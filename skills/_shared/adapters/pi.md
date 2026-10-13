# Adapter · Pi Coding Agent (Earendil, pi.dev)

> Runtime adapter para Squad Protocol v5 + Business Protocol v1 + Harness Protocol v1.
> Cobre os 3 protocolos em um único doc. Seções canônicas conforme Squad v4 §18.5.
> Identidade + capabilities do sistema (o que o Nirvana-OS é e pode fazer): ver `../NIRVANA-OS.md` (fonte única).
> Espelha o `kimi-cli.md` (dispatch sub-process, sem agent-profile por arquivo), com duas diferenças de peso:
> **resume nativo de sessão** (`--session-id <id>`) e **multi-provider real** (15+ providers, incluindo modelos LOCAIS).

As flags abaixo foram conferidas em 2026-10-11 contra o `pi --help` e o `dist/cli/args.js` do 0.84.3 instalado, a documentação do pacote, e o CHANGELOG 1.x e o `docs/cli.md` do `earendil-works/pi` na main. O 1.1.0 em si não rodou aqui.

---

## 1. Adapter Metadata

| Campo | Valor |
|---|---|
| `runtime` | `pi` |
| `vendor` | Earendil Inc. (pi.dev), MIT, npm `@earendil-works/pi-coding-agent` (o antigo `@mariozechner/pi-coding-agent` para no 0.73.1) |
| `min_version` | `pi 0.82.1` (headless verificado). Alvo 1.1.0 (2026-10-07); o 1.0.0 saiu em 2026-10-01. Instalado aqui: 0.84.3. `--mode json` com fallback para `-p` puro em builds sem a flag (§7). |
| `default_model` | herdado do runtime. O engine NUNCA define model; vem da entrada `pi:<model>@<provider>` do `LLM_CASCADE`. `--model` aceita `provider/id` e sufixo `:<thinking>` (ex.: `sonnet:high`). O `@provider` vira `--provider` só junto com `--model` (§7). |
| `tested_against` | `pi 0.82.1` (2026-07-28): `--help` e runs headless reais: (a) caminho de ERRO (provider xai sem créditos → exit 0 com `stopReason:"error"` no stream, classificado `quota_exhausted`); (b) caminho de SUCESSO LOCAL (`--provider ollama --model qwen2.5-coder:7b` via `models.json`), texto do assistant extraído do stream, custo $0, resume real via `--session-id`. 0.84.3 (2026-10-11): `--help` e `args.js` relidos, sem run. |
| `config_paths` | `~/.pi/agent/` (`settings.json`, `auth.json`, `models.json`, `mcp.json`, `trust.json`, `SYSTEM.md`, `APPEND_SYSTEM.md`); no projeto `.pi/settings.json`, `.pi/mcp.json`, `.pi/SYSTEM.md`, `AGENTS.md`/`CLAUDE.md` |
| `skills_root` | Padrão Agent Skills. Globais `~/.pi/agent/skills/` **e** `~/.agents/skills/`; por projeto `.pi/skills/` e `.agents/skills/` do cwd até a raiz do git (as de projeto só depois que o projeto é confiado). Mesmo nome em duas raízes: o pi avisa e fica com a primeira encontrada. O `nrv install` linka o engine em `~/.pi/agent/skills/` e, para o OpenClaw, em `~/.agents/skills/`; com os dois presentes, cada skill do Nirvana aparece duas vezes e o pi loga um aviso de colisão por skill (§13). |
| `agents_root` | Sem agent-profile por arquivo; a persona vai no prompt e a diretiva no `--append-system-prompt` (§7). Extensões podem definir agentes. |
| `memory_root` | `<project>/AGENTS.md` (também `CLAUDE.md`) + `SYSTEM.md`/`APPEND_SYSTEM.md`; sessões persistidas como árvores JSONL (`PI_SESSION_FILE`) |
| `audit_log` | `~/.harness-logs/` (jsonl via driver) + o próprio session file JSONL do pi (árvore navegável, `--export` para HTML) |
| `protocol_versions` | Squad 5.0, Business 1.0, Harness 1.0 (com gaps registrados em §13) |

---

## 2. Feature Support Matrix

`✓` = nativo · `~` = workaround/parcial · `✗` = não suportado

