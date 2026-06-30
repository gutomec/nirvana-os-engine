# Reference 04 — Multi-target coordination (DAG execution)

Loaded on demand by the maestro when Phase 4 dispatches **2+ businesses/squads that must collaborate**. For single-target dispatch, ignore this file.

When the cascade picks multiple targets that need to collaborate, create a shared project workspace with coordination artifacts:

```
.nirvana/outputs/<trace_id>/
├── brief-enriched.md           ← FULL context, immutable, read by everyone
├── manifest.json               ← live DAG state (phases, deps, waves, status)
├── businesses/<slug>/
│   ├── DISPATCH-INSTRUCTION.md     ← "your part", written by orchestrator per target
│   ├── HANDOFF.json                ← phase tracking
│   └── outputs/
│       └── _SUMMARY.md             ← 1-page exec summary written at completion
├── squads/<slug>/...
├── agents/<slug>/...
└── plan-change-requests/<slug>.md   ← if a target needs the plan to change
```

## Three artifacts the orchestrator creates upfront

1. **`brief-enriched.md`** (once, immutable) — full context every target reads first. Original brief + clarifications + landscape + dispatch plan summary + global acceptance criteria.

2. **`manifest.json`** — live DAG state with `phases[]` (id, target, status, depends_on, consumed_by, outputs_path) and `parallel_waves[]` (ordered list of phase-id groups that can run in parallel). Update as each phase completes.

3. **`DISPATCH-INSTRUCTION.md`** (one per target) — "your part" customization. Template at `~/.claude/skills/harness/templates/DISPATCH-INSTRUCTION.template.md`. Includes: target identity + role; pointer to `brief-enriched.md`; specific deliverable + acceptance criteria; upstream phases it depends on (with paths to read); downstream phases that will consume its outputs (so it produces compatible shapes); its output path; coordination rules.

## DAG execution loop

```
For each wave in manifest.parallel_waves:
  For each phase in wave (parallel when no write-conflict):
    - Dispatch (business/squad/agent-x) with DISPATCH-INSTRUCTION path
    - Emit dispatch_<type> audit event
  Wait until every phase in wave has HANDOFF.json status="completed"
    AND outputs/_SUMMARY.md exists.
  Update manifest.json (finished_at, status per phase).
  Next wave.

After last wave: global quality gate + delivered.
```

## Read order for downstream targets (before producing)

1. `../../brief-enriched.md` (full context — once per session)
2. Their own `DISPATCH-INSTRUCTION.md` (their specific scope)
3. `_SUMMARY.md` of each upstream phase in `depends_on` (1 page each — cheap)
4. (Only when needed) specific files under `../<upstream>/outputs/` mentioned in their DISPATCH-INSTRUCTION

The `_SUMMARY.md` is the **public API between phases**. Targets write it at completion (1 page max) so downstream targets don't parse all upstream outputs.

## Cross-phase coordination signals (audit-only, never inline conversation)

- `plan_change_request` — target writes `plan-change-requests/<slug>.md` + emits event. Orchestrator decides whether to re-plan.
- `mention` events — target signals partial-result available so a sibling target can start early.
- `notify_human` — only for true blockers; orchestrator escalates.

Targets **never** modify other targets' outputs directly. Scope isolation is enforced by the project dir layout.

## Parallel dispatch primitive

When Phase 4 produces multiple targets with no data dependency, run them concurrently:

```ts
import { planDag, executePlan, fromOrgChart } from "~/.claude/skills/harness/lib/dag-planner.ts";
const plan = planDag(nodes);              // topological layers
const result = await executePlan(plan, runFn, { concurrency: 2 });
```

Before parallelizing, the race-detector checks for write-write, handoff-collision, and read-write conflicts; it recommends serial fallback if any risk exists. Capabilities opt in via `parallel_safe: true` + `writes_paths: [...]` in their schema. Keep concurrency modest (2-3) to avoid runtime rate limits.
