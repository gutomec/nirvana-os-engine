# Business Protocol Specification, v2

```
Title:    Business Protocol Specification
Version:  2.1.0
Status:   ACTIVE (complete protocol; the manifest value is protocol: "2.0")
Date:     2026-09-30
Author:   Luiz Gustavo Vieira Rodrigues (Prospecteezy)
License:  SUL-1.0
Scope:    Runtime-agnostic definition of an autonomous business: its structure, its contracts, and how the engine runs it
Archive:  v1 lives in docs/legacy/protocols/businesses/ of the repository; this document does not depend on it
```

## §0 Deprecation policy

This policy applies to every field, file or block marked **retired**. It is written once; no section redefines what "retired" means.

1. **The loader tolerates.** A manifest or frontmatter with a retired field loads without error, on 1.0 and 2.0. Rejecting would break most installed seats on the day of publication.
2. **The gate warns.** `nrv validate business <slug>` emits one warning per field (`deprecated_field:<name>`) or per file (`deprecated_file:<name>`). A warning does not fail the business; with `--strict` it does.
3. **Conversion is explicit.** Only `--fix` converts or removes. `self_score_contract` becomes `acceptance[]`, `draws_from` becomes `assigned_mind_clones`, `dna_reference` becomes `pinned_mind_clones`; the rest are removed. No fixer deletes authored content: retired files are reported, never deleted.
4. **Removal is v3.** The loader stops accepting a retired field only in a v3. Until then a manifest that never ran `--fix` keeps working.

Tolerant reading with canonical writing is what lets many surfaces retire without a forced migration window.

---

## §1 Introduction and scope

### 1.1 Purpose

A **business** is a self-contained folder that describes an organization of AI agents: who works there (employees, called seats), how they relate (org chart), what the business produces and when it should be chosen (routing metadata), what its work must satisfy (acceptance), and what it remembers. The engine routes a request to a business, writes it a brief, runs it, checks the result and delivers.

This protocol defines two things:

1. **Structure.** The files of a business, every field the validator accepts, and the admission gate (`nrv validate business`).
2. **Execution.** How the engine runs a business: as **one agent** that is the whole business for one request (§14).

### 1.2 What this protocol is not

- Not a runtime. The engine and its adapters run businesses.
- Not a replacement for the Squad Protocol. A business uses squads; a squad never uses a business.
- Not a license to run agents in regulated work without human oversight. Where the law requires a human, the business must say so in its method and its brief (§12).

### 1.3 Relationship to squads

| Aspect | Squad | Business |
|---|---|---|
| Unit of work | One atomic capability with finite output | A request that may need several capabilities and a point of view |
| Identity | Agents defined by a workflow | Seats defined by a role in an organization |
| Memory | Stateless or session scoped | Two curated scopes, machine and project (§9) |
| Composition | Workflow steps | The agent reads the seats it needs and uses squads through their work cards (§13.3) |

### 1.4 Audience

Business authors, engine and adapter implementers, and the operators who set review and budget policy.

---

## §2 Terminology

| Term | Definition |
|---|---|
| **Business** | The folder under `business.yaml`: manifest, seats, org chart, routing, memory seed. |
| **Seat** (employee) | A role of the business, one Markdown file with YAML frontmatter and a body. Not a separate running agent. |
| **Org chart** | The reporting structure of the seats: `reports_to`, `manages`, `org-chart.yaml`. |
| **Brief** | The six-section request the orchestrator writes for the business (§14.1). |
| **Intake seat** | The one seat with `is_brief_intake: true`. Its `acceptance[]` is the business's contract with the judge (§11). |
| **Antagonist** | A seat whose job is to challenge the work (BP7). |
| **Mind-clone** | A persona from the clone library. A seat may pin one or hint at one (§7.7). |
| **Work card** | The short description of an installed squad that the business agent reads in order to use it (`nrv cards squad <slug>`). |
| **Solo run** | The execution model: one agent, the whole business, one request (§14). |
| **Gate** | The admission gate, `nrv validate business <slug>` (§16). |
| **Surface** | `.nirvana-surface.json`, the engine-owned extraction of a business's contract (§5.3). |

---

## §3 Design principles (BP1-BP13)

### BP1: Zero-human is the default
A run does not pause for a person. When it cannot continue without one, it says so in its summary and the engine surfaces it (§12).

### BP2: Hierarchy is real, not decorative
Seats have a place in the org chart. The single agent reads that structure and honors it: a seat decides inside its scope, and a decision above that scope is recorded as an open item for the seat that owns it.

### BP3: Work is structured, not free-form
Inside a run there are no handoffs between processes. The structure of the work is the brief in, the phases in `_work/PROGRESS.md`, and the three closing files out (§14). Between businesses, the orchestrator hands over files (`_SUMMARY.md` of one as an input of the next).

### BP4: Acceptance is declared per seat, not scored by the author
Each seat declares `acceptance[]`, what its deliverable must satisfy. The judge and `verify-deliverable` decide; an author's own score of its own work is not evidence (§11).

### BP5: Memory has two curated scopes, isolated by construction
Machine memory and project memory live in `.nirvana`, never inside the business. A run reads both and never writes a business's shipped files (§9).

### BP6: The brief is the unit of entry
Work enters as a brief. Routing picks the business (§13); the orchestrator writes the brief (§14.1).

### BP7: Antagonists are mandatory above five seats
A business with more than 5 seats declares at least one seat with `is_antagonist: true`. When the business agent plays an antagonist seat it challenges the work it just did, in that seat's voice, and records what changed. The gate rejects the violation (`antagonist_bp7`).

### BP8: Default to functional_specialist
A seat is defined by method, not by a person. `mind_clone` is for seats whose identity is the person, with disclosure (§7.8).

### BP9 (retired): approval chains
`approval-chains.yaml` was never read by any code. The number stays reserved. Adversarial review is BP7; delivery review is decided by the engine (§14.4).

### BP10 (retired): heartbeats
No scheduler ever ran a heartbeat. The number stays reserved. Recurring work belongs to the host scheduler (`nrv schedule`, system cron), outside this protocol.

### BP11: Project outputs are the source of truth, memory is a cache
Deliverables are files under the outputs root. If a memory and the files disagree, the files win.

### BP12: The audit trail is non-negotiable
Every run is logged with a timestamp, the business, the project and a structured payload. Event names are in a closed enum; a new one carries the `x_` prefix and names the business (§17.3).

### BP13: Writing contract
Every prose deliverable follows the writing contract appended to `AGENTS.md`, `CLAUDE.md` and `GEMINI.md`. It is applied at write time, with no correction loop afterwards. Technical artifacts (JSON, code) are outside it by content.

---

## §4 Architecture layers

```
Business Protocol (this document)      structure, contracts, gate, execution model
        |  uses
Squad Protocol                         capabilities the business reads and works from
        |  orchestrated by
Harness                                routes requests, writes briefs, dispatches, reviews, gates, delivers
        |  implemented by
Runtime adapters                       claude-code, codex, gemini-cli, and the others
```

