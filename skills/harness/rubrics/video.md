---
name: video
display_name: "Video (reel, ad, explainer)"
type: harness_rubric
version: 1.0.0
target_model: inherit
pass_threshold: 70
applies_to_produces:
  - video
  - reel
  - explainer
  - ad-video
description: |
  Avalia vídeo (assumindo que o judge recebe descrição estruturada ou
  storyboard + frames-chave). Hook nos primeiros 3s é decisivo.
---

# Video Rubric

## Inputs
```json
{
  "artifact_description": "<storyboard or frame-level description>",
  "artifact_path": "<file path>",
  "duration_seconds": <number>,
  "brief": "<original>"
}
```

## Criteria

1. **hook_first_3s** (weight 30)  
   Primeiros 3 segundos retêm atenção. Falha: logo do canal no início,
   "olá pessoal", lentidão de exposição.

2. **brief_fidelity** (weight 20)  
   Mensagem principal entregue. Tom adequado. Persona/produto retratado.

3. **pacing** (weight 15)  
   Cortes na cadência certa. Sem dead air. Música/SFX casa com cortes.

4. **audio_quality** (weight 10)  
   Voz clara, sem ruído ambiente, mixed levels. Música não compete com fala.

5. **caption_quality** (weight 10)  
   Closed captions presentes, sincronizados, sem typos. Plataforma exige.

6. **cta_quality** (weight 5)  
   CTA visual + auditivo. Claro. Específico.

7. **brand_consistency** (weight 5)  
   Cores, tom, logo placement.

8. **platform_fit** (weight 5)  
   Aspect ratio (9:16 reels, 1:1 feed, 16:9 YouTube). Duração dentro do limite.

## Output schema
Padrão. Critique[] cita timecodes (mm:ss).
