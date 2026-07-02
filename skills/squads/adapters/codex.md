# Adapter: Codex CLI

Runtime-specific documentation for running Squad Protocol v4.0 squads on **Codex CLI** (OpenAI).

---

## 1. Adapter Metadata

| Field | Value |
|-------|-------|
| Runtime ID | `codex` |
| Runtime Name | Codex CLI |
| Vendor | OpenAI |
| Adapter Version | 0.1.0 |
| Protocol Version | 4.0 |
| Minimum Runtime Version | 0.5.0 |
| Status | beta |

---

## 2. Feature Support Matrix

Legend: ✅ enforced · 🟡 advisory · ⚠️ hybrid · ❌ unsupported · 🤝 convention

| Feature | Support | Mechanism |
|---------|---------|-----------|
| `max_turns` | ✅ | CLI flag `--max-turns` |
| `tool_whitelist` | ✅ | CLI flag `--allowedTools` |
| `handoff_artifacts` | 🤝 | No native primitive; convention via structured output |
| `subagent_spawning` | ❌ | Not supported natively |
| `sequential_execution` | ✅ | Default |
| `project_memory` | ❌ | No canonical project memory file |
| `global_memory` | ❌ | Not supported |
| `session_memory` | ✅ | In-memory conversation |
| `hooks` | ❌ | Not supported |
| `sandboxing` | 🟡 | `--sandbox` flag; behavior varies by version |
| `web_search` | ✅ | Built-in |
| `file_write` | ✅ | Built-in |
| `shell_exec` | ✅ | Built-in |
| `fork_context` | ❌ | Not supported |
| `teammate_primitive` | ❌ | Not applicable |

---

## 3. Concept Mapping

### 3.1 Core → Runtime Primitives

| Core concept | Codex primitive |
|-------------|-----------------|
| Agent | `.md` file, instructions passed via `--instructions` flag or stdin |
| Task | `.md` file (harness-interpreted) |
| Workflow | Harness orchestrator; no native workflow format |
| Subagent invocation | Not supported; harness spawns separate Codex processes |
| Session | One Codex CLI invocation |
| Agent body | Injected as system prompt or via `--instructions` file |

### 3.2 Frontmatter Field Semantics

| Frontmatter field | Purpose | Visible to LLM? |
|-------------------|---------|-----------------|
| `name` | Harness routing | No |
| `description` | Harness selection | No (unless harness injects into prompt) |
| `tools` → `allowedTools` | Passed as `--allowedTools` CLI flag | No |
| `maxTurns` | Passed as `--max-turns` | No |

---

## 4. Frontmatter Mapping

```yaml
---
name: reviewer
description: "Reviews code changes"
maxTurns: 25
tools: [read, grep, glob]
runtimes:
  codex:
    allowedTools: [read, grep, glob, bash]
    model: gpt-4o
    sandbox: true
---
```

---

## 5. Tool Whitelist Mechanics

**Enforcement level:** **Enforced** (via CLI flag).

The `--allowedTools` flag restricts which tools the Codex process can invoke. Tools not in the flag are unavailable for the duration of the invocation.

**Portable → local tool names:**

| Portable | Codex tool |
|----------|-----------|
| `read` | `read` |
| `write` | `write` |
| `edit` | `edit` |
| `grep` | `grep` |
| `glob` | `glob` |
| `bash` / `shell` | `bash` |
| `web_search` | `web` |
| `web_fetch` | `web` |

---

## 6. Max-Turns Mechanics

| Property | Value |
|----------|-------|
| Frontmatter field | `maxTurns` |
| CLI flag | `--max-turns` |
| Runtime default | version-dependent; always declare explicitly |
| Hard cap | none published |

**Typical values:**

| Task type | Recommended maxTurns |
|-----------|---------------------|
| Read + report | 5 |
| Code review | 15–25 |
| Fix + test | 25–40 |

---

## 7. Subagent Spawning

**Primitive:** None. Codex CLI has no native subagent/child-process primitive.

**Fallback:** The harness executes workflow steps **sequentially** in topological DAG order. For squads declaring `features_optional: [subagent_spawning]`, the harness logs:

```
INFO: runtime 'codex' does not support subagent_spawning.
      Executing workflow steps sequentially.
```

**Workaround for parallelism:** The harness can spawn **independent Codex processes** for independent steps. This simulates parallelism at the OS level, not inside Codex.

---

## 8. Memory Storage

### 8.1 Memory Scopes

| Core scope | Codex implementation | Location |
|-----------|---------------------|----------|
| Ephemeral | Process-local state | In-memory |
| Session | Single CLI invocation | In-memory |
| Project | `AGENTS.md` or `--instructions` file | Repo root (convention) |
| Global | Not supported | — |

**`AGENTS.md`** is a widely-adopted convention for project-scoped agent instructions. Codex does not inject it automatically; the harness or user must pass it via `--instructions`.

---

## 9. Context Window & Compaction

### 9.1 Numeric Values

| Metric | Value |
|--------|-------|
| Context window | 128,000 tokens (gpt-4o) |
| Max output tokens | 4,096 (default) |
| Effective context | ~124,000 tokens |

Codex does not publish autocompact buffer mechanics equivalent to Claude Code's. Squads should design for the smaller 128K window and use aggressive handoff artifact discipline.

### 9.2 Compaction Mechanism

Codex relies on model-level compaction rather than harness-level summarization. When context fills, older turns may be truncated at the API boundary.

### 9.3 Environment Overrides

No documented env vars for context window override.

---

## 10. Hook System

Not applicable — Codex CLI does not provide a hook system equivalent to PreToolUse/PostToolUse. Pre/post behavior must be implemented as explicit workflow validator steps.

---

## 11. Invocation Examples

### 11.1 Interactive Session

```bash
codex
```

### 11.2 Non-Interactive with Restrictions

```bash
codex --allowedTools read,grep,bash --max-turns 25 "review the diff"
```

### 11.3 With Sandbox

```bash
codex --sandbox --allowedTools read,edit "apply the fix"
```

### 11.4 Environment Variables

```bash
export OPENAI_API_KEY=sk-...
```

### 11.5 Running a Squad

```bash
squads run ./my-squad --runtime codex
```

---

## 12. Runtime-Specific Validators

| ID | Applies to | Level | Description |
|----|-----------|-------|-------------|
| `codex-tools-lowercase` | agent | warning | Tool names are lowercase in Codex |
| `codex-max-turns-required` | agent | blocking | `maxTurns` declaration required |
| `codex-sequential-only` | squad | info | Squads requiring `subagent_spawning` will degrade to sequential |

---

## 13. Known Limitations

| Limitation | Workaround |
|-----------|-----------|
| No native subagent spawning | Design squads tolerant of sequential execution |
| No hook system | Add validator agents as workflow steps |
| No standardized project memory injection | Pass `AGENTS.md` via `--instructions` manually |
| Smaller context window than Claude (128K) | Aggressive handoff discipline, smaller agent bodies |
| Sandbox behavior varies by version | Test sandbox against target version before production |
| No `fork_context` primitive | Re-invoke with serialized parent context |

---

## 14. Source References

Claims in this adapter are based on publicly documented Codex CLI behavior. Where documentation is ambiguous, claims are conservative (feature marked unsupported rather than assumed).

---

## 15. Version History

| Version | Date | Changes |
|---------|------|---------|
| 0.1.0 | 2026-04-04 | Initial adapter for Squad Protocol v4.0 |
