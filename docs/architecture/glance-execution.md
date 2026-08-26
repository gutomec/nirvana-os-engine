# Execução no Glance

## Estado

Antes deste corte, `nrv glance` subia o servidor sem adapter de execução: toda Message de projeto adotado terminava em `rolled_back` com `capability_unavailable`. O único adapter existente (`GlanceAgentXCanaryAdapter`) é síncrono e in-process, então em produção ele travaria o event loop do `Bun.serve` durante minutos, congelando HTTP e SSE.

Agora a fila do canário aceita um runner de execução (`GlanceExecutionRunner`, em `skills/harness/lib/control-plane/execution-runner.ts`). Com o runner, cada Message vira um processo filho que roda o `dispatch.ts` existente. O servidor nunca bloqueia: um `GET` durante a execução responde normalmente, e a timeline chega pelo SSE enquanto o filho escreve no kernel.

Prioridade na fila: runner quando presente; senão o adapter in-process; senão `capability_unavailable`. O adapter in-process continua disponível para testes herméticos.

## Fluxo

1. `POST /api/v1/conversations/:cnv/messages` persiste a Message, prepara o Run canônico com `policySnapshotRef: gauntlet-light-canary` e responde `202` quando o Run entrou na fila.
2. O alvo vem do texto da Message: `use business <slug>:` ou `use squad <slug>:` no início (palavra-chave sem distinção de maiúsculas, slug `[a-z0-9-]+`) prepara um Run tipado `business` ou `squad`; qualquer outro texto é `agent-x`.
3. Ao drenar, a fila grava o brief em `<projectRoot>/.nirvana/glance/runs/<runId>/brief.md`, chama `runner.start` e registra `glance.child_started` com `pid`, `attempt` e o argv resumido.
4. O filho é `bun dispatch.ts <--agent-x | --business <slug> | --squad <slug>> --brief-file <brief> --exec --project <prj> --run-id <runId> --outputs-root <projectRoot>/.nirvana/glance/runs/<runId>/outputs`, com `cwd` no root do projeto e `NIRVANA_PROJECT_ROOT` apontando para ele. Para `agent-x` o runner acrescenta `--execution-mode=gauntlet --gauntlet-intensity=light`, o contrato atual do canário. Business e squad não recebem modo forçado: o filho herda o env do servidor (`NIRVANA_EXECUTION_MODE`, allowlists) e decide sozinho. `stdout` e `stderr` vão para `child.log` no mesmo diretório.
5. Com `--run-id`, o cutover Gauntlet do dispatch adota o Run já preparado (`getRun ?? create`) no kernel do projeto, em vez de criar `run_<project>` num kernel próprio. A transição `prepared → running` usa a chave idempotente do cutover, e os eventos do Run herdam o trace com que ele foi preparado.
6. A fila aguarda o término e relê o Run no kernel. Estado terminal: nada a fazer. Estado não terminal: `failed` com `reason: child_exited_without_terminal_state` e o `exitCode` (`rolled_back` se o filho morreu antes de reivindicar o Run). Em ambos os casos `glance.child_exited` registra `pid`, `attempt` e `exitCode`.

A sequência canônica de uma Message `agent-x` bem-sucedida é `run.prepared → glance.child_started → runtime.selection_snapshot → gauntlet.plan_compiled → gauntlet.round_started → run.transitioned(running) → gauntlet.candidate_created → gauntlet.evaluation_recorded → gauntlet.round_evaluated → gauntlet.stopped → run.transitioned(verifying) → run.transitioned(completed) → glance.child_exited`, sem lacunas de sequence. `Last-Event-ID` retoma o stream de qualquer ponto.

## Cancelamento

`POST /api/v1/runs/:run:cancel` em um item ativo envia `SIGTERM` ao filho, registra `glance.child_killed` e transiciona `running → cancelling` com `reason: cancelled_by_user`. Quando o filho sai, a fila completa `cancelling → cancelled`. Se o filho terminou o Run antes de morrer, o estado terminal dele prevalece.

