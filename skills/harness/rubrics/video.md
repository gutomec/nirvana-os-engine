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
# PT/EN synonyms of the slugs above (rubric-selector.ts): the same artifact
# spelled the other way selects this rubric instead of the generic fallback.
aliases:
  - vídeo
  - reels
  - anuncio-em-video
  - roteiro-de-video
  - motion-graphic
  - shorts
description: |
  Evaluates video (assuming the judge receives a structured description or
  a storyboard + key frames). The hook in the first 3s is decisive.
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
   The first 3 seconds hold attention. Failure: channel logo at the start,
   "hi everyone", slow exposition.

2. **brief_fidelity** (weight 20)  
   Main message delivered. Appropriate tone. Persona/product portrayed.

3. **pacing** (weight 15)  
   Cuts at the right cadence. No dead air. Music/SFX match the cuts.

4. **audio_quality** (weight 10)  
   Clear voice, no ambient noise, balanced levels. Music does not compete with speech.

5. **caption_quality** (weight 10)  
   Closed captions present, synchronized, no typos. The platform requires it.

6. **cta_quality** (weight 5)  
   Visual + audible CTA. Clear. Specific.

7. **brand_consistency** (weight 5)  
   Colors, tone, logo placement.

8. **platform_fit** (weight 5)  
   Aspect ratio (9:16 reels, 1:1 feed, 16:9 YouTube). Duration within the limit.

## Output schema
Default. Critique[] cites timecodes (mm:ss).
