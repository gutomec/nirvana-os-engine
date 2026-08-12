# Adapter · Pi Coding Agent (Earendil — pi.dev)

> Runtime adapter para Squad Protocol v5 + Business Protocol v1 + Harness Protocol v1.
> Cobre os 3 protocolos em um único doc. Seções canônicas conforme Squad v4 §18.5.
> Identidade + capabilities do sistema (o que o Nirvana-OS é e pode fazer): ver `../NIRVANA-OS.md` (fonte única).
> Espelha o `kimi-cli.md` (dispatch sub-process, sem agent-profile por arquivo), com duas diferenças de peso:
> **resume nativo de sessão** (`--session <id>`) e **multi-provider real** (15+ providers, incluindo modelos LOCAIS).

---

## 1. Adapter Metadata

| Campo | Valor |
|---|---|
| `runtime` | `pi` |
| `vendor` | Earendil Inc. (pi.dev) — MIT, npm `@earendil-works/pi-coding-agent` |
| `min_version` | `pi 0.82.1` (verificado). `--mode json` exigido, com fallback para print mode `-p` em builds sem a flag (§7). |
| `default_model` | herdado do runtime — o engine NUNCA define model; vem da entrada `pi:<model>@<provider>` do `LLM_CASCADE`. O `@provider` vira `--provider` NATIVO (anthropic, openai, google, openrouter, ollama, …). `--model` aceita `provider/id` e sufixo `:<thinking>` (ex.: `sonnet:high`). |
| `tested_against` | `pi 0.82.1` (2026-07-28) — flags confirmadas via `--help` E runs headless reais: (a) caminho de ERRO (provider xai sem créditos → exit 0 com `stopReason:"error"` no stream, classificado `quota_exhausted`); (b) caminho de SUCESSO 100% LOCAL (`--provider ollama --model qwen2.5-coder:7b` via `models.json`): texto do assistant extraído do stream, custo $0, e RESUME real da sessão via `--session-id` (2ª chamada recuperou o contexto da 1ª) |
| `config_paths` | `~/.pi/agent/` (`auth.json`, `models.json`, settings), `<project>/AGENTS.md`, `SYSTEM.md` |
| `skills_root` | Padrão **Agent Skills** (agentskills.io, mesmo formato do Claude Code): globais em `~/.pi/agent/skills/` e `~/.agents/skills/`; por projeto em `.pi/skills/` e `.agents/skills/`. O `nrv install` symlinka a árvore do Nirvana em `~/.pi/agent/skills/` quando `~/.pi/agent` existe. |
| `agents_root` | Sem agent-profile por arquivo (como Codex/Kimi) — persona vai no prompt do `pi --mode json` (§7). Extensões TypeScript podem definir agentes custom. |
| `memory_root` | `<project>/AGENTS.md` (project) + `SYSTEM.md`; sessões persistidas como árvores JSONL (`PI_SESSION_FILE`) |
| `audit_log` | `~/.harness-logs/` (jsonl via driver) + o próprio session file JSONL do pi (árvore navegável, exportável em HTML/gist) |
| `protocol_versions` | Squad 5.0, Business 1.0, Harness 1.0 (com gaps registrados em §13) |

---

## 2. Feature Support Matrix

`✓` = nativo · `~` = workaround/parcial · `✗` = não suportado

