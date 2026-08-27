# Squad Creation (v5 default)

## When to load
Intent: CREATE (keywords: create, new, scaffold, generate, build squad)

## Protocol Reference
- `SQUAD_PROTOCOL_V5.md` §22 (capabilities) + base v4 §5–§8.
- Canonical schema: `~/.nirvana/skills/_shared/schemas/capability.schema.json`.
- Prompt wizard: `references/15-creation-wizard.md`.
- Capability catalog: `~/.nirvana/skills/_shared/catalogs/CAPABILITY_CATALOG_V1.yaml`.

## Default version

As of 2026-05, **new squads are created in v5 by default**.
A v4 squad is only created with `--legacy-v4`. Templates:

| Version | Template | When to use |
|--------|----------|-------------|
| **v5** (default) | `templates/squad.yaml.tmpl` | Every new squad |
| v4 (legacy) | `templates/squad-v4.yaml.tmpl` | Squad without capabilities (rare) |

---

## Creation Pipeline

> **This pipeline IS the system's squad creator.** There is no longer an
> intermediate squad for creating squads (`nirvana-squad-creator` was absorbed
> into the engine on 2026-07-27): the model carrying this skill executes the
> phases below agentically, end to end. The goal is not "a valid squad" — it is
> the best possible squad for that role.

### Phase 0: Intent archaeology + domain research

Before asking the user anything (Phase 1), do the work that turns a vague
request into the right squad:

1. **Intent archaeology.** The request says what the user wants; the squad has
   to serve what they NEED. Extract: which recurring pain motivates the squad,
   who consumes the outputs, which deliverable format closes the loop, and what
   ALREADY exists in the portfolio that covers part of it (`nrv find --no-amplify`
   with 3-5 hypothetical briefs from the domain — a new squad that steals an
   existing squad's territory is born wrong; the result dictates the `not_for`
   of both). On a clean engine install (zero squads — the engine installs no
   content), the search comes back empty and this step degrades to nothing:
   move on.
2. **Domain research (web, mandatory).** The squad has to be born at the state
   of the art, not from the model's memory: the domain's CURRENT best tools,
   libraries, practices, and services, with date and source. What the research
   decides becomes: stack choices in the agents/tasks, real domain vocabulary
   in the `capabilities[]` (keywords a domain user would type, PT and
   EN), and citable references in the README. Record the choices in a
   `## Escolhas de stack` block of the plan — same discipline as the harness
   freshness gate (Phase 2 of SKILL.md).

Only then run the wizard — with the questions already reduced to what the
archaeology could not infer.

### Phase 1: Elicitation (Wizard)

Use the formal wizard in `references/15-creation-wizard.md` (4 rounds).
Summary of collected fields:

| Round | Fields |
|-------|--------|
| 1 — Identity | `name`, `description`, `slashPrefix`, `tags` |
| 2 — Components | `components.agents[]`, `components.tasks[]`, `components.workflows[]` |
| 3 — Capabilities | `capabilities[]` (id, description, domains, invoke, examples, not_for) |
| 4 — Review | visual confirmation before writing files |

### Phase 2: Deterministic scaffold

```bash
bun ~/.nirvana/skills/squads/scripts/init-squad.ts ${SQUADS_DIR}/<name> \
  --name <name> \
  --description "<description>" \
  --capability-id <cap_id> \
  --capability-description "<...>" \
  --capability-domains "marketing,sales" \
  --workflow-ref <workflow_name>
```

Creates:
- `${SQUADS_DIR}/<name>/squad.yaml` (from the v5 template)
- `${SQUADS_DIR}/<name>/{agents,tasks,workflows,schemas}/` (skeleton)

### Phase 3: Generate squad.yaml (v5)

Final shape. **`protocol: "5.0"`** and the `capabilities[]` block are mandatory.

```yaml
name: my-squad
version: "1.0.0"
protocol: "5.0"
description: "What this squad does"
author: "author"
license: SUL-1.0
slashPrefix: msq
tags: [domain, keywords]

# capabilities[] is what makes the squad discoverable by the harness.
# See templates/capability-block.tmpl for the full snippet.
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
  policy: active
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

## Capabilities block — standard snippet

Paste inside `capabilities:` when adding a new capability. Full version
in `templates/capability-block.tmpl`.

```yaml
  - id: <domain>.<feature>.<action>           # dotted, ≥3 segments
    description: >
      <What it delivers, in 20-1500 chars. Concrete.>
    domains: [<d1>, <d2>]                      # 1-5 from CAPABILITY_CATALOG_V1
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
      - "<NL phrase 1>"
      - "<NL phrase 2>"
      - "<NL phrase 3>"
    not_for:
      - "<counterexample> (use <alt_capability_id>)"
    fidelity:
      status: experimental
      threshold: 0.85
    score_boost: 1.0
    model_hint: sonnet
    estimated_cost_usd: 0.50