Um item ainda pendente mantém o comportamento anterior: `prepared → rolled_back` com `cancelled_before_execution`, sem side effects.

## Recuperação após restart

No boot, `recover` percorre os Runs do canário:

- Run `prepared` com Message vinculada: reenfileirado como antes (`canary.recovery_enqueued`).
- Run em execução (`running`, `waiting`, `verifying`, `revising`) com `glance.child_started` sem `glance.child_exited` correspondente e pid vivo (`process.kill(pid, 0)`): a fila se reanexa (`canary.recovery_reattached`) e acompanha liveness e estado por polling, sem novo filho. Quando o processo termina, `glance.child_exited` é registrado com `exitCode: null` e o Run é avaliado como em qualquer saída.
- Mesmo caso com pid morto: um novo filho é iniciado com o mesmo `--run-id` (`canary.recovery_redispatched`). O cutover retoma da primeira unidade incompleta: candidates e scorecards persistidos não repetem producer nem evaluator.
- Run `cancelling` cujo filho morreu: a fila fecha `cancelled`.
- Run em execução sem evento de filho: ignorado como antes (`canary.recovery_skipped` com `state_running`).

As chaves idempotentes incluem o número da tentativa (`glance.child_started:<runId>:<attempt>`, `canary.recovery_redispatched:<runId>:<attempt>`), então dois restarts sobre o mesmo processo morto produzem um único evento e um único filho novo.

## Variáveis de ambiente

| Variável | Efeito |
|---|---|
| `NIRVANA_GLANCE_EXECUTION=0` | Sobe o cockpit sem runner; Messages terminam em `capability_unavailable`. `--read-only` também desliga a execução. |
| `NIRVANA_DISPATCH_SCRIPT` | Substitui o `dispatch.ts` do repositório como script filho (usado pelos testes para injetar um filho determinístico). |
| `NIRVANA_PROJECT_ROOT` | Root do projeto servido; o runner o repassa ao filho, e o dispatch com `--run-id` abre `<root>/.nirvana/run-kernel.sqlite`. |
| `NIRVANA_HOST_RUNTIME`, `NIRVANA_DEFAULT_RUNTIME` | Entram na mesma regra de runtime padrão do dispatch (host da sessão, depois a variável, depois o primeiro runtime no PATH, depois `claude-code`). `available()` do runner é verdadeiro quando esse runtime está no PATH. |
| `NIRVANA_EXECUTION_MODE`, `NIRVANA_BUSINESS_GAUNTLET_ALLOWLIST` | Herdadas pelo filho; decidem o modo de business e squad. |

O boot de `nrv glance` imprime uma linha dizendo se a execução está ativa e qual runtime foi detectado.

## Limitações

- `kill()` atinge o processo `bun dispatch.ts`. O runtime que ele iniciou (por exemplo `claude -p`) é um neto e pode sobreviver ao cancelamento; o Run já estará `cancelled` e o kernel rejeita transições posteriores desse processo.
- A reanexação confia no pid. Um pid reutilizado por outro processo mantém a fila acompanhando até esse processo terminar ou o Run alcançar estado terminal.
- A fila é serial: uma Message por vez por servidor, como antes.
- `available()` é uma sondagem de PATH; a cota, credenciais e a saúde do runtime só aparecem no `child.log` e no estado terminal do Run.
- O `policySnapshotRef` de admissão é `gauntlet-light-canary` para os três alvos. Business e squad caem no executor legado do dispatch quando o env do servidor não pede `gauntlet` (`NIRVANA_EXECUTION_MODE=gauntlet` e, para business, a allowlist). O executor legado não escreve no kernel, então o Run canônico termina `rolled_back` com `child_exited_without_terminal_state` mesmo que o filho tenha entregue em `outputs/`.
