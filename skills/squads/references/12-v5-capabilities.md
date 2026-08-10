# v5 capabilities — operational guide

## When to load

Intent: CREATE | MODIFY | VALIDATE when the user mentions "capability",
"declarar capabilities", "adicionar capability", or is creating a v5 squad
from scratch.

## Protocol Reference

`SQUAD_PROTOCOL_V5.md` §22 (Capability Manifest), §22.9 (validation rules).
Schema: `~/.nirvana/skills/_shared/schemas/capability.schema.json`.
Validator: `~/.nirvana/skills/_shared/validators/validators.py` (class `Capability`).
Domain catalog: `~/.nirvana/skills/_shared/catalogs/CAPABILITY_CATALOG_V1.yaml`.

---

## What a capability is

A capability is the harness's **unit of discovery**. It maps a natural
language intent ("criar funil de vendas completo") to an invocation point
inside the squad — workflow, task, or agent.

Without `capabilities[]` in `squad.yaml`, the squad remains manually
executable (`*squad run`) but is **invisible to the harness**. The harness
only routes to squads whose capabilities have well-declared descriptions,
examples, and domains (BM25 indexes that metadata).

### Minimal anatomy

```yaml
capabilities:
  - id: marketing.funnel.create        # dotted, ≥3 segments
    description: >                      # 20-500 chars, indexed by BM25
      Criação de funil de vendas completo, da awareness ao closing.
    domains: [marketing, sales]         # 1-5 from CAPABILITY_CATALOG_V1
    invoke:
      type: workflow                    # workflow | task | agent
      ref: workflows/full-funnel-creation.yaml
    examples:                           # ≥1 mandatory
      - "criar funil de vendas completo"
      - "construir funnel end-to-end"
```

With this the squad is already discoverable. The following fields are
optional but strongly recommended.

---

## How to declare — real example

Excerpt from `${SQUADS_DIR}/sales-funnel-masters/squad.yaml`:

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

Note the pattern: each capability is **self-contained**. The harness makes
the routing decision without needing to open the target workflow.

---

## How to choose domains

Always start from the **canonical catalog** (`CAPABILITY_CATALOG_V1.yaml`).
There are 56 domains organized into 6 groups:

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

Use 1 to 5 domains, ordered from most specific to most general.

### When to use `experimental_domains: true`

If the domain you need **is not in the catalog**, declare on the squad:

```yaml
experimental_domains: true
```

…and use the custom domain. The harness applies `score_boost * 0.7` to
break ties against canonical capabilities. Use this only when really
necessary — discussing adding the domain to the catalog is better in the
medium term.

---

## How to connect `invoke` to the workflow/task/agent

Three invocation types:

### Type 1 — workflow (most common)

```yaml
invoke:
  type: workflow
  ref: workflows/full-funnel-creation.yaml
```

The workflow is the set of pre-defined steps. Use when the capability
requires multiple coordinated agents.

### Type 2 — task (when there is a single specific task)

```yaml
invoke:
  type: task
  ref: tasks/analyze-video.md
  agent: video-analyst                  # optional, pins the agent
  inputs_mapping:                       # optional, maps inputs
    video_path: file
```

Use when the capability is "run this task with this agent". Useful for
atomic capabilities.

### Type 3 — agent (no pre-defined task)

```yaml
invoke:
  type: agent
  ref: agents/conversational-pm.md
  prompt_template: "Conversa sobre projeto: {{user_message}}"
```

Use when the agent decides the flow dynamically. More flexible, less
predictable — only for free-chat / interactive consulting cases.

**Golden rule:** prefer `type: workflow` when the capability has >1 step.
Workflows are auditable, testable, resumable.

---

## When to use `humanize: true/false`

Human-facing outputs pass through humanization (P11) before the final
return to the user.

```yaml
- id: copy.sales_letter.write
  # ...
  humanize: true                # default — literary/textual output

- id: data.pipeline.export
  # ...
  humanize: false               # technical output (json/binary/file)
```

**Rule of thumb:**
- user-facing `markdown`, `string`, `html` → `humanize: true`
- technical `json`, `binary`, `file` → `humanize: false`
- In doubt → `true` (default)

Without humanization on a human-facing capability, the platform's
zero-human perception breaks. P11 (Squad v5 §27) is blocking when the
output goes straight to the end user.

---

## Anti-patterns

NEVER:

1. **Capability without `examples[]`** — without NL examples, BM25 does not
   index well. Poor ranking, inconsistent discovery.
2. **Capability invoking another squad** — `invoke.ref` points to
   components of its own squad. Cross-squad is the harness's responsibility.
3. **`description` too short** — the schema rejects <20 chars. But even
   above that, avoid generic descriptions like "faz X". Be concrete.
4. **`domains` outside the catalog without `experimental_domains: true`** —
   the validator emits a warning. The harness deranks.
5. **`id` with <3 segments** — the schema rejects it. `marketing.funnel`
   fails, `marketing.funnel.create` passes.
6. **Too many capabilities (>50)** — the schema blocks at 50. If your squad
   has >20 real capabilities, consider splitting into smaller squads.
7. **Reusing the same `id` across multiple squads without coordination** —
   two squads with `marketing.funnel.create` make the harness choose by
   `score_boost` + `fidelity_status`. That is OK and desired, but declare
   `not_for` to differentiate.
8. **`fidelity.status: validated` without `eval_results`** — the
   `validated` status requires evidence (ground-truth eval + results).
   Without it, leave `experimental`.
9. **`tools_required` with runtime-specific names** — use the semantic
   names from v4 §10.7 (`read`, `write`, `bash`, `web_search`, etc.). The
   adapter translates to native names.
10. **`estimated_cost_usd: 0`** — a zero estimate is a lie. Without a
    confident estimate, omit the field.

---

## Quality loop when creating a capability

Define success before coding:

1. Write 3-5 NL phrases that must match the capability. Paste into
   `examples[]`.
2. Write 1-2 NL phrases that must NOT match (cite the alternative).
   Paste into `not_for[]`.
3. Run the local BM25 search (once the registry is populated):
   ```bash
   bun ~/.nirvana/skills/squads/tests/smoke-v5.ts
   ```
   Verify your capability is the top hit for its own examples.
4. Run the validator:
   ```bash
   bun ~/.nirvana/skills/squads/scripts/validate-squad.ts ${SQUADS_DIR}/<name>
   ```
5. Run the registry rebuild:
   ```bash
   bun ~/.nirvana/skills/squads/scripts/index-squads.ts
   ```

If any step fails, fix and repeat. Do not publish a capability until all
of them pass.

---

## Final checklist (P5)

- [ ] `id` follows regex `^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){2,}$`
- [ ] `description` ≥20 and ≤500 chars, concrete
- [ ] `domains[]` 1-5 from the catalog (or `experimental_domains: true`)
- [ ] `invoke` points to an existing file in the squad
- [ ] `examples[]` ≥1, all ≥5 chars
- [ ] `not_for[]` cites an alternative capability when known
- [ ] `fidelity.status` honest (`experimental` by default)
- [ ] `outputs[]` declared with the correct type
- [ ] `humanize` set (true for human text, false for tech)
- [ ] `model_hint` appropriate for the complexity
- [ ] `*squad validate <name>` validation passes
- [ ] Registry rebuild finds the new capability

Without these, the capability technically works — but the harness may
choose a better alternative from another squad. Capability hygiene is the
difference between a discoverable squad and a forgotten one.
