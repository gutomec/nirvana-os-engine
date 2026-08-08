# Walkthrough: one brief, end to end

This traces a real dispatch so you can see the moving parts — and, if you are an
agent, the exact steps and the receipt you must produce. Nothing here is
special-cased; it is the ordinary path every production brief takes.

## The brief

The user types, in plain prose:

> "Analyze the competitive landscape for AI note-taking apps and write me a
> one-page brief with the three biggest gaps."

The user picks nothing else — no squad, no model, no flags. That is the point.

## What the maestro does

**1. Engage the harness.** The single entry point:

```
Skill("harness", "Analyze the competitive landscape for AI note-taking apps and write me a one-page brief with the three biggest gaps.")
```

**2. Route (zero-token preview available).** The harness consults the three
registries. You can see the same decision the maestro makes:

```
$ nrv find "competitive landscape analysis, one-page brief"
signal:   HIGH
target:   squad_capability · research-intelligence:market.competitive_analysis.execute
```

A research/market squad matches by content. No model is chosen — the run
inherits whatever model the user's runtime is set to.

**3. Prep (this is what writes the audit trail).** Before spawning, run the
scripted prep for the target. It scaffolds the project and emits the first
events on any runtime — you do not rely on remembering to log:

```
$ bun ~/.claude/skills/squads/scripts/brief-squad.ts research-intelligence \
    "competitive landscape for AI note-taking apps → one-page gap brief" \
    --project proj-20260717-notetaking
```

**4. Dispatch.** Spawn the runtime's native in-process subagent over the squad's
`squad.yaml` + workflow, handed the enriched brief path, an `output_path`, and
the `trace_id`. The subagent — not you — produces the artifact.

**5. Gate.** When the deliverable lands, run the quality gate:

```
$ nrv quality-gate outputs/proj-20260717-notetaking/brief.md --auto
```

It picks rubrics by extension, returns a verdict, and emits `gate_passed` or
`gate_failed`. Fail-closed: if no rubric applies, the exit is non-zero.

**6. Deliver.** Report the artifact path to the user. You never pasted the brief
into chat — you directed its creation.

## The receipt (proof it happened)

A run that leaves no trail is a bug. After the dispatch, the audit log holds the
story — the user can read it, and so can you:

```
$ tail ~/.harness-logs/2026-07-17/audit.jsonl | jq -c '{event, squad_name}'
{"event":"brief_received","squad_name":"research-intelligence"}
{"event":"dispatch_squad","squad_name":"research-intelligence"}
{"event":"gate_passed","squad_name":"research-intelligence"}
{"event":"delivered","squad_name":"research-intelligence"}
```

Each line is one JSON object with `ts`, `event`, `trace_id`, and event-specific
fields. `brief_received` and `dispatch_squad` come free from step 3;
`gate_passed`/`gate_failed` from step 5; `delivered` when you hand the path back.

If that log is empty after a run, the completion message is not honest yet —
something in steps 3–6 was skipped.

## The two rules this run obeyed

1. **The orchestrator never produces the artifact.** The maestro routed, prepped,
   gated and delivered. The squad wrote the brief.
2. **The engine never prescribes a model.** No model was set anywhere; the run
   used the user's configured model. Only an explicit user request would change
   that.
