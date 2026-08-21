---
name: design
display_name: "Design (UI, landing page, design system, mockup)"
type: harness_rubric
version: 1.1.0
target_model: inherit
pass_threshold: 75
hard_gates:
  - final_composite_contrast
  - rendered_text_containment
  - wcag_2_2_AA
applies_to_produces:
  - landing-page
  - mockup
  - design-system
  - ui-component
  - figma-frame
description: |
  Avalia design (assumindo HTML/CSS gerado ou descrição estruturada do
  Figma). WCAG 2.2 AA é hard gate de acessibilidade.
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

### Hard gates on the final render

- **final_composite_contrast** **[HARD GATE]** Measure contrast from the rendered pixels at
  the intended viewport and state, after overlays, gradients, opacity, images,
  blend modes and effects. Source color tokens or CSS values alone do not prove
  the result.
- **rendered_text_containment** **[HARD GATE]** With the intended fonts loaded, every glyph
  remains fully inside its visual container with safe padding. Clipping,
  truncation, unintended overflow, overlap or lost legibility fails the gate.
  Check every viewport, language and content state required by the brief.

1. **brief_fidelity** (weight 20)  
   Layout entrega o solicitado. Seções pedidas presentes. CTA hierárquico.

2. **wcag_2_2_AA** (weight 20) **[HARD GATE — falha individual reprova]**  
   Contraste de cor ≥ 4.5:1 para texto, medido na composição renderizada final.
   Foco visível. Tamanho mínimo de toque 44×44. Labels para todos os inputs.
   Alt-text em imagens.

3. **visual_hierarchy** (weight 15)  
   Eye traveling claro: hero → benefício → social proof → CTA. Sem
   "wall of text". Headlines escaláveis (mobile/desktop).

4. **typography_system** (weight 10)  
   Escala consistente. Line-height legível (1.4-1.6 body). Pareamento
   serif/sans respeitado. Texto integralmente visível em seu contêiner.

5. **color_palette_discipline** (weight 10)  
   Cores derivam de tokens, não hardcoded random. Estados (hover/active/
   disabled) coerentes. Modo escuro funcional se aplicável.

6. **spacing_rhythm** (weight 10)  
   Escala de espaçamento consistente (4/8/16/24/32...). Sem padding aleatório.

7. **responsive** (weight 10)  
   Mobile-first ou ao menos breakpoints declarados. Sem overflow horizontal.

8. **performance_hints** (weight 5)  
   Imagens com lazy loading; fontes com font-display: swap; sem assets
   gigantes hardcoded.

## Output schema
Padrão, incluindo `hard_gate_results[]` com `name`, `passed` e `rationale` para
cada nome declarado no frontmatter. Falha em WCAG, contraste da composição
final ou contenção do texto = severity:high obrigatório.
