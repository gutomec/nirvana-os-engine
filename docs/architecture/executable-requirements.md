# Requisitos executáveis

Os IDs são estáveis. “Crítico” significa que o programa não pode avançar ao cutover sem o cenário aprovado.

Tags de estado: `[implementado]` quando um teste ou script do repositório cobre o cenário inteiro; `[parcial]` quando a prova cobre parte do cenário, com a lacuna nomeada; `[proposto]` quando não há prova. Caminhos de teste sem prefixo ficam em `skills/harness/tests/`.

## 1. Run Kernel

### RK-001, lifecycle único [crítico, parcial]

**Dado** um Run de business, squad ou `agent-x`, **quando** seus events forem reconstruídos, **então** ledger, validator, audit e Glance devem produzir o mesmo estado e target.

Prova: `run-kernel.test.ts` ("rejects invalid and terminal transitions", "rebuild produces the same deterministic projection snapshot", "opens and updates the existing ledger while preserving its schema and audit projection"); `dispatch-standard-kernel.e2e.test.ts` (Runs de `agent-x` e Squad no kernel com o audit legado ao lado); `glance-agent-x-canary-e2e.test.ts` (o Glance lê o mesmo kernel). Falta: nenhum teste compara, para o mesmo Run do modo `standard`, o estado do run-ledger legado com o do kernel.

### RK-002, publicação transacional [crítico, parcial]

**Dado** um provider preparado, **quando** a validação falhar antes de commit, **então** nenhum Run ou Agent parcial pode ser publicado e todos os resources devem ser descartados.

Prova: `run-kernel.test.ts` ("recovers a pending event after a simulated publisher failure": evento e outbox na mesma transação); `gauntlet-controller.test.ts` ("keeps a round evaluation atomic so an interrupted decision replays from producing"); `run-kernel-multi-target-ports.test.ts` ("persisted plan or reservation divergence fails closed"). Falta: descarte de Run ou Agent parcial quando a validação de um provider falha antes do commit.

### RK-003, event identity [crítico, implementado]

Todo event normativo deve ter `event_id`, `run_id`, `sequence`, `correlation_id` e `causation_id` quando houver causa. Replay do mesmo event é idempotente; mesmo ID com payload diferente é conflito.

Prova: `run-kernel.test.ts` ("assigns monotonic project sequence and preserves causal links", "replays duplicate identities once and rejects divergent payloads", "retries run creation and transition commands by idempotency key").

### RK-004, artifact verificável [crítico, parcial]

Todo artifact entregue deve ter revision imutável, digest, tamanho, media type, producer e localização publicada. Alteração após gate deve ser detectada.

Prova: `run-kernel.test.ts` ("verifies immutable artifact metadata and detects later changes", "rejects artifacts outside the authorized workspace"); `agent-x-gauntlet-cutover.test.ts` (o evaluator recebe um ArtifactRef por arquivo de candidate). Falta: deliverables do modo `standard` não recebem ArtifactRef.

### RK-005, outbox [crítico, parcial]

Dispatch, approval, custo, tool side effect, artifact, gate e terminal devem ser persistidos atomicamente com uma outbox. Telemetria não pode substituir prova normativa.

Prova: `run-kernel.test.ts` ("recovers a pending event after a simulated publisher failure"); `gauntlet-store.test.ts` (plano, revisões e scorecards no journal canônico). Falta: dispatch, aprovação, custo, side effects de tools e gate do caminho legado continuam no audit JSONL, fora da outbox.

### RK-006, authority [crítico, implementado]

Um child scope pode restringir permissões, nunca ampliar uma negação do parent. O teste deve cobrir filesystem, process, network, secrets e host.

Prova: `run-kernel.test.ts` ("child authority can restrict but never widen a parent denial", com `filesystem`, `process`, `network`, `secrets` e `host`).

## 2. Runtime e modelos

