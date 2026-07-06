# Adapter: Claude Code

Runtime-specific documentation for running Squad Protocol v4.0 squads on **Claude Code** (Anthropic). This is the reference adapter: every claim is verified against the Claude Code source code.

---

## 1. Adapter Metadata

| Field | Value |
|-------|-------|
| Runtime ID | `claude-code` |
| Runtime Name | Claude Code |
| Vendor | Anthropic |
| Adapter Version | 1.0.0 |
| Protocol Version | 4.0 |
| Minimum Runtime Version | 2.0.0 |
| Maintainer | gutomec |
| Homepage | https://code.claude.com |
| Status | stable |

---

## 2. Feature Support Matrix

Legend: ✅ enforced · 🟡 advisory · ⚠️ hybrid · ❌ unsupported · 🤝 convention

| Feature | Support | Mechanism |
|---------|---------|-----------|
| `max_turns` | ✅ | Harness-enforced; no default |
| `tool_whitelist` | ✅ | Tools absent from API schema cannot be invoked |
| `handoff_artifacts` | 🤝 | Free text inside `content[].text`; squads impose shape by prompt |
| `subagent_spawning` | ✅ | Task tool spawns subagents |
| `sequential_execution` | ✅ | Default |
| `project_memory` | ✅ | `CLAUDE.md` injected as userContext |
| `global_memory` | ✅ | `~/.claude/CLAUDE.md` |
| `session_memory` | ✅ | In-memory conversation |
| `hooks` | ✅ | PreToolUse (gate) + PostToolUse (observe only) |
| `sandboxing` | 🟡 | Permission modes (plan, acceptEdits, bypassPermissions) |
| `web_search` | ✅ | Built-in `WebSearch` tool |
| `file_write` | ✅ | Built-in `Write`, `Edit` tools |
| `shell_exec` | ✅ | Built-in `Bash` tool |
| `fork_context` | ✅ | Fork subagents inherit full conversation; maxTurns hardcoded 200 |
| `teammate_primitive` | ✅ | Experimental; SendMessageTool, Unix Domain Sockets |

---

## 3. Concept Mapping

### 3.1 Core → Runtime Primitives

| Core concept | Claude Code primitive |
|-------------|----------------------|
| Agent | `.md` file in `.claude/agents/` or squad `agents/` |
| Task | `.md` file (referenced by workflow) |
| Workflow | Harness or orchestrator; no native workflow file format |
| Subagent invocation | `Task` tool call |
| Session | Conversation in the Claude Code CLI |
| Agent body | System prompt injected via `getSystemPrompt()` |
| Agent frontmatter | Runtime config; NEVER sent to LLM |

### 3.2 Frontmatter Field Semantics

| Frontmatter field | Purpose | Visible to LLM? |
|-------------------|---------|-----------------|
| `name` | Agent identity and routing | No |
| `description` | Selection criterion; exposed as `whenToUse` to planner | Indirectly (listed in agent registry, not injected into context) |
| `tools` | Tool whitelist (hard-enforced in API schema) | No |
| `model` | Model selection | No |
| `maxTurns` | Turn limit for agent loop | No |
| `memory` | Memory scope (user/project/local) | No |
| `effort` | Reasoning depth hint | No |

**Source:** SRC-1, SRC-11.

---

## 4. Frontmatter Mapping

A v4 squad agent can carry Claude-Code-specific config under `runtimes.claude-code.*`:

```yaml
---
name: reviewer
description: "Reviews code changes against acceptance criteria"
maxTurns: 25
tools: [read, grep, glob]           # portable semantic names
runtimes:
  claude-code:
    tools: [Read, Grep, Glob, Bash]  # CC local tool names (override)
    model: inherit
    effort: high
    memory: project
---
```

**Resolution order for `tools`:**
1. If `runtimes.claude-code.tools` is present, use it verbatim.
2. Otherwise, map portable names from `tools` via the semantic map (see §3).
3. Otherwise, no tools granted (fail-closed per Core P5).

---

## 5. Tool Whitelist Mechanics

**Enforcement level:** **Hard (enforced).**

Tools not listed literally do not exist in the schema sent to the API. The model cannot invoke what is not in the schema. This is not prompt instruction — it is an API-level constraint.

**Source:** SRC-11 (`agentToolUtils.ts:157-160`; `runAgent.ts:502`).

**Portable → local tool names:**