| Feature (Business v1 §6) | Squad v5 | Business v1 | Harness v1 | Notas |
|---|---|---|---|---|
| `max_turns` | ~ | ~ | ~ | Sem flag de turns; o adapter usa o timeout do sub-process, e os eventos `turn_start`/`turn_end` do stream JSON dão a contagem real |
| `tool_whitelist` | ✓ | ✓ | ✓ | `--tools/-t` (allowlist; o 1.1.0 aceita também deltas `+name`/`-name`), `--exclude-tools/-xt` (denylist; padrões `*` desde o 1.0.4), `--no-tools/-nt`, `--no-builtin-tools/-nbt`. O engine não passa nenhuma hoje (§5) |
| `subagent_spawning` | ~ | ~ | ~ | Sem sub-agentes built-in. Fan-out via sub-processes `pi -p --mode json`, ou um pacote como `@pi9/subagent` (instalado aqui; orquestração não exercitada) |
| `audit_trail` | ✓ | ✓ | ✓ | Sessão inteira como árvore JSONL; o harness adiciona jsonl próprio via `runPi` |
| `scheduled_invocation` | ✗ | ✗ | ✗ | Sem cron nativo: degradar para cron externo |
| `event_bus` | ~ | ~ | ~ | Mentions/tickets via file-system; o modo RPC (JSONL em stdin/stdout) poderia hospedar um broker |
| `hooks` | ~ | ~ | ~ | Sem hooks de shell; extensões TypeScript assinam eventos do agente (`tool_call`, `agent_settled`, ...) |
| `sandboxing` | ~ | ~ | ~ | Sem sandbox do OS; scripts do codemode rodam num sandbox QuickJS, mas as tools dele (`bash`, `write`) alcançam o host. Isolar via cwd + container |
| `session_memory` | ✓ | ✓ | ✓ | Sessões em árvore, `--session-id`, `--session`, `--fork`, `--continue`; `--no-session` para runs efêmeros |
| `project_memory` | ✓ | ✓ | ✓ | `AGENTS.md`/`CLAUDE.md` no projeto + `SYSTEM.md` |
| `global_memory` | ~ | ~ | ~ | `~/.pi/agent/` guarda config, skills e `SYSTEM.md` globais; sem auto-memory |
| `handoff_artifacts` | ✓ | ✓ | ✓ | JSON do último evento `message_end` do assistant, ou texto puro no fallback `-p` |
| `fork_context` | ✓ | ✓ | ✓ | `--fork <path\|id>` cria fork real de uma sessão |
| `teammate_primitive` | ✗ | ✗ | ✗ | Sem primitive de time; team é convenção via file system |
| `telemetry_otel` | ~ | ~ | ~ | `PI_TELEMETRY` cobre só a telemetria de install/update; OTel via extensão ou SDK externo |
| `mcp` | ✓ | ✓ | ✓ | Built-in desde o 0.99.0: servidores stdio e streamable HTTP com OAuth, de `~/.pi/agent/mcp.json` e, em projetos confiados, `.pi/mcp.json`; `pi mcp add\|remove\|list\|login\|logout`; `--no-mcp` desliga por um run. Uma extensão que registra `/mcp` (ex.: `pi-mcp-adapter`, instalada aqui) substitui o suporte built-in |

> **Nota fora da matriz canônica:** o diferencial do pi é **um runtime → 15+ providers** (Anthropic, OpenAI, Google, Azure, Bedrock, Mistral, Groq, Cerebras, xAI, OpenRouter, Ollama, ...), OAuth de assinaturas (Claude Pro/Max, ChatGPT, Copilot), **modelos LOCAIS** (§8), o trio print/JSON/RPC e, desde o 0.99, o **codemode**: uma tool `codemode` que roda JavaScript escrito pelo modelo num QuickJS e chama as tools do pi em paralelo (ative com `--tools +codemode` ou `"defaultTools": ["+codemode"]`).

---

## 3. Concept Mapping

