# businesses skill · Configuration reference

> What can be configured in this skill, where, and what each setting does. The field contracts are in `BUSINESS_PROTOCOL_V2.md`; this file is the operational summary.

---

## 1. Where configuration lives

In precedence order (first wins):

1. **Command-line flags** of the scripts.
2. **Environment variables.**
3. **Defaults** in the scripts and `lib/`.

There is no `config.yaml` for this skill. Engine-wide settings (review, budget, verify mode) are read with `nrv config explain <key>`.

---

## 2. Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `BUSINESSES_DIR` | `~/businesses` | Root of the installed businesses. Each `<slug>/` holds `business.yaml`, `employees/`, `org-chart.yaml`, `routing.yaml`. |
| `BUSINESSES_LIBRARY` | `${BUSINESSES_DIR}/_library` | Assets shared across businesses (clone library, frameworks). Not scanned as businesses. |
| `DNA_LIBRARY` | `${BUSINESSES_LIBRARY}/dna` | The mind-clone library that `pinned_mind_clones` and `assigned_mind_clones` resolve against. |
| `BUSINESSES_REGISTRY_PATH` | `<NIRVANA_HOME>/.businesses-registry.json` | The registry `nrv index` writes. |
| `PROJECTS_OUTPUT_DIR` | `.projects-outputs` | Where run outputs are written, per project. |
| `NIRVANA_PROJECT_ROOT` | (walk up to `.nirvana/project.yaml`) | Pins the project root regardless of the working directory. |
| `NIRVANA_HOME` | `~` | Home of `.nirvana` (engine, machine memory). |

Run scripts from the project's working directory with absolute paths. Scope (global, project, merge) is detected by walking up from the current directory.

---

## 3. Scripts

Run them with `bun ~/.nirvana/skills/businesses/scripts/<script>.ts`, or through `nrv` where a subcommand exists (`nrv list-businesses`, `nrv validate business`, `nrv index`).

### `init-business.ts <slug> [options]`

Scaffolds a business from a template and runs the gate over it in `--fix` mode.

| Flag | Purpose |
|---|---|
| `--template <type>` or `--type <type>` | `solo`, `council`, `agency` or `conglomerate` |
| `--from-json <path>` | Build from a JSON description |
| `--non-interactive` | Never ask questions |
| `--domains a,b` | Override domains |
| `--description <text>` | Set the description |
| `--force` | Overwrite an existing directory |
| `--skip-verify` | Skip the post-scaffold gate run |

### `validate-business.ts <path-or-slug> | --all` (same code as `nrv validate business`)

The admission gate: the 41 criteria of `BUSINESS_PROTOCOL_V2.md` §16.2 (18 errors, 23 warnings).

| Flag | Purpose |
|---|---|
| `--all` | Every business the scope resolves, one batch report |
| `--fix` | Apply the mechanical fixers with backup, re-check and rollback |
| `--strict` | Warnings fail too (exit 2) |
| `--json` | Machine report (`nirvana.verify-report/v1`; `nirvana.verify-batch/v1` with `--all`) |
| `--report` | Also write the JSON to `.audit-state/<slug>/verify.json` |
| `--no-retrieval` | Skip the self-retrieval axis |

Exit codes: `0` admitted; `1` an error the baseline does not cover; `2` only warnings under `--strict`; `64` usage error or unknown business.

### `index-businesses.ts [--quiet]` (`nrv index`)

Scans the scope's business directories and writes the registry.

### `list-businesses.ts [--short] [--format compact|json]` (`nrv list-businesses`)

Lists the registry. `--short` omits descriptions.

### `inspect-business.ts <slug> [--format compact|json]`

Manifest, seats and org chart of one business.

### `brief-business.ts <slug> "<brief>" [--project <id>] [--manifest <file>]`

Scaffolds a run (project folder, brief, ledger entry) without executing. `--manifest` lists the files the delivery must contain. Execution is `nrv dispatch <slug> --brief-file <brief> --exec`.

