# Pre-Ship Rubric

> Used by `quality-judge.runQualityJudge` immediately before delivering work
> to the user. The last line of defense.

Three categories. All three must clear `≥ 80%`. Verdict otherwise is
`needs_revision` (no `fail` here — pre-ship issues are always actionable).

## 1. Humanization applied

- (veto) The deliverable reads as human-written, free of the AI tells the writing contract (BP13, loaded via the runtime memory file) requires every agent to avoid: excessive em-dashes, rule of three, vague attributions, filler openers.
- User's locale is mirrored (responses in PT-BR when the user wrote PT-BR).

## 2. Business goal met

- (veto) The deliverable addresses the brief's primary outcome — not a
  tangent.
- Constraints declared in the brief (budget, time, format) are respected.
- Out-of-scope items declared in the plan are still out of scope.

## 3. Audit trail complete

- `audit.jsonl` contains `brief_received`, `routing_decision`, at least one
  `invocation_start`/`invocation_end` pair, and any `approval_*` events the
  workflow produced.
- All `handoff` events have `handoff_artifact` references that exist on disk.
- No `validation_failed` or `isolation_violation` events are unresolved.

## Output format

Strict JSON only — same shape as the other rubrics.