| Portable | Claude Code tool |
|----------|------------------|
| `read` | `Read` |
| `write` | `Write` |
| `edit` | `Edit` |
| `grep` | `Grep` |
| `glob` | `Glob` |
| `bash` / `shell` | `Bash` |
| `web_search` | `WebSearch` |
| `web_fetch` | `WebFetch` |

**Deny-by-default:** If an agent declares `tools: []` or omits tools entirely, it has no tool access and can only emit text.

**Guardrails in body:** Tool whitelist is the first line of defense. Body-level safety prose (`NEVER delete outside output/`) is the second line for misuse of tools the agent legitimately has.

---

## 6. Max-Turns Mechanics

**Frontmatter field:** `maxTurns`
**CLI flag:** none (frontmatter only)
**Runtime default:** **none — without declaration, the agent loop has no upper bound**
**Hard cap:** 200 (fork subagents only; normal subagents have none)

**Critical:** The check in `query.ts:1705` is `if (maxTurns && ...)`. An agent without `maxTurns` in frontmatter can loop indefinitely. v4 Core P4 makes `maxTurns` mandatory precisely because of this.

**Source:** SRC-8 (`query.ts:1705`; `forkSubagent.ts:65`).

**Typical values:**

| Task type | Recommended maxTurns |
|-----------|---------------------|
| Read + report | 3–5 |
| Code review pass | 10–20 |
| Targeted fix + test | 15–30 |
| Research across many searches | 25–50 |
| Large refactor | 50–100 |

---

## 7. Subagent Spawning

**Primitive:** `Task` tool.

**Mechanism:**
- A parent agent invokes the `Task` tool with a prompt and an agent type.
- The runtime spawns a subagent context.
- The subagent receives `promptMessages = [createUserMessage({ content: prompt })]` — **a single user message, nothing else** (SRC-1-Q1, `AgentTool.tsx:538-540`).
- The subagent returns a handoff artifact (see §9 of Core spec).

**Context inheritance:** **None by default.** The subagent starts with just the prompt. No working directory, no file list, no tool results, no environment variables are automatically injected.

**Fork path (experimental):** `FORK_SUBAGENT_TYPE` inherits the full parent conversation. maxTurns hardcoded at 200. Use sparingly.

**Concurrency:** Up to 10 subagents can run in parallel (harness limit).

**Source:** SRC-1-Q1, SRC-8, SRC-1-Q4.

---

## 8. Memory Storage

### 8.1 Memory Scopes Mapped to Files

| Core scope | Claude Code implementation | Location |
|-----------|---------------------------|----------|
| Ephemeral | Conversation state | In-memory |
| Session | Conversation + tool results | In-memory |
| Project | `CLAUDE.md` | Repo root, walks up from CWD |
| Global | `~/.claude/CLAUDE.md` | User home |
| Project (per-agent) | `.claude/agent-memory/{agent}.md` | Project `.claude/` |
| Local (per-agent, not committed) | `.claude/agent-memory-local/{agent}.md` | Project `.claude/` |
| User (per-agent) | `~/.claude/agent-memory/{agent}.md` | User home |

**Source:** SRC-9, SRC-10.

### 8.2 Injection Semantics

`CLAUDE.md` is injected as `userContext` — it appears **before** user messages but **after** the system prompt. This position gives it primacy bias: content near the top of the file is seen first.

**Source:** SRC-9 (`claudemd.ts`, `runAgent.ts:394-395`).

### 8.3 Size Limits

| Limit | Value | Source |
|-------|-------|--------|
| `MAX_MEMORY_CHARACTER_COUNT` | 40,000 chars (~10K tokens) | SRC-9-Q2 (`claudemd.ts:92`) |
| Standard CLAUDE.md truncation | none (file injected whole) | SRC-9-Q2 |
| AutoMem / TeamMem truncation | yes | SRC-9-Q2 |

Files larger than `MAX_MEMORY_CHARACTER_COUNT` are identified for warnings but still injected in full for standard memory.

### 8.4 Recommended Memory File Structure

```markdown
# Project Memory

## Project Rules (always relevant)
- Use Prettier with 80 columns.
- All tests must use pytest.
- API responses follow { data, error, meta }.

## Learned Facts (auto-curated, conflict_resolution=replace)
- 2026-04-01: Staging DB at db.staging.internal:5432.
- 2026-04-03: Payment API fails if `currency` not uppercase.
```

---

## 9. Context Window & Compaction

### 9.1 Numeric Values (Sonnet 200K)

