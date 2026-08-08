# businesses skill · Configuration Reference

> Everything that can be configured in this skill, where, and the effect of each variable.
> Last updated: 2026-05-03 (refactor enforcement layer + capabilities indexer).

---

## 1. Where the configuration lives

The `businesses` skill reads configuration from 3 sources, in precedence order (first wins):

1. **CLI flags** of the scripts (e.g. `--roots <dir>`, `--format json`)
2. **Environment variables** (`~/.env` loaded via shell)
3. **Hardcoded defaults** in `lib/registry.py` and the scripts

There is no dedicated `config.yaml` for this skill. The relevant configuration lives in `~/.env` or in CLI flags.

---

## 2. Environment variables

Set in `~/.env` (and propagated via `set -a; source ~/.env; set +a` or by Claude Code).

### Paths

| Variable | Default | Purpose |
|---|---|---|
| `BUSINESSES_DIR` | `~/businesses` | Root directory where businesses are read/written by the scripts. Each `<slug>/` subdirectory is a business with `business.yaml`, `employees/`, `org-chart.yaml`, `routing.yaml`. |
| `BUSINESSES_LIBRARY` | `${BUSINESSES_DIR}/_library` | Directory with assets shared across businesses (DNA library, templates). Not scanned by the registry. |
| `DNA_LIBRARY` | `${BUSINESSES_LIBRARY}/dna` | Directory with canonical mind-clones (60 categories, 408 .md). Employees with `type: mind_clone` point to files here via `dna_reference`. |
| `PROJECTS_OUTPUT_DIR` | `.projects-outputs` | Subdirectory (relative to each business) where dispatches via `brief-business.ts` write outputs. Each brief becomes `<biz>/<PROJECTS_OUTPUT_DIR>/proj-<id>/`. |

### Flow: how each one is used

- `BUSINESSES_DIR` is what `index-businesses.ts` scans to generate `${BUSINESSES_REGISTRY_PATH}`
- `BUSINESSES_LIBRARY` + `DNA_LIBRARY` are consumed by `mapAgentToEmployee()` when creating a business via `init-business.ts` or via the `paperclip-to-business-v1.ts` adapter
- `PROJECTS_OUTPUT_DIR` is just a naming convention — used by the scripts when creating dispatch dirs

---

## 3. CLI scripts — flags and arguments

The 6 scripts in `~/.claude/skills/businesses/scripts/`:

### `init-business.ts <name> [options]`

Creates a new business via interactive wizard.

| Flag | Default | Purpose |
|---|---|---|
| `<name>` (positional) | required | Business slug (kebab-case, 3-64 chars, regex `^[a-z][a-z0-9-]+$`) |
| `--template <name>` | `solo` | Initial template: `solo` (1 employee), `council` (3-7 employees with C-suite), `agency` (8-15 employees full agency) |
| `--force` | (off) | Overwrites existing directory without asking |
| `--domain <slug>,...` | (interactive) | Override domains (skips the user prompt) |
| `--employee-count <n>` | (interactive) | Pre-sets the wizard's employee count |

### `validate-business.ts <path-or-slug>`

Validates manifest + integrity.

| Flag | Default | Purpose |
|---|---|---|
| `<path-or-slug>` (positional) | required | Absolute path or slug (resolved against `BUSINESSES_DIR`) |
| `--strict` | (off) | Promotes warnings to errors (BP7 antagonist, intake unique, schema strict) |

### `index-businesses.ts [options]`

Scans + generates `${BUSINESSES_REGISTRY_PATH}`.

| Flag | Default | Purpose |
|---|---|---|
| `--roots <dir>...` | `[$BUSINESSES_DIR]` | Override the roots to scan. Accepts multiple: `--roots ~/businesses ~/work-businesses` |
| `--output <path>` | `${BUSINESSES_REGISTRY_PATH}` | Path of the generated registry JSON |
| `--quiet` | (off) | Suppresses listing of found businesses |

### `list-businesses.ts [options]`

Enumerates the registry.

