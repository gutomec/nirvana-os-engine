---
name: prose_shortform
display_name: "Prose — Shortform (post, copy, caption, comment)"
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
# PT/EN synonyms of the slugs above (rubric-selector.ts): the same artifact
# spelled the other way selects this rubric instead of the generic fallback.
aliases:
  - post
  - post-instagram
  - post-blog
  - artigo
  - legenda
  - copy-de-anuncio
  - social-post
  - ad-copy
  - email
  - email-marketing
  - roteiro-de-post
description: |
  Short, dense, no fat. The criteria reflect that the most common failures
  in short prose are genericness, a weak hook and a missing/generic CTA.
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
   The first sentence stops the scroll. Failures: starts with "in this post", "let's
   talk about", "many professionals". No specific promise.

2. **brief_fidelity** (weight 20)  
   Covers every point of the brief without inflating.

3. **specificity** (weight 15)  
   Concrete > abstract. Numbers, names, examples. No clichés.

4. **cta_quality** (weight 10)  
   A CTA exists, is clear, is specific. "Learn more" does not count. "Reply to
   this post with X" counts.

5. **no_llm_tells** (weight 10)  
   Same criterion as longform, adjusted: em-dash overuse, rule-of-three,
   "let's explore", "ultimately", "transform your life". The equivalent tells in the deliverable's language count too.

6. **platform_fit** (weight 10)  
   Character limit respected. Tone suited to the platform. Hashtags
   (Instagram) or tags (LinkedIn) coherent. No blog tone mixed into
   Twitter.

7. **scannability** (weight 5)  
   Line breaks, emphasis (bold/italic) where they make sense. Not a
   compact block of text.

8. **brand_consistency** (weight 5)  
   If the brief mentioned a brand/client, the tone is consistent.

## Output schema
Same as prose-longform: `verdict`, `total_score`, `criteria_scores[]`, `critique[]`.
