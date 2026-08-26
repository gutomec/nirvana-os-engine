# ADR-006: modo de execução Gauntlet

**Status:** proposto
**Requisitos:** GT-001 a GT-007

## Contexto

O engine já possui dispatch, gate, revision e loop guard. Falta um plano prévio que separe producers e evaluators, preserve candidates, meça progresso, teste regressão e encerre por política finita.

## Decisão

Adicionar `execution.mode: gauntlet` como estratégia opcional do Run Kernel. Após o brief, um compiler cria success contract, candidate strategy, gauntlets, selection policy, budget e stop policy. Producers não aprovam o próprio candidate. Revisions recebem defeitos e evidências específicas. O quality gate final permanece obrigatório.

## Consequências

Businesses mantêm accountability; squads produzem e avaliam por capabilities; mind-clones ajudam com método e rubrica. Light, balanced e exhaustive são perfis de limites. Auto respeita policy e explicita motivo. Candidates e scorecards aumentam storage e custo.

## Alternativas rejeitadas

Prompt “continue até perfeito”; fan-out universal; maioria de judges como prova; diferença textual como progresso; substituir testes por crítica LLM.
