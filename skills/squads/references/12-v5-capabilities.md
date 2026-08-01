# v5 Capabilities — Guia Operacional

## Quando carregar

Intent: CREATE | MODIFY | VALIDATE quando o usuário fala em "capability",
"declarar capabilities", "adicionar capability", ou está criando uma squad
v5 do zero.

## Protocol Reference

`SQUAD_PROTOCOL_V5.md` §22 (Capability Manifest), §22.9 (validation rules).
Schema: `~/.claude/skills/_shared/schemas/capability.schema.json`.
Validador: `~/.claude/skills/_shared/validators/validators.py` (classe `Capability`).
Catálogo de domains: `~/.claude/skills/_shared/catalogs/CAPABILITY_CATALOG_V1.yaml`.

---

## O que é uma capability

Uma capability é a **unidade de descoberta** do harness. Ela mapeia uma
intenção em linguagem natural ("criar funil de vendas completo") para um
ponto de invocação dentro da squad — workflow, task ou agent.

Sem `capabilities[]` na `squad.yaml`, a squad continua executável manualmente
(`*squad run`), mas fica **invisível para o harness**. O harness só roteia
para squads cujas capabilities tenham descrições, exemplos e domains bem
declarados (BM25 indexa essa metadata).

### Anatomia mínima

```yaml
capabilities:
  - id: marketing.funnel.create        # dotted, ≥3 segmentos
    description: >                      # 20-500 chars, indexado por BM25
      Criação de funil de vendas completo, da awareness ao closing.
    domains: [marketing, sales]         # 1-5 do CAPABILITY_CATALOG_V1
    invoke:
      type: workflow                    # workflow | task | agent
      ref: workflows/full-funnel-creation.yaml
    examples:                           # ≥1 obrigatório
      - "criar funil de vendas completo"
      - "construir funnel end-to-end"
```

Com isso a squad já é descobrível. Os campos seguintes são opcionais mas
fortemente recomendados.

---

## Como declarar — exemplo real

Trecho de `${SQUADS_DIR}/sales-funnel-masters/squad.yaml`:

```yaml
- id: marketing.funnel.create
  description: >
    Criação de funil de vendas completo, da awareness ao closing. Saída inclui
    arquitetura do funil, value ladder, sequência de páginas e mecânicas de conversão.
  domains: [marketing, sales, growth]
  invoke: { type: workflow, ref: workflows/full-funnel-creation.yaml }
  examples:
    - "criar funil de vendas completo para infoproduto"
    - "construir funil end-to-end com lead magnet, vsl e checkout"
    - "desenhar funnel para escalar SaaS B2C"
  not_for:
    - "tarefa pontual de copy isolada (use copy.sales_letter.write)"
    - "apenas calcular pricing (use sales.pricing.optimize)"
  outputs:
    - name: funnel_blueprint
      type: markdown
      description: Blueprint do funil com etapas, copy, pricing e tráfego
  fidelity:
    status: experimental
    threshold: 0.85
  score_boost: 1.0
  model_hint: opus
  estimated_cost_usd: 1.50
```

Observe o padrão: cada capability é **autocontida**. O harness toma decisão
de roteamento sem precisar abrir o workflow alvo.

---

## Como escolher domains

Sempre comece pelo **catálogo canônico** (`CAPABILITY_CATALOG_V1.yaml`).
São 56 domains organizados em 6 grupos:

- Marketing & Sales (10): `marketing`, `sales`, `branding`, `copy`, `growth`,
  `performance`, `ads`, `retention`, `lifecycle`, `crm`
- Content & Media (8): `content`, `media`, `video`, `audio`, `image`,
  `social_media`, `podcasting`, `journalism`
- Engineering & Tech (11): `software_engineering`, `frontend`, `backend`,
  `mobile`, `data_engineering`, `devops`, `infra`, `security`, `ml_ops`,
  `ai_research`, `qa`
- Strategy & Ops (7): `strategy`, `product`, `operations`, `analytics`,
  `finance`, `legal`, `hr`
- Knowledge & Education (5): `research`, `education`, `tutoring`,
  `documentation`, `knowledge_management`
- Health, Industry, Other (15): `health`, `wellness`, `nutrition`,
  `fitness`, `agriculture`, `manufacturing`, `logistics`, `realestate`,
  `automotive`, `energy`, `civic`, `nonprofit`, `entertainment`,
  `gaming`, `art`

Use 1 a 5 domains, ordenados do mais específico para o mais geral.

### Quando usar `experimental_domains: true`

Se o domínio que você precisa **não está no catálogo**, declare na squad:

```yaml
experimental_domains: true
```

…e use o domain customizado. O harness aplica `score_boost * 0.7` para
desempatar contra capabilities canônicas. Use isso só quando realmente
necessário — discutir adicionar o domain ao catálogo é melhor a médio prazo.

---

## Como conectar `invoke` ao workflow/task/agent

Três tipos de invocação:

### Type 1 — workflow (mais comum)

```yaml
invoke:
  type: workflow
  ref: workflows/full-funnel-creation.yaml
```

O workflow é o conjunto de passos pré-definidos. Use quando a capability
exige múltiplos agentes coordenados.

