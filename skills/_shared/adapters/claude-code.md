# Adapter · Claude Code

> Runtime adapter for Squad Protocol v6 + Business Protocol v2 + Harness Protocol v1.
> Covers the 3 protocols in a single doc. Canonical sections per Squad Protocol v6 §18.5.
> System identity + capabilities (what Nirvana-OS is and can do): see `../NIRVANA-OS.md` (single source).

---

## 1. Adapter metadata

| Field | Value |
|---|---|
| `runtime` | `claude-code` |
| `vendor` | Anthropic |
| `min_version` | Not enforced by the engine. The argv in §7 was audited on 2.1.284 and 2.1.296; the resume cost correction assumes 2.1.277 or later and keeps an older CLI's per-run figure as it is. The engine spawns the CLI and uses no Anthropic SDK. |
| `default_model` | inherited from the runtime. The engine NEVER sets a model; the user's runtime config decides. Pass a model only when the user explicitly asks. |
| `tested_against` | Claude Code 2.1.296 (CLI, native build), audited 2026-10-11. Opus 5.5 is the default Opus since 2.1.280 |
| `config_paths` | `~/.claude/settings.json` (user), `<project>/.claude/settings.json`, `<project>/.claude/settings.local.json` |
| `skills_root` | `~/.nirvana/skills/` (user), `<project>/.claude/skills/` (project), bundled |
| `agents_root` | `~/.claude/agents/` (user), `<project>/.claude/agents/` (project) |
| `memory_root` | `~/.claude/memory/` (permanent), `<project>/CLAUDE.md` (project), conversation context (session) |
| `audit_log` | `~/.claude/projects/<project-id>/` (transcripts, tool results), `~/.harness-logs/` (harness OTel/jsonl) |
| `protocol_versions` | Squad 5.0, Business 1.0, Harness 1.0 |

---

## 2. Feature support matrix

`✓` = native · `~` = workaround/partial · `✗` = not supported

| Feature (Business v2 §6.5) | Squad v6 | Business v2 | Harness v1 | Notes |
|---|---|---|---|---|
| `max_turns` | ✓ | ✓ | ✓ | Enforced by the runtime: `maxTurns` in subagent frontmatter, `--max-turns` on `claude -p`. The engine does not map employee `max_turns` to the flag yet (§6) |
| `tool_whitelist` | ✓ | ✓ | ✓ | `tools:` in frontmatter + `permissions` in settings.json |
| `subagent_spawning` | ✓ | ✓ | ✓ | `Agent` tool with `subagent_type` (`Task` is the old name, still accepted). The `Workflow` tool also spawns agents (§7) |
| `audit_trail` | ✓ | ✓ | ✓ | OTel if configured, fallback to jsonl in `~/.harness-logs/` |
| `scheduled_invocation` | ✓ | ✓ | ✓ | `ScheduleWakeup`, `CronCreate` (deferred tools) |
| `event_bus` | ~ | ~ | ~ | No native broker. Mentions and tickets travel through tool results + filesystem watch + memory polling. Documented as a limitation in §13. |
| `hooks` | ✓ | ✓ | ✓ | `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`, `SubagentStop`, `SessionStart`, `PreCompact`, `PostCompact` (§10) |
| `sandboxing` | ~ | ~ | ~ | `dangerouslyDisableSandbox` on the Bash tool; the sandbox is per tool permission, not process isolation |
| `session_memory` | ✓ | ✓ | ✓ | Conversation context (auto-compacted) |
| `project_memory` | ✓ | ✓ | ✓ | `CLAUDE.md` + `<project>/.claude/memory/` |
| `global_memory` | ✓ | ✓ | ✓ | `~/.claude/CLAUDE.md` + `~/.claude/memory/` |
| `handoff_artifacts` | ✓ | ✓ | ✓ | JSON structure in `tool_result` or in a persisted file |
| `fork_context` | ✓ | ✓ | ✓ | Each `Agent` invocation creates an isolated sub-context |
| `teammate_primitive` | ~ | ~ | ~ | Subagents act as teammates by convention; `TeamCreate` is a deferred tool and is not available in every install. When unavailable the adapter falls back to parallel `Agent` spawns. |
| `telemetry_otel` | ✓ | ✓ | ✓ | Via OTLP endpoint when `HARNESS_TELEMETRY=otel` |