### RT-001, runtime ativo universal [crítico, implementado]

Manifesto com `runtime_requirements.policy: active` deve executar no runtime ativo sem exigir que seu nome esteja em `minimum` ou `compatible`, desde que o host forneça as features obrigatórias.

Prova: `skills/squads/tests/active-runtime-policy.test.ts` ("active policy permits omitting minimum for squads and businesses", "active policy uses a registered adapter and degrades optional features", "active policy accepts an explicit bridge and rejects missing required features", "active policy fails without adapter or bridge and honors incompatible").

### RT-002, fallback ao ativo [crítico, implementado]

Quando nenhum runtime declarado estiver disponível e a policy permitir fallback, o sistema deve avaliar o runtime ativo. Falta de capability obrigatória encerra com incompatibilidade explicada, nunca com troca silenciosa.

Prova: `skills/squads/tests/runtime-broker.test.ts` ("uses the active runtime as universal fallback through the compatibility facade"); `runtime-snapshot-after-catalog-update.e2e.test.ts` ("a missing required feature or model rolls the Run back before the producer with the broker's explanation"); `standard-publication.test.ts` ("broker errors in the frozen snapshot end the Run rolled_back before any producer (RT-002)").

### RT-003, negociação por capability [crítico, proposto]

`policy: negotiate` deve filtrar por capability, enforcement, evidence, authorization e constraints antes de ordenar candidates. Requisito obrigatório não pode virar peso compensável.

Prova: nenhuma. `policy: negotiate` não aparece na implementação nem nos testes.

### RT-004, independência de modelo [crítico, implementado]

Runtime e modelo devem possuir descriptors separados. Um runtime compatível com modelo incompatível deve ser rejeitado para aquela task.

Prova: `skills/squads/tests/runtime-broker.test.ts` ("fails honestly when a compatible runtime has no compatible model", "selects the model by required image capability and modality"); `runtime-snapshot-after-catalog-update.e2e.test.ts` (modelo rejeitado com a razão em `rejected` e Run encerrado antes do producer).

### RT-005, seleção explicável [parcial]

Toda seleção automática deve congelar evidence snapshot e registrar selected, rejected, degradations, custo previsto e policy aplicada.

Prova: `runtime-snapshot-after-catalog-update.e2e.test.ts` (snapshot congelado por Run com `evidence`, `policy`, `rejected`, `warnings` e `errors`; `degradations` entra quando o broker as reporta). Falta: custo previsto não entra no snapshot.

### RT-006, compatibilidade legada [crítico, parcial]

Todos os manifests existentes devem manter parse, routing e resultado de compatibility sob `declared` e `active` sem rewrite.

Prova: `skills/squads/tests/active-runtime-policy.test.ts` ("legacy manifests default to declared and still require minimum", "declared policy rejects an undeclared active runtime"); `skills/squads/tests/runtime-broker.test.ts` ("preserves declared policy behavior for legacy manifests", "accepts provider catalog updates without changing a squad manifest"); `scripts/check-organizational-non-regression.ts` (nenhuma escrita nas entidades instaladas durante as suítes). Falta: varredura do corpus completo de manifests sob `declared` e `active`.

## 3. Gauntlet Engine

### GT-001, compilação após brief [crítico, implementado]

Quando `execution.mode` for `gauntlet`, o sistema deve compilar `success_contract`, candidate strategy, gauntlets, selection policy, budget e stop policy antes de produzir candidates.

Prova: `gauntlet-compiler.test.ts` ("compiles %s into explicit finite limits": candidate strategy, `stop.maxRounds`, holdout e judge independente; "is deterministic and blocks ambiguous critical briefs": `successContract.humanRequired`); `agent-x-gauntlet-cutover.test.ts` ("splits the plan budget across rounds and candidates without exceeding the plan ceiling", "persists plan and candidate before an independent evaluation, then runs the final gate").

### GT-002, papéis separados [crítico, parcial]

