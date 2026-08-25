# Coordenador Gauntlet multi-target

## Estado e fronteira

`coordinateMultiTargetPlan` é a fronteira interna que consome `CompiledMultiTargetPlan` e `AggregateGauntletBudgetReservation`. Ela executa o manifest existente por ondas, mas não está conectada ao CLI, ao dispatch público ou a entidades instaladas.

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

O estado terminal do plano é `failed` quando existe falha ou nó sem lease recuperável. Sem falha, withholding ou skip produz `withheld`. Somente todos os nós entregues produzem `delivered`.

## Retomada e projeção

As portas `state` e `journal` são injetáveis. A primeira carrega e persiste `MultiTargetCoordinatorSnapshot`. A segunda persiste as referências imutáveis e recebe eventos tipados que podem ser projetados futuramente no Run Kernel.

Nós terminais não executam novamente. Um nó persistido como `running` só é reenviado quando a porta de lease confirma recuperação; nesse caso, o adapter recebe a mesma chave idempotente e `resume: true`. Sem lease, o nó vira `stalled` e nenhum side effect é presumido seguro.

## Limitações e próximo cutover

Não há adapter de produção registrado, escrita direta no Run Kernel, cancellation policy, lease concreta nem comando público. Os testes usam somente adapters locais determinísticos. O próximo cutover deve implementar portas canônicas sobre o Run Kernel, provar crash resume com storage real e liberar uma allowlist separada antes de encaminhar qualquer dispatch público ao coordenador.