---

## 3. Concept mapping

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

## 4. Frontmatter mapping

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

## 5. Tool whitelist mechanics

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

## 6. Max-turns mechanics

Claude Code enforces a turn limit natively in two places:

1. **Subagent frontmatter**: `maxTurns: N` in `~/.claude/agents/<name>.md` caps that subagent.
2. **Headless runs**: `claude -p --max-turns N`. The flag is hidden from `claude --help` but accepted (checked on 2.1.296). A run that hits the cap ends with result subtype `error_max_turns`; `runClaudeCode` returns it as `resultSubtype` and names it in `error`.

The engine does not pass `--max-turns` today, so an employee's `max_turns` reaches a headless worker only as:

- **Informative**: `maxTurns` in the employee frontmatter appears in the prompt ("you have N turns").
- **Pre-flight budget**: the harness converts `maxTurns × estimated_cost_per_turn` into `budget.default_max_cost_usd` (Harness §6), and `--max-budget-usd` stops the run (`error_max_budget_usd`).

A hook can add a counter where neither native limit applies. A `PostToolUse` hook that returns `{"continue": false}` once the count is exceeded stops processing; `decision: "block"` on `PostToolUse` only shows the reason to Claude, because the tool already ran. Current settings schema (event, matcher group, handler list):

```json
// settings.json hook (example)
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Agent",
        "hooks": [
          { "type": "command", "command": "~/.claude/hooks/turn-counter.sh" }
        ]
      }
    ]
  }
}
```

**Known limitation:** if the work runs via `Skill` instead of `Agent`, a subagent-scoped `maxTurns` or an `Agent` matcher does not see it; only the session-level `--max-turns` covers it.

---

## 7. Subagent spawning

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

The spawn returns a receipt right away (`"Async agent launched successfully"`) and the session stays free. The work arrives later in a `<task-notification>` with a `<result>`, which is where the subagent's report lives. Do not pass `run_in_background: false`: it blocks the whole session for the duration of the subagent (a deploy stack takes 45 min) and brings nothing the notification does not already bring. The headless `claude -p` path (`host-agent-driver.runClaudeCode`) is the FALLBACK, used only by standalone scripts with no LLM context of their own (`dispatch.ts`).

**Headless argv, as the driver builds it** (`skills/_shared/lib/host-agent-driver.ts`, checked against `claude --help` on 2.1.296):

- `runClaudeCode`: `claude -p --output-format json`, then `--resume <id>` on a revise, `--model <m>` and `--effort <level>` only when the caller or the user's pin sets them, `--tools ""` for a no-tools call, `--allowedTools` when the caller lists tools or autonomy is off, then one of: the caller's `--permission-mode`, `--permission-mode acceptEdits` (autonomy off), or `--dangerously-skip-permissions` (the default). After that `--disallowedTools Task Agent Workflow` unless `allowSubagents`, `--max-budget-usd`, `--settings`, each `--add-dir`, and the directive last as `--append-system-prompt <text>` (or `--append-system-prompt-file <path>` when the CLI is reached through a shell, so a long directive never truncates argv). The prompt goes on stdin.
- `buildCall` (the `claude-code` entry in `RUNTIMES`, used by `callHostAgent` for judges and gates): `claude -p --no-session-persistence --output-format json`, `--dangerously-skip-permissions` when autonomy is on, `--model` when pinned, `--append-system-prompt <persona>`. The message goes on stdin.
- Child environment (`headlessClaudeEnv`): `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` unless the user set it, `CLAUDE_CODE_DISABLE_WORKFLOWS=1` for a worker that may not open agents, and `CLAUDE_CODE_AUTO_COMPACT_WINDOW` from `execution.context_window`.

