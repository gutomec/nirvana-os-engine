# Adapter · Gemini CLI

> Runtime adapter for Squad Protocol v6 + Business Protocol v2 + Harness Protocol v1.
> Covers the 3 protocols in a single doc. Canonical sections per Squad Protocol v6 §18.5.
> System identity + capabilities (what Nirvana-OS is and can do): see `../NIRVANA-OS.md` (single source).

> **LEGACY: sunset on 2026-06-18.** Gemini CLI was discontinued. Its successor is **antigravity-cli** (binary `agy`, see [`antigravity-cli.md`](./antigravity-cli.md)), which keeps the Google/Gemini backend but adds **native in-process dynamic subagents** (via the local Agent Harness). Gemini CLI dispatch stays **sub-process** (`gemini run`); for new installs on the consumer tier, prefer antigravity-cli.

---

## 1. Adapter Metadata

| Field | Value |
|---|---|
| `runtime` | `gemini-cli` |
| `vendor` | Google |
| `min_version` | `0.4+` (Gemini CLI), `google-genai` SDK `>=0.5` |
| `default_model` | inherited from the runtime. The engine NEVER sets a model; the user's runtime config decides. Pass a model only when the user explicitly asks. |
| `tested_against` | Gemini CLI 0.4-0.6 against Gemini 2.5 Pro |
| `config_paths` | `~/.gemini/settings.json`, `<project>/GEMINI.md`, `<project>/.gemini/config.toml` |
| `skills_root` | No formal skill system; the adapter uses `~/.gemini/skills/<name>/` (convention) |
| `agents_root` | `~/.gemini/agents/<name>.md` (experimental) or bundled in `<project>/.gemini/agents/` |
| `memory_root` | `<project>/GEMINI.md` (project), `~/.gemini/memory/` (custom) |
| `audit_log` | `~/.gemini/sessions/` (experimental), `~/.harness-logs/` (jsonl fallback) |
| `protocol_versions` | Squad 5.0, Business 1.0, Harness 1.0 (with gaps recorded in §13) |

---

## 2. Feature Support Matrix

`✓` = native · `~` = workaround/partial · `✗` = not supported

| Feature (Business v2 §6.5) | Squad v6 | Business v2 | Harness v1 | Notes |
|---|---|---|---|---|
| `max_turns` | ~ | ~ | ~ | `--max-iterations` on the CLI; per-employee via wrapper |
| `tool_whitelist` | ✓ | ✓ | ✓ | Function calling whitelist + `--tools` flag |
| `subagent_spawning` | ~ | ~ | ~ | `gemini agent` (experimental) or the `gemini run` sub-process; no isolation primitive |
| `audit_trail` | ~ | ~ | ~ | Experimental session transcripts; the harness adds OTel/jsonl |
| `scheduled_invocation` | ✗ | ✗ | ✗ | No `ScheduleWakeup`: external cron |
| `event_bus` | ✗ | ~ | ~ | Mentions/tickets via file-system; no broker |
| `hooks` | ✗ | ✗ | ✗ | No hook system; workaround in a wrapper |
| `sandboxing` | ~ | ~ | ~ | Optional container-based sandbox (`--sandbox`), limited profiles compared to Codex |
| `session_memory` | ✓ | ✓ | ✓ | Conversation context |
| `project_memory` | ✓ | ✓ | ✓ | `GEMINI.md` loaded at start |
| `global_memory` | ~ | ~ | ~ | `~/GEMINI.md` user-level, no rich auto-discovery |
| `handoff_artifacts` | ✓ | ✓ | ✓ | JSON in tool_result or in a persisted file |
| `fork_context` | ~ | ~ | ~ | Sub-process spawn |
| `teammate_primitive` | ✗ | ✗ | ✗ | Sem `TeamCreate` |
| `telemetry_otel` | ~ | ~ | ~ | Via OpenTelemetry SDK externo |

> **Note outside the canonical matrix:** Gemini CLI supports MCP servers (experimental) registered in `~/.gemini/mcp/`. It is not one of the 15 features of Business v2 §6.5, but it is worth having as an extra vector for custom tools. Covered in §5 and §13.

---

## 3. Concept Mapping