| Feature (Business v1 §6) | Squad v5 | Business v1 | Harness v1 | Notas |
|---|---|---|---|---|
| `max_turns` | ~ | ~ | ~ | Sem flag per-employee; adapter simula via timeout do sub-process + contagem no handoff |
| `tool_whitelist` | ✓ | ✓ | ✓ | Flags NATIVAS confirmadas: `--tools/-t` (allowlist), `--exclude-tools/-xt` (denylist), `--no-tools/-nt`, `--no-builtin-tools/-nbt`; skills aceitam `allowed-tools` no frontmatter |
| `subagent_spawning` | ~ | ~ | ~ | SEM sub-agentes built-in (filosofia "primitives, not features"). Fan-out via sub-process `pi --mode json`, OU via pacote: `@pi9/subagent` instalado (`pi install npm:@pi9/subagent` — subagents assíncronos/recursivos/resumíveis; carrega em headless sem quebrar o driver, orquestração ainda não exercitada) |
| `audit_trail` | ✓ | ✓ | ✓ | Sessão inteira persistida como árvore JSONL (`PI_SESSION_FILE`); harness adiciona jsonl próprio via `runPi` |
| `scheduled_invocation` | ✗ | ✗ | ✗ | Sem cron nativo — degradar para cron externo |
| `event_bus` | ~ | ~ | ~ | Mentions/tickets via file-system; modo RPC (JSONL stdin/stdout) permite um broker externo no futuro |
| `hooks` | ~ | ~ | ~ | Sem hook system de shell; extensões TypeScript interceptam eventos do agente (equivalente funcional, exige escrever a extensão) |
| `sandboxing` | ~ | ~ | ~ | Sem sandbox próprio; docs oficiais cobrem containerização — isolar via cwd + container |
| `session_memory` | ✓ | ✓ | ✓ | Sessões em árvore com navegação, bookmarks, `--fork` e resume nativo (`--session <id>`) |
| `project_memory` | ✓ | ✓ | ✓ | `AGENTS.md` no projeto (convenção compartilhada com Codex/Antigravity/Kimi) + `SYSTEM.md` |
| `global_memory` | ~ | ~ | ~ | Sem auto-discovery rico como `~/.claude/memory/`; `~/.pi/agent/` guarda config/skills globais |
| `handoff_artifacts` | ✓ | ✓ | ✓ | JSON extraído dos eventos `message_end` (JSONL), ou texto puro no fallback `-p` |
| `fork_context` | ✓ | ✓ | ✓ | `--fork <path\|id>` cria fork REAL da sessão (melhor que sub-process cego) |
| `teammate_primitive` | ✗ | ✗ | ✗ | Sem `TeamCreate`; team é convenção via file system |
| `telemetry_otel` | ~ | ~ | ~ | `PI_TELEMETRY` controla a telemetria própria; OTel via SDK externo |
| `mcp` | ~ | ~ | ~ | SEM MCP nativo (decisão de design) — coberto via pacote: `pi-mcp-adapter` instalado (`pi install npm:pi-mcp-adapter`; carrega em headless sem quebrar o driver, servers ainda não configurados/exercitados) |

> **Nota fora da matriz canônica:** o grande diferencial do pi é **um runtime → 15+ providers** (Anthropic, OpenAI, Google, Azure, Bedrock, Mistral, Groq, Cerebras, xAI, Hugging Face, MiniMax, NVIDIA, OpenRouter, Ollama…), com OAuth de assinaturas (Claude Pro/Max, ChatGPT, Copilot) e **modelos LOCAIS** (§8), além do trio print/JSON/RPC para uso programático.

---

## 3. Concept Mapping

| Conceito (Protocolo) | Equivalente Pi | Implementação |
|---|---|---|
| Squad / Business | Diretório de skills + AGENTS.md | `~/.pi/agent/skills/<name>/` (global) ou `.agents/skills/` (projeto) + `AGENTS.md` do CWD |
| Capability | Skill (padrão Agent Skills) | `SKILL.md` com frontmatter `name`/`description`; forçável via `/skill:nome` |
| Employee | Persona embutida no prompt | persona-núcleo + DNA no corpo do prompt do `pi --mode json`; não é arquivo de agent |
| `is_brief_intake: true` | Persona default quando skill ativa | Montada no prompt / `AGENTS.md` |
| `is_antagonist: true` | Sub-process invocado em pipeline | `pi --mode json --provider <p> --model <m> "<persona+brief>"` |
| Handoff artifact | JSON nos eventos `message_end` + arquivo | Persistido em `<project>/.handoffs/` |
| Mention `@employee` | Convenção no handoff | Adapter detecta → novo sub-process |
| Ticket | Arquivo persistido | `<project>/.tickets/<TICKET_ID>.json` |
| Escalation trigger | Wrapper script + harness call | Wrapper checa condição → emite notification para harness |
| Permanent memory | `<project>/AGENTS.md` + files custom | Sem auto-load global rico |
| Project memory | `<project>/AGENTS.md` + `SYSTEM.md` | Convenção |
| Session memory | Árvore de sessão JSONL | Resume via `--session <id>`; fork via `--fork`; compaction automática nativa |
| Routing decision (harness) | Pre-spawn lookup table | BM25 sobre `capabilities[].examples[]` em wrapper Bun/Node |