| Metric | Value | Source |
|--------|-------|--------|
| Context window | 200,000 tokens | spec |
| `CAPPED_DEFAULT_MAX_TOKENS` | 8,000 | SRC-4 (`autoCompact.ts:30`) |
| `reservedTokensForSummary` | `min(maxOutput, 20_000)` = 8,000 | SRC-4 |
| `effectiveContextWindow` | 200,000 - 8,000 = **192,000** | SRC-4 |
| `AUTOCOMPACT_BUFFER_TOKENS` | 13,000 | SRC-4 (`autoCompact.ts:62`) |
| **Autocompact trigger** | 192,000 - 13,000 = **179,000 (~89.5%)** | SRC-4 |
| Warning threshold (UI) | `autocompactThreshold - 20K` ≈ 159,000 (~79.5%) | SRC-4 |
| Manual compact blocking | `effectiveContextWindow - 3K` ≈ 189,000 (~94.5%) | SRC-4 |

### 9.2 Formula

```
effectiveContextWindow = contextWindow - min(getMaxOutputTokensForModel(model), 20_000)
autocompactThreshold   = effectiveContextWindow - AUTOCOMPACT_BUFFER_TOKENS
```

### 9.3 Environment Override

`CLAUDE_CODE_AUTO_COMPACT_WINDOW` limits `contextWindow` before the calculation. It does **not** change the buffer size.

### 9.4 Compaction Variants

The runtime has **three** compaction prompts, not one (SRC-5, `compact/prompt.ts`):

| Variant | When | Differences |
|---------|------|-------------|
| `BASE_COMPACT_PROMPT` | Full conversation compaction | 9 standard sections |
| `PARTIAL_COMPACT_PROMPT` | Recent portion only | §9 emphasizes verbatim citations |
| `PARTIAL_COMPACT_UP_TO_PROMPT` | Older prefix only | §8 becomes "Work Completed", §9 becomes "Context for Continuing Work" |

Tool use is **forbidden during compaction**.

### 9.5 The 9 Compaction Sections

Compaction output is templated into 9 sections. Content that does not fit one of these sections **disappears**:

```
1. Primary Request and Intent
2. Key Technical Concepts
3. Files and Code Sections        ← file names + line numbers + snippets
4. Errors and Fixes
5. Problem Solving
6. All User Messages              ← VERBATIM — nearly empty for subagents
7. Pending Tasks
8. Current Work
9. Optional Next Step             ← verbatim citations in PARTIAL variant
```

**Critical caveat:** `getCompactPrompt()` does **not** branch by agent type (SRC-3-Q3, `compact/prompt.ts:293-303`). A subagent with only one user message (the workflow instruction) has a nearly empty §6.

### 9.6 Surviving Compaction — Placement Rules

| Data to preserve | Place in | Survives via section |
|-----------------|----------|---------------------|
| Code paths, file names, line numbers | Snippets in prompt/output | 3 (Files and Code Sections) |
| Workflow instructions | Original subagent prompt | 6 (All User Messages) |
| Decisions and context | `<protocol-context>` block in prompt | 8 (Current Work) |
| Verbatim references | Direct citations in output | 9 (Optional Next Step) |

### 9.7 `<protocol-context>` Pattern

When a subagent must survive compaction, include a tagged context block at the top of its prompt:

```markdown
<protocol-context>
Agent role: code-review-squad / bug-detector.
Input: output/findings.json from the analyzer.
Output: append to output/bug-findings.json.
Constraint: critical findings must include reproduction steps verbatim.
</protocol-context>
```

The tagged block survives compaction via §8 (Current Work).

---

## 10. Hook System

**Supported events:**

| Event | When | Can abort? |
|-------|------|-----------|
| `PreToolUse` | Before tool invocation | Yes |
| `PostToolUse` | After tool invocation | No |
| `SessionStart` | Session begins | N/A |
| `SessionEnd` | Session ends | N/A |
| `UserPromptSubmit` | User submits a prompt | Yes |
| `Stop` | Agent stops | N/A |

**Critical:** `PostToolUse` hooks run **after** the tool already executed. There is no `abort` field in the post-hook response schema. Use `PreToolUse` for gating, or add a validator agent as a workflow step.

**Source:** SRC-12 (`toolExecution.ts:800,1483`; `types/hooks.ts:101-107`).

---

## 11. Invocation Examples

### 11.1 Interactive Session

```bash
claude
```

