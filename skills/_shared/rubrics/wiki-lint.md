# Wiki Lint Rubric — Cross-Document Consistency

> Used by `quality-judge.runQualityJudge` with `phase: 'wiki_lint'` and a
> multi-artifact context. Returns a list of factual contradictions across
> documents (entity pages, briefs, outputs).

## What this rubric is for

You will be given N documents that are supposed to live together coherently
(brand book + landing page + panfleto, or research thesis + 4 source notes,
or business org-chart + employee personas). Your job is to find **factual
contradictions** between them — places where Doc A claims X about a thing and
Doc B claims something incompatible about the same thing.

## Categories of contradiction

For each contradiction you find, classify it:

- **naming** — different names/labels for the same entity (e.g. brand-book
  says "Verde Tatá", panfleto says "Molho Verde")
- **strategy** — incompatible strategic claims (e.g. brand-book commits to
  ES-base, panfleto is PT-only)
- **fact** — numeric or factual divergence (e.g. one doc says 10 sabores,
  another says 12)
- **temporal** — date/sequence mismatch (e.g. one doc says wave 2 ships in
  june, another says july)
- **scope** — claim covers different scopes (one doc treats X as in-scope,
  another as out-of-scope)

Severity:
- **high** — would confuse a reader/customer/supplier; needs fix before ship
- **medium** — internal-only inconsistency; should be reconciled
- **low** — minor wording drift; acceptable in non-strict contexts

## What is NOT a contradiction

- Stylistic differences (formal vs casual tone)
- Synonyms (e.g. "10 sabores" vs "dez sabores")
- Different levels of detail (a summary vs a deep dive)
- Older docs marked as historical/archived

## Output format — STRICT JSON

```json
{
  "verdict": "pass" | "fail" | "needs_revision",
  "score": 0,
  "contradictions": [
    {
      "claim_a": { "doc": "<filename:line?>", "text": "<quote>" },
      "claim_b": { "doc": "<filename:line?>", "text": "<quote>" },
      "category": "naming" | "strategy" | "fact" | "temporal" | "scope",
      "severity": "high" | "medium" | "low",
      "evidence": "<short reasoning>",
      "suggested_resolution": "<which doc should change, and how>"
    }
  ],
  "categories": [
    { "name": "consistency", "score": 0, "notes": "..." }
  ],
  "evidence": ["<observations from the artifacts>"]
}
```

### Verdict rules

- `pass` — zero contradictions found, OR only "low" severity drift that is
  contextually acceptable.
- `needs_revision` — 1-3 medium contradictions, or a single high one that is
  cleanly fixable.
- `fail` — 4+ contradictions across the docs, OR ≥2 high-severity
  contradictions, OR a contradiction that suggests a strategic ambiguity
  rather than a fixable error.

### Score rule

`score = 100 - (5 × low) - (15 × medium) - (35 × high)` — clamp 0..100.

## Discipline

- Quote the contradicting text from BOTH docs literally. Do not paraphrase
  beyond what's needed to fit a 200-char window.
- If you cannot find a contradiction, return `verdict: pass` and an empty
  `contradictions: []`. Do not invent contradictions to look thorough.
- Stylistic preferences are not contradictions. Be conservative.
- Synonyms are not contradictions. Be conservative.
- A single doc contradicting itself across paragraphs IS a contradiction —
  report it with `claim_a.doc === claim_b.doc`.
