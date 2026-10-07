# Adapter · Claude Code

> Runtime adapter for Squad Protocol v6 + Business Protocol v2 + Harness Protocol v1.
> Covers the 3 protocols in a single doc. Canonical sections per Squad Protocol v6 §18.5.
> System identity + capabilities (what Nirvana-OS is and can do): see `../NIRVANA-OS.md` (single source).

---

## 1. Adapter Metadata

| Field | Value |
|---|---|
| `runtime` | `claude-code` |
| `vendor` | Anthropic |
| `min_version` | `1.0.0` (CLI), Anthropic SDK `>=0.30` |
| `default_model` | inherited from the runtime. The engine NEVER sets a model; the user's runtime config decides. Pass a model only when the user explicitly asks. |
| `tested_against` | Claude Code 1.x (CLI, IDE, web) — Opus 4.7 |
| `config_paths` | `~/.claude/settings.json` (user), `<project>/.claude/settings.json`, `<project>/.claude/settings.local.json` |
| `skills_root` | `~/.nirvana/skills/` (user), `<project>/.claude/skills/` (project), bundled |
| `agents_root` | `~/.claude/agents/` (user), `<project>/.claude/agents/` (project) |
| `memory_root` | `~/.claude/memory/` (permanent), `<project>/CLAUDE.md` (project), conversation context (session) |
| `audit_log` | `~/.claude/projects/<project-id>/` (transcripts, tool results), `~/.harness-logs/` (harness OTel/jsonl) |
| `protocol_versions` | Squad 5.0, Business 1.0, Harness 1.0 |

---

## 2. Feature Support Matrix

`✓` = native · `~` = workaround/partial · `✗` = not supported

| Feature (Business v2 §6.5) | Squad v6 | Business v2 | Harness v1 | Notes |
|---|---|---|---|---|
| `max_turns` | ✓ | ✓ | ✓ | `maxTurns` in agent/employee frontmatter; the runtime does not enforce it as a hard limit but the adapter can close it via hook |
| `tool_whitelist` | ✓ | ✓ | ✓ | `tools:` in frontmatter + `permissions` in settings.json |
| `subagent_spawning` | ✓ | ✓ | ✓ | `Agent` tool with `subagent_type` |
| `audit_trail` | ✓ | ✓ | ✓ | OTel if configured, fallback to jsonl in `~/.harness-logs/` |
| `scheduled_invocation` | ✓ | ✓ | ✓ | `ScheduleWakeup`, `CronCreate` (deferred tools) |
| `event_bus` | ~ | ~ | ~ | No native broker. Mentions and tickets travel through tool results + filesystem watch + memory polling. Documented as a limitation in §13. |
| `hooks` | ✓ | ✓ | ✓ | `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`, `SessionStart`, `Compact` |
| `sandboxing` | ~ | ~ | ~ | `dangerouslyDisableSandbox` on the Bash tool; the sandbox is per tool permission, not process isolation |
| `session_memory` | ✓ | ✓ | ✓ | Conversation context (auto-compacted) |
| `project_memory` | ✓ | ✓ | ✓ | `CLAUDE.md` + `<project>/.claude/memory/` |
| `global_memory` | ✓ | ✓ | ✓ | `~/.claude/CLAUDE.md` + `~/.claude/memory/` |
| `handoff_artifacts` | ✓ | ✓ | ✓ | JSON structure in `tool_result` or in a persisted file |
| `fork_context` | ✓ | ✓ | ✓ | Each `Agent` invocation creates an isolated sub-context |
| `teammate_primitive` | ~ | ~ | ~ | Subagents act as teammates by convention; `TeamCreate` is a deferred tool and is not available in every 1.x install. When unavailable the adapter falls back to parallel `Agent` spawns. |
| `telemetry_otel` | ✓ | ✓ | ✓ | Via OTLP endpoint when `HARNESS_TELEMETRY=otel` |

---

## 3. Concept Mapping