### 11.2 Non-Interactive with Specific Model

```bash
claude --model claude-sonnet-4-6 "review the latest PR"
```

### 11.3 Environment Variables

```bash
export ANTHROPIC_API_KEY=sk-ant-...
export CLAUDE_CODE_AUTO_COMPACT_WINDOW=150000   # smaller effective window
export CLAUDE_CODE_AGENT_LIST_IN_MESSAGES=1     # attach agent list as system-reminder
```

### 11.4 Running a Squad (conceptual)

Claude Code has no native "run squad" command; the harness (this skill) drives it. Typical flow:

```bash
# Harness loads squad, resolves adapter, spawns subagents via Task tool
squads run ./my-squad --runtime claude-code
```

---

## 12. Runtime-Specific Validators

Claude Code adapter adds the following validators beyond Core:

| ID | Applies to | Level | Description |
|----|-----------|-------|-------------|
| `cc-frontmatter-flat` | agent | warning | Frontmatter should be flat YAML; nested `agent:`/`persona:` blocks indicate v2 legacy format |
| `cc-description-length` | agent | warning | `description` field should be <= 1024 characters |
| `cc-max-turns-required` | agent | blocking | `maxTurns` is mandatory (runtime has no default) |

---

## 13. Known Limitations

| Limitation | Workaround | Source |
|-----------|-----------|--------|
| No `maxTurns` default — omission = infinite loop | Always declare explicitly | SRC-8 |
| Subagents receive no context inheritance | Pass handoff artifact as JSON in prompt | SRC-1-Q1 |
| Compaction §6 (All User Messages) nearly empty for subagents | Use `<protocol-context>` block in prompt | SRC-3-Q3 |
| PostToolUse hooks cannot abort | Use PreToolUse for gating | SRC-12 |
| Context inheritance is all-or-nothing | Serialize what the child needs into the handoff | SRC-1-Q4 |
| No harness-level doom-loop detection | maxTurns bound only; add workflow reviewer | SRC-7 |

---

## 14. Source References

All claims in this adapter are verified against the Claude Code source code.

| ID | Claim | Source |
|----|-------|--------|
| SRC-1 | Frontmatter discarded from LLM context; description → whenToUse via `formatAgentLine()` | `prompt.ts:43-45` |
| SRC-2 | Plain-text agent matching; no embeddings; two delivery modes via `listViaAttachment` | `prompt.ts:59-64, 194-199` |
| SRC-3 | Handoff artifact schema fixed; `content[].text` is free text | `agentToolUtils.ts:227-260` |
| SRC-4 | `CAPPED_DEFAULT_MAX_TOKENS=8000`; threshold = 179K (~89.5%) for Sonnet 200K | `autoCompact.ts:30,62-65,72-76`; `context.ts:24` |
| SRC-5 | Three compaction prompt variants, 9 sections, tools forbidden during compaction | `compact/prompt.ts` |
| SRC-7 | Zero doom-loop detection; only `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES=3` for API failures | global repo search |
| SRC-8 | `maxTurns` without declaration = infinite loop; fork hardcoded 200 | `query.ts:1705`; `forkSubagent.ts:65` |
| SRC-9 | `CLAUDE.md` injected as userContext, not systemPrompt | `claudemd.ts`; `runAgent.ts:394-395` |
| SRC-9-Q2 | `MAX_MEMORY_CHARACTER_COUNT=40000`; no automatic truncation for standard CLAUDE.md | `claudemd.ts:92` |
| SRC-10 | Memory scopes paths (user/project/local) | settings |
| SRC-11 | Tool restriction = hard enforcement at API schema level | `agentToolUtils.ts:157-160`; `runAgent.ts:502` |
| SRC-12 | `PreToolUse` prevents execution; `PostToolUse` runs after; no abort in post schema | `toolExecution.ts:800,1483`; `types/hooks.ts:101-107` |
| SRC-1-Q1 | `userMessage(prompt)` = text only; zero implicit context | `AgentTool.tsx:538-540` |
| SRC-3-Q3 | Compaction does not differentiate agent type; §6 problematic for subagents | `compact/prompt.ts:293-303` |
| SRC-1-Q4 | All-or-nothing context transfer; no selective inheritance | AgentTool schema |

---

## 15. Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0.0 | 2026-04-04 | Initial adapter for Squad Protocol v4.0. Supersedes `references/cc-squad-standard.md`. Incorporates all v3.1 findings. |
