# Changelog

All notable changes to the Nirvana-OS engine. Versions map to GitHub releases
(`nirvana-os-engine`); each release ships the full engine tarball that
`npx @nirvana-os/cli` and pack installs consume.

## 0.1.71 — 2026-07-27

### Roteador fast pós-censo: 94,1% → 99,8%, e NO_MATCH enfim alcançável

Censo de verdade-terreno contra TODOS os 2.358 `example_briefs` do registro
provou que o `applyAdjustments` derrubava 133 briefs válidos — todos erro,
zero curadoria. Correções, cada uma medida antes e depois:

- **Filtro de intent vira opt-in** (`NIRVANA_ROUTER_INTENT_FILTER=1` religa).
  Verbos banais ("run", "rodar") excluíam capabilities por classe: 81 NO_MATCH
  fabricados + 34 HIGH para rota alheia. Pós-ajustes: 94,1% → 99,8%.
- **`score_boost` clampado em [1.0, 1.3]** — boost 0 era aceito como
  multiplicador ×0 e auto-aniquilava a capability.
- **NO_MATCH por cobertura**: vencedor que casa ≤1 de ≥3 tokens de conteúdo do
  brief ORIGINAL (nunca o amplificado) → NO_MATCH; 2 de ≥4 com fração ≤0,5 →
  AMBIGUOUS. Brief fora de domínio agora abstém com razão explícita; zero
  falso-negativo nos 2.358 reais. Fecha a dívida "NO_MATCH inalcançável".
- **Stage -1 sem sequestro**: gatilhos banais ("portfolio", "end-to-end")
  removidos e fallback por substring morto — 56 briefs sequestrados com 0
  acertos voltam ao pipeline normal.
- **Promoção business-first vê `business_route` como rival** — fecha o
  invariante top=1.0 quebrado.
- **Business era invisível para o próprio brief**: `example_briefs`/`produces`/
  `keywords` entram no texto indexado do doc de business. Destino certo dos
  319 briefs declarados: 7,5% → 91,5%. E2E squads subiu junto (99,6%).

### Criação nativa: o engine sem conteúdo cria tudo

O engine instala sem businesses, squads ou clones — e agora cria os três de
ponta a ponta, sem squad intermediário (o papel do `nirvana-squad-creator` foi
absorvido):

- `squads/references/02-creation.md`: Phase 0 (arqueologia de intenção +
  pesquisa web obrigatória) e Phase 8 (otimização + gate de roteamento com
  `example_briefs` como verdade-terreno).
- `businesses/SKILL.md`: Round 0 e Round 5 equivalentes, com mind-clones
  escolhidos por necessidade.
- `_shared/MIND_CLONE_CREATION_PIPELINE.md` (novo): clone ponta a ponta com
  gate de material (sem fonte = archetype, nunca nome real), DNA `^[FONTE]` e
  bloco routing pelo contrato.
- Harness: clones casados por NECESSIDADE via `nrv find-clone` (campo
  `serves`), NO_MATCH despacha `agent-x` (o brief nunca para), e gate de
  atualidade na Fase 2 (escolha de stack não especificada exige pesquisa web
  com fonte e data).

### Qualidade travada no CI

- Eval de roteamento de clones entra na suíte com marcos d'água; em install
  limpo ou pack parcial os marcos skipam (pureza: o engine não instala
  conteúdo) e vale o invariante universal de auto-recuperação 100%.
- `index-clones.ts` espelha o registry do escopo global automaticamente.
- Suíte: 141 pass, 0 fail.

## 0.1.70 — 2026-07-27

### Clone ausente nunca mais derruba o dispatch — em sete camadas

Regra do dono: **o dispatch jamais pode morrer porque um mind-clone não existe.**
Um brief que cite um especialista fora da biblioteca matava a execução inteira,
mesmo quando o agente sabia perfeitamente trabalhar como aquela pessoa.

Mas degradar em silêncio é pior que falhar, então toda degradação é RUIDOSA em
três canais: evento `mind_clone_missing_degraded`, bloco explícito dentro do
prompt dizendo ao agente que ele NÃO carrega aquele DNA, e campo no retorno para
quem chamou reportar ao usuário.

O levantamento achou o defeito em sete lugares, não um:

- **`injectMindClones`** lançava exceção. Agora degrada e devolve `degraded[]`.
- **`validateTrace`**, a garantia anti-fabricação, tratava clone degradado como
  fabricação. Passou a distinguir três estados: injetado, degradado com evento, e
  sumido sem rastro. Só o terceiro reprova — a propriedade anti-fabricação segue
  intacta, verificada com trace sintético.
- **`team-orchestrator`** pulava em silêncio (`if (persona)`).
- **`employee-prompt`** era o pior: clone SOLICITADO e inexistente fazia
  `hadRequested` virar `false`, e o sistema caía calado para BUSCA e injetava
  **outra pessoa**. O employee rodava achando que era a persona certa.