The bypass flag is the default because a child without a TTY cannot answer a prompt: in a `-p` run the calls that would still prompt are denied instead. Which mode `claude -p` starts in without a flag depends on the session: `default` (shown as `manual`) where the CLI fetches feature flags, `auto` on third-party providers or with telemetry off since 2.1.285. The engine does not rely on either. `--permission-mode` choices printed by help are `acceptEdits`, `auto`, `bypassPermissions`, `manual`, `dontAsk`, `plan`; `default` is no longer listed but still accepted as `manual`. A worker reaches any folder and runs any command its brief needs, on any model. `NIRVANA_HEADLESS_SKIP_PERMISSIONS=0` turns autonomy off on every runtime (`claude -p` falls back to `--allowedTools` + `--permission-mode acceptEdits`, the same path as `nrv dispatch --safe`).

**Workers do not open agents.** Denying `Task` and `Agent` is not enough on current builds: the `Workflow` tool runs dynamic workflows inside `claude -p`, bypass mode approves the call, and one run may spawn up to 1,000 agents. Its off switches are `CLAUDE_CODE_DISABLE_WORKFLOWS=1`, `"disableWorkflows": true` in settings, or a deny rule on `Workflow`. The engine uses two of them for every worker unless the caller passes `allowSubagents: true`: `--disallowedTools Task Agent Workflow` on the argv (also in `orca-worker.ts`) and `CLAUDE_CODE_DISABLE_WORKFLOWS=1` in the child env.

**Cost on resume.** Since 2.1.277 the `total_cost_usd` of a resumed session includes the spend of the runs it restored, so summing results double counts. The engine records the run's own cost: it keeps the last total reported per session id in the run ledger (`claude-session-cost.ts`) and, on a resumed run, records the difference. When no previous total is known, or the reported value is lower than it (a CLI older than 2.1.277), the reported value is kept. `--max-budget-usd` counts only the call's own spend.

**`--bare`.** The CLI docs announce `--bare` as the future default for `-p`. It skips hooks, CLAUDE.md discovery, OAuth and keychain (API key or `apiKeyHelper` only), so it would break subscription auth and the `~/.nirvana` setup. The engine never passes it.

**For businesses:** a business runs as ONE solo agent (`skills/harness/lib/business-solo.ts`) that plays the seats itself. It opens no subagent, no squad dispatch and no other business. Whether a reviewer checks the result is decided by `review.policy`.

**For squads (capabilities):** a capability with `invoke.type: agent` maps to `Agent`; with `type: workflow` or `type: task` it can run inline in the skill's scope.

---

## 8. Memory storage

| Layer | Path | Persistence |
|---|---|---|
| Permanent (cross-session) | `~/.claude/memory/<topic>.md` indexada por `~/.claude/memory/MEMORY.md` | Manual or automatic via `auto memory` |
| Project (per-cliente) | `<project>/.claude/memory/` + `<project>/CLAUDE.md` | Auto-load at session start |
| Session | Conversation context | Compacted by the runtime |
| Business permanent | `~/businesses/<biz>/memory/permanent.md` | Adapter persists explicitly via Write |
| Project (business) | `<project>/<biz>/<project_id>/memory/` | Isolation by construction (Business v2 §9) |

> **Isolation guard (Harness §H10):** when the adapter detects an attempt to read another `project_id`'s memory, it emits `audit_event: isolation_violation` and blocks.

---

## 9. Context window and compaction

- Window: set by the model the user runs. The engine can lower the point where compaction starts with `execution.context_window`, passed to the child as `CLAUDE_CODE_AUTO_COMPACT_WINDOW` (the CLI accepts 100000 to 1000000; smaller values clamp to 100K). `claude --autocompact <auto|tokens>` sets the same window for one run.
- Compaction: automatic near the limit. `PreCompact` fires before it (matcher `manual` or `auto`) so critical state can be persisted first, and `PostCompact` after it completes.
- For long-running businesses: force a checkpoint via `Skill: harness#checkpoint` at 70% of the context.

---

## 10. Hook system