---

## 4. Frontmatter Mapping

### Squad v5 / Business v1 → AGENTS.md

O pi lê `AGENTS.md` nativamente (context engineering minimalista). O adapter gera dois arquivos (mesma tática do Codex/Kimi):

```yaml
# AGENTS.md (head do projeto/skill)
You are an AI agent operating under the Squad/Business Protocol.

Available capabilities: [media.video.analyze, media.transcript.extract, ...]
Default tools: [Read, Write, Bash]
```

```yaml
# .agents/manifest.yaml (auxiliar — lido por wrapper, não pelo pi)
name: nexus-council
protocol: 1.0
employees: [ceo, marketing-lead, ...]
operation_mode: zero_human
```

### Employee → prompt do `pi --mode json`

Sem agent-profile por arquivo. A persona do employee é montada no prompt:

```
<persona-núcleo do employee (frontmatter → topo)>
<DNA do mind-clone — injectMindClones().combined_prompt>
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

- Built-in tools: `read`, `bash`, `edit`, `write` (+ `grep`, `find`, `ls` read-only, off por default). Tudo além disso vem de **extensões TypeScript**.
- Whitelist NATIVA por flag (confirmada no 0.82.1, vale para built-in + extension + custom tools):
  - `--tools, -t <a,b,c>` — allowlist por nome (`pi --tools read,grep,find,ls -p "..."` = modo read-only real).
  - `--exclude-tools, -xt <a,b>` — denylist.
  - `--no-tools, -nt` / `--no-builtin-tools, -nbt` — desligar tudo / só as built-in.
  - Skill frontmatter: campo `allowed-tools` do padrão Agent Skills (por skill).
- O driver não injeta `--tools` hoje (o contrato `allowedTools` do harness usa nomes do Claude — Write/Edit/Read — que não mapeiam 1:1); wrapper que precisar de safe-mode duro pode passar a flag direto.
- `-a/--approve` × `-na/--no-approve` controlam a confiança nos **arquivos locais do projeto** (extensões/settings de `.pi/`) — não é um permission-mode por tool. Headless: o driver passa `--approve` (full trust) ou `--no-approve` (`--safe`), porque sem TTY não há como responder o trust prompt.

---

## 6. Max-Turns Mechanics

O pi **não** expõe `--max-turns` per-employee. Adapter simula assim:

1. Cada employee roda como sub-process `pi --mode json`, com `timeout` do wrapper (`opts.timeoutMs` → `spawnSync`).
2. Contagem lógica de turns vem do handoff (o employee reporta steps executados) — ou dos eventos `turn_start`/`turn_end` do próprio JSONL, que o pi emite e o wrapper pode contar.
3. Estouro de timeout → o sub-process termina; o wrapper registra `audit_event: budget_violation`.

**Vantagem sobre kimi/grok:** os eventos `turn_*` do stream JSON dão contagem de turns REAL (não estimada), se o wrapper quiser enforçar.

---

## 7. Subagent Spawning

**Sem subagent primitive nativo** — decisão de design explícita do pi ("no built-in sub-agents"). O caminho é sub-process (`host-agent-driver.runPi`):

```bash
# Adapter spawn (host-agent-driver.runPi) — verificado contra pi 0.82.1
pi -p --mode json --session-id <uuid> --provider <provider> --model <model> --approve \
  "Review this offer: ..." \
  > .handoffs/alex-hormozi-$(date +%s).jsonl
