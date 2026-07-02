# Adapter: Cursor Agent

Runtime-specific documentation for running Squad Protocol v4.0 squads on **Cursor Agent** (Cursor).

---

## 1. Adapter Metadata

| Field | Value |
|-------|-------|
| Runtime ID | `cursor` |
| Runtime Name | Cursor Agent |
| Vendor | Cursor |
| Adapter Version | 0.1.0 |
| Protocol Version | 4.0 |
| Minimum Runtime Version | 0.40.0 |
| Status | beta |

---

## 2. Feature Support Matrix

| Feature | Support | Mechanism |
|---------|---------|-----------|
| `max_turns` | ⚠️ | Hybrid (agent-loop level; flag varies) |
| `tool_whitelist` | 🟡 | Advisory |
| `handoff_artifacts` | 🤝 | Convention |
| `subagent_spawning` | ❌ | Not supported |
| `sequential_execution` | ✅ | Default |
| `project_memory` | ✅ | `.cursorrules` |
| `global_memory` | ❌ | Not native |
| `session_memory` | ✅ | Chat session |
| `hooks` | ❌ | Not supported |
| `sandboxing` | ❓ | Not verified |
| `web_search` | ✅ | Built-in |
| `file_write` | ✅ | Via edit tool |
| `shell_exec` | ✅ | Via terminal tool |
| `fork_context` | ❌ | Not supported |
| `teammate_primitive` | ❌ | Not applicable |

---

## 3. Concept Mapping

### 3.1 Core → Runtime Primitives

| Core concept | Cursor primitive |
|-------------|------------------|
| Agent | Cursor chat agent with custom system prompt |
| Task | `.md` file (harness-interpreted) |
| Workflow | Harness orchestrator |
| Subagent invocation | Not supported; sequential |
| Session | Chat session in Cursor IDE |

### 3.2 Frontmatter Semantics

| Frontmatter field | Purpose |
|-------------------|---------|
| `name` | Routing |
| `description` | Harness selection |
| `tools` | Advisory |
| `maxTurns` | Agent loop bound |

---

## 4. Frontmatter Mapping

```yaml
---
name: reviewer
description: "Reviews code in Cursor IDE context"
maxTurns: 25
tools: [read, grep, edit]
runtimes:
  cursor:
    model: inherit
---
```

---

## 5. Tool Whitelist Mechanics

**Enforcement level:** **Advisory.**

Cursor's tool gating is not as strict as API-schema enforcement. Squad authors should:
- Rely on body-level safety prose (`NEVER delete outside output/`).
- Minimize tool grants to reduce attack surface.

**Portable → local tool names:**

| Portable | Cursor tool |
|----------|-------------|
| `read` | `read` |
| `write` / `edit` | `edit` |
| `grep` | `grep` |
| `glob` | `glob` |
| `bash` / `shell` | `terminal` |
| `web_search` | `search` |
| `web_fetch` | `fetch` |

---

## 6. Max-Turns Mechanics

| Property | Value |
|----------|-------|
| Frontmatter field | `maxTurns` |
| CLI flag | version-dependent |
| Runtime default | none reliable |
| Hard cap | none published |

Declare `maxTurns` in every agent.

---

## 7. Subagent Spawning

**Primitive:** None.

**Fallback:** Sequential execution of workflow steps.

---

## 8. Memory Storage

| Core scope | Implementation | Location |
|-----------|---------------|----------|
| Ephemeral | Session state | In-memory |
| Session | Chat session | In-memory |
| Project | `.cursorrules` | Workspace root |
| Global | Not native | — |

**`.cursorrules`** is a per-workspace file that Cursor injects into agent sessions. It fulfills the project memory scope.

---

## 9. Context Window & Compaction

### 9.1 Numeric Values

Cursor routes through various model providers; context window depends on the selected model. For Claude models: 200K; for GPT-4o: 128K.

### 9.2 Compaction Mechanism

Not formally documented at this adapter version. Model-level summarization handles context pressure.

---

## 10. Hook System

Not supported.

---

## 11. Invocation Examples

### 11.1 Interactive (Cursor IDE)

Open Cursor IDE with agent panel. Custom prompts loaded from `.cursorrules`.

### 11.2 CLI

```bash
cursor-agent --workspace ./my-repo "review the diff"
```

### 11.3 Running a Squad

```bash
squads run ./my-squad --runtime cursor
```

---

## 12. Runtime-Specific Validators

| ID | Applies to | Level | Description |
|----|-----------|-------|-------------|
| `cursor-max-turns-required` | agent | blocking | `maxTurns` required |
| `cursor-tool-advisory` | agent | warning | Tool whitelist is advisory; add body safety prose |

---

## 13. Known Limitations

| Limitation | Workaround |
|-----------|-----------|
| Tool whitelist advisory, not hard-enforced | Body-level safety prose as primary defense |
| No native subagent primitive | Sequential execution |
| No hook system | Validator agent as workflow step |
| Best experience requires Cursor IDE | CLI works but lacks IDE integrations |

---

## 14. Source References

Based on publicly documented Cursor Agent behavior.

---

## 15. Version History

| Version | Date | Changes |
|---------|------|---------|
| 0.1.0 | 2026-04-04 | Initial adapter for Squad Protocol v4.0 |
