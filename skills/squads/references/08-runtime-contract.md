# Runtime Contract

## When to load
Intent: ADAPT, UNDERSTAND_RUNTIME, AUTHOR_ADAPTER

## Protocol Reference
SQUAD_PROTOCOL_V4.md §4, §18

## What a Runtime Adapter Provides

Every runtime adapter is a **contract** between the Core Protocol and a specific agentic runtime. The contract has two parts:

1. **Manifest** (`adapters/{runtime_id}.yaml`) — machine-readable declaration of support, mappings, numeric values, validators.
2. **Documentation** (`adapters/{runtime_id}.md`) — human-readable explanation of the adapter's mechanics.

## Adapter Manifest (Required Fields)

```yaml
adapter:
  runtime_id: example-runtime
  runtime_name: "Example Runtime"
  vendor: "Vendor Name"
  adapter_version: 1.0.0
  protocol_version: "4.0"
  minimum_runtime_version: "1.0.0"

features_supported:
  - id: max_turns
    mechanism: enforced | advisory | hybrid | convention
    notes: "..."

features_unsupported:
  - id: subagent_spawning
    fallback: "Sequential execution"

concept_mapping:
  # Core → Runtime primitive maps

numeric_values:
  # Runtime-specific numbers live HERE only

validators:
  # Adapter-level validators beyond Core

invocation:
  # CLI flags, env vars, sample commands
```

The manifest validates against `schemas/adapter-schema.json`.

## Required Documentation Sections

Every adapter doc has 15 numbered sections. Sections required for every adapter:

| # | Section |
|---|---------|
| 1 | Adapter Metadata |
| 2 | Feature Support Matrix |
| 3 | Concept Mapping |
| 6 | Max-Turns Mechanics |
| 11 | Invocation Examples |
| 13 | Known Limitations |

Other sections are optional if the runtime lacks the underlying capability, but MUST be present with a "Not applicable" explanation.

## Graceful Degradation Contract

When a squad declares a feature under `features_optional` and the adapter lists it under `features_unsupported`:

1. Harness logs the degradation at load time.
2. Harness substitutes the documented fallback.
3. Execution continues.

When a squad declares a feature under `features_required` and the adapter lacks it:

1. Harness refuses to load the squad.
2. Error message points to the adapter's Feature Support Matrix.
3. Fail-closed (Core P5).

## Feature Canonical Names

The Core spec defines a closed list of feature names adapters and squads speak. See Core §18.2 and Appendix B.

Adapters MAY document additional runtime-specific features beyond this list, but Core matching uses only the canonical names.

## Numeric Values Locality

**All runtime-specific numeric values live in adapter manifests** (`numeric_values` block) and adapter documentation (§9 Context Window & Compaction). Examples:

- Context window size in tokens.
- Compaction buffer size.
- Compaction trigger threshold.
- Default and hard-cap maxTurns.
- Memory file size limits.

Core contains **no** absolute numeric thresholds. Core expresses budgets as relative fractions (§12.2).

## Source References (SRC-N)

Adapters that verify claims against runtime source code cite them with SRC-N identifiers. Example: `SRC-8 (query.ts:1705)` cites a specific line in the runtime's implementation.

Citations live in each adapter's §14 Source References. This discipline keeps the adapter honest: if a line changes, the citation becomes stale and the claim needs re-verification.

## Writing a New Adapter

1. Copy `adapters/_template-adapter.md`.
2. Fill in all required sections.
3. Create the YAML manifest conforming to `schemas/adapter-schema.json`.
4. Declare `features_supported` and `features_unsupported` honestly.
5. Populate `concept_mapping` for every Core concept your runtime supports.
6. Document `numeric_values` with actual verified values.
7. Add validators for runtime-specific rules.
8. List Known Limitations honestly.
9. Validate the manifest: `ajv validate -s schemas/adapter-schema.json -d adapters/{runtime_id}.yaml`.
10. Test with a known squad: `squads run ./examples/cc-code-review --runtime {runtime_id}`.

See `references/11-adapters-guide.md` for the complete authoring guide.

---

## Runtime-Specific Details

Every adapter follows this contract. See each adapter for its specific implementation:

| Runtime | Adapter |
|---------|---------|
| Claude Code | [adapters/claude-code.md](../adapters/claude-code.md) |
| Gemini CLI | [adapters/gemini-cli.md](../adapters/gemini-cli.md) |
| Codex | [adapters/codex.md](../adapters/codex.md) |
| Cursor | [adapters/cursor.md](../adapters/cursor.md) |
| Antigravity | [adapters/antigravity.md](../adapters/antigravity.md) |