The core is runtime-agnostic: the business agent needs to read files, run commands and write files, nothing more. Adapters decide how a headless session is started, resumed and bounded; they live in `skills/_shared/adapters/`.

---

## §5 Business structure

### 5.1 Name rules

- Business names: kebab-case, `^[a-z][a-z0-9-]{1,63}$`.
- Seat names: kebab-case, equal to the file name (`employees/cmo-strategy.md` declares `name: cmo-strategy`).
- Capability ids: dotted, at least three segments (`marketing.campaign.full_funnel`).
- Domains: snake_case, from the capability catalog.

### 5.2 Files at a glance

| File | Required | Owner | Purpose |
|---|---|---|---|
| `business.yaml` | yes | author | Manifest (§6) |
| `employees/*.md` | yes, at least one | author | Seats (§7) |
| `org-chart.yaml` | yes | author, derivable | Hierarchy (§8) |
| `routing.yaml` | recommended | author | Default seat and `auto_routes` (§13) |
| `.nirvana-surface.json` | yes | engine | Contract surface (§5.3) |
| `memory/permanent.md` | optional | author | Shipped seed of machine memory (§9) |
| `README.md` | recommended | author | Human overview |

### 5.3 Canonical layout

```
~/businesses/<slug>/
├── business.yaml              # manifest
├── org-chart.yaml             # hierarchy
├── routing.yaml               # brief_intake + auto_routes (the only home of auto_routes)
├── .nirvana-surface.json      # engine-owned, never edited by hand
├── employees/*.md             # seats
├── memory/permanent.md        # shipped seed, replaced on pack update
└── README.md
```

**The surface is the engine's.** `.nirvana-surface.json` sits at the root, is produced by `extractSurface`, and is never edited by hand. The gate regenerates it (`surface_regen`). Absence is an error (`surface_missing`); a divergence from the extraction is a warning (`surface_stale`).

**The org chart can be derived.** The parent of a seat is its own `reports_to`; a seat with none is adopted by the single seat that lists it under `manages`. `--fix` rewrites `org-chart.yaml` from the frontmatter, which makes the two directions of the chart consistent by construction (§8).

**`dna/` symlinks are retired** (§0). Symlinks do not travel in a zip, so the binding reaches a buyer broken. The binding between a seat and a clone lives only in frontmatter (`pinned_mind_clones`, `assigned_mind_clones`). The gate still reads a `dna/` directory to catch a broken link (`dna_symlink_dangling`, error); its presence is a warning (`dna_dir_present`), and `--fix` converts the link names into `assigned_mind_clones` of the intake seat before removing the directory.

**Not part of the layout** (§22): `culture.md`, `budgets.yaml`, `secrets-manifest.yaml`, `escalation-triggers.yaml`, `approval-chains.yaml`, `tickets/`, `processes/`, `dna/`. Organizational workflow is a squad's job. A secret is `env_required` plus the host's vault.

**Run output never lives inside the business.** A run's folders (`deliverables/`, `.projects-outputs/`, and the like) inside the business directory are an error (`outputs_pollution`).

---

## §6 Manifest (`business.yaml`)

The manifest schema is `BusinessManifestSchema` (Zod, `skills/_shared/validators/validators.ts`). It tolerates unknown extra keys (passthrough) so richer manifests still load; the keys below are the ones the protocol defines.

### 6.1 Required fields

```yaml
name: marketing-conglomerate-x          # kebab-case
version: "1.0.0"                        # semver
protocol: "2.0"                         # "1.0" or "2.0" (§18.4)
description: "What the business does, concrete and front-loaded, 20 to 2000 characters."
domains: [marketing, growth]            # 1-50 snake_case entries
runtime_requirements:
  policy: active                        # active | declared
```

Optional with defaults: `author`, `license` (default `MIT`), `authority_level` (`tier-1`|`tier-2`|`tier-3`, default `tier-2`), `experimental_domains` (default false).

### 6.2 Capabilities and squads

```yaml
capabilities:                           # what the business EXPOSES; dotted ids, at most 100
  - business.strategy.positioning
squads_preferred: [brandcraft]          # open preference (§6.10)
squads_authorized: [brandcraft]         # closed set, only when not empty (§6.10)
```

### 6.3 Operation mode

```yaml
operation_mode: zero_human              # zero_human | hybrid | human_in_loop (default zero_human)
```

Only `zero_human` is honored. The other two parse and raise `operation_mode_unsupported` (§12).

### 6.4 Output and memory blocks

```yaml
output:
  base_dir: default
memory:
  permanent:
    enabled: true
    files: [permanent.md]
    garbage_collection: {max_facts: 500, review_interval_days: 60, conflict_resolution: replace}
  project:
    isolation: by_construction          # by_construction | advisory
```

The schema accepts these blocks (`max_facts` 50 to 5000, `review_interval_days` 1 to 365, `conflict_resolution` `replace`|`append`|`prompt`). No engine reader applies them today: where outputs go is decided by the run (§14.2) and memory follows §9. They are declarations kept for compatibility.

### 6.5 Runtime requirements

```yaml
runtime_requirements:
  policy: active                        # active = use the session's runtime; declared = use the list below
  minimum: [{runtime: claude-code, version: ">=1.0.0"}]   # required when policy is declared
  compatible: [{runtime: codex, version: ">=0.20.0"}]
  incompatible: []
features_required: [audit_trail]        # from the closed Feature enum of the validator
features_optional: [hooks]              # free strings
```

`runtime` is one of `claude-code`, `codex`, `antigravity-cli`, `antigravity`, `gemini-cli`, `pi`, `kimi-cli`, `grok-cli`, `qwen-code`, `opencode`, `cursor`, `openclaw`. A template that still lists `runtime_requirements` as the skeleton gets `runtime_requirements_default`.

### 6.6 Environment

```yaml
env_required: [ANTHROPIC_API_KEY]       # upper snake case; names only, never values
```

### 6.7 Legacy reference (optional)

```yaml
legacy:
  paperclip_company_id: "0084d097-cdf9-4bdb-a181-ffdd7f02eede"   # uuid
  paperclip_instance: default
  paperclip_data_dir: ${NIRVANA_HOME}/nirvana-command/.paperclip-data
  migration_date: "2026-05-15T10:00:00Z"
  migration_audit_log: ~/.migration-logs/2026-05-15/marketing-conglomerate-x.json
```

Extra keys are allowed. A `legacy` block with a missing or malformed part raises `legacy_partial`.

### 6.8 UI metadata (optional)

```yaml
ui:
  icon: "building"
  category: marketing-agencies
  client_facing_name: "Marketing Conglomerate X"
  pitch: "Brief in. Empire out."
  employees_metadata: {ceo: {title: "Chief Executive"}}
```

### 6.9 Routing metadata

