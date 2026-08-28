# Adapters de dispatch para multi-target

## Estado

`createDispatchMultiTargetAdapters` devolve os adapters `standard` e `gauntlet` esperados por `MultiTargetCoordinatorPorts`. Cada nó executa `skills/harness/scripts/dispatch.ts` como subprocesso, então exit codes, artifacts, audit, session files e canários do caminho legado continuam valendo sem alteração. A factory é consumida por `nrv multi-target run` ([Comando multi-target](gauntlet-multi-target-cli.md)) e pelos testes.

## Entrada da factory

- `projectRoot`: diretório onde o subprocesso roda (`cwd`).
- `projectId`: trace compartilhado por todos os nós, passado como `--project`.
- `workspaceRoot`: padrão `<projectRoot>/.nirvana/outputs/<projectId>`, o layout de `references/04-multi-target.md`.
- `plan`: o `CompiledMultiTargetPlan` já compilado; fornece fases, dependências e consumidores.
- `nodeBriefs`: texto do sub-brief por nó. Um nó business, squad ou agent sem sub-brief falha sem spawn; a síntese recebe um texto padrão.
- `runtime`, `dispatchScriptPath`, `env`, `spawn` e `budgetUsd` são opcionais e injetáveis.

## Layout em disco por nó

O diretório do nó vem de `outputs_path` do manifest sob `workspaceRoot` (`businesses/<slug>/`, `squads/<slug>/`, `agents/<id>/`, `deliverables/<id>/`). Antes do spawn, o adapter grava:

- `DISPATCH-INSTRUCTION.md`, seguindo o template do harness: identidade do target (num nó `agent`, o agent-x no papel com o id do nó, que nenhum squad cobre), ponteiro para `brief-enriched.md`, entregável, caminhos absolutos dos `_SUMMARY.md` dos upstreams entregues, fases downstream e o caminho de saída;
- `dispatch-brief.md`, o brief entregue ao dispatch via `--brief-file`, com o sub-brief e o ponteiro para a instrução;
- `outputs/`, destino de `--outputs-root`.

Upstreams do tipo `support`, como o brief, não entram na lista de resumos, porque não produzem `_SUMMARY.md`.

O scaffold legado do dispatch (agent-prompt, session.json, handoffs) continua onde o dispatch sempre gravou, em `outputs/<projectId>/...` do `projectRoot`. Somente os deliverables e a instrução vivem no workspace multi-target.

## Seleção explícita do alvo

| Alvo | Comando |
| --- | --- |
| `business` | `bun dispatch.ts --business <slug> --brief-file <...> --exec --project <id> --run-id <id do Run do nó> --outputs-root <abs>` |
| `squad` | `bun dispatch.ts --squad <slug> --brief-file <...> --exec --project <id> --run-id <id do Run do nó> --outputs-root <abs>` |
| `agent-x` (nó `agent`) e `synthesis` | `bun dispatch.ts --agent-x --brief-file <...> --exec --project <id> --run-id <id do Run do nó> --outputs-root <abs>` |

Os dois alvos agent-x se distinguem pelo brief e pelo diretório: o nó `agent` recebe o próprio sub-brief, obrigatório, em `agents/<id>/`; a síntese recebe o texto padrão mais a lista dos `_SUMMARY.md` upstream, em `deliverables/<id>/`.

`--runtime <rt>` é acrescentado quando informado. `--max-budget` recebe o menor valor entre a concessão da reserva (modo `gauntlet`) e `budgetUsd[nodeId]`.

As três flags são mutuamente exclusivas entre si e com `--auto`. `--business` equivale ao positional; `--squad` preenche `resolveDispatchPlan.explicitTarget` e segue pela rota squad-only; `--agent-x` entra direto no branch agent-x. Nenhuma consulta o roteador, então um nó não paga chamada de LLM para ser selecionado, e o brief entregue ao dispatch é o sub-brief sem prefixo.

## Id de Run por nó e tentativa

Todo spawn passa `--run-id run_<projectId>_<nodeId>_a<attempt>` (`nodeRunId`), com cada parte sanitizada como `canonicalRunIdFor` sanitiza o project id (`[^A-Za-z0-9-]` vira `-`): `run_smoke-cafe-solar_final-output_a1` na primeira execução, `_a2` para os nós que uma retomada com `--retry-failed` reexecuta, enquanto os nós entregues não spawnam. Vale para `standard` e `gauntlet`, business, squad, agent-x e síntese; a `attempt` vem do snapshot do coordenador, no mesmo `MultiTargetAdapterInput` que carrega a chave idempotente.

Sem o id explícito, o `dispatch.ts` derivava `run_<projectId>` de `--project`, que todos os nós de um plano compartilham. Na primeira retomada real, o nó `standard` da onda 1 publicou e concluiu `run_smoke-cafe-solar`; a onda 2 reproduziu os eventos desse Run e gerou `x_run_kernel_unavailable` na transição terminal; o canário Gauntlet da onda 3 adotou o Run já `completed`, produziu um candidato de USD 2,27, passou no gate e morreu em `illegal transition completed -> completed`. Candidatos, scorecards e o diretório `.nirvana/gauntlet/<runId>/` também eram compartilhados pelo mesmo id.

O dispatch abre o kernel do projeto (`<NIRVANA_PROJECT_ROOT || cwd>/.nirvana/run-kernel.sqlite`), o mesmo que guarda o Run do plano (`run_mt_<projectId>`) e que o Glance lê; o adapter fixa `NIRVANA_PROJECT_ROOT` no `projectRoot` em que roda, então o kernel é esse independentemente do shell do chamador. O Run do nó não existe antes do spawn: o filho o cria sob o id recebido, e um Run já terminal sob esse id é recusado com `x_run_id_collision` e exit 1 antes do produtor ([Operação do Run Kernel](run-kernel-operations.md)). O adapter do avaliador Gauntlet não passa `--run-id`: ele roda sob um project id próprio (`<projectId>-evl-<revisionId>`), que já carrega o Run do nó, e por isso não colide.

