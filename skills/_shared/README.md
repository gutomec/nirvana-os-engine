# _shared · Centralized Schemas, Validators, Adapters, and Catalog

> Source of truth for the canonical vocabulary and validation logic shared across the **businesses**, **squads**, and **harness** skills. **Do not duplicate these elsewhere** — import from here.

> 📖 **Procurando o overview de estrutura?** Veja **[STRUCTURE.md](./STRUCTURE.md)** — diagrama lado-a-lado de **global × project**, tabela de paths, 3 scope modes, formato canônico de mind-clones e quickstart por cenário.

This directory exists so that the three skills don't drift. When you change a JSON schema, both the TypeScript (Zod) and Python (Pydantic v2) validators are kept in sync, and all three skills (businesses, squads, harness) get the change automatically.

---

## What's inside

```
~/.claude/skills/_shared/
├── catalogs/
│   └── CAPABILITY_CATALOG_V1.yaml      ← 57 canonical domains, 6 categories
├── schemas/
│   ├── business.schema.json            ← business manifest
│   ├── capability.schema.json          ← squad capability declaration
│   ├── core-schemas.json               ← bundle: employee, org_chart, routing, ticket, mention,
│   │                                     escalation_trigger, self_score, handoff_artifact,
│   │                                     approval_chain, registry_squads, registry_businesses,
│   │                                     audit_event, harness_notification, harness_config
│   └── dna.schema.json                 ← mind-clone DNA file frontmatter
├── validators/
│   ├── validators.ts                   ← Zod (TypeScript), 8/8 smoke OK
│   └── validators.py                   ← Pydantic v2 (Python), 36/36 pytest passing
├── lib/
│   ├── bun-helpers.ts                  ← cross-platform primitives (Bun + Node 22 fallback)
│   ├── paths.js                        ← scope-aware path resolver (CommonJS)
│   ├── scope.ts                        ← NIRVANA_SCOPE resolver + slug enumeration
│   └── _delegator.sh                   ← .sh → .ts router for legacy callers
├── scripts/
│   └── init-project.{ts,sh,cmd}        ← bootstrap a scoped project skeleton
├── templates/
│   └── project-skeleton/               ← .env / .env.example / .agents/skills (canonical)
│                                         + per-agent symlinks (skills.sh truth table)
│                                         + .nirvana/{squads,businesses,mind-clones}
├── tests/
│   ├── scope.test.ts                   ← 17 asserts locking the scope contract
│   ├── scope-isolation-smoke.ts        ← 9 checks proving project isolation
│   └── portability-smoke.ts            ← shebang + Bun migration audit
├── adapters/
│   ├── claude-code.md                  ← runtime-neutral spec for Claude Code (15 sections)
│   ├── codex.md                        ← Codex sub-process spawn pattern
│   ├── gemini-cli.md                   ← Gemini-CLI MCP integration
│   └── README.md                       ← comparison matrix across runtimes
├── SCRIPT_CONTRACT.md                  ← shell + Bun cross-platform contract
└── SCOPE_CONTRACT.md                   ← project/global/merge scope contract
```

---

## Project scoping (NIRVANA_SCOPE)

The framework supports per-project isolation via `<project>/.env`:

```bash
NIRVANA_SCOPE=global   # only ~/squads/*, ~/businesses/* (default — backward compat)
NIRVANA_SCOPE=project  # only <project>/.nirvana/*       (fully isolated)
NIRVANA_SCOPE=merge    # both, project overrides global by slug (directory name)
```

In project mode, registries / state / logs persist under `<project>/.nirvana/` (not `$HOME`). Two scope=project projects on the same machine never collide. See **`SCOPE_CONTRACT.md`** for the full contract (path resolution table per mode, override rules, what is intentionally not scope-aware).

Bootstrap a new scoped project:

```bash
# Materialize skeleton with .env, .env.example, .agents/skills (canonical),
# per-agent symlinks (.claude/skills, .continue/skills, …) and .nirvana/{...}
bun ~/.claude/skills/_shared/scripts/init-project.ts <target_dir> --scope=project

# Inspect resolved scope at any time
cd <target_dir>
bun ~/.claude/skills/_shared/lib/scope.ts --explain

# Verify (locks the contract — runs in <2s)
bun ~/.claude/skills/_shared/tests/scope.test.ts
bun ~/.claude/skills/_shared/tests/scope-isolation-smoke.ts
```

The `.env.example` in the skeleton documents every variable the system actually reads (≈40 vars across 8 sections: scope, core paths, runtime, agent integration, API keys, runtimes, Stage 6.5/DAG, Antigravity hints). Copy what you need into `.env`.

---

## Capability Catalog

`catalogs/CAPABILITY_CATALOG_V1.yaml` is the controlled vocabulary used by:
- `capabilities[].domains` in squads (v5)
- `business.domains` in businesses
- Stage 1 / Stage 2 of the harness for domain-aware filtering

