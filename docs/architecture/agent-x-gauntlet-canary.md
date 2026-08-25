# Canário Gauntlet para agent-x, Squad e Business

## Escopo habilitado

O cutover vertical do Gauntlet executa quando todas estas condições são verdadeiras:

- `--exec` está ativo;
- o modo resolvido é `gauntlet`, pedido de forma explícita;
- o roteamento real terminou em `agent-x`, em exatamente um Squad, ou em um Business presente em `NIRVANA_BUSINESS_GAUNTLET_ALLOWLIST`, sem kill switch e fora do team mode.

As três intensidades entram no cutover. `light` produz um candidate por rodada, `balanced` produz três e `exhaustive` produz cinco, sempre com os limites de rounds, custo e duração do plano compilado. Rotas com dois ou mais Squads permanecem no fluxo anterior, pois exigem isolamento e composição explícitos entre outputs. O modo `standard` continua sendo o padrão e não muda.

## Fluxo do cutover

O helper `runAgentXGauntlet` abre o Run Kernel pela facade de compatibilidade, compila o plano da intensidade pedida e percorre o controller até uma parada finita. Cada rodada `r` reserva custo, produz `can_1..can_N` em `.nirvana/gauntlet/<run>/candidates/can_<n>/rev_<r>` e registra um `ArtifactRef` verificado e imutável para cada arquivo. O evaluator independente recebe `candidateId`, `revisionId`, a rodada e o metadata `holdout` do plano, e avalia todas as revisões da rodada.

Quando o controller pede revisão, o cutover chama `reviseCandidate` para cada candidate com defeitos: dimensões reprovadas, `revisionRequests`, ids das avaliações causais e o caminho da revisão anterior. A nova revisão começa como cópia da anterior e é registrada como `CandidateRevision` filha, com `parentRevisionId`, `causalEvaluationIds` e hipótese. Um candidate sem defeitos na rodada anterior é carregado adiante sem novo producer. A rodada seguinte reavalia todas as revisões; o controller compara cada lineage consigo mesma para detectar regressão e ordena as revisões por evidência: sem falha bloqueante, maior nota ponderada, id estável.

A parada é sempre do controller: `success`, `max_rounds`, `max_cost`, `max_duration`, `no_progress`, `critical_regression`, `judge_disagreement` ou `execution_failure`. Só a revisão apontada em `selectedRevisionId` é publicada em `outputsRoot` e passa pelo `runDelivery` existente, que continua sendo o quality gate obrigatório. Qualquer outra parada encerra o Run em `withheld` com a razão no payload da transição.

No `dispatch.ts`, os três call sites reutilizam o mesmo producer para o candidate inicial e para cada revisão: mesma função de execução, mesmo runtime, com o brief original mais a seção "Defeitos a corrigir" gravada ao lado das revisões do candidate. O Business reconstrói o prompt do employee por candidate, para que cada revisão escreva no próprio diretório. O custo reservado por rodada é a estimativa por candidate multiplicada por `candidateStrategy.count`, sem ultrapassar o teto do plano; a estimativa divide o teto pelo número de rounds e de candidates, e `--max-budget` só a reduz.

O Glance expõe `GET /api/v1/runs/{run_id}/gauntlet?project_id={project_id}`. O servidor precisa abrir o mesmo Project root que contém `.nirvana/run-kernel.sqlite`.

## Retomada

`runAgentXGauntlet` é idempotente por rodada, candidate e revisão. Após um crash em qualquer ponto, reexecutar o helper continua da primeira unidade incompleta: rodadas já iniciadas não são reabertas, revisões persistidas não chamam producer nem `reviseCandidate`, e scorecards persistidos não chamam o evaluator. A avaliação de uma rodada é gravada em uma única transação com a decisão seguinte, então um crash entre as duas deixa o Gauntlet em `producing` e a reavaliação é repetida com a mesma chave.

## Corte vertical do chat

Em um Project adotado, `POST /api/v1/conversations/{conversation_id}/messages` persiste a Message, prepara um Run canônico e grava o vínculo `message.run_id`. A única execução permitida nesse corte é `agent-x` com `policySnapshotRef: gauntlet-light-canary`. O mesmo `Idempotency-Key` retorna a mesma Message e o mesmo Run.

Uma fila local serializa o canário e recebe um adapter explícito. O adapter declara se a capability `agent-x.gauntlet.light` existe, executa o candidate, fornece evaluator independente e chama o gate final. Sem adapter compatível, o Run termina em `rolled_back` com `reason: capability_unavailable`; não há fallback silencioso para outro runtime, target ou intensidade. O adapter não fornece `reviseCandidate`: um Gauntlet que chega a `revising` encerra `withheld` com razão `revision_unavailable`.

O endpoint `POST /api/v1/runs/{run_id}:cancel` cancela Runs ainda na fila antes de qualquer side effect. Cancelamento durante execução é cooperativo pelo `AbortSignal` do adapter. A UI acompanha o mesmo `.nirvana/run-kernel.sqlite` por SSE e deixa de iniciar o action runner legado quando recebe um Run canônico. Projetos não adotados continuam no chat legado.

## Limites

- Rotas com múltiplos Squads e o coordenador multi-target ainda não usam este loop.
- O evaluator de produção é o quality gate offline do harness por um adapter injetável; a nota é a fração de arquivos avaliáveis aprovados. Um candidate com nota zero em `light` para em `no_progress` já na primeira rodada, porque a paciência do perfil é uma rodada. Uma capability organizacional dedicada poderá substituir o evaluator sem alterar o controller.
- Holdout é metadata `evaluator_only` repassado ao evaluator. Não há isolamento físico do conteúdo.
- A publicação usa arquivos temporários e rename por arquivo. Ela é retomável e não sobrescreve arquivos idênticos, mas ainda não oferece commit atômico do diretório inteiro.
- Uma interrupção entre os arquivos do candidate e o registro da revisão repete o producer daquela revisão. Uma interrupção durante o gate final pode repetir o gate, que deve permanecer idempotente por artifacts e event identity.
- No Business, o rollback para o executor legado só acontece antes do primeiro producer do processo atual; uma retomada que falha antes de qualquer producer ainda cai nessa regra.
- A fila em memória não é uma segunda fonte de verdade. No restart, o Glance procura Runs `prepared` desse canário que tenham `conversationId` e uma Message vinculada ao mesmo `runId`. Esses Runs recebem `canary.recovery_enqueued` e voltam à fila pelo adapter injetado.
- Recovery é conservador. Runs `running`, cancelados e terminais não são retomados. Um Run `running` só poderá voltar a executar quando um marco posterior provar uma lease recuperável do provider.
- O claim acontece pela transição atômica `prepared → running`. Dois restarts podem descobrir o mesmo Run, mas somente um alcança o side effect. O evento de recovery usa idempotência por `runId`.
- O Glance não escolhe runtime ou modelo neste canário. A ausência do adapter é tratada como capability indisponível.