```

Flags usadas pelo driver (todas confirmadas no `pi --help` 0.82.1 + run real):
- `-p --mode json` — event stream JSONL: header `{"type":"session","version":3,"id":"<uuid>","timestamp","cwd"}` + eventos (`agent_start`, `turn_start/end`, `message_start/update/end`, `tool_execution_*`, `agent_end`, `agent_settled`). O texto do assistant vem nos `message_end` (`message.content = [{type:"text",text}]`). **Builds sem `--mode`** → o driver detecta o erro de flag e **re-executa em print mode `-p`** (texto puro no stdout).
- `--session-id <uuid>` — sessão DETERMINÍSTICA ("exact project session ID, creating it if missing"): o driver gera o uuid no 1º run e o `nrv revise` retoma passando o MESMO id (padrão runGemini). Alternativas: `--session <path|id>` (lookup por UUID parcial), `--fork <path|id>` (branch), `-c/--continue` (mais recente).
- `--append-system-prompt <text>` — o `AUTONOMOUS_DIRECTIVE` vai como system prompt DE VERDADE (não dobrado no prompt do usuário como em codex/gemini/kimi/grok).
- `--model <pattern>` / `--provider <name>` — vêm SÓ da entrada `pi:<model>@<provider>` do cascade, nunca hardcoded. Sem eles, vale o default da config do usuário do pi (não necessariamente `google`, o default de fábrica).
- `--approve` / `--no-approve` — trust nos arquivos locais do projeto (ver §5).
- Prompt como argumento posicional; stdin também é aceito como conteúdo anexado (`cat file | pi -p "..."`) — cuidado em shells interativos: sem EOF no stdin o pi BLOQUEIA esperando input (o spawnSync do driver fecha o stdin, então o dispatch não sofre disso; em teste manual use `< /dev/null`).

**Detecção de erro (quirk importante):** o pi **sai com exit 0 mesmo quando o provider falha**. O erro vem no stream: `message.stopReason === "error"` + `message.errorMessage` (ex.: `403 "...used all available credits or reached its monthly spending limit"`). O `runPi` marca `ok=false` a partir do stream e propaga o `errorMessage` para o quota-detector (classificado como `quota_exhausted`/`auth_failed`/etc.). Custo real por turn em `message.usage.cost.total` (o driver soma).

**Para mention `@x`:** adapter detecta no handoff retornado, abre novo sub-process para `x`.

**Fan-out paralelo:** simulado ao nível do OS (sub-processes independentes), não dentro do pi. Alternativa avançada: **modo RPC** (`--mode rpc`, JSONL bidirecional em stdin/stdout) permite um driver persistente com steering/follow-up — não usado pelo driver atual (ver §13).

---

## 8. Memory Storage

| Camada | Path | Persistência |
|---|---|---|
| Permanent (cross-session) | `<project>/AGENTS.md` + files custom | Manual |
| Project | `<project>/AGENTS.md` + `SYSTEM.md` | Nativa (context engineering do pi) |
| Session | Árvore JSONL (`PI_SESSION_FILE`) | Nativa; resume/fork/navegação; compaction automática |
| Business permanent | `~/businesses/<biz>/memory/permanent.md` | Adapter persiste |
| Project (business) | `<project>/<biz>/<project_id>/memory/` | Isolation by construction |

**Autenticação (multi-provider — o coração do pi).** Resolução de credencial em ordem: flag `--api-key` > `~/.pi/agent/auth.json` > env var do provider > keys em `models.json`. Rotas:

- **API keys** — `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY`, `MISTRAL_API_KEY`, `DEEPSEEK_API_KEY`, … (envs padrão de cada provider).
- **OAuth de assinatura** — `/login` interativo: Claude Pro/Max, ChatGPT Plus/Pro, GitHub Copilot, xAI, OpenRouter. $0 marginal (cap da assinatura), igual ao trilho subscription dos outros runtimes.
- **MODELOS LOCAIS** — resposta direta à pergunta "o pi roda LLM local?": **sim, por três portas**:
  1. **Ollama** — provider suportado via `models.json` (endpoint local `http://localhost:11434`).
  2. **llama.cpp router server** — suporte dedicado: `/login llama.cpp` + gestão de modelos carregados com `/llama`.
  3. **Qualquer endpoint OpenAI-compatible** — LM Studio, vLLM, etc., registrado em `~/.pi/agent/models.json` (o pi fala OpenAI Completions, Anthropic Messages e Google Generative AI).
  Custo por token = $0 (hardware próprio); privacidade total (nada sai da máquina). Cascade: `pi:<modelo-local>@ollama`.

