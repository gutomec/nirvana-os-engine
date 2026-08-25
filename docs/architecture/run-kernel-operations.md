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

Cada instância usa um arquivo SQLite definido pelo caller. O schema inicial tem versão `1` e cria as tabelas `project_sequences`, `run_events`, `run_projections`, `kernel_outbox`, `transcript_messages` e `artifact_refs`. WAL, `busy_timeout`, foreign keys e `synchronous=FULL` são configurados na abertura.

O journal e a outbox não devem ser apagados em rollback. Desativar o writer novo basta para retornar aos readers legados. A facade mantém o ledger atual no formato existente e adiciona somente eventos `x_run_kernel_projection` ao audit.

## Recovery

Um event e sua linha de outbox são gravados na mesma transação. Se a publicação falhar, a linha permanece pendente e uma chamada posterior a `publishOutbox` tenta novamente com o mesmo `eventId`. O consumer precisa deduplicar pelo `eventId`, pois uma falha após o side effect remoto e antes da confirmação local pode produzir nova entrega.

As projections podem ser descartadas e reconstruídas com `rebuildProjections`. O snapshot canônico antes e depois do replay deve ser idêntico.

## Compatibilidade e cutover

`RunKernelCompatibilityFacade` centraliza o dual-write. `createHarnessLegacyAdapter` projeta apenas transições representáveis pelo ledger atual. Estados canônicos sem equivalente exato continuam preservados no kernel e aparecem no audit; a facade não força uma transição ilegal no ledger.

O cutover recomendado é vertical:

1. abrir o kernel em shadow mode;
2. habilitar a facade para um fluxo;
3. comparar projection canônica, ledger e audit;
4. promover um reader por vez;
5. manter o fallback legado durante a janela de paridade.

## Limites conhecidos

Esta fundação não altera Glance, Gauntlet, runtime providers, supervisor ou dispatch. A outbox oferece entrega pelo menos uma vez, com identidade estável para deduplicação, porque exatamente uma vez entre SQLite e um side effect externo exige cooperação do consumer. A publicação atômica de artifacts além da verificação de `ArtifactRef` fica para o marco próprio previsto no plano incremental.
