<div align="center">

<img src="./docs/assets/banner-week1.png" alt="Nirvana-OS: uma frase entra, trabalho pronto sai. Workflows de agentes em paralelo convergem por portões de qualidade." width="100%">

# Nirvana-OS

**Operações agênticas prontas para rodar.** Uma frase entra. Trabalho pronto sai.

[![npm downloads](https://img.shields.io/npm/dm/@nirvana-os/cli)](https://www.npmjs.com/package/@nirvana-os/cli)
[![GitHub stars](https://img.shields.io/github/stars/gutomec/nirvana-os-engine)](https://github.com/gutomec/nirvana-os-engine/stargazers)
[![version](https://img.shields.io/github/v/release/gutomec/nirvana-os-engine?label=version)](./CHANGELOG.md)
[![CI](https://github.com/gutomec/nirvana-os-engine/actions/workflows/smoke.yml/badge.svg)](https://github.com/gutomec/nirvana-os-engine/actions/workflows/smoke.yml)
[![license](https://img.shields.io/badge/license-SUL-lightgrey)](./LICENSE)
[![npm](https://img.shields.io/npm/v/@nirvana-os/cli?label=npm)](https://www.npmjs.com/package/@nirvana-os/cli)

```bash
npx @nirvana-os/cli
```

Um comando instala o engine e o conecta a cada agente de terminal que encontra. Seguro para rodar de novo a qualquer momento.

[Documentação](https://gutomec.github.io/nirvana-os-engine/) · [Packs](https://squads.sh/pt/packs) · [Instalação ilustrada](https://gutomec.github.io/nirvana-os-engine/install.html) · [Changelog](./CHANGELOG.md)

**Leia isto no seu idioma:** [English](./README.md) · [Português](./README.pt-BR.md) · [Español](./README.es.md) · [中文](./README.zh.md) · [हिन्दी](./README.hi.md) · [العربية](./README.ar.md)

</div>

---

## Seu agente é afiado. E está sozinho.

Você já roda um agente de terminal: Claude Code, Codex, Gemini-CLI ou Antigravity. Um prompt rende uma boa resposta. Trabalho de verdade não é um prompt. É um pesquisador, um redator, um revisor e um operador puxando na mesma direção, em paralelo, com registro de cada passo. Hoje, a cola é você.

O Nirvana-OS promove esse agente solitário a um maestro que conduz organizações inteiras. Você descreve o resultado em prosa simples. O engine lê o briefing, consulta o que você tem, despacha empresas, squads e mind-clones em paralelo, reconcilia tudo atrás de um portão de qualidade e escreve uma trilha de auditoria de cada despacho. Você deixa de ser o operador e vira o diretor.

A interface inteira é prosa mais um comprovante. Você fala. Seu agente roda os comandos.

## O que é

O Nirvana-OS é um sistema operacional multi-agente nativo em Bun e agnóstico de runtime. Ele cria, gerencia e administra um conglomerado: qualquer número de empresas e squads, orquestrado do briefing ao entregável verificado. É a camada de orquestração acima do seu agente de terminal, não um substituto dele.

O padrão é **zero-humano**: as empresas rodam de forma autônoma, e a participação humana é opt-in, por gatilhos explícitos no manifesto. Você declara o resultado. O engine escolhe o elenco.

Tudo o que ele cria é uma de três coisas:

| Pilar | O que é | Onde vive |
|---|---|---|
| **Empresas (businesses)** | Organizações autônomas com um organograma de funcionários persistentes que chamam squads | `~/businesses/` |
| **Squads** | Times de agentes portáteis que rodam workflows reais: DAG, portões de qualidade, escalação | `~/squads/` |
| **Mind-clones** | DNA de persona em 5 camadas, injetado nos funcionários para que pensem e falem com o método de um mestre | `~/businesses/_library/dna/` |

Uma empresa orquestra funcionários. Um funcionário chama squads. Um squad roda agents. Um mind-clone dá a qualquer um deles uma voz mais verdadeira. Um único briefing pode mobilizar muitos deles de uma vez.

## Início rápido

O que você precisa: [Bun](https://bun.sh) 1.0 ou mais novo. Node 18+ e `tar` existem só para o `npx` funcionar, e a maioria das máquinas já os tem.

```bash
# macOS / Linux
curl -fsSL https://bun.sh/install | bash
exec $SHELL
npx @nirvana-os/cli

# Windows (nativo, sem WSL), no PowerShell
powershell -c "irm bun.sh/install.ps1 | iex"
# abra uma NOVA janela do PowerShell para o PATH atualizar
npx @nirvana-os/cli
```

O instalador coloca uma única árvore de skills em `~/.nirvana/skills`, conecta-a a `~/.claude`, `~/.codex`, `~/.gemini` e `~/.antigravity` onde quer que os encontre, e põe os binários `nrv` no seu PATH. Ele instala o engine e nenhum conteúdo: seus registries começam vazios por design, então tudo neles é algo que você construiu ou escolheu instalar. Rodar o instalador de novo é idempotente e sempre baixa o engine mais recente.

Confirme que a instalação está saudável:

```bash
nrv doctor
```

No Windows, o `nrv doctor` também verifica no PATH do usuário as entradas temporárias `nrv-*` que engines até a 0.8.0 podiam deixar para trás. `nrv install --repair-path` lista essas entradas sem escrever nada; `--apply` remove exatamente essas e mantém todas as outras como estão.

Depois abra seu agente e diga **"use o Nirvana-OS para…"**. Para uma configuração conduzida pelo agente, aponte seu runtime para [`AGENT-QUICKSTART.md`](./AGENT-QUICKSTART.md).

## Demo de 90 segundos

> **Espaço reservado.** O passo a passo canônico de 90 segundos entra aqui assim que for publicado. Até lá, esta é a visão ao vivo de uma ordem em prosa montando um conglomerado.

<div align="center">
  <img src="./docs/assets/nirvana-promo-en-readme.gif" alt="Uma ordem em prosa entra, e um conglomerado de IA inteiro se monta e entrega" width="100%">
</div>

<!-- DEMO-90s SLOT
     Canonical 90-second demo goes here when published (trace 75fbfbcc, phase X3).
     Replace the block above with:
     <a href="VIDEO_URL"><img src="THUMBNAIL_URL" alt="Nirvana-OS em 90 segundos" width="100%"></a>
-->

## Veja funcionar: tudo é uma frase

**Construa uma empresa descrevendo-a.** O sistema desenha a organização, escreve cada funcionário, conecta os workflows e valida o resultado contra o Business Protocol.

```text
Use Nirvana-OS to create a company called podcast-empire that produces, publishes,
and monetizes 3 podcasts at once. Each show has its own niche, an AI host, an
editorial calendar, and an independent monetization funnel. Around 7 employees.
```

**Clone um expert em prosa.** A fábrica de gênios extrai um DNA de 5 camadas (filosofias, modelos mentais, heurísticas, frameworks, metodologias) da obra pública de uma pessoa, cada item citado de volta à sua fonte.

```text
Use Nirvana-OS to turn the public work of <author> into a complete AI mind-clone
through the genius factory.
```

**Uma frase, muitos times de uma vez.** Um único briefing pode puxar um squad de pesquisa, um squad de copy e uma empresa de design em paralelo, reconciliados atrás de um único portão de qualidade, com a trilha de auditoria mostrando cada escolha que o maestro fez.

```text
Use Nirvana-OS to produce a launch package: market research, landing-page copy,
and a competitive teardown.
```

Mais fluxos, incluindo "desenhe a agência, clone os especialistas, construa" em três perguntas, estão na [home da documentação](https://gutomec.github.io/nirvana-os-engine/), que roda a mesma frase nos sete runtimes suportados: Claude Code, Codex, Gemini, Antigravity, Grok, Kimi e Hermes.

## Por que "o trabalho está feito" significa algo aqui

Sistemas multi-agente têm um problema de confiança: um orquestrador pode anunciar qualquer coisa na mensagem final. O Nirvana-OS responde com três garantias, cada uma sustentada por um mecanismo que você pode abrir no disco.

- **Rastreável.** Cada ação vira um evento append-only em `~/.harness-logs/<date>/audit.jsonl`: briefing recebido, despacho, mind-clone injetado, portão aprovado ou reprovado. Cada execução com `--exec`, em modo `standard` ou pelo Gauntlet, também deixa um Run canônico no `.nirvana/run-kernel.sqlite` do projeto, um journal append-only que o Glance lê. Sem esses eventos, nenhuma mensagem de conclusão é honesta.
- **Testado.** `verify-deliverable.ts` compara o que o briefing prometeu com o que de fato existe no disco. `quality-gate.ts` roda rubrics por tipo de arquivo num loop de julgar, criticar e revisar. Sem um PASS do verify, não há conclusão legítima.
- **Contratado.** Tasks têm critérios de aceitação binários. Capabilities têm inputs e outputs tipados. Output destinado ao cliente passa por uma cadeia de aprovação: produtor, depois revisor, depois aprovador. Orçamentos são um teto rígido, e gatilhos de escalação definem exatamente quando um humano entra no loop.

## Engine grátis, conteúdo pago

O engine neste repositório é grátis, sem tier capado e nada básico trancado. Ele cria e orquestra empresas, squads e mind-clones do zero. O código-fonte é publicado e abertamente legível sob a [Sustainable Use License](./LICENSE) (source-available, não aprovada pela OSI; certos usos comerciais exigem uma licença separada).

A camada paga é **conteúdo, não capacidade**: coleções curadas e prontas para rodar, entregues via [squads.sh](https://squads.sh). A diferença que os packs compram para você é tempo, não poder. Veja todos em **[squads.sh/pt/packs](https://squads.sh/pt/packs)**. O carro-chefe, o **[Genesis Circle](https://squads.sh/pt/nirvana-os)**, entrega um conglomerado completo que você pode rodar no primeiro dia, mantido atualizado com `nrv update <pack>`.

| | Engine grátis (este repo) | Packs ([squads.sh/pt/packs](https://squads.sh/pt/packs)) |
|---|---|---|
| Criar do zero | Sim | Sim |
| Orquestrar em paralelo | Sim | Sim |
| Trilha de auditoria em cada despacho | Sim | Sim |
| Squads, empresas e mind-clones pré-construídos | Nenhum, vazio por design | Um conglomerado completo, no primeiro dia |

## O punhado de comandos que vale digitar você mesmo

| Você digita | O que faz |
|---|---|
| `npx @nirvana-os/cli` | Instala ou atualiza o engine (idempotente) |
| `nrv glance` | Cockpit web: empresas, squads, clones, auditoria, custos. Num projeto adotado, uma Message no chat roda um despacho de verdade em processo filho, com timeline ao vivo, cancelamento e recuperação após restart. `--read-only` mantém só a leitura |
| `nrv list-businesses` / `nrv list-squads` / `nrv list-clones` | Navega pelos três registries |
| `nrv search "<topic>"` | Busca capabilities pelos três registries |
| `nrv dispatch --business <slug> \| --squad <slug> \| --agent-x "<brief>" --exec` | Roda um briefing contra um alvo que você nomeia; o roteador nunca é consultado |
| `nrv run <business> "<brief>" --execution-mode=gauntlet --gauntlet-intensity=light\|balanced\|exhaustive` | Opta pelo Gauntlet: candidates, avaliações e rodadas de revisão em três intensidades (alvos Business exigem `NIRVANA_BUSINESS_GAUNTLET_ALLOWLIST`) |
| `nrv multi-target plan\|run\|status <plan.json>` | Compila, executa ou inspeciona um plano multi-target sobre o Run Kernel (`run` exige `NIRVANA_MULTI_TARGET_ENGINE=1`) |
| `nrv update <pack>` | Atualiza um pack instalado |
| `nrv doctor` | Verifica a instalação; no Windows, `nrv install --repair-path` limpa as entradas do PATH do usuário sobre as quais ele avisa |

Todo o resto, seu agente roda. Referência completa: [docs/CLI.md](./docs/CLI.md).

## FAQ

**Preciso saber programar?** Não. Você descreve resultados em linguagem simples; o sistema escreve, valida e roda o código.

**Ele substitui meu agente?** Não. Ele roda por cima do Claude Code, Codex, Gemini-CLI ou Antigravity, e faz o que você já tem orquestrar muitos.

**Onde meu trabalho fica?** Na sua máquina, sob `~/businesses`, `~/squads` e `~/businesses/_library/dna`. Local-first, sem nuvem de terceiros no meio.

**E se o sistema não conseguir fazer o que eu pedir?** Ele diz. Um briefing que não casa com nada recebe uma recusa mais uma sugestão de criar a capability faltante. Um briefing ambíguo recebe uma pergunta de volta, com os principais candidatos.

**Windows?** Nativo, via Bun. Sem WSL.

## Licença, autoria e status

Autor: **Luiz Gustavo Vieira Rodrigues (gutomec / Prospecteezy)**. Sem coautores.

Licença: a Nirvana-OS Sustainable Use License (SUL) v1.0. O código-fonte é publicado e abertamente legível, e o engine é grátis para usar. É source-available, não uma licença open-source aprovada pela OSI, e certos usos comerciais exigem uma licença comercial separada. Leia [LICENSE](./LICENSE) antes de confiar em qualquer resumo, incluindo este.

Status: beta (0.x, atualmente 0.8.1). O engine funciona hoje e instala em minutos. Espere a superfície continuar mudando até o 1.0.
