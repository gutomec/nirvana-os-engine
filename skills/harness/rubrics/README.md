# Rubrics — Phase 3 (Quality Gate com Revision Loop)

Cada rubric vive em um arquivo `<name>.md` com frontmatter YAML declarando:

```yaml
---
name: prose_shortform                # slug interno
display_name: "Prose — Shortform …"  # human-readable
type: harness_rubric                  # OBRIGATÓRIO — filtro do loader
version: 1.0.0
target_model: inherit
pass_threshold: 75                    # 0-100; abaixo disso → fail
applies_to_produces:                  # lista de slugs de `produces` que disparam essa rubric
  - blog-post
  - instagram-post
hard_gates:                           # invariantes booleanas que anulam a nota total
  - source_grounding
description: |
  Breve descrição do escopo da rubric.
---
```

Após o frontmatter, o corpo Markdown contém:
- `## Inputs` — schema JSON dos campos que o judge recebe
- `## Criteria` — lista numerada de critérios com pesos (soma normalmente = 100)
- `## Output schema` — schema da resposta JSON do judge, incluindo
  `hard_gate_results[]` quando o frontmatter declara hard gates

## Componentes que consomem rubrics

| Módulo | Função |
|---|---|
| `lib/rubric-selector.ts` | Carrega todas as rubrics; mapeia `produces[]` → rubrics aplicáveis. |
| `lib/judge.ts` | Recebe `(rubric, artifact)`, invoca o host-agent (Claude Code / Codex / Gemini), valida resposta contra schema. |
| `lib/critique.ts` | Transforma critique em instrução acionável de revisão. |
| `lib/revision-dispatch.ts` | Orquestra `judge → critique → revise → judge` em loop até converger ou estourar `max_revisions`. |

## Como ativar o gate em produção

Por padrão a Fase 3 vem desligada (`quality_gate.judge_enabled: false`). Para ativar:

1. Edite `skills/harness/config.yaml`:
   ```yaml
   quality_gate:
     judge_enabled: true
     max_revisions: 2
   ```
2. Implemente o ponto de chamada no `lib/dispatch.ts` (não está incluído na entrega da Fase 3 para evitar mudança invasiva no dispatcher core; veja `docs/nirvana-evolution/decisions/0001-judge-integration-deferred.md`).
3. Rode `bun test skills/harness/tests/` para confirmar 100%.
4. Monitore audit log para os novos eventos:
   - `judge_invoked` — judge LLM call iniciado
   - `critique_generated` — verdict + critique retornados
   - `revision_dispatched` — re-invocação com instrução de revisão
   - `revision_loop_exhausted` — `max_revisions` atingido sem convergir

## Quando criar uma rubric nova

Quando um novo tipo de deliverable não casa com nenhuma das 8 existentes:

1. Defina o slug do `produces` (ex: `podcast-episode`).
2. Crie `<name>.md` neste diretório com frontmatter completo.
3. Garanta ≥ 5 critérios com pesos somando 100.
4. Inclua o schema de output JSON.
5. Adicione testes em `tests/rubric-selector.test.ts` cobrindo o mapping.
6. Rode o suite.

## Quando NÃO criar rubric

- Para uma variação pequena de tipo existente (ex: "carrossel" de Instagram → usar `prose_shortform` com hint).
- Para teste único / one-off — use `mock_judge` em vez disso.
- Para mudança em critério existente — versionar a rubric existente, não criar nova.

## Hard gates (falha individual = reprova)

Hard gates executáveis são declarados em `hard_gates` no frontmatter. O judge
exige um `hard_gate_results[]` com o nome exato e um booleano `passed` para cada
item. Resultado ausente ou `passed: false` força `verdict: fail`, mesmo quando a
LLM devolve nota acima do corte. O loader também reconhece os marcadores
numerados `[HARD GATE]` das rubrics antigas para preservar compatibilidade.

Rubrics com hard gates:

- `data-research.md`: `source_grounding` (sem fonte = re-geração total)
- `juridical.md`: `citation_verifiability` (citação inventada = re-geração total)
- `design.md`: `final_composite_contrast`, `rendered_text_containment` e
  `wcag_2_2_AA`
- `image.md`: `final_composite_contrast`, `rendered_text_containment` e
  `no_artifacts`

O `judge.ts` adiciona uma crítica `severity:"high"` para orientar a revisão, mas
o bloqueio não depende da severidade: o booleano do hard gate é a autoridade.
