# Squad Creation (v5 default)

## When to load
Intent: CREATE (keywords: create, new, scaffold, generate, build squad)

## Protocol Reference
- `SQUAD_PROTOCOL_V5.md` §22 (capabilities) + base v4 §5–§8.
- Schema canônico: `~/.claude/skills/_shared/schemas/capability.schema.json`.
- Wizard de prompts: `references/15-creation-wizard.md`.
- Capability catalog: `~/.claude/skills/_shared/catalogs/CAPABILITY_CATALOG_V1.yaml`.

## Versão default

A partir de 2026-05, **squads novas são criadas em v5 por default**.
Squad v4 só é criada com `--legacy-v4`. Templates:

| Versão | Template | Quando usar |
|--------|----------|-------------|
| **v5** (default) | `templates/squad.yaml.tmpl` | Toda squad nova |
| v4 (legacy) | `templates/squad-v4.yaml.tmpl` | Squad sem capabilities (raro) |

---

## Creation Pipeline

### Phase 1: Elicitation (Wizard)

Use o wizard formal em `references/15-creation-wizard.md` (4 rounds).
Resumo dos campos coletados:

| Round | Campos |
|-------|--------|
| 1 — Identidade | `name`, `description`, `slashPrefix`, `tags` |
| 2 — Componentes | `components.agents[]`, `components.tasks[]`, `components.workflows[]` |
| 3 — Capabilities | `capabilities[]` (id, description, domains, invoke, examples, not_for) |
| 4 — Review | confirmação visual antes de gravar arquivos |

### Phase 2: Scaffold determinístico

```bash
bun ~/.claude/skills/squads/scripts/init-squad.ts ${SQUADS_DIR}/<name> \
  --name <name> \
  --description "<description>" \
  --capability-id <cap_id> \
  --capability-description "<...>" \
  --capability-domains "marketing,sales" \
  --workflow-ref <workflow_name>
```

Cria:
- `${SQUADS_DIR}/<name>/squad.yaml` (do template v5)
- `${SQUADS_DIR}/<name>/{agents,tasks,workflows,schemas}/` (skeleton)

### Phase 3: Generate squad.yaml (v5)

Forma final. **`protocol: "5.0"`** e bloco `capabilities[]` obrigatório.

```yaml
name: my-squad
version: "1.0.0"
protocol: "5.0"
description: "What this squad does"
author: "author"
license: SUL-1.0
slashPrefix: msq
tags: [domain, keywords]

# capabilities[] é o que torna a squad descobrível pelo harness.
# Veja templates/capability-block.tmpl para o snippet completo.
capabilities:
  - id: marketing.funnel.create
    description: >
      Criação de funil de vendas completo. Saída inclui blueprint,
      value ladder, sequência de páginas e mecânicas de conversão.
    domains: [marketing, sales]
    invoke: { type: workflow, ref: workflows/main-pipeline.yaml }
    examples:
      - "criar funil de vendas completo"
      - "construir funil end-to-end com lead magnet"
    not_for:
      - "tarefa pontual de copy isolada (use copy.sales_letter.write)"
    outputs:
      - name: funnel_blueprint
        type: markdown
        description: Blueprint do funil
    fidelity:
      status: experimental
      threshold: 0.85
    score_boost: 1.0
    model_hint: opus

components:
  agents:
    - agent-one.md
    - agent-two.md
  tasks:
    - task-one.md
    - task-two.md
  workflows:
    - main-pipeline.yaml

runtime_requirements:
  minimum:
    - { runtime: claude-code, version: ">=1.0.0" }
  compatible:
    - { runtime: codex, version: ">=0.20.0" }
    - { runtime: gemini-cli, version: ">=0.4.0" }

features_required:
  - max_turns
  - tool_whitelist
  - subagent_spawning
  - handoff_artifacts

output:
  base_dir: default
```

---

## Capabilities Block — snippet padrão

Cole dentro de `capabilities:` ao adicionar nova capability. Versão
completa em `templates/capability-block.tmpl`.