O producer não pode emitir o verdict final de seu próprio candidate. Toda exceção precisa de waiver explícito e auditável.

Prova: `gauntlet-compiler.test.ts` ("selects by capability without hardcoded squads and rejects self-evaluation"); `gauntlet-controller.test.ts` ("delivers only after an independent hard gate passes": autoavaliação lança erro); `agent-x-gauntlet-cutover.test.ts` ("rejects a producer evaluating its own candidate and records a post-start failure"). Falta: não existe waiver explícito e auditável; a regra não admite exceção.

### GT-003, progresso mensurável [crítico, implementado]

Uma nova round só pode começar quando houver budget e uma hipótese de melhoria ligada a defeito observado. Delta deve usar métricas estáveis, testes ou evidência, não diferença textual.

Prova: `gauntlet-controller.test.ts` ("does not dispatch a round without budget", "stops after stable metrics show no progress"); `gauntlet-revision-loop.e2e.test.ts` ("revises the candidate from its evaluated defects and reaches the final gate": hipótese e `causalEvaluationIds` ligados ao defeito observado).

### GT-004, regressão [crítico, implementado]

Após revision, testes que falharam e testes previamente aprovados devem ser reexecutados. Regressão crítica impede seleção.

Prova: `gauntlet-controller.test.ts` ("blocks selection when a revision regresses a previously passed hard gate", "does not read a sibling's pass as a regression of another candidate"); `gauntlet-revision-loop.e2e.test.ts` ("withholds a revision that regresses a passed blocking dimension without running the final gate").

### GT-005, parada finita [crítico, parcial]

O controller deve parar por `success`, `max_rounds`, `max_cost`, `max_duration`, `no_progress`, `critical_regression`, `judge_disagreement`, `human_required` ou `execution_failure`.

Prova: `gauntlet-controller.test.ts` (`success`, `max_cost`, `no_progress`, `critical_regression`, `max_rounds`); `gauntlet-revision-loop.e2e.test.ts` (`max_rounds`, `no_progress`, `critical_regression`, `execution_failure`); `gauntlet-compiler.test.ts` (`humanRequired` na compilação). Falta: `max_duration` e `judge_disagreement` não têm teste.

### GT-006, intensidade [implementado]

`light`, `balanced` e `exhaustive` devem compilar para limites explícitos. `auto` apenas sugere ou seleciona dentro da policy do Project.

Prova: `gauntlet-compiler.test.ts` ("compiles %s into explicit finite limits" para `light`, `balanced` e `exhaustive`; "keeps standard as the default and makes auto policy explicit"); `gauntlet-revision-loop.e2e.test.ts` ("balanced produces three isolated candidates, evaluates all and publishes only the selected one", "exhaustive produces five isolated candidates and selects through the controller").

### GT-007, preservação organizacional [crítico, parcial]

Business mantém accountability e budget; squads executam capabilities; mind-clones informam método e rubricas. Candidate, judge e revision devem preservar essa lineage.

Prova: `business-gauntlet-glance-proof.e2e.test.ts` (candidate com producer Business e scorecard com evaluator distinto); `gauntlet-revision-loop.e2e.test.ts` ("a typed Business crosses the revision loop, the real offline gate and the post-gate", "a typed %s producer crosses the revision loop to completed"); `multi-target-coordinator.test.ts` ("runs parallel Businesses, then Squad and explicit synthesis with typed modes and upstream paths"). Falta: mind-clones informando método e rubricas do evaluator não têm teste; o evaluator de produção é o gate offline do harness.

## 4. Glance e Projects

### GL-001, paridade com `nrv init` [crítico, parcial]

CLI e Glance devem produzir manifesto e scaffold semanticamente equivalentes ao receber o mesmo plano. Arquivos do usuário não podem ser sobrescritos.

