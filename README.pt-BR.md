# Nirvana-OS engine

[![version](https://img.shields.io/badge/version-0.1.54--beta-blue)](#licença-autoria-e-status)
[![license](https://img.shields.io/badge/license-SUL-lightgrey)](./LICENSE)
[![npm](https://img.shields.io/badge/npm-%40nirvana--os%2Fcli-cb3837)](https://www.npmjs.com/package/@nirvana-os/cli)

**Leia isto no seu idioma:** [English](./README.md) · [Português](./README.pt-BR.md) · [Español](./README.es.md) · [中文](./README.zh.md) · [हिन्दी](./README.hi.md) · [العربية](./README.ar.md)

---

## Comande um universo de empresas em linguagem comum

Você já tem um agente de terminal. Claude Code, Codex, Gemini-CLI ou Antigravity. Ele é afiado, e está sozinho.

O Nirvana-OS transforma esse agente solitário em um maestro que conduz **empresas inteiras**. Você descreve o que quer em prosa simples, e o sistema levanta as organizações, os times especialistas e as mentes expertas para entregar o resultado, muitas delas de uma vez, com um comprovante de cada passo.

```bash
npx @nirvana-os/cli
```

Um comando. Ele instala o engine, se conecta a cada runtime de agente que encontra, e pode ser rodado de novo a qualquer momento com segurança. Nada mais para configurar.

E aqui está a regra que esta página não para de provar, seção após seção: **você fala, seu agente roda os comandos.** O punhado que vale a pena digitar você mesmo cabe em uma única tabela curta.

## Você não precisa de mais um chatbot. Você precisa de uma organização que faça o trabalho.

Um único agente responde a um prompt. Trabalho de verdade não é um prompt. É um pesquisador, um redator, um revisor e um operador puxando em direções diferentes, coordenados, com registro em papel. Hoje você é a cola: você roda prompt atrás de prompt na mão e costura as peças você mesmo, sem registro de quem fez o quê.

O Nirvana-OS tira você da cola. Você declara o resultado em prosa. O engine lê, consulta o que você tem, despacha a combinação certa de empresas e squads, roda tudo em paralelo, reconcilia o resultado atrás de um portão de qualidade e anota cada despacho. Você sai de operador para diretor: declara a meta e inspeciona o resultado.

## Para quem isto é

Um público pequeno e específico, de propósito: desenvolvedores e operadores que já rodam um agente de terminal e perceberam que o gargalo se moveu. Uma boa resposta é fácil agora. Uma organização inteira de trabalho coordenado, com prova de quem fez o quê, ainda é difícil, e esse é o problema que este engine remove. O Nirvana-OS não substitui seu agente. Ele o promove.

## O que é, em um fôlego

O Nirvana-OS é um sistema operacional multi-agente nativo em Bun que cria, gerencia e administra um conglomerado: qualquer número de empresas e/ou squads, orquestrado do briefing ao entregável verificado. É a camada de orquestração **acima** do seu agente de terminal, não "uma empresa que constrói empresas", e funciona em três materiais, todos moldados por linguagem natural:

- **Empresas (businesses):** organizações autônomas com um organograma de funcionários. Cada funcionário chama squads. Elas vivem em `~/businesses/`.
- **Squads:** times de agentes portáteis que rodam workflows reais (DAG, gates, escalação) e entregam entregáveis prontos. Eles vivem em `~/squads/`.
- **Mind-clones:** DNA de persona em 5 camadas, injetado nos funcionários para que pensem e falem com o método de um mestre. Eles vivem em `~/businesses/_library/dna/`.

Uma única requisição pode mobilizar muitos deles ao mesmo tempo. O orquestrador (o `harness`) escolhe o elenco. Você só descreve o resultado.

## Veja funcionar: tudo é uma frase

Esta é a parte que importa. Você não escreve código, não preenche formulários, não edita config. Você conversa com o sistema, dentro do runtime de IA que você já usa, chamando-o pelo nome: **"use o Nirvana-OS para…"**. É assim que fica.

### 1. Construa uma empresa descrevendo-a

Dê a hierarquia e os papéis em prosa. Ele desenha a organização, escreve cada funcionário, conecta os workflows e valida o resultado.

```text
Use Nirvana-OS to create a company called podcast-empire that produces, publishes,
and monetizes 3 podcasts at once. Each show has its own niche, an AI host, an
editorial calendar, and an independent monetization funnel. Around 7 employees.
```

O sistema roda sua fábrica de empresas: leitura de intenção, pesquisa de domínio, um blueprint de organização que você aprova, e então funcionários, memória e workflows, validados contra o Business Protocol. Você termina com `~/businesses/podcast-empire/`, com o quadro montado e pronto para rodar.

### 2. Ou deixe o sistema desenhar a empresa para você

Ainda não sabe a estrutura certa? Pergunte. Este é o fluxo pelo qual a maioria das pessoas se apaixona.

**Passo um, peça o desenho:**

```text
Use Nirvana-OS: how would a complete, modern marketing agency be structured?
Give me the hierarchy, the key roles, and who the best specialists in the world
are for each seat.
```

O sistema responde com um organograma real: um diretor de criação, um head de performance, um chefe de copy, um líder de conteúdo, um estrategista, e os nomes dos operadores cujos métodos cada cadeira deveria encarnar.

**Passo dois, clone esses especialistas:**

```text
Great. Clone those specialists into mind-clones I can hire.
```

Ele roda a fábrica de mind-clones e produz DNA de persona para cada um, o pensamento, as heurísticas e a voz daquele tipo de operador.

**Passo três, construa a empresa com eles nas cadeiras:**

```text
Now build the agency, and put those clones in the matching roles as the
brains of each employee.
```

Ele monta a empresa, atribui cada mind-clone ao funcionário certo, e cria qualquer squad especialista que a agência precise mas ainda não tenha. Você fez três perguntas em português claro e recebeu uma empresa com o quadro montado.

### 3. Crie um squad especialista em prosa

Quando uma empresa precisa de uma capability que nenhum time existente cobre, descreva o time que você quer.

```text
Use Nirvana-OS to generate a squad for headless e-commerce automation, with
agents for catalog, checkout, inventory, and support. Validate it against the
Squad Protocol.
```

Sai um `~/squads/…/` com agents, tasks, workflows, schemas, uma config de harness e um README, tudo validado.

### 4. Clone um expert em prosa

Transforme a obra pública de qualquer pessoa em um conselheiro que seus funcionários podem usar.

```text
Use Nirvana-OS to turn the public work of <author> into a complete AI mind-clone
through the genius factory.
```

A fábrica extrai um DNA de 5 camadas (filosofias, modelos mentais, heurísticas, frameworks, metodologias), constrói a persona, passa-a por um painel de outras mentes, e entrega um conselheiro que você pode encaixar em qualquer empresa.

### 5. Uma frase, muitos times de uma vez

O orquestrador tem prazer em mobilizar várias empresas e squads a partir de um único briefing.

```text
Use Nirvana-OS to produce a launch package: market research, landing-page copy,
and a competitive teardown.
```

Essa única linha pode puxar um squad de pesquisa, um squad de copy e uma empresa de design em paralelo, cada um com funcionários carregando os mind-clones certos, reconciliados atrás de um único portão de qualidade. Você não escolheu nenhum deles. O maestro escolheu, e a trilha de auditoria mostra suas escolhas.

> A interface inteira é prosa mais um comprovante. Sem chamadas de API, sem arquivos de config. Descreva o resultado, depois leia a trilha de auditoria que prova o que aconteceu.

O que deixa uma pergunta prática. Como você diz tudo isso para o *seu* agente? Instale primeiro; isso leva um minuto.

## Instale em 60 segundos

Mesma ideia em todo OS: instale o Bun uma vez, depois rode um comando.

O que você precisa: Bun 1.0 ou mais novo roda tudo. Node 18 ou mais novo e `tar` existem só para o `npx` funcionar; a maioria das máquinas já os tem. Python 3.10 ou mais novo é opcional, necessário só para `nrv export --pdf` e `--zip`.

### macOS / Linux

```bash
curl -fsSL https://bun.sh/install | bash
exec $SHELL                # reload PATH, or just open a new terminal
npx @nirvana-os/cli        # installs the engine
```

### Windows (nativo, sem WSL)

O sistema inteiro roda em Bun, então o Windows precisa só do Bun. No **PowerShell**:

```powershell
powershell -c "irm bun.sh/install.ps1 | iex"
# open a NEW PowerShell window so PATH refreshes
npx @nirvana-os/cli
```

### O que o instalador realmente faz

Ele coloca uma única árvore de skills em `~/.nirvana/skills`, conecta-a a `~/.claude`, `~/.codex`, `~/.gemini` e `~/.antigravity` onde quer que os encontre, e põe os binários `nrv`, `nrv-gemini` e `nrv-hermes` em `~/.local/bin` (`%USERPROFILE%\.local\bin` no Windows), no seu PATH automaticamente. Ele instala o engine e nenhum conteúdo. Rodar `npx @nirvana-os/cli` de novo é idempotente e sempre baixa o engine mais recente.

Para confirmar que a instalação está saudável:

```bash
nrv doctor
```

Depois abra seu agente e diga **"use o Nirvana-OS para…"**. A próxima seção mostra exatamente como isso fica em cada runtime.

## Como pedir ao seu agente, runtime por runtime

Não há app do Nirvana-OS para abrir. Você fala com o agente que já usa, e uma frase acorda o sistema: **"use o Nirvana-OS para…"**. Variantes também funcionam: "via Nirvana", "orquestre pelo Nirvana", "use minhas empresas", "use meus squads". A frase dispara a skill `harness`. Essa skill é o maestro.

| Runtime | Status do link | Como você pede |
|---|---|---|
| Claude Code | Sempre conectado | Prosa, no seu chat. O agente invoca o harness sozinho. |
| Codex | Conectado se presente | Igual: prosa, in-process. |
| Antigravity (`agy`) | Conectado se presente | Igual: prosa, in-process. |
| Hermes | Ponte opt-in | `hermes chat`, depois prosa. Ou one-shot com `hermes -z`. |
| Gemini-CLI | Conectado se presente | Subprocesso via `nrv dispatch` (legado, em descontinuação). |

Em detalhe:

- **Claude Code, Codex, Antigravity (in-process):** você escreve a frase e nada mais. O agente invoca `Skill("harness", "<your brief>")` sozinho, ou ativa a skill casando com a descrição dela. Você nunca sai da conversa.
- **Hermes:** rode `hermes chat` e peça em prosa. Para um one-shot, `hermes -z "use the nirvana-os skill: <brief>"`. A ponte chama `nrv dispatch` por você.
- **Gemini-CLI (legado):** o engine o dirige como subprocesso via `nrv dispatch`. Funciona, e está a caminho da aposentadoria.
- **Qualquer diretório de projeto:** rode `nrv init <dir>` uma vez. Ele escreve um contrato `AGENTS.md`, com cópias `CLAUDE.md` e `GEMINI.md` idênticas byte a byte, para que qualquer agente que abra o diretório descubra o harness sozinho.

### O sistema sugere. Você decide.

Você não precisa decorar o que instalou. No modo agêntico, o padrão, o maestro raciocina sobre os três registries: empresas, squads, mind-clones. Um match limpo é despachado. Um briefing ambíguo recebe uma pergunta de volta, com os principais candidatos e suas descrições, para você escolher com contexto. Nenhum match resulta em recusa mais uma sugestão de criar a capability faltante, nunca uma tentativa falsa.

A seleção de mind-clone segue uma ordem fixa: solicitado, depois atribuído, depois busca, depois padrão. E sempre que o sistema escolhe um clone, ele também mostra os candidatos alternativos que descartou.

O que levanta a próxima pergunta óbvia: raciocina sobre *o quê*, exatamente? Veja você mesmo.

## Explore com `nrv`

Os comandos de descoberta são read-only e seguros a qualquer momento.

```bash
nrv glance            # read-only web cockpit: companies, squads, clones, audit, costs
nrv list-businesses   # organizations registered locally
nrv list-squads       # the agent teams
nrv list-clones       # persona DNA available to inject
nrv search "launch"   # find capabilities across all three registries
```

Rode isso numa instalação nova e você encontra a primeira objeção honesta a todo esse discurso: tudo volta vazio.

Ótimo. Isso é o projeto, não um defeito. A fábrica está instalada; a carga, não. O engine vem com poder total para criar e orquestrar e zero conteúdo pré-construído, então tudo nesses registries é algo que você construiu ou escolheu instalar. Nada chega que você não tenha posto ali.

Então o que vai nos registries? Três tipos de coisa, e apenas três.

## Os três pilares

Tudo o que o engine cria e orquestra é uma de três coisas. Este é o modelo mental inteiro.

| Pilar | O que é | Onde vive |
|---|---|---|
| **Empresas** | Organizações autônomas, cada uma com um organograma de funcionários | `~/businesses/` |
| **Squads** | Times de agentes portáteis que rodam workflows (DAG, gates, escalação) | `~/squads/` |
| **Mind-clones** | DNA de persona injetado nos funcionários para voz e julgamento | `~/businesses/_library/dna/` |

Uma empresa orquestra funcionários. Um funcionário chama squads. Um squad roda agents. Um mind-clone dá a qualquer um deles uma voz mais verdadeira. Um único briefing raramente precisa de apenas um.

É isso que eles são. Como cada um é formado é onde a engenharia aparece.

## Anatomia: como cada pilar é formado

Prosa é a interface, mas nada por baixo é vago. Cada pilar é um pacote com um protocolo por trás, e a anatomia vale dois minutos do seu tempo.

### Como um squad é formado (Squad Protocol v5)

Um squad é um pacote portátil sob `squad.yaml`, construído a partir de exatamente quatro tipos de peça:

- **Agents:** cada persona é um arquivo `.md` com duas audiências dentro. O frontmatter YAML carrega a configuração de runtime e é lido pela máquina; o corpo em prosa é o system prompt e é lido pelo modelo.
- **Tasks:** a unidade de trabalho. Uma task declara inputs, steps, outputs e critérios de aceitação que são binários e verificáveis: passou ou não passou. Tasks não têm dono.
- **Workflows:** YAML que amarra agents a tasks em um DAG. Steps no mesmo nível formam uma onda paralela. Quando um runtime não consegue criar subagentes, o workflow degrada graciosamente para execução sequencial.
- **Capabilities:** a camada de descoberta do v5. Cada capability tem um id hierárquico com pontos (`domain.subdomain.verb`), uma descrição, domínios, inputs e outputs tipados, exemplos, uma lista `not_for`, e um contrato `invoke` apontando para um workflow, uma task ou um agent.

A regra que segura tudo: a capability é o que o squad promete, atômica e vista de fora; o workflow é o como; a task é uma unidade dentro.

### Como uma empresa é formada (Business Protocol v1)

Uma empresa é um pacote sob `business.yaml`, e é a unidade de coerência organizacional. Dentro:

- **Funcionários:** agentes especialistas persistentes. Cada um é um arquivo `.md` cujo frontmatter declara `role`, `reports_to`, um `type` (`functional_specialist` ou `mind_clone`) e um `self_score_contract`; o corpo é o system prompt.
- **Um organograma:** hierarquia real, não decoração. Ao lado dele: roteamento e processos.
- **Memória:** memória permanente da organização, mais memória isolada por projeto.
- **Governança:** orçamentos, gatilhos de escalação, cadeias de aprovação e um `culture.md`.

Um funcionário não faz tudo à mão. Antes de produzir qualquer entregável atômico ele mesmo, ele pergunta "existe um squad para isto?", chama um ou mais squads (governados por uma whitelist `squads_authorized`; vazia significa todos permitidos), e integra o resultado de volta. O trabalho circula entre funcionários por cinco primitivas de handoff: menção (`@name`), ticket, escalação (para cima), delegação (para baixo) e roteamento automático.

Uma regra estrutural tem dentes: uma empresa com mais de 5 funcionários precisa de um antagonista, uma cadeira cujo trabalho é contestar.

### Como um mind-clone é formado (5 camadas de DNA)

Um mind-clone é o método destilado de um expert real, extraído da sua obra pública em 5 camadas:

1. **L1 Filosofias:** crenças e axiomas.
2. **L2 Modelos mentais:** como o expert estrutura problemas.
3. **L3 Heurísticas:** regras táticas rápidas.
4. **L4 Frameworks:** sistemas nomeados.
5. **L5 Metodologias:** processos passo a passo.

Cada item carrega uma citação `^[FONTE:file:section:excerpt]` de volta ao material de origem, e cada build reporta sua cobertura de fontes (94%, por exemplo). O pacote é concreto: `MANIFEST.yaml`, mais `agent/AGENT.md` (uma emulação cognitiva em primeira pessoa), `agent/SOUL.md` (valores, medos, contradições, influências), `agent/DNA-CONFIG.yaml` e `dna/dna-schema.md` (as 5 camadas com suas fontes).

Em runtime, o DNA é injetado inteiro no prompt de um funcionário, com uma instrução permanente: o clone está totalmente incorporado, então entregue como se o clone tivesse produzido o trabalho. A injeção nunca é silenciosa. Ela emite um evento de audit `mind_clone_injected` registrando bytes e sha256 de cada arquivo injetado, para que você possa provar qual mente estava na sala. O catálogo tem 503 clones, incluindo David Ogilvy, Alex Hormozi, Seth Godin e Dan Kennedy.

## Você pode fazer mais de tudo: as meta-ferramentas

O engine vem com três fábricas, e elas chamam umas às outras. É assim que uma empresa que você pediu em uma frase acaba completa.

- **Business Creator** transforma um briefing em prosa em uma organização completa: funcionários, memória, workflows, validados de ponta a ponta. Quando precisa de uma capability que nenhum squad cobre, ele delega ao Squad Creator.
- **Squad Creator** transforma um briefing em prosa em um squad validado: agents, tasks, workflows, schemas, config de harness, README.
- **Genius Factory** transforma a obra pública de uma pessoa em um mind-clone de 5 camadas, e então te entrega um conselheiro pronto para contratar.

Meta-ferramentas chamando meta-ferramentas é por que "desenhe a agência, clone os especialistas, construa" funciona como três frases simples.

## Como funciona

Dê um briefing ao harness e ele faz cinco coisas, em ordem:

1. Lê o briefing.
2. Consulta os três registries: empresas, squads, mind-clones.
3. Despacha a melhor combinação, que pode ser muitas empresas e/ou squads em paralelo.
4. Reconcilia os resultados atrás de um portão de qualidade.
5. Escreve uma trilha de auditoria em `~/.harness-logs/<date>/audit.jsonl`.

```
                      briefing
                         │
                         ▼
                ┌───────────────────┐
                │ harness (maestro) │
                │ ler · rotear ·    │
                │ despachar         │
                └───────────────────┘
                         │
        consulta os três registries
       (empresas · squads · mind-clones)
                         │
        ┌────────────────┼────────────────┐
        ▼                ▼                 ▼
 ┌────────────┐   ┌────────────┐    ┌──────────────┐
 │  empresa A │   │  squad X   │    │  mind-clones │
 │funcionários│   │  workflow  │◀───│injetados como│
 │  → squads  │   │  DAG·gates │    │DNA de persona│
 └────────────┘   └────────────┘    └──────────────┘
        │                │
        └───── despacho paralelo ──────┘
                         │
                         ▼
                ┌───────────────────┐
                │portão de qualidade│
                │ reconcilia saída  │
                └───────────────────┘
                         │
            ┌────────────┴────────────┐
            ▼                         ▼
       resultado final     ~/.harness-logs/<date>/audit.jsonl
                            (cada despacho, registrado)
```

O paralelismo é a alavanca: um briefing pode pôr vários times para trabalhar na mesma execução e reunir o output deles no fim. A trilha de auditoria é a confiança: abra o log e rastreie quais agents rodaram, em qual briefing, em que ordem e por quê. Trabalho agêntico deixa de ser uma caixa-preta.

Um diagrama é uma afirmação. Três garantias a sustentam.

## Os três selos: rastreável, testado, contratado

Sistemas multi-agente têm um problema de confiança. Um orquestrador pode anunciar qualquer coisa na mensagem final. O Nirvana-OS responde com três garantias, cada uma sustentada por um mecanismo que você pode abrir no disco.

**Rastreável.** Cada ação vira um evento append-only em `audit.jsonl`: `brief_received`, `dispatch_business`, `dispatch_squad`, `mind_clone_injected`, `gate_passed` ou `gate_failed`, `verify_passed` ou `verify_failed`. O log vive em `~/.harness-logs/<date>/audit.jsonl` e é visível no `nrv glance`. A regra é seca: sem esses eventos, nenhuma mensagem de conclusão é honesta. A interface é prosa mais um comprovante.

**Testado.** Dois programas ficam entre uma afirmação e um entregável. `verify-deliverable.ts` compara a verdade do disco: o que o briefing prometeu contra o que de fato existe no disco, sinalizando qualquer coisa faltante ou de fachada. `quality-gate.ts` roda rubrics por tipo de arquivo, num loop de julgar, criticar e revisar. Sem um PASS do verify não existe `gate_passed` legítimo. Squads também carregam um contrato de fidelidade com ground truth, e funcionários se autoavaliam antes de cada handoff.

**Contratado.** Nada anda no feeling. Tasks têm critérios de aceitação binários. Capabilities têm inputs e outputs tipados; o id é o contrato e a implementação fica escondida. Handoffs são artefatos estruturados de no máximo 800 tokens. Output destinado ao cliente passa por uma cadeia de aprovação: produtor, depois revisor, depois aprovador. Orçamentos são um teto rígido, e gatilhos de escalação definem exatamente quando um humano precisa entrar no loop.

Rastreável te diz o que aconteceu. Testado te diz que é real. Contratado te diz que foi permitido. Juntos, são a razão de "o trabalho está feito" significar algo aqui.

## Open core: o engine é grátis, e continua grátis

O engine neste repositório é grátis, sem tier capado e nada básico trancado. Ele cria e orquestra empresas, squads e mind-clones do zero. Se você quer construir seu próprio conglomerado a partir do nada, o engine é tudo o que você vai precisar e você não deve nada.

Isso é deliberado. O engine é a capacidade inteira, e dar a capacidade inteira é como a confiança se constrói: você pode verificar tudo nesta página antes de gastar qualquer coisa.

Grátis convida a uma pergunta justa: é open-source? Sejamos precisos aqui. O código-fonte é publicado e abertamente legível, mas a licença é source-available, não open-source aprovada pela OSI, e certos usos comerciais exigem uma licença comercial separada. A [seção de licença](#licença-autoria-e-status) detalha isso.

A camada paga é **conteúdo, não capacidade**: coleções curadas e prontas para rodar de squads, empresas e mind-clones, entregues via [squads.sh](https://squads.sh).

| | Engine grátis (este repo) | Packs pagos (squads.sh) |
|---|---|---|
| Criar do zero | Sim | Sim |
| Orquestrar em paralelo | Sim | Sim |
| Trilha de auditoria em cada despacho | Sim | Sim |
| Instalação multi-runtime | Sim | Sim |
| Squads, empresas e mind-clones pré-construídos | Nenhum, vazio por design | Um conglomerado completo, pronto para rodar |
| Tempo até um conglomerado funcional | Você constrói | Dia um |

A diferença que os packs compram para você é **tempo, não poder**. O carro-chefe, o **Genesis Circle**, entrega 39 squads de produção, 11 empresas e 159 mind-clones em uma única instalação. Os packs se instalam por cima do engine e ficam atualizados com `nrv update <pack>`. [Veja os packs no squads.sh](https://squads.sh).

## Os comandos `nrv`: seu agente roda a maioria deles

A CLI existe para que as próprias skills e hooks do sistema possam dirigir o engine, e para que seu agente aja em seu nome. No uso diário, você fala e seu agente digita. O punhado genuinamente humano:

| Você digita | O que faz |
|---|---|
| `npx @nirvana-os/cli` | Instala ou atualiza o engine (idempotente) |
| `nrv glance` | Cockpit web read-only: empresas, squads, clones, auditoria, custos |
| `nrv init <dir>` | Escreve o contrato `AGENTS.md` num diretório de projeto |
| `nrv list-businesses` / `nrv list-squads` / `nrv list-clones` | Navega pelos três registries (read-only) |
| `nrv search "<topic>"` | Busca capabilities pelos três registries |
| `nrv update <pack>` | Atualiza um pack instalado |
| `nrv doctor` | Verifica a instalação |

Todo o resto é rodado pelo agente ou é avançado. `Skill("harness", …)` é a entrada in-process que seu agente usa. `nrv dispatch`, `nrv run` e `nrv auto` dirigem a orquestração pelo shell. `nrv ask <clone>` conversa com um único mind-clone com o DNA dele injetado; `nrv revise` aplica uma mudança a um projeto na mesma sessão de runtime; `nrv audit-view` percorre a cadeia de auditoria de um projeto; `nrv export` empacota o output de um projeto (Python 3.10+ necessário só para `--pdf` e `--zip`).

Dois comandos merecem um aviso de rebaixamento. `nrv route` e `nrv find` são diagnósticos BM25 com perda: bons para uma farejada rápida de palavra-chave, nunca uma fonte de verdade. O maestro agêntico é a fonte de verdade.

Referência completa: [docs/CLI.md](./docs/CLI.md).

## FAQ

**Preciso saber programar?** Não. Você descreve resultados em linguagem simples. O sistema escreve, valida e roda o código.

**Preciso aprender a CLI?** Não. Seu agente roda a maioria dos comandos `nrv` por você. O punhado humano é instalar, `nrv glance`, `nrv init`, o trio `list-*`, `nrv search`, `nrv update` e `nrv doctor`.

**E se o sistema não conseguir fazer o que eu pedir?** Ele diz. Quando um briefing não casa com nada nos seus registries, o maestro recusa e sugere criar a capability faltante. Quando é ambíguo, ele pergunta, com os principais candidatos e suas descrições.

**Ele substitui meu agente?** Não. Ele roda por cima do Claude Code, Codex, Gemini-CLI ou Antigravity, e faz o que você tem orquestrar muitos.

**Onde meu trabalho fica?** Na sua máquina, sob `~/businesses`, `~/squads` e `~/businesses/_library/dna`. Local-first, sem nuvem de terceiros no meio.

**O engine é mesmo grátis?** Sim. Os packs pagos são conteúdo pré-construído que economiza seu tempo. O engine constrói as mesmas coisas do zero sem custo.

**Windows?** Nativo, via Bun. Sem WSL.

## Licença, autoria e status

Autor: **Luiz Gustavo Vieira Rodrigues (gutomec / Prospecteezy)**. Sem coautores.

Licença: a Nirvana-OS Sustainable Use License (SUL) v1.0. Termos claros, porque é aqui que a confiança se ganha ou se perde: o código-fonte é publicado e abertamente legível, e o engine é grátis para usar. É **source-available, não uma licença open-source aprovada pela OSI**, e certos usos comerciais exigem uma licença comercial separada. Se essa distinção importa para o seu caso, leia [LICENSE](./LICENSE) antes de confiar em qualquer resumo, incluindo este.

Status: beta (0.x, atualmente 0.1.54). O engine funciona hoje e instala em minutos. Espere a superfície continuar mudando até o 1.0.
