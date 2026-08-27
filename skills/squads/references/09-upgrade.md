# Squad Upgrade

## When to load
Intent: UPGRADE, MIGRATE (keywords: upgrade, migrate, convert, v4)

## Protocol Reference
SQUAD_PROTOCOL_V6.md §35 (v5 → v6) · SQUAD_PROTOCOL_V4.md §21 (everything older)

## v5 → v6: one command

```bash
nrv migrate <slug|path> --to 6            # dry run — writes nothing
nrv migrate <slug|path> --to 6 --apply    # converts, with a backup
nrv validate squad <slug>                 # the admission gate on the result
nrv migrate <slug|path> --rollback <ts>   # undo, when the squad has not changed since
```

What changes in the squad:

| v5 | v6 |
|----|----|
| `workflows/<name>.yaml`, in one of eight graph dialects | `workflows/<name>.md` — frontmatter graph, prose body (§28.1) |
| `steps[].depends_on` / `deps` / `after` | `steps[].requires` |
| a prompt inline in `task: \|` or `action:` | `tasks/<workflow>-<step>.md` when it is a real prompt, the body under `## <step.id>` when it is a note |
| `invoke.ref: workflows/main.yaml` | `invoke.ref: workflows/main` (§28.6) |
| `components.workflows: [main.yaml]` | `components.workflows: [main]` |
| `success_indicators` nobody read | `capabilities[].acceptance[]`, derived with `blocking: false` (§29) |
| `not_for: ["long refusal sentence (use other-squad)"]` | `not_for: ["short refusal"]` — 25 chars max (§33) |
| `protocol: "5.0"` | `protocol: "6.0"` |

What it refuses to convert, and why: `event_routes` (a router, not a DAG), a
document from which no step can be derived, and a file whose stem is not
`^[a-z][a-z0-9_-]*$`. Without `--force` the squad is refused whole and nothing
is written; with `--force` that one document is left alone and the rest
migrates. **The migration never invents prose** — every sentence in a converted
body already existed in the source.

Three populations, three procedures (§35.5): never migrate an installed pack
copy (migrate the pack source and let `nrv update` deliver it); unify an
authored squad with its pack copies via `unify-squad.ts <slug> --authored
<local>` BEFORE migrating, because `check-copy-drift --strict` compares the
`squad.yaml` md5 across copies; migrate an orphan in place.

Reading `.yaml` is permanent. A v5 squad nobody migrates keeps loading, keeps
routing and keeps validating exactly as it does today.

## Supported Source Versions

The v4 harness accepts squads written against:

| Source version | Loaded how | Action recommended |
|---------------|-----------|-------------------|
| **v6.0** | Native | No action |
| **v5.0** | Native | `nrv migrate <slug> --to 6 --apply` (optional; v5 stays valid) |
| **v4.0** | Native, treated as declaring no capabilities | `nrv migrate <slug> --to 6 --apply` after adding `capabilities[]` |
| **v3.1** | Auto-upgrade at load with warning | `squads migrate --from v3.1 --to v4` |
| **v2.0 CC flat** | Auto-upgrade via shim with warning | `squads migrate --from v2 --to v4` |
| **v2.0 legacy nested** | Legacy shim + deprecation warning | `squads migrate --from v2 --to v4` (urgent) |

## Version Detection

The validator inspects `squad.yaml` and agent files:

| Indicator | Detected version |
|-----------|-----------------|
| `protocol: "6.0"` in manifest | v6.0 native |
| `protocol: "5.0"` in manifest | v5.0 native |
| `protocol: "4.0"` in manifest | v4.0 native |
| `protocol` absent, all agents have `maxTurns` mandatory | v3.1 |
| `protocol` absent, flat `name:`+`description:` in agents | v2.0 CC flat |
| Nested `agent:` / `persona:` blocks in agents | v2.0 legacy nested |

## v2.0 → v4.0 Migration

### Manifest Changes

| v2.0 | v4.0 |
|------|------|
| (no `protocol` field) | `protocol: "4.0"` |
| (implicit runtime) | `runtime_requirements.minimum: [claude-code]` |
| (no feature declarations) | `features_required`, `features_optional` |
| `harness.*` (v3+) | `runtimes.{id}.*` (runtime-specific) |
| `agents_metadata:` (top-level) | `ui.agents_metadata:` (under `ui:`) |
| `components.agents: [{id, file}]` | `components.agents: ["agents/x.md"]` (simplified) |

### Agent Changes

