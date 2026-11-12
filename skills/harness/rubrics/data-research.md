---
name: data_research
display_name: "Data / Research (research report, data analysis, dataset)"
type: harness_rubric
version: 1.0.0
target_model: inherit
pass_threshold: 75
applies_to_produces:
  - market-research
  - competitive-analysis
  - dataset
  - data-analysis
  - benchmark
  - audit-report
# PT/EN synonyms of the slugs above (rubric-selector.ts): the same artifact
# spelled the other way selects this rubric instead of the generic fallback.
aliases:
  - pesquisa
  - pesquisa-de-mercado
  - analise-de-dados
  - análise-de-dados
  - analise-competitiva
  - análise-competitiva
  - relatorio-de-pesquisa
  - auditoria
  - research
  - planilha
description: |
  Rigorous research: verifiable sources, no fabrication. Opus by default
  because hallucinations are catastrophic here.
---

# Data / Research Rubric

## Inputs
```json
{
  "artifact": "<full report>",
  "brief": "<original>",
  "claimed_sources": ["<URL or citation>", ...]
}
```

## Criteria

1. **source_grounding** (weight 30) **[HARD GATE]**  
   Every numeric/factual claim points to a verifiable source (URL,
   paper, official database). No loose numbers. No "studies show" without
   a citation. **Serious failure → fails without revision (regenerate from scratch).**

2. **no_fabrication** (weight 25)  
   Names, dates and quotes from people exist as cited. Beware of invented
   "executives of company X" and papers that do not exist.

3. **brief_fidelity** (weight 15)  
   Covers the requested scope. Does not drift into nearby tangents.

4. **methodology_explicit** (weight 10)  
   How was the data obtained? Sample size, time window, filters, source.
   No black box.

5. **calibration** (weight 10)  
   When uncertain, says "uncertain". Does not inflate certainty. Distinguishes
   primary data from informed opinion.

6. **synthesis_quality** (weight 5)  
   Goes beyond listing sources: draws a coherent conclusion, identifies a pattern.

7. **structure** (weight 3)  
   Executive summary → method → findings → implications → limitations.

8. **trade_offs_explicit** (weight 2)  
   When recommending, shows the trade-off. Does not present a single
   solution without alternatives.

## Output schema
Default. Critique[] must cite evidence for each item.
