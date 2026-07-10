# Adapter: Antigravity

Runtime-specific documentation for running Squad Protocol v4.0 squads on **Antigravity** (Google).

**Status:** Experimental. This adapter reflects current public understanding of Antigravity and will evolve as the runtime matures.

---

## 1. Adapter Metadata

| Field | Value |
|-------|-------|
| Runtime ID | `antigravity` |
| Runtime Name | Antigravity |
| Vendor | Google |
| Adapter Version | 0.1.0 |
| Protocol Version | 4.0 |
| Minimum Runtime Version | 0.1.0 |
| Status | **experimental** |

---

## 2. Feature Support Matrix

| Feature | Support | Mechanism |
|---------|---------|-----------|
| `max_turns` | ❌ | Enforcement not verified |
| `tool_whitelist` | ❌ | Advisory only |
| `handoff_artifacts` | 🤝 | Convention |
| `subagent_spawning` | ❌ | Evolving |
| `sequential_execution` | ✅ | Default |
| `project_memory` | ❌ | Manual only |
| `global_memory` | ❌ | Not supported |
| `session_memory` | ✅ | In-memory |
| `hooks` | ❌ | Not supported |
| `sandboxing` | ❓ | Not verified |
| `web_search` | ❓ | Not verified |
| `file_write` | ✅ | Built-in |
| `shell_exec` | ✅ | Built-in |
| `fork_context` | ❌ | Not supported |
| `teammate_primitive` | ❌ | Not applicable |

---

## 3. Concept Mapping

### 3.1 Core → Runtime Primitives

| Core concept | Antigravity primitive |
|-------------|----------------------|
| Agent | `.md` file with prose instructions |
| Task | `.md` file (harness-interpreted) |
| Workflow | Harness orchestrator |
| Subagent invocation | Not stable; harness falls back to sequential |
| Session | One Antigravity session |

### 3.2 Frontmatter Semantics

| Frontmatter field | Status on Antigravity |
|-------------------|-----------------------|
| `name` | Used by harness |
| `description` | Used by harness |
| `tools` | Advisory; rely on body guardrails |
| `maxTurns` | Declared for portability; enforcement not verified |

---

## 4. Frontmatter Mapping

```yaml
---
name: example
description: "..."
maxTurns: 25           # declare even though enforcement not verified
tools: [read, grep]    # advisory only
---
```

---

## 5. Tool Whitelist Mechanics

**Enforcement level:** **Advisory only.**

Antigravity's tool gating is not formalized in a way this adapter can rely on. Squad authors must:
- Only grant tools the squad genuinely needs.
- Rely on body-level safety prose for misuse prevention.
- Plan for runtime to honor the whitelist best-effort.

---

## 6. Max-Turns Mechanics

| Property | Value |
|----------|-------|
| Frontmatter field | `maxTurns` |
| CLI flag | unknown |
| Runtime default | unverified |
| Hard cap | unverified |

**Declare maxTurns for portability.** Do not depend on runtime enforcement in the current Antigravity version.

---

## 7. Subagent Spawning

**Primitive:** Evolving.

**Fallback:** Sequential execution. The harness runs workflow steps in topological order one at a time.

Revisit this adapter when Antigravity formalizes a subagent API.

---

## 8. Memory Storage

| Core scope | Implementation |
|-----------|---------------|
| Ephemeral | Session state |
| Session | In-memory |
| Project | Manual file injection only |
| Global | Not supported |

---

## 9. Context Window & Compaction

Not publicly documented at this adapter version. Keep agent bodies small and handoff artifacts disciplined.

---

## 10. Hook System

Not supported.

---

## 11. Invocation Examples

### 11.1 Interactive Session

```bash
antigravity
```

### 11.2 Running a Squad

```bash
squads run ./my-squad --runtime antigravity
```

---

## 12. Runtime-Specific Validators

| ID | Applies to | Level | Description |
|----|-----------|-------|-------------|
| `antigravity-experimental-advisory` | squad | warning | Adapter is experimental; prefer stable runtimes for production |
| `antigravity-tool-advisory` | agent | warning | Tool whitelist is advisory; depend on body safety prose |

---

## 13. Known Limitations

| Limitation | Workaround |
|-----------|-----------|
| Subagent model evolving | Use sequential workflows |
| Tool whitelist advisory | Minimize tool grants; body-level guardrails |
| `maxTurns` enforcement unverified | Declare for portability, do not rely on it |
| No public compaction mechanics | Keep bodies small, handoffs disciplined |
| Experimental adapter (v0.1.0) | Prefer `claude-code` or `gemini-cli` for production |

**Honest recommendation:** use `gemini-cli` for production Google-family squads until Antigravity stabilizes.

---

## 14. Source References

No SRC citations yet. This adapter reflects public documentation as of the adapter version date.

---

## 15. Version History

| Version | Date | Changes |
|---------|------|---------|
| 0.1.0 | 2026-04-04 | Initial experimental adapter |
