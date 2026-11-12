# Adapter · Pi Coding Agent (Earendil, pi.dev)

> Runtime adapter for Squad Protocol v6 + Business Protocol v2 + Harness Protocol v1.
> Covers the 3 protocols in a single doc. Canonical sections per Squad Protocol v6 §18.5.
> System identity + capabilities (what Nirvana-OS is and can do): see `../NIRVANA-OS.md` (single source).
> Mirrors `kimi-cli.md` (sub-process dispatch, no per-file agent profile), with two heavy differences:
> **native session resume** (`--session-id <id>`) and **real multi-provider** (15+ providers, including LOCAL models).

Flags below were checked on 2026-10-11 against `pi --help` and `dist/cli/args.js` of the installed 0.84.3, the package docs, and the 1.x CHANGELOG and `docs/cli.md` on `earendil-works/pi` main. 1.1.0 itself was not run here.

---

## 1. Adapter Metadata

| Field | Value |
|---|---|
| `runtime` | `pi` |
| `vendor` | Earendil Inc. (pi.dev), MIT, npm `@earendil-works/pi-coding-agent` (the old `@mariozechner/pi-coding-agent` stops at 0.73.1) |
| `min_version` | `pi 0.82.1` (headless verified). Target 1.1.0 (2026-10-07); 1.0.0 shipped 2026-10-01. Installed here: 0.84.3. `--mode json` with a fallback to plain `-p` on builds without it (§7). |
| `default_model` | Inherited from the runtime. The engine never sets a model; it comes from the `pi:<model>@<provider>` entry of `LLM_CASCADE`. `--model` accepts `provider/id` and a `:<thinking>` suffix (e.g. `sonnet:high`). The `@provider` becomes `--provider` only together with `--model` (§7). |
| `tested_against` | `pi 0.82.1` (2026-07-28): `--help` plus real headless runs: (a) ERROR path (xai provider with no credits → exit 0 with `stopReason:"error"` in the stream, classified `quota_exhausted`); (b) LOCAL SUCCESS path (`--provider ollama --model qwen2.5-coder:7b` via `models.json`), assistant text from the stream, $0 cost, real resume via `--session-id`. 0.84.3 (2026-10-11): `--help` and `args.js` re-read, no run. |
| `config_paths` | `~/.pi/agent/` (`settings.json`, `auth.json`, `models.json`, `mcp.json`, `trust.json`, `SYSTEM.md`, `APPEND_SYSTEM.md`); project `.pi/settings.json`, `.pi/mcp.json`, `.pi/SYSTEM.md`, `AGENTS.md`/`CLAUDE.md` |
| `skills_root` | Agent Skills standard. Global `~/.pi/agent/skills/` **and** `~/.agents/skills/`; project `.pi/skills/` and `.agents/skills/` from the cwd up to the git root (project roots only once the project is trusted). Same name in two roots: pi warns and keeps the first one found. `nrv install` links the engine into `~/.pi/agent/skills/`, and into `~/.agents/skills/` for OpenClaw, so with both present every Nirvana skill shows up twice and pi logs one collision warning per skill (§13). |
| `agents_root` | No per-file agent profile; the persona goes in the prompt and the directive in `--append-system-prompt` (§7). Extensions can define agents. |
| `memory_root` | `<project>/AGENTS.md` (also `CLAUDE.md`) + `SYSTEM.md`/`APPEND_SYSTEM.md`; sessions persisted as JSONL trees (`PI_SESSION_FILE`) |
| `audit_log` | `~/.harness-logs/` (jsonl via the driver) + pi's own session JSONL (a navigable tree, `--export` to HTML) |
| `protocol_versions` | Squad 5.0, Business 1.0, Harness 1.0 (with gaps recorded in §13) |

---

## 2. Feature Support Matrix

`✓` = native · `~` = workaround/partial · `✗` = not supported

