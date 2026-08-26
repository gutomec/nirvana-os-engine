# Estado da implementação

Data da revisão: 25 de agosto de 2026.

Este documento separa fundação implementada, integração ativa e cutovers ainda bloqueados. A distinção evita que uma API existente seja confundida com um fluxo operacional completo.

## Estado geral

| Área | Estado | Evidência | Limite atual |
|---|---|---|---|
| Política de runtime ativo | Implementada | Testes de compatibilidade e fallback | Nenhuma enumeração central é exigida pela política `active` |
| Runtime Provider e Model Broker | Implementados | Catálogos extensíveis, seleção por capability, stale data e snapshot nos Runs do canário | O dispatch legado ainda não persiste o snapshot escolhido em todo Run |
| Run Kernel | Implementado como fundação opt-in | Journal, projeções, outbox, transcript, ArtifactRef e recovery | O dispatch legado ainda não faz dual-write em todos os caminhos |
| Gauntlet Engine | Engine implementada, com canário operacional | Compiler, stores, controller, budgets, replay, `agent-x light`, Squad único `light`, política, reserva, coordenador multi-target, portas Run Kernel com lease, heartbeat e abort, adapters de dispatch por subprocesso com alvo explícito, comando opt-in `nrv multi-target plan|run|status` | O comando multi-target exige `NIRVANA_MULTI_TARGET_ENGINE=1` e o protocolo em prosa segue padrão nos runtimes interativos; `balanced` e `exhaustive` já passam pelo controller nos canários, mas os adapters multi-target ainda os recusam |
| Glance Project Workspace | Control plane com execução real por processo filho | Project, Conversation, Message, Run, Events, SSE, fila com runner (`dispatch.ts --run-id`), cancelamento que mata o filho, recuperação por pid (reanexar ou redespachar), alvo explícito na Message, timeline canônica rotulada e projeção multi-target por Run | Uma Message por vez por servidor; o runtime neto pode sobreviver ao cancelamento; a projeção multi-target só existe depois do primeiro snapshot do coordenador |
| Cutover vertical | Loop completo nos três targets | `agent-x`, Squad único e Business allowlistado atravessam produção, avaliação independente, revisão causal, seleção e gate final nas três intensidades, com leitura no Glance | Rotas com múltiplos Squads e o coordenador multi-target continuam fora; o chat do Glance pede `light` para `agent-x` e deixa business e squad decidirem o modo pelo env do servidor |

O pós-gate de Business agora passa por `runBusinessPostGate`, uma fronteira reutilizável chamada pelo mesmo hook da delivery pipeline. A extração preserva PDF, HTML, ZIP, manifesto, session file, audit e decisões terminais. Ela prepara um futuro adapter de Business, mas não ativa o Business Gauntlet. Esse cutover continua bloqueado até a comparação de paridade cobrir o fluxo completo.

A prova hermética `business-delivery-parity.e2e.test.ts` compara o contrato legado congelado com a nova fronteira. No sucesso, ela atravessa manifesto, gate offline, PDF, HTML, ZIP e session file, então compara resultado, arquivos, eventos e estado terminal `delivered`. Na falha de manifesto, ambos os caminhos terminam em `failed`, sem publicação nem evento `delivered`. A prova não chama LLM, runtime externo, credenciais ou rede.

Essa evidência cobre somente a região afetada pela extração. O teste integrado `business-gauntlet-glance-proof.e2e.test.ts` fecha a etapa seguinte com um target `business` tipado: produção local, candidate e scorecard pelo `GauntletController`, evaluator independente, snapshot honesto de runtime, provider e modelo, delivery final, pós-gate e leitura da timeline pelo Glance. Os eventos de delivery preservam causalidade e sequência. Uma rejeição bloqueia delivery e pós-gate.

O canário Business `light` está disponível de forma estritamente opt-in. Ele exige pedido explícito de `gauntlet`, intensidade `light`, execução individual e slug presente em `NIRVANA_BUSINESS_GAUNTLET_ALLOWLIST`. `NIRVANA_BUSINESS_GAUNTLET_KILL_SWITCH=1` desliga o canário antes da produção. Ausência de qualquer condição mantém o executor legado.

Rollback automático só ocorre antes do producer iniciar. Depois desse marco, erro ou rejeição encerra o Run canônico e nunca chama o producer legado. Os eventos `x_business_gauntlet_selected`, `x_business_gauntlet_bypassed`, `x_business_gauntlet_rollback` e `x_business_gauntlet_terminal` registram a decisão operacional.

O rollout não inclui `balanced`, `exhaustive`, modo `auto`, team mode, múltiplos Squads ou troca automática de runtime. A prova hermética usa decisão direta, sem revision. A allowlist vazia mantém todos os Businesses no fluxo anterior.

## O que já funciona

### Runtime universal

A política `active` aceita o runtime da sessão quando há provider ou bridge compatível. Um runtime novo pode entrar pelo catálogo sem alteração de allowlist no core. O Model Broker filtra capabilities e modalidades antes de ordenar modelos. Catálogos vencidos falham de forma explícita, salvo autorização específica para aceitar stale data.

