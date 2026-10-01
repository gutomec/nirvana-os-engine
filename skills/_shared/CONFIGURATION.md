# _shared · Configuration Reference

> Everything that can be configured in the central pieces (schemas, validators, catalog, adapters).
> Last updated: 2026-05-03.

---

## 1. What lives here

`~/.nirvana/skills/_shared/` is where the 3 skills (businesses, squads, harness) **import** schemas, validators and the catalog from. **It is not executable on its own**: it is always consumed by other skills.

```
catalogs/CAPABILITY_CATALOG_V1.yaml      ← canonical vocabulary (57 domains)
schemas/business.schema.json             ← business manifest
schemas/capability.schema.json           ← squad capability
schemas/core-schemas.json                ← bundle: employee, org_chart, routing, etc.
schemas/dna.schema.json                  ← mind-clone DNA file
validators/validators.ts                 ← Zod (TypeScript)
validators/validators.py                 ← Pydantic v2 (Python)
adapters/<runtime>.md                    ← one doc per runtime (+ README.md matrix)
```

The relevant configuration here is static (governance + versioning), not env vars.

---

## 2. Capability Catalog: `catalogs/CAPABILITY_CATALOG_V1.yaml`

Source of truth for the controlled vocabulary.

### Structure

```yaml
version: "1.0.0"
protocol_compatibility:
  squad: "5.0"
  business: "1.0"
  harness: "1.0"
generated_at: "2026-05-02"
status: stable

domains:
  - id: marketing
    description: "..."
  - id: branding
    description: "..."
  # ... 57 entries in 6 categories

namespaces:
  - prefix: marketing
    parent_domain: marketing
    sample_capabilities: [marketing.campaign.full_funnel, ...]
  # ...

reserved_prefixes: []
deprecated: []
validation_rules:
  ...
governance:
  additions: "PR review by protocol authors"
  removals: "deprecation cycle of one minor version"
```

### Current domains (57)

**Marketing & Sales (10):** marketing, sales, branding, copy, growth, performance, ads, retention, lifecycle, crm

**Content & Media (8):** content, media, video, audio, image, social_media, podcasting, journalism

**Engineering & Tech (11):** software_engineering, frontend, backend, mobile, data_engineering, devops, security, infrastructure, ai_engineering, qa, observability

**Business & Strategy (10):** strategy, business_operations, finance, accounting, legal, compliance, hr, recruiting, consulting, analytics

**Vertical (12):** healthcare, education, real_estate, fintech, crypto, gaming, ecommerce, hospitality, energy, agriculture, government, foodtech

**Cross-cutting (6):** research, knowledge_management, document_processing, automation, integration, **multi_agent_orchestration** (added 2026-05-02)

### How to add a new domain

1. Edit `catalogs/CAPABILITY_CATALOG_V1.yaml`
2. Put it in the right category (Marketing/Content/Engineering/Business/Vertical/Cross-cutting)
3. Update the count in the category's comment header
4. If it needs a new namespace, add it in `namespaces[]`
5. Squads/businesses now accept the domain without `experimental_domains: true`

### How to deprecate a domain

1. Mark it in `deprecated[]` with `from_version` and `replacement`
2. Schemas keep accepting it for 1 minor version
3. `validate-squad.ts` emits a warning when a squad uses a deprecated domain

---

## 3. Schemas (JSON Schema 2020-12)

Schemas control what is accepted in manifests, frontmatters, and runtime payloads.

### `business.schema.json`

| Field | Required | Constraint |
|---|---|---|
| `name` | ✅ | regex `^[a-z][a-z0-9-]{1,63}$` |
| `version` | ✅ | semver |
| `protocol` | ✅ | enum: `"1.0"` |
| `description` | ✅ | 20-500 chars |
| `domains` | ✅ | 1-50 entries, each matching `^[a-z][a-z0-9_]*$` |
| `employee_count` | optional | 1-100 |
| `authority_level` | optional | enum: `tier-1, tier-2, tier-3` (default `tier-2`) |
| `operation_mode` | ✅ | enum: `zero_human, hybrid, human_in_loop` (default `zero_human`) |
| `runtime_requirements.minimum[]` | ✅ | min 1 entry |
| `legacy.*` | optional | `additionalProperties: true` (free-form) |
| `experimental_domains` | optional | boolean (default `false`) |