Hooks are declared per event, as matcher groups that each carry a `hooks` list of handlers (§6 has the JSON). Handler `type` is `command`, `http`, `mcp_tool`, `prompt` or `agent`. Relevant events:

| Hook | Trigger | Protocol use |
|---|---|---|
| `PreToolUse` | Before each tool call | Enforce permissions, dry-run cost |
| `PostToolUse` | After each tool call | Turn counter, cost emission, audit |
| `UserPromptSubmit` | Each user prompt | Inject harness preamble |
| `Stop` | End of turn | Persist mention/ticket inbox |
| `SubagentStop` | A subagent finishes | Collect handoff artifacts |
| `SessionStart` | Start of session | Load memory + check pending tickets |
| `PreCompact` | Before compaction (manual or auto) | Save critical state (Business v2 §9.3) |
| `PostCompact` | After compaction completes | Re-inject state the summary dropped |

Configured in `settings.json` (user, project or local), in plugin `hooks/hooks.json`, or in skill and subagent frontmatter. `--bare` skips hooks from settings and plugins. In `-p`, a settings file that fails validation is silently ignored. See the `update-config` skill for the exact syntax.

---

## 11. Invocation examples

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

## 12. Runtime-specific validators

Besides `validators.ts/.py`, Claude Code requires:

- **Subagent existence check**: every `subagent_type` referenced in an employee `manages:` or in a mention must exist as a file `~/.claude/agents/<name>.md` or bundled in the skill.
- **Slash command collision**: if a squad/business has a `slashPrefix`, it must not collide with a built-in (`/clear`, `/help`, `/config`, `/loop`, `/schedule`, etc.).
- **Settings.json schema**: when injecting permissions/hooks, validate against the Claude Code schema (the `update-config` skill knows the schema).

---

## 13. Known limitations

1. **The engine does not pass `--max-turns`.** The runtime enforces turn limits (§6), but an employee's `max_turns` reaches a headless worker only as prompt text and budget.
2. **No event broker.** Mentions/tickets depend on file-system + memory; race conditions are possible in multi-process. For v1: single-process.
3. **OTel is not built-in.** Requires external config (`OTEL_EXPORTER_OTLP_ENDPOINT` env var) or the jsonl fallback.
4. **Subagent context has no explicit quota.** Each `Agent` creates a new fork; the budget is macroscopic (cost USD), not micro (tokens per sub).
5. **Slash commands do not accept structured args.** The adapter passes args as a single string; validators receive and parse them.
6. **Hooks run in shell**, not JS, a limitation for complex validations. Workaround: the hook calls a Node/Python script.
7. **`ScheduleWakeup` is Claude Code specific** (not portable). The harness must degrade to external cron on runtimes that do not support it.
8. **No strong isolation per subagent.** Subagents share the main process's fs/network; isolation is by permissions, not by sandbox.

---

## 14. Source references

- Claude Code public docs: https://code.claude.com/docs (headless: `/en/headless`, hooks: `/en/hooks`, permission modes: `/en/permission-modes`, workflows: `/en/workflows`, cost: `/en/agent-sdk/cost-tracking`)
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

## 15. Version history

| Version | Date | Changes |
|---|---|---|
| 1.0.0 | 2026-05-02 | Initial doc: covers Squad 5.0 + Business 1.0 + Harness 1.0 against Claude Code 1.x (Opus 4.7) |
| 1.1.0 | 2026-10-11 | Audited against Claude Code 2.1.296 (Opus 5.5 default Opus). Hook events `PreCompact`/`PostCompact` replace the nonexistent `Compact`; hook JSON uses the `{matcher, hooks:[{type, command}]}` schema; native `maxTurns`/`--max-turns` and `error_max_turns`; starting permission mode (`auto` on third-party providers or telemetry off since 2.1.285) and `--permission-mode` choices; the real headless argv; `Workflow` tool and the worker fence (`--disallowedTools Task Agent Workflow`, `CLAUDE_CODE_DISABLE_WORKFLOWS=1`); cumulative resume cost and the ledger difference; `--bare` never passed; docs moved to code.claude.com |
