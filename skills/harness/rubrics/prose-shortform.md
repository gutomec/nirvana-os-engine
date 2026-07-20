---
name: prose_shortform
display_name: "Prose — Shortform (post, copy, caption, comentário)"
type: harness_rubric
version: 1.0.0
target_model: inherit
pass_threshold: 75
applies_to_produces:
  - blog-post
  - instagram-post
  - twitter-thread
  - linkedin-post
  - newsletter
  - copy
  - caption
description: |
  Curto, denso, sem gordura. Critérios refletem que o falhas mais comuns
  em prose curta são genericidade, hook fraco e CTA ausente/genérico.
---

# Prose Shortform Rubric

## Inputs
```json
{
  "artifact": "<text>",
  "brief": "<original brief>",
  "platform": "instagram"|"linkedin"|"twitter"|"blog"|"email"|null,
  "expected_length_chars": <number|null>
}
```

## Criteria

1. **hook_strength** (weight 25)  
   Primeira frase para o scroll. Falhas: começa com "neste post", "vamos
   falar sobre", "muitos profissionais". Sem promessa específica.

2. **brief_fidelity** (weight 20)  
   Cobre todos os pontos do brief sem inflar.

3. **specificity** (weight 15)  
   Concreto > abstrato. Números, nomes, exemplos. Sem chavões.

4. **cta_quality** (weight 10)  
   CTA existe, é claro, é específico. "Saiba mais" não conta. "Responda
   este post com X" conta.

5. **no_llm_tells** (weight 10)  
   Mesmo critério da longform, ajustado: em-dash overuse, rule-of-three,
   "vamos explorar", "em última análise", "transforme sua vida".

6. **platform_fit** (weight 10)  
   Limite de caracteres respeitado. Tom adequado à plataforma. Hashtags
   (Instagram) ou tags (LinkedIn) coerentes. Sem misturar tom blog em
   Twitter.

7. **scannability** (weight 5)  
   Quebras de linha, ênfases (bold/itálico) onde fazem sentido. Não é um
   bloco de texto compacto.

8. **brand_consistency** (weight 5)  
   Se o brief mencionou marca/cliente, o tom é consistente.

## Output schema
Igual ao prose-longform: `verdict`, `total_score`, `criteria_scores[]`, `critique[]`.
