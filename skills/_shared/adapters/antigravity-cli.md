# Adapter · Antigravity CLI (Google Antigravity 2.0)

> Runtime adapter for Squad Protocol v6 + Business Protocol v2 + Harness Protocol v1.
> Covers the 3 protocols in a single doc. Canonical sections per Squad Protocol v6 §18.5.
> System identity + capabilities (what Nirvana-OS is and can do): see `../NIRVANA-OS.md` (single source).

> **Successor to gemini-cli.** Announced at Google I/O 2026, Antigravity 2.0 **replaces gemini-cli** on the consumer tier from 2026-06-18. Same Google backend (Gemini models), different binary and flag conventions (`agy`). See [`gemini-cli.md`](./gemini-cli.md) (legacy).

---

## 1. Adapter Metadata

| Field | Value |
|---|---|
| `runtime` | `antigravity-cli` |
| `vendor` | Google |
| `min_version` | `2.0+` (Antigravity CLI), `google-genai` SDK `>=0.5` |
| `default_model` | inherited from the runtime. The engine NEVER sets a model; the user's runtime config decides. Pass a model only when the user explicitly asks. |
| `tested_against` | Antigravity 2.0 against Gemini 3 Pro |
| `config_paths` | `~/.gemini/config/hooks.json` (named hooks; Nirvana's is `nirvana-os`, a `PreInvocation` that injects the session context), `<project>/AGENTS.md`, `~/AGENTS.md` |
| `skills_root` | `~/.gemini/config/skills/<name>/` (read by agy, by the CLI and by the IDE; the CLI also reads `~/.gemini/antigravity-cli/skills/` and `<workspace>/.agents/skills/`). `~/.antigravity/skills` is not read by any of them |
| `agents_root` | `~/.antigravity/agents/<name>.md` or bundled in `<project>/.antigravity/agents/` |
| `memory_root` | `<project>/AGENTS.md` (project), `~/.antigravity/memory/` (custom) |
| `audit_log` | `~/.antigravity/sessions/` (transcripts), `~/.harness-logs/` (jsonl fallback) |
| `protocol_versions` | Squad 5.0, Business 1.0, Harness 1.0 (with gaps recorded in §13) |

---

## 2. Feature Support Matrix

`✓` = native · `~` = workaround/partial · `✗` = not supported

| Feature (Business v2 §6.5) | Squad v6 | Business v2 | Harness v1 | Notes |
|---|---|---|---|---|
| `max_turns` | ~ | ~ | ~ | global `--max-iterations` on the CLI; per-employee via wrapper |
| `tool_whitelist` | ✓ | ✓ | ✓ | Function calling whitelist + `--tools` flag |
| `subagent_spawning` | ✓ | ✓ | ✓ | native: dynamic subagents in-process via the local Agent Harness; Managed Agents for long runs; the `agy -p` sub-process is the fallback |
| `audit_trail` | ✓ | ✓ | ✓ | Session transcripts in `~/.antigravity/sessions/`; the harness adds OTel/jsonl |
| `scheduled_invocation` | ✗ | ✗ | ✗ | No `ScheduleWakeup`: external cron |
| `event_bus` | ~ | ~ | ~ | Mentions/tickets via file-system; no broker |
| `hooks` | ~ | ~ | ~ | Partial hooks; complex validation in a wrapper |
| `sandboxing` | ~ | ~ | ~ | Approval modes (Request Review / Proceed-in-Sandbox / Always-Proceed); profiles are being consolidated |
| `session_memory` | ✓ | ✓ | ✓ | Conversation context |
| `project_memory` | ✓ | ✓ | ✓ | `AGENTS.md` loaded at start |
| `global_memory` | ~ | ~ | ~ | `~/AGENTS.md` user-level, no rich auto-discovery |
| `handoff_artifacts` | ✓ | ✓ | ✓ | JSON in tool_result or in a persisted file |
| `fork_context` | ✓ | ✓ | ✓ | Dynamic subagents create an isolated context in-process |
| `teammate_primitive` | ~ | ~ | ~ | Managed Agents for long runs; a formal team via convention |
| `telemetry_otel` | ~ | ~ | ~ | Via an external OpenTelemetry SDK |

> **Note outside the canonical matrix:** Antigravity exposes its own SDK to orchestrate agents programmatically, besides the local Agent Harness that hosts the dynamic subagents. Covered in §7.

---

## 3. Concept Mapping

| Concept (Protocol) | Antigravity equivalent | Implementation |
|---|---|---|
| Squad / Business | Agents directory + AGENTS.md | `<project>/.antigravity/<name>/AGENTS.md` loads the "skill" |
| Capability | Workflow file | `<skill>/capabilities/<id>.md` invoked by a wrapper |
| Employee (seat) | Seat file played by the one business agent; optional Antigravity agent profile | A business runs as ONE solo agent (`skills/harness/lib/business-solo.ts`) that opens a seat's file when it works as that seat; `~/.antigravity/agents/<name>.md` (frontmatter + body) is only for a stand-alone subagent |
| `is_brief_intake: true` | Default agent when the skill is active | Configured in the skill's `AGENTS.md` |
| `is_antagonist: true` | Dynamic subagent in a pipeline | In-process spawn via the Agent Harness |
| Handoff artifact | JSON in a file + tool_result | Persisted in `<project>/.handoffs/` |
| Mention `@employee` | Convention in the prompt | The adapter resolves it to a subagent spawn |
| Ticket | Persisted file | `<project>/.tickets/<TICKET_ID>.json` |
| Escalation trigger | Wrapper script + harness call | The wrapper checks the condition → emits a notification to the harness |
| Permanent memory | `~/AGENTS.md` + custom files | Auto-loads only AGENTS.md |
| Project memory | `<project>/AGENTS.md` | Auto-load |
| Session memory | Conversation transcript | Compacted automatically |
| Routing decision (harness) | Pre-spawn lookup table | BM25 over `capabilities[].examples[]` in a Python/Node wrapper |

---

## 4. Frontmatter Mapping

### Squad v6 / Business v2 → AGENTS.md

Antigravity has no rich frontmatter in the skill head. The adapter generates two files:

```yaml
# AGENTS.md (head of the project/skill)
You are an AI agent operating under the Squad/Business Protocol.

Available capabilities: [media.video.analyze, media.transcript.extract, ...]
Default tools: [Read, Write, Bash]
```

```yaml
# .antigravity/manifest.yaml (auxiliary: read by a wrapper, not by the runtime)
name: nexus-council
protocol: 1.0
employees: [ceo, marketing-lead, ...]
operation_mode: zero_human
```

### Employee → Antigravity agent profile

```yaml
# ~/.antigravity/agents/alex-hormozi.md
---
name: alex-hormozi
description: Mind clone of Alex Hormozi for offer evaluation. (DISCLOSURE: AI-generated persona, not real person.)
model: inherit  # the engine does not pin a model; it uses the runtime's
tools: [Read, Grep, Bash]
max_iterations: 30
---

# System prompt
You are a mind-clone of Alex Hormozi specialized in offer evaluation...
```

> The adapter prepends `(DISCLOSURE: ...)` to the description when `type: mind_clone`.

---

## 5. Tool Whitelist Mechanics

- Antigravity uses function calling (Gemini backend). The adapter translates semantic tools → function declarations:
  - `read` → `read_file({path})`
  - `bash` → `execute_command({command})`
  - `web_fetch` → `fetch_url({url})`
- The whitelist is enforced in the list passed to the SDK (`tools=[...]`) or via `--tools`.
- The approval mode (§9) is an additional gate on commands that write.

---

## 6. Max-Turns Mechanics

Antigravity CLI has a global `--max-iterations N`, but not per-subagent. The adapter simulates it like this:

1. The wrapper spawns `agy -p "..." --max-iterations <N>` (or dispatches a native subagent with a per-agent limit).
2. `<N>` is read from the employee frontmatter (`maxTurns` / `max_iterations`).
3. Process exit or the wrapper detects the limit → emits `audit_event: budget_violation`.

**Limitation:** nested invocations via a dynamic subagent can escape the external wrapper's count. Documented as `~` (partial).

---

## 7. Subagent Spawning

**PRIMARY: native dynamic subagents.** Antigravity 2.0 spawns **in-process dynamic** subagents through a **local Agent Harness server**. When the maestro runs inside an `agy` session, it dispatches the work as a dynamic subagent hosted by the Agent Harness, in-process to that run, with no sub-process cold start. For long runs there are **Managed Agents** (they run in a managed/persistent way), and an **SDK** allows orchestrating agents programmatically.

**FALLBACK: `agy -p` sub-process.** For standalone scripts with no LLM context of their own (or sub-process-only runtimes), the adapter uses `agy -p` as a sub-process (`host-agent-driver.runAntigravity`):

```bash
# Adapter spawn (host-agent-driver.runAntigravity)
agy -p "Review this offer: ..." \
  --output-format json \
  > .handoffs/alex-hormozi-$(date +%s).json
```

Real flags used by the driver:
- `-p "<prompt>"`: headless prompt (one-shot). `-p` / `--print` / `--prompt` take the prompt as an argv value.
- `--output-format json`: a single JSON object (parity with `runGemini`/`runClaudeCode`). `stream-json` (NDJSON) also exists.
- `--resume <id>`: resumes the session (passed when `opts.sessionId` is set).
- `--model <id>`: model override (passed when `opts.model` is set).

The sub-process returns the handoff artifact on stdout. The adapter parses it and records it in the audit log.

> **Driver note:** the approval-mode flag (autonomous/yolo) is **not yet confirmed** in the research (`(internal knowledge base)` §5.3, modes Request Review / Proceed-in-Sandbox / Always-Proceed). `host-agent-driver.runAntigravity` carries a TODO: confirm with `agy --help` once authenticated, then map `opts.yolo !== false → Always-Proceed`.

**For a mention `@x`:** the adapter detects it in the returned handoff and spawns a new subagent (in-process) or sub-process for `x`.

---

## 8. Memory Storage

| Layer | Path | Persistence |
|---|---|---|
| Permanent (cross-session) | `~/AGENTS.md` + `~/.antigravity/memory/` (adapter convention) | Manual |
| Project | `<project>/AGENTS.md` | Auto-load |
| Session | Conversation transcript | Compacted |
| Business permanent | `~/businesses/<biz>/memory/permanent.md` | Adapter persists |
| Project (business) | `<project>/<biz>/<project_id>/memory/` | Isolation by construction |

> **Isolation guard:** Antigravity does not enforce memory isolation natively. The adapter builds the prompt with ONLY the memory relevant to the `project_id` before spawning, otherwise `audit_event: isolation_violation`.

---

## 9. Context Window & Compaction

- Window: 1M-2M tokens (Gemini 3 Pro/Flash), larger than Claude/Codex.
- Compaction: auto-summarization near the limit.
- **Approval modes** (Request Review / Proceed-in-Sandbox / Always-Proceed) govern whether commands that write ask for confirmation; they affect long autonomous runs.
- **Advantage:** the larger window reduces compaction pressure in long-running businesses.

---

## 10. Hook System

Antigravity has no mature granular hooks. Workarounds in a wrapper:

| Desired hook | Antigravity workaround |
|---|---|
| `PreToolUse` | Function declaration validation in the SDK |
| `PostToolUse` | The wrapper parses tool calls from the transcript after each turn |
| `UserPromptSubmit` | The adapter injects system instructions into the `agy -p` prompt |
| `Stop` | The wrapper inspects the exit code and the final transcript |
| `SessionStart` | The wrapper loads memory before invoking `agy` |
| `Compact` | `--checkpoint` flag (when available) |

---

## 11. Invocation Examples

### Example 1: Squad capability

```bash
agy -p "Analyze video: https://..." \
  --output-format json
```

### Example 2: Business brief with handoff in a pipeline

```bash
# The business runs as ONE solo agent (it plays the seats itself)
agy -p "<brief>" --output-format json > .handoffs/ceo-1.json

# Adapter detecta `next_action: delegate to marketing-lead`
agy -p "<context from ceo handoff>" --output-format json --resume <ceo-session-id> \
  > .handoffs/marketing-1.json

# Adapter detecta mention `@alex-hormozi`
agy -p "<context from marketing handoff>" --output-format json \
  > .handoffs/alex-1.json
```

### Example 3: Harness escalation

```bash
echo '{"type":"human_escalation_required","trigger_id":"budget","severity":"high",...}' \
  > .harness/notifications/$(date +%s).json
```

---

## 12. Runtime-Specific Validators

- **Coherent approval mode**: if employee.tools includes `Bash`, the approval mode must not be so restrictive that it blocks every write the brief expects.
- **Coherent function declarations**: tools in the whitelist need a valid declaration; the wrapper validates pre-spawn.
- **AGENTS.md loaded**: the adapter checks that the skill manifest is referenced in `AGENTS.md` (otherwise it does not load).
- **Supported model**: some features (rich function calling, code execution) vary by model. The adapter checks `model` in the employee frontmatter against the Antigravity capability matrix.

---

## 13. Known Limitations

1. **Approval-mode flag for autonomous runs not yet confirmed**: TODO in the driver (§7); confirm with an authenticated `agy --help`.
2. **No mature granular hooks**: validation in an external wrapper.
3. **No `ScheduleWakeup` / `CronCreate`**: external cron.
4. **No rich cross-session memory**: the adapter keeps memory in files and builds the prompt manually.
5. **Per-employee max-iterations is simulated**: nested subagent invocations can escape the wrapper's count.
6. **Mentions and tickets** depend on the wrapper detecting and fanning out; race conditions are possible in multi-process.
7. **OTel is not built-in**: the adapter integrates with an external OpenTelemetry SDK.
8. **Recent runtime (2.0)**: the flag/SDK surface can change between versions; test before each bump.

---

## 14. Source References

- Antigravity CLI spec (internal research): `(internal knowledge base)`
- Google Gen AI SDK: https://github.com/google-gemini/generative-ai-python
- Squad Protocol v6: `~/.nirvana/skills/squads/SQUAD_PROTOCOL_V6.md`
- Business Protocol v2: `~/.nirvana/skills/businesses/BUSINESS_PROTOCOL_V2.md`
- Harness protocol: `~/.nirvana/skills/harness/SKILL.md`

---

## 15. Version History

| Version | Date | Changes |
|---|---|---|
| 1.0.0 | 2026-06-06 | Doc inicial — successor to gemini-cli (sunset 2026-06-18); covers Squad 5.0 + Business 1.0 + Harness 1.0 against Antigravity 2.0 (Gemini 3 Pro) |
