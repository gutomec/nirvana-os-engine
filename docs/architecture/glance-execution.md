# Execução no Glance

## Estado

Antes deste corte, `nrv glance` subia o servidor sem adapter de execução: toda Message de projeto adotado terminava em `rolled_back` com `capability_unavailable`. O único adapter existente (`GlanceAgentXCanaryAdapter`) é síncrono e in-process, então em produção ele travaria o event loop do `Bun.serve` durante minutos, congelando HTTP e SSE.

Agora a fila do canário aceita um runner de execução (`GlanceExecutionRunner`, em `skills/harness/lib/control-plane/execution-runner.ts`). Com o runner, cada Message vira um processo filho que roda o `dispatch.ts` existente. O servidor nunca bloqueia: um `GET` durante a execução responde normalmente, e a timeline chega pelo SSE enquanto o filho escreve no kernel.

Prioridade na fila: runner quando presente; senão o adapter in-process; senão `capability_unavailable`. O adapter in-process continua disponível para testes herméticos.

## Fluxo

1. `POST /api/v1/conversations/:cnv/messages` persiste a Message, prepara o Run canônico com `policySnapshotRef: gauntlet-light-canary` e responde `202` quando o Run entrou na fila.
2. O alvo segue a cascata do maestro. `use business <slug>:` ou `use squad <slug>:` no início da Message (palavra-chave sem distinção de maiúsculas, slug `[a-z0-9-]+`) prepara um Run tipado `business` ou `squad` sem consultar o roteador. Qualquer outro texto passa pelo roteador agêntico antes de o Run existir: `primary_business` vira alvo `business`; sem empresa, exatamente um squad em `mandatory_squads` vira alvo `squad` (`squad.execute`); o resto é `agent-x`. Detalhes em [Roteamento da Message](#roteamento-da-message).
3. Ao drenar, a fila grava o brief em `<projectRoot>/.nirvana/glance/runs/<runId>/brief.md`, chama `runner.start` e registra `glance.child_started` com `pid`, `attempt` e o argv resumido.
4. O filho é `bun dispatch.ts <--agent-x | --business <slug> | --squad <slug>> --brief-file <brief> --exec --project <prj> --run-id <runId> --outputs-root <projectRoot>/.nirvana/glance/runs/<runId>/outputs`, com `cwd` no root do projeto, `NIRVANA_PROJECT_ROOT` apontando para ele e `HARNESS_LOGS_DIR` apontando para o log do harness do projeto (`<projectRoot>/.nirvana/logs/harness`), a menos que o servidor já tenha a variável definida. Sem ela o dispatch ancora o audit no scaffold que ele cria (`outputs/<prj>/.nirvana/logs/harness`), fora do log que o cockpit e os leitores de custo abrem. Para `agent-x` o runner acrescenta `--execution-mode=gauntlet --gauntlet-intensity=light`, o contrato atual do canário. Business e squad não recebem modo forçado: o filho herda o env do servidor (`NIRVANA_EXECUTION_MODE`, allowlists) e decide sozinho. `stdout` e `stderr` vão para `child.log` no mesmo diretório.
5. Com `--run-id`, o dispatch adota o Run já preparado (`getRun ?? create`) no kernel do projeto, em vez de criar `run_<project>` num kernel próprio. No Gauntlet a adoção é do cutover; em modo `standard` (business e squad sem `NIRVANA_EXECUTION_MODE=gauntlet`) é da publicação do modo standard (`lib/run-kernel/standard-publication.ts`, ver [Operação do Run Kernel](run-kernel-operations.md)). Nos dois casos os eventos do Run herdam o trace e o `policySnapshotRef` com que ele foi preparado.
6. A fila aguarda o término e relê o Run no kernel. Estado terminal: nada a fazer. Estado não terminal: `failed` com `reason: child_exited_without_terminal_state` e o `exitCode` (`rolled_back` se o filho morreu antes de reivindicar o Run). Em ambos os casos `glance.child_exited` registra `pid`, `attempt` e `exitCode`.

A sequência canônica de uma Message `agent-x` bem-sucedida é `run.prepared → glance.child_started → runtime.selection_snapshot → gauntlet.plan_compiled → gauntlet.round_started → run.transitioned(running) → gauntlet.candidate_created → gauntlet.evaluation_recorded → gauntlet.round_evaluated → gauntlet.stopped → run.transitioned(verifying) → run.transitioned(completed) → glance.child_exited`, sem lacunas de sequence. Uma Message `use squad <slug>:` ou `use business <slug>:` em modo `standard` produz `run.prepared → glance.child_started → runtime.selection_snapshot → run.transitioned(running) → run.transitioned(verifying) → run.transitioned(<terminal>) → glance.child_exited`, com `exitCode`, `gateOutcome` e `outputsRoot` no payload terminal. `Last-Event-ID` retoma o stream de qualquer ponto.

## Roteamento da Message

`resolveMessageTarget` (`skills/harness/lib/control-plane/agent-x-canary-queue.ts`) decide o alvo de uma Message com a mesma cascata que o maestro aplica a um brief: o usuário no comando, depois empresa, depois squad, depois `agent-x`. O roteador é o `agenticRoute` de `lib/agentic-router.ts`, o único do engine; o Glance não ranqueia nada. A decisão do roteador vira alvo pelo `resolveDispatchPlan` de `lib/dispatch-cascade.ts`, o mesmo mapeamento do `dispatch.ts --auto` fora de um TTY.

| Situação | Alvo | `route.source` |
|---|---|---|
| `use business <slug>:` ou `use squad <slug>:` no início | o nomeado, sem chamar o roteador | `explicit` |
| decisão com `primary_business` | `business` | `router` |
| decisão sem empresa e com exatamente um squad em `mandatory_squads` | `squad`, capability `squad.execute` | `router` |
| decisão `ambiguous` | o primeiro candidato despachável (empresa ou squad), com `x_route_ambiguous_autopicked` no audit | `router` |
| decisão com dois ou mais squads e sem empresa | `agent-x`; um Run do Glance executa um alvo | `fallback` |
| `no_match` | `agent-x`, com a razão do roteador | `fallback` |
| roteador lança, devolve falha de transporte ou estoura o teto | `agent-x` com `routing.on_router_failure=cascade` (padrão); com `fail`, o Run é preparado e revertido (`rolled_back`, `reason: router_failed`) sem executar | `fallback` |
| `routing.mode=fast` | `agent-x`, sem chamar o roteador; o Glance compõe só o roteador agêntico, e o BM25 do modo `fast` continua sendo do dispatch | `fallback` |
| servidor sem roteador (`--read-only`, `glance.execution=false`, testes sem injeção) | `agent-x` | `fallback` |

O teto de uma chamada é `MESSAGE_ROUTE_TIMEOUT_MS` (120 s), fixo: nenhuma chave de settings configura o timeout do roteador ainda, e o dispatch espera cinco minutos. O valor vai ao `agenticRoute`, que encerra a CLI headless no teto, e vale também para um roteador injetado que não responde. `routing.mode` e `routing.on_router_failure` são lidos por `resolveSetting` sobre o root do projeto a cada Message, então uma mudança pelo painel "Configuração" vale na próxima.

Em produção, `nrv glance` compõe o roteador com `createAgenticMessageRouter` (`lib/control-plane/message-router.ts`): o `agenticRoute` roda num Worker, porque a chamada headless que ele faz é um `spawnSync`; no Worker ela bloqueia a própria thread, e o servidor segue respondendo HTTP e SSE enquanto uma Message é roteada. O runtime do roteador segue a mesma regra do runner (`detectExecutionRuntime`). O roteador é injetado na fila (`AgentXCanaryQueue`, quinto argumento) e no servidor (`startServer({ messageRouter })`); os testes passam um roteador falso e nunca chamam LLM nem rede.

Cada resolução escreve `auto_route_selected` no audit do projeto (`<root>/.nirvana/logs/harness/<data>/audit.jsonl`) com o `trace_id` da Message (o `runId`), `message_id`, `source`, `plan_source`, `target_kind`, `target_slug`, `rationale` e, quando o roteador respondeu, `decision_kind`, `cost_usd` e `duration_ms`. Um roteador que lança ou estoura o teto escreve também `agentic_route_failed` com o mesmo `trace_id`; a falha de transporte que o próprio `agenticRoute` já registrou não é registrada duas vezes. O Run nasce com `route: { source, rationale }` no payload de `run.prepared` e na projeção (`GET /api/v1/runs/{id}`), e o recibo `202` já o traz: o chat mostra alvo e origem antes de o filho iniciar, a timeline rotula `run.prepared` com a origem e a razão, e o cabeçalho do Run nomeia a origem. Uma Message roteada uma vez fica roteada: o retry com a mesma `Idempotency-Key` reaproveita o Run, e dois envios simultâneos compartilham uma resolução.

## Cancelamento

`POST /api/v1/runs/:run:cancel` em um item ativo envia `SIGTERM` ao grupo de processos do filho, registra `glance.child_killed` e transiciona `running → cancelling` com `reason: cancelled_by_user`. Quando o filho sai, a fila completa `cancelling → cancelled`. Se o filho terminou o Run antes de morrer, o estado terminal dele prevalece.

O runner inicia o `dispatch.ts` como líder do próprio grupo de processos (`detached`), e `kill()` sinaliza o grupo (`process.kill(-pid)`), não só o pid: o runtime que o dispatch iniciou (`claude -p`, `codex`, `gemini`) recebe o mesmo `SIGTERM` e morre com ele. Um handler de sinal em JavaScript dentro do dispatch não resolveria: o runtime roda sob `spawnSync`, que bloqueia o event loop, então o handler só executaria depois que o neto terminasse sozinho. Onde grupos de processos não existem (Windows), `kill()` volta a sinalizar apenas o pid. Um filho reanexado de um servidor anterior recebe o sinal pelo grupo do mesmo modo.

Um item ainda pendente mantém o comportamento anterior: `prepared → rolled_back` com `cancelled_before_execution`, sem side effects. O `shutdown()` do servidor (idle ou `SIGINT`/`SIGTERM`) encerra a fila antes de parar o servidor, então um filho ainda em execução fica para a recuperação do próximo servidor em vez de ser encerrado por um servidor que está morrendo.

## Recuperação após restart

No boot, `recover` percorre os Runs do canário:

- Run `prepared` com Message vinculada: reenfileirado como antes (`canary.recovery_enqueued`).
- Run em execução (`running`, `waiting`, `verifying`, `revising`) com `glance.child_started` sem `glance.child_exited` correspondente e pid vivo (`process.kill(pid, 0)`): a fila se reanexa (`canary.recovery_reattached`) e acompanha liveness e estado por polling, sem novo filho. Quando o processo termina, `glance.child_exited` é registrado com `exitCode: null` e o Run é avaliado como em qualquer saída.
- Mesmo caso com pid morto: um novo filho é iniciado com o mesmo `--run-id` (`canary.recovery_redispatched`). O cutover retoma da primeira unidade incompleta: candidates e scorecards persistidos não repetem producer nem evaluator.
- Run `cancelling` cujo filho morreu: a fila fecha `cancelled`.
- Run em execução sem evento de filho: ignorado como antes (`canary.recovery_skipped` com `state_running`).

As chaves idempotentes incluem o número da tentativa (`glance.child_started:<runId>:<attempt>`, `canary.recovery_redispatched:<runId>:<attempt>`), então dois restarts sobre o mesmo processo morto produzem um único evento e um único filho novo. A chave de `canary.recovery_skipped` inclui a razão (`canary.recovery_skipped:<runId>:<reason>`): um Run ignorado por `capability_unavailable` num boot e por `state_completed` no seguinte gera dois eventos, nunca um conflito de identidade dentro de `recover()`.

## Variáveis de ambiente

| Variável | Efeito |
|---|---|
| `NIRVANA_GLANCE_EXECUTION=0` | Sobe o cockpit sem runner; Messages terminam em `capability_unavailable`. `--read-only` também desliga a execução. |
| `NIRVANA_DISPATCH_SCRIPT` | Substitui o `dispatch.ts` do repositório como script filho (usado pelos testes para injetar um filho determinístico). |
| `NIRVANA_PROJECT_ROOT` | Root do projeto servido; o runner o repassa ao filho, e o dispatch com `--run-id` abre `<root>/.nirvana/run-kernel.sqlite`. |
| `HARNESS_LOGS_DIR` | Onde o filho grava o audit legado. O runner a define como `<root>/.nirvana/logs/harness` quando o servidor não a tem; um valor do servidor é repassado como está. |
| `NIRVANA_HOST_RUNTIME`, `NIRVANA_DEFAULT_RUNTIME` | Entram na mesma regra de runtime padrão do dispatch (host da sessão, depois a variável, depois o primeiro runtime no PATH, depois `claude-code`). `available()` do runner é verdadeiro quando esse runtime está no PATH. |
| `NIRVANA_EXECUTION_MODE`, `NIRVANA_BUSINESS_GAUNTLET_ALLOWLIST` | Herdadas pelo filho; decidem o modo de business e squad. |

Além do que o servidor herda, o runner fixa no filho o valor efetivo de cada chave do schema que tem variável (`settingsEnvForChild`), resolvido a cada spawn sobre o root do projeto. Uma mudança pelo painel "Configuração" ou por `nrv config set` vale, portanto, no próximo despacho, sem reiniciar o servidor; ver [Configuração pelo Glance](glance-settings.md).

O boot de `nrv glance` imprime uma linha dizendo se a execução está ativa e qual runtime foi detectado.

## Limitações

- Só o sinal ao grupo alcança o neto. Um `kill <pid>` manual dirigido apenas ao `bun dispatch.ts` ainda deixa o runtime órfão; o Run já estará `cancelled` e o kernel rejeita transições posteriores desse processo.
- A reanexação confia no pid. Um pid reutilizado por outro processo mantém a fila acompanhando até esse processo terminar ou o Run alcançar estado terminal.
- A fila é serial: uma Message por vez por servidor, como antes.
- Um Run do Glance executa um alvo, então a rota multi-squad do maestro (vários squads em sequência) cai em `agent-x`. O roteador da Message não recebe as regras `USE_*` de runtime nem teto de gasto por chamada; o dispatch passa ambos.
- `available()` é uma sondagem de PATH; a cota, credenciais e a saúde do runtime só aparecem no `child.log` e no estado terminal do Run.
- O `policySnapshotRef` de admissão é `gauntlet-light-canary` para os três alvos, e um Run adotado o mantém mesmo em modo `standard`; o snapshot real do broker fica no evento `runtime.selection_snapshot` do Run.