### `capability.schema.json`

| Field | Required | Constraint |
|---|---|---|
| `id` | ✅ | regex `^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){2,}$` (≥3 segments) |
| `description` | ✅ | 20-500 chars |
| `domains[]` | ✅ | 1-5 entries |
| `inputs[]` | optional | `{name, type, formats, schema, required, description}` |
| `outputs[]` | optional | type enum: `file, string, json, array, markdown, html, binary` |
| `tools_required[]` | optional | array of strings |
| `invoke.type` | ✅ | enum: `workflow, task, agent` |
| `invoke.ref` | ✅ | string |
| `examples[]` | ✅ | min 1, each ≥5 chars |
| `produces[]` | optional | kebab-case deliverable slugs (≥1, ≤20); primary signal for agentic discovery |
| `example_briefs[]` | optional | real PT/EN briefs (≤10, each 20-500 chars) |
| `keywords[]` | optional | PT/EN synonyms (≤30, each 2-60 chars) |
| `not_for[]` | optional | array of strings |
| `fidelity` | optional | `{status: validated\|experimental\|drifted\|retired, ground_truth_dir?, eval_results?, threshold?}` |
| `score_boost` | optional | number (default 1.0) |
| `model_hint` | optional | enum: `haiku, sonnet, opus, inherit` |
| `estimated_cost_usd` | optional | number ≥0 |
| `parallel_safe` | optional | boolean (default `false`); Phase 5: safe concurrency in the DAG |
| `writes_paths[]` | optional | paths the capability writes (consumed by the race-detector) |

### `core-schemas.json#/definitions/employee`

The seat (employee) frontmatter is validated by `EmployeeFrontmatterSchema` (strict: an unknown key is an error). The complete field table, the retired fields (`self_score_contract`, `heartbeat`, `budget_monthly_usd`, `dna_reference`, ...) and how the solo run uses each one are in `skills/businesses/BUSINESS_PROTOCOL_V2.md` §7.2. Only `name`, `role` and `description` are required.

### `core-schemas.json#/definitions/handoff_artifact`

Retired. A business runs as one solo agent (`skills/harness/lib/business-solo.ts`), so no handoff between seats exists at runtime and nothing reads this schema. It stays in the bundle only so old manifests still load.

### `dna.schema.json`

Mind-clone frontmatter:

| Field | Required |
|---|---|
| `name` | ✅ |
| `description` | ✅ |
| `model` | ✅ |
| `maxTurns` | ✅ (1-200) |
| `tools[]` | ✅ |

The body must have 10 numbered top-level sections (`## 1. ...` through `## 10. ...`). Validated by `validators.py#validate_dna_file()`.

---

## 4. Validators: `validators.{ts,py}`

### TypeScript / Zod (`validators.ts`)

Exports:

| Schema | Purpose |
|---|---|
| `CapabilitySchema` | Validates a capability inside squad.yaml |
| `SquadManifestSchema` | Validates squad.yaml |
| `EmployeeFrontmatterSchema` | Validates the `<biz>/employees/<name>.md` frontmatter |
| `BusinessManifestSchema` | Validates business.yaml |
| `OrgChartSchema` | Validates org-chart.yaml |
| `RoutingSchema` | Validates routing.yaml |
| `TicketSchema, MentionSchema, HandoffArtifactSchema, ApprovalChainSchema` | Retired runtime primitives, kept so old files load |
| `RegistrySquadsSchema, RegistryBusinessesSchema` | Validate generated registries |
| `AuditEventSchema` | Validates audit jsonl entries |
| `HarnessConfigSchema, HarnessNotificationSchema` | Harness-specific |
| `validateBusinessIntegrity({manifest, employees, org_chart})` | Cross-artifact: BP7 + unique intake + org chart with no cycles + bidirectional |

