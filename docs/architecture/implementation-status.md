# Estado da implementação

Data da revisão: 25 de agosto de 2026.

Este documento separa fundação implementada, integração ativa e cutovers ainda bloqueados. A distinção evita que uma API existente seja confundida com um fluxo operacional completo.

## Estado geral

| Área | Estado | Evidência | Limite atual |
|---|---|---|---|
| Política de runtime ativo | Implementada | Testes de compatibilidade e fallback | Nenhuma enumeração central é exigida pela política `active` |
| Runtime Provider e Model Broker | Implementados | Catálogos extensíveis, seleção por capability e testes de stale data | O dispatch legado ainda não persiste o snapshot escolhido em todo Run |
| Run Kernel | Implementado como fundação opt-in | Journal, projeções, outbox, transcript, ArtifactRef e recovery | O dispatch legado ainda não faz dual-write em todos os caminhos |
| Gauntlet Engine | Implementado como engine | Compiler, stores, controller, budgets, replay e decisões terminais | As flags do CLI ainda não comandam o fan-out real do dispatch |
| Glance Project Workspace | Implementado como control plane local | Project, Conversation, Message, Run, Events e SSE persistentes | O chat persistente ainda aciona o action runner legado |
| Cutover vertical | Não concluído | Contratos e seams existem | Falta unir dispatch, broker, kernel, Gauntlet e Glance numa execução real |

## O que já funciona

### Runtime universal

A política `active` aceita o runtime da sessão quando há provider ou bridge compatível. Um runtime novo pode entrar pelo catálogo sem alteração de allowlist no core. O Model Broker filtra capabilities e modalidades antes de ordenar modelos. Catálogos vencidos falham de forma explícita, salvo autorização específica para aceitar stale data.

Manifests legados continuam usando `declared`. A ausência de `runtime_requirements` não cria obrigação de instalar Claude Code, Codex, Gemini CLI ou outro produto enumerado.

### Run Kernel

O kernel mantém eventos append-only em SQLite, sequência monotônica por Project, idempotência, causalidade, projeções reconstruíveis e outbox durável. Mensagens visíveis ficam separadas do journal técnico. ArtifactRef registra digest, tamanho, origem e revisão sem incorporar o conteúdo privado ao evento.

A facade de compatibilidade é opt-in. Ela não altera readers legados por simples presença do módulo.

### Gauntlet Engine

O compiler produz planos determinísticos para `light`, `balanced` e `exhaustive`. O controller bloqueia nova rodada sem orçamento, impõe duração e quantidade máxima de rounds, detecta falta de progresso, impede autoavaliação e registra candidates e scorecards imutáveis.

Essas garantias foram testadas com adapters determinísticos. No CLI de produção, `--execution-mode` ainda registra a intenção, mas não substitui o executor legado pelo controller. Portanto, usar a flag hoje não autoriza afirmar que houve competição entre candidates.

### Glance

Projetos adotados têm identidade estável em `.nirvana/project.yaml`. Adoção exige preview e `plan_hash`. Conversations e Messages sobrevivem a reinício. Runs e Events usam o Run Kernel, a timeline é ordenada por sequência e SSE retoma com `Last-Event-ID`.

O servidor restringe ações a loopback, valida Origin, exige `Idempotency-Key` nas escritas e rejeita path traversal. O navegador não recebe uma rota de shell arbitrário.

## Cutover vertical necessário

O próximo incremento deve ser único e observável:

1. O Glance recebe uma Message e prepara um Run canônico.
2. O harness resolve Business, Squad ou `agent-x` sem mudar a cascata atual.
3. O broker congela runtime, provider, modelo, catálogo e evidências numa policy snapshot.
4. O modo `standard` chama o executor atual por uma facade e publica transições no Run Kernel.
5. O modo `gauntlet` chama o controller, cria workspaces isolados por candidate e seleciona evaluators independentes por capability.
6. Cada avaliação produz scorecard ligado a evidências. Revision recebe defeitos causais, não um prompt genérico.
7. O quality gate final permanece obrigatório depois da seleção.
8. Glance acompanha a mesma sequência de eventos, sem reconstruir verdade a partir de logs soltos.

O modo `standard` deve continuar padrão. O cutover precisa de uma flag independente e rollback por facade, sem reescrever businesses, squads ou mind-clones.

## Critérios para declarar o cutover concluído

- Um teste E2E cria Project, Conversation, Message e Run, despacha um target real por adapter fake e observa toda a timeline por SSE.
- `standard` mantém exit codes, artifacts, audit e session files atuais.
- `gauntlet light` executa produção, avaliação independente, revisão causal e gate final.
- Reiniciar depois de `candidate_created` retoma sem repetir side effect.
- Budget insuficiente impede a próxima execução antes de reservar recursos.
- Snapshot de runtime e modelo permanece consultável mesmo depois de atualizar o catálogo.
- Projeto legado abre sem escrita e só migra após adoção explícita.
- Testes de businesses, squads e mind-clones existentes passam sem migração destrutiva.

## Resultado de testes nesta integração

A bateria focada integrada aprovou 53 testes e 153 asserções, cobrindo runtime broker, política ativa, Run Kernel, Gauntlet Engine, Project, Conversation, Glance API e SSE.

A execução conjunta de `skills/harness/tests` e `skills/squads/tests` avançou por centenas de casos sem falha observada, mas `skills/harness/tests/routing-eval.test.ts` permaneceu sem saída por mais de um minuto e foi interrompido. Esse resultado não equivale a uma suíte global aprovada. O teste precisa de diagnóstico isolado antes de virar gate obrigatório deste programa.

## Regra de entrega

Até os critérios acima passarem, a implementação deve ser descrita como fundação integrada em andamento. As APIs e engines já são utilizáveis para desenvolvimento e testes controlados. Elas ainda não sustentam a alegação de que o fluxo inteiro opera em Gauntlet a partir do Glance.