The router picks a business by BM25 over a document built from the manifest, so these fields decide whether a valid business is also a visible one.

| Field | Cardinality | Rule |
|---|---|---|
| `produces[]` | 1-60 | Artifact-type slugs, kebab-case, 3 to 80 characters. What leaves the business, not what it does. |
| `keywords[]` | at most 100 | Multilingual synonym groups, 2 to 60 characters each: EN and PT (and ES when natural), with and without accents as separate entries. |
| `example_briefs[]` | 3-30 | Symptom phrases as the owner would write them, 20 to 1000 characters. At least one English and one Portuguese; conjugated and infinitive forms. |
| `not_for[]` | at most 40 | Exclusion fences, 5 to 80 characters, 2 to 4 content words, no parentheses, no explanatory suffix. |

`not_for` is loaded by the registry, indexed in the business's routing document and printed in the routing digest.

**Why 80 characters and 2 to 4 words.** The router fires an entry of up to 25 characters by substring and a longer one by token overlap, requiring at least 60% of its tokens in the brief. Measured on 2,832 real `example_briefs` in the library, 902 of 910 long entries fired against no brief at all. A fence that never fires is only a belief that a limit exists. The gate measures it per entity (`auto_route_never_fires` for routes, `check-not-for-fires` for fences) and CI refuses new content with a dead fence.

The limit of 40 `not_for` entries is configurable through `business_not_for_max` in `nirvana-limits.yaml`. The other ceilings (`business_produces_max`, `business_example_briefs_max`, `business_keywords_max`, `business_capabilities_max`, `business_description_max`) are configurable the same way.

### 6.10 Squad preference and restriction

```yaml
squads_preferred: [brandcraft, landing-page-nirvana]   # OPEN set
squads_authorized: [brandcraft]                        # CLOSED set
```

- **`squads_preferred`** names squads the worker always gets a work card for. It closes nothing: every squad in the library stays eligible.
- **`squads_authorized`** closes the set **only when it is not empty**. `[]`, `null` and absent are identical and mean every squad is permitted.

The manifest lists apply to every seat. In a seat's frontmatter, `squads_authorized` narrows (it should be a subset of the business list when one exists) and `squads_preferred` adds.

**What the worker receives.** The solo worker gets a card for the union of: the squads the router picked, the squads the request names, the business's `squads_preferred`, and the closed sets the seats declare. A seat open to any squad adds none, because listing the whole library is the cost the solo model removes. For any other squad the worker can print a card itself (`nrv cards squad <slug>`) or list the library (`nrv list-squads`).

A list that is empty is removed by `--fix`, never renamed (`squads_authorized_empty`); a squad named in either list that is not in the library raises `squads_ref_unknown`.

### 6.11 Budget

```yaml
run_budget_usd: 12.0      # ceiling for one run; 0 or absent = unlimited
```

`run_budget_usd` is the ceiling for one run of the business. When the command-line flag (`--max-budget`) and the manifest declare different ceilings, the smaller wins. A run is one agent, so the ceiling binds that one session. The engine never invents a ceiling of its own.

`budget_monthly_usd` in seat frontmatter is retired (§22): there is no monthly accounting anywhere in the system.

### 6.12 `employee_count` is derived

The count of `employees/*.md` is the truth. Declaring `employee_count` is accepted and raises `employee_count_authored`; a mismatch with the disk is a warning in the integrity check, never a load error. `--fix` removes the declaration.

### 6.13 Review marker

```yaml
review: required          # the only accepted value; absent = no marker
```

`review: required` marks the business's work as sensitive. Under `review.policy: rule` every delivery of such a business is reviewed (§14.4). The field is declared in the manifest schema.

---

## §7 Seats (employees)

### 7.1 Structure

A seat is a Markdown file with YAML frontmatter (for the engine and the gate) and a body (for the agent that plays it).

```markdown
---
name: cmo-strategy
role: "Chief Marketing Officer"
type: functional_specialist
description: "Strategic marketing leader. Use when a request involves multi-channel decisions or repositioning."
reports_to: ceo
manages: [head-of-content, head-of-growth]
is_antagonist: false
is_brief_intake: false
squads_authorized: [brandcraft]
squads_preferred: [landing-page-nirvana]
assigned_mind_clones: [dan-kennedy]
pinned_mind_clones: []
acceptance:
  - id: positioning_defended
    description: "the recommended positioning is argued against two alternatives"
    blocking: true
    minimum_score: 0.8
---

# CMO, Marketing Strategy

## Identity
## Guidelines (DO / DO NOT)
## Process
## Output
## Anti-patterns
```

### 7.2 Frontmatter fields

The schema is `EmployeeFrontmatterSchema`, strict: an unknown key is an error (`employee_frontmatter_invalid`). All fields the validator accepts:

| Field | Type | Rule | Use in the solo run |
|---|---|---|---|
| `name` | kebab-case | Required, equal to the file name | The seat's id |
| `role` | string, 2+ characters | Required | Shown in the worker's seat map |
| `type` | enum | `functional_specialist` (default), `mind_clone`, `orchestrator`, `antagonist_gate` (§7.8) | Read by the agent |
| `description` | string | Required, 20+ characters (an optional ceiling is configurable) | Selection criterion; read by the agent |
| `maxTurns` | int | 1 to the configured ceiling, default 15 | Accepted; not applied to the solo session |
| `reports_to` | kebab-case or null | null only at the top of the chart | Org chart (§8) |
| `manages` | array of kebab-case | Direct reports | Org chart (§8) |
| `tools` | array of strings | Tool list | Accepted; the session's tools come from the runtime |
| `model` | string | Short name or full model id | Accepted; not applied to the solo session |
| `effort` | enum | `low`, `medium`, `high`, `xhigh`, `max` | Accepted; not applied to the solo session |
| `authority_level` | enum | `tier-1`, `tier-2`, `tier-3` | Accepted |
| `is_antagonist` | bool | Default false | BP7 |
| `is_brief_intake` | bool | Exactly one per business | Its `acceptance[]` is the contract (§11) |
| `antagonizes` | array of strings | Whose paradigm this seat challenges | Read by the agent |
| `squads_authorized` | array of kebab-case, or null | Closed set when not empty (§6.10) | Cards for the worker |
| `squads_preferred` | array of kebab-case | Open preference (§6.10) | Cards for the worker |
| `pinned_mind_clones` | array, at most 2 | Strong binding (§7.7) | Voices of the seat |
| `assigned_mind_clones` | array | Hint (§7.7) | Voices of the seat |
| `acceptance` | array | §11 | §11 |
| `disclosure_required` | bool | Must be true when `type: mind_clone` | Informative |
| `commercial_use_allowed` | enum | `never`, `review`, `allowed` | Informative |
| `memory.permanent_path` | string | Seat's slice of memory | Informative |
| `operation_mode` | enum | As §6.3 | Warned like the manifest's |
| `secondary_role` | string | Second role label | Informative |
| `mind_clones_used`, `squad_dispatched` | arrays of strings | Council-style declarations | Informative |