Smoke: `bun ~/.nirvana/skills/_shared/validators/validators.ts test`

### Python / Pydantic v2 (`validators.py`)

Mirror of the TS:

| Class | Purpose |
|---|---|
| `BusinessManifest` | Mirror of BusinessManifestSchema |
| `Employee` | Mirror of EmployeeFrontmatterSchema |
| `OrgChart` | Mirror of OrgChartSchema |
| `Routing` | Mirror of RoutingSchema |
| `HandoffArtifact` | Mirror of the retired schema |
| `AuditEvent` | Mirror |
| `validate_dna_file(path)` | Frontmatter + 10 numbered sections |

Test: `cd ~/.nirvana/skills/_shared/validators && python3 -m pytest validators.py`.

### How to change a validator

1. Edit both validators.ts AND validators.py at the same time (TS = UX source, PY = runtime enforcement source)
2. Run both test suites to detect drift
3. Update the corresponding JSON schema in `schemas/` if the shape changed
4. Document in `~/.nirvana/skills/_shared/README.md#schemas`

---

## 5. Adapters: runtime-neutral specs

`adapters/<runtime>.md` describes how each runtime maps to the protocol, and `adapters/README.md` has the comparative matrix. The engine drives a runtime through `lib/host-agent-driver.ts` (`runHeadless`), so a runtime is usable when it can:

1. Run one prompt headless and exit (prompt by stdin, prompt file or argv).
2. Resume a session by id (`sessionId`).
3. Restrict tools (`allowedTools`, or none) and add extra directories (`addDirs`).
4. Append a system prompt (`appendSystemPrompt`).
5. Report cost and the final text in a parseable output.
6. Honor a context ceiling (`execution.context_window`) by compacting.
7. Discover skills (`nrv install` links the Nirvana tree where the runtime reads them).

Use the docs when implementing a new adapter or checking what a runtime supports.

---

## 6. Environment variables that affect _shared

There are no env vars exclusive to `_shared`. But these paths are read by validators and schemas:

| Variable | Default | Purpose |
|---|---|---|
| `HOME` | (auto) | Used to resolve absolute paths in validators |

Everything else is hardcoded by design: central schemas must not vary between machines.

---

## 7. How to contribute changes

### Add a new schema

1. Edit `core-schemas.json` adding definition `<name>`
2. Mirror it in Zod (`validators.ts`) with strict mode (`.strict()`)
3. Mirror it in Pydantic (`validators.py`) with `model_config = ConfigDict(extra='forbid')`
4. Add positive + strict-mode-rejection tests
5. Run smoke + pytest:
   ```bash
   cd ~/.nirvana/skills/_shared/validators
   bun validators.ts test
   python3 -m pytest validators.py
   ```

### Add a new runtime adapter

1. Add the adapter in `lib/host-agent-driver.ts` (the capabilities in §5)
2. Copy `adapters/claude-code.md` as the template and document the native primitives
3. Add a row to `adapters/README.md` (feature matrix)
4. Add `<runtime>` to the `Runtime` enum in both validators

### Add a domain to the catalog

See §2 above.

---

## 8. Versioning policy

| Asset | Versioning |
|---|---|
| `CAPABILITY_CATALOG_V1.yaml` | Semver: additions = minor, removals = major |
| Schemas | Implicit in the `protocol` field (squad: `"5.0"`, business: `"1.0"`, harness: `"1.0"`) |
| Validators | Must support ALL live protocol versions the validators accept |
| Adapters | Independent: versioned per file |

---

## 9. Test coverage

| Suite | Command | Status |
|---|---|---|
| TS smoke | `bun validators.ts test` | Prints OK per schema |
| Python pytest | `python3 -m pytest validators.py` | All pass |
| Drift detection | Both running | Manual: no CI yet |

---