- **`deterministicAudit` Regra 2** marcava clone ausente como `critical`, e
  `critical > 0` produz `verdict: "block"`. O `throw` removido ressuscitava um
  andar acima. Rebaixado para `warning`; squad e business ausentes seguem críticos.
- **`buildVoiceFidelityPack`** omitia clone ausente sem registro, deixando o gate
  de fidelidade indistinguível de "nenhum clone declarado". Ganhou `missing_clones`.
- **Rubric do auditor LLM** (`dispatch-auditor.md`) ainda listava mind-clone sob
  "Critical — verdict: block", o que reintroduziria o bloqueio pela camada
  semântica. Movido para warning, com o caminho de criação documentado.

### Rule 9 no SKILL.md: procure por necessidade, crie se faltar, degrade com honestidade
- Seleção de clone em quatro passos, e nenhum termina em falha dura: nomeado no
  brief vence tudo; não nomeado busca pela NECESSIDADE e não pelo nome; pedido e
  inexistente oferece criar via `fabrica-de-genios`
  (`knowledge_management.mind_clone_generation_pipeline.execute`); não criou, atua
  por conhecimento próprio **dizendo que é isso**.
- O ponto do passo 4 é a diferença entre degradar e mentir. Trabalhar sem o DNA é
  aceitável; deixar o usuário achar que o DNA estava lá, não.

## 0.1.69 — 2026-07-27

### O caminho fragmentado descartava a espinha operacional da persona
- `NIRVANA_DNA_INJECTION=fragments` nunca leu o `AGENT.md`. Ele lia SOUL + camadas
  do schema + coherence map, e só. Isso não era "seleção por camada": era trocar a
  definição operacional do agente pelo resumo derivado dela. O `AGENT.md` é **36%
  de tudo que o full injeta** e é onde vivem os Princípios, os Frameworks nomeados,
  os `Commands`, o `What You Refuse to Do` e as `Limitations`.
- Consequência: quem tivesse ligado o modo fragmentado — disponível há tempo, atrás
  de env var — rodava com personas sem limites declarados e sem recusas, e o sistema
  não emitia sinal nenhum. Modo degradado silencioso, como o corte cego do 0.1.68.
- Corrigido: o `AGENT.md` entra como primeira unidade do fragmento. Teste de
  regressão fixa a invariante.

### Como isso apareceu, e o que a medição mostrou
- Teste cego de 5 pares (mesmo brief, persona inteira contra fragmento da fase,
  juiz sem saber qual é qual, persona completa como referência): a persona inteira
  venceu **4×1**. Um dos juízes decidiu explicitamente por `Limitations` — seção
  que o fragmento não tinha como enxergar. Elo causal, não correlação.
- Depois do conserto, com uma variável trocada: **3×2**, que com n=5 é
  indistinguível de moeda. O déficit sumiu; a equivalência **não** ficou
  demonstrada, e o teste não tem poder para decidir.
- **O default segue `full`.** A economia real, medida com o `AGENT.md` restaurado,
  é 21% — e cai para 12% se o L5 voltar à política de fase, o que a evidência dos
  juízes sugere ser necessário em trabalho analítico. As camadas têm peso quase
  igual (17% a 26%), então não há folga a extrair sem custo proporcional.
- Registro honesto: os 55% que a versão anterior reportava somavam 34 pontos de
  amputação a 21 de seleção real. A amputação estava sendo contabilizada como ganho.

## 0.1.68 — 2026-07-26

### Injeção de DNA por camada deixa de amputar o método
- A seleção estrutural por camada (L1 Filosofias · L2 Modelos Mentais · L3 Heurísticas ·
  L4 Frameworks · L5 Metodologias) já existia e é SEM PERDA por construção, mas estava
  inutilizável: o `byteBudget` cortava com `lastIndexOf("\n", 9000)` sobre o texto já
  colado. Como a ordem de montagem é SOUL → L1 → camadas da fase → coherence map, a
  cauda amputada era sempre **a última camada pedida** — exatamente aquela que a
  política de fase escolheu — enquanto o L1, que entra em toda fase, sobrevivia intacto.
  Medido: **175 dos 548 clones** eram amputados assim, sem erro nenhum.
- O orçamento agora descarta **unidade inteira** (só o coherence map, que é derivado) e,
  se ainda estourar, entrega o fragmento COMPLETO. O teto virou consultivo: entregar
  SOUL + as camadas da fase acima do orçamento continua sendo fração do full, enquanto
  amputar destrói o método. Corte cego segue valendo só para os caminhos não fragmentados.
- Teto de 9 KB → 16 KB, escolhido por medição: 9 KB deixava 65% dos fragmentos caberem
  íntegros, 16 KB leva a 94%, e 24 KB acrescenta 2 pontos.