| Feature (Business v2 §6.5) | Squad v6 | Business v2 | Harness v1 | Notes |
|---|---|---|---|---|
| `max_turns` | ~ | ~ | ~ | No turn flag; the adapter uses the sub-process timeout, and the JSON stream's `turn_start`/`turn_end` events give a real count |
| `tool_whitelist` | ✓ | ✓ | ✓ | `--tools/-t` (allowlist; 1.1.0 also takes `+name`/`-name` deltas), `--exclude-tools/-xt` (denylist; `*` patterns since 1.0.4), `--no-tools/-nt`, `--no-builtin-tools/-nbt`. The engine passes none of them today (§5) |
| `subagent_spawning` | ~ | ~ | ~ | No built-in sub-agents. Fan-out via `pi -p --mode json` sub-processes, or a package such as `@pi9/subagent` (installed here; orchestration not exercised) |
| `audit_trail` | ✓ | ✓ | ✓ | Whole session as a JSONL tree; the harness adds its own jsonl via `runPi` |
| `scheduled_invocation` | ✗ | ✗ | ✗ | No native cron: degrade to external cron |
| `event_bus` | ~ | ~ | ~ | Mentions/tickets via the file system; RPC mode (JSONL on stdin/stdout) could host a broker |
| `hooks` | ~ | ~ | ~ | No shell hooks; TypeScript extensions subscribe to agent events (`tool_call`, `agent_settled`, ...) |
| `sandboxing` | ~ | ~ | ~ | No OS sandbox; codemode scripts run in a QuickJS sandbox, but its tools (`bash`, `write`) reach the host. Isolate via cwd + container |
| `session_memory` | ✓ | ✓ | ✓ | Tree sessions, `--session-id`, `--session`, `--fork`, `--continue`; `--no-session` for ephemeral runs |
| `project_memory` | ✓ | ✓ | ✓ | `AGENTS.md`/`CLAUDE.md` in the project + `SYSTEM.md` |
| `global_memory` | ~ | ~ | ~ | `~/.pi/agent/` holds global config, skills and `SYSTEM.md`; no auto-memory |
| `handoff_artifacts` | ✓ | ✓ | ✓ | JSON from the last assistant `message_end` event, or plain text in the `-p` fallback |
| `fork_context` | ✓ | ✓ | ✓ | `--fork <path\|id>` creates a real fork of a session |
| `teammate_primitive` | ✗ | ✗ | ✗ | No team primitive; a team is a file-system convention |
| `telemetry_otel` | ~ | ~ | ~ | `PI_TELEMETRY` covers install/update telemetry only; OTel via an extension or external SDK |
| `mcp` | ✓ | ✓ | ✓ | Built in since 0.99.0: stdio and streamable HTTP servers with OAuth from `~/.pi/agent/mcp.json` and, in trusted projects, `.pi/mcp.json`; `pi mcp add\|remove\|list\|login\|logout`; `--no-mcp` turns it off for one run. An extension that registers `/mcp` (e.g. `pi-mcp-adapter`, installed here) replaces the built-in support |

> **Note outside the canonical matrix:** pi's differentiator is **one runtime → 15+ providers** (Anthropic, OpenAI, Google, Azure, Bedrock, Mistral, Groq, Cerebras, xAI, OpenRouter, Ollama, ...), OAuth for subscriptions (Claude Pro/Max, ChatGPT, Copilot), **LOCAL models** (§8), the print/JSON/RPC trio, and since 0.99 **codemode**: a `codemode` tool that runs model-written JavaScript in QuickJS and calls pi's tools in parallel (enable with `--tools +codemode` or `"defaultTools": ["+codemode"]`).

---

## 3. Concept Mapping

| Concept (Protocol) | Pi equivalent | Implementation |
|---|---|---|
| Squad / Business | Skills directory + AGENTS.md | `~/.pi/agent/skills/<name>/` (global) or `.agents/skills/` (project) + the CWD's `AGENTS.md` |
| Capability | Skill (Agent Skills standard) | `SKILL.md` with `name`/`description` frontmatter; forceable via `/skill:name` |
| Employee (seat) | Persona embedded in the prompt | A business runs as ONE solo agent (`skills/harness/lib/business-solo.ts`) that plays the seats itself; core persona + DNA in the prompt body |
| `is_brief_intake: true` | Default persona when the skill is active | Built in the prompt / `AGENTS.md` |
| `is_antagonist: true` | Sub-process invoked in a pipeline | `pi -p --mode json --model <m> --provider <p> --approve -- "<persona+brief>"` |
| Handoff artifact | JSON in `message_end` events + file | Persisted in `<project>/.handoffs/` |
| Mention `@employee` | Convention in the handoff | The adapter detects it → new sub-process |
| Ticket | Persisted file | `<project>/.tickets/<TICKET_ID>.json` |
| Escalation trigger | Wrapper script + harness call | The wrapper checks the condition → emits a notification to the harness |
| Permanent memory | `<project>/AGENTS.md` + custom files | No global auto-memory |
| Project memory | `<project>/AGENTS.md` + `SYSTEM.md` | Native load |
| Session memory | JSONL session tree | Resume via `--session-id`; fork via `--fork`; automatic compaction |
| Routing decision (harness) | Pre-spawn lookup table | BM25 over `capabilities[].examples[]` in a Bun wrapper |

