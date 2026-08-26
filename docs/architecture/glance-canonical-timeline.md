# Timeline canônica no Glance

## Estado

A timeline do chat consome o stream canônico `GET /api/v1/projects/:prj/stream` e o journal `GET /api/v1/projects/:prj/events`. Antes deste corte, o renderizador conhecia apenas o formato legado do audit (`ev.event`), e todo evento do Run Kernel caía num ícone genérico sem título.

O mapa de rótulos agora vive em `skills/harness/lib/glance/views/run-event-labels.js`, um módulo ES puro, sem dependências. `bun test` importa o arquivo diretamente. A página carrega o mesmo arquivo por um `<script type="module">` em `index.html`, que expõe as exportações como `window.NirvanaRunEventLabels`, porque `glance.js` é um script clássico e apenas delega. Não existe cópia do mapa.

## Resolução de rótulos

`runEventView(ev)` resolve por `ev.type` quando presente. Sem `type`, usa o mapa legado por `ev.event`, preservado sem alteração. Eventos `delivery.<evento_legado>`, gravados pela facade de compatibilidade com os campos legados dentro de `payload`, são desembrulhados e resolvidos pelo mapa antigo.

Um tipo canônico desconhecido produz o próprio tipo como título. Um evento sem `type` nem `event` produz `evento`. O título nunca é indefinido.

## Mapa de tipos

| Tipo | Título | Subtítulo | Tom |
|---|---|---|---|
| `run.prepared` | Run preparado → slug do alvo | kind e capability | neutro |
| `run.transitioned` | Run + estado de destino | `from → to` | ok, active ou fail pelo estado |
| `runtime.selection_snapshot` | Runtime: id | provider e modelo | neutro |
| `gauntlet.plan_compiled` | Plano Gauntlet + intensidade | estado inicial e motivo de parada | neutro |
| `gauntlet.candidate_created` | Candidate id criado | revisão, producer e artifacts | active |
| `gauntlet.candidate_revised` | Candidate id revisado | revisão, producer e artifacts | active |
| `gauntlet.evaluation_recorded` | Avaliação: veredito | gauntletId, evaluator e custo | pelo veredito |
| `gauntlet.round_started` | Rodada n iniciada | custo reservado | active |
| `gauntlet.round_evaluated` | Rodada n avaliada | score, melhora, regressões e falha bloqueante | ok ou fail |
| `gauntlet.revision_requested` | Revisão solicitada | quantidade de pedidos | active |
| `gauntlet.regression_started` | Regressão iniciada | vazio | active |
| `gauntlet.stopped` | Gauntlet parou: decisão | motivo, ressalvas e gate final pendente | pela decisão |
| `canary.recovery_enqueued` | Recuperação enfileirada | motivo | active |
| `canary.recovery_skipped` | Recuperação ignorada | motivo | neutro |
| `multi_target.snapshots_bound` | Plano multi-target vinculado | digests abreviados | neutro |
| `multi_target.snapshot_saved` | Snapshot vN salvo | estado e onda | neutro, oculto por padrão |
| `multi_target.node_started` | Nó id iniciado | onda, modo e custo concedido | active |
| `multi_target.node_delivered` | Nó id entregue | onda e custo reportado | ok |
| `multi_target.node_withheld` | Nó id retido | onda e razão | fail |
| `multi_target.node_failed` | Nó id falhou | onda e razão | fail |
| `multi_target.node_skipped` | Nó id pulado | onda e bloqueios | fail |
| `multi_target.node_stalled` | Nó id travado | onda e razão | fail |
| `multi_target.support_completed` | Nó id de suporte concluído | onda | ok |
| `multi_target.budget_exceeded` | Nó id excedeu o orçamento | onda e razão | fail |
| `multi_target.lease_claimed` | Lease de id obtida | owner e versão | neutro |
| `multi_target.lease_renewed` | Lease de id renovada | owner e versão | neutro, oculto por padrão |
| `multi_target.lease_released` | Lease de id liberada | owner e versão | neutro |
| `multi_target.lease_lost` | Lease de id perdida | owner, versão e razão | fail |
| `multi_target.plan_terminal` | Plano multi-target + estado | razão | pelo estado |

Estados de Run, decisões e motivos de parada do Gauntlet, vereditos e estados de plano aparecem em PT-BR nos títulos. Os badges do cabeçalho e do painel mostram o identificador bruto do estado, como o restante da UI. O teste `glance-run-event-labels.test.ts` falha quando o módulo cobre um conjunto diferente desta lista.