- A fase real chega ao seletor (`injectMindClones({ phase })`); antes era `"execute"`
  fixo, então um dispatch de planejamento recebia camadas de execução.
- Resultado na biblioteca: **0 mutilados** (eram 175), 512 clones fragmentáveis, **56%
  de economia média sem nenhuma perda**.

### Parser de camadas reconhece cabeçalho em nível 3
- Cinco clones traziam as cinco camadas completas, com fontes citadas, escritas como
  `### Layer 1 — VISION`. O parser estrito os reprovava e eles caíam para full. Reescrever
  a persona para caber no regex seria destruir material bom por causa da ferramenta.
- Fallback que só entra quando o estrito falha, repartindo também em `###`. O caminho
  canônico fica idêntico: repartir em `###` de saída quebraria o corpo das camadas dos
  clones bem formados.

### Correções na superfície de contrato do 0.1.67
- **Churn perpétuo em mind-clone.** A superfície de clone varre o diretório inteiro e
  media `CHANGES.json` e `CHANGELOG.md` — que o próprio gerador escreve. Cada execução
  produzia mudança, que escrevia arquivo, que produzia mudança. 22 clones em laço.
  Saídas do gerador agora estão fora da medição (`GENERATED_FILES`).
- **Supressão por schema virava permanente.** `diffSurfaces` ignora diff entre schemas
  diferentes de propósito, para uma melhoria do extrator não inundar compradores com
  mudanças fantasma. Mas o `gen` retornava cedo quando não havia mudança, então a
  superfície nunca era regravada com o schema novo: o mismatch persistia e TODA mudança
  real futura daquele artefato seria engolida em silêncio. Agora schema diferente força
  a regravação. `SURFACE_SCHEMA` → 2.
- Entradas fantasma já gravadas ("dna-artifact removido: CHANGELOG.md") foram limpas de
  22 clones — elas diriam ao agente do comprador que houve remoção com quebra.

## 0.1.67 — 2026-07-26

### Mudança de artefato deixa de ser narrada e passa a ser calculada
- O sistema distribui squads, empresas e mind-clones que mudam o tempo todo, mas
  quem recebe a atualização não tinha como saber **o que** mudou. O agente do
  comprador seguia invocando uma capability renomeada, ou apontando para um alvo
  que virou outro, sem nada falhar em voz alta: o trabalho só saía errado.
- A saída óbvia — um `CHANGELOG.md` escrito à mão em cada artefato — já tinha
  falhado neste sistema antes de ser tentada. O campo `version` existe em todos os
  774 artefatos e está morto: 132 dos 178 squads parados em `5.0.0` (a versão do
  *protocolo* vazando) e 48 das 49 empresas em `1.0.0`. Metadado que depende de
  alguém lembrar apodrece; escrever prosa apodrece mais rápido que trocar um número.
- Agora cada artefato carrega uma **superfície de contrato** (`.nirvana-surface.json`):
  os identificadores aos quais um agente consumidor de fato se liga — id de
  capability, alvo de `invoke`, nome de task/workflow/agent, slug de employee,
  domains e produces — mais o hash do corpo de cada um. Duas superfícies são
  comparáveis por máquina, então versão e changelog passam a ser **derivados**.
- Severidade é consequência estrutural, não opinião: id removido ou renomeado e
  alvo de invocação trocado são QUEBRA (major); id novo é aditivo (minor); só o
  corpo ou a prosa de descoberta mudou é ajuste (patch). Renomeação é reconhecida
  como tal (mesmo corpo, id diferente) em vez de virar "removido + adicionado",
  que esconderia justamente a migração trivial.
- A superfície mora **dentro** do artefato e viaja no pack. Isso dispensa registro
  central: na atualização, o instalador compara a superfície instalada com a que
  está chegando no único instante em que as duas coexistem em disco, antes de
  sobrescrever, e reporta as quebras com a migração de cada uma.
- `nrv changes pending <entidade> --project <dir>` responde a pergunta que importa
  para quem consome: *o que mudou que ESTE projeto ainda não viu?* Devolve um
  `brief_block` pronto para o orquestrador colar na instrução de dispatch (Rule 8),
  porque changelog que o agente precisa lembrar de abrir é changelog que ele não lê.
- Comportamento é o único tipo que nenhum diff estrutural enxerga (mesma interface,
  resultado diferente). Fica como anotação manual opcional em `.nirvana-behavior.md`,
  consumida e apagada no build — deliberadamente a exceção, não a regra.

### Detalhes que decidem se isto funciona ou vira ruído
- **Determinismo é requisito.** O arquivo gerado entra no `hashDir()` do instalador.
  Com timestamp ou ordenação instável, todo rebuild marcaria todo artefato como
  atualizado e o sinal morreria no ruído. Sem data de geração, chaves ordenadas em
  qualquer profundidade, e o próprio arquivo excluído do que ele mede.
