# Squad Creation (v6 default)

## When to load
Intent: CREATE (keywords: create, new, scaffold, generate, build squad)

## Protocol Reference
- `SQUAD_PROTOCOL_V6.md` §28 (workflow document), §29 (acceptance), §33 (`not_for` ≤25), §34 (admission gate).
- `SQUAD_PROTOCOL_V5.md` §22 (capabilities) + base v4 §5–§8.
- Canonical schema: `~/.nirvana/skills/_shared/schemas/capability.schema.json`.
- Routing metadata: `~/.nirvana/skills/_shared/ROUTING_METADATA_CONTRACT.md`.
- Prompt wizard: `references/15-creation-wizard.md`.
- Capability catalog: `~/.nirvana/skills/_shared/catalogs/CAPABILITY_CATALOG_V1.yaml`.

## Default version

New squads are created in **v6 by default** (`nrv migrate <slug> --to 6` raises
existing v5 squads; see `references/09-upgrade.md`). A v4 squad is only created
with `--legacy-v4`. Templates:

| Version | Template | When to use |
|--------|----------|-------------|
| **v6** (default) | `templates/squad.yaml.tmpl` + `templates/workflow.md.tmpl` | Every new squad |
| v5 | — (no new squads; existing v5 squads stay valid, unmigrated) | Never for creation |
| v4 (legacy) | `templates/squad-v4.yaml.tmpl` | Squad without capabilities (rare) |

What v6 changes at creation time, and why:

- **The workflow is ONE Markdown document** at `workflows/<ref>.md` (§28):
  frontmatter is the graph, the body is the prose, one `## <step.id>` section
  per step. The eight YAML graph dialects of the v5 era are read but never
  written.
- **Refs carry no extension** (§28.6): `invoke.ref: workflows/main-pipeline`,
  `components.workflows: [main-pipeline]`. The ref names the workflow, not its
  encoding — with `.md`/`.yaml` the admission gate fails `invoke_ref_extension`.
- **`acceptance[]` on the capability** (§29): what the judge grades a run on,
  binary and verifiable, max 12 entries.
- **`not_for` is a short token list** (§33): ≤25 chars per entry, 2-4 content
  words, no `(use other-squad)` suffix. The penalty is a substring match, and
  above 25 chars BM25 needs 60% token overlap — a sentence-long fence stops
  firing at all.

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
   with 3-5 hypothetical briefs from the domain). Overlap is not a problem to
   solve here: two squads may cover the same ground, and the maestro compares
   them at dispatch with the brief in hand. What the search tells you is what
   this squad must be **visibly better at** — sharpen its description,
   `produces` and `example_briefs` until a reader could say which of the two
   fits a given brief. Never fence a neighbour off in `not_for`: that carries
   genuine refusals only, and a defensive entry removes this squad from a
   comparison it might have won. On a clean engine install (zero squads — the
   engine installs no content), the search comes back empty and this step
   degrades to nothing: move on.
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
| 3 — Capabilities | `capabilities[]` (id, description, domains, invoke, examples, acceptance, not_for) |
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
- `${SQUADS_DIR}/<name>/squad.yaml` (from the v6 template)
- `${SQUADS_DIR}/<name>/workflows/<workflow_name>.md` — the §28 workflow
  document, graph scaffolded, body yours to write
- `${SQUADS_DIR}/<name>/{agents,tasks,schemas}/` (skeleton)

The scaffolder then runs the admission gate itself (`--fix` mode, §34) and
**deletes the directory if the gate rejects it** — a broken scaffold is never
left on disk pretending to be a squad. What survives is engine-owned repairs
(`.nirvana-surface.json`, component stubs) plus your placeholders to fill.

### Phase 3: Generate squad.yaml (v6)

Final shape. **`protocol: "6.0"`**, the `capabilities[]` block, and the
contract-complete routing metadata are mandatory. Note every workflow ref
WITHOUT its extension.

