# businesses · Multi-Business Orchestrator Skill

> **Business Protocol v1** · zero-deps · filesystem-first · auto-bootstrap · **DOMAIN-AGNOSTIC**

Create, validate, index, and invoke multi-agent organizations ("businesses") with hierarchical employees, memory isolation, and structured handoff primitives. Each business is a folder with a manifest, employees, an org chart, and routing rules — versionable, portable, auditable.

**The skill is universal.** It works for any domain where a team of agents makes sense: marketing, healthcare, engineering, legal, real-estate, gaming, foodtech, trading, education, research, government, etc. The 31 currently indexed businesses are marketing-focused because that was the initial migration. Create businesses in whichever domains you need.

---

## What this skill does

A **business** is a self-contained organization of AI agents that share:

- A **manifest** (`business.yaml`) declaring identity, domains, runtime requirements, and budget
- A roster of **employees** (`employees/<name>.md`) with roles, tools, self-score contracts, and either a functional spec or a mind-clone DNA reference
- An **org chart** (`org-chart.yaml`) with bidirectional reporting and antagonist designations
- **Routing rules** (`routing.yaml`) mapping incoming brief patterns to employees + escalation triggers
- Isolated **memory** (`memory/permanent.md` + `memory/projects/<id>/`)
- A **legacy/** dir preserving non-runtime artifacts from migrations

Briefs sent to a business are intaken by exactly one `is_brief_intake` employee (default CEO) and routed via mention/ticket/escalation/delegation/auto_route primitives. Outputs flow back as schema-validated `handoff_artifact`s.

---

## Installation

Zero external dependencies beyond Node 18+ and Python 3.9+ stdlib (plus `pyyaml`).

```bash
# Clone or copy ~/.claude/skills/businesses/ to your machine
mkdir -p ~/businesses
bun ~/.claude/skills/businesses/scripts/list-businesses.ts   # auto-bootstraps registry
```

---

## Project scoping (NIRVANA_SCOPE)

Businesses can be **global** (visible to every project), **project-local** (visible only inside one project), or **merged** (project overrides global by slug). Set in `<project>/.env`:

```bash
NIRVANA_SCOPE=global   # ~/businesses/* only — default, full backward compat
NIRVANA_SCOPE=project  # <project>/.nirvana/businesses/* only
NIRVANA_SCOPE=merge    # both, project overrides global on slug clash
```

Project-local businesses live at `<project>/.nirvana/businesses/<slug>/` with the same v1 layout (`business.yaml` + `employees/` + `org-chart.yaml` + `routing.yaml` + `memory/`). The business registry persists at `<project>/.nirvana/.businesses-registry.json` so two projects on the same machine never collide.

```bash
# List businesses in current scope
bun ~/.claude/skills/businesses/scripts/list-businesses.ts

# Re-index — registry lands in the right place automatically (project or global)
bun ~/.claude/skills/businesses/scripts/index-businesses.ts

# Inspect resolved scope
bun ~/.claude/skills/_shared/lib/scope.ts --explain
```

For the full scope contract (resolution rules per mode, override semantics, what's intentionally not scope-aware) see `~/.claude/skills/_shared/SCOPE_CONTRACT.md`. To bootstrap a new scoped project: `bun ~/.claude/skills/_shared/scripts/init-project.ts <dir>`.

---

## Quick-start tutorial (5 minutes)

### Step 1 — list what already exists

```bash
bun ~/.claude/skills/businesses/scripts/list-businesses.ts
```

Output:
```
nexus-council            v1.0.0  · 9 employees · zero_human · tier-2
authority-engine         v1.0.0  · 13 employees · zero_human · tier-2
...
31 businesses total · 328 employees
```

### Step 2 — inspect one in detail

```bash
bun ~/.claude/skills/businesses/scripts/inspect-business.ts nexus-council
```

You'll see: domains, employees with roles + reports_to + maxTurns, org chart hierarchy, squads_authorized, brief_intake employee, antagonist.

### Step 3 — create a new one (interactive wizard)

```bash
bun ~/.claude/skills/businesses/scripts/init-business.ts my-startup --template solo
```

The wizard asks 4 rounds of questions: identity, domains, runtime, employees. It generates a fully valid `business.yaml` + `employees/` + `org-chart.yaml` + `routing.yaml` + `memory/`.

Templates:
- `--template solo` — single-employee business (founder mode)
- `--template council` — 3-7 employees with C-suite + advisor council pattern
- `--template agency` — 8-15 employees with full agency org chart

### Step 4 — validate

```bash
bun ~/.claude/skills/businesses/scripts/validate-business.ts ~/businesses/my-startup
```

Validates manifest schema, employee frontmatter, org chart bidirectional consistency, BP7 antagonist requirement (mandatory when employee_count > 5), DAG (no cycles), brief_intake uniqueness.

### Step 5 — index into the registry

```bash
bun ~/.claude/skills/businesses/scripts/index-businesses.ts
```

Generates `${BUSINESSES_REGISTRY_PATH}` — consumed by the **harness** skill for routing discovery.

### Step 6 — dispatch a brief

```bash
bun ~/.claude/skills/businesses/scripts/brief-business.ts my-startup "Define the brand essence and 3 differentiation axes"
```

Resolves to a `project_id`, copies the brief to `~/.projects-outputs/<id>/`, and returns the path. The next step (LLM-mediated) is to spawn the `is_brief_intake` employee as a subagent that processes the brief and emits a `handoff_artifact`.

---

## Common workflows

### Workflow A — Migrate an existing org (paperclip company → business v1)

```bash
bun ~/migration-tools/paperclip-to-business-v1.ts \
  /path/to/source/company \
  ~/businesses/<target-slug> \
  --dry-run
```

The adapter (~2000 LOC, 17 functions) reads filesystem-first, generates the full business directory with employees, org chart, routing, and a `legacy/` preserve. Use `--no-translate` (default) to keep original AI agent prompts; `--translate=llm` rewrites paperclip-specific protocol calls into business v1 primitives.

Override domain inference, intake, and antagonist auto-pick:
```bash
bun ~/migration-tools/paperclip-to-business-v1.ts <src> <dst> \
  --domain=marketing,strategy \
  --intake=ceo \
  --antagonist=qa-lead
```

### Workflow B — Customize self-score contracts

The migration adapter (and `init-business.ts`) auto-pick a self-score template per role from `~/migration-tools/templates/self-score/`:

```
ceo.yaml       cto.yaml         product-lead.yaml   growth-lead.yaml
brand-lead.yaml  marketing-lead.yaml  sales-lead.yaml  specialist.yaml
antagonist.yaml  utility.yaml    engineer.yaml       analyst.yaml
copywriter.yaml  content-creator.yaml  lead.yaml     default.yaml
```

Each declares 2-4 falsifiable criteria with thresholds. To add a new role template, write a yaml in that dir following the existing format — `pickSelfScoreTemplate` will find it via exact match → substring → default fallback.

### Workflow C — Inspect routing for a business

```bash
python3 -c "
import json
r = json.load(open('${BUSINESSES_REGISTRY_PATH}'))
routes = r.get('_business_routing', {}).get('nexus-council', [])
for route in routes[:5]:
    print(f\"{route['pattern']:40} → {route['route_to']}\")
"
```

Routing rules drive the harness Stage 0 short-circuit: when a brief contains keywords from `auto_routes[].pattern` (e.g., `type:refund-request`), the harness dispatches directly to the named employee.

---

## Architecture

```
~/.claude/skills/businesses/
├── SKILL.md                      ← Claude-discoverable skill descriptor
├── BUSINESS_PROTOCOL_V1.md       ← protocol spec (BP1-BP13, ~1850 lines)
├── lib/
│   ├── loader.py                 ← load_business(path) → BusinessConfig
│   └── registry.py               ← scan + write ${BUSINESSES_REGISTRY_PATH}
├── scripts/                      ← 6 CLI entrypoints
│   ├── init-business.ts          ← interactive wizard
│   ├── validate-business.ts      ← schema + integrity validation
│   ├── index-businesses.ts       ← rebuild registry
│   ├── list-businesses.ts        ← table or JSON output
│   ├── inspect-business.ts       ← detailed view of 1 business
│   └── brief-business.ts         ← dispatch entrypoint
├── templates/
│   └── example-business/         ← runnable template (used by init wizard)
├── schemas/                      ← JSON Schema files
└── tests/
    └── smoke.ts                  ← E2E: create → validate → index → list → inspect → brief
```

Schemas live centralized in `~/.claude/skills/_shared/schemas/`:
- `business.schema.json` — manifest (top-level)
- `core-schemas.json#/definitions/employee` — employee frontmatter
- `core-schemas.json#/definitions/org_chart` — hierarchy
- `core-schemas.json#/definitions/routing` — auto_routes + escalation

Validators in `~/.claude/skills/_shared/validators/validators.{ts,py}` (Zod + Pydantic v2 mirrors).

---

## CLI reference

| Script | Purpose |
|---|---|
| `init-business.ts <name> [--template solo\|council\|agency]` | Interactive wizard |
| `validate-business.ts <path>` | Manifest + integrity validation |
| `index-businesses.ts [--roots <dir>...]` | Rebuild registry |
| `list-businesses.ts [--format json\|table]` | Enumerate registry |
| `inspect-business.ts <slug>` | Detailed view |
| `brief-business.ts <slug> "<brief>"` | Dispatch a brief |

---

## Programmatic API (Python)

```python
from sys import path
path.insert(0, '~/.claude/skills/businesses/lib')
from loader import load_business
from registry import build_registry, write_registry

biz = load_business('${BUSINESSES_DIR}/nexus-council')
print(biz.manifest.name, biz.manifest.domains, len(biz.employees))

# Bulk re-index
registry = build_registry(['${BUSINESSES_DIR}'])
write_registry(registry)
```

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `validate-business.ts` fails on `BP7 violation` | businesses with > 5 employees need ≥1 antagonist | Add `is_antagonist: true` to one employee's frontmatter |
| `Exactly one employee must have is_brief_intake: true` | Zero or multiple intakes | Set on exactly the CEO (or designated intake) |
| `Org chart references unknown employee` | employee in chart but not in `employees/` | Either add the .md file or remove the chart entry |
| Registry not finding new business | Forgot to re-index | `bun scripts/index-businesses.ts` |
| Schema rejects `type: yaml` in capability output | Schema only allows `file/string/json/array/markdown/html/binary` | Use `string` |
| Slug must match `^[a-z][a-z0-9-]{1,63}$` | uppercase or special chars | kebab-case only |

---

## Related skills

- **squads** — for one-shot reusable workflows (vs. persistent organizations)
- **harness** — top-level routing engine that consumes this skill's registry for discovery
- **_shared** — schemas, validators, and the canonical capability catalog used here
- **business-nirvana-maestro** (squad) — the orchestrator that uses *this* skill to dispatch multi-business projects

---

## Spec & versioning

- Protocol: **Business Protocol v1.0** (`BUSINESS_PROTOCOL_V1.md`, ~1850 lines)
- Schema version: `1.0.0`
- 31 production businesses indexed at last count (328 employees, 387 auto_routes)
- Test coverage: 6/6 smoke E2E + 36/36 pytest in `_shared/validators/`