## 10. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| The TS validator accepts, Python rejects (or vice versa) | Drift between the two | Review the diff, align them |
| `Domain X not in catalog` warning | Domain missing | Add it to `CAPABILITY_CATALOG_V1.yaml` or use `experimental_domains: true` |
| `Capability id pattern violation` | <3 dotted segments | Fix the id |
| `Extra inputs not permitted` | Strict schema, extra field | Remove it OR move it to `legacy.*` (which accepts extras) |

---

## Configurable limits (`limits.py` / `limits.ts`)

> Added 2026-05-15. Allows overriding the size/count limits of the validators
> without editing code.

### Why

Several fields had hard-coded limits (`description` 500 chars,
`produces` 30 items, `keywords` 40 items, etc.). With 1M-token window
models and multi-dimensional businesses, some limits got tight. Now they are
configurable, but **with judgment**: not everything should grow.

### Files

| File | Purpose |
|---|---|
| `validators/limits.py` | Cascade loader (Python): exports `LIMITS` |
| `validators/limits.ts` | Cascade loader (TypeScript): exports `LIMITS` |
| `~/.claude/nirvana-limits.yaml` | User-level override (optional) |
| `<project>/.nirvana-limits.yaml` | Project-level override (optional) |

`validators.py` and `validators.ts` import `LIMITS` and use it in the
`StringConstraints` / `z.string().max()`.

### Precedence cascade (highest wins)

```
1. NIRVANA_LIMIT_<KEY>  env var
2. <project>/.nirvana-limits.yaml      (found by walking up from cwd to the root)
3. ~/.claude/nirvana-limits.yaml       (user level)
4. DEFAULTS                            (historical hard-coded values)
```

**Backward-compatible**: with no `.yaml` and no env var, `LIMITS == DEFAULTS`
== behavior identical to before.

### Safety bounds

Every key has `(floor, ceiling)` in `SAFETY_BOUNDS`. Absurd values are
**clamped** with a warning on stderr: it is not possible, for example, to set
`business_description_max=10` (it would break existing entities) nor
`employee_max_turns_max=99999` (runaway).

### Limit buckets

| Bucket | Policy | Examples |
|---|---|---|
| **A: PAYLOAD SIZE** | Configurable, low risk | description, example_briefs, keywords, produces |
| **B: EXECUTION CONTROL** | Configurable, loose defaults | max_turns, max_tokens, max_cost, max_duration |
| **C: FEATURE LIMITS** | **NOT** exposed: the limit is a design feature | orgchart.reports (1), domains |

### Available keys

The keys, their defaults and their `[floor, ceiling]` bounds are the `DEFAULTS` and `SAFETY_BOUNDS` tables in `validators/limits.ts` (mirrored in `limits.py`). Read them there or with the commands below; this file does not copy the numbers.

### Inspect the effective limits

```bash
python3 ~/.nirvana/skills/_shared/validators/limits.py    # Python table
bun     ~/.nirvana/skills/_shared/validators/limits.ts    # TS table
NIRVANA_LIMITS_DEBUG=1 python3 -c "import limits"         # with the source of each value
```

### Where the JSON Schema lags behind

The `schemas/*.json` files still carry the **old defaults**
(external tools that validate by JSON Schema do not know env vars).
`validators.py`/`.ts` take precedence in the real Nirvana runtime. If
you use an external JSON Schema validator, it will be stricter:
that is safe (it rejects more, never less).

---

## References

- **README.md**: overview of _shared + sample usage
- **CAPABILITY_CATALOG_V1.yaml**: canonical vocabulary
- **schemas/{business,capability,core-schemas,dna}.schema.json**
- **validators/{validators.ts, validators.py, limits.ts, limits.py}**
- **~/.claude/nirvana-limits.yaml**: user-level limits override
- **adapters/{claude-code,codex,gemini-cli}.md** + `adapters/README.md`
- **~/.nirvana/skills/businesses/CONFIGURATION.md**: downstream consumer
- **~/.nirvana/skills/squads/CONFIGURATION.md**: downstream consumer
