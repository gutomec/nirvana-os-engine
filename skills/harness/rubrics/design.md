---
name: design
display_name: "Design (UI, landing page, design system, mockup)"
type: harness_rubric
version: 1.0.0
target_model: inherit
pass_threshold: 75
applies_to_produces:
  - landing-page
  - mockup
  - design-system
  - ui-component
  - figma-frame
# PT/EN synonyms of the slugs above (rubric-selector.ts): the same artifact
# spelled the other way selects this rubric instead of the generic fallback.
aliases:
  - design
  - pagina-de-vendas
  - página-de-vendas
  - landing
  - wireframe
  - prototipo
  - protótipo
  - identidade-visual
  - brand-kit
  - site
description: |
  Evaluates design (assuming generated HTML/CSS or a structured Figma
  description). WCAG 2.2 AA is the accessibility hard gate.
---

# Design Rubric

## Inputs
```json
{
  "artifact": "<HTML/CSS code or screenshot description>",
  "tokens": "<DTCG tokens.json if available>",
  "brief": "<original>"
}
```

## Criteria

1. **brief_fidelity** (weight 20)  
   The layout delivers what was requested. Requested sections present. CTA with clear hierarchy.

2. **wcag_2_2_AA** (weight 20) **[HARD GATE — individual failure fails the artifact]**  
   Text color contrast ≥ 4.5:1. Visible focus. Minimum touch target
   44×44. Labels for all inputs. Alt text on images.

3. **visual_hierarchy** (weight 15)  
   Clear eye travel: hero → benefit → social proof → CTA. No
   "wall of text". Scalable headlines (mobile/desktop).

4. **typography_system** (weight 10)  
   Consistent scale. Readable line-height (1.4-1.6 body). Serif/sans
   pairing respected.

5. **color_palette_discipline** (weight 10)  
   Colors derive from tokens, not hardcoded at random. States (hover/active/
   disabled) coherent. Working dark mode if applicable.

6. **spacing_rhythm** (weight 10)  
   Consistent spacing scale (4/8/16/24/32...). No random padding.

7. **responsive** (weight 10)  
   Mobile-first or at least declared breakpoints. No horizontal overflow.

8. **performance_hints** (weight 5)  
   Images with lazy loading; fonts with font-display: swap; no huge
   hardcoded assets.

## Output schema
Default. A WCAG failure requires severity:high.
