# Adapters de dispatch para multi-target

## Estado

`createDispatchMultiTargetAdapters` devolve os adapters `standard` e `gauntlet` esperados por `MultiTargetCoordinatorPorts`. Cada nó executa `skills/harness/scripts/dispatch.ts` como subprocesso, então exit codes, artifacts, audit, session files e canários do caminho legado continuam valendo sem alteração. A factory é consumida por `nrv multi-target run` ([Comando multi-target](gauntlet-multi-target-cli.md)) e pelos testes.

## Entrada da factory

- `projectRoot`: diretório onde o subprocesso roda (`cwd`).
- `projectId`: trace compartilhado por todos os nós, passado como `--project`.
- `workspaceRoot`: padrão `<projectRoot>/.nirvana/outputs/<projectId>`, o layout de `references/04-multi-target.md`.
- `plan`: o `CompiledMultiTargetPlan` já compilado; fornece fases, dependências e consumidores.
- `nodeBriefs`: texto do sub-brief por nó. Um nó business ou squad sem sub-brief falha sem spawn; a síntese recebe um texto padrão.
- `runtime`, `dispatchScriptPath`, `env`, `spawn` e `budgetUsd` são opcionais e injetáveis.

## Layout em disco por nó

O diretório do nó vem de `outputs_path` do manifest sob `workspaceRoot` (`businesses/<slug>/`, `squads/<slug>/`, `deliverables/<id>/`). Antes do spawn, o adapter grava:

- `DISPATCH-INSTRUCTION.md`, seguindo o template do harness: identidade do target, ponteiro para `brief-enriched.md`, entregável, caminhos absolutos dos `_SUMMARY.md` dos upstreams entregues, fases downstream e o caminho de saída;
- `dispatch-brief.md`, o brief entregue ao dispatch via `--brief-file`, com o sub-brief e o ponteiro para a instrução;
- `outputs/`, destino de `--outputs-root`.

Upstreams do tipo `support`, como o brief, não entram na lista de resumos, porque não produzem `_SUMMARY.md`.

O scaffold legado do dispatch (agent-prompt, session.json, handoffs) continua onde o dispatch sempre gravou, em `outputs/<projectId>/...` do `projectRoot`. Somente os deliverables e a instrução vivem no workspace multi-target.

## Seleção explícita do alvo

| Alvo | Comando |
| --- | --- |
| `business` | `bun dispatch.ts --business <slug> --brief-file <...> --exec --project <id> --outputs-root <abs>` |
| `squad` | `bun dispatch.ts --squad <slug> --brief-file <...> --exec --project <id> --outputs-root <abs>` |
| `agent-x` e `synthesis` | `bun dispatch.ts --agent-x --brief-file <...> --exec --project <id> --outputs-root <abs>` |

`--runtime <rt>` é acrescentado quando informado. `--max-budget` recebe o menor valor entre a concessão da reserva (modo `gauntlet`) e `budgetUsd[nodeId]`.

As três flags são mutuamente exclusivas entre si e com `--auto`. `--business` equivale ao positional; `--squad` preenche `resolveDispatchPlan.explicitTarget` e segue pela rota squad-only; `--agent-x` entra direto no branch agent-x. Nenhuma consulta o roteador, então um nó não paga chamada de LLM para ser selecionado, e o brief entregue ao dispatch é o sub-brief sem prefixo.

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

O custo reportado é a soma de `cost_usd` nos eventos `agent_executed` do audit do harness, lidos de todas as pastas diárias em `harnessLogsDir({ projectRoot })` (ou `HARNESS_LOGS_DIR`, quando definido no ambiente do filho). O filtro usa `trace_id` igual ao `projectId` e o discriminador que cada caminho legado já grava: `business_slug` para business, `squad_slug` sem `business_slug` para squad e `employee: "agent-x"` para agent-x e síntese. Ausência de registro vale zero.

Essa escolha segue o que o dispatch já escreve: o run-ledger não guarda custo, e o audit é por projeto e alimentado pelos três caminhos. Duas limitações conhecidas: o canário Gauntlet de business não emite `agent_executed`, então seu custo aparece como zero; e dois nós agent-x no mesmo trace compartilhariam o discriminador, situação que o grafo atual não produz.

## Marcador de retomada

Ao concluir um subprocesso, o adapter grava `<dir do nó>/.multi-target-result.json` com `idempotencyKey`, `state`, `exitCode`, `reportedCostUsd`, `finishedAt` e, quando houver, `reason`. Uma nova chamada com a mesma chave devolve o resultado gravado sem spawn, tanto em `resume: true` quanto em repetição acidental. Chave divergente ignora o marcador e executa.

Abortos não gravam marcador: a execução foi interrompida, então uma execução futura pode tentar de novo.

## Abort

`signal` abortado antes do spawn devolve `failed` sem subprocesso. Abortado durante a execução, o adapter mata o filho e devolve `failed` com razão `aborted: <razão>`. A porta Run Kernel usa esse canal quando perde a lease.

## Limitações

O scaffold legado e o workspace multi-target são árvores separadas. Nenhum teste toca rede, LLM ou runtime real: o dispatch é substituído por um script Bun compartilhado (`tests/helpers/fake-dispatch.ts`) que grava argv, ambiente e cwd, emite o evento de custo e sai com o código configurado. O adapter não valida a intensidade nem confirma que o Gauntlet executou: repassa a decisão do plano e deixa allowlist, kill switch e o loop do controller com o dispatch; o exit code decide o estado do nó, como antes.
