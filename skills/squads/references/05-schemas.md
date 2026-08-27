# Schema Reference

## When to load
Intent: CREATE, VALIDATE, MODIFY

## Protocol Reference
SQUAD_PROTOCOL_V4.md §5.1, §6.2, §7.1 · SQUAD_PROTOCOL_V6.md §28.1, App-G

## Schemas Available

**The validator that runs is Zod**, in `~/.nirvana/skills/_shared/validators/validators.ts`.
The JSON Schemas below are GENERATED from it by `bun scripts/gen-json-schemas.ts`
(`--check` runs in `check:all`), so a divergence between the JSON and the Zod
schema cannot survive a build. Never edit them by hand.

| Schema | Validates | Path |
|--------|-----------|------|
| `squad.schema.json` | `squad.yaml` manifest | `_shared/schemas/squad.schema.json` |
| `capability.schema.json` | one entry of `capabilities[]` | `_shared/schemas/capability.schema.json` |
| `workflow.schema.json` | the canonical workflow graph (§28.1) | `_shared/schemas/workflow.schema.json` |

The per-squad `schemas/*.json` mirrors (`squad-schema.json`, `agent-schema.json`,
`task-schema.json`, `adapter-schema.json`, `handoff-schema.json`) were removed in
v6: they described a v4 manifest nobody authored any more, and no code path read
them. What replaced each of them:

| Was | Now |
|-----|-----|
| `agent-schema.json` | `nrv validate squad` criterion `agent_frontmatter_incomplete` (frontmatter with `maxTurns` and `tools`) |
| `task-schema.json` | `nrv validate squad` criterion `task_acceptance_missing` (`## Acceptance Criteria` or `outputs:`) |
| `adapter-schema.json` | `skills/squads/lib/adapter-loader.js`, the loader that actually reads `adapters/{runtime}.yaml` |
| `handoff-schema.json` | `HandoffArtifactSchema` in `validators.ts` |

## Two Frontmatter Formats (Both Accepted)

### v4 Flat Format (preferred for new squads)

**Agent required fields:**
- `name` (string, kebab-case)
- `description` (string, the selection criterion)
- `maxTurns` (integer, **mandatory**)

**Agent optional fields:**
- `tools` (array of portable semantic tool names)
- `model` (family hint: `haiku` | `sonnet` | `opus`)
- `effort` (`low` | `medium` | `high`)
- `version` (semver)
- `memory` (scope)
- `isolation` (`worktree` | `branch` | `none`)
- `permissionMode`
- `runtimes.{id}` (runtime-specific namespace)

**Task required fields:**
- `name` (string, kebab-case)

**Task optional fields:**
- `description` (string)
- `allowed-tools` (array)
- `context` (`fork` | `inline`)

### Legacy v2 Format (backward compatible)

**Agent required fields:**
- `agent.name` (string)
- `agent.id` (string, kebab-case)

**Agent optional fields (nested):**
- `persona.role`, `persona.style`, `persona.identity`, `persona.focus`, `persona.core_principles`
- `commands`, `activation-instructions`, `dependencies`, etc.

**Task required fields:**
- `task.name` or `task` (string)
- `owner` / `responsavel` (string, must match agent name)

## Squad Manifest Schema (v4)

**Required:**
- `name` (kebab-case, 2–50 chars)
- `version` (semver)
- `protocol` (recommended: `"4.0"`)

**Components block:**
- `components.agents`: array of string paths (v4) or legacy objects with `id`/`file`
- `components.tasks`: same, both formats
- `components.workflows`: same, both formats

**Runtime compatibility (v4):**
- `runtime_requirements.minimum` (array of `{runtime, version}`)
- `runtime_requirements.compatible` (optional)
- `runtime_requirements.incompatible` (optional)
- `features_required` (array of canonical feature names)
- `features_optional` (array of canonical feature names)
- `runtimes.{id}` (runtime-specific config namespace)

**Optional v4 fields:**
- `contracts` (inter-task schema map)
- `memory` (persistent memory + GC policy)
- `ui` (marketplace metadata)
- `capabilities` (required/forbidden capability declarations)
- `execution` (sandbox, filesystem, network constraints)

## Validation Commands

```bash
nrv validate squad ./my-squad           # the admission gate
nrv validate squad ./my-squad --json    # nirvana.verify-report/v1
nrv validate squad ./my-squad --fix     # apply the mechanical repairs (backup + rollback)
nrv validate squad ./my-squad --strict  # warnings reject too (exit 2)
```

---

## Runtime-Specific Details

Each adapter may add runtime-specific schema fields under its namespace:

| Runtime | See |
|---------|-----|
| Claude Code | [_shared/adapters/claude-code.md §4](../../_shared/adapters/claude-code.md#4-frontmatter-mapping) |
| Gemini CLI | [_shared/adapters/gemini-cli.md §4](../../_shared/adapters/gemini-cli.md#4-frontmatter-mapping) |
| Codex | [_shared/adapters/codex.md §4](../../_shared/adapters/codex.md#4-frontmatter-mapping) |
| Antigravity | [_shared/adapters/antigravity-cli.md §4](../../_shared/adapters/antigravity-cli.md#4-frontmatter-mapping) |
| Kimi | [_shared/adapters/kimi-cli.md §4](../../_shared/adapters/kimi-cli.md#4-frontmatter-mapping) |
| Grok | [_shared/adapters/grok-cli.md §4](../../_shared/adapters/grok-cli.md#4-frontmatter-mapping) |
| Pi | [_shared/adapters/pi.md §4](../../_shared/adapters/pi.md#4-frontmatter-mapping) |
