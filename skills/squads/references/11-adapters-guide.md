# Adapters Guide

## When to load
Intent: AUTHOR_ADAPTER, UNDERSTAND_RUNTIME, DEBUG_RUNTIME_ISSUE

## Protocol Reference
SQUAD_PROTOCOL_V4.md §4, §18

## What an Adapter Is

An **adapter** is the bridge between the runtime-agnostic Core Protocol and a specific agentic runtime. Adapters translate portable squad concepts (agents, tasks, workflows, maxTurns, tool whitelists) into runtime-specific mechanics (CLI flags, API fields, file paths, numeric thresholds).

Without adapters, squads would be locked to a single runtime. With adapters, one squad file runs everywhere.

## The Two-File Contract

Every adapter consists of two files:

```
adapters/
├── {runtime_id}.md     # Human-readable documentation (15 sections)
└── {runtime_id}.yaml   # Machine-readable manifest (validated by adapter-schema.json)
```

Both must exist for the adapter to be usable by the harness.

## Why Adapters Matter

Three pain points adapters solve:

1. **Numeric divergence.** Each runtime has different context windows, compaction thresholds, max-turn defaults. Adapters keep these numbers **in one place** so squads don't hardcode them.
2. **CLI flag divergence.** `--allowedTools` vs `--allowed-tools` vs frontmatter `tools:`. Adapters map portable names to runtime syntax.
3. **Feature divergence.** Not every runtime supports subagents, hooks, or persistent memory. Adapters declare what's supported and document fallbacks.

## Reading an Adapter

A user deciding whether to target a runtime for their squad reads the adapter's:

- **§2 Feature Support Matrix** — does the runtime support the features my squad needs?
- **§9 Context Window & Compaction** — will my squad fit?
- **§13 Known Limitations** — what will break or degrade?

These three sections answer: "Is this runtime a good fit for my squad?"

## Writing a New Adapter

### Step 1: Copy the template

```bash
cp adapters/_template-adapter.md adapters/my-runtime.md
```

### Step 2: Fill in Required Sections

At minimum, document these six sections (Core §18.5 Minimum Adapter Contract):

| # | Section | Why required |
|---|---------|-------------|
| 1 | Adapter Metadata | Identifies the adapter |
| 2 | Feature Support Matrix | Users need to know what works |
| 3 | Concept Mapping | Core concepts → runtime primitives |
| 6 | Max-Turns Mechanics | Universal mandatory feature |
| 11 | Invocation Examples | Users need to know how to run it |
| 13 | Known Limitations | Honesty about what breaks |

Sections 4, 5, 7, 8, 9, 10, 12, 14, 15 are optional if the runtime genuinely lacks the underlying capability. Replace with "Not applicable — {runtime} does not support X" when appropriate.

### Step 3: Create the YAML Manifest

```yaml
# adapters/my-runtime.yaml
adapter:
  runtime_id: my-runtime
  runtime_name: "My Runtime"
  vendor: "Vendor"
  adapter_version: 0.1.0
  protocol_version: "4.0"
  minimum_runtime_version: "1.0.0"

features_supported: [...]
features_unsupported: [...]
concept_mapping: {...}
numeric_values: {...}
validators: [...]
invocation:
  examples: [...]
```

Validate it:

```bash
ajv validate -s schemas/adapter-schema.json -d adapters/my-runtime.yaml
```

### Step 4: Declare Features Honestly

Use only canonical feature names from Core §18.2 and Appendix B. Do not invent features. If your runtime has a unique capability, document it under adapter-specific sections but don't claim Core features you don't have.

**Mechanism options:**
- `enforced` — runtime guarantees the behavior
- `advisory` — runtime treats as hint; squads must supplement with prose
- `hybrid` — mixed enforcement
- `convention` — no runtime primitive; squads implement via discipline

### Step 5: Map Numeric Values

All runtime-specific numbers go into the `numeric_values` block:

```yaml
numeric_values:
  context_window_tokens: 128000
  max_output_tokens: 4096
  default_max_turns: null
  memory_file_max_chars: null
```

**Core never contains these values.** If you find a number in Core, it's a bug — move it to the adapter.

### Step 6: Document Known Limitations

This section is for the squad author deciding whether to target your runtime. Underselling limitations damages trust. Examples of honest limitations:

- "No native subagent spawning; parallel steps degrade to sequential."
- "`maxTurns` enforcement unverified in current version."
- "Tool whitelist is advisory, not API-enforced."

### Step 7: Add Runtime-Specific Validators

If your runtime has rules beyond Core, declare them:

```yaml
validators:
  - id: my-runtime-specific-check
    description: "Explanation of the rule"
    level: blocking | warning | info
    applies_to: agent | task | squad | workflow | manifest
```

### Step 8: Test with a Known Squad

```bash
squads run ./examples/cc-code-review --runtime my-runtime
```

If features degrade, confirm the degradation logs are sensible. If something crashes, the adapter is lying about its feature support.

## Graceful Degradation Contract

When a squad declares `features_optional: [...]` and your adapter lists one under `features_unsupported`:

1. Harness logs: `INFO: runtime 'my-runtime' does not support {feature}; falling back to {documented fallback}.`
2. Harness substitutes the fallback.
3. Execution continues.

Your adapter documents the fallback in the `features_unsupported` entry's `fallback` field.

## Version Discipline

- **Adapter semver** tracks adapter changes (config format, validators, documented behavior).
- **Runtime semver** in `minimum_runtime_version` tracks the underlying runtime.
- When the underlying runtime breaks your adapter, bump adapter major.
- When you add a validator or feature, bump adapter minor.
- When you fix a citation or clarify wording, bump adapter patch.

## Source References (SRC-N)

If you verify claims against runtime source code, cite them:

```yaml
source_references:
  - id: SRC-X-1
    claim: "What this proves"
    source: "file.ts:line-number"
    verified_at: "2026-04-04"
```

This discipline keeps adapters honest. When a line changes, the citation becomes stale and the claim needs re-verification.

## Example Adapters

| Runtime | Status | Adapter |
|---------|--------|---------|
| Claude Code | stable (reference) | [claude-code.md](../adapters/claude-code.md) |
| Codex | beta | [codex.md](../adapters/codex.md) |
| Gemini CLI | beta | [gemini-cli.md](../adapters/gemini-cli.md) |
| Cursor | beta | [cursor.md](../adapters/cursor.md) |
| Antigravity | experimental | [antigravity.md](../adapters/antigravity.md) |
| (new runtime) | — | [_template-adapter.md](../adapters/_template-adapter.md) |

## Submitting a New Adapter

1. Draft adapter doc and YAML manifest.
2. Validate manifest against `schemas/adapter-schema.json`.
3. Test with one or more example squads.
4. Verify all 6 required sections are populated.
5. Open a PR with the adapter files and a short rationale.

---

## Summary

Adapters are the honest answer to "portability is hard." Rather than pretending all runtimes are equivalent, adapters document the exact shape of each runtime's support. Squads declare what they need. Adapters declare what they provide. The harness matches them, degrades what doesn't fit, and logs everything.

This is how Squad Protocol v4.0 achieves portability without dishonesty.