| Conceito (Protocolo) | Equivalente Pi | Implementação |
|---|---|---|
| Squad / Business | Diretório de skills + AGENTS.md | `~/.pi/agent/skills/<name>/` (global) ou `.agents/skills/` (projeto) + `AGENTS.md` do CWD |
| Capability | Skill (padrão Agent Skills) | `SKILL.md` com frontmatter `name`/`description`; forçável via `/skill:nome` |
| Employee | Persona embutida no prompt | persona-núcleo + DNA no corpo do prompt do `pi -p --mode json`; não é arquivo de agent |
| `is_brief_intake: true` | Persona default quando skill ativa | Montada no prompt / `AGENTS.md` |
| `is_antagonist: true` | Sub-process invocado em pipeline | `pi -p --mode json --model <m> --provider <p> --approve -- "<persona+brief>"` |
| Handoff artifact | JSON nos eventos `message_end` + arquivo | Persistido em `<project>/.handoffs/` |
| Mention `@employee` | Convenção no handoff | Adapter detecta → novo sub-process |
| Ticket | Arquivo persistido | `<project>/.tickets/<TICKET_ID>.json` |
| Escalation trigger | Wrapper script + harness call | Wrapper checa condição → emite notification para harness |
| Permanent memory | `<project>/AGENTS.md` + files custom | Sem auto-memory global |
| Project memory | `<project>/AGENTS.md` + `SYSTEM.md` | Load nativo |
| Session memory | Árvore de sessão JSONL | Resume via `--session-id`; fork via `--fork`; compaction automática |
| Routing decision (harness) | Pre-spawn lookup table | BM25 sobre `capabilities[].examples[]` em wrapper Bun |

---

## 4. Frontmatter Mapping

### Squad v5 / Business v1 → AGENTS.md

O pi lê `AGENTS.md` nativamente (`--no-context-files` desliga isso). O adapter mantém os mesmos dois arquivos do Codex/Kimi:

```yaml
# AGENTS.md (head do projeto/skill)
You are an AI agent operating under the Squad/Business Protocol.

Available capabilities: [media.video.analyze, media.transcript.extract, ...]
Default tools: [Read, Write, Bash]
```

```yaml
# .agents/manifest.yaml (auxiliar: lido por wrapper, não pelo pi)
name: nexus-council
protocol: 1.0
employees: [ceo, marketing-lead, ...]
operation_mode: zero_human
```

### Employee → prompt do `pi -p --mode json`

Sem agent-profile por arquivo. A persona do employee é montada no prompt:

```
<persona-núcleo do employee (frontmatter → topo)>
<DNA do mind-clone: injectMindClones().combined_prompt>
## Brief
<brief enriquecido>
## Tools permitidos
<tool whitelist>
## Contrato de saída
Responda SOMENTE com um único objeto JSON: {...}
```

> Para `type: mind_clone`, o adapter **prepende** `(DISCLOSURE: AI-generated persona, not a real person.)` na persona, igual ao Codex.

---

## 5. Tool Whitelist Mechanics

- Tools default: `read`, `bash`, `edit`, `write`, a menos que o setting `defaultTools` mude isso. `grep`, `find`, `ls`, `codemode` e `tool_search` ficam desligadas por default. Extensões adicionam outras.
- Flags (valem para tools built-in, de extensão e custom):
  - `--tools, -t <a,b,c>`: nomes simples substituem a seleção (`pi --tools read,grep,find,ls -p "..."` é um modo read-only real). No 1.1.0, uma lista só de entradas `+name`/`-name` edita a seleção default (`-t +codemode,-write`); as duas formas não se misturam.
  - `--exclude-tools, -xt <a,b>`: denylist; padrões `*` desde o 1.0.4.
  - `--no-tools, -nt` / `--no-builtin-tools, -nbt`: desligar tudo / só as built-in.
  - Tools MCP (1.x): `--tools` as mantém, a menos que uma entrada comece com `mcp__` (`--tools read,codemode,'mcp__radius__*'`); para tirá-las, `--exclude-tools 'mcp__*'` ou `--no-mcp`.
  - Skill frontmatter: campo `allowed-tools` do padrão Agent Skills.
- O driver não passa nada disso hoje. O contrato `allowedTools` do harness usa nomes do Claude (Write/Edit/Read), que não mapeiam 1:1; `noTools` poderia virar `--no-tools`.
- `-a/--approve` × `-na/--no-approve` decidem a confiança na configuração e nos recursos locais do projeto (`.pi/settings.json`, extensões de `.pi`, skills de projeto, `.pi/mcp.json`) por um run. Não é permission-mode por tool. Os modos não interativos (`-p`, `--mode json`, `--mode rpc`) nunca mostram o trust prompt; sem decisão salva em `~/.pi/agent/trust.json` eles seguem o `defaultProjectTrust` (`ask`, o default, e `never` ignoram os recursos do projeto; `always` confia). O driver sempre passa uma das duas flags, então o resultado não depende desse setting.

