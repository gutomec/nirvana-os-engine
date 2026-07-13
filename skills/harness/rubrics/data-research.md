---
name: data_research
display_name: "Data / Research (relatório de pesquisa, análise de dados, dataset)"
type: harness_rubric
version: 1.0.0
target_model: opus
pass_threshold: 75
applies_to_produces:
  - market-research
  - competitive-analysis
  - dataset
  - data-analysis
  - benchmark
  - audit-report
description: |
  Pesquisa rigorosa: fontes verificáveis, sem fabricação. Opus por padrão
  porque hallucinations são catastróficas aqui.
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
   Toda alegação numérica/factual aponta para fonte verificável (URL,
   paper, base oficial). Sem números soltos. Sem "estudos mostram" sem
   citação. **Falha grave → reprova sem revisão (gerar de novo do zero).**

2. **no_fabrication** (weight 25)  
   Nomes, datas, citações de pessoas existem como citadas. Cuidado com
   nomes de "executivos da empresa X" inventados, papers que não existem.

3. **brief_fidelity** (weight 15)  
   Cobre o escopo pedido. Não foge para tangentes próximas.

4. **methodology_explicit** (weight 10)  
   Como o dado foi obtido? Sample size, janela temporal, filtros, fonte.
   Sem black-box.

5. **calibration** (weight 10)  
   Quando incerto, diz "incerto". Não inflaciona certeza. Distingue dado
   primário de opinião informada.

6. **synthesis_quality** (weight 5)  
   Vai além de listar fontes: tira conclusão coerente, identifica padrão.

7. **structure** (weight 3)  
   Executive summary → método → achados → implicações → limitações.

8. **trade_offs_explicit** (weight 2)  
   Quando recomenda, mostra trade-off. Não apresenta solução única
   sem alternativas.

## Output schema
Padrão. Critique[] obrigatoriamente cita evidência para cada item.
