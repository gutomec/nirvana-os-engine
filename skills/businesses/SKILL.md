---
name: businesses
description: "Business lifecycle skill (DOMAIN-AGNOSTIC). Creates, lists, inspects, validates, and migrates businesses — autonomous multi-agent organizations — following the Business Protocol v1. Works for ANY domain: marketing, healthcare, engineering, legal, real-estate, gaming, foodtech, trading, education, research, government, etc. Triggers: list businesses, inspect business, create business, validate business, migrate business, manage org chart, library/dna ops. For EXECUTION of production briefs ('use as empresas', 'produza X via empresa Y'), invoke the `harness` skill instead — it carries the maestro intelligence. Default: zero_human."
tools: [Read, Write, Edit, Glob, Grep, Bash, AgentTool, TaskCreate, AskUserQuestion]
maxTurns: 100
---

# Business Protocol Engine v1.0

Multi-agent business orchestrator following `BUSINESS_PROTOCOL_V1.md`. Runtime-agnostic (Claude Code, Codex, Gemini-CLI). Zero external dependencies beyond the runtime and the centralized validators in `~/.claude/skills/_shared/`.

---

## Scope of this skill

This skill is for **business lifecycle operations**: list / inspect / create / validate / migrate businesses; manage the `~/businesses/_library/dna/` mind-clone library; bootstrap structure; consult registries.

For **execution requests** ("use as empresas", "rode pela empresa X", "produza um livro/post/vídeo", any production brief), invoke the **`harness` skill** instead. The harness skill carries the maestro intelligence — it reads the brief, optionally researches, picks the right business, dispatches its org chart, and runs the quality gate. This skill is not the entry point for orchestration.

### Verifying real dispatch (when execution does happen via harness)

After delivery, confirm in `~/.harness-logs/$(date +%Y-%m-%d)/audit.jsonl`:
- `event=brief_received` (from brief-business.ts)
- `event=dispatch_business` (or `dispatch_squad` for fallback) with this trace_id
- `event=mind_clone_injected` for each DNA file loaded (from buildEmployeePrompt)
- `event=handoff_phase_advanced` for `plan → execute` and `execute → complete`
- `event=verify_passed` (from verify-deliverable.ts)
- `event=gate_passed` (from quality-gate.ts) with the rubrics list
- The actual artifact at the dispatched target's declared `outputs[]` location

If absent, the orchestration didn't happen — claiming "I used business X + squad Y" without those events is fiction. Iterate, don't fake.

---

## Protocol Compliance for Employees (HARD RULES)

When an employee is spawned via subagent (using `buildEmployeePrompt()` from `lib/employee-prompt.ts`), the prompt already includes a "PROTOCOL COMPLIANCE" section. Reinforced here for the runtime:

1. **Read multi-target coordination artifacts in this order, every time:**
   1. `<project_dir>/brief-enriched.md` — the full project context.
   2. `<your_target_dir>/DISPATCH-INSTRUCTION.md` (if it exists) — your specific scope, upstream deps, downstream consumers.
   3. `<each_upstream>/outputs/_SUMMARY.md` for every phase in your `depends_on` — 1 page each.
   4. Specific files under `<upstream>/outputs/` only when your DISPATCH-INSTRUCTION calls them out by name.
2. **Read `HANDOFF.json` on start.** Phase tells you where to resume after rate-limit / kill / restart.
3. **Advance phases:** import `updateHandoffPhase` from `~/.claude/skills/_shared/lib/handoff.js`:
   - Before first artifact write → `updateHandoffPhase(projectDir, "execute", {nextTaskId: "T-001"})`
   - After last artifact written → `updateHandoffPhase(projectDir, "complete", {lastTaskCompleted: ...})`
   - On interruption → leave `phase: "execute"` with `last_task_completed` set; next session resumes.