Retired but still accepted (§22): `heartbeat`, `self_score_contract`, `escalation_triggers`, `mentions`, `budget_monthly_usd`, `draws_from`, `dna_reference`. The loader tolerates them, the gate warns (`deprecated_field:<name>`), and `--fix` converts or removes them.

**The seat as the agent reads it.** The solo run does not apply `maxTurns`, `model`, `effort` or `tools` per seat: one session plays every seat. They remain valid frontmatter because a seat file is also read by humans and by other tools. The engine reads from a seat file only what §7.5 lists.

### 7.3 Body

A body is written for the agent that plays the seat: Identity, Guidelines (DO and DO NOT), Process, Output, Anti-patterns, plus optional notes on when this seat's decision belongs to a seat above it. A body must stand on its own method whatever `type` is. The clone a task uses is chosen for the task, never guaranteed by the seat, so a body that only scopes the role is thin (`seat_thin`, measured by `check-seat-sufficiency.ts` as sections plus decision lines).

### 7.4 Mind-clone seats

A seat with `type: mind_clone` takes its identity from a clone in the library. It requires `disclosure_required: true` (the schema rejects it otherwise) and should pin the clone (`type_mind_clone_without_pin` when it does not). `disclosure_required` is informative: the engine adds no disclosure text of its own, so a business that must disclose writes the disclosure into the seat's method.

### 7.5 How a seat is played

The business agent receives a map of the seats, one line each: slug, role, file path and the voices (clones) the seat pins or hints at.

- To work as a seat, the agent **opens its file first**.
- To write in a clone's voice, it **opens that clone's persona files first** and never claims a voice it did not load. A clone listed as "not installed" is a defect the gate also catches for pins (`pinned_clone_unresolved`).
- Only `name`, `role`, `pinned_mind_clones`, `assigned_mind_clones` and `squads_authorized` are read from the frontmatter by the engine when it builds that map. A seat whose frontmatter does not parse still appears, by its file name.

### 7.6 Seat lifecycle (retired)

The v1 lifecycle (loaded, idle, active, heartbeat, escalated, drained) assumed seats were running processes. They are not. A seat is a file, read when its work comes up in the run.

### 7.7 Pinned clone per seat

```yaml
pinned_mind_clones: [rory-sutherland]   # at most 2
assigned_mind_clones: [dan-kennedy]     # hint
```

`pinned_mind_clones` is the strong binding: for a seat whose identity is a voice (an advisor), the pin says which voice. `assigned_mind_clones` is a hint. The cap is 2 so that a pinned seat leaves room for the clone a task asks for. Both lists feed the voices of the seat in the worker's map (a category-prefixed ref such as `47-creative-director/david-droga` is reduced to its slug).

A pin that does not resolve in the library is an error at admission (`pinned_clone_unresolved`). A seat that promises one voice and delivers another is worse than a seat that promises none.

`dna_reference` is retired (§22): `--fix` converts it into a pin when its path resolves to a library slug.

### 7.8 `type`: four values

| `type` | Meaning |
|---|---|
| `functional_specialist` | Default (BP8). A role defined by method. |
| `mind_clone` | A role whose identity is a pinned clone. Needs `pinned_mind_clones` (`type_mind_clone_without_pin` otherwise) and `disclosure_required: true`. |
| `orchestrator` | A role that decomposes and distributes work without producing the final deliverable. In the solo run it is a perspective the agent takes, not a dispatcher. |
| `antagonist_gate` | An adversarial reviewer. Implies `is_antagonist: true` (`type_flag_mismatch` when they differ; `--fix` syncs them). |

### 7.9 `acceptance[]` in frontmatter

See §11.

---

## §8 Org chart

`org-chart.yaml` states the hierarchy. The schema is `OrgChartSchema` (extra keys allowed). It accepts two layouts: the canonical `chart` list, and a richer `org` map used by some businesses (no graph is checked for the `org` layout).

```yaml
chart:
  - employee: ceo
    reports: []                  # exactly one node has an empty list: the top
    direct_reports: [cmo-strategy, skeptic-in-residence]
  - employee: cmo-strategy
    reports: [ceo]               # at most one parent
    direct_reports: []
  - employee: skeptic-in-residence
    reports: [ceo]
    direct_reports: []
    is_antagonist: true
    antagonizes: [cmo-strategy]

routing_rules:
  escalation_path: {cmo-strategy: ceo}     # accepted, read by nothing
  default_skip_levels: false
  cross_team_handoff_allowed: true
  antagonist_invocation: {triggers: ["any decision involving 3+ employees"]}
  approval_gates: []
```

**Validation** (the checks behind `org_chart_missing` and `org_chart_inconsistent`):

1. Exactly one node has `reports: []`.
2. Every node exists in `employees/`, and every name in `reports` and `direct_reports` is a seat.
3. If A lists B in `direct_reports`, B lists A in `reports`.
4. No cycle.
5. Exactly one seat has `is_brief_intake: true` (`intake_exactly_one`).
6. More than 5 seats require an antagonist (`antagonist_bp7`).

**What the agent does with it.** The single agent reads the chart to know who owns what. A decision that belongs above the seat it is playing goes into `_SUMMARY.md` as an open item naming that seat. `routing_rules.escalation_path`, `default_skip_levels`, `cross_team_handoff_allowed`, `antagonist_invocation` and `approval_gates` are accepted so existing charts validate; the engine implements none of them, because a seat never hands anything to another process.

---

## §9 Memory

### 9.1 Two curated scopes

Memory never lives inside a business, a squad or a clone. Those folders are the product: a pack update, a migration or a reinstall replaces them wholesale.

```
GLOBAL   <NIRVANA_HOME>/.nirvana/memory/businesses/<slug>/{permanent.md, learned.md}
         true of the business wherever it works
PROJECT  <projectRoot>/.nirvana/memory/businesses/<slug>/{permanent.md, learned.md}
         true only for one project's use of the business
```

- `permanent.md` is curated by the owner.
- `learned.md` holds what past runs proposed and a human promoted.

The scope of a fact is a judgment from its meaning ("this client approves by WhatsApp" is global to the business; "the deadline is the 15th" is project), never inferred from the working directory. A write states its scope; a read returns both, labeled.

### 9.2 The shipped seed

A business may ship `memory/permanent.md`. It is a **seed**: copied once into the global home when that file is empty, then not read again. A stub (a heading with nothing under it) is never copied. When the global home has nothing, a run falls back to the shipped `memory/` directory.

`memory/learned.md` or `memory/projects/` inside a business is a warning (`memory_inside_entity`): a pack update discards it. `nrv memory relocate --apply` moves it.

### 9.3 What the worker does with memory

