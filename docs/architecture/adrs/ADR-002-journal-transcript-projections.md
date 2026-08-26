# ADR-002: journal, transcript e projections

**Status:** proposto
**Requisitos:** RK-003, RK-005, GL-003, GL-004

## Contexto

Audit JSONL, ledger e estados inferidos geram verdades concorrentes. Chat persistente exige conteúdo visível, enquanto compliance exige lifecycle durável. Misturar ambos aumenta volume e risco de privacidade.

## Decisão

Separar `RunJournal` organizacional de `ModelTranscript` cognitivo. O journal usa events tipados, sequence por Project, causalidade e outbox. O transcript guarda apenas mensagens e contexto visíveis, nunca chain-of-thought. Projections são reconstruíveis, versionadas e idempotentes.

## Consequências

Glance, ledger, gate e audit compatível passam a compartilhar event IDs. SSE retoma por sequence. Rebuild precisa produzir hash estável. Retenção de transcript pode ser menor que a do journal.

## Alternativas rejeitadas

Usar o audit diário como event store; usar transcript como fonte única; persistir estado de UI como autoridade.
