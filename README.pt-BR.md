# Nirvana-OS engine

[![version](https://img.shields.io/badge/version-0.1.24--beta-blue)](#licença-autoria-e-status)
[![license](https://img.shields.io/badge/license-SUL-lightgrey)](./LICENSE)
[![npm](https://img.shields.io/badge/npm-%40nirvana--os%2Fcli-cb3837)](https://www.npmjs.com/package/@nirvana-os/cli)

**Leia isto no seu idioma:** [English](./README.md) · [Português](./README.pt-BR.md) · [Español](./README.es.md) · [中文](./README.zh.md) · [हिन्दी](./README.hi.md) · [العربية](./README.ar.md)

---

## Comande um universo de empresas em linguagem comum

Você já tem um agente no terminal. Claude Code, Codex, Gemini-CLI ou Antigravity. Ele é afiado, e está sozinho.

O Nirvana-OS transforma esse agente único em um maestro que opera **empresas inteiras**. Você descreve o que quer em prosa simples, e o sistema levanta as organizações, os times de especialistas e as mentes expertas para entregar, muitos deles ao mesmo tempo, com um comprovante para cada passo.

```bash
npx @nirvana-os/cli
```

Um comando. Ele instala o engine, se conecta a cada runtime de agente que encontra, e pode ser rodado de novo a qualquer momento com segurança. Nada mais para configurar.

## Você não precisa de mais um chatbot. Você precisa de uma organização que faça o trabalho.

Um agente sozinho responde a um prompt. Trabalho de verdade não é um prompt só. É um pesquisador, um redator, um revisor e um operador puxando em direções diferentes, coordenados, com registro do que foi feito. Hoje a cola é você: roda prompt atrás de prompt na mão e costura as partes você mesmo, sem registro de quem fez o quê.

O Nirvana-OS tira você da cola. Você declara o resultado em prosa. O engine lê, consulta o que você tem, despacha a combinação certa de empresas e squads, roda tudo em paralelo, reconcilia o resultado atrás de um portão de qualidade e anota cada despacho. Você sai de operador para diretor: declara a meta e inspeciona o resultado.

## O que é, em uma frase

O Nirvana-OS é a camada de orquestração **acima** dos agentes de terminal. Ele cria e roda três tipos de coisa, e faz tudo isso a partir de linguagem natural:

- **Empresas (businesses)** — organizações autônomas com um organograma de funcionários. Cada funcionário chama squads.
- **Squads** — times portáteis de agentes que rodam workflows reais (DAG, gates, escalação) e entregam resultados acabados.
- **Mind-clones** — DNA de persona (5 camadas) injetado nos funcionários para que pensem e falem com o método de um mestre.

Um único pedido pode mobilizar muitos deles ao mesmo tempo. O orquestrador (o `harness`) escolhe o elenco. Você só descreve o resultado.

## Veja funcionar: tudo é uma frase

Esta é a parte que importa. Você não escreve código, não preenche formulários, não edita config. Você conversa com o sistema, dentro do runtime de IA que já usa, chamando-o pelo nome: **"use o Nirvana-OS para…"**. É assim que fica.

### 1. Construa uma empresa descrevendo-a

Dê a hierarquia e os papéis em prosa. Ele desenha a organização, escreve cada funcionário, conecta os workflows e valida o resultado.

```text
Use o Nirvana-OS para criar uma empresa chamada podcast-empire que produz, publica
e monetiza 3 podcasts ao mesmo tempo. Cada programa tem seu próprio nicho, um host
de IA, um calendário editorial e um funil de monetização independente. Cerca de 7
funcionários.
```

O sistema roda sua fábrica de empresas: leitura de intenção, pesquisa de domínio, um blueprint do organograma que você aprova, depois funcionários, memória e workflows, validados contra o Business Protocol. Você termina com `~/businesses/podcast-empire/`, com a equipe montada e pronto para rodar.

### 2. Ou deixe o sistema desenhar a empresa para você

Ainda não sabe a estrutura certa? Pergunte. É por este fluxo que a maioria se apaixona.

**Passo um, peça o desenho:**

```text
Use o Nirvana-OS: como seria estruturada uma agência de marketing completa e
moderna? Me dê a hierarquia, os papéis-chave e quem são os melhores especialistas
do mundo para cada cadeira.
```

O sistema responde com um organograma de verdade: um diretor de criação, um head de performance, um chefe de copy, um líder de conteúdo, um estrategista, e os nomes dos operadores cujos métodos cada cadeira deve incorporar.

**Passo dois, clone esses especialistas:**

```text
Ótimo. Clone esses especialistas em mind-clones que eu possa contratar.
```

Ele roda a fábrica de mind-clones e produz o DNA de persona de cada um, o pensamento, as heurísticas e a voz daquele tipo de operador.

**Passo três, monte a empresa com eles nas cadeiras:**

```text
Agora monte a agência e coloque esses clones nos papéis correspondentes como o
cérebro de cada funcionário.
```

Ele monta a empresa, atribui cada mind-clone ao funcionário certo e cria qualquer squad de especialista que a agência precise mas ainda não tenha. Você fez três perguntas em português simples e recebeu uma empresa com equipe montada.

### 3. Crie um squad de especialistas em prosa

Quando uma empresa precisa de uma capacidade que nenhum time existente cobre, descreva o time que você quer.

```text
Use o Nirvana-OS para gerar um squad de automação de e-commerce headless, com
agentes para catálogo, checkout, estoque e suporte. Valide-o contra o Squad
Protocol.
```

Sai `~/squads/…/` com agentes, tasks, workflows, schemas, uma config de harness e um README, tudo validado.

### 4. Clone um expert em prosa

Transforme a obra pública de qualquer pessoa em um conselheiro que seus funcionários podem usar.

```text
Use o Nirvana-OS para transformar a obra pública de <autor> em um mind-clone de IA
completo através da genius factory.
```

A fábrica extrai um DNA de 5 camadas (filosofias, modelos mentais, heurísticas, frameworks, metodologias), constrói a persona, passa-a por um painel de outras mentes e entrega um conselheiro que você pode encaixar em qualquer empresa.

### 5. Uma frase, vários times de uma vez

O orquestrador adora mobilizar várias empresas e squads a partir de um único briefing.

```text
Use o Nirvana-OS para produzir um pacote de lançamento: pesquisa de mercado, copy
de landing page e um teardown competitivo.
```

Essa única linha pode puxar um squad de pesquisa, um squad de copy e uma empresa de design em paralelo, cada um com funcionários carregando os mind-clones certos, reconciliados atrás de um único portão de qualidade. Você também pode forçar uma trilha pela CLI: `nrv use-businesses "…"` ou `nrv use-squads "…"`.

> A interface inteira é prosa mais um comprovante. Nenhuma chamada de API, nenhum arquivo de config. Apenas descreva o resultado e leia a trilha de auditoria que prova o que aconteceu.

## Instale em 60 segundos

A mesma ideia em todo sistema operacional: instale o Bun uma vez, depois rode um comando. Você também precisa do Node.js para o `npx` (a maioria das máquinas já tem; se não, [nodejs.org](https://nodejs.org)).

### macOS / Linux

```bash
curl -fsSL https://bun.sh/install | bash
exec $SHELL                # recarrega o PATH, ou apenas abra um novo terminal
npx @nirvana-os/cli        # instala o engine
```

### Windows (nativo, sem WSL)

O sistema inteiro roda em Bun, então o Windows precisa só do Bun. No **PowerShell**:

```powershell
powershell -c "irm bun.sh/install.ps1 | iex"
# abra uma NOVA janela do PowerShell para o PATH atualizar
npx @nirvana-os/cli
```

O instalador coloca o comando `nrv` em `~/.local/bin` (`%USERPROFILE%\.local\bin` no Windows) e o adiciona ao seu PATH automaticamente. Abra um novo terminal e confirme:

```bash
nrv --help
```

Rodar `npx @nirvana-os/cli` de novo é idempotente e sempre baixa o engine mais recente.

## Dê uma olhada com o `nrv`

Os comandos de descoberta são somente leitura e seguros a qualquer momento.

```bash
nrv glance            # visão geral em uma tela do que você tem
nrv list-businesses   # organizações registradas localmente
nrv list-squads       # os times de agentes
nrv list-clones       # DNA de persona disponível para injetar
nrv search "launch"   # encontra capacidades nos três registries
```

Um engine recém-instalado retorna vazio aqui, e esse é o ponto. A fábrica está instalada; a carga, não.

## Os três pilares

Tudo o que o engine cria e orquestra é uma de três coisas. Este é o modelo mental inteiro.

| Pilar | O que é | Onde mora |
|---|---|---|
| **Empresas** | Organizações autônomas, cada uma com um organograma de funcionários | `~/businesses/` |
| **Squads** | Times portáteis de agentes que rodam workflows (DAG, gates, escalação) | `~/squads/` |
| **Mind-clones** | DNA de persona injetado nos funcionários para voz e julgamento | `~/businesses/_library/dna/` |

Uma empresa orquestra funcionários. Um funcionário chama squads. Um squad roda agentes. Um mind-clone dá a qualquer um deles uma voz mais verdadeira. Um único briefing raramente precisa de só um.

## Você pode fazer mais de tudo: as meta-ferramentas

O engine vem com três fábricas, e elas chamam umas às outras. É assim que uma empresa que você pediu em uma frase acaba completa.

- **Business Creator** transforma um briefing em prosa em uma organização inteira: funcionários, memória, workflows, validados de ponta a ponta. Quando precisa de uma capacidade que nenhum squad cobre, delega ao Squad Creator.
- **Squad Creator** transforma um briefing em prosa em um squad validado: agentes, tasks, workflows, schemas, config de harness, README.
- **Genius Factory** transforma a obra pública de uma pessoa em um mind-clone através de um pipeline de 5 estágios, depois entrega um conselheiro pronto para contratar.

Meta-ferramentas chamando meta-ferramentas é o motivo de "desenhe a agência, clone os especialistas, monte" funcionar como três frases simples.

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
                │ lê · roteia ·     │
                │ despacha          │
                └───────────────────┘
                         │
        consulta os três registries
       (empresas · squads · mind-clones)
                         │
        ┌────────────────┼────────────────┐
        ▼                ▼                 ▼
 ┌────────────┐   ┌────────────┐    ┌──────────────┐
 │  empresa A │   │  squad X   │    │  mind-clones │
 │ funcionár. │   │  workflow  │◀───│ injetados as │
 │  → squads  │   │  DAG·gates │    │  persona DNA │
 └────────────┘   └────────────┘    └──────────────┘
        │                │
        └──── despacho em paralelo ────┘
                         │
                         ▼
                ┌───────────────────┐
                │ portão de qualid. │
                │ reconcilia output │
                └───────────────────┘
                         │
            ┌────────────┴────────────┐
            ▼                         ▼
     resultado final      ~/.harness-logs/<date>/audit.jsonl
                          (cada despacho, registrado)
```

O paralelismo é a alavanca: um briefing pode colocar vários times para trabalhar na mesma rodada e reunir o resultado deles no fim. A trilha de auditoria é a confiança: abra o log e rastreie quais agentes rodaram, em qual briefing, em que ordem e por quê. O trabalho agêntico deixa de ser uma caixa-preta.

## Uma instalação, todo runtime

Há uma única árvore de skills em `~/.nirvana/skills`, conectada a cada runtime que o instalador detecta. O Nirvana-OS não pede que você troque de agente. Ele aprimora o que você já tem.

| Runtime | Status |
|---|---|
| Claude Code | Sempre conectado |
| Codex | Conectado se presente |
| Gemini-CLI | Conectado se presente |
| Antigravity (`agy`) | Conectado se presente |
| Hermes | Ponte opcional (opt-in) |

## Open core: o engine é grátis, e continua grátis

O engine neste repositório é grátis, sem tier capado e nada básico trancado. Ele cria e orquestra empresas, squads e mind-clones do zero. Se você quer construir seu próprio conglomerado a partir do nada, o engine é tudo o que você vai precisar e você não deve nada.

A camada paga é **conteúdo, não capacidade**: coleções curadas e prontas para rodar de squads, empresas e mind-clones, entregues pelo [squads.sh](https://squads.sh).

| | Engine grátis (este repo) | Packs pagos (squads.sh) |
|---|---|---|
| Criar do zero | Sim | Sim |
| Orquestrar em paralelo | Sim | Sim |
| Trilha de auditoria em cada despacho | Sim | Sim |
| Instalação multi-runtime | Sim | Sim |
| Squads, empresas, mind-clones pré-construídos | Nenhum, vazio por design | Um conglomerado inteiro, pronto para rodar |
| Tempo até um conglomerado funcionando | Você constrói | No primeiro dia |

A diferença que os packs compram para você é **tempo, não poder**. O carro-chefe, o **Genesis Circle**, entrega 39 squads de produção, 11 empresas e 159 mind-clones em uma instalação. Um pack se sobrepõe ao engine: compre, rode `bun setup.ts`, mantenha-o atualizado com `nrv update <slug>`. [Veja os packs no squads.sh](https://squads.sh).

## Comandos `nrv`

| Comando | O que faz |
|---|---|
| `nrv route "<brief>"` | Entrega um briefing em prosa ao maestro |
| `nrv use-businesses "<brief>"` | Roteia um briefing, empresa primeiro |
| `nrv use-squads "<brief>"` | Roteia um briefing, squad primeiro |
| `nrv glance` | Visão geral do seu setup em uma tela |
| `nrv list-businesses` / `list-squads` / `list-clones` | Navega pelos registries (somente leitura) |
| `nrv search "<topic>"` | Busca capacidades nos três registries |
| `nrv init <path>` | Inicializa um novo projeto |
| `nrv update <slug>` | Atualiza um pack instalado |
| `nrv --help` | Referência completa de comandos |

Referência completa: [docs/CLI.md](./docs/CLI.md).

## FAQ

**Preciso saber programar?** Não. Você descreve resultados em linguagem comum. O sistema escreve, valida e roda o código.

**Ele substitui meu agente?** Não. Ele roda em cima do Claude Code, Codex, Gemini-CLI ou Antigravity, e faz o que você já tem orquestrar muitos.

**Onde meu trabalho fica?** Na sua máquina, em `~/businesses`, `~/squads` e `~/businesses/_library/dna`. Local-first, sem nenhuma nuvem de terceiros no circuito.

**O engine é mesmo grátis?** Sim. Os packs pagos são conteúdo pré-construído que economiza seu tempo. O engine constrói as mesmas coisas do zero sem custo.

**Windows?** Nativo, via Bun. Sem WSL.

## Licença, autoria e status

Autor: **Luiz Gustavo Vieira Rodrigues (Prospecteezy)**. Sem coautores.

Licença: a Nirvana-OS Sustainable Use License (SUL). O código-fonte é publicado abertamente e source-available. Não é uma licença open-source aprovada pela OSI, e certos usos comerciais exigem uma licença comercial separada. Leia os termos completos em [LICENSE](./LICENSE) antes de confiar em qualquer resumo.

Status: beta (0.x). O engine funciona hoje e instala em minutos. Espere a superfície continuar mudando até o 1.0.