The worker's map lists the memory directories that exist (global, then project) and tells it to honor what they record. They are pointed at, never pasted into the prompt. A run never writes either file: it writes its own project's memory and lists promotion candidates in its report; a human promotes them to `learned.md`.

### 9.4 Isolation by construction

The worker may touch only: the run folder, the outputs root, the business folder (read), the memory directories, the voices it loads, the squads whose cards it holds, and the folder of its brief. Anything outside is out of scope (§17.1). A project's memory is reachable only through that project's root, so a run for client A has no path to client B's memory.

The isolation test stays mandatory in onboarding: run two briefs for two projects through the same business, then confirm that neither project's outputs contain the other's names.

---

## §10 Handoffs (retired)

Mentions, tickets, escalation, delegation and auto-routing as runtime handoffs between seats are retired. They assumed one agent per seat, and a run is one agent (§14). No business ever had a `tickets/` directory and no code read a mention. In the files, `mentions`, `mention_routing`, `ticket_intake` and the `tickets` block are retired fields (§22).

What replaced them: the seat map (§7.5) for who does what, the open-items list of `_SUMMARY.md` for decisions that belong to another seat or to the user, and `auto_routes` (§13.2) for which business a request goes to.

---

## §11 Acceptance per seat (BP4)

Each seat declares what its deliverable must satisfy:

```yaml
acceptance:
  - id: sources_cited                      # ^[a-z][a-z0-9_-]*$, unique in the business
    description: every factual claim cites a named, dated source
    blocking: true                         # default true
    minimum_score: 0.8                     # 0..1; default = the intensity profile
    capability: quality.specification_conformance    # default
  - id: report_exists
    description: the report exists and is not an outline
    path: outputs/report.md
    min_bytes: 2000
```

| Field | Required | Rule |
|---|---|---|
| `id` | yes | `^[a-z][a-z0-9_-]*$`, unique within the business |
| `description` | yes | What the judge will check, in one sentence |
| `blocking` | no | Default `true` |
| `minimum_score` | no | 0 to 1; without it the entry inherits the Gauntlet intensity profile |
| `capability` | no | Default `quality.specification_conformance` |
| `path` | no | Relative path of the artifact; feeds `verify-deliverable` and resolves against the outputs root |
| `min_bytes` | no | Byte floor of the artifact at `path` |

Unknown keys are an error.

**How it reaches the judge.** Each entry maps one to one onto a `SuccessRequirement`, the type squad capabilities already use. The `acceptance[]` of **every seat** becomes the judge's requirements for the run, next to the brief-conformance requirement (at most 11 in total; ids are deduplicated, the first read wins). Entries with a `path` feed the completeness check of `verify-deliverable.ts`, which applies the declared `min_bytes` whichever list named the file.

**While playing a seat.** A seat's `acceptance[]` is also the quality bar the agent holds itself to while playing that seat. The judged contract is the seats' entries plus the brief's "Done when" items, which the gate also checks against `_CLAIMS.json`.

**No `acceptance` declared** is not an error. The intake seat without one gets `acceptance_missing`, because it is the seat whose output reaches the user.

`self_score_contract` is retired (§22). `--fix` converts `criteria[].{id, description, threshold}` into `acceptance[]` with `blocking: true`, prefixing the seat name when an id would collide. `on_below_threshold` and `max_revise_iterations` have no destination.

---

## §12 Zero-human operation

`operation_mode: zero_human` is the default and the only mode honored. `hybrid` and `human_in_loop` parse and raise `operation_mode_unsupported`; the engine runs them as zero-human.

A business never stops silently. When the worker is blocked by something only a person can supply (a credential, a legal sign-off, a decision outside its brief), it finishes what it can, records the block in `_SUMMARY.md`, and the harness surfaces it to the user. The `escalation_triggers` field and `escalation-triggers.yaml` are retired (§22): 234 seats declared triggers and nothing ever fired one.

Businesses in regulated areas state in each seat's method where a human must review before delivery, and set `review: required` (§6.13) so a reviewer checks every delivery.

---

## §13 Brief routing

### 13.1 The flow

```
request
  → router: BM25 over each business's routing document (§6.9) and its auto_routes (§13.2)
  → the orchestrator picks the business and writes its brief (§14.1)
  → nrv dispatch <business> --brief-file <brief> --exec
  → one business agent runs the request (§14)
```

The router reports the business and, for a route that fired, the seat the route names. `routing.yaml.brief_intake.default_employee` names the seat for a request no route claims.

### 13.2 `auto_routes` live in `routing.yaml`

`business.yaml.auto_routes` is retired; `--fix` relocates it (`auto_route_in_manifest`).

```yaml
auto_routes:
  - pattern: "\\b(audit\\w*|auditoria)\\b.*\\b(seo)\\b"
    route_to: seo-lead
```

A route does two things:

1. **Routing candidate.** The pair (pattern, route_to) becomes a document in the BM25 index, and a brief that matches makes the business a candidate.
2. **Seat selection.** The first pattern that fires resolves the seat the request belongs to, carried in the router's plan as `employee`. The solo run launches no process as that seat; the agent reads the whole business.

Rules:

- `route_to` must name an existing seat (`auto_route_unknown_employee`). The key must be exactly `route_to`; the gate and the router read no other spelling.
- First match wins; file order is evaluation order.
- A catch-all pattern (`.*`, `.+`, `(?i).*` and the like) is ignored and flagged (`auto_route_catch_all`): it would turn routing off while looking like routing.
- Every pattern must fire on at least one of the business's own `example_briefs` (`auto_route_never_fires`).
- `confidence_threshold` and `requires_escalation_to` are retired (§22): neither was ever read, and a regex match has no confidence.

`routing.yaml.brief_intake.default_employee` is the fallback seat. The schema also accepts `brief_intake.alternates`, `mention_routing` and `ticket_intake`; the last two are retired.

### 13.3 Using squads

A business uses a squad by reading its work card and working as the squad's agents. It never dispatches the squad. The flow:

```
a part of the work could be a squad's
  → is a squad named in the request? use it, always
  → is a card in the worker's map (router picks, preferred, seats' closed sets)? read it
  → otherwise nrv cards squad <slug> for an installed squad that fits
  → the seat's closed squads_authorized, when not empty, bounds the choice
  → none fits: the business does the part itself
```

The worker picks the capability its part needs, opens its workflow or task, and for each step it runs opens that step's agent file and works as that agent.

---

## §14 Execution model: the solo run

A dispatched business is **one agent** that is the whole business for one request (`skills/harness/lib/business-solo.ts`). It never dispatches anything: not a squad, not a seat, not another business (role `solo`, an empty dispatch allowance; the engine refuses any dispatch from it).

### 14.1 The brief

The orchestrator writes one brief per business, in six sections with these exact headings:

