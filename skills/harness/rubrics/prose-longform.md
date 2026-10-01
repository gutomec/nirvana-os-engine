---
name: prose_longform
display_name: "Prose — Longform (book, report, essay, dossier)"
type: harness_rubric
version: 1.0.0
target_model: inherit
pass_threshold: 70
applies_to_produces:
  - book
  - longform-report
  - ensaio
  - dossie
  - market-research-report
  - board-memo
# PT/EN synonyms of the slugs above (rubric-selector.ts): the same artifact
# spelled the other way selects this rubric instead of the generic fallback.
aliases:
  - livro
  - relatorio
  - relatório
  - ebook
  - dossier
  - whitepaper
  - long-form-report
  - memorando
  - report
description: |
  Quality criteria for long-prose deliverables (≥ 1500 words).
  Focus on structure, argumentative coherence, factual precision and absence
  of LLM tells.
---

# Prose Longform Rubric

## Inputs
```json
{
  "artifact": "<full markdown text>",
  "brief": "<original user brief>",
  "expected_length_words": <number|null>
}
```

## Criteria (each scored 0-10, weighted)

1. **brief_fidelity** (weight 25)  
   Does the artifact answer ALL the explicit requirements of the brief? Failures:
   generic paragraphs unconnected to the request; assuming constraints the
   user did not state; omitting requested deliverables.

2. **structure** (weight 20)  
   Hierarchical H1/H2/H3 headers, paragraphs with a clear thesis, transitions
   between sections. Failure: walls of text, decorative headers with no distinct
   content, lists instead of prose where prose would be better.

3. **factual_precision** (weight 20)  
   Are dates, numbers, names and quotes verifiable? Is there a concrete claim
   or is everything vague? Common failures: "studies show", "many experts",
   round numbers without a source, generic years.

4. **no_llm_tells** (weight 15)  
   Absence of: em-dash overuse (3+ in a paragraph); artificial rule of three
   ("rapid, robust, and resilient"); vague attributions ("some say",
   "often argued"); formulaic conclusions ("in summary",
   "ultimately"); negative parallelism ("not X, but Y"). The equivalent tells in the deliverable's language count too.

5. **argumentative_coherence** (weight 10)  
   The thesis appears early, is developed, is defended against counterarguments,
   and concludes. Failure: the thesis changes midway, the conclusion does not talk to the introduction.

6. **length_discipline** (weight 5)  
   Within ±20% of `expected_length_words`. Serious failure: ≥ 50% deviation
   or text that clearly padded to hit the target.

7. **natural_voice** (weight 5)  
   No robotic cadences; uses contractions; varies sentence length;
   has at least ONE observation that sounds personal/contextual (not generic).
   Follows the writing contract of AGENTS.md/CLAUDE.md/GEMINI.md.

## Output schema (judge must return)
```json
{
  "verdict": "pass" | "fail",
  "total_score": <0-100>,
  "criteria_scores": [
    { "name": "<criterion>", "score": <0-10>, "weight": <number>,
      "rationale": "<short>", "severity": "low"|"medium"|"high"|null,
      "fixable": true|false }
  ],
  "critique": [
    { "id": "<c1>", "severity": "high|medium|low",
      "issue": "<concrete problem>", "suggested_fix": "<actionable>" }
  ]
}
```