Runs do canário congelam a decisão de execução no journal. Quando provider ou modelo continuam sob escolha interna do runtime, o snapshot registra `resolved: false` e `runtime-default` em vez de inventar uma identidade. O digest dessa estrutura fica em `policySnapshotRef`.

Manifests legados continuam usando `declared`. A ausência de `runtime_requirements` não cria obrigação de instalar Claude Code, Codex, Gemini CLI ou outro produto enumerado.

### Run Kernel

O kernel mantém eventos append-only em SQLite, sequência monotônica por Project, idempotência, causalidade, projeções reconstruíveis e outbox durável. Mensagens visíveis ficam separadas do journal técnico. ArtifactRef registra digest, tamanho, origem e revisão sem incorporar o conteúdo privado ao evento.

A facade de compatibilidade é opt-in. Ela não altera readers legados por simples presença do módulo.

### Gauntlet Engine

O compiler produz planos determinísticos para `light`, `balanced` e `exhaustive`. O controller bloqueia nova rodada sem orçamento, impõe duração e quantidade máxima de rounds, detecta falta de progresso, impede autoavaliação e registra candidates e scorecards imutáveis.

Essas garantias foram testadas com adapters determinísticos. No CLI de produção, `--exec` com `gauntlet` explícito substitui o executor legado pelo controller para `agent-x`, um Squad e Businesses allowlistados. `light`, `balanced` e `exhaustive` usam o mesmo loop: `candidateStrategy.count` candidates isolados por rodada, avaliação independente de todas as revisões, revisão causal por `reviseCandidate` quando o controller pede, seleção por `selectedRevisionId` e gate final apenas sobre a revisão selecionada. A prova hermética `gauntlet-revision-loop.e2e.test.ts` cobre a revisão causal, as paradas finitas, a retomada após crash e os três targets.

O engine multi-target tem entrada pública escriturada: `nrv multi-target plan|run|status` compila um plano em arquivo (`nirvana.multi-target-plan/v1alpha1`), cria o Run no kernel do projeto, executa as ondas pelas portas do Run Kernel e pelos adapters de dispatch, e transiciona `prepared → running → verifying → completed|withheld|failed`. O `run` é opt-in por `NIRVANA_MULTI_TARGET_ENGINE=1`, com kill switch, e repetir o comando retoma sem reexecutar nós concluídos. O dispatch ganhou `--business`, `--squad` e `--agent-x`, então os adapters selecionam o alvo sem chamada ao roteador. Detalhes em [Comando multi-target](gauntlet-multi-target-cli.md).

### Glance

Projetos adotados têm identidade estável em `.nirvana/project.yaml`. Adoção exige preview e `plan_hash`. Conversations e Messages sobrevivem a reinício. Runs e Events usam o Run Kernel, a timeline é ordenada por sequência e SSE retoma com `Last-Event-ID`.

O servidor restringe ações a loopback, valida Origin, exige `Idempotency-Key` nas escritas e rejeita path traversal. O navegador não recebe uma rota de shell arbitrário.

Uma Message de projeto adotado prepara um Run com `policySnapshotRef: gauntlet-light-canary`, persiste o vínculo e entra numa fila serial. Com `nrv glance` em produção, a fila roda cada Run em um processo filho do `dispatch.ts` (`--agent-x`, `--business` ou `--squad`, mais `--run-id` para adotar o Run já preparado no kernel do projeto), e o servidor segue respondendo durante a execução. O texto `use business <slug>:` ou `use squad <slug>:` no início da Message escolhe o alvo; qualquer outro texto vai para `agent-x` no Gauntlet `light`. A UI não inicia o executor legado em paralelo. Projeto não adotado conserva o comportamento anterior. Runtime ausente e cancelamento antes de side effects produzem estados terminais explícitos; `--read-only` e `NIRVANA_GLANCE_EXECUTION=0` sobem o cockpit sem runner.

Cancelar um Run em execução mata o filho e conclui `running → cancelling → cancelled`. Um filho que sai sem transição terminal deixa o Run `failed` com `child_exited_without_terminal_state`. Os eventos `glance.child_started`, `glance.child_exited` e `glance.child_killed` registram pid, tentativa e código de saída na timeline.

No restart, Runs `prepared` vinculados a uma Message são reivindicados atomicamente e reencaminhados por `runId`. Runs em execução com filho registrado são reanexados quando o pid está vivo (`canary.recovery_reattached`) ou redespachados com o mesmo `--run-id` quando o pid morreu (`canary.recovery_redispatched`); o cutover retoma sem repetir producer nem evaluator, e dois restarts sobre o mesmo processo morto geram um único filho novo. Runs terminais e Runs em execução sem evento de filho são ignorados e registrados de forma explícita. Detalhes em [Execução no Glance](glance-execution.md).

A timeline do chat rotula todo evento canônico do Run Kernel por `type`, com título, subtítulo e tom em PT-BR, a partir de um único módulo (`run-event-labels.js`) compartilhado pela página e pelos testes. Eventos legados do audit continuam resolvendo pelo mapa antigo, e um tipo desconhecido aparece com o próprio nome, nunca sem título. Snapshots do coordenador e renovações de lease permanecem no stream, mas ficam ocultos até o usuário pedir para vê-los. O cabeçalho do Run mostra estado terminal, decisão do Gauntlet e custo vindos dos eventos canônicos.