| Concept (Protocol) | Claude Code equivalent | Implementation |
|---|---|---|
| Squad / Business | Skill | Directory `~/.nirvana/skills/<name>/SKILL.md` (frontmatter + body) |
| Capability | Sub-skill / task / workflow | File invoked by name from the `Skill` tool or via slash command |
| Employee (seat) | Seat file played by the one business agent | The business runs as ONE solo agent (`skills/harness/lib/business-solo.ts`); it opens a seat's `employees/<slug>.md` when it works as that seat. No subagent per seat. A standalone `agent.md` in `~/.claude/agents/` is only needed when the user wants a seat as a stand-alone subagent |
| `is_brief_intake: true` | Skill activator | Skill that fires first when the harness receives a brief |
| `is_antagonist: true` | Subagent invoked in a review loop | Parallel spawn of a critic subagent |
| Handoff artifact | Tool result | Structured JSON returned by a subagent (validatable against `HandoffArtifactSchema`) |
| Mention `@employee` | Convention in prompt + memory | Adapter resolves `@x` to `Agent({ subagent_type: "x", ...})` |
| Ticket | Persisted file + memory ref | `<project>/.tickets/<TICKET_ID>.json` + memory entry |
| Escalation trigger | Hook + harness notification | `PostToolUse` checks the condition → emits `HarnessNotification` |
| Permanent memory | `~/.claude/memory/*.md` + `~/.claude/CLAUDE.md` | Files referenced via auto-load |
| Project memory | `<project>/.claude/memory/` + `CLAUDE.md` | Auto-load per session |
| Session memory | Conversation context | Kept by the runtime, compacted near the limit |
| Routing decision (harness) | Skill scoring + AgentTool dispatch | BM25 over `capabilities[].examples[]` |

---

## 4. Frontmatter Mapping

### Squad v6 → Skill frontmatter

```yaml
# squad.yaml (Squad Protocol v6 §22)
name: instagram-intelligence
version: 5.4.0
protocol: 5.0
description: ...
capabilities:
  - id: media.video.analyze
    invoke: { type: task, ref: tasks/analyze.md }
```

```yaml
---
# ~/.nirvana/skills/instagram-intelligence/SKILL.md frontmatter
name: instagram-intelligence
description: <copy of squad.yaml description>
---
```

### Business v2 → Skill frontmatter

```yaml
# business.yaml (Business v2 §6.5)
name: nexus-council
employee_count: 9
operation_mode: zero_human
```

```yaml
---
# ~/.nirvana/skills/nexus-council/SKILL.md frontmatter
name: nexus-council
description: <generated from description+pitch>
---
```

### Employee → Subagent agent.md (optional, only for a stand-alone subagent)

```yaml
# employees/alex-hormozi.md frontmatter (Business v2 §7)
name: alex-hormozi
type: mind_clone
disclosure_required: true
maxTurns: 30
tools: [Read, Grep, Bash]
model: inherit
```

```yaml
---
# ~/.claude/agents/alex-hormozi.md frontmatter
name: alex-hormozi
description: Mind clone of Alex Hormozi for offer evaluation. (DISCLOSURE: AI-generated persona, not real person.)
tools: Read, Grep, Bash
model: inherit
---
```

> **Translation rule:** when `type: mind_clone`, the adapter **prepends** `(DISCLOSURE: AI-generated persona, not real person.)` to the agent.md description.

---

## 5. Tool Whitelist Mechanics

- The `tools:` frontmatter accepts semantic names (`read`, `write`, `edit`, `grep`, `glob`, `bash`, `web_search`, `web_fetch`), Squad Protocol v6 §10.7.
- The Claude Code adapter translates them to native names: `Read`, `Write`, `Edit`, `Grep`, `Glob`, `Bash`, `WebSearch`, `WebFetch`.
- MCP tools enter as `mcp__<server>__<tool>`.
- To enforce the whitelist at runtime, configure `permissions` in `<project>/.claude/settings.json`:

```json
{
  "permissions": {
    "allow": ["Read", "Grep", "Bash(npm test:*)"],
    "deny": ["WebFetch"]
  }
}
```

---

## 6. Max-Turns Mechanics

Claude Code does not enforce `maxTurns` natively in sub-agents. The adapter uses 3 mechanisms:

1. **Informative**: `maxTurns` in the employee frontmatter appears in the subagent prompt ("you have N turns").
2. **Pre-flight budget**: the harness converts `maxTurns × estimated_cost_per_turn` into `budget.default_max_cost_usd` (Harness §6).
3. **Hook enforcement**: a `PostToolUse` hook counts the subagent's tool calls and aborts via `decision: "block"` when it exceeds:

```json
// settings.json hook (example)
{
  "hooks": {
    "PostToolUse": [
      { "matcher": "Agent", "command": "~/.claude/hooks/turn-counter.sh" }
    ]
  }
}
```

