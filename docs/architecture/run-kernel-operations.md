# Operação do Run Kernel

## Escopo desta implementação

O módulo `skills/harness/lib/run-kernel/` implementa a fundação canônica descrita nos ADRs 001, 002, 003 e 008. Ele mantém o dispatch atual intacto. A adoção ocorre por uma facade explícita, portanto nenhum caller legado muda de comportamento apenas ao atualizar o engine.

O kernel contém:

- journal append-only com sequência monotônica por Project;
- identidade e idempotência de events;
- causalidade confinada ao mesmo Project;
- lifecycle canônico de Run;
- projections reconstruíveis por replay;
- outbox durável no mesmo commit do event;
- transcript separado, limitado a mensagens visíveis;
- `ArtifactRef` imutável com digest, tamanho, media type, producer e URI publicada;
- facade opcional para o audit JSONL e o run ledger existentes.
- scopes aninhados com authority monotônica e descarte LIFO idempotente.

## Storage

Cada instância usa um arquivo SQLite definido pelo caller. O schema inicial tem versão `1` e cria as tabelas `project_sequences`, `run_events`, `run_projections`, `kernel_outbox`, `transcript_messages` e `artifact_refs`. WAL, `busy_timeout`, foreign keys e `synchronous=FULL` são configurados na abertura. Toda transação de escrita do kernel (journal, projections, store do Gauntlet e leases multi-target) começa com `BEGIN IMMEDIATE`: uma transação deferred que lê antes de escrever recebe `SQLITE_BUSY` imediato, sem passar pelo busy handler, quando outro processo gravou entre a leitura e a escrita, e é exatamente isso que acontece entre o servidor do Glance e o filho de dispatch no mesmo arquivo.

O journal e a outbox não devem ser apagados em rollback. Desativar o writer novo basta para retornar aos readers legados. A facade mantém o ledger atual no formato existente e adiciona somente eventos `x_run_kernel_projection` ao audit.

## Recovery

Um event e sua linha de outbox são gravados na mesma transação. Se a publicação falhar, a linha permanece pendente e uma chamada posterior a `publishOutbox` tenta novamente com o mesmo `eventId`. O consumer precisa deduplicar pelo `eventId`, pois uma falha após o side effect remoto e antes da confirmação local pode produzir nova entrega.

As projections podem ser descartadas e reconstruídas com `rebuildProjections`. O snapshot canônico antes e depois do replay deve ser idêntico.

## Compatibilidade e cutover

`RunKernelCompatibilityFacade` centraliza o dual-write. `createHarnessLegacyAdapter` projeta apenas transições representáveis pelo ledger atual. Estados canônicos sem equivalente exato continuam preservados no kernel e aparecem no audit; a facade não força uma transição ilegal no ledger. O mapa canônico → legado é fixo: `prepared` → `dispatched`; `running`, `waiting`, `revising` e `cancelling` → `running`; `verifying` → `verifying`; `completed` e `delivered_with_reservations` → `delivered` (a reserva fica em `meta.canonical_state`); `withheld` → `withheld`; `failed`, `rolled_back` e `cancelled` → `failed`, com o `error` da transição, senão a `reason` e os `errors` dela, em `last_error`, inclusive no rollback antes do producer de um canário Gauntlet, que abre ou adota a linha pelo mesmo adapter; `abandoned` não é projetado, porque o ledger só chega lá por `abandon()`.

O cutover recomendado é vertical:

1. abrir o kernel em shadow mode;
2. habilitar a facade para um fluxo;
3. comparar projection canônica, ledger e audit;
4. promover um reader por vez;
5. manter o fallback legado durante a janela de paridade.

## Publicação do modo standard

O modo `standard` do `dispatch.ts` publica cada execução com `--exec` como Run canônico pelo módulo `standard-publication.ts`, em vez da facade: o run-ledger legado já é aberto pelo próprio dispatch, e a facade com adapter legado criaria uma segunda linha sem heartbeat. As branches chamam quatro operações e nada mais.

