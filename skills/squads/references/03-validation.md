# Squad Validation

## When to load
Intent: VALIDATE (keywords: validate, check, verify, fix, repair, lint, audit)

## Protocol Reference
SQUAD_PROTOCOL_V4.md §15

## Validation — Two-Stage

Validation runs in two stages:

1. **Core validation** — universal rules that hold on every runtime (this document).
2. **Adapter validation** — runtime-specific rules declared in each adapter's §12 Runtime-Specific Validators.

## Format Detection

The validator accepts v4.0 (native), v3.1 (auto-upgrade), and v2.0 (legacy shim) formats.

| Indicator | Detected version |
|-----------|-----------------|
| `protocol: "4.0"` in manifest | **v4.0 native** |
| `protocol` absent, flat agent frontmatter with mandatory `maxTurns` | v3.1 |
| `protocol` absent, flat `name:`+`description:` in agent | v2.0 CC flat |
| Nested `agent:`/`persona:` blocks in agent | v2.0 legacy nested |

## Core Blocking Checks (MUST pass)

| # | Check | v4 | v2 legacy |
|---|-------|----|-----------|
| B1 | `squad.yaml` exists and valid YAML | Same | Same |
| B2 | `name` is kebab-case (2–50 chars) | Same | Same |
| B3 | `version` is valid semver | Same | Same |
| B4 | `protocol` declared and supported | **Required** | Auto-injected by shim |
| B5 | All files in `components.*` exist on disk | Same | Same |
| B6 | Agent has identity | `name`+`description`+`maxTurns` | `agent.name`+`agent.id` |
| B7 | Agent frontmatter valid YAML | Same | Same |
| B8 | **`maxTurns` declared per agent** | **Blocking** | Shim warns + defaults to 25 |
| B9 | Task has identity | `name` | `task`+`owner` |
| B10 | Task frontmatter valid YAML | Same | Same |
| B11 | Workflow has name | `name` or `workflow_name` | Same |
| B12 | Agent names unique | Same | Same |
| B13 | Task names unique | Same | Same |
| B14 | Workflow step `agent`/`task` refs resolve | Same | Same |
| B15 | Workflow DAG is acyclic | Same | Same |
| B16 | `runtime_requirements.minimum` has at least one runtime | **Required** | Auto-injected by shim |
| B17 | Every runtime in `runtime_requirements` has adapter available | **Required** | Auto-fills to claude-code |
| B18 | If `contracts:` present, schemas exist and valid | Same | Same |

## Non-Blocking Checks (Advisories)

These do NOT block validation but are flagged as warnings:

- `tools:` declared per agent.
- `description` follows "[verb] [domain]. Use when… Do NOT use for…" pattern.
- Body contains four canonical sections (identity, guidelines, process, output).
- `features_required` non-empty.
- Memory GC policy declared if persistent memory is used.
- `ui.agents_metadata` present for marketplace display.

## Adapter Validation Stage

After Core passes, the harness loads each target adapter and runs its runtime-specific validators. Examples:

- Claude Code: `cc-max-turns-required` (blocking), `cc-description-length` (warning)
- Codex: `codex-tools-lowercase` (warning), `codex-sequential-only` (info)
- Gemini CLI: `gemini-max-turns-required` (blocking)

See each adapter's §12 for its validators list.

## Validation Procedure

1. Detect squad version.
2. Run Core blocking checks (B1–B18).
3. Run Core advisory checks.
4. For each target runtime in `runtime_requirements`, load adapter and run adapter validators.
5. Report results with score.
6. If errors: offer `--report` for AI-friendly fix guidance.
7. If errors: offer `--fix` for auto-fix of common issues.

## CLI Commands

```bash
squads validate ./my-squad                       # Validate with colored report
squads validate ./my-squad --json                # JSON output
squads validate ./my-squad --report              # AI-friendly fix report
squads validate ./my-squad --fix                 # Auto-fix then validate
squads validate ./my-squad --runtime claude-code # Validate only against specific adapter
```

---

## Runtime-Specific Details

Adapter-level validators live in each adapter's §12:

| Runtime | See |
|---------|-----|
| Claude Code | [adapters/claude-code.md §12](../adapters/claude-code.md#12-runtime-specific-validators) |
| Gemini CLI | [adapters/gemini-cli.md §12](../adapters/gemini-cli.md#12-runtime-specific-validators) |
| Codex | [adapters/codex.md §12](../adapters/codex.md#12-runtime-specific-validators) |
| Cursor | [adapters/cursor.md §12](../adapters/cursor.md#12-runtime-specific-validators) |
| Antigravity | [adapters/antigravity.md §12](../adapters/antigravity.md#12-runtime-specific-validators) |