Prova: `project-control-plane.test.ts` ("plans without writes and adopts only with the current plan hash": arquivo do usuário preservado); `init-existing-project.test.ts` ("code and other files are never touched", "running it twice changes nothing — markers make it idempotent"). Falta: teste golden comparando o scaffold do `nrv init` com o do Glance para o mesmo plano.

### GL-002, identidade de Project [crítico, implementado]

Project deve ter ID estável independente do path e manifesto `.nirvana/project.yaml`. Abrir Project legado não pode migrá-lo implicitamente.

Prova: `project-control-plane.test.ts` ("keeps identity stable when the workspace moves", "plans without writes and adopts only with the current plan hash"); `glance-control-plane.test.ts` ("legacy discovery is read-only and adoption is explicit").

### GL-003, chat persistente [crítico, implementado]

Conversation e Message devem sobreviver ao restart. `localStorage` pode guardar preferências e drafts, nunca o histórico canônico.

Prova: `project-control-plane.test.ts` ("persists isolated conversations and ordered messages across restart"); `glance-control-plane.test.ts` ("persists conversation messages and keeps entities separate").

### GL-004, timeline reconstruível [crítico, parcial]

Chat, timeline, DAG, swimlane, costs, gates e lineage devem usar os mesmos event IDs e sequence. Reconexão deve continuar por cursor sem lacunas.

Prova: `glance-control-plane.test.ts` ("returns journal events in sequence and resumes SSE after cursor"); `glance-agent-x-canary-e2e.test.ts` (sequência contígua e retomada por `Last-Event-ID`); `business-gauntlet-glance-proof.e2e.test.ts` (timeline com os mesmos `sequence` do kernel e causalidade por `causationId`); `glance-multi-target-projection.test.ts`; `glance-run-event-labels.test.ts` (custo e decisão lidos dos eventos canônicos). Falta: DAG, swimlane e lineage não existem como vistas; a aba Runs deriva do audit legado.

### GL-005, comandos tipados [crítico, implementado]

O browser envia commands tipados. Não pode enviar shell arbitrário. Escritas exigem idempotency key; updates exigem versão esperada.

Prova: `glance-control-plane.test.ts` ("requires idempotency and rejects foreign origins and traversal": escrita sem `Idempotency-Key` responde 400, Origin estranha responde 403, `/api/actions/chat-shell` responde 404 e `tool.execute.shell` é `false`); `project-control-plane.test.ts` (adoção exige o `plan_hash` atual).

### GL-006, acessibilidade [crítico, proposto]

O Project cockpit deve passar WCAG 2.2 AA, teclado, reflow a 400%, reduced motion e alternativas textuais para DAG e charts.

Prova: nenhuma. Não há teste de teclado, reflow, reduced motion ou alternativas textuais.

### GL-007, ações de Run [parcial]

Follow-up, steer, cancel, retry, revise, fork e approval têm semântica própria. Capability ausente deve aparecer como unsupported, sem emulação silenciosa.

Prova: `glance-agent-x-canary-e2e.test.ts` ("queued run can be cancelled without invoking the adapter", "cancel during execution kills the child and settles cancelled", "missing capability records an honest terminal run"). Falta: follow-up, steer, retry, revise, fork e approval.

## 5. Critério global de aceite

O programa pode entrar em produção quando `RK-001` a `RK-006`, `RT-001` a `RT-004` e `RT-006`, `GT-001` a `GT-005` e `GT-007`, `GL-001` a `GL-006` estiverem aprovados no corpus legado e nas suites novas.

Estado nesta revisão: desses requisitos, RK-003, RK-006, RT-001, RT-002, RT-004, GT-001, GT-003, GT-004, GL-002, GL-003 e GL-005 estão `[implementado]`; RK-001, RK-002, RK-004, RK-005, RT-006, GT-002, GT-005, GT-007, GL-001 e GL-004 estão `[parcial]`; RT-003 e GL-006 estão `[proposto]`. O critério não está atendido.