| v2.0 legacy nested | v4.0 flat |
|-------------------|-----------|
| `agent.name`, `agent.id` | `name` |
| `agent.whenToUse` | `description` |
| `persona.role`, `persona.style`, `persona.identity` | Body prose |
| `persona.core_principles` | Body `## Guidelines` section |
| `commands:` | Body `## Process` section |
| (maxTurns optional) | **`maxTurns` required** |

**v2.0 CC flat → v4.0:** mostly unchanged; add `maxTurns` where missing, move CC-specific fields into `runtimes.claude-code.*`.

### Task Changes

| v2.0 | v4.0 |
|------|------|
| `task.name`, `task.responsavel` | `name` only |
| `task.owner` | Remove (workflow binds agent) |
| `steps:`, `inputs:`, `outputs:` in YAML | Prose in body |

## v3.1 → v4.0 Migration

v3.1 already has mandatory `maxTurns` and flat frontmatter. Main changes:

1. Add `protocol: "4.0"` to manifest.
2. Add `runtime_requirements` block (most v3.1 squads target `claude-code`).
3. Move runtime-specific numeric values (compaction buffers, SRC citations) from root into `runtimes.claude-code.*` or move them entirely out of the squad (they belong to the adapter, not the squad).
4. Remove body-level references to `AUTOCOMPACT_BUFFER_TOKENS`, `claudemd.ts`, etc. — these are adapter concerns, not squad concerns.

## Auto-Upgrade Shim (at load)

The v4 harness applies these transformations in memory when loading non-v4 squads:

1. **Inject `protocol: "4.0"`** (if missing).
2. **Assume `claude-code`** as the target runtime if not declared.
3. **Wrap flat CC frontmatter** under `runtimes.claude-code.*` where appropriate.
4. **Inject default `maxTurns: 25`** for agents missing it, emit WARNING per agent.
5. **Move `agents_metadata` → `ui.agents_metadata`**.
6. **Detect legacy nested format** and parse via `agent:`/`persona:` shim.

The shim is **in-memory only**. Use `squads migrate` to persist.

## Persistent Migration

```bash
squads migrate --from v2 --to v4 ./my-squad
squads migrate --from v3.1 --to v4 ./my-squad
```

The migration tool:
- Rewrites `squad.yaml` with explicit `protocol` and `runtime_requirements`.
- Moves runtime-specific fields into `runtimes.{id}.*` namespaces.
- Injects mandatory `maxTurns` where missing.
- Renames `harness.*` → adapter-specific namespaces.
- Writes a `MIGRATION.md` log of all changes.
- Validates the result.

## Deprecation Timeline

| v4 version | v2 flat | v2 nested | v3.1 | v4.0 |
|-----------|---------|-----------|------|------|
| 4.0 (current) | accepted | accepted (warn) | accepted | native |
| 4.1 (planned) | accepted | accepted (stronger warn) | accepted | native |
| 5.0 (planned) | accepted via shim | **removed** | accepted via shim | native |

## After Migration

1. Run `nrv validate squad ./my-squad` — zero errors, or `--fix` and re-run.
2. Re-index so routing sees the new text: `nrv index`.
3. Review the migration report (`<state>/squads/<slug>/migrate-<ts>.json`) to
   confirm every change was intended; `nrv migrate <slug> --rollback <ts>` puts
   it back while the squad is untouched.
4. Commit the migrated squad.

---

## Runtime-Specific Details

Adapter-specific migration notes (per-runtime config mappings):

| Runtime | See |
|---------|-----|
| Claude Code | [_shared/adapters/claude-code.md §4](../../_shared/adapters/claude-code.md#4-frontmatter-mapping) |
| Gemini CLI | [_shared/adapters/gemini-cli.md §4](../../_shared/adapters/gemini-cli.md#4-frontmatter-mapping) |
| Codex | [_shared/adapters/codex.md §4](../../_shared/adapters/codex.md#4-frontmatter-mapping) |
| Antigravity | [_shared/adapters/antigravity-cli.md §4](../../_shared/adapters/antigravity-cli.md#4-frontmatter-mapping) |
| Kimi | [_shared/adapters/kimi-cli.md §4](../../_shared/adapters/kimi-cli.md#4-frontmatter-mapping) |
| Grok | [_shared/adapters/grok-cli.md §4](../../_shared/adapters/grok-cli.md#4-frontmatter-mapping) |
| Pi | [_shared/adapters/pi.md §4](../../_shared/adapters/pi.md#4-frontmatter-mapping) |