---

## 9. Context Window & Compaction

- Janela: **depende do modelo ativo** (200K Anthropic, 1M Gemini, local = config do servidor). O pi é a única porta do engine onde a janela é escolhida POR ENTRADA de cascade, não por runtime.
- Compaction: **automática nativa** — o pi compacta a sessão sozinho quando a janela aperta (parte do context engineering minimalista).
- Troca de modelo mid-session (`/model`, `Ctrl+L`) preserva a sessão — útil para escalar um brief travado para um modelo maior sem perder contexto.

---

## 10. Hook System

Sem hooks de shell. O equivalente funcional são **extensões TypeScript** (o pi recarrega com `/reload`):

| Hook desejado | Workaround Pi |
|---|---|
| `PreToolUse` | Extensão TypeScript interceptando tool events; ou persona como soft-validator + hard validation no wrapper |
| `PostToolUse` | Extensão, ou wrapper parseando os eventos `tool_execution_end` do JSONL |
| `UserPromptSubmit` | Adapter injeta instructions no prompt |
| `Stop` | Wrapper inspeciona `agent_end` + exit code |
| `SessionStart` | Wrapper carrega memory antes de invocar; ou `SYSTEM.md`/`AGENTS.md` |
| `Compact` | Compaction automática nativa (evento `compaction_start` no stream) |

---

## 11. Invocation Examples

### Exemplo 1 — Squad capability

```bash
# User: "transcrever vídeo do Instagram https://..."
# Harness wrapper:
pi --mode json --approve "You are instagram-intelligence. Analyze video: https://..." \
  > .handoffs/ii-1.jsonl
```

### Exemplo 2 — Business brief com handoff em pipeline (modelo local!)

```bash
# CEO no modelo local via Ollama (privacidade total, $0/token)
pi --mode json --provider ollama --model qwen3-coder --approve \
  "<persona ceo + brief + contrato JSON>" > .handoffs/ceo-1.jsonl

# Adapter detecta `next_action: delegate to marketing-lead` — resume a MESMA sessão
SESSION_ID=$(head -1 .handoffs/ceo-1.jsonl | jq -r .id)
pi --mode json --session "$SESSION_ID" --approve \
  "<persona marketing + contrato JSON>" > .handoffs/marketing-1.jsonl
```

### Exemplo 3 — Entradas de cascade (`.env`)

```dotenv
# pi como camada de resiliência multi-provider + fallback local infinito
LLM_CASCADE=claude-code:opus,pi:gpt-5.5@openai$10,pi:qwen3-coder@ollama
USE_PI="Quando precisar de modelos locais (Ollama/llama.cpp) ou de um provider fora dos CLIs oficiais"
```

---

## 12. Runtime-Specific Validators

- **Credencial do provider ATIVO**: a entrada `pi:<model>@<provider>` só é válida se o provider tem credencial resolvível (`auth.json`, env, `models.json`) — ou é local (ollama/llama.cpp rodando). Wrapper checa antes do spawn.
- **Model resolvível**: `<model>` tem que existir no catálogo do provider ou no `models.json`; erro vira `quota_exhausted` de TTL curto no quota-detector (cascade pula para a próxima entrada).
- **Endpoint local vivo**: para providers locais, provar `GET /v1/models` (ou equivalente) responde antes de despachar — servidor local caído é o erro mais comum.
- **Trust do projeto**: headless SEMPRE com `--approve` ou `--no-approve` explícito — nunca deixar o pi tentar perguntar num TTY que não existe.

---

## 13. Known Limitations

