<div align="center">

<img src="./docs/assets/banner-week1.png" alt="Nirvana-OS: uma frase entra, trabalho pronto sai. Workflows de agentes em paralelo convergem por portões de qualidade." width="100%">

# Nirvana-OS

**Operações agênticas prontas para rodar.** Uma frase entra. Trabalho pronto sai.

[![GitHub stars](https://img.shields.io/github/stars/gutomec/nirvana-os-engine)](https://github.com/gutomec/nirvana-os-engine/stargazers)
[![version](https://img.shields.io/github/v/release/gutomec/nirvana-os-engine?label=version)](./CHANGELOG.md)
[![CI](https://github.com/gutomec/nirvana-os-engine/actions/workflows/smoke.yml/badge.svg)](https://github.com/gutomec/nirvana-os-engine/actions/workflows/smoke.yml)
[![license](https://img.shields.io/badge/license-SUL-lightgrey)](./LICENSE)

**macOS, Linux e WSL**

```bash
curl -fsSL https://gutomec.github.io/nirvana-os-engine/install.sh | bash
```

**Windows (PowerShell)**

```powershell
irm https://gutomec.github.io/nirvana-os-engine/install.ps1 | iex
```

[Documentação](https://gutomec.github.io/nirvana-os-engine/) · [Packs](https://squads.sh/pt/packs) · [Instalação ilustrada](https://gutomec.github.io/nirvana-os-engine/install.html) · [Beta](https://gutomec.github.io/nirvana-os-engine/beta.html) · [Changelog](./CHANGELOG.md)

**Leia isto no seu idioma:** [English](./README.md) · [Português](./README.pt-BR.md) · [Español](./README.es.md) · [中文](./README.zh.md) · [हिन्दी](./README.hi.md) · [العربية](./README.ar.md)

</div>

---

## Você conversa com o seu agente. O seu agente usa o Nirvana.

Você já trabalha com um agente de terminal: Claude Code, Codex, Antigravity, Pi, Grok ou outro. Um prompt rende uma boa resposta. Trabalho de verdade pede um pesquisador, um redator, um revisor e um operador, com registro de quem fez o quê.

O Nirvana-OS dá essa organização ao seu agente. Você pede em linguagem natural, e o agente usa o Nirvana para escolher as empresas, os squads e os mind-clones certos, despachá-los, conferir o que voltou e mostrar o comprovante. Você não aprende uma interface nova e não digita comandos no dia a dia. Os comandos mais abaixo são a referência que o seu agente usa, e ficam à sua disposição quando você quiser.

## O que é

O Nirvana-OS é um sistema multiagente nativo em Bun e independente de runtime. Ele roda por cima do agente que você já usa e nunca o substitui. Trabalha com três tipos de conteúdo, todos pastas na sua máquina:

| Pilar | O que é | Onde fica |
|---|---|---|
| **Empresas (businesses)** | Organizações com organograma. Uma empresa despachada roda como um agente que ocupa os seus assentos, usa squads pelos cards deles e canaliza mind-clones | `~/businesses/` |
| **Squads** | Equipes portáteis de agentes, com agentes, tarefas e workflows que o agente despachado segue como método | `~/squads/` |
| **Mind-clones** | DNA de persona em cinco camadas, para que um agente pense e escreva com o método de um especialista | `~/businesses/_library/dna/` |

O engine vem sem conteúdo. Você cria empresas, squads e clones pedindo ao seu agente, ou instala um pack do [squads.sh](https://squads.sh/pt/packs).

## Instalação

Este README descreve o beta da 0.15, `v0.15.0-beta.10`. O comando do topo desta página instala a última release **estável** (0.14.11); para instalar este beta, use os comandos em [Betas](#betas). Node não é necessário. Se faltar o [Bun](https://bun.sh), qualquer um dos dois instaladores o coloca na sua pasta de usuário (`~/.bun`), sem sudo e sem administrador, e continua.

Antes de rodar:

- **macOS:** nada a preparar.
- **Windows (PowerShell):** nada a preparar, e sem direitos de administrador.
- **Linux (Ubuntu):** `sudo apt update && sudo apt install -y curl unzip`.
- **Windows com WSL (Ubuntu):** rode `wsl --install` num PowerShell aberto como administrador, reinicie, abra o app Ubuntu e crie o seu usuário Linux. Depois instale `curl` e `unzip` como no Linux e rode o comando `bash` dentro do Ubuntu. O seu agente de IA (Claude Code, Codex, Antigravity) também precisa ser instalado dentro do Ubuntu, e os seus projetos ficam em `~`, não em `/mnt/c`, que é lento.

O que ele muda na sua máquina:

- o engine em `~/.nirvana/skills`;
- a skill `nirvana` ligada em cada runtime de agente que encontrar: `~/.claude/skills`, `~/.codex/skills`, `~/.gemini/config/skills` (Antigravity), `~/.pi/agent/skills` e `~/.agents/skills` (OpenClaw);
- `nrv` e `nrv-hermes` em `~/.local/bin`, mais uma linha de PATH no perfil do seu shell (o PATH do usuário no Windows);
- hooks de auditoria no Claude Code, no Antigravity e no Codex;
- as pastas de conteúdo vazias `~/squads`, `~/businesses` e `~/businesses/_library/dna`.

Rodar de novo é seguro. **Feche o terminal e abra um novo** para que o `nrv` entre no PATH, e confira com `nrv --version`; este beta mostra `0.15.0-beta.10`. Depois peça ao seu agente: *"Confira se o Nirvana-OS está instalado corretamente."* Ele roda `nrv doctor`. Saída 1 significa só avisos; saída 2 lista o que falhou.

Pelo `curl | bash` o instalador não faz perguntas. Para escolher um perfil de desempenho já na instalação, passe-o adiante: troque o `bash` do fim por `bash -s -- --profile=balanced`. Você também pode defini-lo depois, pedindo ao seu agente (veja [Configurações](#configurações)).

O passo a passo de cada sistema está no [site de documentação](https://gutomec.github.io/nirvana-os-engine/install.html), com uma [página para o beta](https://gutomec.github.io/nirvana-os-engine/beta.html), e no [INSTALL.md](./INSTALL.md), com os outros caminhos (a skill `nirvana` pelo skills.sh, instalar a partir de um clone).

## Comece um projeto

Abra a pasta em que vai trabalhar, inicie o seu agente nela e diga: *"Prepare esta pasta como um projeto do Nirvana-OS."* O agente roda `nrv init .`, que escreve `.nirvana/project.yaml` e uma nota curta em `AGENTS.md`, `CLAUDE.md` e `GEMINI.md`. Os entregáveis caem em `outputs/`, dentro do projeto.

Essa nota mantém o seu agente trabalhando como sempre. Ele usa o Nirvana só quando o pedido chama por ele:

- você o nomeia ("use o Nirvana para…", "via nirvana");
- você nomeia ou aponta uma das suas empresas, squads ou mind-clones ("minha empresa de lançamentos", "o squad de copy", "com a voz do Hormozi"), inclusive o nome de um pack;
- você pede que o trabalho, ou parte dele, rode em outro runtime ("use o Codex para revisar").

Se quiser que o Nirvana orquestre todo entregável de um projeto, diga *"orquestre tudo neste projeto com o Nirvana"*. O agente roda `nrv init . --orchestrators=always`. Abra uma sessão nova para a mudança valer. A estável 0.14.11 funciona ao contrário: o contrato completo é o padrão dela, e ela só pergunta quando você mesmo roda `nrv init .` numa pasta que já tem um desses arquivos.

Daí em diante você conversa com o seu agente em linguagem natural e ele usa o Nirvana-OS. Você não digita comandos no dia a dia.

## O que pedir ao seu agente

| Você diz | O seu agente roda |
|---|---|
| "Quais empresas / squads / mind-clones eu tenho?" | `nrv list-businesses`, `nrv list-squads`, `nrv list-clones` |
| "Use o Nirvana para escrever a copy de lançamento de X." | o harness: escolhe a empresa, escreve um brief, `nrv dispatch … --exec` |
| "Rode isto pelo squad de copy, no Codex." | `nrv dispatch --squad <slug> … --exec --runtime codex` |
| "Pare essa execução." | `nrv run-track stop <run>` |
| "Troque o título no que você entregou." | `nrv revise <projeto> "<mudança>"` |
| "Mostre o que essa execução fez." | `nrv audit-view <projeto>` |
| "Instale as dependências de todos os meus squads." | `nrv activate --all` |
| "Atualize o Nirvana-OS." | `nrv update` |
| "Atualize o meu pack Genesis Circle." | `nrv update genesis-circle` |
| "Deixe o Nirvana no modo economia." | `nrv config set execution.profile economy --global` |

Pedidos maiores funcionam do mesmo jeito:

```text
Use o Nirvana-OS para criar uma empresa chamada podcast-empire que produz, publica
e monetiza 3 podcasts ao mesmo tempo. Cada programa com nicho próprio, apresentador
de IA, calendário editorial e funil de monetização independente. Uns 7 funcionários.
```

```text
Use o Nirvana-OS para transformar a obra pública de <autor> num mind-clone completo.
```

```text
Use o Nirvana-OS para produzir um pacote de lançamento: pesquisa de mercado, copy
da landing page e uma análise da concorrência.
```

O agente orquestra e nunca escreve o entregável ele mesmo. Cada empresa escolhida recebe o próprio brief e a própria execução, em paralelo quando as partes são independentes.

<div align="center">
  <img src="./docs/assets/nirvana-promo-en-readme.gif" alt="Uma ordem em prosa entra, um conglomerado de IA inteiro se monta e entrega" width="100%">
</div>

## Packs

Packs são empresas, squads e mind-clones curados, vendidos no [squads.sh](https://squads.sh/pt/packs). O carro-chefe é o [Genesis Circle](https://squads.sh/pt/nirvana-os).

1. Compre o pack no squads.sh e baixe o zip pelo seu painel.
2. Descompacte o arquivo inteiro e abra um terminal na pasta que tem o `setup.sh`:
   - macOS: dê dois cliques no zip, digite `cd ` no Terminal, arraste a pasta para a janela e aperte Enter;
   - Windows: clique com o botão direito no zip, escolha **Extrair tudo**, abra a pasta, clique com o botão direito num espaço vazio e escolha **Abrir no Terminal**;
   - Linux e WSL: `cd ~/Downloads && unzip <arquivo>.zip -d <pasta> && cd <pasta>`. No WSL, copie antes o zip de `/mnt/c/Users/<usuário>/Downloads` para `~/Downloads`.
3. Rode o setup:
   - macOS, Linux e WSL: `bash setup.sh`
   - Windows: `powershell -ExecutionPolicy Bypass -File setup.ps1`

   O setup instala o Bun se precisar, instala ou atualiza o engine, copia o conteúdo para `~/squads`, `~/businesses` e `~/businesses/_library/dna`, reconstrói os índices e guarda a licença do pack em `~/.nirvana-license/packs/<pack>/`. Ele nunca troca o engine por uma release mais antiga, então um beta continua beta.
4. Converse com o seu agente: *"Use o Nirvana para listar o que o pack Genesis Circle me trouxe"*, e depois peça trabalho nomeando uma empresa, um squad ou o pack.

**Ativar os squads.** As dependências de um squad são instaladas sob demanda na primeira vez que ele roda, num ambiente só dele em `~/.nirvana/envs/<squad>`. Para preparar todas de uma vez, peça ao seu agente: *"Ative todos os meus squads do Nirvana."* Ele roda `nrv activate --all`, que cobre pacotes Node e Python, programas do sistema, chaves de API e variáveis de ambiente, servidores MCP e modelos. O agente recebe a lista de falhas com o comando exato que corrige cada uma, e pede a sua permissão antes de qualquer coisa que use `brew`, `sudo` ou `winget`, e para qualquer chave de API. A primeira execução num pack grande leva alguns minutos.

**Atualizar um pack.** Peça ao seu agente para atualizá-lo, ou rode `nrv update <slug-do-pack>`, por exemplo `nrv update genesis-circle`. Componentes que você editou ganham backup em `~/.nirvana/backups/packs/<pack>/` antes que a atualização os substitua. Se a atualização falhar com erro de licença, baixe o pack de novo no squads.sh e rode o setup outra vez; isso também renova a licença.

## Atualizar o engine

Peça ao seu agente para atualizar o Nirvana-OS, ou rode `nrv update`. Ele faz backup de `~/.nirvana/skills` antes e mantém as suas configurações e o seu conteúdo. `nrv update --check` diz qual release instalaria, sem mudar nada.

Uma atualização nunca leva o engine para uma release mais antiga. Um engine estável só vai para uma estável mais nova. Um beta vai para a release maior mais nova, beta ou estável, então um beta da 0.15 vira 0.15.0 quando ela sair. Depois de atualizar o engine, o `nrv update` também confere cada pack instalado que tem licença e avisa quando há versão nova.

## Betas

Betas são prereleases no GitHub, e este README é o do beta: `v0.15.0-beta.10`. O comando do topo instala a última estável, então o beta é instalado fixando o tarball dele. A tag começa com `v`; sem ele o download devolve 404. Para um beta mais novo, troque essa tag por uma da [lista de releases](https://github.com/gutomec/nirvana-os-engine/releases).

macOS, Linux e WSL:

```bash
curl -fsSL https://gutomec.github.io/nirvana-os-engine/install.sh | NIRVANA_ENGINE_URL=https://github.com/gutomec/nirvana-os-engine/releases/download/v0.15.0-beta.10/nirvana-os-engine.tar.gz bash
```

Windows (PowerShell), numa linha só:

```powershell
$env:NIRVANA_ENGINE_URL='https://github.com/gutomec/nirvana-os-engine/releases/download/v0.15.0-beta.10/nirvana-os-engine.tar.gz'; irm https://gutomec.github.io/nirvana-os-engine/install.ps1 | iex
```

Depois, se a janela continuar aberta, rode `Remove-Item Env:NIRVANA_ENGINE_URL`: enquanto a variável existir, o `nrv update` reinstala o tarball fixado. Os comandos de Windows usam aspas simples porque uma aspa dupla perdida na colagem deixa o PowerShell esperando em `>>`.

Uma vez no beta, o `nrv update` e todo setup de pack mantêm você no canal beta: betas mais novos e, quando sair, a 0.15.0. Um projeto preparado na 0.14.11 mantém o contrato completo até você rodar `nrv init .` no beta, que o troca, no lugar, pela nota sob demanda (`--orchestrators=always` mantém o contrato completo); as linhas que você escreveu acima do bloco do Nirvana ficam.

**Voltar à estável.** No Windows, abra um PowerShell novo e rode `Remove-Item Env:NIRVANA_ENGINE_URL`; um erro dizendo que ela não existe não tem problema. Rode o comando de instalação simples do topo desta página. Ele instala a última estável por cima do beta e mantém o seu conteúdo, os packs e as configurações. Confira que o `nrv --version` não mostra mais `beta` e rode `nrv init .` de novo em cada projeto que usou com o beta, depois de remover o bloco que o beta escreveu em `AGENTS.md`, `CLAUDE.md` e `GEMINI.md` ([detalhes](./INSTALL.md#back-to-stable-from-a-beta)).

## Configurações

As configurações mudam quando você pede. *"Deixe o Nirvana no modo economia"*, *"máxima qualidade"* ou *"o que está configurado?"* bastam; o seu agente roda `nrv config` e diz o que mudou.

Um perfil move várias configurações de uma vez:

| Perfil | Esforço | Teto de contexto por worker | Revisão | Checagens visuais pelos workers |
|---|---|---|---|---|
| `max` | xhigh | nenhum (padrão do runtime) | toda entrega, até duas rodadas | ligadas |
| `balanced` | high | 400 mil tokens | quando uma regra pede | desligadas |
| `economy` | medium | 200 mil tokens | só quando pedida | desligadas |

Um perfil nunca escolhe o modelo; quem escolhe é a configuração do seu runtime. Uma configuração que você muda explicitamente vence o perfil. `nrv config list` mostra cada configuração, o valor e de onde ele veio. A referência completa está em [docs/configuration.md](./docs/configuration.md). Perfis só existem a partir da 0.15.

**Por projeto.** `nrv config set briefing.altitude <outcome|guided|prescriptive> --project` define quanto um brief carrega: `outcome`, o padrão, diz o resultado, os limites e a definição de pronto; `guided` acrescenta a estrutura que o autor sugere; `prescriptive` acrescenta critérios por item, a lista de artefatos e o método. `nrv config get briefing.altitude` mostra o valor em vigor. Regras em texto livre vão no `CLAUDE.md`, `AGENTS.md` ou `GEMINI.md` do projeto, acima do bloco do Nirvana que o `nrv init` reescreve; o seu agente as lê e as leva para os briefs que escreve. Basta pedir: *"neste projeto, use briefs guiados"*, *"acrescente ao CLAUDE.md deste projeto: todo entregável em português do Brasil"*.

## Por que "o trabalho está feito" significa algo aqui

Um orquestrador pode anunciar qualquer coisa na mensagem final. O Nirvana-OS apoia cada entrega em coisas que você abre no disco.

- **Trilha de auditoria.** Cada despacho, veredito de portão e entrega é um evento só de acréscimo em `~/.harness-logs/<data>/audit.jsonl`. Toda execução com `--exec` também deixa um registro em `.nirvana/run-kernel.sqlite`, no projeto. `nrv audit-view <projeto>` mostra a cadeia.
- **Conferido no disco.** O `verify-deliverable` compara o que o brief prometeu com os arquivos que existem, e o portão de qualidade roda rubricas por tipo de arquivo, com rodadas de correção quando reprova. Uma execução cujas falhas graves sobrevivem às correções é retida, não entregue.
- **Briefs com critérios.** Cada brief leva o pedido do usuário palavra por palavra e critérios observáveis de "pronto quando"; os marcados `(blocking)` decidem se a entrega passa.
- **Gasto sob o seu controle.** Nenhum teto de custo é definido a menos que você peça um (*"limite cada execução a US$ 5"* define `budget.default_max_cost_usd`).

## Referência de comandos

Para agentes e usuários avançados. `nrv help` lista tudo; `nrv <comando> --help` mostra as opções de cada comando. Referência completa: [docs/CLI.md](./docs/CLI.md).

| Comando | O que faz |
|---|---|
| `nrv doctor` | Diagnóstico: runtimes, hooks, links de skills, dependências, registros, licenças |
| `nrv init <dir>` | Torna uma pasta um projeto Nirvana (`--orchestrators=always`, `--scope=project\|merge\|global`) |
| `nrv list-businesses` / `list-squads` / `list-clones` | Navega pelos três registros |
| `nrv find "<necessidade>"` / `nrv search "<tema>"` | Candidatos ranqueados para um pedido / busca por palavra-chave nas bibliotecas |
| `nrv brief template\|check\|decide` | O brief de seis seções que o orquestrador escreve para uma empresa |
| `nrv dispatch <empresa> --brief-file <arquivo> --exec` | Roda uma empresa sobre um brief; `--squad <slug>[:<capability>]`, `--agent-x` ou `--auto` nomeiam outros alvos. Recusa sem `--exec` |
| `nrv run-track status\|stop <run>` | Lê o estado de uma execução, ou a para de forma limpa |
| `nrv revise <projeto> "<mudança>"` | Muda uma entrega na mesma sessão do runtime |
| `nrv audit-view <projeto>` | A cadeia de auditoria de uma execução |
| `nrv activate <squad>\|--all` | Prepara antes o ambiente de um squad em `~/.nirvana/envs/<squad>` |
| `nrv config list\|get\|set\|unset\|explain` | Configurações, com `--global` ou `--project` |
| `nrv update [--check]` / `nrv update <pack>` | Atualiza o engine / um pack |
| `nrv validate <squad\|business\|clone> <slug> [--fix]` | Portão de admissão de uma entidade |
| `nrv glance` | Cockpit web (`--read-only` só para navegar) |
| `nrv uninstall --engine` | Remove o engine e mantém o seu conteúdo |

## FAQ

**Preciso saber programar?** Não. Você descreve resultados em linguagem natural; o seu agente usa o Nirvana, e as empresas e os squads escrevem, conferem e entregam.

**Ele substitui o meu agente?** Não. Roda por cima dele. O trabalho despachado roda no runtime da sua sessão, a menos que você nomeie outro: Claude Code, Codex, Antigravity, Pi, Kimi, Grok, Qwen Code ou OpenCode.

**Onde fica o meu trabalho?** Na sua máquina: o conteúdo em `~/businesses`, `~/squads` e `~/businesses/_library/dna`, os entregáveis no `outputs/` de cada projeto. Não há nuvem do Nirvana no caminho.

**E se nada na minha biblioteca servir?** O pedido roda mesmo assim, no `agent-x`, o generalista. Você também pode pedir ao agente que crie a empresa ou o squad que falta.

**Windows?** Nativo, via Bun, sem precisar de WSL. Se preferir o WSL, instale tudo dentro do Ubuntu, inclusive o seu agente.

## Solução de problemas

- **O PowerShell mostra `>>` e fica esperando.** Uma aspa ficou aberta na colagem. Aperte Ctrl+C ou abra uma janela nova e cole de novo a linha única.
- **O macOS mostra "Saving session… [Processo concluído]" depois que você fecha o Terminal.** É o Terminal encerrando o shell, não um erro.
- **A instalação devolve 404.** Falta o `v` no começo da tag, ou essa release não existe.
- **A atualização de um pack falha com erro de licença.** Baixe o pack de novo no squads.sh e rode o setup dele.
- **Qualquer outra coisa.** `nrv doctor` confere a instalação inteira e `nrv install --check` confere os hooks e o PATH. Mais no [INSTALL.md](./INSTALL.md#troubleshooting).

## Licença, autoria e status

Autor: **Luiz Gustavo Vieira Rodrigues (gutomec / Prospecteezy)**. Sem coautores.

Licença: a Nirvana-OS Sustainable Use License (SUL) v1.0. O código-fonte é publicado e abertamente legível, e o engine é grátis para usar. É source-available, não uma licença open-source aprovada pela OSI, e certos usos comerciais exigem uma licença comercial separada. Leia [LICENSE](./LICENSE) antes de confiar em qualquer resumo, incluindo este.

Status: beta (0.x, atualmente 0.15.0-beta.10). O engine funciona hoje e instala em minutos. Espere a superfície continuar mudando até o 1.0.