**59 domains** across 6 categories:
- Marketing & Sales (10) — marketing, sales, branding, copy, growth, performance, ads, retention, lifecycle, crm
- Content & Media (10) — content, media, video, audio, voice, tts, image, social_media, podcasting, journalism
- Engineering & Tech (11) — software_engineering, frontend, backend, mobile, data_engineering, devops, security, infrastructure, ai_engineering, qa, observability
- Business & Strategy (10) — strategy, business_operations, finance, accounting, legal, compliance, hr, recruiting, consulting, analytics
- Vertical (12) — healthcare, education, real_estate, fintech, crypto, gaming, ecommerce, hospitality, energy, agriculture, government, foodtech
- Cross-cutting (6) — research, knowledge_management, document_processing, automation, integration, **multi_agent_orchestration** (added for the Maestro pattern)

**Capability id namespace pattern:** `{namespace}.{segment}.{verb}` — at least 3 dotted segments. Examples: `marketing.campaign.full_funnel`, `media.video.analyze`, `business.project.orchestrate`.

Adding a domain or namespace = PR review by protocol authors. Removals = deprecation cycle of one minor version.

---

## Schemas (JSON Schema 2020-12)

### `business.schema.json`
The `business.yaml` manifest schema. Top-level required: `name, version, protocol, description, domains, operation_mode, runtime_requirements`. Optional: `legacy.*` (free-form, additionalProperties: true for migration metadata).

### `capability.schema.json`
A single capability declaration in a squad's `capabilities[]`. Required: `id, description, domains, invoke, examples`. Pattern for `id`: `^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){2,}$`.

### `core-schemas.json` (bundle)
Defines 14 reference-able schemas via `$ref: '#/definitions/<name>'`. The most important:

- `employee` — frontmatter for `employees/<name>.md`. Required: `name, role, type, description, maxTurns, reports_to, self_score_contract`. Pattern for `name`: `^[a-z][a-z0-9-]{1,63}$`.
- `org_chart` — bidirectional reporting + DAG (no cycles, validated at integrity check).
- `routing` — `brief_intake.default_employee` + `auto_routes[]` + `mention_routing[]` + `ticket_intake`.
- `handoff_artifact` — schema for inter-agent handoffs. Required: `schemaVersion, from_agent, to_agent, summary, next_action`.
- `audit_event` — jsonl entries. Enum of 22 event types.

### `dna.schema.json`
For mind-clone DNA files in `~/businesses/_library/dna/`. Frontmatter required: `name, description, model, maxTurns, tools`. Body must contain 10 numbered top-level sections (`## 1. ...` through `## 10. ...`).

---

## Validators

### TypeScript / Zod (`validators.ts`)

```typescript
import {
  CapabilitySchema,
  SquadManifestSchema,
  BusinessManifestSchema,
  EmployeeFrontmatterSchema,
  OrgChartSchema,
  RoutingSchema,
  TicketSchema,
  MentionSchema,
  HandoffArtifactSchema,
  ApprovalChainSchema,
  RegistrySquadsSchema,
  RegistryBusinessesSchema,
  AuditEventSchema,
  HarnessConfigSchema,
  HarnessNotificationSchema,
  validateBusinessIntegrity,   // cross-artifact: BP7 antagonist + intake unique + DAG + bidirectional
} from '~/.claude/skills/_shared/validators/validators.ts'

const result = BusinessManifestSchema.safeParse(manifestObj)
if (!result.success) console.error(result.error.issues)

const integrity = validateBusinessIntegrity({
  manifest: validatedBusiness,
  employees: validatedEmployees,
  org_chart: validatedOrgChart,
})
// → { valid: boolean, errors: string[] }
```

Smoke: `bun ~/.claude/skills/_shared/validators/validators.ts test` (8 OKs).

### Python / Pydantic v2 (`validators.py`)

```python
from sys import path
path.insert(0, '~/.claude/skills/_shared/validators')
from validators import (
    BusinessManifest,
    Employee,
    OrgChart,
    Routing,
    HandoffArtifact,
    AuditEvent,
    validate_dna_file,    # frontmatter + 10 numbered sections
)

biz = BusinessManifest.model_validate(manifest_dict)   # raises pydantic.ValidationError on fail
ok = validate_dna_file('/Volumes/guto1/mindclones/02-negocios/naval-ravikant.md')
```

Test: `cd ~/.claude/skills/_shared/validators && python3 -m pytest validators.py` (36 passed).

**Both validators are mirrors** — change one, change the other. The smoke + pytest tests catch drift.

---

## Adapters (runtime-neutral specs)

`adapters/{claude-code,codex,gemini-cli}.md` describe how each runtime adapter implements the 15 canonical sections of the protocol:

1. Skill discovery
2. Subagent spawning
3. Memory isolation enforcement
4. Tool whitelisting
5. Handoff artifact validation
6. Audit event emission
7. Budget pre-flight
8. Workflow orchestration
9. Mention/ticket dispatch
10. Escalation trigger handling
11. Approval chain execution
12. Cron / heartbeat scheduling (optional)
13. Project memory layout
14. Multi-runtime negotiation

Use these when:
- Implementing a new adapter
- Reviewing whether a runtime supports the full protocol
- Debugging cross-runtime brief portability

`adapters/README.md` has a feature matrix comparing all three.

---

## How the three skills consume `_shared`

| Asset | businesses | squads | harness |
|---|:---:|:---:|:---:|
| `business.schema.json` | ✅ direct | — | reads via registry |
| `capability.schema.json` | — | ✅ direct | reads via registry |
| `core-schemas.json#employee` | ✅ direct | — | — |
| `core-schemas.json#routing` | ✅ direct | — | reads `_business_routing` for Stage 0 |
| `core-schemas.json#handoff_artifact` | ✅ on dispatch | ✅ on invoke | ✅ on validation |
| `core-schemas.json#audit_event` | ✅ for migration | ✅ for index | ✅ for routing log |
| `core-schemas.json#harness_config` | — | — | ✅ direct |
| `validators.{ts,py}` | ✅ all schemas | ✅ all schemas | ✅ config + audit |
| `CAPABILITY_CATALOG_V1.yaml` | ✅ for `domains[]` | ✅ for `domains[]` | ✅ for known domains in Stage 1/2 |
| `adapters/*.md` | reference for runtime support | reference | reference |

Never copy these into a skill's own dir. Always import via path absolute.

---

## Adding a new schema

1. Edit `core-schemas.json` and add a new `definitions.<name>` entry.
2. Add a corresponding Zod schema in `validators.ts` (mirror the JSON Schema as faithfully as Zod allows).
3. Add a Pydantic v2 model in `validators.py` with `model_config = ConfigDict(extra='forbid')` for strict mode.
4. Add a test in both validators (a positive sample + a strict-mode-rejection sample).
5. Run smoke + pytest:
   ```bash
   cd ~/.claude/skills/_shared/validators
   bun validators.ts test
   python3 -m pytest validators.py
   ```
6. Update consumers if they should now use the new schema (rare — usually consumers just call `validateBusinessIntegrity` etc.).

---

## Adding a new domain to the catalog

1. Edit `catalogs/CAPABILITY_CATALOG_V1.yaml`.
2. Place the new entry in the appropriate category (Marketing/Content/Engineering/Business/Vertical/Cross-cutting). Update the count in the comment header.
3. If it warrants a new namespace (rare), add to `namespaces` with `prefix`, `parent_domain`, `sample_capabilities`.
4. Note the addition in `~/.claude/skills/squads/SQUAD_PROTOCOL_V5.md` Appendix C if you're a protocol author.
5. The next time `index-squads.ts` runs, the new domain becomes accepted (squads can now use it without `experimental_domains: true`).

---

## Adding a new runtime adapter

1. Copy `adapters/claude-code.md` as the structural template (15 canonical sections).
2. For each section, document the runtime's native primitive (e.g., for Codex: sub-process spawn with stdin/stdout JSON; for Gemini-CLI: MCP client).
3. Add to `adapters/README.md` the feature matrix row.
4. Add the runtime id (e.g., `cursor`, `aider`) to the `Runtime` enum in `validators.ts` AND `validators.py`.
5. Run smoke + pytest.

---

## Versioning

- `CAPABILITY_CATALOG_V1.yaml` — semver `1.0.0`. Backward compat across all `1.x`.
- Schemas — version implicit in `protocol` field of each manifest type. Squad uses `protocol: "5.0"`, business `"1.0"`, harness config `"1.0"`.
- Validators — must support all live protocol versions. `protocol: "4.0"` (legacy) and `"5.0"` both supported in squads validator.

---

## Test coverage

```bash
# TypeScript
bun ~/.claude/skills/_shared/validators/validators.ts test       # 8/8 OK

# Python
cd ~/.claude/skills/_shared/validators
python3 -m pytest validators.py                                  # 36/36 passed
```

Drift between TS and Python validators is the single largest risk for this dir — when in doubt, run both test suites.

---

## Related

- **businesses skill** — uses `business.schema.json`, `core-schemas.json#{employee,org_chart,routing}`, all validators
- **squads skill** — uses `capability.schema.json`, `core-schemas.json#registry_squads`, all validators
- **harness skill** — uses `core-schemas.json#{harness_config,audit_event,registry_businesses,registry_squads}`, all validators
- **migration-tools** — `~/migration-tools/paperclip-to-business-v1.ts` reuses `pickSelfScoreTemplate`, `buildOrgChart`, `mapAgentToEmployee` plus the validators here

---

## License

MIT. Part of the Nirvana system.
