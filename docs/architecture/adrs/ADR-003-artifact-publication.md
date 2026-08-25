# ADR-003: identidade e publicação de artifacts

**Status:** proposto
**Requisitos:** RK-004

## Contexto

A verificação atual depende de `business_slug` e paths podem divergir entre staging, outputs root e destino pedido pelo usuário.

## Decisão

Todo Run produz um Artifact Manifest neutro. Cada revision contém identidade, digest, bytes, media type, classificação, producer, staging URI e published URI. Publication é stage, flush, hash, validate, atomic publish e journal. Gate referencia revisions imutáveis.

## Consequências

Business, squad e `agent-x` usam o mesmo verifier. Correções criam revision nova. Paths externos exigem policy e publish explícito. Symlink e TOCTOU entram na threat model.

## Alternativas rejeitadas

Verificação por business; confiar em path sem digest; sobrescrever artifact aprovado durante revision.
