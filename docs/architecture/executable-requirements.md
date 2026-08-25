# Requisitos executáveis

Os IDs são estáveis. “Crítico” significa que o programa não pode avançar ao cutover sem o cenário aprovado.

## 1. Run Kernel

### RK-001, lifecycle único [crítico, proposto]

**Dado** um Run de business, squad ou `agent-x`, **quando** seus events forem reconstruídos, **então** ledger, validator, audit e Glance devem produzir o mesmo estado e target.

### RK-002, publicação transacional [crítico, proposto]

**Dado** um provider preparado, **quando** a validação falhar antes de commit, **então** nenhum Run ou Agent parcial pode ser publicado e todos os resources devem ser descartados.

### RK-003, event identity [crítico, proposto]

Todo event normativo deve ter `event_id`, `run_id`, `sequence`, `correlation_id` e `causation_id` quando houver causa. Replay do mesmo event é idempotente; mesmo ID com payload diferente é conflito.

### RK-004, artifact verificável [crítico, proposto]

Todo artifact entregue deve ter revision imutável, digest, tamanho, media type, producer e localização publicada. Alteração após gate deve ser detectada.

### RK-005, outbox [crítico, proposto]

Dispatch, approval, custo, tool side effect, artifact, gate e terminal devem ser persistidos atomicamente com uma outbox. Telemetria não pode substituir prova normativa.

### RK-006, authority [crítico, proposto]

Um child scope pode restringir permissões, nunca ampliar uma negação do parent. O teste deve cobrir filesystem, process, network, secrets e host.

## 2. Runtime e modelos

### RT-001, runtime ativo universal [crítico, parcialmente existente]

Manifesto com `runtime_requirements.policy: active` deve executar no runtime ativo sem exigir que seu nome esteja em `minimum` ou `compatible`, desde que o host forneça as features obrigatórias.

### RT-002, fallback ao ativo [crítico, proposto]

Quando nenhum runtime declarado estiver disponível e a policy permitir fallback, o sistema deve avaliar o runtime ativo. Falta de capability obrigatória encerra com incompatibilidade explicada, nunca com troca silenciosa.

### RT-003, negociação por capability [crítico, proposto]

`policy: negotiate` deve filtrar por capability, enforcement, evidence, authorization e constraints antes de ordenar candidates. Requisito obrigatório não pode virar peso compensável.

### RT-004, independência de modelo [crítico, proposto]

Runtime e modelo devem possuir descriptors separados. Um runtime compatível com modelo incompatível deve ser rejeitado para aquela task.

### RT-005, seleção explicável [proposto]

Toda seleção automática deve congelar evidence snapshot e registrar selected, rejected, degradations, custo previsto e policy aplicada.

### RT-006, compatibilidade legada [crítico, proposto]

Todos os manifests existentes devem manter parse, routing e resultado de compatibility sob `declared` e `active` sem rewrite.

## 3. Gauntlet Engine

### GT-001, compilação após brief [crítico, proposto]

Quando `execution.mode` for `gauntlet`, o sistema deve compilar `success_contract`, candidate strategy, gauntlets, selection policy, budget e stop policy antes de produzir candidates.

### GT-002, papéis separados [crítico, proposto]

O producer não pode emitir o verdict final de seu próprio candidate. Toda exceção precisa de waiver explícito e auditável.

### GT-003, progresso mensurável [crítico, proposto]

Uma nova round só pode começar quando houver budget e uma hipótese de melhoria ligada a defeito observado. Delta deve usar métricas estáveis, testes ou evidência, não diferença textual.

### GT-004, regressão [crítico, proposto]

Após revision, testes que falharam e testes previamente aprovados devem ser reexecutados. Regressão crítica impede seleção.

### GT-005, parada finita [crítico, proposto]

O controller deve parar por `success`, `max_rounds`, `max_cost`, `max_duration`, `no_progress`, `critical_regression`, `judge_disagreement`, `human_required` ou `execution_failure`.

### GT-006, intensidade [proposto]

`light`, `balanced` e `exhaustive` devem compilar para limites explícitos. `auto` apenas sugere ou seleciona dentro da policy do Project.

### GT-007, preservação organizacional [crítico, proposto]

Business mantém accountability e budget; squads executam capabilities; mind-clones informam método e rubricas. Candidate, judge e revision devem preservar essa lineage.

## 4. Glance e Projects

### GL-001, paridade com `nrv init` [crítico, proposto]

CLI e Glance devem produzir manifesto e scaffold semanticamente equivalentes ao receber o mesmo plano. Arquivos do usuário não podem ser sobrescritos.

### GL-002, identidade de Project [crítico, proposto]

Project deve ter ID estável independente do path e manifesto `.nirvana/project.json`. Abrir Project legado não pode migrá-lo implicitamente.

### GL-003, chat persistente [crítico, proposto]

Conversation e Message devem sobreviver ao restart. `localStorage` pode guardar preferências e drafts, nunca o histórico canônico.

### GL-004, timeline reconstruível [crítico, proposto]

Chat, timeline, DAG, swimlane, costs, gates e lineage devem usar os mesmos event IDs e sequence. Reconexão deve continuar por cursor sem lacunas.

### GL-005, comandos tipados [crítico, proposto]

O browser envia commands tipados. Não pode enviar shell arbitrário. Escritas exigem idempotency key; updates exigem versão esperada.

### GL-006, acessibilidade [crítico, proposto]

O Project cockpit deve passar WCAG 2.2 AA, teclado, reflow a 400%, reduced motion e alternativas textuais para DAG e charts.

### GL-007, ações de Run [proposto]

Follow-up, steer, cancel, retry, revise, fork e approval têm semântica própria. Capability ausente deve aparecer como unsupported, sem emulação silenciosa.

## 5. Critério global de aceite

O programa pode entrar em produção quando `RK-001` a `RK-006`, `RT-001` a `RT-004` e `RT-006`, `GT-001` a `GT-005` e `GT-007`, `GL-001` a `GL-006` estiverem aprovados no corpus legado e nas suites novas.
