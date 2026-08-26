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
| `briefs` | sim | sub-brief por nó; todo nó `company`, `squad` ou `agent` precisa de um; `deliverable` é opcional |
| `graph` | sim | `DependencyGraph` com nós `company`, `squad`, `agent`, `deliverable` e `brief` |
| `policy` | não | `MultiTargetGauntletPolicy`, repassada ao compilador sem reinterpretação |
| `runtime` | não | runtime passado a cada subprocesso; `--runtime` vence |
| `budgetUsd` | não | teto por nó em USD, combinado com a concessão da reserva (vale o menor) |

A validação é estrita (`zod`): chave desconhecida, tipo de nó fora da lista, sub-brief ausente para nó executável, chave de `briefs` ou `budgetUsd` sem nó correspondente. Ciclos, referências e limites inválidos da política vêm do compilador no mesmo formato, e uma reserva rejeitada também invalida o plano. Cada problema sai como `path: message` e o comando termina com exit 4.

### Nó `agent`

Um papel sem squad especializado (a copy de um lançamento entre o squad de pesquisa e o de design) entra no plano como nó `agent`. O `id` é o nome do papel, um slug livre que não precisa existir em registro nenhum. O nó é briefado, depende e produz (`briefs`, `depends_on`, `yields`) como um squad; compila para `target: "agent/<id>"`, `outputs_path: "agents/<id>/outputs/"` e decisão de tipo `agent-x`; entra em todo escopo da política, em `criticalTargetIds`, em `targets` e na reserva agregada como um squad ([política](gauntlet-multi-target-policy.md)); e executa como `dispatch.ts --agent-x` com o sub-brief do nó, obrigatório como para squads ([adapters](gauntlet-multi-target-adapters.md)). A síntese continua sendo o nó `deliverable`.

```json
{
  "schemaVersion": "nirvana.multi-target-plan/v1alpha1",
  "brief": "# Brief\n\nLaunch the thing; the copy has no squad.\n",
  "briefs": {
    "squad-research": "Research the market.",
    "role-copywriter": "Write the launch copy from the research.",
    "squad-design": "Design the landing page around the copy.",
    "final-output": "Assemble the launch kit."
  },
  "graph": {
    "nodes": [
      { "id": "brief-main", "type": "brief" },
      { "id": "squad-research", "type": "squad" },
      { "id": "role-copywriter", "type": "agent" },
      { "id": "squad-design", "type": "squad" },
      { "id": "final-output", "type": "deliverable" }
    ],
    "edges": [
      { "id": "brief-research", "source": "brief-main", "target": "squad-research", "type": "briefs" },
      { "id": "copy-after-research", "source": "role-copywriter", "target": "squad-research", "type": "depends_on" },
      { "id": "design-after-copy", "source": "squad-design", "target": "role-copywriter", "type": "depends_on" },
      { "id": "final", "source": "squad-design", "target": "final-output", "type": "yields" }
    ]
  },
  "policy": {
    "scope": "each-target-and-final", "intensity": "light", "synthesisNodeId": "final-output", "limits": { "maxCostUsd": 10 },
    "targets": { "squad-research": { "mode": "standard" }, "role-copywriter": { "limits": { "maxCostUsd": 2 } }, "squad-design": { "mode": "standard" } }
  },
  "budgetUsd": { "role-copywriter": 1.5 }
}
```

As ondas são `brief-main`, `squad-research`, `role-copywriter`, `squad-design` e `final-output`, uma por vez. O `DISPATCH-INSTRUCTION.md` de `agents/role-copywriter/` apresenta o executor como o agent-x no papel `role-copywriter`, aponta o `_SUMMARY.md` de `squads/squad-research/outputs/` e nomeia `squad-design` como consumidor. É o plano que `skills/harness/tests/multi-target-cli.test.ts` executa de ponta a ponta com o dispatch falso.

### Limites da síntese

A síntese (o nó `deliverable` em `synthesisNodeId`) pede à reserva agregada `min(teto, limite próprio)`; sem limite próprio ela pede o teto inteiro e deixa os outros targets Gauntlet no piso. `policy.synthesis` declara intensidade e limites só dela, e `policy.targets[<synthesisNodeId>]` é um alias com o mesmo significado, sem `mode`, porque o modo da síntese é do escopo ([política](gauntlet-multi-target-policy.md)). Um plano com teto USD 32, squad limitado a USD 20 e síntese limitada a USD 10:

```json
"policy": {
  "scope": "each-target-and-final",
  "intensity": "light",
  "synthesisNodeId": "final-output",
  "limits": { "maxCostUsd": 32 },
  "synthesis": { "limits": { "maxCostUsd": 10 } },
  "targets": {
    "visual-brief": { "mode": "standard" },
    "landing-page-nirvana": { "limits": { "maxCostUsd": 20 } }
  }
}
```

