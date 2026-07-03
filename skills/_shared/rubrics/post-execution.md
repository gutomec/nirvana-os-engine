# Post-Execution Rubric

> Used by `quality-judge.runQualityJudge` after a phase produces artifacts,
> before the next phase or before commit/ship.

Four categories. Each with 1–3 checks.

- `pass` — all categories ≥ 80% AND no veto fails.
- `needs_revision` — 1–2 categories < 80%, no veto fail.
- `fail` — ≥ 3 categories below 80% OR any veto fails.

## 1. Artifact existence

- (veto) Every artifact the plan promised exists at the declared path.
- Each artifact is non-empty (≥ 50 bytes for text, ≥ 1KB for binary).
- File extensions match content (a `.json` parses, a `.md` has headers).

## 2. Claim vs evidence

- (veto) Claims in summaries map to evidence in artifacts (no fabrication).
- Numeric assertions ("scored 87/100", "increased by 12%") are reproducible
  from the artifacts cited.
- "Done" doesn't mean "stub" — a placeholder TODO is treated as not-done.

## 3. Regression check

- Pre-existing artifacts referenced by the plan still exist and are valid.
- Smoke tests that ran before the phase still pass after.
- No file outside the plan's declared write set was modified.

## 4. Output schema valid

- Each artifact validates against its declared schema (Pydantic, JSON Schema,
  YAML structure).
- Frontmatter, when present, contains required keys.
- Identifiers (slugs, capability_ids) match the project's conventions.

## 5. Volume bounds

- (veto) When the task declared a `target_words` or `word_target` range, the
  artifact word count is within ±20% of that range. Overdelivery beyond +20%
  is treated the same as under-delivery: it signals scope drift and should
  trigger `needs_revision`.
- When the task declared a `min_words` floor, the artifact meets it.
- When no target was declared, this category is skipped (not failed).
- Reasoning: in the Foguero project (May 2026), two artifacts overshot their
  targets by +54% and +68% — overdelivery looked like value but signaled the
  agent had no stop condition. A target with a tolerance band is a stop
  condition.

## Output format

Strict JSON only — same shape as `plan-quality.md`:

```json
{
  "verdict": "pass" | "needs_revision" | "fail",
  "score": 0..100,
  "categories": [...],
  "failed_checks": [...],
  "evidence": [...]
}
```