1. **Exit code NÃO sinaliza erro de provider** (verificado no 0.82.1): o pi sai com 0 mesmo com `stopReason: "error"` — quem checar só exit code declara sucesso falso. O `runPi` já detecta pelo stream; qualquer wrapper próprio TEM que fazer o mesmo.
2. **Schema dos eventos JSONL pode variar por build** (formato confirmado no 0.82.1) → o driver extrai session id e texto do assistant defensivamente; se nada parsear, mantém o stdout inteiro.
3. **Sem MCP nativo** (decisão de design) → mitigado pelo pacote `pi-mcp-adapter` (instalado, headless OK; servers ainda não exercitados). Squads que exigem `mcp` hard devem validar antes de declarar `pi`.
4. **Sem subagents nativos** → fan-out via sub-process, ou pacote `@pi9/subagent` (instalado, headless OK; orquestração ainda não exercitada).
4b. **Modelos locais pequenos (≤7B) NÃO sustentam o dispatch de business completo** — testado 2x com `qwen2.5-coder:7b` (prompt de employee de 92k chars): zero tool calls, entregável nunca escrito (verify reprovou honestamente); no 2º teste o modelo se perdeu na persona do DNA. Pacotes de contexto/planejamento não resolvem (o gargalo é o prompt inicial + capacidade). Uso correto do trilho local: fim do cascade, chamadas de julgamento curtas, tarefas mecânicas — não o topo da cascata de produção.
5. **Sem hooks de shell** → equivalente via extensões TypeScript (exige escrevê-las).
6. **Sem cron/ScheduleWakeup** → degradar para cron externo.
7. **Sem sandbox próprio** → containerizar quando isolamento importa (docs oficiais cobrem).
8. **Custo por token CONFIRMADO no stream** — `message.usage.cost.total` por turn do assistant (o driver soma). Budget `$N` do cascade funciona quando o provider reporta custo; trilhas OAuth de assinatura podem reportar 0.
9. **`--approve` semantics**: trust é sobre ARQUIVOS LOCAIS do projeto (extensões/settings), não um permission-mode por tool — não confundir com o `--dangerously-skip-permissions` do claude.
10. **Modo RPC não usado** pelo driver atual — sessões persistentes com steering ficam como evolução (§7).

**Vantagem compensatória:** um único runtime cobre 15+ providers + modelos locais ($0/token, 100% offline), com resume/fork de sessão nativo e trilha JSONL auditável — o melhor fit do engine para fallback-infinito e briefs privacy-sensitive.

---

## 14. Source References

- Site/instalação: `https://pi.dev` — `curl -fsSL https://pi.dev/install.sh | sh` ou `npm i -g --ignore-scripts @earendil-works/pi-coding-agent`.
- Docs: `https://pi.dev/docs/latest` — usage (flags), providers (auth, llama.cpp, models.json), json (event stream), rpc, skills (padrão Agent Skills), environment-variables (`PI_CODING_AGENT`, `PI_SESSION_ID`, `PI_SESSION_FILE`, `PI_PROVIDER`, `PI_MODEL`).
- Repo: `github.com/earendil-works/pi` (MIT).
- Driver: `skills/harness/lib/host-agent-driver.ts` (`runPi`); judge driver: `skills/_shared/lib/host-agent-driver.ts` (adapter `pi`).
- Squad Protocol v5: `~/.nirvana/skills/squads/SQUAD_PROTOCOL_V5.md`
- Business Protocol v1: `~/.nirvana/skills/businesses/BUSINESS_PROTOCOL_V1.md`
- Harness Protocol v1: `~/.nirvana/skills/harness/HARNESS_PROTOCOL_V1.md`

---

## 15. Version History

| Versão | Data | Mudanças |
|---|---|---|
| 1.0.0 | 2026-07-27 | Doc inicial — cobre Squad 5.0 + Business 1.0 + Harness 1.0 contra o Pi Coding Agent (pi.dev). Dispatch via `pi --mode json` (sub-process, JSONL→texto), resume nativo `--session`, multi-provider com modelos locais. Flags não verificadas contra binário real. |
| 1.1.0 | 2026-07-28 | **Verificado contra `pi 0.82.1`** (--help + run headless real). Driver migrado para `--session-id` determinístico + `--append-system-prompt` nativo; detecção de erro pelo stream (exit 0 no erro de provider — §13.1); custo real em `message.usage.cost.total`; tool whitelist nativa (`--tools`) documentada (§5). Caminho de SUCESSO verificado 100% local: Ollama + qwen2.5-coder:7b via `models.json`, com resume de sessão real. |