4. **Prefer squads — discover, shortlist the TOP 5, then pick the best agentically (§13.4).** You are an orchestrator, not just a doer: before producing an atomic deliverable by hand, look for a squad that covers it. If the brief names a squad, use it. Otherwise:
   a. **Discover candidates** by capability over the squad registry — match the brief against each squad's `capabilities[].domains` + `produces` + `example_briefs` + `keywords` (`agentic` mode, default; or seed the shortlist fast with `nrv find "<need>"` BM25).
   b. **Shortlist the top 5** best-matching squads.
   c. **Analyze those 5 deeply** — read each one's full capability block (`description`, `examples`, `produces`, `not_for`, `domains`, `fidelity`, `score_boost`), judge fit against the brief and your role, then **pick the single best**. Tiebreak: higher `produces`/capability coverage → `fidelity: validated` → `score_boost`. Record in the audit why it beat the other four.
   d. Only if **none** of the 5 genuinely fit, produce it directly (and say so).
   Businesses no longer whitelist squads — `squads_authorized` is empty, so **all squads are permitted** and this **top-5 agentic choice is THE gate** that keeps routing sharp. (`squads_authorized`, if ever set non-empty, still acts as a hard restriction; per-employee lists narrow further.) Don't pass the raw brief down: build a **brief-context** shaped by your role and (if `type: mind_clone`) your incorporated persona, hand that to the squad, then integrate its output. Executing directly what a squad already covers breaks the audit chain.
5. **Verify before declaring done.** Run `verify-deliverable.ts` and `quality-gate.ts` from the harness; **write `outputs/_SUMMARY.md`** (1 page max — your public API for downstream phases); only emit `delivered` audit event after gates PASS.
6. **Scope isolation.** Write only under your own target directory. Coordination with siblings is audit-only (`plan_change_request`, `mention`, `notify_human`) — never modify other targets' outputs.

These rules turn employees from "general-purpose subagents with persona text" into real Nirvana-OS citizens with auditable, resumable state.

---

## First invocation (auto-bootstrap)

When this skill activates for the first time, ensure the minimal structure exists. Idempotent:

```bash
mkdir -p ~/businesses ~/businesses/_library/dna ~/businesses/_library/frameworks
mkdir -p ~/.businesses-state ~/.businesses-logs/$(date +%Y-%m-%d)
[ -f ~/.businesses-registry.json ] || echo '{"schema_version":"1.0.0","generated_at":"","businesses":{}}' > ~/.businesses-registry.json
```

Report: number of businesses found, registry status, dependencies (Python 3.9+, Node 18+ — only for validators).

## Project scoping (NIRVANA_SCOPE)

When invoked from inside a project tree with `<project>/.env` containing `NIRVANA_SCOPE=project|merge`, all loaders (list/index/inspect/validate) honor that scope automatically. Project-local businesses live at `<project>/.nirvana/businesses/<slug>/` and the registry persists at `<project>/.nirvana/.businesses-registry.json`. From global cwd or with `NIRVANA_SCOPE=global` (default), behavior is identical to the home installation. Full contract: `~/.claude/skills/_shared/SCOPE_CONTRACT.md`.

## Protocol source

Source of truth: `BUSINESS_PROTOCOL_V1.md` in this directory.

Centralized schemas in `~/.claude/skills/_shared/schemas/`:
- `business.schema.json` (manifest)
- `core-schemas.json` (employee, org_chart, ticket, mention, routing, approval_chain, etc.)

Validators in `~/.claude/skills/_shared/validators/validators.{py,ts}`. Always delegate validation here instead of re-implementing it.

Runtime-neutral adapters in `~/.claude/skills/_shared/adapters/{claude-code,codex,gemini-cli}.md`.

DNA library of mind-clones in `~/businesses/_library/dna/` (61 categories, 393 validated canonical mind-clones).

Canonical domain catalog in `~/.claude/skills/_shared/catalogs/CAPABILITY_CATALOG_V1.yaml`.

Read on demand. NEVER preemptively load the full protocol into context.

## Principles (BP1-BP13 + inherited Squad P1-P11)

- BP1 Zero-human is the default. Human escalation is opt-in via explicit triggers.
- BP2 Hierarchy is real, not decorative.
- BP3 Handoffs are structured. 5 mechanisms: mention, ticket, escalation, delegation, auto-routing.
- BP4 Self-score before each handoff (per-employee contract).
- BP5 3-tier memory with isolation by construction (Permanent, Project, Session).
- BP6 Brief is the unit of entry. Routing via `routing.yaml`.
- BP7 Antagonist mandatory when employee_count > 5.
- BP8 Default `functional_specialist`, not `mind_clone`.
- BP9 Approval chain mandatory for client-facing output.
- BP10 Heartbeats are bounded.
- BP11 Project outputs are source-of-truth, memory is cache.
- BP12 Audit trail is non-negotiable.
- BP13 Writing contract — every prose deliverable follows the contract appended to `AGENTS.md` / `CLAUDE.md` / `GEMINI.md` (prevention-by-injection, no post-hoc rewrite).