- **Schema diferente reestabelece a base em silêncio.** Uma melhoria futura no
  extrator muda hashes de artefatos que ninguém tocou; comparar entre schemas
  inundaria todo comprador com mudanças fantasma. O engine não sabe o que mudou de
  verdade, então não inventa.
- **Os dois instaladores usam o mesmo helper.** `scripts/install.ts` e
  `skills/_shared/scripts/install-content.ts` têm cada um a sua cópia de `syncKind`;
  a primeira versão desta feature entrou só no primeiro, e o caminho que o comprador
  usa para atualizar teria ficado sem aviso nenhum. A comparação vive em
  `_shared/lib/contract-breaks.ts` para que os dois relatem a mesma coisa.
- Linha de base gerada para 178 squads, 49 empresas e 547 clones em ~2s; segunda
  execução não altera um byte. `build-all-packs.sh` regenera antes de montar os packs.

## 0.1.66 — 2026-07-26

### Ordem antes de forma: paralelismo vira conclusão, não default
- A Phase 4 abria mandando "Dispatch to 1 or N in parallel" — paralelo como ponto
  de partida, antes de qualquer análise de dependência. O raciocínio de ordem
  estava vinte linhas abaixo, atrás de um "load it on demand", e o multi-target
  ainda era mencionado dentro da seção **Optional subsystems** ("None is
  mandatory"). Ou seja: o maestro era instruído a paralelizar primeiro e a pensar
  na ordem só se resolvesse carregar a referência.
- Agora a Phase 4 começa pela pergunta que decide tudo — *este alvo precisa do
  entregável de outro para fazer o trabalho dele?* — e a resposta define a forma.
  Precisa de upstream: roda depois, e a `DISPATCH-INSTRUCTION.md` nomeia a fase e
  o caminho para ler. Não precisa de ninguém: roda concorrente, desde que a
  instrução seja auto-suficiente — alvo que precisaria perguntar algo a um irmão
  no meio do run nunca foi independente, estava sub-instruído.
- Concorrência passa a ser a CONCLUSÃO da análise. Dois alvos que só parecem
  independentes mas leem a saída um do outro são um run corrompido, e a falha
  aparece tarde e com cara de problema de qualidade.

### Multi-target sai de "opcional" e vira o caminho normal de 2+ alvos
- `references/04-multi-target.md` deixa de ser subsistema opcional e passa a ser
  protocolo exigido sempre que a Phase 4 aterrissa em mais de um alvo. A máquina já
  existia e é boa — workspace compartilhado, `manifest.json` com `depends_on` /
  `consumed_by` / `outputs_path` e `parallel_waves[]`, e um
  `DISPATCH-INSTRUCTION.md` por alvo com escopo, caminhos upstream e quem consome a
  saída. O que faltava era o ponto de entrada tratá-la como norma.
- Escrever o DAG é o que torna a ordem auditável: onda que se aponta é decisão,
  onda que ficou na cabeça do maestro é palpite que o usuário não pode conferir.

## 0.1.65 — 2026-07-26

### Reuso de sessão por entidade (o agente continua sendo o mesmo agente)
- Cada dispatch abria sessão fria. A mesma empresa ou squad chamada duas vezes no
  mesmo projeto reconstruía do zero o que já sabia — e um agente que recomeça frio
  não é o mesmo agente, é um novo com o mesmo prompt. Contexto perdido é qualidade
  perdida, e nenhum orçamento traz de volta o que o agente esqueceu.
- `harness/lib/session-store.ts` guarda a sessão por **(projeto, runtime,
  entidade)**. Os três importam: projeto porque a mesma empresa em outro projeto
  deve começar fria (mesma isolação da memória — o que um projeto aprendeu costuma
  ser errado para o próximo); runtime porque id do claude-code não significa nada
  para o codex; entidade porque cada funcionário/squad tem a sua linha de
  raciocínio. Vive em `<projeto>/sessions.json`, único lugar que o BP5 permite
  escrever durante um brief.
- Ligado nos dois pontos do `team-orchestrator` (passo de funcionário e squad
  obrigatório) por um helper único, sem duplicar lógica. Emite `session_resumed` e
  `session_resume_failed` na trilha de auditoria.

### Fallback: o reuso só pode melhorar, nunca degradar
- O driver passa `--resume <id>` e NÃO trata id inválido. Sessão expirada, apagada
  pelo CLI ou vinda de outra máquina faria falhar um dispatch que hoje funciona.
- Agora: se o run falhou E tínhamos passado um id, descarta o id e tenta UMA vez
  fria. O pior caso do reuso passa a ser exatamente o comportamento de hoje.

### Fix: session id vazava entre runtimes no cascade
- Bug latente que esta mudança tornaria comum. O `cascade-runner` montava as opções
  espalhando os args (`{...args, runtime: chosen}`) e, no handoff,
  `{...currentOpts, runtime: chosen}` — o `sessionId` sobrevivia à troca de runtime.
  O CLI novo recebia `--resume` com id de outro CLI.
- Contradizia o comentário do próprio código no handoff ("Build a fresh prompt for
  the new runtime — it doesn't see the old session"). Agora o id só passa quando o
  runtime escolhido é o que o chamador pediu, e é limpo em qualquer handoff.

### Cobertura
- 10 testes novos em `session-store.test.ts`, focados no que pode dar errado:
  isolamento entre runtimes, entre projetos e entre tipos de entidade; arquivo
  corrompido, JSON de forma errada e runtime sem session id não derrubando o
  dispatch; `dropSession` cirúrgico. Suíte total: 89 testes.

### Não implementado, de propósito
- Paralelismo no laço de squads obrigatórios. O mecanismo foi provado num spike
  (1531ms contra 4195ms, `session_id` idêntico, payload de 200KB íntegro através de
  múltiplos chunks, falha isolada), mas o ganho é wall-clock e a saída de cada squad
  é idêntica em série ou em paralelo. Exigiria tornar assíncrono o `cascade-runner`,
  que é o cérebro de failover — trocar o caminho mais crítico do sistema por
  latência, num sistema cuja regra primordial é qualidade sem limite de gasto, é um
  negócio ruim. A cadeia de funcionários segue sequencial por dependência real
  (cada passo lê os `priorOutputs` do anterior).

## 0.1.64 — 2026-07-25

### Rule 7 do contrato de execução: escopo inteiro, e o que passar dele é declarado
- Entrega impecável significa a tarefa INTEIRA, não a parte fácil: só reportar
  conclusão quando estiver de fato pronto e, se algo travar de verdade, terminar
  todo o resto e dizer o que ficou faltando e por quê. Ambiguidade se resolve
  como um colega cuidadoso resolveria — decisão de rotina é do maestro, e só
  volta ao usuário quando leituras diferentes levam a trabalhos materialmente
  diferentes.
- O que o escopo não pode fazer é se mover em silêncio. Nada de estreitar,
  alargar ou transformar o pedido sem avisar; achar que o brief está errado vira
  uma frase dita ao usuário, não uma troca calada. O que for além do pedido entra
  na instrução de dispatch e no relatório final como adição explícita — trabalho
  que o usuário não pediu não é bônus se ele não consegue distinguir do que pediu.

### Contrato de escrita: comprimento acompanha substância
- Seção `Structure` ganhou a regra de tamanho: cobrir o que o entregável precisa
  e parar. Seção de enchimento, resumo redundante, contexto reafirmado e
  boilerplate passam a ser tratados como DEFEITO, não como zelo — comprimento sem
  substância soterra a parte que o leitor foi buscar. Documento longo justifica o
  tamanho cobrindo mais, nunca dizendo a mesma coisa duas vezes.
- Chega aos três arquivos de contrato do projeto (`AGENTS.md`, `CLAUDE.md`,
  `GEMINI.md`) pelo `init-project`, então alcança também as entidades despachadas,
  que rodam com cwd no projeto.

### O que deliberadamente NÃO mudou
- `effort` e `model` continuam sendo os do usuário. O Nirvana-OS não altera nem um
  nem outro por conta própria: herda o que estiver no sistema e só muda se o
  `.env` especificar ou se o usuário pedir. Nenhum nível de esforço foi embutido
  em lugar nenhum.
- Nenhum teto de spawn e nenhum budget obrigatório. Orçamento ilimitado e máxima
  qualidade são regra primordial do sistema; o cap de multi-agente que a
  documentação do modelo recomenda vale para workloads sensíveis a custo, que não
  é o caso aqui. A arquitetura de fan-out fica como está.
- Os três gates determinísticos (`quality-gate`, `verify-deliverable`,
  `validate-chain`) ficam intactos: eles conferem verdade em disco, não são
  auto-verificação dirigida por prompt.

## 0.1.63 — 2026-07-25

### Colisão de slug agora é avisada (não mais silenciosa)
- Política inalterada: o pack é a fonte da verdade dos SEUS componentes, vence
  sempre e não há backup — quem altera o que é nosso é responsável pelas
  próprias mudanças. O que muda é só a VISIBILIDADE: se o usuário criou um
  componente com o mesmo slug de um do pack, o sync o sobrescrevia em silêncio e
  o trabalho dele sumia sem explicação (virava issue "sumiu do nada").
- Detecção exata: existe em disco E não está no manifesto do pack
  (`~/.nirvana-pack.json`) ⇒ é criação do usuário. Sem falso positivo na segunda
  rodada, quando o pack já passou a ser dono do slug.
- Reportado como `N overwritten` na contagem e em bloco próprio no fim, com o
  caminho de saída (renomear o seu) e o que foi preservado (run-state:
  `projects/`, `outputs/`, `memory/projects`). Aplicado nos DOIS caminhos de
  sync — `scripts/install.ts` (starter) e `_shared/scripts/install-content.ts`
  (o que o comprador roda via `setup.ts` do pack e `nrv update <slug>`).

### Clones em layout legado aninhado voltam a ser indexados
- Instalações de pack em ≤ 0.1.61 gravaram `dna/<categoria>/<slug>/` (issue #2,
  corrigida na 0.1.62). Quem já tinha essa árvore continuava com `0 mind-clones
  indexed` mesmo após atualizar, porque o scanner só via um nível.
- `index-clones.ts` agora lê os dois layouts: leitor liberal, escritor estrito.
  NADA é movido em disco — mexer nos dados do usuário durante um comando de
  leitura seria pior que o bug. O writer já é flat desde a 0.1.62, então este é
  um caminho de compatibilidade que decai sozinho conforme as instalações
  antigas reinstalam.
- Flat vence no empate de slug; para o clone aninhado a categoria vem do próprio
  diretório-pai. O total legado é reportado ao fim do index, com a orientação de
  que reinstalar o pack normaliza e nada precisa ser movido à mão.

## 0.1.62 — 2026-07-25

### Bibliotecas de conteúdo criadas vazias no install (`~/squads`, `~/businesses`, `~/businesses/_library/dna`)
- O engine é core-only (não embarca conteúdo), mas os diretórios onde o usuário
  cria as SUAS empresas/squads/mind-clones não existiam após a instalação: o
  `scripts/install.ts` só os criava quando havia conteúdo do starter pack para
  copiar (`if (available.length > 0) mkdirSync(dstRoot)`). Com `--no-starter`
  (o caminho do `npx`), nenhum era criado — e o comportamento ainda era
  inconsistente: `~/squads` acabava surgindo por acaso no primeiro `nrv index`
  (via `squads/lib/registry.js`), enquanto `~/businesses` e a biblioteca de DNA
  nunca apareciam. Resultado: instalação nova reportava `⚠ 3 warning(s). System
  usable but degraded.` no `nrv doctor`.
- Agora `ensureContentLibraries()` cria os três VAZIOS, antes do starter pack
  (vale com e sem `--no-starter`). Espelha o que o escopo de projeto já fazia
  (`init-project.ts` cria `.nirvana/{squads,businesses,mind-clones}`).
- NÃO destrutivo e idempotente: `mkdir` recursivo é no-op em diretório
  existente — conteúdo do usuário é preservado (reporta `kept` em vez de
  `created`). Cross-OS: só `path.join` + `mkdirSync`, sem comando de shell, com
  EEXIST tolerado (o Bun lança no Windows mesmo com `recursive: true`).
  `nrv install --check` continua sem mutar nada.

### Fix: pack install gravava mind-clones aninhados por categoria (issue #2) — 0 clones indexados
- `installer.ts` instalava clone em `dna/<categoria>/<slug>/`, mas o layout
  canônico é FLAT (`dna/<slug>/`) — o que `index-clones.ts` (varre um nível só)
  e `install-content.ts` já seguiam. Todo pack com mind-clones instalado por
  `nrv install --type=pack` resultava em `0 mind-clones indexed`.
- Instala flat agora (pack e asset avulso) e grava a categoria como METADADO em
  `.pack-categories.json` — arquivo que o indexer lê mas que NENHUM fluxo do
  engine escrevia, então `pack_category` nunca saía de `null`.
- Colisão de slug dentro do pack agora falha explícita (antes ficava mascarada
  por categorias diferentes). Inferência de categoria endurecida: packs reais
  são flat, então o nome do diretório pai gravaria `"mind-clones"` como
  categoria. `index-clones.ts` passou a resolver o mapa por-root (o metadado
  gravado em escopo de projeto era ignorado).

### Fix: `nrv init --with-skills` quebrava com cópia de 312 MB e projeto pela metade (issue #3)
- Eram três defeitos encadeados, não um: (1) o branch de symlink não criava
  `<target>/.agents`, então `symlinkSync` falhava com ENOENT; (2) caía no
  fallback de cópia; (3) `copyTree` usava `statSync` e seguia o symlink
  `node_modules` de cada skill → centenas de MB e recursão infinita nos ciclos
  de `node_modules/.bin/*` (ELOOP). Corrigir só o `copyTree` deixaria o gatilho
  de pé, com todo `--with-skills` copiando em vez de linkar.
- `copyTree` usa `lstatSync`, pula `node_modules` em QUALQUER profundidade (não
  só no topo) e recria symlinks em vez de expandi-los; `.agents` passou a ser
  criado no branch de symlink; e a falha de cópia virou fail-closed — antes era
  `log.warn` e o comando saía 0 deixando um projeto quebrado.

### Fix: `nrv index` falhava no Windows em escopo de projeto (issue #1, bug 2)
- `businesses/lib/registry.ts` fazia `mkdirSync` cru; no Bun/Windows isso lança
  EEXIST mesmo com `recursive: true` quando o diretório já existe — o caso de
  `<projeto>/.nirvana`, que existe desde o `nrv init`. Passou a usar o helper
  canônico `ensureDir`, que já tolera EEXIST. (Os outros 3 bugs da issue #1 já
  estavam corrigidos desde a 0.1.25/0.1.26.)

### grok-cli: flag documentada + custo real
- Trocado `--yolo` por `--always-approve` (código e docs). `--yolo` funciona,
  mas é alias OCULTO — não aparece no `--help` e pode sumir entre builds.
- O driver gravava `costUsd: null` fixo alegando que a assinatura não reporta
  gasto; o build real devolve `total_cost_usd` no JSON. Agora é parseado.
- Invocação VERIFICADA contra o binário real (`grok 0.2.103`): flags aceitas,
  JSON com `text`/`sessionId`/`total_cost_usd`. O `kimi-cli` segue NÃO
  verificado (binário ausente na máquina de teste).

## 0.1.61 — 2026-07-20

### Novos runtimes first-class: Kimi Code CLI + Grok Build CLI
- `kimi-cli` (Moonshot, binário `kimi`) e `grok-cli` (xAI, binário `grok`) agora são
  runtimes de primeira classe, iguais a codex/gemini-cli/antigravity-cli: `runKimi`/
  `runGrok` no host-agent-driver, presentes em VALID_RUNTIMES/EXEC_RUNTIMES,
  RUNTIME_ALIASES (`USE_KIMI`/`USE_GROK`), detecção de host, menção no brief, glance,
  `.env.example`, e adapters completos em `_shared/adapters/{kimi-cli,grok-cli}.md` +
  `_shared/agents/agent-x.{kimi,grok}.md`. Model vem só do LLM_CASCADE
  (`kimi-cli:k3` / `grok-cli:<model>`), NUNCA hardcoded (model-agnostic).
  - Kimi: grátis via OAuth Kimi.com (K3/K2.7), `kimi -m <model> -p … --output-format stream-json`.
  - Grok: coding agêntico + geração de mídia nativa, `grok -p … --output-format json --yolo --cwd`.
  - Ressalva: as invocações ainda NÃO foram verificadas contra os binários `kimi`/`grok`
    reais (fallback seguro se uma flag divergir).

### Consolidação dos adapters em `_shared/adapters/` (v5, fonte única)
- Aposentada a camada `squads/adapters/` v4.0 (duplicatas/órfãs): removidos codex,
  gemini-cli, antigravity, cursor, claude-code. As tabelas de `squads/references/*`
  agora apontam para `_shared/adapters/`. Nenhum código dependia da camada v4.
- Antigravity: eliminado o adapter órfão (id `antigravity`/binário `antigravity`/modelo
  fixo); fica só o canônico `antigravity-cli` (binário `agy`, sem model).
- Cursor: removido (substituído pelo `grok-cli`).
- Purgados TODOS os nomes de modelo velhos dos adapters — o engine usa o default do
  runtime ou o escolhido pelo usuário, nunca um id fixo.

## 0.1.60 — 2026-07-18

### Fix: validator drift — v5 capability/business description caps
- `capability-validator.js` (the v5 structural pre-check that `validate-squad.ts`
  runs) hard-coded the capability `description` cap at 500, which had drifted from
  the raised canonical limit (1500 in `_shared/validators/limits.ts`, the same
  `LIMITS` the zod validators use). Valid v5 manifests with 500–1500-char
  capability descriptions were wrongly rejected, aborting `brief-squad.ts` prep
  (e.g. a squad's `whatsapp.system.provision` at 639 chars). It now reads the cap
  from `limits.ts` (single source of truth) with a safe fallback to 1500 — never
  500 again, so the fast pre-check can't drift from the authoritative validator.
- Aligned the JSON schemas to `limits.ts`: capability `description` 500→1500 and
  `example_briefs` items 500→1000; business `description` 500→2000 and
  `example_briefs` items 500→1000.

## 0.1.59 — 2026-07-17

### Windows: CRLF-tolerant parsing
- The frontmatter parsers were `\n`-anchored, so a Windows CRLF checkout made
  `---\r\n` fail to match → rubrics (and 8 other parsers: mind-clone/squad/
  business audit criteria, clone inspect/list/translate) silently loaded
  nothing, and the quality gate selected no rubric on Windows. Fixed with a
  `.gitattributes` (`eol=lf` for parsed files, `eol=crlf` for `.cmd` launchers)
  plus CRLF-tolerant regexes as defense in depth. Caught by the new quality-gate
  test on the Windows CI runner.

## 0.1.58 — 2026-07-17

### The engine never prescribes a model
- The model used is ALWAYS the one configured in the user's own agent runtime
  (Claude Code, Codex, Gemini, Antigravity, …). The engine only overrides it when
  the user explicitly asks for a specific model.
- Removed every default model from the engine: judge config (`default_judge_model:
  inherit`), capability `model_hint` default, rubric `target_model` (now
  telemetry-only `inherit`), adapter docs, and the pixelle client (now
  `gemini-flash-latest`, the provider's non-versioned pointer — no more 404s from
  retired model slugs).

### Router: explicit mention wins; business-first stops hijacking
- New Stage 0.5: naming a squad or business by slug ("use o squad code-review…")
  deterministically short-circuits routing (`route_tier: explicit_mention`) —
  before any scoring. Accent/hyphen-normalized, guarded against false positives.
- Business-first preference is now a relative tiebreak against the best squad,
  never an absolute floor; artifact-pattern routes (`business_route`) compete
  inside the RRF fusion as a third ranked list instead of short-circuiting ahead
  of content matching. Briefs that clearly match a squad no longer get hijacked
  by unrelated business routes.

### Repo & docs
- `CHANGELOG.md` (this file), `AGENT-QUICKSTART.md` (one-page agent onboarding),
  `SECURITY.md`, issue/PR templates, `examples/` end-to-end walkthrough.
- README hero image + CI badge; version badge now rewritten from `package.json`
  at publish time.
- `AGENTS.md` is the single source for the agent contract; `CLAUDE.md`/`GEMINI.md`
  are generated copies (drift fails the publish).
- `skills/harness/SKILL.md` normalized to English throughout.
- New tests: audit event emission (`audit-emit`) and quality-gate selection/fail-closed paths.

## 0.1.57 — 2026-07-13

- **Windows:** `nrv index` fixed (POSIX-only bun-path check made every indexer
  spawn fail with ENOENT when Bun wasn't on PATH); shell-string quoting replaced
  by argv-based `run()`; 11 `.cmd` wrappers fixed (`>nul` instead of
  `/dev/null`); spawn errors now surface their cause.
- **Install anywhere:** the npx installer auto-installs the latest Bun on Windows
  (PowerShell) and continues in the same run; `nrv` is added to the user PATH via
  registry + `WM_SETTINGCHANGE` broadcast so new terminals work without a
  restart; post-install indexing now runs on Windows (`nrv.cmd`); hook commands
  are quoted and use per-OS stderr suppression; `fileURLToPath` fixes repo-root
  resolution on Windows.

## 0.1.56 — 2026-07-13

- Grok-aware ENGINE-MENU (Grok Imagine i2v across video squads' guidance).
- `brief-squad.ts`: squad dispatch now scaffolds the project dir, HANDOFF and
  brief AND emits `brief_received`/`dispatch_squad` automatically — the audit
  trail exists on any runtime, no reliance on the agent obeying SKILL.md.

## 0.1.55 — 2026-07-10

- `nrv doctor` reports honestly: "last activity <date>" instead of a false
  "no dispatches yet?"; detects outputs-without-audit (agent not emitting
  events) and squad dispatches (not only businesses); OS-safe paths.

## 0.1.54 — 2026-07-10

- Security hardening: removed `js-yaml` (DoS advisory GHSA-h67p-54hq-rp68) —
  the two remaining users migrated to `yaml` v2; `bun audit` clean.
- Embedder locked with `allowLocalModels=false` (closes the local-model vector
  of the ONNX CVEs; hub/cache behavior unchanged).

## 0.1.53 — 2026-07-10

- Hybrid retrieval: BM25 + optional local dense arm (transformers.js/ONNX,
  multilingual MiniLM) fused with Reciprocal Rank Fusion; opt-in via
  `nrv embeddings enable` — the core stays zero-hard-dep with graceful fallback.
- Router calibration (E1–E7 external audit): capability `keywords`/
  `example_briefs`/`produces` indexed with field weighting; org-noun vs verb
  separation; best-business-only promotion; generic-object abstention in the
  keyword stage; meta-intent pruning.
- Retroactive learning loop: audit readers accept `business_slug`/`squad_name`
  aliases (history recovered); `nrv audit emit` canonical writer CLI.
- First router test suite (69 tests) + YAML/HTML validation rubrics.

---

Earlier releases (0.1.9 → 0.1.52) predate this changelog; see the GitHub
release notes of each tag for their summaries.