| Concept (Protocol) | Gemini CLI equivalent | Implementation |
|---|---|---|
| Squad / Business | Directory + GEMINI.md | `<project>/.gemini/<name>/GEMINI.md` loads the "skill" |
| Capability | Workflow file | `<skill>/capabilities/<id>.md` invoked by a wrapper or via a Gemini CLI slash command |
| Employee (seat) | Seat file played by the one business agent; optional Gemini agent profile | A business runs as ONE solo agent (`skills/harness/lib/business-solo.ts`) that opens a seat's file when it works as that seat; `~/.gemini/agents/<name>.md` (experimental) is only for a stand-alone subagent |
| `is_brief_intake: true` | Default agent when the skill is active | `default_agent` in settings.json |
| `is_antagonist: true` | Sub-process invoked in a pipeline | `gemini run --agent <name> --prompt "..."` |
| Handoff artifact | JSON in a file + tool_result | `<project>/.handoffs/` |
| Mention `@employee` | Convention in the prompt | The adapter resolves it to a sub-process spawn |
| Ticket | Persisted file | `<project>/.tickets/<TICKET_ID>.json` |
| Escalation trigger | Wrapper script + harness call | The wrapper checks the condition → emits a notification |
| Permanent memory | `~/GEMINI.md` + custom files | Auto-loads only GEMINI.md |
| Project memory | `<project>/GEMINI.md` | Auto-load |
| Session memory | Conversation transcript | Compacted |
| Routing decision (harness) | Pre-spawn lookup | BM25 over `capabilities[].examples[]` in a wrapper |

---

## 4. Frontmatter Mapping

### Squad v6 / Business v2 → GEMINI.md

```markdown
# GEMINI.md (head of the project/skill)
You are an AI agent operating under the Squad/Business Protocol.

Available capabilities: [media.video.analyze, media.transcript.extract, ...]
Default tools: [Read, Write, Bash]
Sandbox: enabled
```

```yaml
# .gemini/manifest.yaml (auxiliary, read by a wrapper)
name: nexus-council
protocol: 1.0
employees: [ceo, marketing-lead, ...]
operation_mode: zero_human
```

### Employee → Gemini agent profile

```yaml
# ~/.gemini/agents/alex-hormozi.md
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

- Gemini uses function calling. The adapter translates semantic tools → function declarations:
  - `read` → `read_file({path})`
  - `bash` → `execute_command({command})`
  - `web_fetch` → `fetch_url({url})`
- The whitelist is enforced in the list passed to the SDK (`tools=[...]`).
- MCP servers (experimental) registered via `~/.gemini/mcp/` appear as additional tools; the adapter can include/exclude them by the `mcp__<server>__` prefix.

---

## 6. Max-Turns Mechanics

Gemini CLI has a global `--max-iterations N`. The adapter simulates per-employee like this:

1. The wrapper spawns `gemini run --max-iterations <N> --agent <name> --prompt "..."`.
2. `<N>` is read from the employee frontmatter (`maxTurns`).
3. Process exit or the wrapper detects the limit → emits `audit_event: budget_violation`.

Limitation: nested invocations escape the count. Documented as `~`.

---

## 7. Subagent Spawning

Gemini CLI has an experimental `gemini agent`. The adapter prefers the robust sub-process approach:

```bash
gemini run \
  --agent alex-hormozi \
  --max-iterations 30 \
  --output-format json \
  --prompt "Review this offer: ..." \
  > .handoffs/alex-hormozi-$(date +%s).json
