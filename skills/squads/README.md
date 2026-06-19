# squads · Reusable Multi-Agent Workflow Skill

> **Squad Protocol v5** (with v4 backward compat) · zero-deps · capability-first

Create, validate, index, and invoke **squads** — portable multi-agent teams that expose **capabilities** discoverable by the harness for BM25 routing. Where `businesses` are persistent organizations with hierarchy and memory, **squads are reusable workflow units**: a fixed roster of agents with declared capabilities, tasks, and workflows that produce well-defined outputs.

---

## Squad vs. Business — quick contrast

| Dimension | Squad | Business |
|---|---|---|
| Persistence | Stateless reusable | Stateful organization |
| Hierarchy | Flat or workflow-shaped | Org chart with reports_to |
| Memory | None (per-invocation context) | Permanent + project memory |
| Discovery unit | Capability id (`marketing.funnel.create`) | Domain + auto_routes |
| Lifecycle | Invoke → produce artifact → done | Long-lived, multiple briefs over time |
| Protocol | v5 (capability-first) or v4 (legacy) | v1 |

Use **squads** for: "create a sales funnel", "analyze this video", "draft pitch deck".
Use **businesses** for: "manage the marketing operation of client X for 6 months".

---

## Installation

Zero external deps beyond Node 18+ and Python 3.9+ stdlib (`pyyaml` for parsing).

```bash
mkdir -p ${SQUADS_DIR}    # canonical home for squads (default ~/squads)
bun ~/.claude/skills/squads/scripts/list-squads.ts   # auto-bootstrap registry
```

---

## Project scoping (NIRVANA_SCOPE)

Squads can be **global** (visible to every project), **project-local** (visible only inside one project), or **merged** (project overrides global by slug). Set `NIRVANA_SCOPE` in `<project>/.env`:

```bash
NIRVANA_SCOPE=global   # ~/squads/* only — default, full backward compat
NIRVANA_SCOPE=project  # <project>/.nirvana/squads/* only
NIRVANA_SCOPE=merge    # both, project overrides global on slug clash
```

Project-local squads live at `<project>/.nirvana/squads/<slug>/` with the same v5 layout (`squad.yaml` + `agents/` + `tasks/` + `workflows/` + `dependencies.yaml`). The squad registry, activation state, and logs persist under `<project>/.nirvana/` (never `$HOME`) so two projects on the same machine never collide.

```bash
# List squads in current scope (project / global / merge)
bun ~/.claude/skills/squads/scripts/list-squads.ts

# With source labels and scope explanation
bun ~/.claude/skills/squads/scripts/list-squads.ts --show-scope

# Inspect resolved scope + slug-by-slug source attribution
bun ~/.claude/skills/_shared/lib/scope.ts --explain

# Activate a squad — resolves project-vs-global automatically; state persists
# in <project>/.nirvana/state/squads/ when source = project
bun ~/.claude/skills/squads/scripts/activate-squad.ts activate <slug>
```