| Flag | Default | Purpose |
|---|---|---|
| `--format <fmt>` | `table` | `table` (readable output) or `json` (raw) |
| `--filter-domain <slug>` | (off) | Shows only businesses containing the domain |
| `--filter-mode <mode>` | (off) | Filters by `operation_mode` (zero_human, hybrid, human_in_loop) |

### `inspect-business.ts <slug>`

Detailed view of a business.

| Flag | Default | Purpose |
|---|---|---|
| `<slug>` (positional) | required | Canonical business name (not path) |
| `--show-memory` | (off) | Includes the contents of `memory/permanent.md` in the output |
| `--validate` | (off) | Runs `validate-business.ts` at the end |

### `brief-business.ts <slug> "<brief>" [options]`

Atomic dispatch of 1 brief to 1 business.

| Flag | Default | Purpose |
|---|---|---|
| `<slug>` (positional) | required | Target business |
| `"<brief>"` (positional) | required | Free text (PT-BR or EN) |
| `--project-id <id>` | auto-generated `proj-<ts>-<slug>` | Override the project_id |
| `--target-employee <name>` | (auto: `is_brief_intake: true`) | Force dispatch to a specific employee, bypassing the default intake |
| `--priority <p>` | `normal` | `low | normal | high | urgent` |

---

## 4. Manifest — `business.yaml` configurable fields

Each business has a manifest with optional fields:

| Field | Default | Purpose |
|---|---|---|
| `operation_mode` | `zero_human` | `zero_human` (autonomous), `hybrid` (escalation gates), `human_in_loop` (every decision validated with a human) |
| `authority_level` | `tier-2` | `tier-1` (board approval for changes), `tier-2` (default), `tier-3` (more permissive) |
| `runtime_requirements.minimum[]` | `[{runtime: claude-code}]` | Which runtimes are supported (claude-code, codex, antigravity-cli, gemini-cli, cursor, openclaw, opencode) |
| `features_required[]` | `[]` | Features that MUST exist in the runtime: `max_turns, tool_whitelist, subagent_spawning, audit_trail, scheduled_invocation, event_bus, hooks, sandboxing, session_memory, project_memory, global_memory, handoff_artifacts, fork_context, teammate_primitive, telemetry_otel` |
| `features_optional[]` | `[]` | Features that improve experience but do not block |
| `env_required[]` | `[]` | List of env var keys that must exist before the business can operate |
| `experimental_domains` | `false` | When `true`, accepts domains outside `CAPABILITY_CATALOG_V1.yaml` |
| `legacy.*` | `{}` | Free-form bag for migration metadata (paperclip_company_id, paperclip_data_dir, etc.) |

---

## 5. Employee frontmatter — configurable fields

Each `employees/<name>.md` has YAML frontmatter with:

| Field | Default | Purpose |
|---|---|---|
| `name` | required | Employee slug (kebab-case, 1-64 chars) |
| `role` | required | Free text ≥3 chars describing the role |
| `type` | `functional_specialist` | `functional_specialist` (generic) or `mind_clone` (embodies a public persona) |
| `description` | required, ≥20 chars | Short persona/responsibility summary |
| `maxTurns` | required, 1-200 | Turn limit for agent invocation. **Cap 200 hardcoded in the schema.** |
| `reports_to` | `null` | Slug of the manager OR `null` (CEO / root) |
| `manages[]` | `[]` | Slugs of direct reports (must match their `reports_to`) |
| `tools[]` | (none) | Subset of the v5 §10.7 whitelist. Free-form accepted. |
| `model` | (not set) | `haiku | sonnet | opus | inherit` — hint for the runtime |
| `budget_monthly_usd` | (none) | Monthly cost cap for this employee's invocations |
| `heartbeat.cadence` | `manual` | `hourly | daily | weekly | manual` (manual = only dispatched on demand) |
| `heartbeat.enabled` | `false` | Enables scheduled_invocation if the runtime supports it |
| `is_antagonist` | `false` | Marks the employee as an internal adversary (BP7 — required when `employee_count > 5`) |
| `is_brief_intake` | `false` | Receives briefs by default. **Exactly 1 per business** (validated). |
| `dna_reference` | (none) | Path to canonical mind-clone in `~/businesses/_library/dna/<category>/<name>.md` |
| `disclosure_required` | (none) | For mind-clones: forces "AI-generated persona" disclosure in the body |
| `commercial_use_allowed` | (none) | `never | review | allowed` for mind-clones |
| `self_score_contract` | required | Falsifiable criteria the employee meets on every handoff. Templates in `~/migration-tools/templates/self-score/<role>.yaml` |

