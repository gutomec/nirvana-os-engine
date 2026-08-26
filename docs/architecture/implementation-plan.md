# Plano incremental de branches e commits

## 1. Regras de execução

Cada frente nasce da branch de integração `feat/universal-runtime-glance-gauntlet`. Nenhum commit mistura schema, storage, UI e migration sem necessidade. Cada branch passa testes próprios e corpus legado antes do merge. Commits e identificadores de código usam inglês.

## 2. Sequência

### Marco 0, especificação

**Branch:** `feat/universal-runtime-glance-gauntlet`
**Commit:** `docs: define universal runtime glance and gauntlet program`

Saídas: este pacote, ADRs, requisitos, contracts, states e test matrix. Nenhum código.

### Marco 1, fundação do Run Kernel

**Branch:** `feat/run-kernel-foundation`

Commits previstos:

1. `test: add canonical run lifecycle fixtures`
2. `feat: add versioned run and event schemas`
3. `feat: add artifact manifest and generic verifier`
4. `feat: add run journal outbox and projections`
5. `feat: add execution scopes and transactional publication`
6. `refactor: wrap legacy driver with runtime provider`

Gate: corpus business, squad e `agent-x`; replay determinístico; crash recovery; zero orphan resources.

### Marco 2, runtime universal

**Branch:** `feat/universal-runtime-negotiation`

Commits previstos:

1. `test: add runtime conformance fixtures`
2. `feat: add runtime and model descriptors`
3. `feat: add provider registry and active runtime fallback`
4. `feat: add capability negotiator in shadow mode`
5. `feat: add selection explanations and policy approvals`
6. `feat: enable opt-in negotiated runtime policy`

Gate: manifests legados sem mudança; runtime fixture entra sem editar core; seleção por snapshot é reproduzível.

### Marco 3, Gauntlet Engine

**Branch:** `feat/gauntlet-execution-engine`

Commits previstos:

1. `test: add gauntlet plan and stop policy fixtures`
2. `feat: compile briefs into gauntlet plans`
3. `feat: add candidate and evaluation stores`
4. `feat: add bounded revision and regression controller`
5. `feat: add independent evaluator selection`
6. `feat: add light balanced and exhaustive modes`

Gate: stop finito, cost reservation, no-progress, regressão, producer/evaluator separation e lineage organizacional.

### Marco 4, ProjectService e API

**Branch:** `feat/project-control-plane`

Commits previstos:

1. `test: capture nrv init golden fixtures`
2. `refactor: extract project planner and materializer`
3. `feat: add project identity and legacy adoption`
4. `feat: add conversation and command services`
5. `feat: unify cli glance and serve application APIs`

Gate: paridade de scaffold, adoção sem sobrescrita, history e commands sobrevivem a restart.

### Marco 5, Glance cockpit

**Branch:** `feat/glance-project-cockpit`

Commits previstos:

1. `feat: add project and conversation navigation`
2. `feat: add persistent operational chat`
3. `feat: add replayable run timeline and lineage`
4. `feat: add gauntlet candidate and scorecard views`
5. `feat: add typed approvals and run controls`
6. `test: add accessibility and browser security gates`

Gate: WCAG 2.2 AA, reconnection by cursor, no arbitrary shell, views share event IDs.

### Marco 6, integração e canário

**Branch:** `feat/universal-runtime-glance-gauntlet`

Commits previstos:

1. `test: add end-to-end migration and recovery matrix`
2. `chore: enable shadow projections in canary mode`
3. `docs: publish operations rollback and recovery runbooks`

Gate: parity 100%, zero critical security finding, rollback ensaiado, métricas e SLOs observáveis.

## 3. Ordem proibida

Não iniciar Model Broker, UI persistente ou fan-out Gauntlet antes de event identity, ArtifactRef e lifecycle único. Isso criaria novas decisões sobre uma trilha ainda inconsistente.