**Known limitation:** if the subagent is dispatched via `Skill` instead of `Agent`, the counter has to run in another scope. Documented as `~` (partial) in the matrix.

---

## 7. Subagent Spawning

Default: the `Agent` tool with `subagent_type` pointing to the agent name defined in `~/.claude/agents/<name>.md`.

```typescript
// Internal pseudo-invocation
Agent({
  subagent_type: "alex-hormozi",
  description: "Offer review",
  prompt: "Review this offer for clarity and pricing...",
  // optional:
  isolation: "worktree" // git worktree for isolated changes
})
```

The `Agent` tool is the **PRIMARY dispatch path**: it runs in-process inside the maestro's session, with no child `claude -p` and no 20-minute wall-clock hard kill, so long deliverables are not truncated.

The spawn returns a receipt right away (`"Async agent launched successfully"`) and the session stays free. The work arrives later in a `<task-notification>` with a `<result>`, which is where the subagent's report lives. Do not pass `run_in_background: false`: it blocks the whole session for the duration of the subagent (a deploy stack takes 45 min) and brings nothing the notification does not already bring. The headless `claude -p` path (`host-agent-driver.runClaudeCode`, flags `--output-format json` / `--allowedTools` / `--permission-mode` / `--add-dir` / `--max-budget-usd` / `--resume`) is the FALLBACK, used only by standalone scripts with no LLM context of their own (`dispatch.ts`). Every headless child (`runClaudeCode` and the `buildCall` of `callHostAgent`) passes `--dangerously-skip-permissions` by default, because `claude -p` starts in manual mode and, without a TTY, the CLI denies the first tool that asks for approval. A worker reaches any folder and runs any command its brief needs, on any model. `NIRVANA_HEADLESS_SKIP_PERMISSIONS=0` turns autonomy off on every runtime (`claude -p` falls back to `--allowedTools` + `--permission-mode acceptEdits`, the same path as `nrv dispatch --safe`).

**For businesses:** a business runs as ONE solo agent (`skills/harness/lib/business-solo.ts`) that plays the seats itself. It opens no subagent, no squad dispatch and no other business. Whether a reviewer checks the result is decided by `review.policy`.

**For squads (capabilities):** a capability with `invoke.type: agent` maps to `Agent`; with `type: workflow` or `type: task` it can run inline in the skill's scope.

---

## 8. Memory Storage

| Layer | Path | Persistence |
|---|---|---|
| Permanent (cross-session) | `~/.claude/memory/<topic>.md` indexada por `~/.claude/memory/MEMORY.md` | Manual or automatic via `auto memory` |
| Project (per-cliente) | `<project>/.claude/memory/` + `<project>/CLAUDE.md` | Auto-load at session start |
| Session | Conversation context | Compacted by the runtime |
| Business permanent | `~/businesses/<biz>/memory/permanent.md` | Adapter persists explicitly via Write |
| Project (business) | `<project>/<biz>/<project_id>/memory/` | Isolation by construction (Business v2 §9) |

> **Isolation guard (Harness §H10):** when the adapter detects an attempt to read another `project_id`'s memory, it emits `audit_event: isolation_violation` and blocks.

---

## 9. Context Window & Compaction

- Window: 200K tokens (Sonnet/Opus 4.x).
- Compaction: automatic near the limit. Emits the `Compact` hook so critical state can be persisted first.
- For long-running businesses: force a checkpoint via `Skill: harness#checkpoint` at 70% of the context.

---

## 10. Hook System

Hooks run shell commands. Relevant events:

| Hook | Trigger | Protocol use |
|---|---|---|
| `PreToolUse` | Before each tool call | Enforce permissions, dry-run cost |
| `PostToolUse` | After each tool call | Turn counter, cost emission, audit |
| `UserPromptSubmit` | Each user prompt | Inject harness preamble |
| `Stop` | End of turn | Persist mention/ticket inbox |
| `SessionStart` | Start of session | Load memory + check pending tickets |
| `Compact` | Before auto-compaction | Save critical state (Business v2 §9.3) |

Configured in `settings.json`. See the `update-config` skill for the exact syntax.

---

## 11. Invocation Examples

### Example 1: Squad capability (Squad v6)