---

## 6. Routing — `routing.yaml` configurables

| Field | Default | Purpose |
|---|---|---|
| `brief_intake.default_employee` | `<is_brief_intake employee>` | Who receives the brief when nothing else matches |
| `brief_intake.alternates[]` | `[]` | Conditions that route to a different intake (e.g. type=urgent → CEO) |
| `auto_routes[].pattern` | required | Pattern like `type:<x>` or substring that triggers direct dispatch |
| `auto_routes[].route_to` | required | Employee slug |
| `auto_routes[].confidence_threshold` | `0.7` | Minimum match confidence (consumed by harness Stage 0) |
| `auto_routes[].requires_escalation_to` | (none) | Approver slug — if the brief requires approval, escalate to this employee first |
| `mention_routing[]` | `[]` | Map `@<mention>` → employee |
| `ticket_intake.default_assignee` | `<is_brief_intake>` | Who receives a ticket created by another employee |
| `ticket_intake.by_type` | `{}` | Map `type` (regex) → employee for categorized tickets |

---

## 7. Org chart — `org-chart.yaml` configurables

| Field | Default | Purpose |
|---|---|---|
| `chart[].employee` | required | Slug |
| `chart[].reports[]` | required, max 1 | List of managers (always 0 or 1) |
| `chart[].direct_reports[]` | required | Direct subordinates. Bidirectional check validates against `reports[]` |
| `chart[].is_antagonist` | `false` | Marks antagonist on the chart as well (consistent with employee.is_antagonist) |
| `chart[].antagonizes[]` | `[]` | Slugs this antagonist challenges (typically C-suite peers) |
| `routing_rules.escalation_path` | `{}` | Map `<gate_id>` → employee (e.g. `price_change → human`) |
| `routing_rules.default_skip_levels` | `false` | If `true`, escalation can skip hierarchical levels |
| `routing_rules.cross_team_handoff_allowed` | `true` | If `false`, handoffs must go through the CEO |

---

## 8. How to change configuration

### Change the businesses directory path

```bash
echo 'BUSINESSES_DIR=/Volumes/external/businesses' >> ~/.env
source ~/.env
bun ~/.claude/skills/businesses/scripts/index-businesses.ts
```

### Add a new business

```bash
BUSINESSES_DIR=~/businesses bun ~/.claude/skills/businesses/scripts/init-business.ts my-new-biz --template council
bun ~/.claude/skills/businesses/scripts/validate-business.ts my-new-biz
bun ~/.claude/skills/businesses/scripts/index-businesses.ts
```


### Switch operation mode to human_in_loop

```yaml
operation_mode: human_in_loop
```

And add gates in `routing.yaml`:

```yaml
auto_routes:
  - pattern: "type:strategic_decision"
    route_to: ceo
    requires_escalation_to: human   # forces AskUserQuestion
```

---

## 9. Schema defaults and limits (non-negotiable)

These come from `~/.claude/skills/_shared/schemas/`:

| Limit | Value | Source |
|---|---|---|
| `name` regex | `^[a-z][a-z0-9-]{1,63}$` | business.schema.json |
| `description` length | 20-500 chars | business.schema.json |
| `domains[]` length | 1-10 entries | business.schema.json |
| `employee_count` | 1-100 | business.schema.json |
| `employee.maxTurns` | 1-200 | core-schemas.json#employee |
| `self_score_contract.criteria[].threshold` | 0.0-1.0 | core-schemas.json#employee |
| `self_score_contract.max_revise_iterations` | 0-5 | core-schemas.json#employee |