### Type 2 — task (quando há uma única tarefa específica)

```yaml
invoke:
  type: task
  ref: tasks/analyze-video.md
  agent: video-analyst                  # opcional, fixa o agent
  inputs_mapping:                       # opcional, mapeia inputs
    video_path: file
```

Use quando a capability é "execute esta task com esse agent". Útil para
capabilities atômicas.

### Type 3 — agent (sem task pré-definida)

```yaml
invoke:
  type: agent
  ref: agents/conversational-pm.md
  prompt_template: "Conversa sobre projeto: {{user_message}}"
```

Use quando o agente decide o fluxo dinamicamente. Mais flexível, menos
previsível — só para casos de chat livre / consultoria interativa.

**Regra de ouro:** prefira `type: workflow` quando a capability tem >1 passo.
Workflows são auditáveis, testáveis, resumíveis.

---

## Quando usar `humanize: true/false`

Outputs voltados a humano passam por humanização (P11) antes do retorno
final ao usuário.

```yaml
- id: copy.sales_letter.write
  # ...
  humanize: true                # default — output literário/textual

- id: data.pipeline.export
  # ...
  humanize: false               # output técnico (json/binary/file)
```

**Regra prática:**
- `markdown`, `string`, `html` voltados ao usuário → `humanize: true`
- `json`, `binary`, `file` técnicos → `humanize: false`
- Em dúvida → `true` (default)

Sem humanização em capability humana-facing, a percepção zero-human da
plataforma quebra. P11 (Squad v5 §27) é blocking quando o output vai
direto pro usuário final.

---

## Anti-patterns

NUNCA:

1. **Capability sem `examples[]`** — sem exemplos NL, BM25 não indexa
   bem. Ranking ruim, descoberta inconsistente.
2. **Capability invocando outra squad** — `invoke.ref` aponta para
   componentes da própria squad. Cross-squad é responsabilidade do harness.
3. **`description` curta demais** — schema rejeita <20 chars. Mas mesmo
   acima, evite descrições genéricas tipo "faz X". Concretize.
4. **`domains` fora do catálogo sem `experimental_domains: true`** —
   validador emite warning. Harness desranqueia.
5. **`id` com <3 segmentos** — schema rejeita. `marketing.funnel` falha,
   `marketing.funnel.create` passa.
6. **Muitas capabilities (>50)** — schema bloqueia em 50. Se sua squad
   tem >20 capabilities reais, considere quebrar em squads menores.
7. **Reusar mesma `id` em múltiplas squads sem coordenação** — duas
   squads com `marketing.funnel.create` fazem o harness escolher por
   `score_boost` + `fidelity_status`. Isso é OK e desejado, mas declare
   `not_for` para diferenciar.
8. **`fidelity.status: validated` sem `eval_results`** — o status
   `validated` exige evidência (eval ground truth + resultados). Sem
   isso, deixe `experimental`.
9. **`tools_required` com nomes runtime-específicos** — use os semantic
   names do v4 §10.7 (`read`, `write`, `bash`, `web_search`, etc.). Adapter
   traduz para nomes nativos.
10. **`estimated_cost_usd: 0`** — estimativa zero é mentira. Sem
    estimativa segura, omita o campo.

---

## Loop de qualidade ao criar uma capability

Defina sucesso antes de codar:

1. Escreva 3-5 frases NL que devem casar com a capability. Cole em
   `examples[]`.
2. Escreva 1-2 frases NL que NÃO devem casar (cite alternativa).
   Cole em `not_for[]`.
3. Rode o BM25 search local (quando o registry estiver populado):
   ```bash
   bun ~/.claude/skills/squads/tests/smoke-v5.ts
   ```
   Verifique que sua capability é a top hit para os exemplos próprios.
4. Rode o validador:
   ```bash
   bun ~/.claude/skills/squads/scripts/validate-squad.ts ${SQUADS_DIR}/<name>
   ```
5. Rode o registry rebuild:
   ```bash
   bun ~/.claude/skills/squads/scripts/index-squads.ts
   ```

Se algum passo falhar, conserte e repita. Não publique uma capability
até passar todos.

---

## Checklist final (P5)

- [ ] `id` segue regex `^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){2,}$`
- [ ] `description` ≥20 e ≤500 chars, concreta
- [ ] `domains[]` 1-5 do catálogo (ou `experimental_domains: true`)
- [ ] `invoke` aponta para arquivo existente na squad
- [ ] `examples[]` ≥1, todos ≥5 chars
- [ ] `not_for[]` cita capability alternativa quando souber
- [ ] `fidelity.status` honesto (`experimental` por default)
- [ ] `outputs[]` declarado com tipo correto
- [ ] `humanize` definido (true para texto humano, false para tech)
- [ ] `model_hint` apropriado para a complexidade
- [ ] Validação `*squad validate <name>` passa
- [ ] Registry rebuild encontra a nova capability

Sem esses, a capability tecnicamente funciona — mas o harness pode
escolher uma alternativa melhor de outra squad. Higiene de capability
é a diferença entre uma squad descobrível e uma squad esquecida.