```

**Practical rules (Squad v5 §22.9):**
- `id` unique within the squad. Globally, multiple squads MAY share the same
  id; the harness picks by the `score_boost + fidelity_status` combination.
- `description` is the strong signal for BM25. Be concrete.
- `examples[]` ≥1, ideally 3-5. Cover linguistic variations.
- `not_for[]` reduces ambiguity when there is a neighboring capability.
- `acceptance[]` (v6 §29) states how the output is judged; without it the judge falls back to the acceptance criteria of the invoked task.

Operational details in `references/12-v5-capabilities.md`.

---

### Phase 4: Generate agents (v4 frontmatter, valid in v5)

Use `templates/agent-cc.md.tmpl`. Mandatory frontmatter:

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
- `maxTurns` is mandatory (P4).
- Body 1000-2000 tokens. Max: 1.5% of the context window.
- Prose only in the body — not YAML.
- 4 minimum sections: identity + Guidelines + Process + Output.
- Semantic tool names (`read`, `write`, `grep`). Per-runtime override
  in `runtimes.{id}.tools`.

### Phase 5: Generate tasks

Use `templates/task-cc.md.tmpl`. No `owner` — the workflow binds.

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
bun ~/.nirvana/skills/squads/scripts/validate-squad.ts ${SQUADS_DIR}/<name>
bun ~/.nirvana/skills/squads/scripts/index-squads.ts
```

Both must pass before declaring the squad ready.

### Phase 8: Optimization + readiness gate (mandatory)

Validating proves conformance; this phase proves QUALITY. Three passes, all
blocking:

1. **Optimization pass.** Reread each generated agent/task/workflow as a
   hostile reviewer: a generic persona ("helps users with...") is a defect; a
   task without a binary acceptance criterion is a defect; a workflow whose
   gate is not verifiable is a defect; any knowledge Phase 0 researched that
   the artifact does not use is waste. Fix before moving on.
2. **Routing gate (ground truth for free).** Every declared `example_brief`
   MUST route back to its own capability in 1st place:
   `nrv find --no-amplify "<example_brief>"`. If it does not route, the defect
   is in the block (weak description/domains/keywords or an example_brief that
   does not look like a real brief) — never "the router's". Also test 2-3
   SYMPTOM briefs a user would type in a panic, not just the jargon (measured
   on 2026-07-27: entities existed in EN jargon and vanished in the PT
   symptom). And confirm that the home briefs of the Phase 0 neighbor squads
   still route to their owners.
3. **Audit score.** `bun ~/.nirvana/skills/squads/scripts/audit-squads-score.ts
   ${SQUADS_DIR}/<name>` when available — a score regression against the
   portfolio's reference squads is a signal to stop and review, not to
   proceed.

A squad that passes Phase 7 and fails Phase 8 is NOT ready. This gate is what
separates "valid" from "the best possible squad for that role".

---

## Legacy v4 path

If the user explicitly needs a v4 squad (without capabilities, for
compatibility with an old runtime):

```bash
# Use the v4 template
cp ~/.nirvana/skills/squads/templates/squad-v4.yaml.tmpl \
   ${SQUADS_DIR}/<name>/squad.yaml

# Edit the placeholders manually
# Validate via legacy branch (auto-detected by protocol: 4.0)
bun ~/.nirvana/skills/squads/scripts/validate-squad.ts ${SQUADS_DIR}/<name>
```

`validate-squad.ts` detects `protocol: 4.0` in the manifest and runs B1-B18
checks (does not require capabilities).

---

## Runtime-Specific Details

| Runtime | Adapter |
|---------|---------|
| Claude Code | `~/.nirvana/skills/_shared/adapters/claude-code.md` |
| Codex | `~/.nirvana/skills/_shared/adapters/codex.md` |
| Gemini CLI | `~/.nirvana/skills/_shared/adapters/gemini-cli.md` |

Each adapter declares: tool name mapping, frontmatter dialect, supported
hooks, and which `features_required` features are honored.
