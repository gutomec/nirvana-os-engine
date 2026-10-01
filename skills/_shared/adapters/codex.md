# Adapter · Codex (OpenAI Codex CLI)

> Runtime adapter for Squad Protocol v6 + Business Protocol v2 + Harness Protocol v1.
> Covers the 3 protocols in a single doc. Canonical sections per Squad Protocol v6 §18.5.
> System identity + capabilities (what Nirvana-OS is and can do): see `../NIRVANA-OS.md` (single source).

---

## 1. Adapter Metadata

| Field | Value |
|---|---|
| `runtime` | `codex` |
| `vendor` | OpenAI |
| `min_version` | `0.20+` (Codex CLI), OpenAI SDK `>=1.50` |
| `default_model` | inherited from the runtime. The engine NEVER sets a model; the user's runtime config decides. Pass a model only when the user explicitly asks. |
| `tested_against` | Codex CLI 0.2x — runtime default model / chosen by the user (the engine never pins a model) |
| `config_paths` | `~/.codex/config.toml`, `<project>/AGENTS.md`, `~/AGENTS.md` |
| `skills_root` | No native skill system: the adapter uses `~/.codex/skills/<name>/` (convention) or flat `~/.codex/agents/` |
| `agents_root` | `~/.codex/agents/<name>.md` or bundled in `<project>/.codex/agents/` |
| `memory_root` | `<project>/AGENTS.md` (project), `~/.codex/memory/` (custom). Codex has no native cross-session memory |
| `audit_log` | `~/.codex/sessions/` (transcripts), `~/.harness-logs/` (jsonl fallback) |
| `protocol_versions` | Squad 5.0, Business 1.0, Harness 1.0 (with gaps recorded in §13) |

---

## 2. Feature Support Matrix

`✓` = native · `~` = workaround/partial · `✗` = not supported

| Feature (Business v2 §6.5) | Squad v6 | Business v2 | Harness v1 | Notes |
|---|---|---|---|---|
| `max_turns` | ~ | ~ | ~ | Codex has a global `--max-turns` on the CLI; the adapter has to simulate per-employee via a wrapper script |
| `tool_whitelist` | ✓ | ✓ | ✓ | Function-calling whitelist via OpenAI tool definitions; sandbox gating native |
| `subagent_spawning` | ✓ | ✓ | ✓ | native via `[agents]` in `~/.codex/config.toml` (`agents.max_depth` default 1, explicit-only, `/agent`); the `runCodex` sub-process is the fallback |
| `audit_trail` | ✓ | ✓ | ✓ | Session transcripts in `~/.codex/sessions/`, the harness adds OTel/jsonl |
| `scheduled_invocation` | ✗ | ✗ | ✗ | No `ScheduleWakeup`/`CronCreate`: degrade to external cron |
| `event_bus` | ~ | ~ | ~ | Mentions/tickets via file-system; no broker |
| `hooks` | ~ | ~ | ~ | Codex has `--profile` and `instructions` but no granular hooks (`PreToolUse`, etc.) |
| `sandboxing` | ✓ | ✓ | ✓ | Native sandbox (`workspace-write`, `read-only`, `danger-full-access`) |
| `session_memory` | ✓ | ✓ | ✓ | Conversation context per session |
| `project_memory` | ✓ | ✓ | ✓ | `AGENTS.md` in the project (automatic load) |
| `global_memory` | ~ | ~ | ~ | `~/AGENTS.md` user-level, without the rich auto-discovery of `~/.claude/memory/` |
| `handoff_artifacts` | ✓ | ✓ | ✓ | JSON structure in tool_result or in a persisted file |
| `fork_context` | ~ | ~ | ~ | Sub-process spawn creates a fork but without strong isolation |
| `teammate_primitive` | ✗ | ✗ | ✗ | No `TeamCreate`; a team is a convention via the file system |
| `telemetry_otel` | ~ | ~ | ~ | OTel via an external OpenTelemetry SDK (not built-in) |

---

## 3. Concept Mapping