```yaml
name: my-squad
version: "1.0.0"
protocol: "6.0"
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
      Builds a complete sales funnel: blueprint, value ladder, page
      sequence and conversion mechanics, from a product brief.
    domains: [marketing, sales]
    invoke: { type: workflow, ref: workflows/main-pipeline }   # §28.6: no extension
    examples:
      - "criar funil de vendas completo"
      - "construir funil end-to-end com lead magnet"
    # Routing metadata (ROUTING_METADATA_CONTRACT.md) — all four, always:
    produces: [funnel-blueprint, landing-page-copy]
    keywords:
      - "sales funnel"
      - "funil de vendas"
      - "value ladder"
      - "escada de valor"
    example_briefs:
      - "Preciso de um funil completo para lançar meu curso de confeitaria"
      - "Build me an end-to-end funnel with a lead magnet for a B2B SaaS"
      - "quero estruturar a jornada de compra do meu produto digital"
    not_for:
      - "copy isolada"            # §33: ≤25 chars, 2-4 content words,
      - "isolated copy task"      # no "(use X)" suffix, PT and EN separate
    outputs:
      - name: funnel_blueprint
        type: markdown
        description: Funnel blueprint
    # v6 §29 — what the judge grades a run of this capability on:
    acceptance:
      - id: blueprint_complete
        description: "The blueprint names every funnel stage with its page and conversion mechanic"
        blocking: true
      - id: value_ladder_priced
        description: "Each value-ladder step carries an explicit price point"
        blocking: false
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
    - main-pipeline                # §28.6: no extension, same as invoke.ref

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
      <What it delivers, 20-1500 chars, canonical ENGLISH, concrete and
      front-loaded (contract §1). Never truncated.>
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
      ref: workflows/<wf>                      # §28.6: NO extension
    examples:
      - "<NL phrase 1>"
      - "<NL phrase 2>"
      - "<NL phrase 3>"
    produces: [<artifact-type-slug>]           # kebab-case (contract §3)
    keywords:                                  # multilingual synonym groups (§4):
      - "<concept in English>"                 # EN + PT, accented AND unaccented
      - "<conceito em português>"
      - "<conceito em portugues>"
    example_briefs:                            # ≥3; ≥1 EN and ≥1 PT; symptom-phrased (§5)
      - "<real user ask, conjugated verb>"
      - "<brief como o dono escreveria em pânico>"
      - "<forma no infinitivo>"
    not_for:                                   # §33: ≤25 chars, 2-4 content words,
      - "<short refusal>"                      # no sentences, no "(use X)" suffix
    acceptance:                                # §29: binary, verifiable, max 12
      - id: <acceptance_id>                    # ^[a-z][a-z0-9_-]*$, unique in the squad
        description: "<binary verifiable criterion>"
        blocking: true
    fidelity:
      status: experimental
      threshold: 0.85
    score_boost: 1.0
    model_hint: sonnet
    estimated_cost_usd: 0.50
```

**Practical rules (v5 §22.9 + v6 §29/§33):**
- `id` unique within the squad. Globally, multiple squads MAY share the same
  id; the harness picks by the `score_boost + fidelity_status` combination.
- `description` is the strong signal for BM25. Be concrete.
- `examples[]` ≥1, ideally 3-5. Cover linguistic variations.
- `not_for[]` ≤25 chars per entry — a short token list, never a sentence. EN
  and PT are separate entries; accented and unaccented are separate entries.
- `acceptance[]` (§29) states how the output is judged; without it the judge
  falls back to the acceptance criteria of the invoked task.

Operational details in `references/12-v5-capabilities.md`.

---

### Phase 4: Generate agents

Use `templates/agent.md.tmpl` (portable frontmatter; per-runtime overrides
under `runtimes.{id}.*`). Mandatory frontmatter:

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

Use `templates/task.md.tmpl`. No `owner` — the workflow binds.

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

