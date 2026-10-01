# squads skill: configuration reference

Everything that can be configured for squads, where, and what it does.

## 1. Where configuration lives

In order of precedence:

1. **Command flags** of the scripts below.
2. **Environment variables.**
3. **Engine settings** (`nrv config list|get|set|explain <key>`), with the origin of each value.
4. **Defaults** in `skills/_shared/lib/paths.js` and `skills/_shared/validators/limits.ts`.

The skill has no `config.yaml` of its own.

## 2. Environment variables

| Variable | Default | Effect |
|---|---|---|
| `SQUADS_DIR` | `~/squads` (under `$NIRVANA_HOME` when set) | Canonical squads directory. New squads go here and `nrv index` scans it. |
| `SQUADS_LEGACY_DIR` | `<home>/squads-legacy-v4` | Extra directory scanned by the indexer. On a slug collision `${SQUADS_DIR}` wins. |
| `SQUADS_REGISTRY_PATH` | project `.squads-registry.json`, else `~/.squads-registry.json` | Where the registry is written (`SQUAD_PROTOCOL_V6.md` §23). |
| `NIRVANA_PROJECT_ROOT`, `SQUADS_PROJECT_ROOT` | nearest declared project | Project root used for standalone run output `.squads-outputs/` (§16bis). |
| `NIRVANA_SCOPE` | `global` | `global`, `project` or `merge`, read from `<project>/.env`; decides which squads `list-squads` and the indexer see. |
| `NIRVANA_LIMIT_<KEY>` | none | Overrides a payload limit (section 5). |

## 3. Commands and flags

### `nrv validate squad`

The admission gate (`SQUAD_PROTOCOL_V6.md` §34).

| Flag | Effect |
|---|---|
| `<slug\|path>` or `--all` | One squad, or the whole library |
| `--fix` | Mechanical repairs, with backup and rollback |
| `--fix=agentic` with `--yes` | Then an agent repairs what only meaning can fix |
| `--strict` | Warnings reject too |
| `--json` | Machine-readable report (`--all --json` gives `nirvana.verify-batch/v1`) |
| `--no-retrieval` | Skip retrieval checks |
| `--baseline <file>` | Use a debt baseline |
| `--record [--allow-regression]` | With `--all`, record the current debt |
| `--root <dir>` | With `--all`, the library root |

### `nrv migrate`

`<slug|path> --to 6 [--apply] [--map-refs] [--no-extract-tasks] [--no-derive-acceptance] [--force] [--json]`, `<slug|path> --rollback <ts>`, and `squad --all --to 6 [--root <dir>]`. Dry run unless `--apply` (§35).

### `nrv index` and `nrv list-squads`

`nrv index` rebuilds the registry (`index-squads.ts` takes `--json` to print the scan and `--quiet`). `nrv list-squads` takes `--format compact|table|json`, `--short` and `--show-scope`.

### Other squad commands

| Command | Effect |
|---|---|
| `nrv activate <slug>` or `--all` | Installs what `dependencies.yaml` declares. Flags: `--dry-run`, `--confirm-heavy`, `--only-declared`, `--verbose`, `--skip-verify` |
| `nrv fix-squad <slug\|path> [--apply]` | Writes `SQUAD-DOCTOR-REPORT.md`; `--apply` applies the safe fixes |
| `nrv find "<brief>"` | Dry-run discovery: signal, capability, squad, score |
| `nrv cards squad <slug>` | The work card a business reads to use a squad (§32.3) |
| `nrv dispatch --squad <slug>[:<capabilityId>] "<brief>"` | Dispatches one squad on its own; add `--exec` (or use `nrv run --squad`) to execute (§32.2) |

### `init-squad.ts`

Scaffold a v6 squad from `templates/`. It is a script, not an `nrv` subcommand, and runs the create gate afterwards.

```bash
bun ~/.nirvana/skills/squads/scripts/init-squad.ts <target-dir> [--name N] [--description D] [--author A] [--prefix P] \
  [--capability-id ID] [--capability-description D] [--capability-domains "a,b"] [--workflow-ref NAME] \
  [--example "intent"] [--force] [--skip-verify]
```

Each value also has an environment variable (`SQUAD_NAME`, `SQUAD_DESCRIPTION`, `SQUAD_CAPABILITY_ID`, `SQUAD_WORKFLOW_REF`, and others). Without `--force` it refuses to overwrite an existing `squad.yaml`.

## 4. Manifest fields