Schemas validated by `~/.claude/skills/_shared/validators/validators.{ts,py}` (Zod + Pydantic v2 mirrors).

---

## 10. Configuration troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `BUSINESSES_DIR is empty` | env not loaded | `source ~/.env` before running scripts |
| Registry does not find new business | Forgot to re-index | `bun scripts/index-businesses.ts` |
| Slug rejected | uppercase, space, special char | kebab-case only, no spaces |
| `BP7 violation` | >5 employees without antagonist | Add `is_antagonist: true` on one (typically a qa role) |
| `Exactly one brief_intake` | Zero or ≥2 employees with `is_brief_intake: true` | Set exactly 1 (typically CEO) |
| Domain rejected | Not in CAPABILITY_CATALOG_V1.yaml | Add to the catalog OR set `experimental_domains: true` in business.yaml |

---

## References

- **SKILL.md** — skill entry in Claude Code
- **README.md** — overview + tutorials
- **TUTORIAL.md** — step-by-step tutorial
- **BUSINESS_PROTOCOL_V1.md** — full spec (~1850 lines)
- **~/.claude/skills/_shared/CONFIGURATION.md** — central schemas + validators
- **~/.claude/skills/harness/CONFIGURATION.md** — config of the router that consumes this registry
- **~/.claude/skills/_shared/SCRIPT_CONTRACT.md** — the system-wide bash script contract (portable shebang, no stdin, structured exit codes, two-mode flags)

---

## Why there is no `memory-add.sh` shortcut

A natural request from automation agents is "give me a script that appends a fact to a business's permanent memory in one call". The Nirvana system intentionally does NOT provide one. Here's why.

### Memory is a Stage 6.5 / synthesizer-controlled artifact

`<business>/memory/permanent.md` is the long-term knowledge a business carries between projects. Every employee inside the business reads it as authoritative context. If we let any agent write to it directly via a `memory-add.sh "fact"` shortcut, two failure modes emerge:

1. **Filler poisoning.** The exact failure the Antigravity demonstrated for outputs (lorem ipsum BRAND-BIBLE, `<p>Line N>` landing) becomes possible for memory: an LLM under throughput pressure invents "facts" and pushes them into permanent storage. Future projects then consume those fabrications as ground truth, compounding the error.
2. **Cross-squad incoherence.** Memory drift becomes invisible because there's no audit trail tying each fact to a producing project, a council verdict, or an agentic auditor approval.

### The right path

Permanent memory is written ONLY by the maestro (the orchestrator that compiles final deliverables) AFTER both gates pass:

- **Gate 1 — Handoff completeness.** Every expected handoff for the project is present, validated against `HandoffArtifactSchema`, and has an authorship comment.
- **Gate 2 — Stage 6.5 audit-wave gate.** No `FILLER` verdict on any critical artifact. Run via `bash ${MAESTRO_DIR}/scripts/audit-wave.sh gate <project_id>`.

Once the synthesizer's deliverable passes both gates, it may extract durable findings and append them to `<business>/memory/permanent.md` with a citation pointing back to the project_id, the producing squad/business, and the council session that approved it.

### What an agent should do instead

If you want a fact persisted to memory:

1. Run the project end-to-end through the maestro pipeline.
2. Let the synthesizer extract memory-worthy findings.
3. Re-index: `bun ~/.claude/skills/businesses/scripts/index-businesses.ts`.

If you have a single, uncontestable fact (e.g., a config detail that doesn't need council review), edit `<business>/memory/permanent.md` directly with `Read` + `Edit`, then re-index. The lack of a shortcut is the protection — it keeps every memory write traceable to a human or to the audited synthesizer, not to a hung-up automation agent improvising under time pressure.

This is the same separation-of-duties principle that makes Stage 6.5 work: the producer is never the auditor, and the auditor is never the writer.