| Concept (Protocol) | Codex equivalent | Implementation |
|---|---|---|
| Squad / Business | Agents directory + AGENTS.md | `<project>/.codex/<name>/AGENTS.md` loads the "skill" |
| Capability | Workflow file | `<skill>/capabilities/<id>.md` invoked by a wrapper |
| Employee (seat) | Seat file played by the one business agent; optional Codex agent profile | A business runs as ONE solo agent (`skills/harness/lib/business-solo.ts`) that opens a seat's file when it works as that seat; a profile `~/.codex/agents/<name>.md` (frontmatter + body) is only needed for a stand-alone subagent |
| `is_brief_intake: true` | Default agent when the skill is active | Configured in the skill's `AGENTS.md` |
| `is_antagonist: true` | Sub-process invoked in a pipeline | `codex run --agent <name> --prompt "..."` |
| Handoff artifact | JSON in a file + tool_result | Persisted in `<project>/.handoffs/` |
| Mention `@employee` | Convention in the prompt | The adapter resolves it to a sub-process spawn |
| Ticket | Persisted file | `<project>/.tickets/<TICKET_ID>.json` |
| Escalation trigger | Wrapper script + harness call | The wrapper checks the condition → emits a notification to the harness |
| Permanent memory | `~/AGENTS.md` + custom files | Codex auto-loads only AGENTS.md |
| Project memory | `<project>/AGENTS.md` | Auto-load |
| Session memory | Conversation transcript | Codex compacts automatically |
| Routing decision (harness) | Pre-spawn lookup table | BM25 over `capabilities[].examples[]` in a Python/Node wrapper |

---

## 4. Frontmatter Mapping

### Squad v6 / Business v2 → AGENTS.md

Codex has no rich frontmatter. The adapter generates two files:

```yaml
# AGENTS.md (head of the project/skill)
You are an AI agent operating under the Squad/Business Protocol.

Available capabilities: [media.video.analyze, media.transcript.extract, ...]
Default tools: [Read, Write, Bash]
Sandbox: workspace-write
```

```yaml
# .codex/manifest.yaml (auxiliary: read by a wrapper, not by Codex)
name: nexus-council
protocol: 1.0
employees: [ceo, marketing-lead, ...]
operation_mode: zero_human
```

### Employee → Codex agent profile

```yaml
# ~/.codex/agents/alex-hormozi.md
---
name: alex-hormozi
description: Mind clone of Alex Hormozi for offer evaluation. (DISCLOSURE: AI-generated persona, not real person.)
model: inherit  # the engine does not pin a model; it uses the runtime's
tools: [Read, Grep, Bash]
sandbox: read-only
---

# System prompt
You are a mind-clone of Alex Hormozi specialized in offer evaluation...
```

> The adapter prepends `(DISCLOSURE: ...)` to the description when `type: mind_clone`.

---

## 5. Tool Whitelist Mechanics

- Codex uses OpenAI function-calling. The adapter translates semantic tools → function definitions:
  - `read` → `read_file({path})`
  - `bash` → `run_command({command})`
  - `web_fetch` → `fetch_url({url})`
- The whitelist is enforced in the list passed to the API (`tools=[...]`).
- The sandbox profile (`workspace-write` / `read-only` / `danger-full-access`) is an additional gate.

---

## 6. Max-Turns Mechanics

Codex CLI has a global `--max-turns N`, but not per-subagent. The adapter simulates it like this:

1. The wrapper spawns `codex run --max-turns <N> --agent <name> --prompt "..."`.
2. `<N>` is read from the employee frontmatter (`maxTurns`).
3. Process exit code != 0 when it exceeds → the harness emits `audit_event: budget_violation`.

**Limitation:** if an employee invokes another employee internally (without returning to the adapter), the adapter loses the count. Documented as `~` (partial). Codex employees are recommended to be flat (no nested invocation).

---

## 7. Subagent Spawning

**PRIMARY: native Codex subagents.** Codex now has native subagents: `[agents]` blocks in `~/.codex/config.toml`, with `agents.max_depth` (default 1), **explicit-only** delegation and the `/agent` command. When the maestro runs inside an interactive/headless `codex run`, it dispatches the work as a native subagent (in-process to that run), with no sub-process cold start. Ref: https://developers.openai.com/codex/subagents.

```toml
# ~/.codex/config.toml
[agents.alex-hormozi]
description = "Mind clone of Alex Hormozi for offer evaluation."
model = "inherit"  # the engine does not pin a model; it uses the runtime's
# agents.max_depth default 1: delegation is explicit-only (/agent)
```

**FALLBACK: `codex exec` sub-process.** For standalone scripts with no LLM context of their own, the adapter uses `codex exec` as a sub-process with an isolated scope:

```bash
# Adapter spawn (pseudocode)
codex run \
  --agent alex-hormozi \
  --max-turns 30 \
  --sandbox read-only \
  --output-format json \
  --prompt "Review this offer: ..." \
  > .handoffs/alex-hormozi-$(date +%s).json
```

The sub-process returns the handoff artifact on stdout. The adapter parses it and records it in the audit log.

> **Driver note:** `host-agent-driver.runCodex` currently **always** uses the sub-process fallback (`codex exec`). This doc describes native subagents as the primary path; doc-ahead-of-driver is acceptable until the driver is updated.

