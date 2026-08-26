# Comando multi-target

## Estado

`nrv multi-target plan|run|status` é a entrada pública do engine multi-target. O comando lê um plano declarado em arquivo, compila manifest, política Gauntlet e reserva agregada, e executa o resultado com `coordinateMultiTargetPlan` sobre as portas do Run Kernel e os adapters de dispatch por subprocesso. A implementação está em `skills/harness/scripts/multi-target.ts`; o alias é `nrv mt`.

Nenhuma rota existente do dispatch muda. Cada nó continua executando `scripts/dispatch.ts` como subprocesso, com os mesmos exit codes, artifacts, audit e canários. O protocolo em prosa de `references/04-multi-target.md` segue sendo o caminho padrão nos runtimes interativos; o comando cobre execução headless, runtimes cujo único primitivo de delegação é o shell e retomada depois de uma queda.

## Arquivo de plano

Schema `nirvana.multi-target-plan/v1alpha1`, em JSON, por convenção em `.nirvana/plans/<trace_id>.json`:

```json
{
  "schemaVersion": "nirvana.multi-target-plan/v1alpha1",
  "projectId": "proj-lancamento",
  "brief": "# Brief completo\n...",
  "briefs": { "business-a": "Entregue a parte A.", "squad-c": "Monte C a partir de A e B." },
  "graph": { "nodes": [], "edges": [] },
  "policy": { "scope": "each-target-and-final", "intensity": "light", "synthesisNodeId": "final-output", "limits": { "maxCostUsd": 10 } },
  "runtime": "claude-code",
  "budgetUsd": { "business-a": 3 }
}
```

| Campo | Obrigatório | Significado |
| --- | --- | --- |
| `schemaVersion` | sim | literal `nirvana.multi-target-plan/v1alpha1` |
| `projectId` | não | trace id; `--project` vence, e sem ambos vale o nome do arquivo sem extensão |
| `brief` | sim | conteúdo de `brief-enriched.md`, lido por todo target |
| `briefs` | sim | sub-brief por nó; todo nó `company` ou `squad` precisa de um; `deliverable` é opcional |
| `graph` | sim | `DependencyGraph` com nós `company`, `squad`, `deliverable` e `brief` |
| `policy` | não | `MultiTargetGauntletPolicy`, repassada ao compilador sem reinterpretação |
| `runtime` | não | runtime passado a cada subprocesso; `--runtime` vence |
| `budgetUsd` | não | teto por nó em USD, combinado com a concessão da reserva (vale o menor) |

A validação é estrita (`zod`): chave desconhecida, tipo de nó fora da lista, sub-brief ausente para nó executável, chave de `briefs` ou `budgetUsd` sem nó correspondente. Ciclos, referências e limites inválidos da política vêm do compilador no mesmo formato, e uma reserva rejeitada também invalida o plano. Cada problema sai como `path: message` e o comando termina com exit 4.

## Comandos

### `plan <arquivo> [--project <id>]`

Compila e imprime ondas, decisões por nó, alocações da reserva e os digests do plano e da reserva. Grava `manifest.json` e `brief-enriched.md` em `<projectRoot>/.nirvana/outputs/<projectId>/` e emite `x_multi_target_plan_compiled`. Não executa nada. Exit 0, ou 4 para plano inválido ou reserva rejeitada.

### `run <arquivo> [--project <id>] [--runtime <rt>] [--owner <id>] [--json]`

Faz tudo do `plan` e então:

1. abre `<projectRoot>/.nirvana/run-kernel.sqlite`, o mesmo kernel que o Glance lê (`NIRVANA_PROJECT_ROOT`, senão o diretório atual);
2. cria o Run `run_mt_<projectId>` com `target: { kind: "agent-x", slug: "agent-x" }`, `planId: plan_<runId>` e `policySnapshotRef: snapshot_<prefixo do digest do plano>`, sob chave idempotente;
3. transiciona `prepared → running` antes da primeira onda;
4. executa o coordenador com `createRunKernelMultiTargetPorts` e `createDispatchMultiTargetAdapters`;
5. transiciona `running → verifying → completed|withheld|failed` conforme o estado terminal do coordenador.

`--owner` identifica o dono das leases por nó; o padrão é `hostname:pid`. `--json` imprime apenas `{ projectId, runId, run, projection, exitCode }` no stdout.

### `status <arquivo|runId> [--project <id>] [--json]`