`nrv multi-target plan` imprime a alocação: `landing-page-nirvana` na onda 2 com USD 20 solicitados e concedidos, `final-output` na onda 3 com USD 10 solicitados e concedidos, saldo USD 2. Sem `synthesis`, o mesmo plano concede USD 31 à síntese e USD 1 ao squad.

## Comandos

### `plan <arquivo> [--project <id>]`

Compila e imprime ondas, decisões por nó, alocações da reserva e os digests do plano e da reserva. Grava `manifest.json` e `brief-enriched.md` em `<projectRoot>/.nirvana/outputs/<projectId>/` e emite `x_multi_target_plan_compiled`. Não executa nada. Exit 0, ou 4 para plano inválido ou reserva rejeitada.

### `run <arquivo> [--project <id>] [--runtime <rt>] [--owner <id>] [--retry-failed] [--json]`

Faz tudo do `plan` e então:

1. abre `<projectRoot>/.nirvana/run-kernel.sqlite`, o mesmo kernel que o Glance lê (`NIRVANA_PROJECT_ROOT`, senão o diretório atual);
2. localiza o Run mais recente da cadeia do plano (`run_mt_<projectId>`, depois `run_mt_<projectId>_r2`, `_r3`, enquanto existirem) ou cria o primeiro com `target: { kind: "agent-x", slug: "agent-x" }`, `planId: plan_<runId>` e `policySnapshotRef: snapshot_<prefixo do digest do plano>`, sob chave idempotente;
3. transiciona `prepared → running` antes da primeira onda;
4. executa o coordenador com `createRunKernelMultiTargetPorts` e `createDispatchMultiTargetAdapters`; cada nó roda sob o próprio Run canônico, `run_<projectId>_<nó>_a<tentativa>`, no mesmo kernel ([adapters](gauntlet-multi-target-adapters.md));
5. transiciona `running → verifying → completed|withheld|failed` conforme o estado terminal do coordenador.

`--owner` identifica o dono das leases por nó; o padrão é `hostname:pid`. `--json` imprime apenas `{ projectId, runId, run, projection, exitCode }` no stdout.

O resumo do `run` mostra, por nó, o custo reportado; um nó que executou sem deixar evento de custo no audit aparece com `custo não observado`, e o rodapé lista esses nós. O custo real deles é desconhecido, não zero: a proteção de orçamento do Gauntlet ficou cega para aquele nó. Um `run` que termina `failed` ou `withheld` imprime o comando de retomada.

#### `--retry-failed`

Reabre um plano cujo Run mais recente terminou `failed` ou `withheld`, depois que a causa foi corrigida (um manifesto inválido, um runtime fora do PATH, uma credencial ausente). Sem a flag, o comportamento continua o de antes: um Run terminal devolve o resultado sem executar nada.

O que a retomada faz, nesta ordem:

1. recusa com exit 4 quando o plano nunca executou, quando o Run mais recente não é terminal (repita `run` sem a flag para retomar uma queda), quando ele é terminal mas não é `failed` nem `withheld`, ou quando o plano ou a reserva mudaram desde o Run (o `policySnapshotRef` do Run e os digests gravados no snapshot do coordenador têm que bater com o arquivo atual; restaure o arquivo original ou use outro `--project`);
2. lê o último snapshot do coordenador do Run anterior e deriva o snapshot de retomada (`retryMultiTargetSnapshot`): os nós `delivered` ficam como estão, com outputs e marcadores intactos; `failed`, `withheld`, `skipped` e `stalled` voltam a `pending`; o estado do plano volta a `ready`, a `attempt` é incrementada e a `version` é a do snapshot anterior mais um;
3. cria um Run canônico novo, `run_mt_<projectId>_r<attempt>`, com `parentRunId` apontando para o Run anterior e o mesmo `policySnapshotRef`, congela o `runtime.selection_snapshot` dele como em qualquer Run novo e transiciona `prepared → running`;
4. grava no journal do Run novo `multi_target.plan_retried { previousRunId, resetNodes }` e o snapshot de retomada, e emite `x_multi_target_plan_retried` no audit;
5. executa o coordenador: ele carrega o snapshot, pula os nós entregues e executa só os que voltaram a `pending`, com chaves idempotentes que carregam a tentativa (`multi-target:<digest>:<nó>:attempt-<n>`), então o marcador `.multi-target-result.json` da tentativa falha nunca responde pela nova; cada nó reexecutado recebe um Run canônico novo, `run_<projectId>_<nó>_a<n>`, e os nós entregues mantêm o Run da tentativa em que foram entregues.