**For a mention `@x`:** the adapter detects it in the returned handoff and opens a new sub-process for `x`.

---

## 8. Memory Storage

| Layer | Path | Persistence |
|---|---|---|
| Permanent (cross-session) | `~/AGENTS.md` + `~/.codex/memory/` (adapter convention) | Manual |
| Project | `<project>/AGENTS.md` | Auto-load |
| Session | Conversation transcript | Compacted |
| Business permanent | `~/businesses/<biz>/memory/permanent.md` | Adapter persists |
| Project (business) | `<project>/<biz>/<project_id>/memory/` | Isolation by construction |

> **Isolation guard:** Codex does not enforce memory isolation natively. The adapter must build the prompt with ONLY the memory relevant to the `project_id` before spawning, otherwise `audit_event: isolation_violation`.

---

## 9. Context Window & Compaction

- Window: 128K-200K tokens, varying with the model the runtime is using.
- Compaction: Codex has auto-summarization near the limit; the adapter can force `--checkpoint` first.

---

## 10. Hook System

Codex has no granular hooks. Workarounds:

| Desired hook | Codex workaround |
|---|---|
| `PreToolUse` | A function definition can carry a `description` that acts as a soft validator; hard validation in a wrapper |
| `PostToolUse` | The wrapper parses tool calls from the transcript after each turn |
| `UserPromptSubmit` | The adapter injects `instructions` into the `codex run` prompt |
| `Stop` | The wrapper inspects the exit code and the final transcript |
| `SessionStart` | The wrapper loads memory before invoking `codex run` |
| `Compact` | `--checkpoint` flag |

---

## 11. Invocation Examples

### Example 1: Squad capability

```bash
# User: "transcrever vídeo do Instagram https://..."
# Harness wrapper:
codex run \
  --agent instagram-intelligence \
  --skill media.video.analyze \
  --max-turns 20 \
  --prompt "Analyze video: https://..." \
  --output-format json
```

### Example 2: Business brief with handoff

```bash
# The business runs as ONE solo agent that plays the seats itself
codex run --agent nexus-council --max-turns 40 --prompt "<brief>" > .handoffs/nexus-1.json

# A stand-alone subagent (optional) is only spawned for an explicit mention `@alex-hormozi`
codex run --agent alex-hormozi --max-turns 15 \
  --prompt "<context from the business handoff>" > .handoffs/alex-1.json
```

### Example 3: Harness escalation

```bash
# Wrapper detecta budget_violation
echo '{"type":"human_escalation_required","trigger_id":"budget","severity":"high",...}' \
  > .harness/notifications/$(date +%s).json
# The harness orchestrator (in another runtime or interactive) consumes the file
```

---

## 12. Runtime-Specific Validators

- **Coherent sandbox profile**: if employee.tools includes `Bash`, the sandbox must be `workspace-write` or `danger-full-access` (not `read-only`).
- **Function definition match**: every tool in the whitelist needs a valid function definition; the wrapper validates before spawning.
- **AGENTS.md loaded**: the adapter checks that `AGENTS.md` references `manifest.yaml` correctly (otherwise Codex does not see the skill).

---

## 13. Known Limitations

1. **No subagent primitive** (for the fallback path) → the adapter uses the `codex run` sub-process. Cost: each spawn pays cold start overhead.
2. **No granular hooks** → validation in an external wrapper, not inline.
3. **No `ScheduleWakeup` / `CronCreate`** → the harness degrades to external cron.
4. **No rich cross-session memory** → the adapter keeps memory in files and builds the prompt manually.
5. **Per-employee max-turns is simulated** → assumes flat employees (no nested invocation).
6. **No `TeamCreate`** → teams are a file-system convention.
7. **OTel is not built-in** → the adapter integrates with an external OpenTelemetry SDK.
8. **Mentions and tickets** depend on the wrapper detecting and fanning out; race conditions are possible in multi-process.
9. **Slash commands** do not exist natively; the adapter uses CLI flags (`--agent`, `--skill`, `--prompt`).

---

## 14. Source References

- Codex CLI docs: https://platform.openai.com/docs/codex
- OpenAI SDK: https://github.com/openai/openai-python
- Squad Protocol v6: `~/.nirvana/skills/squads/SQUAD_PROTOCOL_V6.md`
- Business Protocol v2: `~/.nirvana/skills/businesses/BUSINESS_PROTOCOL_V2.md`
- Harness protocol: `~/.nirvana/skills/harness/SKILL.md`

---

## 15. Version History

| Version | Date | Changes |
|---|---|---|
| 1.0.0 | 2026-05-02 | Initial doc: covers Squad 5.0 + Business 1.0 + Harness 1.0 against Codex CLI 0.2x |