## Modo gauntlet

`gauntlet` acrescenta `--execution-mode=gauntlet --gauntlet-intensity=<intensidade>`. Para alvo `business`, injeta o slug em `NIRVANA_BUSINESS_GAUNTLET_ALLOWLIST` no ambiente do filho, mesclando com o valor existente sem remover outros slugs. A intensidade vem da decisão do plano e segue como está para business, squad e agent-x; sem valor, o adapter usa `light`. `NIRVANA_BUSINESS_GAUNTLET_KILL_SWITCH` continua sendo respeitado pelo dispatch.

## Mapeamento de exit codes

| Exit | Estado | Razão |
| --- | --- | --- |
| 0 | `delivered` | |
| 2 | `withheld` | gate reprovou após o orçamento de revisões |
| 3 | `withheld` | `indeterminate`: nada foi julgado |
| outro | `failed` | `dispatch exit <n>` com o fim do stderr |

`outputPaths` devolve o `outputs/` do nó no mesmo formato relativo do manifest.

## Fonte de custo

O custo reportado é a soma de `cost_usd` nos eventos `agent_executed` do audit do harness, lidos de todas as pastas diárias em `harnessLogsDir({ projectRoot })` (ou `HARNESS_LOGS_DIR`, quando o chamador o definiu). O filtro usa `trace_id` igual ao `projectId` e o discriminador que cada caminho legado já grava: `business_slug` para business, `squad_slug` sem `business_slug` para squad e `employee: "agent-x"` para agent-x e síntese. Como um nó `agent` e a síntese do mesmo plano são ambos agent-x sob o mesmo trace, o adapter nomeia o nó no ambiente de todo filho (`NIRVANA_MULTI_TARGET_NODE_ID`), o `runAgentX` copia o valor como `node_id` no `agent_executed`, e o matcher de um alvo agent-x só soma os eventos com o `node_id` do nó. O `costMatcher` sem `nodeId` continua somando todo evento agent-x do trace; é o contrato do adapter do avaliador Gauntlet, que roda sob um project id próprio.

O filho é avisado de onde esse log fica. Sem `HARNESS_LOGS_DIR` no ambiente, o `dispatch.ts` ancora o audit no scaffold que ele mesmo cria (`<projectRoot>/outputs/<projectId>/.nirvana/logs/harness`, via `harnessLogsDir({ cwd: projDir })`), e não em `<projectRoot>/.nirvana/logs/harness`: no primeiro smoke com LLM real, um nó entregue por USD 2,15 foi registrado pelo coordenador como USD 0. O adapter agora define `HARNESS_LOGS_DIR` no ambiente do filho com o mesmo diretório que ele lê; um valor já definido pelo chamador não é sobrescrito. Os testes herméticos fixavam a variável por fixture, o que escondia o desvio; o dispatch falso passou a gravar o evento onde o real grava, então o desvio é reproduzido e a correção, testada.

Quando nenhum `agent_executed` é encontrado para um nó que executou, o resultado traz `costObserved: false` com `reportedCostUsd: 0`, em vez de um zero silencioso: o custo é desconhecido, e o coordenador registra isso em `multi_target.cost_unobserved` e `x_multi_target_cost_unobserved` ([coordenador](gauntlet-multi-target-coordinator.md)). O `observeCost` exportado devolve `{ costUsd, observed }`; `observedCostUsd` continua existindo para quem só carrega o número (o scorecard do avaliador Gauntlet).

Essa escolha segue o que o dispatch já escreve: o run-ledger não guarda custo, e o audit é por projeto e alimentado pelos três caminhos. Duas limitações conhecidas: o canário Gauntlet de business não emite `agent_executed`, então seu custo aparece como não observado; e um evento agent-x sem `node_id` (um filho que não foi gerado pelos adapters) não conta para nenhum nó. A soma cobre todas as tentativas do nó no mesmo trace: um nó retomado por `--retry-failed` reporta o gasto acumulado.

## Marcador de retomada

Ao concluir um subprocesso, o adapter grava `<dir do nó>/.multi-target-result.json` com `idempotencyKey`, `state`, `exitCode`, `reportedCostUsd`, `costObserved`, `finishedAt` e, quando houver, `reason`. Uma nova chamada com a mesma chave devolve o resultado gravado sem spawn, tanto em `resume: true` quanto em repetição acidental. Chave divergente ignora o marcador e executa; é o que acontece na retomada de um plano falho, cuja chave carrega a tentativa. Um marcador gravado antes do campo `costObserved` existir responde `true` quando o custo é positivo e `false` quando é zero.

Abortos não gravam marcador: a execução foi interrompida, então uma execução futura pode tentar de novo.

## Abort

`signal` abortado antes do spawn devolve `failed` sem subprocesso. Abortado durante a execução, o adapter mata o filho e devolve `failed` com razão `aborted: <razão>`. A porta Run Kernel usa esse canal quando perde a lease.

## Limitações

O scaffold legado e o workspace multi-target são árvores separadas. Nenhum teste toca rede, LLM ou runtime real: o dispatch é substituído por um script Bun compartilhado (`tests/helpers/fake-dispatch.ts`) que grava argv, ambiente e cwd, emite o evento de custo e sai com o código configurado. O adapter não valida a intensidade nem confirma que o Gauntlet executou: repassa a decisão do plano e deixa allowlist, kill switch e o loop do controller com o dispatch; o exit code decide o estado do nó, como antes.
