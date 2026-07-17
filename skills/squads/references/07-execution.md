# Execution Runtime

## When to load
Intent: EXECUTE, RUN, DEBUG

## Protocol Reference
SQUAD_PROTOCOL_V4.md §8, §13, §14

## Execution Concepts

### Bounded Iteration

All execution loops have explicit maximums. Squads declare `maxTurns` per agent (Core P4, mandatory). Workflow-level loops (QA review cycles, retry cascades) declare their own bounds.

Without bounds, some runtimes loop indefinitely. `maxTurns` is the universal safeguard and must be declared on every agent.

### Context Pressure and Compaction

When an agent's conversation approaches the runtime's context capacity, the runtime may compact: summarize older turns, drop tool results, rewrite history to preserve essential information.

Mechanism, thresholds, and templates are runtime-specific. The Core spec describes **practices** for surviving compaction, not specific numbers. See each adapter's §9 Context Window & Compaction for exact values.

### Loop Detection

Some runtimes are proposed to detect when an agent emits repeated near-identical outputs and take corrective action. At the time of this protocol, **no mainstream runtime implements harness-level loop detection**. `maxTurns` is the reliable guard.

See Core §20 Proposed (Not Implemented).

### Verification

After a step completes, the harness can run configurable verification:
- Schema validation of declared outputs.
- Acceptance-criteria checklist.
- Custom validator agents.

Verification failures trigger the retry/escalation cascade (Core §14.5).

## Execution Flow

```
1. Resolve squad path
2. Detect runtime and load adapter
3. Validate runtime_requirements and feature compatibility
4. For each workflow step:
   a. Compute wave (parallel-eligible steps at same dep level)
   b. Dispatch to runtime via adapter
   c. Collect handoff artifact
   d. Validate against declared output schema (if any)
   e. Apply verification
   f. On failure: retry → rollback → escalate
5. Report workflow outcome
```

## Handoff Between Steps

Each step produces a handoff artifact consumed by downstream steps. The artifact is a portable JSON structure (see Core §9 and `schemas/handoff-schema.json`). Squads that rely on passing raw conversation history fragment context and multiply token costs.

## Surviving Compaction — Practices

Core §13 Context Preservation describes four runtime-agnostic practices:

1. **Put critical instructions in the initial prompt** — runtimes tend to preserve the original request.
2. **Use tagged context blocks** — `<protocol-context>...</protocol-context>` blocks survive compaction via section preservation.
3. **Include file paths and line numbers in output** — compactors preserve structured code references.
4. **Keep agents small** — the cheapest compaction is the one that never happens.

## Error Recovery Cascade

```
transient → retry with backoff (max 3)
  → state → rollback + retry (max 3)
    → contract → repair prompt + retry (max 3)
      → configuration → skip or escalate
        → fatal → escalate to human
```

Each step is bounded. If the same error pattern recurs, redesign the squad.

---

## Output Path Resolution (v4.1)

As of v4.1 (§16bis), the **skill/runtime** resolves output paths with a standard default. The `output:` field in squad.yaml is **optional** — absent or `"default"` uses the convention; a custom `base_dir` is honored.

### Convention

```
{project-root}/.squads-outputs/{squad-name}/{YYYY-MM-DDTHHMMSS}-{slug}/
```

### Resolution Algorithm

1. **Project root:** `$SQUADS_PROJECT_ROOT` env var → walk up from cwd() until `.git/`, `AGENTS.md`, `CLAUDE.md`, `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, or `Makefile` → fallback cwd()
2. **Output root:** `{project-root}/.squads-outputs/`
3. **Run directory:** `{output-root}/{squad-name}/{timestamp}-{slug}/`
4. **Environment injection:** Runtime sets `$SQUAD_RUN_DIR` to the resolved run directory before executing the squad

### Auto-Created README

On first run, the resolver creates `.squads-outputs/README.md` explaining the directory to AI agents. This ensures discoverability by Claude Code, Cursor, Codex, and other AI tools that scan project structure.

### Resolver Implementation

`lib/output-resolver.js` — call `resolveRunDir(squadName, slug)` to get the full path. Use `ensureRunDir(path)` to create it + auto-generate README.

### Lifecycle

Outputs are intermediate. Users move final deliverables to their project's structure. Old runs can be deleted: `rm -rf .squads-outputs/{squad}/{old-run}/`

---

## Runtime-Specific Details

Numeric compaction thresholds, context window sizes, and compaction template specifics live in each adapter:

| Runtime | See |
|---------|-----|
| Claude Code | [adapters/claude-code.md §9](../adapters/claude-code.md#9-context-window--compaction) |
| Gemini CLI | [adapters/gemini-cli.md §9](../adapters/gemini-cli.md#9-context-window--compaction) |
| Codex | [adapters/codex.md §9](../adapters/codex.md#9-context-window--compaction) |
| Cursor | [adapters/cursor.md §9](../adapters/cursor.md#9-context-window--compaction) |
| Antigravity | [adapters/antigravity.md §9](../adapters/antigravity.md#9-context-window--compaction) |
