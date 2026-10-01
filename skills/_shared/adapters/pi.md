# Adapter · Pi Coding Agent (Earendil, pi.dev)

> Runtime adapter for Squad Protocol v6 + Business Protocol v2 + Harness Protocol v1.
> Covers the 3 protocols in a single doc. Canonical sections per Squad Protocol v6 §18.5.
> System identity + capabilities (what Nirvana-OS is and can do): see `../NIRVANA-OS.md` (single source).
> Mirrors `kimi-cli.md` (sub-process dispatch, no per-file agent profile), with two heavy differences:
> **native session resume** (`--session <id>`) and **real multi-provider** (15+ providers, including LOCAL models).

---

## 1. Adapter Metadata

| Field | Value |
|---|---|
| `runtime` | `pi` |
| `vendor` | Earendil Inc. (pi.dev), MIT, npm `@earendil-works/pi-coding-agent` |
| `min_version` | `pi 0.82.1` (verified). `--mode json` required, with a fallback to print mode `-p` on builds without the flag (§7). |
| `default_model` | inherited from the runtime. The engine NEVER sets a model; it comes from the `pi:<model>@<provider>` entry of `LLM_CASCADE`. The `@provider` becomes a NATIVE `--provider` (anthropic, openai, google, openrouter, ollama, …). `--model` accepts `provider/id` and a `:<thinking>` suffix (e.g. `sonnet:high`). |
| `tested_against` | `pi 0.82.1` (2026-07-28): flags confirmed via `--help` AND real headless runs: (a) ERROR path (xai provider with no credits → exit 0 with `stopReason:"error"` in the stream, classified `quota_exhausted`); (b) 100% LOCAL SUCCESS path (`--provider ollama --model qwen2.5-coder:7b` via `models.json`): assistant text extracted from the stream, $0 cost, and a real session RESUME via `--session-id` (the 2nd call recovered the 1st call's context) |
| `config_paths` | `~/.pi/agent/` (`auth.json`, `models.json`, settings), `<project>/AGENTS.md`, `SYSTEM.md` |
| `skills_root` | **Agent Skills** standard (agentskills.io, same format as Claude Code): global in `~/.pi/agent/skills/` and `~/.agents/skills/`; per project in `.pi/skills/` and `.agents/skills/`. `nrv install` symlinks the Nirvana tree into `~/.pi/agent/skills/` when `~/.pi/agent` exists. |
| `agents_root` | No per-file agent profile (like Codex/Kimi); the persona goes in the `pi --mode json` prompt (§7). TypeScript extensions can define custom agents. |
| `memory_root` | `<project>/AGENTS.md` (project) + `SYSTEM.md`; sessions persisted as JSONL trees (`PI_SESSION_FILE`) |
| `audit_log` | `~/.harness-logs/` (jsonl via the driver) + pi's own JSONL session file (a navigable tree, exportable as HTML/gist) |
| `protocol_versions` | Squad 5.0, Business 1.0, Harness 1.0 (with gaps recorded in §13) |

---

## 2. Feature Support Matrix

`✓` = native · `~` = workaround/partial · `✗` = not supported

| Feature (Business v2 §6.5) | Squad v6 | Business v2 | Harness v1 | Notes |
|---|---|---|---|---|
| `max_turns` | ~ | ~ | ~ | No per-employee flag; the adapter simulates via sub-process timeout + count in the handoff |
| `tool_whitelist` | ✓ | ✓ | ✓ | NATIVE flags confirmed: `--tools/-t` (allowlist), `--exclude-tools/-xt` (denylist), `--no-tools/-nt`, `--no-builtin-tools/-nbt`; skills accept `allowed-tools` in the frontmatter |
| `subagent_spawning` | ~ | ~ | ~ | NO built-in subagents ("primitives, not features" philosophy). Fan-out via `pi --mode json` sub-process, OR via a package: `@pi9/subagent` installed (`pi install npm:@pi9/subagent`, asynchronous/recursive/resumable subagents; loads in headless without breaking the driver, orchestration not yet exercised) |
| `audit_trail` | ✓ | ✓ | ✓ | The whole session persisted as a JSONL tree (`PI_SESSION_FILE`); the harness adds its own jsonl via `runPi` |
| `scheduled_invocation` | ✗ | ✗ | ✗ | No native cron: degrade to external cron |
| `event_bus` | ~ | ~ | ~ | Mentions/tickets via file-system; RPC mode (JSONL stdin/stdout) allows an external broker in the future |
| `hooks` | ~ | ~ | ~ | No shell hook system; TypeScript extensions intercept agent events (functional equivalent, requires writing the extension) |
| `sandboxing` | ~ | ~ | ~ | No sandbox of its own; the official docs cover containerization: isolate via cwd + container |
| `session_memory` | ✓ | ✓ | ✓ | Tree sessions with navigation, bookmarks, `--fork` and native resume (`--session <id>`) |
| `project_memory` | ✓ | ✓ | ✓ | `AGENTS.md` in the project (convention shared with Codex/Antigravity/Kimi) + `SYSTEM.md` |
| `global_memory` | ~ | ~ | ~ | No rich auto-discovery like `~/.claude/memory/`; `~/.pi/agent/` holds global config/skills |
| `handoff_artifacts` | ✓ | ✓ | ✓ | JSON extracted from `message_end` events (JSONL), or plain text in the `-p` fallback |
| `fork_context` | ✓ | ✓ | ✓ | `--fork <path\|id>` creates a REAL fork of the session (better than a blind sub-process) |
| `teammate_primitive` | ✗ | ✗ | ✗ | No `TeamCreate`; a team is a convention via the file system |
| `telemetry_otel` | ~ | ~ | ~ | `PI_TELEMETRY` controls its own telemetry; OTel via an external SDK |
| `mcp` | ~ | ~ | ~ | NO native MCP (design decision), covered via a package: `pi-mcp-adapter` installed (`pi install npm:pi-mcp-adapter`; loads in headless without breaking the driver, servers not yet configured/exercised) |

> **Note outside the canonical matrix:** pi's big differentiator is **one runtime → 15+ providers** (Anthropic, OpenAI, Google, Azure, Bedrock, Mistral, Groq, Cerebras, xAI, Hugging Face, MiniMax, NVIDIA, OpenRouter, Ollama…), with OAuth for subscriptions (Claude Pro/Max, ChatGPT, Copilot) and **LOCAL models** (§8), plus the print/JSON/RPC trio for programmatic use.

---

## 3. Concept Mapping

| Concept (Protocol) | Pi equivalent | Implementation |
|---|---|---|
| Squad / Business | Skills directory + AGENTS.md | `~/.pi/agent/skills/<name>/` (global) or `.agents/skills/` (project) + the CWD's `AGENTS.md` |
| Capability | Skill (Agent Skills standard) | `SKILL.md` with `name`/`description` frontmatter; forceable via `/skill:name` |
| Employee (seat) | Persona embedded in the prompt | A business runs as ONE solo agent (`skills/harness/lib/business-solo.ts`) that plays the seats itself; core persona + DNA in the body of the `pi --mode json` prompt; not an agent file |
| `is_brief_intake: true` | Default persona when the skill is active | Built in the prompt / `AGENTS.md` |
| `is_antagonist: true` | Sub-process invoked in a pipeline | `pi --mode json --provider <p> --model <m> "<persona+brief>"` |
| Handoff artifact | JSON in `message_end` events + file | Persisted in `<project>/.handoffs/` |
| Mention `@employee` | Convention in the handoff | The adapter detects it → new sub-process |
| Ticket | Persisted file | `<project>/.tickets/<TICKET_ID>.json` |
| Escalation trigger | Wrapper script + harness call | The wrapper checks the condition → emits a notification to the harness |
| Permanent memory | `<project>/AGENTS.md` + custom files | No rich global auto-load |
| Project memory | `<project>/AGENTS.md` + `SYSTEM.md` | Convention |
| Session memory | JSONL session tree | Resume via `--session <id>`; fork via `--fork`; native automatic compaction |
| Routing decision (harness) | Pre-spawn lookup table | BM25 over `capabilities[].examples[]` in a Bun/Node wrapper |

---

## 4. Frontmatter Mapping

### Squad v6 / Business v2 → AGENTS.md

pi reads `AGENTS.md` natively (minimalist context engineering). The adapter generates two files (same tactic as Codex/Kimi):

```yaml
# AGENTS.md (head of the project/skill)
You are an AI agent operating under the Squad/Business Protocol.

Available capabilities: [media.video.analyze, media.transcript.extract, ...]
Default tools: [Read, Write, Bash]
```

```yaml
# .agents/manifest.yaml (auxiliary: read by a wrapper, not by pi)
name: nexus-council
protocol: 1.0
employees: [ceo, marketing-lead, ...]
operation_mode: zero_human
```

### Employee → `pi --mode json` prompt

No per-file agent profile. The employee persona is assembled in the prompt:

```
<employee core persona (frontmatter → top)>
<mind-clone DNA: injectMindClones().combined_prompt>
## Brief
<enriched brief>
## Allowed tools
<tool whitelist>
## Output contract
Reply ONLY with a single JSON object: {...}
```

> For `type: mind_clone`, the adapter **prepends** `(DISCLOSURE: AI-generated persona, not a real person.)` to the persona, same as Codex.

---

## 5. Tool Whitelist Mechanics

- Built-in tools: `read`, `bash`, `edit`, `write` (+ `grep`, `find`, `ls` read-only, off by default). Anything beyond that comes from **TypeScript extensions**.
- NATIVE whitelist by flag (confirmed on 0.82.1, applies to built-in + extension + custom tools):
  - `--tools, -t <a,b,c>`: allowlist by name (`pi --tools read,grep,find,ls -p "..."` = a real read-only mode).
  - `--exclude-tools, -xt <a,b>`: denylist.
  - `--no-tools, -nt` / `--no-builtin-tools, -nbt`: turn everything off / only the built-ins.
  - Skill frontmatter: the Agent Skills standard's `allowed-tools` field (per skill).
- The driver does not inject `--tools` today (the harness `allowedTools` contract uses Claude's names, Write/Edit/Read, which do not map 1:1); a wrapper that needs a hard safe mode can pass the flag directly.
- `-a/--approve` × `-na/--no-approve` control trust in the project's **local files** (`.pi/` extensions/settings); it is not a per-tool permission mode. Headless: the driver passes `--approve` (full trust) or `--no-approve` (`--safe`), because without a TTY there is no way to answer the trust prompt.

---

## 6. Max-Turns Mechanics

pi **does not** expose a per-employee `--max-turns`. The adapter simulates it like this:

1. Each employee runs as a `pi --mode json` sub-process, with the wrapper's `timeout` (`opts.timeoutMs` → `spawnSync`).
2. The logical turn count comes from the handoff (the employee reports the steps executed), or from the `turn_start`/`turn_end` events of the JSONL itself, which pi emits and the wrapper can count.
3. Timeout overrun → the sub-process ends; the wrapper records `audit_event: budget_violation`.

**Advantage over kimi/grok:** the `turn_*` events of the JSON stream give a REAL (not estimated) turn count, if the wrapper wants to enforce it.

---

## 7. Subagent Spawning

**No native subagent primitive**, an explicit pi design decision ("no built-in sub-agents"). The path is a sub-process (`host-agent-driver.runPi`):

```bash
# Adapter spawn (host-agent-driver.runPi), verified against pi 0.82.1
pi -p --mode json --session-id <uuid> --provider <provider> --model <model> --approve \
  "Review this offer: ..." \
  > .handoffs/alex-hormozi-$(date +%s).jsonl
```

Flags used by the driver (all confirmed in `pi --help` 0.82.1 + a real run):
- `-p --mode json`: JSONL event stream: header `{"type":"session","version":3,"id":"<uuid>","timestamp","cwd"}` + events (`agent_start`, `turn_start/end`, `message_start/update/end`, `tool_execution_*`, `agent_end`, `agent_settled`). The assistant text arrives in `message_end` (`message.content = [{type:"text",text}]`). **Builds without `--mode`** → the driver detects the flag error and **re-runs in print mode `-p`** (plain text on stdout).
- `--session-id <uuid>`: a DETERMINISTIC session ("exact project session ID, creating it if missing"): the driver generates the uuid on the 1st run and `nrv revise` resumes by passing the SAME id (runGemini pattern). Alternatives: `--session <path|id>` (lookup by partial UUID), `--fork <path|id>` (branch), `-c/--continue` (most recent).
- `--append-system-prompt <text>`: the `AUTONOMOUS_DIRECTIVE` goes as a REAL system prompt (not folded into the user prompt as in codex/gemini/kimi/grok).
- `--model <pattern>` / `--provider <name>`: they come ONLY from the `pi:<model>@<provider>` cascade entry, never hardcoded. Without them, the default of the user's pi config applies (not necessarily `google`, the factory default).
- `--approve` / `--no-approve`: trust in the project's local files (see §5).
- The prompt is a positional argument; stdin is also accepted as attached content (`cat file | pi -p "..."`). Careful in interactive shells: with no EOF on stdin pi BLOCKS waiting for input (the driver's spawnSync closes stdin, so dispatch does not suffer from this; in a manual test use `< /dev/null`).

**Error detection (important quirk):** pi **exits 0 even when the provider fails**. The error comes in the stream: `message.stopReason === "error"` + `message.errorMessage` (e.g. `403 "...used all available credits or reached its monthly spending limit"`). `runPi` marks `ok=false` from the stream and propagates the `errorMessage` to the quota-detector (classified as `quota_exhausted`/`auth_failed`/etc.). Real cost per turn is in `message.usage.cost.total` (the driver sums it).

**For a mention `@x`:** the adapter detects it in the returned handoff and opens a new sub-process for `x`.

**Parallel fan-out:** simulated at the OS level (independent sub-processes), not inside pi. Advanced alternative: **RPC mode** (`--mode rpc`, bidirectional JSONL on stdin/stdout) allows a persistent driver with steering/follow-up; not used by the current driver (see §13).

---

## 8. Memory Storage

| Layer | Path | Persistence |
|---|---|---|
| Permanent (cross-session) | `<project>/AGENTS.md` + custom files | Manual |
| Project | `<project>/AGENTS.md` + `SYSTEM.md` | Native (pi's context engineering) |
| Session | JSONL tree (`PI_SESSION_FILE`) | Native; resume/fork/navigation; automatic compaction |
| Business permanent | `~/businesses/<biz>/memory/permanent.md` | Adapter persists |
| Project (business) | `<project>/<biz>/<project_id>/memory/` | Isolation by construction |

**Authentication (multi-provider, the heart of pi).** Credential resolution in order: `--api-key` flag > `~/.pi/agent/auth.json` > the provider's env var > keys in `models.json`. Routes:

- **API keys**: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY`, `MISTRAL_API_KEY`, `DEEPSEEK_API_KEY`, … (each provider's standard envs).
- **Subscription OAuth**: interactive `/login`: Claude Pro/Max, ChatGPT Plus/Pro, GitHub Copilot, xAI, OpenRouter. $0 marginal (subscription cap), same as the subscription track of the other runtimes.
- **LOCAL MODELS**: a direct answer to "does pi run a local LLM?": **yes, through three doors**:
  1. **Ollama**: provider supported via `models.json` (local endpoint `http://localhost:11434`).
  2. **llama.cpp router server**: dedicated support: `/login llama.cpp` + management of loaded models with `/llama`.
  3. **Any OpenAI-compatible endpoint**: LM Studio, vLLM, etc., registered in `~/.pi/agent/models.json` (pi speaks OpenAI Completions, Anthropic Messages and Google Generative AI).
  Per-token cost = $0 (own hardware); total privacy (nothing leaves the machine). Cascade: `pi:<local-model>@ollama`.

---

## 9. Context Window & Compaction

- Window: **depends on the active model** (200K Anthropic, 1M Gemini, local = server config). pi is the only door of the engine where the window is chosen PER cascade entry, not per runtime.
- Compaction: **native and automatic**: pi compacts the session by itself when the window tightens (part of the minimalist context engineering).
- Switching model mid-session (`/model`, `Ctrl+L`) preserves the session, useful to escalate a stuck brief to a bigger model without losing context.

---

## 10. Hook System

No shell hooks. The functional equivalent is **TypeScript extensions** (pi reloads with `/reload`):

| Desired hook | Pi workaround |
|---|---|
| `PreToolUse` | A TypeScript extension intercepting tool events; or persona as a soft validator + hard validation in the wrapper |
| `PostToolUse` | An extension, or a wrapper parsing the JSONL `tool_execution_end` events |
| `UserPromptSubmit` | The adapter injects instructions into the prompt |
| `Stop` | The wrapper inspects `agent_end` + the exit code |
| `SessionStart` | The wrapper loads memory before invoking; or `SYSTEM.md`/`AGENTS.md` |
| `Compact` | Native automatic compaction (`compaction_start` event in the stream) |

---

## 11. Invocation Examples

### Example 1: Squad capability

```bash
# User: "transcrever vídeo do Instagram https://..."
# Harness wrapper:
pi --mode json --approve "You are instagram-intelligence. Analyze video: https://..." \
  > .handoffs/ii-1.jsonl
```

### Example 2: Business brief with handoff (local model!)

```bash
# The business agent on a local model via Ollama (total privacy, $0/token)
pi --mode json --provider ollama --model qwen3-coder --approve \
  "<business persona + brief + JSON contract>" > .handoffs/nexus-1.jsonl

# A follow-up resumes the SAME session
SESSION_ID=$(head -1 .handoffs/nexus-1.jsonl | jq -r .id)
pi --mode json --session "$SESSION_ID" --approve \
  "<follow-up instruction + JSON contract>" > .handoffs/nexus-2.jsonl
```

### Example 3: Cascade entries (`.env`)

```dotenv
# pi as a multi-provider resilience layer + endless local fallback
LLM_CASCADE=claude-code:opus,pi:gpt-5.5@openai$10,pi:qwen3-coder@ollama
USE_PI="Quando precisar de modelos locais (Ollama/llama.cpp) ou de um provider fora dos CLIs oficiais"
```

---

## 12. Runtime-Specific Validators

- **ACTIVE provider's credential**: the `pi:<model>@<provider>` entry is only valid if the provider has a resolvable credential (`auth.json`, env, `models.json`), or is local (ollama/llama.cpp running). The wrapper checks before spawning.
- **Resolvable model**: `<model>` has to exist in the provider catalog or in `models.json`; an error becomes a short-TTL `quota_exhausted` in the quota-detector (the cascade skips to the next entry).
- **Live local endpoint**: for local providers, prove that `GET /v1/models` (or equivalent) answers before dispatching; a downed local server is the most common error.
- **Project trust**: headless ALWAYS with an explicit `--approve` or `--no-approve`; never let pi try to ask on a TTY that does not exist.

---

## 13. Known Limitations

1. **The exit code does NOT signal a provider error** (verified on 0.82.1): pi exits 0 even with `stopReason: "error"`, so whoever checks only the exit code declares a false success. `runPi` already detects it from the stream; any wrapper of your own MUST do the same.
2. **The JSONL event schema may vary by build** (format confirmed on 0.82.1) → the driver extracts the session id and the assistant text defensively; if nothing parses, it keeps the whole stdout.
3. **No native MCP** (design decision) → mitigated by the `pi-mcp-adapter` package (installed, headless OK; servers not yet exercised). Squads that require `mcp` as a hard need must validate before declaring `pi`.
4. **No native subagents** → fan-out via sub-process, or the `@pi9/subagent` package (installed, headless OK; orchestration not yet exercised).
4b. **Small local models (<=7B) do NOT sustain a full business dispatch**: tested 2x with `qwen2.5-coder:7b` (92k-char employee prompt): zero tool calls, deliverable never written (verify honestly failed); in the 2nd test the model got lost in the DNA persona. Context/planning packages do not solve it (the bottleneck is the initial prompt + capacity). Correct use of the local track: the end of the cascade, short judgment calls, mechanical tasks, not the top of the production cascade.
5. **No shell hooks** → equivalent via TypeScript extensions (requires writing them).
6. **No cron/ScheduleWakeup** → degrade to external cron.
7. **No sandbox of its own** → containerize when isolation matters (the official docs cover it).
8. **Per-token cost CONFIRMED in the stream**: `message.usage.cost.total` per assistant turn (the driver sums it). The cascade's `$N` budget works when the provider reports cost; subscription OAuth tracks may report 0.
9. **`--approve` semantics**: trust is about the project's LOCAL FILES (extensions/settings), not a per-tool permission mode; do not confuse it with claude's `--permission-mode`.
10. **RPC mode not used** by the current driver: persistent sessions with steering remain an evolution (§7).

**Compensating advantage:** a single runtime covers 15+ providers + local models ($0/token, 100% offline), with native session resume/fork and an auditable JSONL trail, the engine's best fit for endless fallback and privacy-sensitive briefs.

---

## 14. Source References

- Site/install: `https://pi.dev`, `curl -fsSL https://pi.dev/install.sh | sh` or `npm i -g --ignore-scripts @earendil-works/pi-coding-agent`.
- Docs: `https://pi.dev/docs/latest`: usage (flags), providers (auth, llama.cpp, models.json), json (event stream), rpc, skills (Agent Skills standard), environment-variables (`PI_CODING_AGENT`, `PI_SESSION_ID`, `PI_SESSION_FILE`, `PI_PROVIDER`, `PI_MODEL`).
- Repo: `github.com/earendil-works/pi` (MIT).
- Driver: `skills/harness/lib/host-agent-driver.ts` (`runPi`); judge driver: `skills/_shared/lib/host-agent-driver.ts` (adapter `pi`).
- Squad Protocol v6: `~/.nirvana/skills/squads/SQUAD_PROTOCOL_V6.md`
- Business Protocol v2: `~/.nirvana/skills/businesses/BUSINESS_PROTOCOL_V2.md`
- Harness protocol: `~/.nirvana/skills/harness/SKILL.md`

---

## 15. Version History

| Version | Date | Changes |
|---|---|---|
| 1.0.0 | 2026-07-27 | Initial doc: covers Squad 5.0 + Business 1.0 + Harness 1.0 against the Pi Coding Agent (pi.dev). Dispatch via `pi --mode json` (sub-process, JSONL→text), native `--session` resume, multi-provider with local models. Flags not verified against the real binary. |
| 1.1.0 | 2026-07-28 | **Verified against `pi 0.82.1`** (--help + real headless run). Driver migrated to a deterministic `--session-id` + native `--append-system-prompt`; error detection from the stream (exit 0 on provider error, §13.1); real cost in `message.usage.cost.total`; native tool whitelist (`--tools`) documented (§5). SUCCESS path verified 100% local: Ollama + qwen2.5-coder:7b via `models.json`, with a real session resume. |
