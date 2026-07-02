# Adapter: Gemini CLI

Runtime-specific documentation for running Squad Protocol v4.0 squads on **Gemini CLI** (Google).

---

## 1. Adapter Metadata

| Field | Value |
|-------|-------|
| Runtime ID | `gemini-cli` |
| Runtime Name | Gemini CLI |
| Vendor | Google |
| Adapter Version | 0.1.0 |
| Protocol Version | 4.0 |
| Minimum Runtime Version | 1.0.0 |
| Status | beta |

---

## 2. Feature Support Matrix

| Feature | Support | Mechanism |
|---------|---------|-----------|
| `max_turns` | ✅ | `--max-turns` flag |
| `tool_whitelist` | ✅ | `--allowed-tools` flag |
| `handoff_artifacts` | 🤝 | Convention via structured output |
| `subagent_spawning` | ❌ | No native primitive |
| `sequential_execution` | ✅ | Default |
| `project_memory` | ✅ | `GEMINI.md` convention |
| `global_memory` | ❌ | Not native |
| `session_memory` | ✅ | In-memory conversation |
| `hooks` | ❌ | Not supported |
| `sandboxing` | 🟡 | `--sandbox` flag |
| `web_search` | ✅ | Google Search grounding |
| `file_write` | ✅ | Built-in |
| `shell_exec` | ✅ | Built-in |
| `fork_context` | ❌ | Not supported |
| `teammate_primitive` | ❌ | Not applicable |

---

## 3. Concept Mapping

### 3.1 Core → Runtime Primitives

| Core concept | Gemini CLI primitive |
|-------------|---------------------|
| Agent | `.md` file, prompt injected via CLI |
| Task | `.md` file (harness-interpreted) |
| Workflow | Harness orchestrator |
| Subagent invocation | Not supported; harness spawns parallel processes |
| Session | One Gemini CLI invocation |

### 3.2 Frontmatter Field Semantics

| Frontmatter field | Purpose |
|-------------------|---------|
| `name` | Harness routing |
| `description` | Harness selection |
| `tools` → `allowed_tools` | Passed as `--allowed-tools` CLI flag |
| `maxTurns` | Passed as `--max-turns` |

---

## 4. Frontmatter Mapping

```yaml
---
name: analyst
description: "Analyzes large codebases leveraging 1M context"
maxTurns: 50
tools: [read, grep, glob, web_search]
runtimes:
  gemini-cli:
    model: gemini-2.5-pro
    allowed_tools: [read_file, grep, glob, google_search]
---
```

---

## 5. Tool Whitelist Mechanics

**Enforcement level:** **Enforced** (via CLI flag).

**Portable → local tool names:**

| Portable | Gemini tool |
|----------|-------------|
| `read` | `read_file` |
| `write` | `write_file` |
| `edit` | `edit_file` |
| `grep` | `grep` |
| `glob` | `glob` |
| `bash` / `shell` | `shell` |
| `web_search` | `google_search` |
| `web_fetch` | `fetch` |

---

## 6. Max-Turns Mechanics

| Property | Value |
|----------|-------|
| Frontmatter field | `maxTurns` |
| CLI flag | `--max-turns` |
| Runtime default | version-dependent |
| Hard cap | none published |

**Gemini 1M context advantage:** larger maxTurns budgets are viable because the runtime tolerates long histories without compaction pressure.

---

## 7. Subagent Spawning

**Primitive:** None. Falls back to sequential execution or harness-spawned independent processes.

---

## 8. Memory Storage

| Core scope | Implementation | Location |
|-----------|---------------|----------|
| Ephemeral | Process state | In-memory |
| Session | CLI invocation | In-memory |
| Project | `GEMINI.md` | Repo root |
| Global | Not native | — |

**`GEMINI.md`** is Gemini CLI's equivalent of `CLAUDE.md`. The convention is less standardized; verify the file is being loaded in your Gemini version.

---

## 9. Context Window & Compaction

### 9.1 Numeric Values

| Metric | Value |
|--------|-------|
| Context window | 1,000,000 tokens (gemini-2.5-pro) |
| Max output tokens | 8,192 |
| Effective context | ~992,000 tokens |

### 9.2 Compaction Mechanism

With a 1M window, compaction pressure is greatly reduced. Gemini does not publish detailed compaction template mechanics. Squads can use larger agent bodies and longer histories.

---

## 10. Hook System

Not applicable — Gemini CLI does not provide a hook system.

---

## 11. Invocation Examples

### 11.1 Interactive Session

```bash
gemini
```

### 11.2 Non-Interactive

```bash
gemini --allowed-tools read_file,grep,shell --max-turns 25 "review the diff"
```

### 11.3 Environment Variables

```bash
export GEMINI_API_KEY=...
# or
export GOOGLE_API_KEY=...
```

### 11.4 Running a Squad

```bash
squads run ./my-squad --runtime gemini-cli
```

---

## 12. Runtime-Specific Validators

| ID | Applies to | Level | Description |
|----|-----------|-------|-------------|
| `gemini-max-turns-required` | agent | blocking | `maxTurns` required |
| `gemini-large-window-advisory` | squad | info | 1M window allows larger bodies |

---

## 13. Known Limitations

| Limitation | Workaround |
|-----------|-----------|
| No native subagent primitive | Harness spawns independent processes |
| No hook system | Validator agent as workflow step |
| `GEMINI.md` injection less standardized | Verify loading; fallback to system prompt |
| Compaction mechanics not detailed publicly | Design for 1M window; less critical |

---

## 14. Source References

Based on publicly documented Gemini CLI behavior.

---

## 15. Version History

| Version | Date | Changes |
|---------|------|---------|
| 0.1.0 | 2026-04-04 | Initial adapter for Squad Protocol v4.0 |
