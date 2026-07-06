# Plan Quality Rubric

> Used by `quality-judge.runQualityJudge` between planning and execution phases.

Evaluate the plan against six categories. Each category has 1–3 checks. Mark
each check **pass** or **fail** with a one-sentence reason. Verdict logic:

- `pass` if all 6 categories have ≥ 80% checks passing
- `needs_revision` if 1–2 categories below 80%
- `fail` if ≥ 3 categories below 80% OR any **veto** check fails

## 1. Completeness

- (veto) Every requirement from the source brief maps to ≥ 1 task in the plan.
- Every external dependency (file, API, secret) is declared explicitly.
- Open questions are listed when not yet answerable.

## 2. Atomicity

- Each task has a single deliverable that fits in one workflow step.
- No task description starts with "and also".
- Task scope is bounded (no "etc.", no "and so on").

## 3. Dependencies

- (veto) The DAG has no cycles.
- Each `depends_on` references a task ID that exists in the same plan.
- Wave grouping respects dependencies.

## 4. Acceptance criteria

- (veto) Every task has at least one binary-verifiable acceptance criterion.
- Criteria are observable (file exists, output schema matches, test passes).
- Subjective terms ("nice", "clean", "good") do not appear without a metric.

## 5. Scope

- The plan does not introduce work outside the brief's stated goal.
- Out-of-scope items are listed explicitly under `out_of_scope`.
- Future work is deferred to a follow-up plan, not silently included.

## 6. Feasibility

- Time / cost estimates are present and rounded to a real unit.
- No task requires a tool not already authorized for the squad/business.
- High-risk steps have a fallback or rollback path.

## Output format

Respond with strict JSON only:

```json
{
  "verdict": "pass" | "needs_revision" | "fail",
  "score": 0..100,
  "categories": [
    { "id": 1, "name": "completeness", "passed": true, "passed_checks": 3, "total_checks": 3, "notes": "..." },
    ...
  ],
  "failed_checks": [
    { "category": "completeness", "check": "Every requirement maps to ≥ 1 task", "reason": "Requirement R-04 has no corresponding task." }
  ],
  "evidence": [ "short sentences citing what you saw in the artifact" ]
}
```