---

## 4. Frontmatter Mapping

### Squad v6 / Business v2 → AGENTS.md

pi reads `AGENTS.md` natively (`--no-context-files` turns that off). The adapter keeps the same two files as Codex/Kimi:

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

### Employee → `pi -p --mode json` prompt

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

- Default tools: `read`, `bash`, `edit`, `write`, unless the `defaultTools` setting changes them. `grep`, `find`, `ls`, `codemode` and `tool_search` are off by default. Extensions add more.
- Flags (apply to built-in, extension and custom tools):
  - `--tools, -t <a,b,c>`: plain names replace the selection (`pi --tools read,grep,find,ls -p "..."` is a real read-only mode). 1.1.0: a list of only `+name`/`-name` entries edits the default selection instead (`-t +codemode,-write`); the two forms cannot be mixed.
  - `--exclude-tools, -xt <a,b>`: denylist; `*` patterns since 1.0.4.
  - `--no-tools, -nt` / `--no-builtin-tools, -nbt`: turn everything off / only the built-ins.
  - MCP tools (1.x): `--tools` keeps them unless an entry starts with `mcp__` (`--tools read,codemode,'mcp__radius__*'`); remove them with `--exclude-tools 'mcp__*'` or `--no-mcp`.
  - Skill frontmatter: the Agent Skills `allowed-tools` field.
- The driver passes none of these today. The harness `allowedTools` contract uses Claude's names (Write/Edit/Read), which do not map 1:1; `noTools` could map to `--no-tools`.
- `-a/--approve` × `-na/--no-approve` decide trust in project-local configuration and resources (`.pi/settings.json`, `.pi` extensions, project skills, `.pi/mcp.json`) for one run. They are not a per-tool permission mode. Non-interactive modes (`-p`, `--mode json`, `--mode rpc`) never show the trust prompt; without a saved decision in `~/.pi/agent/trust.json` they follow `defaultProjectTrust` (`ask`, the default, and `never` ignore project resources; `always` trusts them). The driver always passes one of the two flags, so the outcome does not depend on that setting.

---

## 6. Max-Turns Mechanics

pi has no turn or spend flag. The adapter:

1. Runs each employee as a `pi -p --mode json` sub-process with the driver's timeout (`opts.timeoutMs` → `spawnSync`).
2. Can count `turn_start`/`turn_end` events from the stream for a real count, if a wrapper wants to enforce one.
3. On timeout overrun, ends the sub-process and records `audit_event: budget_violation`.

Effort exists as a flag: `--thinking off|minimal|low|medium|high|xhigh|max` (overrides a `:<thinking>` model suffix, clamped to the model). The engine does not pass it yet: `EFFORT_CAPABLE` holds only claude-code and codex, so profiles do not reach pi.

---

## 7. Subagent Spawning

**No native subagent primitive** ("no built-in sub-agents"). The path is a sub-process (`host-agent-driver.runPi`). The argv it builds:

```bash
pi -p --mode json --session-id <uuid> [--append-system-prompt <directive>] \
  [--model <model> [--provider <provider>]] --approve|--no-approve \
  -- "<prompt>"
# above MAX_ARGV_PROMPT_BYTES the last part becomes:
#   -- @<tmpfile> "The attached file contains the complete task prompt. ..."
```