---

## 6. Max-Turns Mechanics

O pi não tem flag de turns nem de gasto. O adapter:

1. Roda cada employee como sub-process `pi -p --mode json`, com o timeout do driver (`opts.timeoutMs` → `spawnSync`).
2. Pode contar os eventos `turn_start`/`turn_end` do stream para ter contagem real, se um wrapper quiser impor limite.
3. Estouro de timeout → encerra o sub-process e registra `audit_event: budget_violation`.

Effort existe como flag: `--thinking off|minimal|low|medium|high|xhigh|max` (sobrescreve o sufixo `:<thinking>` do model, limitado ao que o modelo suporta). O engine ainda não a passa: `EFFORT_CAPABLE` contém só claude-code e codex, então os perfis não chegam ao pi.

---

## 7. Subagent Spawning

**Sem subagent primitive nativo** ("no built-in sub-agents"). O caminho é sub-process (`host-agent-driver.runPi`). O argv que ele monta:

```bash
pi -p --mode json --session-id <uuid> [--append-system-prompt <diretiva>] \
  [--model <model> [--provider <provider>]] --approve|--no-approve \
  -- "<prompt>"
# acima de MAX_ARGV_PROMPT_BYTES a última parte vira:
#   -- @<tmpfile> "The attached file contains the complete task prompt. ..."
```

- `-p --mode json`: run one-shot, JSONL no stdout: header `{"type":"session","version":3,"id":"<uuid>","timestamp","cwd"}`, depois `agent_start`, `turn_start/end`, `message_start/update/end`, `tool_execution_*`, `agent_end`, `agent_settled` (o 1.1.0 adiciona `aborted` ao `agent_settled`, que distingue um run cancelado de um terminado; o driver ainda não lê). O texto do assistant vem no `message_end` (`message.content = [{type:"text",text}]`); vale o último do assistant. Se o run falha com `--mode`/unknown/unrecognized/invalid option, o driver re-executa como `-p` puro e fica com o stdout em texto. Desde o 0.87.1 um valor inválido de `--mode` sai com código não zero em vez de ser ignorado.
- `--session-id <uuid>`: "exact project session ID, creating it if missing". O driver gera o id no 1º run e o `nrv revise` retoma com o mesmo id. Não combina com `--session`, `--continue` nem `--resume`.
- `--append-system-prompt <text>`: o `AUTONOMOUS_DIRECTIVE` como system prompt de verdade. A flag também aceita caminho de arquivo e pode repetir; o driver passa texto hoje.
- `--model <pattern>`: só da entrada do cascade; sem ela, vale o default do pi do usuário.
- `--provider <name>`: passado **só junto com `--model`**. Desde o 1.0.0, `--provider` sem `--model` "now fails with an error" (antes era ignorado em silêncio). Quando o cascade nomeia provider mas não model, o driver descarta a flag e avisa: `pi: --provider <p> needs --model (pi 1.0.0 rejects it alone); not passed, pi used its configured provider`.
- `--approve` (default) / `--no-approve` (quando `yolo === false`, ou seja `--safe`): trust do projeto neste run (§5).
- `--`: encerra o parse de opções, então um brief que começa com `-` ou `---` (bullet, front matter YAML) continua sendo mensagem (`pi -p -- "- Summarize"`). Um `@path` depois do `--` continua sendo anexo: verificado no `dist/cli/args.js` do 0.84.3, onde argumentos pós-`--` que começam com `@` vão para `fileArgs`.
- Sem flag de grant de diretório (`RUNTIME_DIR_GRANT_FLAG.pi = null`); um dispatch com `addDirs` leva um aviso.
- stdin: conteúdo via pipe é prefixado ao primeiro prompt. O `spawnSync` do driver fecha o stdin; em teste manual use `< /dev/null`, senão o pi espera EOF.