### Phase 6: Generate the workflow document (§28)

ONE Markdown file at `workflows/<ref>.md`: the frontmatter is the graph, the
body is the prose — one `## <step.id>` section per step. `init-squad.ts`
already scaffolded it from `templates/workflow.md.tmpl`; fill it in:

```markdown
---
name: main-pipeline            # equals the file stem, ^[a-z][a-z0-9_-]*$
description: "What this workflow accomplishes"
version: "1.0.0"
steps:
  - id: plan
    agent: agent-one
    task: task-one             # a REFERENCE to tasks/task-one.md, never a paragraph
    creates: [plan-output]
  - id: execute
    agent: agent-two
    task: task-two
    requires: [plan]           # v6: `requires`, never `depends_on`/`deps`/`after`
    creates: [deliverable]
    on_failure: abort
success_indicators:            # the author's checklist; acceptance[] is what
  - "All target files processed"   # the judge actually grades (§29)
  - "Output schema validated"
---

## plan

What this step reads, what it decides, and what it hands to the next one.
Concrete inputs, concrete output — no restating what tasks/task-one.md says.

## execute

What this step assembles from the previous one, and what "done" looks like.
The body is about method; the graph above is about order.
```

What the admission gate enforces here: `name` equals the file stem; every
`requires` names another step's id; `agent` names `agents/<agent>.md`; the
graph is acyclic; a `task:` holding a paragraph instead of a reference fails —
real prompts live in `tasks/`, notes live in the body under `## <step.id>`.

### Phase 7: Validate + Index

```bash
nrv validate squad ${SQUADS_DIR}/<name>      # admission gate (§34); --fix repairs the mechanical findings
nrv index                                    # re-index so routing sees the new squad
```

Both must pass before declaring the squad ready. The gate is Zod
(`~/.nirvana/skills/_shared/validators/validators.ts`) plus the criteria
catalog — a squad it rejects does not exist as far as dispatch is concerned.

### Phase 8: Optimization + readiness gate (mandatory)

Validating proves conformance; this phase proves QUALITY. Three passes, all
blocking:

1. **Optimization pass.** Reread each generated agent/task/workflow as a
   hostile reviewer: a generic persona ("helps users with...") is a defect; a
   task without a binary acceptance criterion is a defect; a workflow whose
   gate is not verifiable is a defect; any knowledge Phase 0 researched that
   the artifact does not use is waste. Fix before moving on.
2. **Self-retrieval gate (ground truth for free, blocking).** After `nrv index`:
   ```bash
   bun ~/.nirvana/skills/_shared/scripts/self-retrieval-gate.ts <squad-slug>
   ```
   Every declared `example_brief` MUST route back to this squad top-1 (exit 0).
   On a miss, the defect is in the capability metadata (weak description /
   domains / keywords, or an example_brief that does not look like a real
   brief) — never "the router's". Diagnose individual briefs with
   `nrv find --no-amplify "<brief>"`. Also test 2-3 SYMPTOM briefs a user
   would type in a panic, not just the jargon (measured on 2026-07-27:
   entities existed in EN jargon and vanished in the PT symptom). And confirm
   that the home briefs of the Phase 0 neighbor squads still route to their
   owners. **Do not report the squad as created while this gate is red.**
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

# Edit the placeholders manually, then run the admission gate
# (auto-detected by protocol: 4.0 — does not require capabilities)
nrv validate squad ${SQUADS_DIR}/<name>
```

---

## Runtime-Specific Details

| Runtime | Adapter |
|---------|---------|
| Claude Code | `~/.nirvana/skills/_shared/adapters/claude-code.md` |
| Codex | `~/.nirvana/skills/_shared/adapters/codex.md` |
| Gemini CLI | `~/.nirvana/skills/_shared/adapters/gemini-cli.md` |

Each adapter declares: tool name mapping, frontmatter dialect, supported
hooks, and which `features_required` features are honored.