For the full scope contract (resolution rules per mode, override semantics, what's intentionally not scope-aware) see `~/.claude/skills/_shared/SCOPE_CONTRACT.md`. To bootstrap a new scoped project: `bun ~/.claude/skills/_shared/scripts/init-project.ts <dir>`.

---

## Quick-start tutorial (10 minutes)

### Step 1 — list what already exists

```bash
bun ~/.claude/skills/squads/scripts/list-squads.ts
```

Output (abbreviated):
```
sales-funnel-masters         v5.0.0  protocol 5.0  · 7 capabilities
business-nirvana-maestro     v1.0.0  protocol 5.0  · 7 capabilities
brandcraft-nirvana           v4.0.0  protocol 4.0  (legacy)
...
148 squads total
```

### Step 2 — inspect one v5 squad in detail

Read its manifest directly:

```bash
cat ${SQUADS_DIR}/sales-funnel-masters/squad.yaml
```

You'll see: 7 capabilities (each with `id`, `domains[]`, `examples[]`, `invoke.{type,ref}`, `outputs[]`), components (agents/tasks/workflows), runtime requirements, features.

### Step 3 — create a new squad

```bash
bun ~/.claude/skills/squads/scripts/init-squad.ts my-research-squad
# or for v4 backward compat:
bun ~/.claude/skills/squads/scripts/init-squad.ts my-research-squad --legacy-v4
```

Generates a scaffold with `squad.yaml` (placeholders), `agents/`, `tasks/`, `workflows/` dirs, and `templates/` with starter templates for each.

### Step 4 — fill in the manifest

Edit `${SQUADS_DIR}/my-research-squad/squad.yaml`:

```yaml
name: my-research-squad
version: 1.0.0
protocol: "5.0"
description: |
  Squad that researches a topic via WebSearch + synthesis.
author: you
license: MIT

capabilities:
  - id: research.market.scan
    description: Scan a market segment and produce a 5-section report.
    domains: [research, knowledge_management]
    invoke:
      type: workflow
      ref: workflows/market-scan.yaml
    examples:
      - "Scan the SaaS pricing tools market"
      - "Research current trends in B2B vertical SaaS"
    outputs:
      - name: market_report
        type: markdown
        description: 5-section markdown report with citations
    score_boost: 1.0
    model_hint: sonnet

components:
  agents:
    - agents/researcher.md
    - agents/synthesizer.md
  tasks:
    - tasks/scan-market.md
    - tasks/synthesize-report.md
  workflows:
    - workflows/market-scan.yaml

runtime_requirements:
  minimum:
    - runtime: claude-code

features_required:
  - max_turns
  - tool_whitelist
  - handoff_artifacts
```

Capability ids follow `^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){2,}$` — at least 3 dotted segments. Use the canonical catalog at `~/.claude/skills/_shared/catalogs/CAPABILITY_CATALOG_V1.yaml` for `domains[]`.

### Step 5 — write agents, tasks, workflows

```
agents/researcher.md       — frontmatter + persona for the researcher agent
agents/synthesizer.md      — frontmatter + persona for the synthesizer
tasks/scan-market.md       — atomic task: inputs, steps, success criteria
tasks/synthesize-report.md — atomic task
workflows/market-scan.yaml — orchestrates: researcher → synthesizer
```

See `${SQUADS_DIR}/sales-funnel-masters/` for a production reference.

### Step 6 — validate

```bash
bun ~/.claude/skills/squads/scripts/validate-squad.ts ${SQUADS_DIR}/my-research-squad
```

Branches by `protocol`:
- `5.0` → Pydantic SquadManifest validator + structural capability checks
- `4.0` → legacy B1-B18 blocking checks

Both run via `~/.claude/skills/_shared/validators/validators.py`.

### Step 7 — index

```bash
bun ~/.claude/skills/squads/scripts/index-squads.ts
```

Writes `${SQUADS_REGISTRY_PATH}` — capabilities become discoverable by the harness BM25 router. Now your squad can be found via:

```bash
bun ~/.claude/skills/harness/scripts/find.ts "scan SaaS pricing market"
# → squad_capability:my-research-squad:research.market.scan
```

---

## Common workflows

### Workflow A — Add a new capability to an existing squad

1. Edit `squad.yaml`: append to `capabilities[]`
2. Add the workflow (or task or agent) it invokes
3. Re-validate + re-index
4. Test discovery: `bun ~/.claude/skills/harness/scripts/find.ts "<example phrase from your new capability>"`

### Workflow B — Migrate v4 → v5

The migration is additive — your v4 squad already works. To gain v5 capability discovery:

1. Add `protocol: "5.0"` to the manifest
2. Add a `capabilities[]` block mapping each existing v4 task to a capability
3. Move components from flat lists to `components: { agents: [...], tasks: [...], workflows: [...] }`
4. Validate via `validate-squad.ts` (it uses the v5 path automatically)
5. Optionally: keep `legacy.v4_path` set during coexistence

The pilot `sales-funnel-masters` did this — see `${SQUADS_DIR}/sales-funnel-masters/MIGRATION-NOTES.md`.

### Workflow C — Consume a capability from another squad

When *your* squad needs to invoke another squad's capability mid-workflow:

```javascript
// In an agent or workflow runner:
Skill({
  skill: "squads",
  args: JSON.stringify({
    command: "invoke-capability",
    squad: "sales-funnel-masters",
    capability: "marketing.funnel.create",
    inputs: { brief: "...", target: "..." }
  })
})
```

The harness handles dispatch, capability resolution, and handoff_artifact validation.

---

## Architecture

```
~/.claude/skills/squads/
├── SKILL.md                      ← Claude-discoverable
├── SQUAD_PROTOCOL_V5.md          ← v5 spec (~1000 lines, capability-aware)
├── SQUAD_PROTOCOL_V4.md          ← v4 spec (legacy)
├── lib/
│   ├── registry.js               ← scan + write ${SQUADS_REGISTRY_PATH} (with capabilities + domains index)
│   └── capability-validator.js   ← structural checks (dotted ids, examples, invoke refs)
├── scripts/                      ← 4 CLI entrypoints
│   ├── init-squad.ts             ← scaffold from template
│   ├── validate-squad.ts         ← v4 OR v5 validation
│   ├── index-squads.ts           ← rebuild registry
│   └── list-squads.ts            ← enumerate
├── templates/
│   ├── squad.yaml.tmpl           ← v5 manifest template (default)
│   ├── squad-v4.yaml.tmpl        ← v4 fallback (--legacy-v4 flag)
│   └── capability-block.tmpl     ← snippet for adding capabilities
├── references/
│   ├── 12-v5-capabilities.md     ← deep dive
│   ├── 13-v5-registry.md         ← registry schema
│   └── 15-creation-wizard.md     ← init flow
└── tests/
    └── smoke-v5.ts               ← T1-T5 (pilot + validate + registry + capability-validator + BM25)
```

Squad v5 manifest reference:
- Top-level required: `name, version, protocol, description, author, license, capabilities, components, runtime_requirements`
- Capability required: `id, description (≥20 chars), domains[1-5], invoke{type,ref}, examples[≥1], outputs[≥1]`
- Optional: `score_boost`, `model_hint`, `tools_required`, `inputs`, `not_for`

---

## CLI reference

| Script | Purpose |
|---|---|
| `init-squad.ts <name> [--legacy-v4]` | Scaffold new squad |
| `validate-squad.ts <path> [--report]` | v4 or v5 validation |
| `index-squads.ts [--roots <dir>...]` | Rebuild registry |
| `list-squads.ts [--format json\|table]` | Enumerate |

---

## Programmatic API (Node)

```javascript
const registry = require('~/.claude/skills/squads/lib/registry');
const result = registry.scan([process.env.SQUADS_DIR]);
console.log(`found ${Object.keys(result.squads).length} squads`);

const capabilityValidator = require('~/.claude/skills/squads/lib/capability-validator');
const ok = capabilityValidator.validateAll(`${process.env.SQUADS_DIR}/my-research-squad`);
```

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Capability id pattern violation` | Less than 3 dotted segments | `marketing.funnel.create` ✅, `marketing.create` ❌ |
| Schema rejects `domain X` | Domain not in CAPABILITY_CATALOG_V1.yaml | Add to catalog OR set `experimental_domains: true` (top-level) |
| Schema rejects `outputs[].type: yaml` | Only `file/string/json/array/markdown/html/binary` allowed | Use `string` and document the format inline |
| `Extra inputs not permitted: fidelity_status` | v5 schema doesn't accept `fidelity_status` per capability | Remove the field |
| BM25 not matching your squad | Description or examples too short | Pad description ≥20 chars; add 2-3 example phrases |
| Bash 3.x array unbound (macOS) | `${arr[@]}` on empty array | Use `${arr[@]+"${arr[@]}"}` idiom |

---

## Related skills

- **harness** — consumes the registry for top-level routing (Stages -1, 0, 2-5)
- **businesses** — for stateful organizations vs. one-shot squad invocations
- **_shared** — schemas, validators, capability catalog (v1.0)
- **nirvana-squad-creator** (squad) — pipeline that *creates* new squads from intent

---

## Spec & versioning

- Protocol: **Squad Protocol v5.0** (`SQUAD_PROTOCOL_V5.md`) + v4 legacy (`SQUAD_PROTOCOL_V4.md`)
- Capability catalog: `~/.claude/skills/_shared/catalogs/CAPABILITY_CATALOG_V1.yaml` (57 domains, 6 categories)
- 148 squads indexed at last count (134 v4 legacy + 14 v5 with capabilities)
- Test coverage: 5/5 smoke (T1-T5) + 36/36 pytest validators
