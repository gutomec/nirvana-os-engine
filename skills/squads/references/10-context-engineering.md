# Context Engineering

## When to load
Intent: OPTIMIZE, DEBUG, DESIGN

## Protocol Reference
SQUAD_PROTOCOL_V4.md §12, §13

## Context Is a Budget

Every agent operates inside a finite token budget (its context window). Every token consumed is a token unavailable for future reasoning. Good squads treat context as a precious resource.

## Three Metrics

| Metric | Formula | Detects |
|--------|---------|---------|
| **Token Utility Ratio** | actionable tokens / total tokens | Inflated prompts |
| **Context Density** | unique information / token count | Repetition across agents |
| **Handoff Overhead** | handoff tokens / total tokens | Over-fragmentation |

A healthy squad has high utility ratio, high density, and low handoff overhead.

## Budget Discipline (Relative, Not Absolute)

Core expresses budgets as **relative fractions** of the runtime's context window, not absolute numbers:

| Target | Fraction of context window |
|--------|---------------------------|
| Agent body | ≤ 1.5% |
| Handoff artifact | ≤ 0.25% |
| Session artifacts cumulatively | ≤ 5% |

Adapters publish absolute values in their §9 Context Window & Compaction.

## Why Relative?

Context windows vary by runtime and model. A body that is 2,500 tokens is fine in one runtime and catastrophic in another. Expressing budgets relative to the window makes squads portable.

## The Biggest Lever Is Handoff Discipline

Shrinking agent bodies saves tokens per turn. But squads that pass full conversation history between steps **multiply** token costs by the number of steps. The bigger lever is handoff discipline:

- Structured handoff artifacts (not full histories).
- Task output schemas with declared fields.
- Contract validation at each step boundary.

A squad with 2,500-token bodies and disciplined handoffs often uses fewer total tokens than a squad with 1,000-token bodies and history passing.

## Context Density Patterns

### Good Density
- One fact per sentence.
- No repetition across agents.
- Specific references (file:line) instead of prose descriptions.
- Schemas defined once, referenced many times.

### Poor Density
- Multiple agents re-explaining the same domain.
- Verbose persona prose at the top of every agent.
- Long descriptions of what the agent should NOT do (use DO NOT bullets, not paragraphs).
- Duplicated examples across sibling agents.

## Context Pressure Is a Runtime Concern

When context usage approaches the runtime's limit, the runtime applies compaction. Mechanism and thresholds vary by runtime and must be documented in the adapter, not Core. Core provides:

- Relative budget targets (above).
- Four survival practices (Core §13).
- Handoff artifact schema (Core §9).

## Agent Body Sizing

Target: 1.5% of the runtime's context window.

When the body grows past the target, the usual cause is that the agent has multiple responsibilities. Split it:

- If two DO sections address different domains → two agents.
- If process has a natural handoff point → split at the handoff.
- If examples consume more than half the body → move examples to `references/` loaded on demand.

## Tool Description Overhead

Tools consume context via their declared schemas. An agent with many tools may burn significant context on tool schemas alone. Declare only the tools an agent uses.

Portable tool names in `tools:` avoid the overhead of verbose runtime-specific tool declarations.

## Memory Overhead

Persistent memory (project, global scopes) is injected into every agent invocation. A large memory file is repeated token cost on every call. GC policy (Core §11.5) caps this.

---

## Runtime-Specific Details

Absolute token budgets, compaction thresholds, and memory injection mechanics are runtime-specific:

| Runtime | See |
|---------|-----|
| Claude Code | [adapters/claude-code.md §9](../adapters/claude-code.md#9-context-window--compaction) |
| Gemini CLI | [adapters/gemini-cli.md §9](../adapters/gemini-cli.md#9-context-window--compaction) |
| Codex | [adapters/codex.md §9](../adapters/codex.md#9-context-window--compaction) |
| Cursor | [adapters/cursor.md §9](../adapters/cursor.md#9-context-window--compaction) |
| Antigravity | [adapters/antigravity.md §9](../adapters/antigravity.md#9-context-window--compaction) |