O adapter da camada leve (judge driver, entrada `pi` do `RUNTIMES`) monta `pi -p --no-approve [--append-system-prompt <persona>] -- <mensagem | @arquivo + nota>` e lê texto puro.

**Detecção de erro (quirk importante):** o pi **sai com exit 0 mesmo quando o provider falha**. O erro vem no stream: `message.stopReason === "error"` + `message.errorMessage` (ex.: `403 "...used all available credits or reached its monthly spending limit"`). O `runPi` marca `ok=false` a partir do stream (um turn posterior bem-sucedido limpa o erro) e passa o `errorMessage` ao quota-detector. Custo por turn em `message.usage.cost.total`, somado pelo driver.

**Para mention `@x`:** adapter detecta no handoff retornado, abre novo sub-process para `x`.

**Fan-out paralelo:** ao nível do OS (sub-processes independentes). O modo RPC (`--mode rpc`, JSONL bidirecional; rejeita argumentos `@file`) permite um worker persistente com steering; não usado pelo driver.

**Worker visível do Orca.** O `orca-worker.ts` abre `pi [--model <model>]`.

---

## 8. Memory Storage

| Camada | Path | Persistência |
|---|---|---|
| Permanent (cross-session) | `<project>/AGENTS.md` + files custom | Manual |
| Project | `<project>/AGENTS.md` + `SYSTEM.md` | Nativa |
| Session | Árvore JSONL (`PI_SESSION_FILE`, vazio com `--no-session`) | Nativa; resume/fork/navegação; compaction automática |
| Business permanent | `~/businesses/<biz>/memory/permanent.md` | Adapter persiste |
| Project (business) | `<project>/<biz>/<project_id>/memory/` | Isolation by construction |

**Autenticação (multi-provider).** Ordem: `--api-key` (exige `--model`) > `~/.pi/agent/auth.json` > env var do provider > keys em `models.json`. Rotas:

- **API keys**: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY`, `XAI_API_KEY`, `OPENROUTER_API_KEY`, `DEEPSEEK_API_KEY`, `AZURE_OPENAI_*`, ...
- **OAuth de assinatura**: `/login` interativo (Claude Pro/Max, ChatGPT, GitHub Copilot, ...). $0 marginal dentro do cap da assinatura.
- **Rename de provider (1.0.3, breaking):** `azure-openai-responses` agora é `azure`. Renomeie em `auth.json`, `models.json`, `settings.json` e em qualquer entrada de cascade (`pi:<model>@azure`). As envs `AZURE_OPENAI_*` não mudaram.
- **MODELOS LOCAIS**, três portas:
  1. **Ollama** via `models.json` (endpoint `http://localhost:11434`).
  2. **llama.cpp router server**: provider built-in (`/login llama.cpp`, `/llama`).
  3. **Qualquer endpoint OpenAI-compatible** (LM Studio, vLLM) registrado em `~/.pi/agent/models.json`.
  Custo por token $0; nada sai da máquina. Cascade: `pi:<modelo-local>@ollama`.

Os binários standalone pararam de carregar arquivos `.env` do diretório de lançamento no 1.1.0; as chaves têm que vir do ambiente real ou do `auth.json`.

---

## 9. Context Window & Compaction

- Janela: **depende do modelo ativo** (200K Anthropic, 1M Gemini, local = config do servidor). O pi é a única porta do engine onde a janela é escolhida por entrada de cascade, não por runtime.
- Compaction: automática (eventos `compaction_start`/`compaction_end` no stream).
- Trocar de modelo no meio da sessão (`/model`) preserva a sessão.

---

## 10. Hook System

Sem hooks de shell. O equivalente funcional são **extensões TypeScript** (recarregadas com `/reload`):

| Hook desejado | Workaround Pi |
|---|---|
| `PreToolUse` | Extensão tratando `tool_call`; ou persona como soft-validator + hard validation no wrapper |
| `PostToolUse` | Extensão, ou wrapper parseando os eventos `tool_execution_end` |
| `UserPromptSubmit` | Adapter injeta instructions no prompt |
| `Stop` | Wrapper inspeciona `agent_settled` + exit code |
| `SessionStart` | Wrapper carrega memory antes de invocar; ou `SYSTEM.md`/`AGENTS.md` |
| `Compact` | Compaction automática (`compaction_start` no stream) |