## Filesystem layout (canonical)

```
~/businesses/                              # business root (one folder per business)
├── _library/
│   ├── dna/                               # canonical mind-clones (symlinks to disk)
│   └── frameworks/                        # reusable frameworks
└── <business-slug>/
    ├── business.yaml                      # v1 manifest
    ├── employees/<slug>.md                # employee frontmatter + body
    ├── org-chart.yaml                     # hierarchy + reporting
    ├── routing.yaml                       # brief intake + auto-routes (optional)
    ├── escalation-triggers.yaml           # triggers (optional, default empty)
    ├── memory/permanent.md                # cross-session memory
    └── projects/                          # per-project state (created on-demand)

~/.businesses-registry.json                # index generated by `*business index`
~/.businesses-state/                       # local skill state
~/.businesses-logs/<YYYY-MM-DD>/           # audit trail jsonl
```

Project outputs live in `${PROJECTS_OUTPUT_DIR}/<project-id>/businesses/<biz-slug>/` (default: `<repo-root>/.projects-outputs/`).

Project-root resolution:
1. `$PROJECTS_OUTPUT_DIR` env var
2. Walk up until `.git/` or `CLAUDE.md` or `package.json` or `pyproject.toml`
3. Fallback `cwd()`

## Intent classification

When the user invokes this skill, map the input to one of the actions below. Use AskUserQuestion to disambiguate when needed.

| Intent (keywords) | Action | Reference |
|---|---|---|
| **CREATE**: create, new business, scaffold, init | `*business init <name>` | `references/01-creation.md` |
| **LIST**: list, view all, which businesses | `*business list` | `references/02-listing.md` |
| **INSPECT**: view, show, inspect, detail | `*business inspect <slug>` | `references/02-listing.md` |
| **VALIDATE**: validate, check, verify | `*business validate <slug>` | `references/01-creation.md` §validation |
| **INDEX**: index, rebuild, refresh registry | `*business index` | `references/02-listing.md` |
| **BRIEF**: brief, process, execute, run | `*business brief <slug> "<text>"` | `references/06-invocation.md` |
| **EMPLOYEES**: add employee, new employee, hire | guide via `references/03-employees.md` |
| **ORG**: org chart, hierarchy, reporting | `references/04-org-chart.md` |
| **HANDOFFS**: mention, ticket, escalate | `references/05-handoffs.md` |
| **MEMORY**: edit memory, maintenance | `*business memory edit <slug>` |

Multi-intent: process in dependency order. Always lazy-load (never load the full protocol).

## Quick commands (operational)

> ⛔ **Run loaders from your PROJECT's working directory, with the ABSOLUTE path
> below. NEVER `cd` into the skill directory to run a loader.** Scope is detected
> by walking up from the current directory; `cd`-ing into `~/.claude/skills/businesses`
> moves your shell out of the project tree, so the loader silently resolves
> `scope=global` and lists the home registry instead of your project's. From a
> scoped project (`NIRVANA_SCOPE=project|merge`) that means you get the WRONG
> answer. If a loader prints `scope=global` when you expected `project`, you
> almost certainly `cd`-ed out. (Pin it cwd-independently with
> `export NIRVANA_PROJECT_ROOT=<project>`.)

| Command | Implementation | Description |
|---|---|---|
| `*business init <name>` | `bun ~/.claude/skills/businesses/scripts/init-business.ts <name>` + wizard via AskUserQuestion | Scaffold new business in `~/businesses/<slug>/` |
| `*business validate <slug>` | `bun ~/.claude/skills/businesses/scripts/validate-business.ts <slug>` | Runs v1 validators (manifest + employees + org-chart + integrity) |
| `*business index` | `bun ~/.claude/skills/businesses/scripts/index-businesses.ts` | Regenerates `~/.businesses-registry.json` |
| `*business list` | `bun ~/.claude/skills/businesses/scripts/list-businesses.ts` | Table of businesses from the registry |
| `*business inspect <slug>` | `bun ~/.claude/skills/businesses/scripts/inspect-business.ts <slug>` | Manifest + employees + org-chart formatted |
| `*business brief <slug> "<text>"` | `bun ~/.claude/skills/businesses/scripts/brief-business.ts <slug> "<text>"` | Records brief, validates, prepares invocation plan |
| `*business memory edit <slug>` | opens `~/businesses/<slug>/memory/permanent.md` in write mode | Maintenance mode |
| `*business audit <project> --business <slug>` | tail `~/.businesses-logs/.../audit.jsonl` filtered | Audit trail |