Lê o Run e `projectMultiTargetRun` sem side effects: estado do Run, estado do plano, onda atual, custo e cada nó com modo, estado, custo concedido e reportado, razão e bloqueios. Com um `runId` em vez de arquivo, `--project` é obrigatório. Sem kernel no projeto ou sem o Run, exit 1.

## Exit codes

| Exit | `run` | `plan` | `status` |
| --- | --- | --- | --- |
| 0 | plano `delivered`, Run `completed` | compilado | Run encontrado |
| 1 | plano `failed`, erro do coordenador ou do kernel | | kernel ou Run ausentes |
| 2 | plano `withheld` | | |
| 4 | plano inválido, opt-in ausente, Run existente com outro plano | plano inválido | plano inválido ou `--project` ausente |

## Opt-in

`run` exige `NIRVANA_MULTI_TARGET_ENGINE=1`. `NIRVANA_MULTI_TARGET_KILL_SWITCH=1` desliga mesmo com a flag. Sem opt-in o comando termina com exit 4 e explica como habilitar, sem abrir o kernel nem gravar o workspace. `plan` e `status` funcionam sempre.

Para testes, `NIRVANA_DISPATCH_SCRIPT` aponta os adapters para outro script de dispatch; a variável só é honrada quando definida.

## Audit

O comando escreve no audit legado (`lib/audit.js`) com `trace_id` e `project_id` iguais ao `projectId`:

| Evento | Quando | Payload |
| --- | --- | --- |
| `x_multi_target_plan_compiled` | `plan` e `run` | digests, ondas, quantidade de nós, workspace |
| `x_multi_target_run_started` | `run` | `run_id`, owner, runtime, `resumed` |
| `x_multi_target_node_terminal` | por nó terminal | nó, onda, modo, estado, custo reportado e concedido, razão, bloqueios |
| `x_multi_target_terminal` | fim do `run` | estado do plano, estado do Run, custo total, razão, exit |

Os subprocessos de cada nó seguem emitindo a própria cadeia legada (`dispatch_business`, `dispatch_squad`, `dispatch_agent_x`, `gate_passed`, `delivered`) no mesmo log. O journal canônico (`multi_target.*`, `run.transitioned`) fica no kernel e aparece no Glance.

## Retomada

Repetir `run` com o mesmo plano retoma. O coordenador carrega o último snapshot do kernel e reaplica os eventos posteriores; nós terminais não executam de novo, e o marcador `.multi-target-result.json` do adapter impede um segundo spawn para a mesma chave idempotente. Um Run terminal devolve o resultado sem executar nada.

Um nó que estava `running` no momento da queda só é reenviado quando a lease continua do mesmo owner e dentro do prazo (30 s por padrão, renovada enquanto o adapter roda). Por isso, para retomar logo depois de uma queda, repita o comando com o mesmo `--owner`. Lease expirada ou de outro owner marca o nó como `stalled` e o plano como `failed`, sem takeover automático; um novo `--project` recomeça do zero.

Um plano diferente sob o mesmo `projectId` é recusado com exit 4, porque o Run existente aponta para outro `policySnapshotRef`.

## Seleção explícita no dispatch

`dispatch.ts` aceita `--business <slug>`, `--squad <slug>` e `--agent-x`, mutuamente exclusivos entre si e com `--auto`. `--business` equivale ao positional; `--squad` preenche `explicitTarget` em `resolveDispatchPlan` e segue pela rota squad-only; `--agent-x` vai direto ao branch agent-x. Nenhum deles consulta o roteador. Os adapters usam essas flags, então nenhum nó paga chamada de LLM para ser selecionado. Sem as flags, o dispatch se comporta exatamente como antes.

## Limitações

- O `manifest.json` gravado no workspace é o manifest compilado, com todas as fases `pending`; o estado vivo está no kernel e em `status`.
- O endpoint `/api/v1/runs/:run/multi-target` do Glance valida `project_id` com prefixo `prj_` ou `proj-`; um trace id fora desse padrão aparece só por `status`.
- Retomar um nó em execução depende de owner e lease; não há recovery humano nem cancelamento conjunto.
- Intensidades `balanced` e `exhaustive` continuam recusadas pelos adapters.
- Interromper o comando não encerra os subprocessos de dispatch em andamento; a lease expira e o próximo `run` marca o nó como `stalled`.
