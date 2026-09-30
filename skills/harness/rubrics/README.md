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
description: |
  Breve descrição do escopo da rubric.
---
```

Após o frontmatter, o corpo Markdown contém:
- `## Inputs` — schema JSON dos campos que o judge recebe
- `## Criteria` — lista numerada de critérios com pesos (soma normalmente = 100)
- `## Output schema` — schema da resposta JSON do judge

## Componentes que consomem rubrics

| Módulo | Função |
|---|---|
| `lib/rubric-selector.ts` | Carrega todas as rubrics; mapeia `produces[]` → rubrics aplicáveis. |
| `lib/judge.ts` | Recebe `(rubric, artifact)`, invoca o host-agent (Claude Code / Codex / Gemini), valida resposta contra schema. |
| `lib/critique.ts` | Transforma critique em instrução acionável de revisão. |
| `lib/revision-dispatch.ts` | Orquestra `judge → critique → revise → judge` em loop até converger ou estourar `max_revisions`. |

## Quando o juiz roda

`quality_gate.judge_enabled` tem três valores:

- `reports` (padrão): o juiz avalia os entregáveis de texto (`.md`, `.txt`) contra o brief; código, imagens e dados seguem nas rubricas heurísticas.
- `true`: o juiz avalia todo arquivo que o gate cobre.
- `false`: só as heurísticas offline.

Com `delivery.produces_to_rubric` (ligado por padrão), o `produces[]` do alvo escolhe a rubrica de domínio, como `data_research` para uma pesquisa; um produces sem rubrica cai na rubrica que a extensão indica.

1. Para mudar o modo: `nrv config set quality_gate.judge_enabled <reports|true|false>`.
2. O pipeline de entrega (`lib/delivery-pipeline.ts`) chama o gate com o brief do run.
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

## Hard gates (falha individual = reprova sem revisão)

Algumas rubrics declaram critérios com **HARD GATE** no body:

- `data-research.md`: `source_grounding` (sem fonte = re-geração total)
- `juridical.md`: `citation_verifiability` (citação inventada = re-geração total)
- `design.md`: `wcag_2_2_AA` (falha de acessibilidade)
- `image.md`: tradicionalmente `no_artifacts` quando crítico

O `judge.ts` deve sinalizar severity:"high" em qualquer item desses; o loop então
decide se aceita revisão (severity high é fixable=true) ou aborta (fixable=false).
