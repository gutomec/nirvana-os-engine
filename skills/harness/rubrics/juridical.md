---
name: juridical
display_name: "Juridical (parecer, peticao, contrato, jurisprudencia)"
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
description: |
  Threshold alto (80) porque erros jurídicos têm custo alto. Opus por padrão.
  Cita legislação e jurisprudência só quando verificável; sem alucinar
  números de processo, súmulas ou artigos.
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
   Artigos de lei citados existem e são pertinentes. Súmulas citadas
   existem (TST, STF, STJ, TJMG quando aplicável). Acórdãos com número
   real. **Falha individual → reprova sem revisão; gerar do zero.**

2. **brief_fidelity** (weight 15)  
   Responde a pergunta exatamente como formulada.

3. **jurisdictional_correctness** (weight 15)  
   Não aplica direito errado (ex: CLT em sociedade civil, código de
   defesa do consumidor em B2B). Considera jurisdição declarada.

4. **structure** (weight 10)  
   Parecer: ementa → fatos → fundamentos → conclusão. Petição: peças
   formais corretas. Contrato: cláusulas numeradas e classificadas.

5. **risk_calibration** (weight 10)  
   Identifica riscos com graduação (alto/médio/baixo). Sem alarmismo
   nem complacência.

6. **alternative_paths** (weight 8)  
   Quando há mais de uma estratégia, lista (não impõe uma).

7. **plain_language_where_needed** (weight 5)  
   Para cliente leigo, há sumário executivo em português claro.

8. **deadlines_explicit** (weight 2)  
   Prazos prescricionais/decadenciais identificados quando relevantes.

## Output schema
Padrão. Severity HIGH obrigatório para qualquer issue de citation_verifiability.