```
User: "transcrever vídeo do Instagram https://..."

Harness routing:
  brief → match capabilities[].examples → "transcrever vídeo do Instagram"
  → match: instagram-intelligence#media.video.analyze (score 0.94)
  → HIGH match (auto-invoke)
  → Skill({ skill: "instagram-intelligence", args: "video=https://..." })
```

### Example 2: Business brief (Business v2)

```
User: "Estamos lançando um produto novo, preciso de um plano completo de marketing."

Harness routing:
  brief → match domains [marketing, strategy] + employee_count
  → match: nexus-council (score 0.78)
  → AMBIGUOUS (confirm via AskUserQuestion or open the business)
  → harness dispatches the business as ONE solo agent (nexus-council)
  → the agent plays the seats itself (marketing-lead, ...), opening each seat file as needed
  → it consolidates and returns a one-page summary
```

### Example 3: Mention between employees

```
Employee A produces a handoff:
{
  "from_agent": "marketing-lead",
  "to_agent": "ceo",
  "summary": "...",
  "next_action": "review",
  "business_extensions": {
    "type": "mention",
    "mention_text": "@alex-hormozi can you review the pricing?",
    "self_score": { "clarity": 0.92, "passes_threshold": true }
  }
}

Adapter detects `@alex-hormozi` → Agent({ subagent_type: "alex-hormozi", prompt: "...marketing-lead asked for a pricing review..." })
```

### Example 4: Harness escalation (zero-human bridge)

```
Budget breach detected (Harness §H6):
  audit_event: budget_violation
  → emit HarnessNotification (severity: high)
  → AskUserQuestion({
      question: "Budget exceeded by 20%. Continue?",
      options: [{ label: "Approve overage" }, { label: "Abort" }]
    })
  → audit_event: human_response_received
  → resume or abort depending on the answer
```

---

## 12. Runtime-Specific Validators

Besides `validators.ts/.py`, Claude Code requires:

- **Subagent existence check**: every `subagent_type` referenced in an employee `manages:` or in a mention must exist as a file `~/.claude/agents/<name>.md` or bundled in the skill.
- **Slash command collision**: if a squad/business has a `slashPrefix`, it must not collide with a built-in (`/clear`, `/help`, `/config`, `/loop`, `/schedule`, etc.).
- **Settings.json schema**: when injecting permissions/hooks, validate against the Claude Code schema (the `update-config` skill knows the schema).

---

## 13. Known Limitations

1. **No native hard maxTurns on the Agent tool.** Mitigation via hook (§6).
2. **No event broker.** Mentions/tickets depend on file-system + memory; race conditions are possible in multi-process. For v1: single-process.
3. **OTel is not built-in.** Requires external config (`OTEL_EXPORTER_OTLP_ENDPOINT` env var) or the jsonl fallback.
4. **Subagent context has no explicit quota.** Each `Agent` creates a new fork; the budget is macroscopic (cost USD), not micro (tokens per sub).
5. **Slash commands do not accept structured args.** The adapter passes args as a single string; validators receive and parse them.
6. **Hooks run in shell**, not JS, a limitation for complex validations. Workaround: the hook calls a Node/Python script.
7. **`ScheduleWakeup` is Claude Code specific** (not portable). The harness must degrade to external cron on runtimes that do not support it.
8. **No strong isolation per subagent.** Subagents share the main process's fs/network; isolation is by permissions, not by sandbox.

---

## 14. Source References

- Claude Code public docs: https://docs.claude.com/en/docs/claude-code
- Implementation reference (paths relative to the Claude Code code):
  - `Skill.md`: skill model
  - `src/tools/AgentTool/`: AgentTool, forkSubagent
  - `src/tools/TaskCreateTool/prompt.ts`: TaskCreate
  - `src/tools/TeamCreateTool/prompt.ts`: TeamCreate
  - `src/coordinator/coordinatorMode.ts`: multi-agent coordination
- Squad Protocol v6: `~/.nirvana/skills/squads/SQUAD_PROTOCOL_V6.md`
- Business Protocol v2: `~/.nirvana/skills/businesses/BUSINESS_PROTOCOL_V2.md`
- Harness protocol: `~/.nirvana/skills/harness/SKILL.md`

---

## 15. Version History

| Version | Date | Changes |
|---|---|---|
| 1.0.0 | 2026-05-02 | Initial doc: covers Squad 5.0 + Business 1.0 + Harness 1.0 against Claude Code 1.x (Opus 4.7) |
