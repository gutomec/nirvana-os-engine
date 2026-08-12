---
name: prose_longform
display_name: "Prose — Longform (livro, relatório, ensaio, dossiê)"
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
description: |
  Critérios de qualidade para deliverables de prosa longa (≥ 1500 palavras).
  Foco em estrutura, coerência argumentativa, precisão factual e ausência
  de tells de LLM.
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
   O artefato responde a TODOS os requisitos explícitos do brief? Falhas:
   parágrafos genéricos não conectados ao pedido; assumir restrições que o
   usuário não fez; omitir entregáveis solicitados.

2. **structure** (weight 20)  
   Headers H1/H2/H3 hierárquicos, parágrafos com tese clara, transições
   entre seções. Falha: muros de texto, headers decorativos sem conteúdo
   distinto, listas em vez de prosa onde prosa seria melhor.

3. **factual_precision** (weight 20)  
   Datas, números, nomes e citações são verificáveis? Há alegação concreta
   ou tudo é vago? Falhas comuns: "estudos mostram", "muitos especialistas",
   números redondos sem fonte, anos genéricos.

4. **no_llm_tells** (weight 15)  
   Ausência de: em-dash overuse (3+ em parágrafo); regra de três artificial
   ("rapid, robust, and resilient"); atribuições vagas ("alguns dizem",
   "frequentemente argumentado"); conclusões formulaicas ("em síntese",
   "em última análise"); negative parallelism ("não X, mas Y").

5. **argumentative_coherence** (weight 10)  
   Tese aparece cedo, é desenvolvida, é defendida contra contra-argumentos,
   conclui. Falha: tese muda no meio, conclusão não conversa com introdução.

6. **length_discipline** (weight 5)  
   Dentro de ±20% do `expected_length_words`. Falha grave: ≥ 50% de desvio
   ou texto que claramente "encheu linguiça" para bater meta.

7. **natural_voice** (weight 5)  
   Sem cadências robóticas; usa contrações; varia comprimento de frase;
   tem ao menos UMA observação que soa pessoal/contextual (não genérica).
   Segue o writing contract de AGENTS.md/CLAUDE.md/GEMINI.md.

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
