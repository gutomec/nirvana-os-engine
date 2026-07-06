# CC Squad Standard — MOVED

This document has moved. Its content is now part of the Claude Code adapter.

**See:** [`adapters/claude-code.md`](../adapters/claude-code.md)

---

## Why did this move?

In Squad Protocol v4.0, runtime-specific documentation lives in adapter files under `adapters/`. The Claude Code adapter is the reference implementation and contains all the detail previously in this file:

- Claude Code frontmatter format and field semantics → [§4](../adapters/claude-code.md#4-frontmatter-mapping)
- Tool whitelist mechanics (hard enforcement via API schema) → [§5](../adapters/claude-code.md#5-tool-whitelist-mechanics)
- Max-turns behavior → [§6](../adapters/claude-code.md#6-max-turns-mechanics)
- Subagent spawning via Task tool → [§7](../adapters/claude-code.md#7-subagent-spawning)
- Memory storage (`CLAUDE.md`, agent-memory scopes) → [§8](../adapters/claude-code.md#8-memory-storage)
- Context window & compaction values → [§9](../adapters/claude-code.md#9-context-window--compaction)
- Hook system (`PreToolUse`, `PostToolUse`) → [§10](../adapters/claude-code.md#10-hook-system)
- Source references (SRC-1…SRC-12 citations) → [§14](../adapters/claude-code.md#14-source-references)

For runtime-neutral squad authoring guidance, see:
- [`SQUAD_PROTOCOL_V4.md`](../SQUAD_PROTOCOL_V4.md) — the Core spec
- [`references/02-creation.md`](02-creation.md) — how to create a squad
- [`references/11-adapters-guide.md`](11-adapters-guide.md) — how adapters work