- `-p --mode json`: one-shot run, JSONL on stdout: header `{"type":"session","version":3,"id":"<uuid>","timestamp","cwd"}`, then `agent_start`, `turn_start/end`, `message_start/update/end`, `tool_execution_*`, `agent_end`, `agent_settled` (1.1.0 adds `aborted` to `agent_settled`, which tells a cancelled run from a finished one; the driver does not read it yet). The assistant text is in `message_end` (`message.content = [{type:"text",text}]`); the last assistant one wins. If the run fails on `--mode`/unknown/unrecognized/invalid option, the driver reruns as plain `-p` and keeps the text stdout. Since 0.87.1 an invalid `--mode` value exits non-zero instead of being ignored.
- `--session-id <uuid>`: "exact project session ID, creating it if missing". The driver generates the id on the first run and `nrv revise` resumes with the same id. Cannot be combined with `--session`, `--continue` or `--resume`.
- `--append-system-prompt <text>`: the `AUTONOMOUS_DIRECTIVE` as a real system prompt. The flag also takes a file path and can repeat; the driver passes text today.
- `--model <pattern>`: only from the cascade entry; without it, the user's pi default applies.
- `--provider <name>`: passed **only together with `--model`**. Since 1.0.0 `--provider` without `--model` "now fails with an error" (it was silently ignored before). When the cascade names a provider but no model, the driver drops the flag and warns: `pi: --provider <p> needs --model (pi 1.0.0 rejects it alone); not passed, pi used its configured provider`.
- `--approve` (default) / `--no-approve` (when `yolo === false`, i.e. `--safe`): project trust for this run (§5).
- `--`: ends option parsing, so a brief that starts with `-` or `---` (a bullet, YAML front matter) stays a message (`pi -p -- "- Summarize"`). An `@path` after `--` is still an attachment: verified in 0.84.3 `dist/cli/args.js`, where post-`--` arguments starting with `@` go to `fileArgs`.
- No directory grant flag (`RUNTIME_DIR_GRANT_FLAG.pi = null`); a dispatch with `addDirs` carries a warning.
- stdin: piped content is prepended to the first prompt. The driver's `spawnSync` closes stdin; in a manual test use `< /dev/null`, otherwise pi waits for EOF.

The light-layer adapter (judge driver, `RUNTIMES` entry `pi`) builds `pi -p --no-approve [--append-system-prompt <persona>] -- <message | @file + note>` and reads plain text.

**Error detection (important quirk):** pi **exits 0 even when the provider fails**. The error comes in the stream: `message.stopReason === "error"` + `message.errorMessage` (e.g. `403 "...used all available credits or reached its monthly spending limit"`). `runPi` marks `ok=false` from the stream (a later successful turn clears it) and passes `errorMessage` to the quota detector. Cost per turn is `message.usage.cost.total`, summed by the driver.

**For a mention `@x`:** the adapter detects it in the returned handoff and opens a new sub-process for `x`.

**Parallel fan-out:** at the OS level (independent sub-processes). RPC mode (`--mode rpc`, bidirectional JSONL; rejects `@file` arguments) allows a persistent worker with steering; not used by the driver.

**Orca visible worker.** `orca-worker.ts` opens `pi [--model <model>]`.

---

## 8. Memory Storage

| Layer | Path | Persistence |
|---|---|---|
| Permanent (cross-session) | `<project>/AGENTS.md` + custom files | Manual |
| Project | `<project>/AGENTS.md` + `SYSTEM.md` | Native |
| Session | JSONL tree (`PI_SESSION_FILE`, unset for `--no-session`) | Native; resume/fork/navigation; automatic compaction |
| Business permanent | `~/businesses/<biz>/memory/permanent.md` | Adapter persists |
| Project (business) | `<project>/<biz>/<project_id>/memory/` | Isolation by construction |

**Authentication (multi-provider).** Order: `--api-key` (needs `--model`) > `~/.pi/agent/auth.json` > the provider's env var > keys in `models.json`. Routes:

- **API keys**: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY`, `XAI_API_KEY`, `OPENROUTER_API_KEY`, `DEEPSEEK_API_KEY`, `AZURE_OPENAI_*`, ...
- **Subscription OAuth**: interactive `/login` (Claude Pro/Max, ChatGPT, GitHub Copilot, ...). $0 marginal within the subscription cap.
- **Provider rename (1.0.3, breaking):** `azure-openai-responses` is now `azure`. Rename it in `auth.json`, `models.json`, `settings.json` and in any cascade entry (`pi:<model>@azure`). The `AZURE_OPENAI_*` env vars are unchanged.
- **LOCAL MODELS**, three doors:
  1. **Ollama** via `models.json` (endpoint `http://localhost:11434`).
  2. **llama.cpp router server**: built-in provider (`/login llama.cpp`, `/llama`).
  3. **Any OpenAI-compatible endpoint** (LM Studio, vLLM) registered in `~/.pi/agent/models.json`.
  Per-token cost $0; nothing leaves the machine. Cascade: `pi:<local-model>@ollama`.

