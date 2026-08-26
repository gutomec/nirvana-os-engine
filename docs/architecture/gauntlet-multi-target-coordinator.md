# Coordenador Gauntlet multi-target

## Estado e fronteira

`coordinateMultiTargetPlan` é a fronteira interna que consome `CompiledMultiTargetPlan` e `AggregateGauntletBudgetReservation`. Ela executa o manifest existente por ondas. O comando opt-in `nrv multi-target run` a conecta ao CLI e aos adapters de dispatch ([Comando multi-target](gauntlet-multi-target-cli.md)); nenhuma rota existente do dispatch a chama.

O coordenador não recompila política, não recalcula reserva e não constrói outro DAG. Antes de qualquer side effect, ele recalcula os digests dos snapshots, exige correspondência entre `reservation.policyDigest` e `plan.digest` e recusa reservas rejeitadas. Um plano com decisões Gauntlet não pode iniciar sem reserva agregada.

## Execução por ondas

As ondas vêm exclusivamente de `manifest.parallel_waves`. Dentro de uma onda, adapters independentes executam com `Promise.all`. O coordenador marca e persiste todos os nós iniciados antes das chamadas. Resultados são aplicados em ordem de ID, então a projeção e os eventos terminais não dependem da ordem de conclusão dos adapters.

Um nó executável recebe:

- target tipado como `business`, `squad`, `agent-x` ou `synthesis`;
- modo `standard` ou `gauntlet` já compilado;
- intensidade, quando aplicável;
- concessão da reserva agregada;
- paths de todos os predecessores entregues;
- `outputs_path` exclusivo da fase;
- chave idempotente derivada do digest da política e do ID do nó;
- sinal explícito de retomada.

`standard` usa somente o adapter legado injetado. `gauntlet` usa somente o adapter Gauntlet injetado. Fases `support`, como o brief, são projetadas como entregues sem chamar adapter. A síntese só usa adapter quando existe como decisão explícita.

## Falhas e orçamento

Somente `delivered` satisfaz uma dependência. `withheld`, `failed`, `stalled` ou `skipped` impedem consumidores. Irmãos já iniciados na mesma onda continuam até o resultado, pois cancelamento conjunto ainda não faz parte da política.

O custo reportado por uma decisão Gauntlet precisa ser finito, não negativo e menor ou igual à concessão. Excesso gera `failed`, evento `multi_target.budget_exceeded` e bloqueio dos consumidores. Custos de adapters `standard` são registrados, mas não debitados da reserva Gauntlet.

Um adapter pode devolver `costObserved: false`: o nó executou e nenhum evento de custo foi encontrado. O coordenador copia a flag para a projeção do nó (`MultiTargetNodeProjection.costObserved`), emite o evento terminal do nó como sempre e, em seguida, `multi_target.cost_unobserved { nodeId, waveIndex, mode, state }`, sem payload `node`, para que a projeção continue reconstruída só a partir dos eventos terminais. A verificação de orçamento não muda: ela compara o que foi reportado, e um custo não observado é zero para ela, o que é justamente a cegueira que o evento denuncia.

O estado terminal do plano é `failed` quando existe falha ou nó sem lease recuperável. Sem falha, withholding ou skip produz `withheld`. Somente todos os nós entregues produzem `delivered`.

## Retomada e projeção

As portas `state` e `journal` são injetáveis. A primeira carrega e persiste `MultiTargetCoordinatorSnapshot`; cada nó da projeção carrega `targetKind` (`business`, `squad`, `agent-x`, `synthesis` ou `support`), ausente só em snapshots gravados antes do campo existir. A segunda persiste as referências imutáveis e recebe eventos tipados. `createRunKernelMultiTargetPorts` implementa ambas sobre o journal, sequence e outbox canônicos, além da lease operacional por nó.

Nós terminais não executam novamente. Um nó persistido como `running` só é reenviado quando a porta de lease confirma recuperação; nesse caso, o adapter recebe a mesma chave idempotente e `resume: true`. Sem lease, o nó vira `stalled` e nenhum side effect é presumido seguro.

## Retomada de um plano falho

`retryMultiTargetSnapshot({ previous, plan, reservation })` deriva, de um snapshot terminal `failed` ou `withheld`, o snapshot com que um Run novo recomeça. Ele recalcula os digests (`assertResumeSnapshot`) e recusa qualquer outro estado. Os nós `delivered` ficam como estão; `failed`, `withheld`, `skipped` e `stalled` (`RETRYABLE_NODE_STATES`) voltam a `pending`, sem razão, bloqueios nem outputs. O plano volta a `ready`, `currentWave` a `-1`, `attempt` recebe o anterior mais um e `version` o anterior mais um. A função devolve o snapshot e a lista ordenada dos nós reabertos; o snapshot anterior não é alterado.

A `attempt` entra na chave idempotente que o coordenador entrega ao adapter: `multi-target:<digest>:<nó>` na primeira tentativa e `multi-target:<digest>:<nó>:attempt-<n>` a partir da segunda. Assim o marcador `.multi-target-result.json` da tentativa falha não responde pela nova, enquanto uma queda no meio da retomada continua retomável pela mesma chave.

Um nó entregue num snapshot anterior ao campo `costObserved`, com custo zero e decisão executável, passa a `costObserved: false`: ele executou e nada foi observado. Nós de suporte, que nunca executam, não recebem a marca.

O comando `run --retry-failed` ([comando](gauntlet-multi-target-cli.md)) cria o Run encadeado, grava `multi_target.plan_retried { previousRunId, resetNodes }` e o snapshot de retomada no journal do Run novo, e chama o coordenador, que carrega o snapshot pela porta `state`, pula os nós entregues e executa o restante.

## Limitações e próximo cutover

Não há cancellation policy nem recovery humano. Os adapters de produção e o comando público existem ([adapters](gauntlet-multi-target-adapters.md), [comando](gauntlet-multi-target-cli.md)); o comando permanece opt-in por variável de ambiente, e nenhuma rota existente do dispatch encaminha ao coordenador.