## Colapso de eventos frequentes

`multi_target.snapshot_saved` e `multi_target.lease_renewed` chegam em volume alto e não mudam a leitura do Run. `runTimeline(events, showInfra)` devolve as linhas visíveis e a contagem de ocultos. Por padrão esses dois tipos ficam fora da lista e o rodapé da timeline mostra o botão "Mostrar N eventos de infraestrutura". O clique alterna `chatInfraVisible` e a lista passa a exibir tudo, na ordem de sequence.

A ocultação com toggle foi escolhida no lugar da contagem agrupada porque snapshots se intercalam com eventos de nó em cada onda; agrupar apenas vizinhos deixaria uma linha de snapshot a cada dois ou três passos. Os eventos permanecem em `chatRunEvents` e no journal; nada é descartado.

## Resumo canônico do Run

`summarizeRunEvents(events)` alimenta o cabeçalho vivo e mantém os campos legados. Para eventos canônicos:

- `state` vem do último `run.transitioned` (`payload.to`).
- `business`, `squad` ou `lastAgent` vêm de `run.prepared` (`payload.target`).
- `runtime` e `model` vêm de `runtime.selection_snapshot`.
- `decision` e `stopReason` vêm de `gauntlet.stopped`.
- `artifacts` soma os `artifactRefs` de candidates criados ou revisados.
- `cost` usa o custo reportado por nó quando existem eventos `multi_target.*` com `payload.node`, contando o último valor de cada `nodeId`. Sem eventos de nó, soma o custo reservado em `gauntlet.round_started`. O controller emite esse valor como `costReservedUsd`; o módulo também aceita `expectedCostUsd`.

O cabeçalho mostra estado como badge e a decisão do Gauntlet com o motivo. Ao fim do stream, a timeline e a projeção multi-target ficam guardadas na mensagem, para que a superfície do Run não desapareça quando `streaming` vira falso.

## Endpoint multi-target

`GET /api/v1/runs/:run/multi-target?project_id=` segue o padrão de `GET /api/v1/runs/:run/gauntlet`:

- `400` quando `project_id` não é `prj_*` nem `proj-*`;
- `404` quando o Run não existe no kernel;
- `200` com `{ "projection": null }` quando o Run nunca salvou snapshot do coordenador;
- `200` com `{ "projection": MultiTargetCoordinatorSnapshot }` nos demais casos.

A reconstrução está em `skills/harness/lib/gauntlet/multi-target-projection.ts`, função `projectMultiTargetRun(kernel, projectId, runId)`, exportada pelo `index.ts` do gauntlet. Ela lê o último `multi_target.snapshot_saved` do Run e reaplica os eventos `multi_target.*` posteriores que carregam `payload.node` ou o `multi_target.plan_terminal`, recalculando `reportedCostUsd`. É a mesma reaplicação que as portas do Run Kernel fazem no reload, então um crash entre o evento terminal de um nó e o próximo snapshot aparece no Glance com o nó já entregue. A leitura não cria tabelas nem escreve no journal.

## Painel

O painel aparece dentro da superfície do Run somente quando a projeção existe. Durante o stream, `subscribeCanonicalRun` refaz a leitura do endpoint a cada snapshot, evento de nó ou evento terminal; eventos de lease não disparam leitura. O cabeçalho traz estado do plano, onda atual, custo reportado total e razão terminal. A tabela usa cabeçalhos de coluna e de linha, e o estado de cada nó aparece como texto dentro do badge, sem depender de cor. Colunas: onda, nó, modo, estado, custo concedido, custo reportado, razão e bloqueios.

## Limitações

- O painel vive na superfície do chat, onde os Runs canônicos são exibidos. A aba Runs continua derivada do audit legado e não lê o kernel.
- Razões e bloqueios são textos do coordenador, em inglês.
- A projeção percorre todos os eventos do Project a cada leitura. As portas do Run Kernel já delegam a `projectMultiTargetRun`; um índice por Run fica para um corte futuro.
- `multi_target.lease_lost` já tem rótulo, mas o evento ainda não é emitido neste corte.
- O adaptador de módulo executa depois do `Alpine.start()`. Se o arquivo não carregar, `runEventView` degrada para o próprio tipo como título, sem mapa duplicado.