`GET /api/v1/runs/:run/multi-target` reconstrói a projeção do coordenador multi-target a partir do journal, com a mesma reaplicação de eventos que as portas do Run Kernel usam no reload. O painel do Run lista ondas, nós, estado, custo concedido e reportado, razão e bloqueios. Detalhes em [Timeline canônica no Glance](glance-canonical-timeline.md).

## Expansão vertical necessária

O canário provou as etapas 1, 2, 4, 5, 7 e 8 para `agent-x light`, com a etapa 2 resolvida pelo alvo explícito da Message e do dispatch. Os próximos incrementos devem completar o mesmo contrato:

1. O Glance recebe uma Message e prepara um Run canônico.
2. O harness resolve Business, Squad ou `agent-x` sem mudar a cascata atual.
3. O broker congela runtime, provider, modelo, catálogo e evidências numa policy snapshot.
4. O modo `standard` chama o executor atual por uma facade e publica transições no Run Kernel.
5. O modo `gauntlet` chama o controller, cria workspaces isolados por candidate e seleciona evaluators independentes por capability.
6. Cada avaliação produz scorecard ligado a evidências. Revision recebe defeitos causais, não um prompt genérico.
7. O quality gate final permanece obrigatório depois da seleção.
8. Glance acompanha a mesma sequência de eventos, sem reconstruir verdade a partir de logs soltos.

O modo `standard` deve continuar padrão. O cutover precisa de uma flag independente e rollback por facade, sem reescrever businesses, squads ou mind-clones.

## Critérios para declarar o programa completo

- Um teste E2E cria Project, Conversation, Message e Run, despacha um target real por adapter fake e observa toda a timeline por SSE. Atendido por `glance-agent-x-canary-e2e.test.ts`: um filho fake injetado por `NIRVANA_DISPATCH_SCRIPT` roda o cutover de verdade em outro processo, e o teste consome o stream do `run.prepared` ao `glance.child_exited`.
- `standard` mantém exit codes, artifacts, audit e session files atuais.
- `gauntlet light` executa produção, avaliação independente, revisão causal e gate final para Business, Squad e `agent-x`.
- Reiniciar depois de `candidate_created` retoma sem repetir side effect.
- Budget insuficiente impede a próxima execução antes de reservar recursos.
- Snapshot de runtime e modelo permanece consultável mesmo depois de atualizar o catálogo.
- Projeto legado abre sem escrita e só migra após adoção explícita.
- Testes de businesses, squads e mind-clones existentes passam sem migração destrutiva.

## Resultado de testes nesta integração

A bateria focada da fronteira de pós-gate aprovou os cenários de PDF, HTML, ZIP, session, audit, falhas não fatais e skip em modo fast. A prova E2E de paridade aprovou sucesso e falha de manifesto. A prova integrada Business aprovou sucesso com timeline completa e rejeição antes do delivery. A delivery pipeline também foi repetida para confirmar que o hook só executa depois de uma decisão entregável.

A suíte conjunta de Harness e Squads aprovou 844 testes e 2.614 asserções antes do último corte do chat. O conjunto afetado foi repetido depois do corte, sem falhas.

Depois do corte de execução por processo filho, a suíte do Harness aprovou 948 testes e 4.037 asserções em 102 arquivos. A bateria focada do corte (runner, e2e do Glance, recuperação, control plane, prova Business, projeção multi-target, rótulos, cutover, loop de revisão e alvo explícito) aprovou 85 testes em 10 arquivos. O corte também corrigiu a identidade de artifact do cutover, que ignorava o `runId` e colidia na segunda Message de um mesmo projeto.

O `routing-eval.test.ts` reconstruía o mesmo índice BM25 para cada um dos 3.449 casos. A avaliação em lote agora prepara o índice uma vez, sem cache global e sem alterar o caminho normal do roteador. O teste caiu de mais de 230 segundos para cerca de 26 segundos. Os nove pisos passaram, com top-1 de 98,5%, MRR de 0,989 e false-dispatch de 0%.

O smoke test do Pi confirmou sua configuração interna com provider `openrouter` e modelo `stealth/ox-alpha`. Essa configuração pertence ao Pi e não define o runtime padrão do Nirvana ou deste projeto. O projeto continua no runtime ativo da sessão. O Pi é reservado para testes auxiliares com alto consumo de tokens de LLM. A execução sem tools, sessão ou contexto respondeu `PI_RUNTIME_OK`; ela confirma disponibilidade do executor auxiliar, mas não substitui os testes herméticos do engine.

## Regra de entrega

Até os critérios acima passarem, a implementação deve ser descrita como fundação integrada com canário operacional. O fluxo `agent-x light` opera pelo Gauntlet, roda de verdade a partir do chat do Glance por processo filho e pode ser inspecionado na timeline. O sistema inteiro ainda não opera em Gauntlet, pois Business, Squad e intensidades maiores permanecem no caminho anterior fora do opt-in explícito.
