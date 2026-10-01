---
name: juridical
display_name: "Juridical (legal opinion, petition, contract, case law)"
type: harness_rubric
version: 1.0.0
target_model: inherit
pass_threshold: 80
applies_to_produces:
  - parecer
  - peticao
  - contrato
  - jurisprudencia
  - juridical-research
  - analise-contratual
# PT/EN synonyms of the slugs above (rubric-selector.ts): the same artifact
# spelled the other way selects this rubric instead of the generic fallback.
aliases:
  - parecer-juridico
  - parecer-jurídico
  - petição
  - peça-processual
  - contract
  - legal-opinion
  - legal-research
description: |
  High threshold (80) because legal errors are costly. Opus by default.
  Cites legislation and case law only when verifiable; no hallucinated
  case numbers, precedents or articles.
---

# Juridical Rubric

## Inputs
```json
{
  "artifact": "<full text>",
  "brief": "<original>",
  "jurisdiction": "BR"|"MG"|"...|null",
  "doc_kind": "parecer"|"peticao"|"contrato"|"pesquisa"|...
}
```

## Criteria

1. **citation_verifiability** (weight 30) **[HARD GATE]**  
   Cited statute articles exist and are pertinent. Cited precedents
   exist (labor, supreme and superior courts, state courts where applicable). Rulings with a
   real number. **Individual failure → fails without revision; regenerate from scratch.**

2. **brief_fidelity** (weight 15)  
   Answers the question exactly as formulated.

3. **jurisdictional_correctness** (weight 15)  
   Does not apply the wrong law (e.g. labor code to a civil partnership, consumer
   protection code to B2B). Considers the declared jurisdiction.

4. **structure** (weight 10)  
   Opinion: summary → facts → grounds → conclusion. Petition: correct formal
   pleading parts. Contract: numbered, classified clauses.

5. **risk_calibration** (weight 10)  
   Identifies risks with gradation (high/medium/low). Neither alarmism
   nor complacency.

6. **alternative_paths** (weight 8)  
   When there is more than one strategy, lists them (does not impose one).

7. **plain_language_where_needed** (weight 5)  
   For a lay client, there is an executive summary in plain language.

8. **deadlines_explicit** (weight 2)  
   Limitation and forfeiture periods identified when relevant.

## Output schema
Default. Severity HIGH is required for any citation_verifiability issue.