Interactive wizards follow a 4-round pattern via AskUserQuestion:
1. Name + description + primary domains
2. Template (solo, council, agency, custom)
3. Initial employees (CEO + roles)
4. Final review of generated manifest

Full wizard detail in `references/01-creation.md`.

## Wizard flow (executed by the skill when intent = CREATE)

When intent = CREATE, follow this sequence without skipping steps:

**Round 1 — Identity**
- AskUserQuestion: "What is the business name?" (single, with hint about kebab-case)
- AskUserQuestion: "Brief description (≥20 chars)? Include domains."
- Validate that the slug does not collide with an existing `~/businesses/<slug>/`.

**Round 2 — Template**
- AskUserQuestion with options: solo (1 employee), council (5 advisors + CEO), agency (CEO + 4-7 specialists + antagonist), custom.
- Each option has a preview in the appropriate `templates/example-business/`.

**Round 3 — Employees**
- For each employee in the template, AskUserQuestion confirming role + adjustments.
- If template = custom, ask for the role list (multi-select of canonical roles + "Other").
- Auto-promote the first alphabetically to CEO if none is explicit. BP7 force-adds an antagonist if there are >5 employees and none is marked.

**Round 4 — Review**
- Generate `business.yaml`, `org-chart.yaml`, `employees/*.md` in a staging directory.
- Run `scripts/validate-business.ts` against staging.
- AskUserQuestion: "Confirm creation?" showing the preview.
- If approved, move to `~/businesses/<slug>/` and update the registry.

## Memory isolation (BP5 enforcement)

During brief invocation, REFUSE any operation outside `${PROJECTS_OUTPUT_DIR}/<current-project>/`. Allowed exceptions:
- Read-only on `~/businesses/<current-biz>/` (manifest, employees, org-chart, permanent memory).
- Read-only on `~/businesses/_library/dna/` (mind-clone refs).
- Append on `~/.businesses-logs/<date>/audit.jsonl`.

Permanent memory (`~/businesses/<slug>/memory/permanent.md`) is writable ONLY in `*business memory edit` mode.

A violation emits `audit_event: isolation_violation` and aborts.

## 5 handoff mechanisms (§10)

When emitting work between employees, choose one:

1. **Mention** (`@employee`): lightweight, in-line. Notifies + handoff. Always produces a handoff artifact.
2. **Ticket** (JSON in `tickets/`): heavy, tracked. For reviews, approvals, significant requests.
3. **Escalation** (upward): scope/budget exceeds authority. Trigger via `escalation_triggers` in employee frontmatter.
4. **Delegation** (downward): manager → direct report. Restricted to `manages:`.
5. **Auto-routing** (in `routing.yaml`): pattern-match sends a brief directly to an employee.

Every handoff produces a `handoff_artifact` (Squad v4 §9 + Business v1 extensions). Size ≤ 800 tokens.

## Self-scoring (BP4)

Before any handoff, the employee MUST self-score against `self_score_contract`. If any criterion is below threshold:
- `revise`: 1 extra turn to correct (bounded by `max_revise_iterations`)
- `escalate`: send to manager
- `annotate`: send with `passes_threshold: false`

The self-score is part of the handoff_artifact.

## Zero-human escalation (BP1, §12)

Default `operation_mode: zero_human`. Triggers in `escalation-triggers.yaml`:
- Budget exceeded (monthly or per-brief)
- N consecutive self-score failures
- Client complaint detected
- Legal/regulatory keyword
- Unproductive heartbeat (≥ 5 cycles)
- Ticket SLA breached
- Scope creep
- Antagonist red flag

