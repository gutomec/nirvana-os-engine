# Schema Reference

## When to load
Intent: CREATE, VALIDATE, MODIFY

## Protocol Reference
SQUAD_PROTOCOL_V4.md §5.1, §6.2, §7.1

## Schemas Available

| Schema | Validates | Path |
|--------|-----------|------|
| `squad-schema.json` | `squad.yaml` manifest | `schemas/squad-schema.json` |
| `agent-schema.json` | Agent frontmatter | `schemas/agent-schema.json` |
| `task-schema.json` | Task frontmatter | `schemas/task-schema.json` |
| `adapter-schema.json` | `adapters/{runtime}.yaml` | `schemas/adapter-schema.json` |
| `handoff-schema.json` | Handoff artifacts | `schemas/handoff-schema.json` |

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
squads validate ./my-squad              # Full validation
squads validate ./my-squad --json       # JSON output
squads validate ./my-squad --report     # AI-friendly fix report
squads validate ./my-squad --fix        # Auto-fix safe issues
```

---

## Runtime-Specific Details

Each adapter may add runtime-specific schema fields under its namespace:

| Runtime | See |
|---------|-----|
| Claude Code | [adapters/claude-code.md §4](../adapters/claude-code.md#4-frontmatter-mapping) |
| Gemini CLI | [adapters/gemini-cli.md §4](../adapters/gemini-cli.md#4-frontmatter-mapping) |
| Codex | [adapters/codex.md §4](../adapters/codex.md#4-frontmatter-mapping) |
| Cursor | [adapters/cursor.md §4](../adapters/cursor.md#4-frontmatter-mapping) |
| Antigravity | [adapters/antigravity.md §4](../adapters/antigravity.md#4-frontmatter-mapping) |