---

## 11. Invocation Examples

### Exemplo 1: Squad capability

```bash
# User: "transcrever vídeo do Instagram https://..."
pi -p --mode json --approve -- "You are instagram-intelligence. Analyze video: https://..." \
  > .handoffs/ii-1.jsonl
```

### Exemplo 2: Business brief com handoff em pipeline (modelo local)

```bash
# CEO no modelo local via Ollama ($0/token, nada sai da máquina)
SID=$(uuidgen)
pi -p --mode json --session-id "$SID" --model qwen3-coder --provider ollama --approve \
  -- "<persona ceo + brief + contrato JSON>" > .handoffs/ceo-1.jsonl

# Adapter detecta `next_action: delegate to marketing-lead` e retoma a MESMA sessão
pi -p --mode json --session-id "$SID" --model qwen3-coder --provider ollama --approve \
  -- "<persona marketing + contrato JSON>" > .handoffs/marketing-1.jsonl
```

### Exemplo 3: Entradas de cascade (`.env`)

```dotenv
# pi como camada de resiliência multi-provider + fallback local infinito
LLM_CASCADE=claude-code:opus,pi:gpt-6.1-sol@openai$10,pi:qwen3-coder@ollama
USE_PI="Quando precisar de modelos locais (Ollama/llama.cpp) ou de um provider fora dos CLIs oficiais"
```

Toda entrada `pi:` que nomeia um provider também precisa nomear um model; sem model, o `--provider` fica de fora (§7).

---

## 12. Runtime-Specific Validators

- **Versão**: `pi --version`. Abaixo do 1.0.0, `--provider` sozinho é ignorado em vez de rejeitado; abaixo do 0.99, não há MCP nem codemode built-in.
- **Credencial do provider ATIVO**: a entrada `pi:<model>@<provider>` só é válida se o provider tem credencial (`auth.json`, env, `models.json`) ou é local e está rodando. `pi auth` checa se o provider está pronto.
- **Model resolvível**: `<model>` tem que existir no catálogo do provider ou no `models.json` (`pi --list-models <busca>`); erro vira `quota_exhausted` de TTL curto e o cascade segue.
- **Endpoint local vivo**: para providers locais, checar `GET /v1/models` (ou equivalente) antes de despachar.
- **Trust do projeto**: headless SEMPRE com `--approve` ou `--no-approve` explícito.
- **MCP**: `pi mcp list` conecta todo servidor habilitado e sai com 1 quando algum falha. Se o `pi-mcp-adapter` estiver instalado, ele é dono do `/mcp` e o pi ignora o `mcp.json`.
- **Skills duplicadas**: se `~/.pi/agent/skills/` e `~/.agents/skills/` tiverem links do Nirvana, espere um aviso de colisão por skill.

---

## 13. Known Limitations

1. **Exit code NÃO sinaliza erro de provider** (verificado no 0.82.1): o pi sai com 0 com `stopReason: "error"`. O `runPi` detecta pelo stream; qualquer wrapper próprio TEM que fazer o mesmo.
2. **Schema JSONL pode variar por build** (confirmado no 0.82.1; o 1.1.0 adiciona `agent_settled.aborted`) → o driver parseia defensivamente e mantém o stdout inteiro se nada parsear.
3. **Skills expostas em dobro**: o engine linka em `~/.pi/agent/skills/` e, para o OpenClaw, em `~/.agents/skills/`; o pi lê as duas e fica com a primeira cópia, com aviso.
4. **MCP encoberto por extensão**: um `pi-mcp-adapter` instalado substitui o suporte MCP built-in do 0.99+; remova-o depois do upgrade para usar o `mcp.json`.
5. **Sem subagents nativos** → fan-out via sub-process, ou pacote `@pi9/subagent` (instalado, não exercitado).
6. **Modelos locais pequenos (≤7B) NÃO sustentam o dispatch de business completo**: testado 2x com `qwen2.5-coder:7b` (prompt de employee de 92k chars): zero tool calls, entregável nunca escrito. Use o trilho local no fim do cascade, para chamadas curtas de julgamento e tarefas mecânicas.
7. **Flags que o engine não usa**: `--thinking`, `--no-tools`/`--tools`/`--exclude-tools` e `--no-session` existem, mas o driver não passa nenhuma.
8. **Diretiva vai como argv**: `--append-system-prompt <text>` soma cerca de 3 KB à linha de comando; na rota `.cmd` do Windows a linha inteira tem teto de 8.191 chars. A flag aceita caminho de arquivo, o que eliminaria o risco.
9. **Sem hooks de shell** → extensões TypeScript.
10. **Sem cron e sem sandbox do OS** → cron externo; containerizar quando isolamento importa.
11. **Custo vem do stream**: `message.usage.cost.total` por turn do assistant; trilhas OAuth de assinatura podem reportar 0.
12. **Semântica do `--approve`**: confiança em arquivos e recursos locais do projeto, não permission-mode por tool.
13. **Modo RPC não usado** pelo driver.