Standalone binaries stopped loading `.env` files from the launch directory in 1.1.0; keys have to come from the real environment or `auth.json`.

---

## 9. Context Window & Compaction

- Window: **depends on the active model** (200K Anthropic, 1M Gemini, local = server config). pi is the one door where the window is chosen per cascade entry, not per runtime.
- Compaction: automatic (`compaction_start`/`compaction_end` events in the stream).
- Switching model mid-session (`/model`) keeps the session.

---

## 10. Hook System

No shell hooks. The functional equivalent is **TypeScript extensions** (reloaded with `/reload`):

| Desired hook | Pi workaround |
|---|---|
| `PreToolUse` | An extension handling `tool_call`; or persona as a soft validator + hard validation in the wrapper |
| `PostToolUse` | An extension, or a wrapper parsing `tool_execution_end` events |
| `UserPromptSubmit` | The adapter injects instructions into the prompt |
| `Stop` | The wrapper inspects `agent_settled` + the exit code |
| `SessionStart` | The wrapper loads memory before invoking; or `SYSTEM.md`/`AGENTS.md` |
| `Compact` | Automatic compaction (`compaction_start` in the stream) |

---

## 11. Invocation Examples

### Example 1: Squad capability

```bash
# User: "transcrever vídeo do Instagram https://..."
pi -p --mode json --approve -- "You are instagram-intelligence. Analyze video: https://..." \
  > .handoffs/ii-1.jsonl
```

### Example 2: Business brief with handoff (local model)

```bash
# The business agent on a local model via Ollama ($0/token, nothing leaves the machine)
SID=$(uuidgen)
pi -p --mode json --session-id "$SID" --model qwen3-coder --provider ollama --approve \
  -- "<business persona + brief + JSON contract>" > .handoffs/nexus-1.jsonl

# A follow-up resumes the SAME session
pi -p --mode json --session-id "$SID" --model qwen3-coder --provider ollama --approve \
  -- "<follow-up instruction + JSON contract>" > .handoffs/nexus-2.jsonl
```

### Example 3: Cascade entries (`.env`)

```dotenv
# pi as a multi-provider resilience layer + endless local fallback
LLM_CASCADE=claude-code:opus,pi:gpt-6.1-sol@openai$10,pi:qwen3-coder@ollama
USE_PI="Quando precisar de modelos locais (Ollama/llama.cpp) ou de um provider fora dos CLIs oficiais"
```

Every `pi:` entry that names a provider must also name a model; `pi:@openai` alone ends up without `--provider` (§7).

---

## 12. Runtime-Specific Validators

- **Version**: `pi --version`. Below 1.0.0, `--provider` alone is ignored rather than rejected; below 0.99, no built-in MCP or codemode.
- **ACTIVE provider's credential**: the `pi:<model>@<provider>` entry is only valid if the provider has a credential (`auth.json`, env, `models.json`) or is local and running. `pi auth` checks provider readiness.
- **Resolvable model**: `<model>` has to exist in the provider catalog or `models.json` (`pi --list-models <search>`); an error becomes a short-TTL `quota_exhausted` and the cascade moves on.
- **Live local endpoint**: for local providers, check `GET /v1/models` (or equivalent) before dispatching.
- **Project trust**: headless ALWAYS with an explicit `--approve` or `--no-approve`.
- **MCP**: `pi mcp list` connects every enabled server and exits 1 when one fails. If `pi-mcp-adapter` is installed, it owns `/mcp` and pi ignores `mcp.json`.
- **Duplicate skills**: if both `~/.pi/agent/skills/` and `~/.agents/skills/` hold Nirvana links, expect one collision warning per skill.

---

## 13. Known Limitations

