# Adapter Template

Use this template to author a new runtime adapter for Squad Protocol v4.0.

Replace `{runtime-id}`, `{Runtime Name}`, `{Vendor}`, and all bracketed placeholders. Remove sections that do not apply after replacing them with a "Not applicable — runtime does not support X" sentence.

**Every adapter MUST provide sections 1, 2, 3, 6, 11, 13.** Other sections are optional when the runtime genuinely lacks the underlying capability.

---

## 1. Adapter Metadata *(required)*

| Field | Value |
|-------|-------|
| Runtime ID | `{runtime-id}` |
| Runtime Name | {Runtime Name} |
| Vendor | {Vendor} |
| Adapter Version | 0.1.0 |
| Protocol Version | 4.0 |
| Minimum Runtime Version | {x.y.z} |
| Maintainer | {name or handle} |
| Homepage | {url} |
| Status | {experimental \| beta \| stable \| deprecated} |

---

## 2. Feature Support Matrix *(required)*

Legend: ✅ enforced · 🟡 advisory · ⚠️ hybrid · ❌ unsupported · 🤝 convention

| Feature | Support | Mechanism |
|---------|---------|-----------|
| `max_turns` | {support} | {mechanism} |
| `tool_whitelist` | {support} | {mechanism} |
| `handoff_artifacts` | {support} | {mechanism} |
| `subagent_spawning` | {support} | {mechanism} |
| `sequential_execution` | {support} | {mechanism} |
| `project_memory` | {support} | {mechanism} |
| `global_memory` | {support} | {mechanism} |
| `session_memory` | {support} | {mechanism} |
| `hooks` | {support} | {mechanism} |
| `sandboxing` | {support} | {mechanism} |
| `web_search` | {support} | {mechanism} |
| `file_write` | {support} | {mechanism} |
| `shell_exec` | {support} | {mechanism} |
| `fork_context` | {support} | {mechanism} |
| `teammate_primitive` | {support} | {mechanism} |

---

## 3. Concept Mapping *(required)*

### 3.1 Core → Runtime Primitives

| Core concept | {Runtime Name} primitive |
|-------------|--------------------------|
| Agent | {how this runtime represents an agent} |
| Task | {how tasks are represented} |
| Workflow | {workflow/orchestration representation} |
| Subagent invocation | {spawn mechanism, or "not supported"} |
| Session | {session concept} |
| Agent body | {how body is delivered to the model} |

### 3.2 Frontmatter Field Semantics

| Frontmatter field | Visible to LLM? | Purpose |
|-------------------|----------------|---------|
| `name` | {yes/no} | {purpose} |
| `description` | {yes/no} | {purpose} |
| `tools` | {yes/no} | {purpose} |
| `maxTurns` | {yes/no} | {purpose} |

---

## 4. Frontmatter Mapping *(optional)*

How a v4 squad carries `{runtime-id}`-specific config:

```yaml
---
name: example-agent
description: "..."
maxTurns: 25
tools: [read, grep]
runtimes:
  {runtime-id}:
    # runtime-specific config
---
```

Describe how `runtimes.{runtime-id}.*` overrides or augments universal fields.

---

## 5. Tool Whitelist Mechanics *(recommended)*

**Enforcement level:** {enforced | advisory | hybrid | unsupported}

{Explain mechanism. CLI flags used. What the whitelist actually does at runtime.}

**Portable → local tool names:**

| Portable | {Runtime} tool |
|----------|---------------|
| `read` | {...} |
| `write` | {...} |
| `edit` | {...} |
| `grep` | {...} |
| `glob` | {...} |
| `bash` | {...} |
| `web_search` | {...} |
| `web_fetch` | {...} |

---

## 6. Max-Turns Mechanics *(required)*

| Property | Value |
|----------|-------|
| Frontmatter field | {maxTurns or runtime-specific name} |
| CLI flag | {flag name or "none"} |
| Runtime default | {value or "none (must be declared)"} |
| Hard cap | {value or "none"} |

**Source:** {citation from runtime codebase or documentation}

**Typical values:**

| Task type | Recommended maxTurns |
|-----------|---------------------|
| Read + report | 3–5 |
| Code review | 10–20 |
| Fix + test | 15–30 |

---

## 7. Subagent Spawning *(optional — document even if unsupported)*

**Primitive:** {tool/mechanism name or "not supported"}

**Mechanism:** {Describe how parent spawns child}

**Context inheritance:** {none | partial | full}

**Concurrency:** {max concurrent or "1 (sequential only)"}

**If unsupported:** Document the fallback (typically sequential execution of workflow steps).

---

## 8. Memory Storage *(optional)*

### 8.1 Memory Scopes

| Core scope | Implementation | Location |
|-----------|---------------|----------|
| Ephemeral | {...} | {...} |
| Session | {...} | {...} |
| Project | {...} | {...} |
| Global | {...} | {...} |

### 8.2 Size Limits

| Limit | Value | Source |
|-------|-------|--------|
| {...} | {...} | {...} |

---

## 9. Context Window & Compaction *(optional — numbers go here only)*

### 9.1 Numeric Values

| Metric | Value | Source |
|--------|-------|--------|
| Context window | {tokens} | {source} |
| Max output tokens | {tokens} | {source} |
| Compaction trigger | {tokens} | {source} |

### 9.2 Compaction Mechanism

{Describe how this runtime handles context pressure. Template? Summarization? Rolling window?}

### 9.3 Environment Overrides

{List env vars that affect context/compaction behavior.}

---

## 10. Hook System *(optional)*

**Supported events:**

| Event | When | Can abort? |
|-------|------|-----------|
| {event} | {when} | {yes/no} |

If the runtime has no hook system, write: "Not applicable — {Runtime Name} does not provide a hook system."

---

## 11. Invocation Examples *(required)*

### 11.1 Interactive Session

```bash
{binary}
```

### 11.2 Non-Interactive

```bash
{binary} --flag value "prompt"
```

### 11.3 Environment Variables

```bash
export {RUNTIME_API_KEY}=...
```

### 11.4 Running a Squad

```bash
squads run ./my-squad --runtime {runtime-id}
```

---

## 12. Runtime-Specific Validators *(optional)*

| ID | Applies to | Level | Description |
|----|-----------|-------|-------------|
| `{runtime-id}-{check-name}` | {agent/task/squad/manifest} | {blocking/warning/info} | {description} |

---

## 13. Known Limitations *(required)*

| Limitation | Workaround | Source |
|-----------|-----------|--------|
| {honest limitation} | {what squad author should do} | {citation or "observed"} |

Be honest. This section is for the squad author deciding whether this runtime is right for their squad. Underselling limitations here damages trust.

---

## 14. Source References *(optional)*

If claims in this adapter are verified against the runtime's source code or authoritative documentation, cite them:

| ID | Claim | Source |
|----|-------|--------|
| SRC-{X}-1 | {claim} | {file:lines or URL} |

---

## 15. Version History *(required)*

| Version | Date | Changes |
|---------|------|---------|
| 0.1.0 | {YYYY-MM-DD} | Initial adapter |