The manifest is defined by `SQUAD_PROTOCOL_V6.md` §5.1 and §22; the generated schemas are `skills/_shared/schemas/{squad,capability,workflow}.schema.json`. The settings that change how a squad runs:

| Field | Effect |
|---|---|
| `protocol` | `"6.0"` for new squads; `4.0`, `4.1`, `5.0` still load |
| `runtime_requirements.policy` | `active` (default): run on the session's runtime. `declared`: restrict to `minimum` plus `compatible`, and `minimum` is required |
| `runtime_requirements.incompatible[]` | Hard denial under either policy |
| `features_required[]` | Closed enum (App-B); the load fails when the runtime lacks one |
| `experimental_domains` | Allows domains outside `CAPABILITY_CATALOG_V1.yaml` |
| `capabilities[].score_boost` | 0 to 2, default 1; multiplies the discovery score |
| `model_hint` (per capability) | `haiku`, `sonnet`, `opus`, `fable` or `inherit` (default: the user's runtime model) |
| `capabilities[].fidelity.status` | `validated`, `experimental`, `drifted`, `retired`; also scales the score |
| `capabilities[].acceptance[]` | What the judge charges (§29); at most 12 |

Runtimes accepted in `runtime_requirements`: `claude-code`, `codex`, `antigravity-cli`, `antigravity`, `gemini-cli`, `pi`, `kimi-cli`, `grok-cli`, `qwen-code`, `opencode`, `cursor`, `openclaw`.

## 5. Settings and limits

| Setting or limit | Default | Effect |
|---|---|---|
| `routing.mode` | `agentic` | `agentic`, `cards` or `fast` (BM25) matcher |
| `routing.dense` | `off` | `fallback` consults dense retrieval only when BM25 finds nothing (`nrv embeddings enable`) |
| `gauntlet.requirements_source` | `brief` | `capability` makes the judge charge `acceptance[]` (§29.3) |
| `gauntlet.evaluator` | automatic | Pin the evaluator, `squad:<slug>[:<cap>]` (§30.3) |
| `capability_description_max` | 1500 | Capability description ceiling (200 to 5000) |
| `capability_keywords_max`, `capability_example_briefs_max`, `capability_produces_max` | 60, 20, 40 | Routing metadata ceilings |
| `squad_capabilities_max` | 50 | Capabilities per squad |
| `workflow_body_words_max` | 2500 | Workflow body ceiling, a warning (§28.2) |
| `squad_prompt_components_bytes_max` | 65536 | Target for agent and task bytes in a dispatch prompt; a note when crossed, never a cut (§32.2) |

Limits cascade: `NIRVANA_LIMIT_<KEY>` env, then `.nirvana-limits.yaml` in the project, then `~/.claude/nirvana-limits.yaml`, then the defaults.

## 6. Common changes

**Move the squads directory.** Set `SQUADS_DIR=/path/to/squads` in the environment, then `nrv index`.

**Add a capability.** Append to `capabilities[]` in `squad.yaml` (`templates/capability-block.tmpl`), then `nrv validate squad <slug>`, `nrv index` and the self-retrieval gate (`bun ~/.nirvana/skills/_shared/scripts/self-retrieval-gate.ts <slug>`).

**Raise a squad's discovery priority.** Set `score_boost` above 1 on the capability. Prefer sharper `description`, `keywords` and `example_briefs`, which is what the matchers read.

## 7. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `manifest_schema` on a capability id | Fewer than 3 dotted segments | Use `domain.subject.verb`, such as `marketing.funnel.create` |
| Domain warning | Not in the catalog | Use a catalog domain or set `experimental_domains: true` |
| `outputs[].type` rejected | Only `file`, `string`, `json`, `array`, `markdown`, `html`, `binary` are accepted | Use `string` and describe the format |
| `not_for_too_long` | Entry over 25 characters | Two to four content words, no `(use X)` suffix (§33) |
| `invoke_ref_extension` | `invoke.ref` ends in `.md` or `.yaml` | Drop the extension (§28.6), or `--fix` |
| Squad missing from `nrv list-squads` | Registry stale or wrong scope | `nrv index`; check `NIRVANA_SCOPE` and `SQUADS_DIR` |
| Router does not pick the squad | Thin description or few examples | Complete the routing metadata (§22.4), run the self-retrieval gate |

## References

`SKILL.md`, `README.md`, `TUTORIAL.md`, `SQUAD_PROTOCOL_V6.md`, `skills/_shared/catalogs/CAPABILITY_CATALOG_V1.yaml`, and `nrv config explain <key>` for engine settings.