1. **The exit code does NOT signal a provider error** (verified on 0.82.1): pi exits 0 with `stopReason: "error"`. `runPi` detects it from the stream; any wrapper of your own MUST do the same.
2. **The JSONL schema may vary by build** (confirmed on 0.82.1; 1.1.0 adds `agent_settled.aborted`) → the driver parses defensively and keeps the whole stdout if nothing parses.
3. **Duplicate skill exposure**: the engine links into `~/.pi/agent/skills/` and, for OpenClaw, `~/.agents/skills/`; pi reads both and keeps the first copy with a warning.
4. **MCP shadowed by an extension**: an installed `pi-mcp-adapter` replaces the built-in MCP support of 0.99+; remove it after upgrading to use `mcp.json`.
5. **No native subagents** → fan-out via sub-process, or the `@pi9/subagent` package (installed, not exercised).
6. **Small local models (<=7B) do NOT sustain a full business dispatch**: tested 2x with `qwen2.5-coder:7b` (92k-char employee prompt): zero tool calls, deliverable never written. Use the local track at the end of the cascade, for short judgment calls and mechanical tasks.
7. **Engine flags not wired**: `--thinking`, `--no-tools`/`--tools`/`--exclude-tools` and `--no-session` exist but the driver passes none of them.
8. **Directive travels as argv**: `--append-system-prompt <text>` adds about 3 KB to the command line; on the Windows `.cmd` route the whole line caps at 8,191 chars. The flag accepts a file path, which would remove the risk.
9. **No shell hooks** → TypeScript extensions.
10. **No cron, no OS sandbox** → external cron; containerize when isolation matters.
11. **Cost from the stream**: `message.usage.cost.total` per assistant turn; subscription OAuth tracks may report 0.
12. **`--approve` semantics**: trust in project-local files and resources, not a per-tool permission mode.
13. **RPC mode not used** by the driver.

**Compensating advantage:** one runtime covers 15+ providers + local models ($0/token, offline), with built-in MCP and codemode, native session resume/fork and an auditable JSONL trail. It is the engine's best fit for endless fallback and privacy-sensitive briefs.

---

## 14. Source References

- Site/install: `https://pi.dev`, `curl -fsSL https://pi.dev/install.sh | sh` (pinned dependencies) or `npm i -g --ignore-scripts @earendil-works/pi-coding-agent` (no shrinkwrap since 1.0.2).
- Docs: `https://pi.dev/docs/latest` and `packages/coding-agent/docs/` in the repo: `cli` (flags, tools, sessions, resources), `mcp`, `codemode`, `settings` (project trust), `skills`, `json` (event stream), `rpc`, `providers`, `environment-variables` (`PI_CODING_AGENT`, `PI_SESSION_ID`, `PI_SESSION_FILE`, `PI_PROVIDER`, `PI_MODEL`, `PI_OFFLINE`, `PI_TELEMETRY`).
- Changelog: `https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/CHANGELOG.md`.
- Repo: `github.com/earendil-works/pi` (MIT).
- Driver: `skills/_shared/lib/host-agent-driver.ts` (`runPi`, light-layer adapter `pi`); Orca worker: `skills/_shared/lib/orca-worker.ts`; skill links: `skills/_shared/lib/runtime-dirs.ts`.
- Squad Protocol v6: `~/.nirvana/skills/squads/SQUAD_PROTOCOL_V6.md`
- Business Protocol v2: `~/.nirvana/skills/businesses/BUSINESS_PROTOCOL_V2.md`
- Harness protocol: `~/.nirvana/skills/harness/SKILL.md`

---

## 15. Version History

| Version | Date | Changes |
|---|---|---|
| 1.0.0 | 2026-07-27 | Initial doc: covers Squad 5.0 + Business 1.0 + Harness 1.0 against the Pi Coding Agent (pi.dev). Dispatch via `pi --mode json` (sub-process, JSONL→text), native `--session` resume, multi-provider with local models. Flags not verified against the real binary. |
| 1.1.0 | 2026-07-28 | **Verified against `pi 0.82.1`** (--help + real headless run). Driver migrated to a deterministic `--session-id` + native `--append-system-prompt`; error detection from the stream (exit 0 on provider error, §13.1); real cost in `message.usage.cost.total`; native tool whitelist (`--tools`) documented (§5). SUCCESS path verified 100% local: Ollama + qwen2.5-coder:7b via `models.json`, with a real session resume. |
| 1.2.0 | 2026-10-11 | Updated to pi 1.1.0. Driver argv: the prompt goes after `--` (`@file` still attaches, verified in 0.84.3 `args.js`); `--provider` only with `--model`, dropped with a warning otherwise (pi 1.0.0 rejects it alone). Documented built-in MCP (0.99) and codemode, trust rules for `-p`/json/rpc, `--thinking`, `--no-tools`/`--tools` (+/- deltas)/`--exclude-tools`, `--no-mcp`, `--no-session`, the `azure-openai-responses`→`azure` rename, both global skill roots and the duplicate-name warning. Removed the "no native MCP" claim; cascade example uses `gpt-6.1-sol`. |
