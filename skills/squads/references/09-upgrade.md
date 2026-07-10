# Squad Upgrade

## When to load
Intent: UPGRADE, MIGRATE (keywords: upgrade, migrate, convert, v4)

## Protocol Reference
SQUAD_PROTOCOL_V4.md §21

## Supported Source Versions

The v4 harness accepts squads written against:

| Source version | Loaded how | Action recommended |
|---------------|-----------|-------------------|
| **v4.0** | Native | No action |
| **v3.1** | Auto-upgrade at load with warning | `squads migrate --from v3.1 --to v4` |
| **v2.0 CC flat** | Auto-upgrade via shim with warning | `squads migrate --from v2 --to v4` |
| **v2.0 legacy nested** | Legacy shim + deprecation warning | `squads migrate --from v2 --to v4` (urgent) |

## Version Detection

The validator inspects `squad.yaml` and agent files:

| Indicator | Detected version |
|-----------|-----------------|
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

1. Run `squads validate ./my-squad` — should pass cleanly.
2. Test with the target runtime: `squads run ./my-squad --runtime claude-code`.
3. Review generated `MIGRATION.md` to confirm all changes are intended.
4. Commit migrated squad.

---

## Runtime-Specific Details

Adapter-specific migration notes (per-runtime config mappings):

| Runtime | See |
|---------|-----|
| Claude Code | [adapters/claude-code.md §4](../adapters/claude-code.md#4-frontmatter-mapping) |
| Gemini CLI | [adapters/gemini-cli.md §4](../adapters/gemini-cli.md#4-frontmatter-mapping) |
| Codex | [adapters/codex.md §4](../adapters/codex.md#4-frontmatter-mapping) |
| Cursor | [adapters/cursor.md §4](../adapters/cursor.md#4-frontmatter-mapping) |
| Antigravity | [adapters/antigravity.md §4](../adapters/antigravity.md#4-frontmatter-mapping) |