**Vantagem compensatória:** um único runtime cobre 15+ providers + modelos locais ($0/token, offline), com MCP e codemode built-in, resume/fork de sessão nativo e trilha JSONL auditável. É o melhor fit do engine para fallback infinito e briefs sensíveis a privacidade.

---

## 14. Source References

- Site/instalação: `https://pi.dev`, `curl -fsSL https://pi.dev/install.sh | sh` (dependências pinadas) ou `npm i -g --ignore-scripts @earendil-works/pi-coding-agent` (sem shrinkwrap desde o 1.0.2).
- Docs: `https://pi.dev/docs/latest` e `packages/coding-agent/docs/` no repo: `cli` (flags, tools, sessões, recursos), `mcp`, `codemode`, `settings` (trust do projeto), `skills`, `json` (event stream), `rpc`, `providers`, `environment-variables` (`PI_CODING_AGENT`, `PI_SESSION_ID`, `PI_SESSION_FILE`, `PI_PROVIDER`, `PI_MODEL`, `PI_OFFLINE`, `PI_TELEMETRY`).
- Changelog: `https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/CHANGELOG.md`.
- Repo: `github.com/earendil-works/pi` (MIT).
- Driver: `skills/_shared/lib/host-agent-driver.ts` (`runPi`, adapter `pi` da camada leve); worker Orca: `skills/_shared/lib/orca-worker.ts`; links de skills: `skills/_shared/lib/runtime-dirs.ts`.
- Squad Protocol v5: `~/.nirvana/skills/squads/SQUAD_PROTOCOL_V5.md`
- Business Protocol v1: `~/.nirvana/skills/businesses/BUSINESS_PROTOCOL_V1.md`
- Harness Protocol v1: `~/.nirvana/skills/harness/HARNESS_PROTOCOL_V1.md`

---

## 15. Version History

| Versão | Data | Mudanças |
|---|---|---|
| 1.0.0 | 2026-07-27 | Doc inicial: cobre Squad 5.0 + Business 1.0 + Harness 1.0 contra o Pi Coding Agent (pi.dev). Dispatch via `pi --mode json` (sub-process, JSONL→texto), resume nativo `--session`, multi-provider com modelos locais. Flags não verificadas contra binário real. |
| 1.1.0 | 2026-07-28 | **Verificado contra `pi 0.82.1`** (--help + run headless real). Driver migrado para `--session-id` determinístico + `--append-system-prompt` nativo; detecção de erro pelo stream (exit 0 no erro de provider, §13.1); custo real em `message.usage.cost.total`; tool whitelist nativa (`--tools`) documentada (§5). Caminho de SUCESSO verificado 100% local: Ollama + qwen2.5-coder:7b via `models.json`, com resume de sessão real. |
| 1.2.0 | 2026-10-11 | Atualizado para o pi 1.1.0. Argv do driver: o prompt vai depois de `--` (o `@file` continua anexando, verificado no `args.js` do 0.84.3); `--provider` só com `--model`, descartado com aviso caso contrário (o pi 1.0.0 rejeita sozinho). Documentados MCP built-in (0.99) e codemode, regras de trust para `-p`/json/rpc, `--thinking`, `--no-tools`/`--tools` (deltas +/-)/`--exclude-tools`, `--no-mcp`, `--no-session`, o rename `azure-openai-responses`→`azure`, as duas raízes globais de skills e o aviso de nome duplicado. Removida a afirmação "sem MCP nativo"; o exemplo de cascade usa `gpt-6.1-sol`. |