When a trigger fires with `notify: human`, the business pauses, the harness emits a notification (Harness §12 bridge), and waits for resume.

## Writing contract (BP13)

Every prose deliverable follows the writing contract appended to `AGENTS.md` / `CLAUDE.md` / `GEMINI.md`. The contract is auto-loaded by every runtime (Claude Code, Antigravity CLI, Gemini CLI, Codex) before the agent generates anything, so prevention happens at write time. No post-hoc correction loop, no separate skill invocation, no extra cost.

Employees that produce only technical artifacts (JSON, schemas, code) ignore the contract by content — none of the prose rules apply to non-prose output.

## Skill layout

```
~/.claude/skills/businesses/
├── SKILL.md                                # this file
├── BUSINESS_PROTOCOL_V1.md                 # source of truth
├── templates/
│   ├── business.yaml.tmpl                  # manifest tmpl with {{PLACEHOLDERS}}
│   ├── employee.md.tmpl                    # employee frontmatter + body
│   ├── org-chart.yaml.tmpl
│   ├── routing.yaml.tmpl
│   ├── escalation-triggers.yaml.tmpl
│   └── example-business/                   # runnable solo template (validation passes)
├── lib/
│   ├── loader.js                           # loads + validates entire business
│   └── registry.js                         # generates ~/.businesses-registry.json
├── scripts/
│   ├── init-business.ts                    # scaffold + wizard kickoff
│   ├── validate-business.ts                # centralized validators
│   ├── index-businesses.ts                 # rebuild registry
│   ├── list-businesses.ts                  # table
│   ├── inspect-business.ts                 # formatted tree
│   └── brief-business.ts                   # prepare invocation plan
├── references/
│   ├── 01-creation.md                      # detailed wizard + validation
│   ├── 02-listing.md                       # registry + list/inspect
│   ├── 03-employees.md                     # types, mind-clones, frontmatter
│   ├── 04-org-chart.md                     # hierarchical structure
│   ├── 05-handoffs.md                      # 5 mechanisms
│   └── 06-invocation.md                    # how a business processes a brief
└── tests/
    └── smoke.ts                            # E2E: init → validate → index → list
```

## Invocation pipeline (when intent = BRIEF)

1. Load business via `lib/loader.js` (manifest + employees + org-chart).
2. Run `validateBusinessIntegrity` (BP7 antagonist, exactly 1 brief_intake, no cycles, etc.).
3. Resolve the `brief_intake` employee (typically the CEO).
4. Create `${PROJECTS_OUTPUT_DIR}/<project-id>/businesses/<biz-slug>/` with `brief.md`, `audit.jsonl`, empty dirs.
5. Spawn AgentTool with `subagent_type` = brief_intake employee. The prompt includes brief + culture + permanent memory (read-only) + isolation guard rules. This is **in-process** (the native Agent tool / runtime subagent), not a child `claude -p`; the `--exec` headless path (`runHeadless`) is reserved for the standalone dispatch script and sub-process-only runtimes (legacy gemini-cli, hermes).
6. Wait for the handoff_artifact JSON via tool result.
7. If `business_extensions.type == "delegation"` or `"mention"`, spawn the next employee. Repeat until the CEO returns `next_action: deliver_to_user`.
8. Emit `audit_event: invocation_end` with cost summary.
9. Return the deliverable to the user.

For each handoff: validate self_score, log to audit, persist to `handoffs/<n>.json`.

## Anti-patterns (DO NOT)

- DO NOT process briefs in `human_in_loop` mode without explicit config.
- DO NOT skip self-score before a handoff.
- DO NOT allow filesystem access outside the project root + own business scope.
- DO NOT use `mind_clone` without `disclosure_required: true`.
- DO NOT create businesses with >5 employees without an antagonist (BP7).
- DO NOT bypass approval chains for client-facing output.
- DO NOT load the full BUSINESS_PROTOCOL_V1.md — use TOC + read on demand.
- DO NOT emit prose output that violates the writing contract in `AGENTS.md` / `CLAUDE.md` / `GEMINI.md` (BP13).

## Backward compat

- Squads referenced in `squads_authorized` may be v4 or v5 (the squads skill resolves both).

---

*Protocol: 1.0 · Status: operational · Spec: BUSINESS_PROTOCOL_V1.md*
