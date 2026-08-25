# Canário Gauntlet para agent-x

## Escopo habilitado

O primeiro cutover vertical do Gauntlet é deliberadamente restrito. Ele executa somente quando todas estas condições são verdadeiras:

- o roteamento real terminou em `agent-x`;
- `--exec` está ativo;
- o modo resolvido é `gauntlet`;
- a intensidade é `light`.

O modo `standard` continua no fluxo anterior. Rotas de business e squad também permanecem intactas, mesmo quando uma opção de Gauntlet é informada.

## Fluxo do canário

O helper `runAgentXGauntlet` abre o Run Kernel pela facade de compatibilidade, compila o plano light, reserva orçamento e executa um candidato em `.nirvana/gauntlet/<run>/candidates/can_1/rev_1`. Os arquivos recebem `ArtifactRef` verificado e imutável.

Um adapter de avaliação processualmente separado produz o scorecard com identidade diferente do produtor. Aprovação pelo Gauntlet ainda não entrega nada. O candidato selecionado é publicado no diretório final e passa pelo `runDelivery` existente, que continua sendo o quality gate obrigatório.

O Glance expõe `GET /api/v1/runs/{run_id}/gauntlet?project_id={project_id}`. O servidor precisa abrir o mesmo Project root que contém `.nirvana/run-kernel.sqlite`.

## Corte vertical do chat

Em um Project adotado, `POST /api/v1/conversations/{conversation_id}/messages` persiste a Message, prepara um Run canônico e grava o vínculo `message.run_id`. A única execução permitida nesse corte é `agent-x` com `policySnapshotRef: gauntlet-light-canary`. O mesmo `Idempotency-Key` retorna a mesma Message e o mesmo Run.

Uma fila local serializa o canário e recebe um adapter explícito. O adapter declara se a capability `agent-x.gauntlet.light` existe, executa o candidate, fornece evaluator independente e chama o gate final. Sem adapter compatível, o Run termina em `rolled_back` com `reason: capability_unavailable`; não há fallback silencioso para outro runtime, target ou intensidade.

O endpoint `POST /api/v1/runs/{run_id}:cancel` cancela Runs ainda na fila antes de qualquer side effect. Cancelamento durante execução é cooperativo pelo `AbortSignal` do adapter. A UI acompanha o mesmo `.nirvana/run-kernel.sqlite` por SSE e deixa de iniciar o action runner legado quando recebe um Run canônico. Projetos não adotados continuam no chat legado.

## Limites

- Há um candidato e nenhuma revisão automática nesta fase.
- `balanced`, `exhaustive`, business e squad ainda não entram no cutover.
- O evaluator inicial usa o quality gate offline do harness por um adapter injetável. Uma capability organizacional dedicada poderá substituí-lo sem alterar o controller.
- A publicação usa arquivos temporários e rename por arquivo. Ela é retomável e não sobrescreve arquivos idênticos, mas ainda não oferece commit atômico do diretório inteiro.
- Uma interrupção após persistir o candidato retoma sem novo dispatch. Uma interrupção durante o gate final pode repetir o gate, que deve permanecer idempotente por artifacts e event identity.
- A fila em memória não é uma segunda fonte de verdade. No restart, o Glance procura Runs `prepared` desse canário que tenham `conversationId` e uma Message vinculada ao mesmo `runId`. Esses Runs recebem `canary.recovery_enqueued` e voltam à fila pelo adapter injetado.
- Recovery é conservador. Runs `running`, cancelados e terminais não são retomados. Um Run `running` só poderá voltar a executar quando um marco posterior provar uma lease recuperável do provider.
- O claim acontece pela transição atômica `prepared → running`. Dois restarts podem descobrir o mesmo Run, mas somente um alcança o side effect. O evento de recovery usa idempotência por `runId`.
- O Glance não escolhe runtime ou modelo neste canário. A ausência do adapter é tratada como capability indisponível.