| Section | Content |
|---|---|
| `Request (verbatim)` | The user's own words, unedited |
| `Decisions` | What the user already decided |
| `Your part` | What this business delivers and what another covers |
| `Inputs` | Paths the worker needs (attachments, another business's `_SUMMARY.md`) |
| `Done when` | Observable criteria; `(blocking)` marks those the delivery fails without |
| `Output` | The folder for the deliverables |

It states what and why, never how. `nrv brief template` prints the skeleton, `nrv brief check <file>` validates it, and `nrv brief decide <file> "<decision>"` appends a decision while the run is going. The worker re-reads the brief at every phase, so decisions reach it without stopping the run. The "Done when" items become review criteria `d1..dn`.

### 14.2 What the worker does

The engine hands the worker a prompt that is a map, never pasted content: the brief file, the business folder, the memory directories, the seat map with each seat's file, the voices (each clone listed once, with its folder and the persona files inside), and the squad cards.

- **Voices.** A clone counts as asked for only when the brief's `Request (verbatim)` section names it, or a line marks it `clone <slug>`; a clone listed as a fact elsewhere in the brief asks for nothing. When the brief asks for none, the library is searched on the request and the business's part, and at most three clones above the coverage gate are offered; if none fits, none is. A clone a seat already carries is not repeated. A clone that was asked for and is not installed gets one line in the prompt, and the search does not stand in for it. A squad dispatch selects its clones by the same rule (`harness/lib/clone-voices.ts`).
- **Squad cards.** Cards are written for the squads the router picked, the ones the brief names and the business's `squads_preferred`. The squads its seats are authorized for (`squads_authorized`) are listed by name only; `nrv cards squad <slug>` prints a card when the work needs one.
- **Memory.** The first run seeds the machine memory home from the business's shipped `memory/` (`nrv memory` explains the two scopes). Directories whose files are stubs are not listed. When the shipped folder differs from the home, the prompt names it as newer. The prompt also gives the command to record a lesson: `nrv memory add <slug> "<fact>" --scope global|project`.
- **Inputs.** Paths in `## Inputs` (absolute, `~`, or relative to the project root) that exist are resolved, listed in the prompt and granted to the run, so a worker whose folder is elsewhere still reads them.

The worker then:

1. Works in **phases** and keeps `_work/PROGRESS.md` current: decisions taken, what is done (with paths), what is next. If its context is compacted, the brief and `PROGRESS.md` are how it continues.
2. **Reads with purpose**: it locates with a search, reads the part it needs, batches independent reads, and does not print back a file it just wrote.
3. Writes **deliverables under the outputs root** and working files under `_work/`. Work the brief places in another folder (a project to review or fix, a new project to create) is done there, and every path it created or changed is listed in the summary. `participation.json` sits in the run folder on purpose.
4. Writes deliverables in the **language of the request**.
5. Delivers the whole of its part and nothing beyond it. Anything beyond goes into the summary as a note.
6. Plays seats by opening their files, writes in a clone's voice only after loading its persona, and uses squads through their cards (§13.3).

### 14.3 What it writes at the end

| File | Content |
|---|---|
| `_SUMMARY.md` | One page at most: what was delivered and where, decisions taken, what is open. The orchestrator reads only this. |
| `_CLAIMS.json` | An array with one entry per "Done when" item, in order: `{"id": "d1", "evidence": "<file>:<lines>, <what it shows>"}` |
| `participation.json` | `{"seats": [{"seat", "files"}], "squads": [...], "clones": [...]}`, naming only what it actually used |

The engine credits the seats the worker declares in `participation.json` (event `x_seat_credited`, evidence `declared`); names that are not seats of the business are dropped. Each clone it declares under `clones` is credited the same way (event `x_clone_credited`, with `source`: `seat` for a seat's own voice, `request` for one the engine offered for the request, `own-choice` otherwise). The voices the engine offered are on `x_business_solo_started` (`voices`). A session that ends before the files are on disk is not a finished run: a headless session dies when its final turn ends, so the worker never leaves background work behind.

### 14.4 Review, decided by a rule

After the run the engine decides whether to review. The setting is `review.policy`:

| Policy | A delivery is reviewed when |
|---|---|
| `always` | always |
| `rule` (default) | the user asked, the business has `review: required` (§6.13), or the deterministic precheck failed |
| `on-request` | the user asked, or the precheck failed |
| `never` | only when the user asks |

`--no-review` from the user wins over everything; `--review` forces it. The precheck is deterministic: there is a deliverable file, `_SUMMARY.md` exists, and `_CLAIMS.json` holds a claim with real evidence for every blocking "Done when" item.

There is **one reviewer for the whole delivery**, never one per seat. With `review.runtime: other` (default) it runs on a different available runtime. It checks each claim's pointer in the files and answers with what it confirmed; silence rejects. A rejection goes back to the worker in its own session, at most `review.max_rounds` times (default 1). When rounds are exhausted the delivery ships with `_QA-RESERVATIONS.md` naming what was never confirmed.

### 14.5 Gate and delivery

The engine then runs the completeness proof (`verify-deliverable`, §11) and the quality gate, and delivers. Proof is what the engine checked on disk and in the audit; the summary is a report, not proof.

### 14.6 What does not exist

No director, no chain of seats, no session per seat, no seats as subagents, no handoffs between seats at runtime, no approval chains, no `execution.business_mode` setting, no `--team` or `--single` flag, no `nrv team`.

---

## §15 Tools

`tools` in seat frontmatter is a list of tool names, accepted for compatibility. In the solo run the session's tools come from the runtime and its permissions. `project_tool_overrides` and `default_tools` are retired (§22): they were never read.

---

## §16 Validation

### 16.1 The executed validator

The validator that runs is **Zod**, in `skills/_shared/validators/validators.ts`. `validators.py` is its canonical mirror for hosts with Python. `skills/_shared/schemas/business.schema.json` and `core-schemas.json` are documentation mirrors: they describe the contract and do not execute it, and a divergence from the Zod schema is a defect in the JSON. Validation is two-stage: the schemas (`BusinessManifestSchema`, `EmployeeFrontmatterSchema`, `OrgChartSchema`, `RoutingSchema`), then the integrity check across them (BP7, one intake, chart consistency, derived count).

### 16.2 The gate catalog

The table below **is** the criteria catalog of `nrv validate business <slug>`. The ids here and the ids in the gate module (`skills/_shared/lib/verify/kinds/business.ts`) are the same set, checked by `skills/businesses/tests/protocol-v2-spec-parity.test.ts`. A row without a criterion, or a criterion without a row, fails that test.

Columns: **id**; **autofix** (`mechanical` is applied by `--fix`, `agentic` by `--fix=agentic`, `none` is human authorship); **baselineable** (may become recorded debt instead of failing); **what it checks**. An error fails the business; a warning fails only with `--strict`.

Debt is reserved for pipeline facts (`seat_thin`, `self_retrieval_miss`) and for the two audit-contract criteria. Those two make a violation of the event contract visible without rejecting the entities that already violate it, some of them inside published packs, before there is anywhere to migrate to. With a baseline they become recorded debt that only shrinks, and any new violation fails. Every other error is unbaselineable.

#### Errors

| id | autofix | baselineable | what it checks |
|---|---|---|---|
| `manifest_parse` | none | no | `business.yaml` exists and is valid YAML |
| `manifest_schema` | mechanical | no | The manifest passes `BusinessManifestSchema` |
| `protocol_unsupported` | none | no | `protocol` is `1.0` or `2.0` |
| `employees_present` | none | no | `employees/` exists with at least one `.md` |
| `employee_frontmatter_invalid` | mechanical | no | Every frontmatter passes `EmployeeFrontmatterSchema` |
| `intake_exactly_one` | mechanical | no | Exactly one seat with `is_brief_intake: true` |
| `org_chart_missing` | mechanical | no | `org-chart.yaml` exists |
| `org_chart_inconsistent` | mechanical | no | Every node exists in `employees/`, reporting is bidirectional, no cycle |
| `antagonist_bp7` | none | no | BP7: more than 5 seats require an antagonist |
| `auto_route_unknown_employee` | none | no | Every `route_to` names an existing seat |
| `auto_route_in_manifest` | mechanical | no | `auto_routes` is not in `business.yaml` |
| `pinned_clone_unresolved` | none | no | Every `pinned_mind_clones` entry resolves in the library |
| `acceptance_invalid` | mechanical | no | `acceptance` ids are valid and unique in the business; `minimum_score` in 0..1 |
| `surface_missing` | mechanical | no | `.nirvana-surface.json` exists |
| `dna_symlink_dangling` | none | no | No `dna/` symlink points at a missing target |
| `outputs_pollution` | none | no | No run-output directory inside the business |
| `audit_event_unprefixed` | none | yes | Every audit event a file names is in the closed enum or carries the `x_` prefix |
| `audit_event_unattributed` | none | yes | Every `x_` event the business emits names the business (`business_slug` or `--business=`) |

#### Warnings

| id | autofix | baselineable | what it checks |
|---|---|---|---|
| `protocol_v1` | mechanical | no | The business still declares `protocol: "1.0"` |
| `employee_count_authored` | mechanical | no | `employee_count` is declared in the manifest (§6.12) |
| `deprecated_field` | mechanical | no | A retired field is present (`:<name>` says which) |
| `deprecated_file` | none | no | A retired file is present (`:<name>` says which) |
| `squads_authorized_empty` | mechanical | no | `squads_authorized: []` is declared (§6.10) |
| `squads_ref_unknown` | none | no | A squad named in preferred or authorized is not in the library |
| `acceptance_missing` | agentic | no | The intake seat declares no `acceptance` |
| `routing_metadata_incomplete` | agentic | no | One of the four §6.9 fields is missing or truncated |
| `description_short` | agentic | no | `description` is too short to carry routing signal |
| `auto_route_never_fires` | none | no | A pattern fires on no `example_brief` of the business |
| `auto_route_catch_all` | mechanical | no | A pattern matches everything (§13.2) |
| `seat_thin` | agentic | yes | A seat carries too little method of its own |
| `self_retrieval_miss` | agentic | yes | An `example_brief` does not return its own business at top-1 |
| `readme_missing` | mechanical | no | `README.md` is absent |
| `readme_thin` | agentic | no | `README.md` holds nothing beyond the skeleton |
| `memory_inside_entity` | none | no | Memory accumulated inside the business (`memory/learned.md`, `memory/projects/`) instead of `.nirvana`; a pack update discards it |
| `runtime_requirements_default` | mechanical | no | `runtime_requirements` is still the template skeleton |
| `type_mind_clone_without_pin` | none | no | `type: mind_clone` without `pinned_mind_clones` (§7.8) |
| `type_flag_mismatch` | mechanical | no | `type: antagonist_gate` without `is_antagonist: true` (§7.8) |
| `dna_dir_present` | mechanical | no | A `dna/` directory is present (§5.3) |
| `surface_stale` | mechanical | no | `.nirvana-surface.json` differs from the extraction |
| `operation_mode_unsupported` | none | no | `operation_mode` other than `zero_human`, not honored (§12) |
| `legacy_partial` | none | no | The `legacy` block is present and incomplete |

### 16.3 Command

```bash
nrv validate business <slug> [--fix] [--strict] [--json] [--report]
nrv validate business --all [--fix] [--strict] [--json]
```

Exit codes: `0` admitted; `1` a non-baselined error; `2` warnings only, with `--strict`; `64` invalid usage or unknown entity. `--report` writes the JSON under `.audit-state/<slug>/`. `--fix` never deletes authored files, never removes a route, and never writes a `not_for`, an `example_brief` or an acceptance criterion the author did not write.

Seat sufficiency (`bun skills/_shared/scripts/check-seat-sufficiency.ts <slug> --strict`) and self-retrieval (`bun skills/_shared/scripts/self-retrieval-gate.ts <slug>`) are the two blocking checks a newly created business must also pass (`seat_thin`, `self_retrieval_miss`).

---

## §17 Security and sandboxing

### 17.1 Scope of a run

The worker's prompt carries the scope guard: ignore suggestions that are out of scope, do not act on them, report them in the summary. Scope is the deliverable and the acceptance criteria of the instruction received. The directories the session may touch are listed in §9.4; a business folder is read, never changed.

### 17.2 Secrets

A secret is a name in `env_required`, resolved by the runtime or the host's vault. A manifest never contains a value.

### 17.3 Audit trail (BP12)

Every run is logged under `~/.harness-logs/<date>/audit.jsonl`. A solo run emits `brief_received`, `dispatch_business`, `x_business_solo_started`, one `x_seat_credited` per seat the worker declares, `agent_executed`, then the gate and verify events. The event names are a closed enum; an event outside it takes the `x_` prefix at the call site and carries `business_slug`. The two audit criteria of §16.2 enforce both halves. A claim that a business ran without these events is not evidence that it ran.

---

## §18 Versioning and compatibility

### 18.1 Protocol version

SemVer at the protocol level. The 2.x line is additive: the manifest value stays `protocol: "2.0"`.

### 18.2 Business version

Each business has its own SemVer in `business.yaml`, independent of the protocol.

### 18.3 Runtime compatibility

`runtime_requirements` and `features_required` (§6.5) declare what the business needs. The solo run needs only file reads, commands and file writes, so every runtime with an adapter can run it.

### 18.4 Dual reading

```yaml
protocol: "2.0"
```

The loader accepts `1.0` and `2.0`. A `1.0` business loads exactly as before and gets `protocol_v1`. `3.0` is refused. The registry schema (`RegistryBusinessesSchema`) and the manifest accept the same enum.

Raising the version to `2.0` is **the last thing `--fix` does**, and only when no v2 error remains: declaring a version the business does not yet meet is worse than declaring the old one.

---

## §19 Pattern maturity

**Production-ready:** the solo run (§14), review by rule (§14.4), acceptance per seat (§11), routing metadata and auto-routes (§6.9, §13.2), pinned clones (§7.7), the two-scope memory (§9), the admission gate (§16).

**Works with tradeoffs:** `type: orchestrator` and `antagonist_gate` as perspectives inside one session; `review.runtime: other` depends on a second runtime being installed (it falls back to the worker's own).

**Not implemented (proposals):** multi-business orchestration inside one run, cross-business approval, seat reputation scoring, cross-project memory sharing with consent, live human takeover, self-improving routing rules.

---

## §20 Proposed

None of §19's last group is specified. A proposal enters this protocol only with a measurement of the gap it closes and a reader in the engine.

---

## §21 Migration from Paperclip

A Paperclip company maps to a business: `company.yaml` to `business.yaml`, `agents/<id>.yaml` plus `instructions/<agent>/*.md` to `employees/<name>.md`, `routing.yaml` to `routing.yaml`, bridges to `squads_authorized`, the company id to `legacy.paperclip_company_id`. Heartbeat, mention and ticket artifacts have no destination (§22). The adapter is `paperclip-to-business-v1.ts` in the migration tools; run `nrv validate business <slug> --fix` afterwards.

---

## §22 Retired surface

Everything below follows §0: the loader tolerates it, the gate warns, only `--fix` converts or removes it, and the loader drops it in v3. The "measured" column counts entities that declared the item on 2026-08-26, over 61 businesses and 581 seats.

| Surface | Measured | Destination |
|---|---|---|
| `heartbeat` (BP10) | 475 seats | Removed. Scheduling belongs to the host. |
| `self_score_contract` (BP4) | 566 seats | Converted to `acceptance[]` (§11) |
| `escalation_triggers` | 234 seats | Removed |
| `escalation-triggers.yaml` | 13 businesses | Reported, never deleted |
| `budget_monthly_usd` | 93 seats | Removed (§6.11) |
| `mentions`, `mention_routing` | 52 seats | Removed (§10) |
| `draws_from` | 51 seats | Converted to `assigned_mind_clones` |
| `dna_reference` | 7 seats | Converted to `pinned_mind_clones` (§7.7) |
| `business.yaml.auto_routes` | 7 businesses | Relocated to `routing.yaml` (§13.2) |
| `dna/` symlinks | 3 businesses | Converted to frontmatter bindings (§5.3) |
| `culture.md` | 2 businesses | Reported; content moves to `memory/permanent.md` |
| `budgets.yaml` | 1 business | Reported, never deleted |
| `tickets/`, `tickets:` block, `ticket_intake` | 0 | Removed |
| `approval-chains.yaml` (BP9) | 0 | Removed |
| `secrets-manifest.yaml` | 0 | Removed. Secrets are `env_required` plus the host vault. |
| `processes/` | 0 | Removed from the layout (§5.3) |
| `capabilities_required` | none | Removed. `capabilities[]` is the field. |
| `project_tool_overrides`, `default_tools` | none | Removed. Seat `tools` is the list. |
| `disclosure_template` | none | Removed. `disclosure_required` is informative. |
| `confidence_threshold`, `requires_escalation_to` | none | Removed from `auto_routes` (§13.2) |
| Runtime handoffs, chains of seats, `execution.business_mode`, `--team`, `--single`, `nrv team` | n/a | Replaced by the solo run (§14) |

**Still honored:** `is_brief_intake`; `is_antagonist` and `antagonizes` (BP7); `reports_to`, `manages` and `org-chart.chart`; `routing.yaml` (`brief_intake.default_employee`, `auto_routes`); `memory/permanent.md` as a seed and the two memory scopes; `type`; the routing metadata (§6.9); `run_budget_usd`; `review`; pins and hints of clones; `squads_preferred` and `squads_authorized`; `acceptance`; `runtime_requirements`, `features_required`, `env_required`; `legacy`; `ui`. Accepted without effect on a solo run: `maxTurns`, `tools`, `model`, `effort`, `authority_level`, `operation_mode` other than `zero_human`, `routing_rules.*`, `output`, the manifest `memory` block.

---

## App-A Migration from v1

No step is required to keep running. The order below is the one `--fix` applies, and it ends with the version bump because the version is a claim about the rest.

1. `nrv validate business <slug> --json`: inventory of what the business declares.
2. `nrv validate business <slug> --fix`: removes empty lists, relocates `auto_routes`, converts `self_score_contract`, removes retired fields, turns `dna/` into frontmatter bindings, regenerates the surface.
3. Human authorship for what `--fix` does not invent: `not_for`, the intake seat's `acceptance`, thin seats, dead fences.
4. `nrv validate business <slug> --strict`: the final report.
5. `protocol: "2.0"` is raised automatically at the end, once no error remains.

Behavioral change worth knowing: v1 described a team of seats exchanging mentions and tickets, with approval chains and heartbeats. In v2 that never ran and no longer exists; the same seats are read by one agent (§14). A business written for v1 needs no change to run.

## App-B Canonical seat roles

`role` is free text, but these names keep businesses comparable.

```
C-suite:     ceo, cmo, cto, cfo, coo, cpo, cco (creative), cgo (growth), cai (ai)
Heads:       head-of-content, head-of-growth, head-of-brand, head-of-engineering, head-of-design,
             head-of-customer-success, head-of-people, head-of-finance, head-of-legal, head-of-data, head-of-sales
Specialists: content-writer, copywriter, designer, motion-designer, brand-strategist, performance-marketer,
             data-analyst, software-engineer, qa-engineer, devops-engineer, security-engineer, product-manager,
             ux-designer, ui-designer, sales-development-rep, account-executive, customer-success-manager
Antagonists: skeptic-in-residence, devils-advocate, anti-pattern-hunter, contrarian-strategist
Specialized: legal-counsel, compliance-officer, accountant, recruiter, brand-guardian, ethics-officer
```

## App-C Schemas and templates

- Zod (executed): `skills/_shared/validators/validators.ts`; Python mirror `validators.py`.
- JSON mirrors (documentation): `skills/_shared/schemas/business.schema.json`, `core-schemas.json`.
- Routing metadata contract: `skills/_shared/ROUTING_METADATA_CONTRACT.md`.
- Templates: `skills/businesses/templates/business-types/{solo,council,agency,conglomerate}` and the runnable `example-business`; `nrv` scaffolds them through `init-business.ts --template <type>`.

## App-Z Versions

| Version | Change |
|---|---|
| 1.0.0 | First protocol: team of seats, handoffs, heartbeats, approval chains. Archived in `docs/legacy/protocols/businesses/`. |
| 2.0.0 | Routing metadata, pinned clones, preference versus restriction, acceptance per seat, single budget field, `auto_routes` semantics, retired surface (§22), the gate catalog (§16.2). |
| 2.1.0 | Complete document. Execution is the solo run (§14); review by rule; two-scope memory; handoffs and team execution retired. |
