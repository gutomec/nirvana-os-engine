# ADR-008: facade de compatibilidade e cutover vertical

**Status:** proposto
**Requisitos:** RT-006, GL-001

## Contexto

Uma reescrita horizontal de driver, ledger, audit, Glance, projects e delivery teria rollback difícil e ameaçaria entidades existentes.

## Decisão

Introduzir uma facade entre callers e serviços legados. Novos contracts entram em shadow mode. Dual-write fica localizado na facade. Readers novos preferem projections e mantêm fallback. Cutover acontece uma projection e um fluxo vertical por vez, sempre após parity no corpus.

## Consequências

Businesses, squads e mind-clones não são reescritos. Campos legados permanecem em projections por janela definida. Cada fase possui flag, comparison, migration e rollback documentados.

## Alternativas rejeitadas

Big bang; migration automática de manifests; dual-write espalhado pelos callers; remover aliases antes do corpus atingir paridade.