### `verify-deliverable.ts`

The completeness proof the engine runs after a run: expected files from a manifest or from the `path` entries of `acceptance[]`.

---

## 4. Manifest (`business.yaml`)

The complete field list, with limits, is `BUSINESS_PROTOCOL_V2.md` §6. The fields that change engine behavior:

| Field | Default | Effect |
|---|---|---|
| `protocol` | required | `"1.0"` or `"2.0"` |
| `description`, `domains`, `produces`, `keywords`, `example_briefs`, `not_for` | see §6.9 | Routing metadata; decides whether the router finds the business |
| `squads_preferred` | none | Open list: the worker always gets a card for these squads |
| `squads_authorized` | none | Closed set, only when not empty; `[]` equals absent (every squad allowed) |
| `run_budget_usd` | none | Ceiling for one run; 0 or absent is unlimited; the smaller of this and `--max-budget` wins |
| `review` | none | `required` marks the work as sensitive; under `review.policy: rule` every delivery is reviewed |
| `operation_mode` | `zero_human` | Only `zero_human` is honored; other values warn |
| `authority_level` | `tier-2` | `tier-1`, `tier-2`, `tier-3` |
| `runtime_requirements.policy` | `active` | `active` uses the session runtime; `declared` requires `minimum[]` |
| `features_required`, `features_optional` | none | Runtime features the business needs |
| `env_required` | none | Environment variable names that must exist; never values |
| `experimental_domains` | `false` | When true, domains outside the capability catalog are accepted |
| `legacy` | none | Migration metadata |

`employee_count` is derived from `employees/*.md`; do not author it. `output` and the manifest `memory` block are accepted and read by nothing.

---

## 5. Seat frontmatter (`employees/<name>.md`)

The frontmatter schema is strict: an unknown key fails `employee_frontmatter_invalid`. The full table, with what the solo run does with each field, is `BUSINESS_PROTOCOL_V2.md` §7.2. The fields the engine uses:

| Field | Default | Effect |
|---|---|---|
| `name`, `role`, `description` | required | Identity; `description` is 20+ characters |
| `type` | `functional_specialist` | Also `mind_clone` (needs `disclosure_required: true`), `orchestrator`, `antagonist_gate` |
| `reports_to`, `manages` | none | Org chart |
| `is_brief_intake` | `false` | Exactly one per business; its `acceptance[]` is the judge's contract |
| `is_antagonist`, `antagonizes` | `false` | BP7: required above 5 seats |
| `acceptance[]` | none | What the deliverable must satisfy (§11) |
| `pinned_mind_clones` | none | At most 2; strong voice binding, must resolve in the library |
| `assigned_mind_clones` | none | Voice hint |
| `squads_authorized`, `squads_preferred` | none | Narrow or extend the business lists |

`maxTurns` (default 15), `model`, `effort`, `tools` and `authority_level` are valid but not applied to a solo run, which is one session for the whole business. Retired fields (`heartbeat`, `self_score_contract`, `mentions`, `escalation_triggers`, `budget_monthly_usd`, `draws_from`, `dna_reference`) are tolerated and warned; see `BUSINESS_PROTOCOL_V2.md` §22.

---

## 6. Routing (`routing.yaml`)

| Field | Effect |
|---|---|
| `brief_intake.default_employee` | The seat for a request no route claims |
| `auto_routes[].pattern` | Regex; must fire on at least one of the business's own `example_briefs` |
| `auto_routes[].route_to` | Seat the request belongs to; must exist |

First match wins. A catch-all pattern is ignored and flagged. `auto_routes` live only here, never in `business.yaml`.

---

## 7. Org chart (`org-chart.yaml`)

`chart[]` nodes carry `employee`, `reports` (zero or one parent), `direct_reports`, optional `is_antagonist` and `antagonizes`. Exactly one node has no parent; reporting must be bidirectional and acyclic. `nrv validate business <slug> --fix` rederives the chart from `reports_to` and `manages`. The `routing_rules` block is accepted and read by nothing.

