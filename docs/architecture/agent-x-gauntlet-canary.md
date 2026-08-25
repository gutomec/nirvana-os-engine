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

## Limites

- Há um candidato e nenhuma revisão automática nesta fase.
- `balanced`, `exhaustive`, business e squad ainda não entram no cutover.
- O evaluator inicial usa o quality gate offline do harness por um adapter injetável. Uma capability organizacional dedicada poderá substituí-lo sem alterar o controller.
- A publicação usa arquivos temporários e rename por arquivo. Ela é retomável e não sobrescreve arquivos idênticos, mas ainda não oferece commit atômico do diretório inteiro.
- Uma interrupção após persistir o candidato retoma sem novo dispatch. Uma interrupção durante o gate final pode repetir o gate, que deve permanecer idempotente por artifacts e event identity.