```

When the `gemini agent` API stabilizes, the adapter can migrate to in-process spawn. For v1: sub-process.

---

## 8. Memory Storage

| Layer | Path | Persistence |
|---|---|---|
| Permanent (cross-session) | `~/GEMINI.md` + `~/.gemini/memory/` (adapter convention) | Manual |
| Project | `<project>/GEMINI.md` | Auto-load |
| Session | Conversation transcript | Compacted |
| Business permanent | `~/businesses/<biz>/memory/permanent.md` | Adapter persists |
| Project (business) | `<project>/<biz>/<project_id>/memory/` | Isolation by construction |

> **Isolation guard:** Gemini CLI does not enforce memory isolation. The adapter builds the prompt with ONLY the memory relevant to the `project_id`. Otherwise it emits `audit_event: isolation_violation`.

---

## 9. Context Window & Compaction

- Window: 1M-2M tokens (Gemini 2.5 Pro/Flash), larger than Claude/Codex.
- Compaction: auto-summarization near the limit.
- **Advantage:** the larger window reduces compaction pressure in long-running businesses.

---

## 10. Hook System

Gemini CLI has no granular hooks. Workarounds in a wrapper:

| Desired hook | Gemini CLI workaround |
|---|---|
| `PreToolUse` | Function declaration validation in the SDK |
| `PostToolUse` | The wrapper parses tool calls from the transcript after each turn |
| `UserPromptSubmit` | The adapter injects system instructions into the `gemini run` prompt |
| `Stop` | The wrapper inspects the exit code and the final transcript |
| `SessionStart` | The wrapper loads memory before invoking `gemini run` |
| `Compact` | `--checkpoint` flag (experimental) |

---

## 11. Invocation Examples

### Example 1: Squad capability

```bash
gemini run \
  --agent instagram-intelligence \
  --skill media.video.analyze \
  --max-iterations 20 \
  --prompt "Analyze video: https://..." \
  --output-format json
```

### Example 2: Business brief with handoff in a pipeline

```bash
# The business runs as ONE solo agent (it plays the seats itself)
gemini run --agent nexus-ceo --max-iterations 10 \
  --prompt "<brief>" > .handoffs/ceo-1.json

# Adapter detecta `next_action: delegate to marketing-lead`
gemini run --agent marketing-lead --max-iterations 30 \
  --prompt "<context from ceo handoff>" > .handoffs/marketing-1.json

# Adapter detecta mention `@alex-hormozi`
gemini run --agent alex-hormozi --max-iterations 15 \
  --prompt "<context from marketing handoff>" > .handoffs/alex-1.json
```

### Example 3: Harness escalation

```bash
echo '{"type":"human_escalation_required","trigger_id":"budget","severity":"high",...}' \
  > .harness/notifications/$(date +%s).json
```

---

## 12. Runtime-Specific Validators

- **MCP server reachability**: if employee.tools includes `mcp__<server>__*`, validate that the MCP server is in `~/.gemini/mcp/<server>/` and answers a health check.
- **Coherent function declarations**: tools in the whitelist need a valid declaration; the wrapper validates pre-spawn.
- **GEMINI.md loaded**: the adapter checks that the skill manifest is referenced in GEMINI.md (otherwise it does not load).
- **Supported model**: some features (rich function calling, code execution) vary by model. The adapter checks `model` in the employee frontmatter against the Gemini capability matrix.

---

## 13. Known Limitations

1. **No stable subagent primitive**: `gemini agent` is experimental, the adapter prefers sub-process.
2. **No granular hooks**: validation in an external wrapper.
3. **No `ScheduleWakeup` / `CronCreate`**: external cron.
4. **No rich cross-session memory**: the adapter keeps memory in files.
5. **Per-employee max-iterations is simulated**: assumes flat employees.
6. **No `TeamCreate`**: teams as a convention.
7. **OTel not built-in**: external SDK.
8. **Mentions and tickets** depend on the wrapper detecting and fanning out.
9. **MCP support is experimental**: it can change between versions; the adapter has to test before each version bump.
10. **Slash commands** are experimental; the adapter uses CLI flags.
11. **Audit log** is experimental: do not rely on it for production without the harness jsonl fallback.

**Compensating advantage:** a context window 5-10x larger than Claude/Codex allows long-running businesses with less compaction pressure.

---

## 14. Source References

- Gemini CLI docs: https://ai.google.dev/gemini-api/docs/cli
- Google Gen AI SDK: https://github.com/google-gemini/generative-ai-python
- MCP support in Gemini CLI (experimental): https://ai.google.dev/gemini-api/docs/mcp
- Squad Protocol v6: `~/.nirvana/skills/squads/SQUAD_PROTOCOL_V6.md`
- Business Protocol v2: `~/.nirvana/skills/businesses/BUSINESS_PROTOCOL_V2.md`
- Harness protocol: `~/.nirvana/skills/harness/SKILL.md`

---

## 15. Version History

| Version | Date | Changes |
|---|---|---|
| 1.0.0 | 2026-05-02 | Initial doc: covers Squad 5.0 + Business 1.0 + Harness 1.0 against Gemini CLI 0.4-0.6 (Gemini 2.5 Pro) |