---

## 8. Engine settings that act on a business run

| Setting | Default | Effect |
|---|---|---|
| `review.policy` | `rule` | `always`, `rule`, `on-request`, `never`: when the delivery is reviewed |
| `review.runtime` | `other` | Reviewer on a different available runtime, or `same` |
| `review.max_rounds` | `1` | Correction rounds after a failed review, then `_QA-RESERVATIONS.md` |
| `quality_gate.max_revisions` | `2` | Automatic revisions before holding a delivery back |
| `verify.mode` | `report` | How the admission-gate hooks treat a finding: `report`, `warn`, `block` |

Per run: `--review` and `--no-review` on `nrv dispatch` override the policy, and `--max-budget <usd>` sets a ceiling. Read any setting with `nrv config explain <key>`.

---

## 9. Memory

Memory lives outside the business, in two scopes (`BUSINESS_PROTOCOL_V2.md` §9):

- Machine: `<NIRVANA_HOME>/.nirvana/memory/businesses/<slug>/{permanent.md, learned.md}`
- Project: `<projectRoot>/.nirvana/memory/businesses/<slug>/{permanent.md, learned.md}`

A shipped `memory/permanent.md` is a seed, copied once into the machine scope. `permanent.md` is curated by the owner; `learned.md` holds what a human promoted from past runs. A run reads both scopes and writes neither; it lists promotion candidates in its report. A business folder holding `memory/learned.md` or `memory/projects/` raises `memory_inside_entity`; `nrv memory relocate --apply` moves them.

There is no shortcut that appends a fact to memory on its own. A fact enters memory through a human edit or a human promotion, so every entry traces to a person.

---

## 10. Limits

| Limit | Value | Source |
|---|---|---|
| Business `name` | `^[a-z][a-z0-9-]{1,63}$` | `validators.ts` |
| `description` | 20 to 2000 characters (configurable ceiling) | `validators.ts`, `limits.ts` |
| `domains` | 1 to 50 | `validators.ts` |
| `produces` | 1 to 60 | `limits.ts` (`business_produces_max`) |
| `example_briefs` | at most 30, each 20 to 1000 characters | `limits.ts` |
| `keywords` | at most 100 | `limits.ts` |
| `not_for` | at most 40, each 5 to 80 characters | `limits.ts` (`business_not_for_max`) |
| `pinned_mind_clones` | at most 2 per seat | `validators.ts` |
| `employee_count` | derived; declared values 1 to 100 | `validators.ts` |

The executed validator is Zod in `skills/_shared/validators/validators.ts`; `validators.py` mirrors it, and the JSON schemas are documentation.

---

## 11. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Registry does not list a new business | Not re-indexed | `nrv index` |
| Slug rejected | Uppercase, space or special character | kebab-case only |
| `antagonist_bp7` | More than 5 seats, no antagonist | `is_antagonist: true` on one seat |
| `intake_exactly_one` | Zero or several intake seats | Exactly one `is_brief_intake: true` |
| Domain rejected | Not in `CAPABILITY_CATALOG_V1.yaml` | Use a catalog domain or set `experimental_domains: true` |
| `surface_stale` or `surface_missing` | `.nirvana-surface.json` is engine-owned | `nrv validate business <slug> --fix` |
| Scripts list the home registry in a project | Shell left the project tree | Run from the project directory, or set `NIRVANA_PROJECT_ROOT` |

---

## References

- `SKILL.md`: the skill entry
- `README.md`: overview
- `TUTORIAL.md`: step-by-step
- `BUSINESS_PROTOCOL_V2.md`: the complete protocol
- `~/.nirvana/skills/_shared/CONFIGURATION.md`: shared schemas and validators
- `~/.nirvana/skills/_shared/SCRIPT_CONTRACT.md`: the script contract
