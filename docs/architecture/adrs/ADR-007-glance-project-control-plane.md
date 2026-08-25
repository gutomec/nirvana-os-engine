# ADR-007: Glance como control plane de Projects

**Status:** proposto
**Requisitos:** GL-001 a GL-007

## Contexto

Glance já observa e aciona o engine, mas Projects são descobertos heuristicamente, chat e jobs são efêmeros e `nrv serve` mantém outro modelo operacional.

## Decisão

Glance, CLI e `nrv serve` chamam os mesmos application services. `nrv init` continua contrato público e delega ao `ProjectService`. Project recebe ID estável e manifesto. Conversation e Message são persistentes. Chat, timeline, DAG, lineage, costs e gates são projections do journal e transcript vinculados.

## Consequências

Glance deixa de ser fonte ou parser heurístico. Commands são tipados e idempotentes. A UI representa business, squad e mind-clone antes de runtime e model. WCAG 2.2 AA é gate.

## Alternativas rejeitadas

Projeto exclusivo do Glance; `localStorage` como histórico; executar shell do browser; interpretar stdout do `nrv init` como API permanente.