Por que um Run novo, e não o mesmo: a máquina de estados do Run (`lib/run-kernel/lifecycle.ts`) não tem transição a partir de nenhum estado terminal; `failed`, `withheld`, `completed`, `rolled_back`, `cancelled` e `abandoned` têm lista de transições vazia, e `assertTransition` recusa `failed → running`. Reabrir o mesmo Run exigiria mudar a máquina de estados, e um Run que ora é terminal, ora não, quebraria o Glance, a recuperação após restart e todo leitor que confia em `TERMINAL_RUN_STATES`. O Run novo encadeado por `parentRunId` (campo que `RunProjection` já tinha) preserva a história: o Run anterior continua `failed` com seu journal, e o novo começa do snapshot herdado. `run` e `status` por arquivo de plano sempre resolvem o Run mais recente da cadeia; `status <runId>` lê um Run específico.

O custo observado de um nó retomado soma o que o audit tem para aquele trace e alvo, em todas as tentativas: um nó que gastou USD 0,25 antes de falhar e USD 0,25 na retomada reporta USD 0,50. Nós entregues em snapshots gravados antes do campo `costObserved` existir, com custo zero, passam a `costObserved: false` na retomada: eles executaram e nada foi encontrado.

Um exemplo. O plano `.nirvana/plans/smoke-cafe-solar.json` teve o nó `nirvana-pesquisa-mercado` entregue e o nó `high-conversion-copy` falho por manifesto inválido do squad. Corrigido o manifesto:

```bash
export NIRVANA_MULTI_TARGET_ENGINE=1
nrv multi-target run .nirvana/plans/smoke-cafe-solar.json --retry-failed
```

cria `run_mt_smoke-cafe-solar_r2`, mantém `nirvana-pesquisa-mercado` e executa só `high-conversion-copy` e `final-output`.

Foi essa retomada que expôs a colisão de ids: `high-conversion-copy` foi entregue, e `final-output` (síntese, Gauntlet `light`) falhou com `[run-ledger] recordSession: run 'run_smoke-cafe-solar' not found` seguido de `illegal transition completed -> completed`, porque os três nós derivavam o mesmo `run_smoke-cafe-solar` de `--project` e a onda 1 já o tinha concluído. Com o id por nó e tentativa, `nrv multi-target run .nirvana/plans/smoke-cafe-solar.json --retry-failed` cria `run_mt_smoke-cafe-solar_r3`, mantém as ondas 1 e 2 e executa só `final-output`, sob `run_smoke-cafe-solar_final-output_a3`. O teste de CLI reproduz a cadeia com o dispatch falso: um squad `standard` na onda 1, a síntese `gauntlet` na onda 2, duas tentativas em que a síntese falha e uma terceira que cria `_r3` e executa um único nó.

### `status <arquivo|runId> [--project <id>] [--json]`

Lê o Run e `projectMultiTargetRun` sem side effects: estado do Run, estado do plano, onda atual, custo e cada nó com tipo do alvo (`business`, `squad`, `agent-x`, `synthesis`, `support`), modo, estado, custo concedido e reportado, razão e bloqueios. Por arquivo de plano, o Run mostrado é o mais recente da cadeia; um Run reaberto imprime `reaberto de <parentRunId>` e `tentativa <n>`. Um nó cujo custo não foi observado carrega a nota `custo não observado`. Com um `runId` em vez de arquivo, `--project` é obrigatório. Sem kernel no projeto ou sem o Run, exit 1.

## Exit codes

| Exit | `run` | `plan` | `status` |
| --- | --- | --- | --- |
| 0 | plano `delivered`, Run `completed` | compilado | Run encontrado |
| 1 | plano `failed`, erro do coordenador ou do kernel | | kernel ou Run ausentes |
| 2 | plano `withheld` | | |
| 4 | plano inválido, opt-in ausente, Run existente com outro plano, `--retry-failed` recusado (nada a reabrir, Run não terminal ou não `failed`/`withheld`, plano ou reserva mudaram) | plano inválido | plano inválido ou `--project` ausente |

## Opt-in

`run` exige `NIRVANA_MULTI_TARGET_ENGINE=1`. `NIRVANA_MULTI_TARGET_KILL_SWITCH=1` desliga mesmo com a flag. Sem opt-in o comando termina com exit 4 e explica como habilitar, sem abrir o kernel nem gravar o workspace. `plan` e `status` funcionam sempre.

Para testes, `NIRVANA_DISPATCH_SCRIPT` aponta os adapters para outro script de dispatch; a variável só é honrada quando definida.

## Audit

O comando escreve no audit legado (`lib/audit.js`) com `trace_id` e `project_id` iguais ao `projectId`:

| Evento | Quando | Payload |
| --- | --- | --- |
| `x_multi_target_plan_compiled` | `plan` e `run` | digests, ondas, quantidade de nós, workspace |
| `x_multi_target_run_started` | `run` | `run_id`, owner, runtime, `resumed`, `retried_from` (Run anterior numa retomada, senão `null`) |
| `x_multi_target_plan_retried` | `run --retry-failed` | `run_id`, `previous_run_id`, `reset_nodes`, `attempt`, `snapshot_version` |
| `x_multi_target_node_terminal` | por nó terminal | nó, onda, tipo do alvo (`target_kind`; `null` em snapshots anteriores ao campo), modo, estado, custo reportado e concedido, `cost_observed` (`false` quando o adapter não achou evento de custo; `null` para nós de suporte), razão, bloqueios |
| `x_multi_target_cost_unobserved` | por nó que executou sem evento de custo | nó, onda, modo, estado, `logs_dir` lido pelo coordenador |
| `x_multi_target_terminal` | fim do `run` | estado do plano, estado do Run, custo total, `cost_unobserved_nodes`, razão, exit |

Os subprocessos de cada nó seguem emitindo a própria cadeia legada (`dispatch_business`, `dispatch_squad`, `dispatch_agent_x`, `gate_passed`, `delivered`) no mesmo log: os adapters passam `HARNESS_LOGS_DIR` ao filho apontando para o diretório que o coordenador lê, então o `agent_executed` de cada nó chega onde o custo é somado ([adapters](gauntlet-multi-target-adapters.md)). Um nó que encontra um Run já terminal sob o `--run-id` recebido grava `x_run_id_collision` e sai com 1 antes do produtor ([Operação do Run Kernel](run-kernel-operations.md)). O journal canônico (`multi_target.*`, `run.transitioned`), o Run do plano e o Run de cada nó ficam no mesmo kernel e aparecem no Glance.

## Retomada

Repetir `run` com o mesmo plano retoma. O coordenador carrega o último snapshot do kernel e reaplica os eventos posteriores; nós terminais não executam de novo, e o marcador `.multi-target-result.json` do adapter impede um segundo spawn para a mesma chave idempotente. Um Run terminal devolve o resultado sem executar nada; se ele terminou `failed` ou `withheld`, o comando indica `--retry-failed`.

Um nó que estava `running` no momento da queda só é reenviado quando a lease continua do mesmo owner e dentro do prazo (30 s por padrão, renovada enquanto o adapter roda). Por isso, para retomar logo depois de uma queda, repita o comando com o mesmo `--owner`. Lease expirada ou de outro owner marca o nó como `stalled` e o plano como `failed`, sem takeover automático; `--retry-failed` reabre esse plano e executa o nó `stalled` de novo, junto com o que dependia dele.

Um plano diferente sob o mesmo `projectId` é recusado com exit 4, porque o Run existente aponta para outro `policySnapshotRef`. Vale também para a retomada: ela só reabre o plano que originou o Run.

## Seleção explícita no dispatch

`dispatch.ts` aceita `--business <slug>`, `--squad <slug>` e `--agent-x`, mutuamente exclusivos entre si e com `--auto`. `--business` equivale ao positional; `--squad` preenche `explicitTarget` em `resolveDispatchPlan` e segue pela rota squad-only; `--agent-x` vai direto ao branch agent-x. Nenhum deles consulta o roteador. Os adapters usam essas flags, então nenhum nó paga chamada de LLM para ser selecionado. Sem as flags, o dispatch se comporta exatamente como antes.

## Limitações

- O `manifest.json` gravado no workspace é o manifest compilado, com todas as fases `pending`; o estado vivo está no kernel e em `status`.
- O endpoint `/api/v1/runs/:run/multi-target` do Glance valida `project_id` com prefixo `prj_` ou `proj-`; um trace id fora desse padrão aparece só por `status`.
- Retomar um nó em execução depende de owner e lease; não há recovery humano nem cancelamento conjunto.
- `--retry-failed` reexecuta um nó `withheld` com o mesmo sub-brief; ele paga de novo por esse nó, e os outputs retidos são sobrescritos pela nova execução.
- Interromper o comando não encerra os subprocessos de dispatch em andamento; a lease expira e o próximo `run` marca o nó como `stalled`.
- Um nó `agent` em modo `gauntlet` é julgado como qualquer produtor agent-x: o avaliador precisa ser independente (`evaluator-registry.ts`), então sem squad instalado que declare `quality.specification_conformance` a rodada cai na heurística, auditada em `x_gauntlet_evaluator_fallback`. Um `judge-x` independente é outro corte.