```yaml
  - id: <domain>.<feature>.<action>           # dotted, ≥3 segmentos
    description: >
      <O que entrega, em 20-500 chars. Concreto.>
    domains: [<d1>, <d2>]                      # 1-5 do CAPABILITY_CATALOG_V1
    inputs:
      - name: <input_name>
        type: string                           # file|string|json|array|...
        required: true
        description: "<...>"
    outputs:
      - name: <output_name>
        type: markdown
        description: "<...>"
    tools_required: [read, write, web_search]
    invoke:
      type: workflow                           # workflow | task | agent
      ref: workflows/<wf>.yaml
    examples:
      - "<frase NL 1>"
      - "<frase NL 2>"
      - "<frase NL 3>"
    not_for:
      - "<contraexemplo> (use <alt_capability_id>)"
    fidelity:
      status: experimental
      threshold: 0.85
    score_boost: 1.0
    model_hint: sonnet
    estimated_cost_usd: 0.50
```

**Regras práticas (Squad v5 §22.9):**
- `id` único na squad. Globalmente, múltiplas squads PODEM ter mesmo id;
  o harness escolhe pela combinação de `score_boost + fidelity_status`.
- `description` é o sinal forte para BM25. Concretize.
- `examples[]` ≥1, idealmente 3-5. Cubra variações linguísticas.
- `not_for[]` reduz ambiguidade quando há capability vizinha.
- `humanize: true` (default) para outputs textuais; `false` para JSON/binary.

Detalhes operacionais em `references/12-v5-capabilities.md`.

---

### Phase 4: Generate agents (v4 frontmatter, válido em v5)

Use `templates/agent-cc.md.tmpl`. Frontmatter mandatório:

```yaml
---
name: agent-name
description: "[Verb] [domain]. Use when [trigger]. Do NOT use for [anti-pattern]."
maxTurns: 25
tools: [read, write, bash]
model: inherit
---
```

**Rules:**
- `maxTurns` é mandatório (P4).
- Body 1000-2000 tokens. Max: 1.5% do context window.
- Prose only no body — não YAML.
- 4 seções mínimas: identity + Guidelines + Process + Output.
- Nomes de tools semantic (`read`, `write`, `grep`). Override per-runtime
  em `runtimes.{id}.tools`.

### Phase 5: Generate tasks

Use `templates/task-cc.md.tmpl`. Não tem `owner` — workflow vincula.

```yaml
---
name: task-name
description: "What this accomplishes"
---

# Task Name

## Input
[What this receives]

## Steps
1. [Step]
2. [Step]

## Output
[What to produce, where to save]

## Acceptance Criteria
- [Binary verifiable criterion]
- [Binary verifiable criterion]
```

### Phase 6: Generate workflow

```yaml
name: main_pipeline
description: "What this workflow accomplishes"

steps:
  - id: step-1
    agent: agent-one
    task: task-one
    depends_on: []
  - id: step-2
    agent: agent-two
    task: task-two
    depends_on: [step-1]

success_indicators:
  - "All target files processed"
  - "Output schema validated"
```

### Phase 7: Validate + Index

```bash
bun ~/.claude/skills/squads/scripts/validate-squad.ts ${SQUADS_DIR}/<name>
bun ~/.claude/skills/squads/scripts/index-squads.ts
```

Ambos devem passar antes de declarar a squad pronta.

---

## Legacy v4 path

Se o usuário precisa explicitamente de uma squad v4 (sem capabilities,
para compatibilidade com runtime antigo):

```bash
# Use o template v4
cp ~/.claude/skills/squads/templates/squad-v4.yaml.tmpl \
   ${SQUADS_DIR}/<name>/squad.yaml

# Edite os placeholders manualmente
# Validate via legacy branch (auto-detectado por protocol: 4.0)
bun ~/.claude/skills/squads/scripts/validate-squad.ts ${SQUADS_DIR}/<name>
```

`validate-squad.ts` detecta `protocol: 4.0` no manifest e roda B1-B18
checks (não exige capabilities).

---

## Runtime-Specific Details

| Runtime | Adapter |
|---------|---------|
| Claude Code | `~/.claude/skills/_shared/adapters/claude-code.md` |
| Codex | `~/.claude/skills/_shared/adapters/codex.md` |
| Gemini CLI | `~/.claude/skills/_shared/adapters/gemini-cli.md` |

Cada adapter declara: tool name mapping, frontmatter dialect, hooks
suportados, e quais features do `features_required` são honradas.