1. `openStandardPublication` abre o kernel do projeto, cria o Run tipado (`{kind: "business", slug}`, `{kind: "squad", slug, capabilityId}` ou `{kind: "agent-x", slug: "agent-x"}`) ou adota o Run que o Glance preparou com `--run-id`, grava `runtime.selection_snapshot` com o snapshot congelado pelo broker e deriva `policySnapshotRef` do digest desse snapshot. Um Run adotado mantém o trace e o `policySnapshotRef` com que foi preparado, e não recebe um segundo `run.prepared`. A adoção segue a regra da seção seguinte: um Run já terminal sob o id recebido é recusado, e a publicação devolve `collided` para o dispatch sair com 1 antes de qualquer producer (a branch business marca a linha do run-ledger como `failed`).
2. `start` transiciona `prepared → running` antes do executor.
3. `verify` transiciona `running → verifying` antes da delivery pipeline.
4. `finish` aplica o estado terminal pelo resultado da entrega: `completed` (exit 0, gate `pass`), `delivered_with_reservations` (exit 0 com `fail-forced` ou `fail-accepted`), `withheld` (exit 2 ou 3) ou `failed` (exit 1 ou erro de runtime, com `payload.error`). O payload terminal registra `exitCode`, `gateOutcome` e `outputsRoot`.

As chaves idempotentes usam o prefixo `standard:<runId>:` (`create`, `execution-snapshot`, `running`, `verifying`, `terminal`), então repetir um dispatch sobre o mesmo Run não duplica eventos. Snapshot com erros do broker encerra o Run em `rolled_back` com `reason: runtime_incompatible` antes do producer, e o dispatch sai com 1.

A publicação é fail-open. Kernel que não abre ou não aceita a transição (disco, permissão, Run adotado num estado que recusa a transição, como um Run ainda `running`) gera `x_run_kernel_unavailable` no audit legado, com `stage` e `error`, e a publicação fica inerte: exit codes, artifacts, audit e session file seguem idênticos ao fluxo anterior. Sem `--exec`, ou com argumentos inválidos, nenhum Run é criado. Uma rota com vários Squads publica sob o primeiro; depois de um rollback do canário Business, o fallback legado não publica um segundo Run, porque o kernel já guarda o estado terminal daquele `runId`.

## Regra de adoção

Um Run só é adotado (continuado por outro processo sob o mesmo id, via `--run-id`) enquanto não terminou. A regra vale para a publicação do modo `standard` e para o cutover Gauntlet (`runAgentXGauntlet`), que leem o Run antes de qualquer escrita no kernel. Sob um id cujo Run é terminal (`completed`, `withheld`, `delivered_with_reservations`, `failed`, `rolled_back`, `cancelled`, `abandoned`), nada é recriado nem transicionado: a publicação `standard` avisa `run '<id>' is already terminal (<estado>); pass a fresh --run-id` e devolve `collided`; o cutover lança `RunAlreadyTerminalError` (`lib/run-kernel/lifecycle.ts`) e os três canários saem com 1, sendo que o canário Business nunca converte essa recusa em rollback para o produtor legado, que rodaria sob o mesmo id. Nos dois casos o audit legado recebe `x_run_id_collision` com `run_id`, `state`, `target_kind` do dispatch recusado, `run_target` do Run existente, `mode` (`standard` ou `gauntlet`) e, na publicação, `kernel_path`.

A regra nasceu de um plano multi-target cujos nós derivavam todos `run_<projectId>` de `--project`: a onda 1 concluiu o Run, a onda 2 reproduziu os eventos dele e a onda 3 adotou o Run `completed`, produziu um candidato e morreu em `illegal transition completed -> completed`. Cada nó passou a receber o próprio `--run-id` ([adapters multi-target](gauntlet-multi-target-adapters.md)); a recusa cobre qualquer outro caminho que repita um id.

Um Run adotado que ainda não terminou ganha, na adoção pelo cutover, a linha do run-ledger legado sob o mesmo `run_id`. Só `facade.create` a abria: um Run preparado pelo Glance chegava ao cutover sem linha, o dual-write lançava `legacy run '<id>' is missing` na primeira transição e `recordSession` registrava `run '<id>' not found` depois de cada produtor. O `openRun` do adapter legado é idempotente sobre uma linha existente, então a adoção o chama sem duplicar nada.

## Limites conhecidos

Esta fundação não altera Gauntlet, runtime providers nem supervisor; o dispatch escreve no kernel apenas pela publicação do modo `standard` descrita acima. A outbox oferece entrega pelo menos uma vez, com identidade estável para deduplicação, porque exatamente uma vez entre SQLite e um side effect externo exige cooperação do consumer. A publicação atômica de artifacts além da verificação de `ArtifactRef` fica para o marco próprio previsto no plano incremental.
