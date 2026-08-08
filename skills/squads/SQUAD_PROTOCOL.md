# Squad Protocol Specification (v2.0.0 — SUPERSEDED)

> ## ⚠️ Deprecation Notice
>
> **This document has been superseded by [`SQUAD_PROTOCOL_V4.md`](SQUAD_PROTOCOL_V4.md).**
>
> v2.0.0 is preserved here for reference and for squads that have not yet migrated. v4.0 harnesses accept v2.0 squads via a legacy shim (see [`references/09-upgrade.md`](references/09-upgrade.md) for migration guidance).
>
> **For new squads, use v4.0.** v4.0 adds runtime-agnostic architecture with adapter separation, mandatory `maxTurns`, pattern maturity labels, and technical honesty throughout.
>
> v2.0 will continue to be accepted via shim indefinitely. v2.0 **nested YAML** format is scheduled for removal at v5.0; use `squads migrate --from v2 --to v4` to convert.

---

```
Title:    Squad Protocol Specification
Version:  2.0.0
Status:   SUPERSEDED by v4.0
Date:     2026-04-03
Authors:  gutomec
license: SUL-1.0
Format:   Claude Code Standard (CC)
```

## Table of Contents

1.  [Introduction](#1-introduction)
2.  [Terminology](#2-terminology)
3.  [Design Principles](#3-design-principles)
4.  [Squad Structure](#4-squad-structure)
5.  [Agent Specification](#5-agent-specification)
6.  [Task Specification](#6-task-specification)
7.  [Workflow Orchestration](#7-workflow-orchestration)
8.  [Communication and Handoff](#8-communication-and-handoff)
9.  [Tool System and MCP](#9-tool-system-and-mcp)
10. [State Management](#10-state-management)
11. [Context Engineering](#11-context-engineering)
12. [Error Handling](#12-error-handling)
13. [Validation](#13-validation)
14. [Security](#14-security)
15. [Versioning](#15-versioning)
16. [Legacy Format Support](#16-legacy-format-support)

---

## 1. Introduction

### 1.1 Purpose

The Squad Protocol defines a portable standard for multi-agent AI systems.
A **squad** is a self-contained package of agents, tasks, workflows, and
artifacts that collectively accomplish a domain of work.

This protocol follows the **Claude Code standard**: agents are Markdown files
with flat YAML frontmatter for runtime configuration and prose body as the
system prompt. The LLM never sees the frontmatter. The body is all the LLM gets.

### 1.2 Format Alignment

This protocol is aligned with the Anthropic Claude Code agent/skill system:

| Claude Code | Squad Protocol |
|------------|----------------|
| Agent `.md` in `.claude/agents/` | Agent `.md` in `agents/` |
| Skill `SKILL.md` in `.claude/skills/` | Task `.md` in `tasks/` |
| `name` + `description` frontmatter | `name` + `description` frontmatter |
| Body = system prompt | Body = system prompt |
| Frontmatter = runtime config | Frontmatter = runtime config |

### 1.3 Enforcement Model

| Tag | Meaning |
|-----|---------|
| `[HARNESS]` | Runtime code enforces this deterministically |
| `[PROMPT]` | LLM system prompt instructs this (best effort) |
| `[SCHEMA]` | JSON Schema validation at load time |
| `[HYBRID]` | Combination of harness + prompt enforcement |

---

## 2. Terminology

| Term | Definition |
|------|-----------|
| **Squad** | Self-contained package: agents + tasks + workflows + manifest |
| **Agent** | Markdown file with frontmatter (config) + body (system prompt) |
| **Task** | Markdown file describing a unit of work with steps and criteria |
| **Workflow** | YAML file defining execution order: which agent runs which task |
| **Harness** | Runtime that loads, validates, and executes squads |
| **Context Window** | Finite token budget available to an agent |
| **Compaction** | Reducing context size while preserving essential information |
| **Doom Loop** | Agent repeatedly producing identical output |
| **Ralph Loop** | QA review-fix cycle with bounded iterations |
| **MCP** | Model Context Protocol for agent-to-tool communication |

---

## 3. Design Principles

### P1: Separation of Concerns

Frontmatter is runtime configuration (the harness reads it).
Body is the system prompt (the LLM reads it).
UI metadata goes in `squad.yaml` (the marketplace reads it).
Never mix these three.

### P2: Prose Over Structure

Agent instructions belong in the body as natural language prose.
LLMs process prose better than YAML arrays. Persona, principles,
vocabulary, and commands are instructions — they go in the body.

### P3: Token Budget Awareness `[HARNESS]`

Agent bodies target 1000-2000 tokens. Maximum 2500. If larger, split
the agent. Every token in the system prompt must earn its place.

### P4: Bounded Iteration `[HARNESS + PROMPT]`

All loops have explicit maximums. Doom loop detection at 3 identical
outputs. QA loop max 5 iterations. Recovery max 3 retries.

### P5: Fail-Closed `[HARNESS]`

Permissions, capabilities, and concurrency default to most restrictive.
Parse failures treat operations as non-concurrent.

### P6: Task-First Architecture

Tasks describe WHAT to do. Workflows decide WHO does WHAT.
Agents don't own tasks. Tasks don't reference agents.

### P7: Portable Format

Squads work in Claude Code, Codex, Cursor, Windsurf, GSD-PI,
and any system that reads Markdown files with YAML frontmatter.

### P8: Observable Execution `[PROMPT]`

Every significant event emits structured telemetry.
CLI-first observation over UI dashboards.

---

## 4. Squad Structure

### 4.1 Manifest `[SCHEMA]`

Every squad MUST have a `squad.yaml` at root.

**Required fields:**
```yaml
name: my-squad          # kebab-case, 2-50 chars
version: "1.0.0"        # semver
```

**Important optional fields:**
```yaml
description: "What this squad does"
author: "name"
license: SUL-1.0
slashPrefix: msq
tags: [domain, keywords]

components:
  agents:
    - researcher.md
    - reviewer.md
  tasks:
    - research-topic.md
    - review-findings.md
  workflows:
    - main-pipeline.yaml

# UI metadata — agents don't need this to function
agents_metadata:
  researcher:
    icon: "🔬"
    archetype: Builder
  reviewer:
    icon: "🛡️"
    archetype: Guardian
```

**Runtime configuration (optional):**
```yaml
state:
  enabled: true
  storage: file
  checkpoint_dir: ".squad-state"
  resume: true

model_strategy:
  orchestrator: "claude-sonnet-4"
  workers: "claude-sonnet-4"

harness:
  doom_loop:
    enabled: true
    max_identical_outputs: 3
    on_detect: abort
  ralph_loop:
    enabled: true
    max_iterations: 5
  context_compaction:
    enabled: true
    strategy: key-fields
    max_handoff_tokens: 4000
  self_verify:
    default_enabled: true
```

### 4.2 Directory Layout

```
{squad-name}/
  squad.yaml             # REQUIRED: manifest
  agents/                # Agent .md files
    {agent-name}.md
  tasks/                 # Task .md files
    {task-name}.md
  workflows/             # Workflow .yaml files
    {workflow-name}.yaml
  references/            # Reference material (agents Read on demand)
    {name}.md
  checklists/            # Quality checklists
  templates/             # Reusable templates
  tools/                 # Tool scripts
  scripts/               # Automation scripts
  data/                  # Static data files
```

### 4.3 Validation `[SCHEMA]`

The validator checks both CC and legacy formats:

| Check | CC Format | Legacy Format |
|-------|-----------|---------------|
| Manifest | name + version required | Same |
| Agent identity | `name` + `description` flat | `agent.name` + `agent.id` nested |
| Task identity | `name` flat | `task` + `owner` |
| Task→agent cross-ref | Skipped (no owner) | `owner` must match agent name |
| Workflow | `name` or `workflow_name` | Same |
| Files exist | Components match disk | Same |

---

## 5. Agent Specification

### 5.1 Agent File Format (CC Standard)

**Location:** `agents/{agent-name}.md`

**The harness separates frontmatter from body. The LLM only sees the body.**

#### Frontmatter (runtime config)

```yaml
---
name: agent-name
description: "When to use this agent — one paragraph"
tools: [Read, Write, Bash]         # optional
model: inherit                       # optional
effort: high                        # optional
maxTurns: 25                        # optional
memory: user                        # optional
---
```

**Required:** `name`, `description`

**Optional:** `tools`, `model`, `effort`, `maxTurns`, `memory`, `context`,
`background`, `isolation`, `mcpServers`, `hooks`, `skills`

#### Body (system prompt)

```markdown
[Opening paragraph: identity + approach. 2-3 sentences.]

## Guidelines
- [5-7 specific, actionable principles]

## Process
1. [Numbered steps when activated]

## Output
[Expected format and location]
```

**Token budget:** 1000-2000 tokens. Maximum 2500.

### 5.2 What Goes Where

| Information | Location | Why |
|-------------|----------|-----|
| Agent name | Frontmatter `name:` | Routing/identity |
| When to use | Frontmatter `description:` | Spawn decision |
| Tool whitelist | Frontmatter `tools:` | Runtime filtering |
| Model override | Frontmatter `model:` | API selection |
| Identity/role | Body paragraph | LLM instruction |
| Principles | Body ## Guidelines | LLM instruction |
| Steps | Body ## Process | LLM instruction |
| Output format | Body ## Output | LLM instruction |
| Icon/emoji | `squad.yaml` agents_metadata | UI display |
| Archetype | `squad.yaml` agents_metadata | UI category |
| Phase/tier | Workflow definition | Orchestration |

### 5.3 Agent Types

#### Squad Agents (from .md files)

Custom agents defined by squad authors. Loaded from `agents/` directory.

#### Harness Agents (runtime-spawned)

Built-in agents created by the harness:

| Type | Purpose | Tools |
|------|---------|-------|
| `general-purpose` | Full task execution | All |
| `Explore` | Read-only investigation | Read-only subset |
| `Plan` | Planning without mutations | Read-only subset |
| `coordinator` | Multi-agent orchestration | Agent, SendMessage, TaskStop |
| `worker` | Execution under coordinator | Standard tools |

### 5.4 Agent Lifecycle

```
UNLOADED → LOADED → ACTIVE → EXECUTING → UNLOADED
                       ↕
                   SUSPENDED (handoff)
```

### 5.5 Handoff Protocol `[PROMPT]`

When switching agents, generate a compact handoff artifact (~379 tokens):

```yaml
handoff:
  from_agent: "current"
  to_agent: "next"
  context:
    current_task: "what was being done"
    decisions: [max 5]
    files_modified: [max 10]
    blockers: [max 3]
  next_action: "what the incoming agent should do"
```

---

## 6. Task Specification

### 6.1 Task File Format (CC Standard)

**Location:** `tasks/{task-name}.md`

#### Frontmatter

```yaml
---
name: task-name
description: "What this task accomplishes"
---
```

**Required:** `name`

**Optional:** `description`, `context` (fork/inline), `allowed-tools`

#### Body

```markdown
# Task Name

## Input
[What this task receives]

## Steps
1. [Specific actions]

## Output
[What to produce, where to save]

## Acceptance Criteria
[Verifiable completion conditions]
```

### 6.2 Tasks Don't Have Owners

In CC format, tasks describe WHAT to do. The workflow decides WHO executes.
This decouples tasks from agents — the same task can run under different agents.

```yaml
# workflow.yaml binds agent ↔ task
steps:
  - id: research
    agent: researcher       # WHO
    task: research-topic    # WHAT
```

### 6.3 Task Lifecycle

```
PENDING → QUEUED → RUNNING ⇄ PAUSED
                     │
              ┌──────┼──────┐
              ▼      ▼      ▼
          COMPLETED FAILED  CANCELLED
                     │
                     ▼
                  RETRYING → RUNNING
```

---

## 7. Workflow Orchestration

### 7.1 Workflow File Format

**Location:** `workflows/{name}.yaml`

```yaml
name: main_pipeline
description: "What this workflow accomplishes"

steps:
  - id: step-1
    agent: agent-name
    task: task-name
    depends_on: []

  - id: step-2
    agent: other-agent
    task: other-task
    depends_on: [step-1]

success_indicators:
  - "Criterion 1"
  - "Criterion 2"
```

**Required:** `name` (or `workflow_name`)

### 7.2 Execution Patterns

| Pattern | When |
|---------|------|
| **Pipeline** | Steps run sequentially |
| **Parallel** | Steps without dependencies run concurrently |
| **DAG** | Steps declare `depends_on` for dependency graph |
| **Loop** | QA review → fix → re-review (bounded) |

### 7.3 Wave Execution

Steps within the same dependency level form a wave.
Waves execute sequentially. Steps within a wave execute in parallel.

```
Wave 1: [step-1, step-2, step-3]  ← parallel (no deps)
Wave 2: [step-4, step-5]          ← parallel (depend on wave 1)
Wave 3: [step-6]                  ← depends on wave 2
```

---

## 8. Communication and Handoff

### 8.1 Message Types

| Type | Direction | Purpose |
|------|-----------|---------|
| `REQUEST` | Agent → Agent | Ask for work |
| `INFORM` | Agent → Agent | Share results |
| `DELEGATE` | Agent → Agent | Hand off task |
| `ESCALATE` | Agent → Human | Request intervention |

### 8.2 Error Message Format

```json
{
  "type": "error",
  "source": { "agent_id": "dev", "task_name": "implement", "step_id": "3" },
  "error": {
    "code": "TASK_STEP_FAILED",
    "category": "transient|state|configuration|dependency|fatal",
    "message": "Human-readable description",
    "recovery_hint": "Suggested action"
  },
  "context": { "attempt": 1, "max_attempts": 3 }
}
```

---

## 9. Tool System and MCP

### 9.1 Tool Concurrency `[HARNESS]`

The harness partitions tool calls into concurrent and sequential batches.
Parse failures default to sequential (fail-closed).

### 9.2 Tool Tiers

| Tier | Loading | Examples |
|------|---------|---------|
| 1 (Always) | Session start | Read, Write, Edit, Bash, Grep, Glob |
| 2 (Deferred) | Agent activation | git, supabase, context7 |
| 3 (Deferred) | On demand | Playwright, Apify, EXA |

### 9.3 MCP Integration `[HARNESS]`

MCP servers are configured in `squad.yaml` under `mcps` and in
`.claude/settings.json`. The harness manages server lifecycle.

---

## 10. State Management

### 10.1 State Layers

| Layer | Scope | Location |
|-------|-------|----------|
| Session | Current conversation | In-memory |
| Agent memory | Per-agent persistent | `agents/{id}/MEMORY.md` |
| Handoff | Agent switch context | `.squad-state/handoffs/` |
| Checkpoints | Workflow progress | `.squad-state/{run-id}/` |
| Artifacts | Filesystem collaboration | `.squad-state/{run-id}/artifacts/` |

---

## 11. Context Engineering

### 11.1 Token Budgets

| Parameter | Value |
|-----------|-------|
| Default context window | 200,000 tokens |
| 1M context (Sonnet 4, Opus) | 1,000,000 tokens |
| Max output tokens | 32,000 (default), 64,000 (upper) |
| Agent body target | 1,000-2,000 tokens |
| Agent body maximum | 2,500 tokens |
| Handoff artifact | ~379 tokens |
| Max handoff tokens | 4,000 tokens |

### 11.2 Auto-Compaction `[HARNESS]`

Triggers when token count exceeds the effective context window.
The harness uses a forked agent to summarize conversation history.

### 11.3 Compaction Strategies

| Strategy | How |
|----------|-----|
| `key-fields` | Keep only schema-required fields from JSON outputs |
| `truncate` | Hard cut at token limit |
| `summarize` | Keep first 2000 chars + metadata |

---

## 12. Error Handling

### 12.1 Retry with Backoff `[HARNESS]`

Exponential backoff: 500ms → 1s → 2s → 4s → ... → 32s cap.
25% jitter added. Max 10 retries.

### 12.2 Doom Loop Detection `[HARNESS]`

3 consecutive identical outputs → abort or change strategy.
Similarity threshold: 0.95 (configurable).

### 12.3 Recovery Cascade `[PROMPT]`

```
retry_same_approach (attempt 1)
  → rollback_and_retry (attempt 2+)
    → escalate_to_human (max retries reached)
```

### 12.4 Error Categories

| Category | Pattern | Default Strategy |
|----------|---------|-----------------|
| `transient` | Timeout, network | Retry |
| `state` | Corrupt, inconsistent | Rollback + retry |
| `configuration` | Missing config | Skip or escalate |
| `dependency` | Missing package | Recovery workflow |
| `fatal` | OOM, unrecoverable | Escalate |

---

## 13. Validation

### 13.1 Validator Behavior

The validator accepts both CC format and legacy format.
CC is the standard for new squads. Legacy is accepted for backward compatibility.

**Blocking checks (must pass):**

| # | Check |
|---|-------|
| 1 | `squad.yaml` exists and is valid YAML |
| 2 | `name` is kebab-case |
| 3 | `version` is semver |
| 4 | All files in `components` exist on disk |
| 5 | Agent has identity: `name`+`description` (CC) or `agent.name`+`agent.id` (legacy) |
| 6 | Agent frontmatter is valid YAML |
| 7 | Task has identity: `name` (CC) or `task`+`owner` (legacy) |
| 8 | Legacy task `owner` matches an agent name |
| 9 | Workflow is valid YAML with `name` or `workflow_name` |
| 10 | Agent IDs/names are unique |

**Not validated (optional, never scored):**
tools, model, effort, persona_profile, greeting_levels, archetype,
commands, icon, owner_type, atomic_layer, inputs, outputs, checklist

### 13.2 Fix Report

When validation fails, the validator generates an AI-friendly fix report:

```bash
squads validate ./my-squad --report    # Copy-pasteable markdown
squads validate ./my-squad --fix       # Auto-fix common issues
squads validate ./my-squad --json      # JSON with fixReport field
```

The fix report groups errors by file, shows the expected format,
and provides specific fix instructions with examples.

---

## 14. Security

### 14.1 Permission Modes

| Mode | Behavior |
|------|----------|
| `default` | Ask for each tool use |
| `acceptEdits` | Auto-allow edits, ask for others |
| `bypassPermissions` | Allow all |
| `plan` | Read-only, no mutations |

### 14.2 Boundary Model `[HYBRID]`

| Layer | Mutability | What |
|-------|-----------|------|
| L1 Framework Core | NEVER | Runtime, constitution |
| L2 Framework Templates | NEVER | Reference tasks, templates |
| L3 Project Config | Conditional | Data files, agent memory |
| L4 Project Runtime | ALWAYS | Squads, stories, code |

---

## 15. Versioning

Protocol follows SemVer 2.0.0.

| Change | Bump |
|--------|------|
| New optional field | Minor |
| Breaking schema change | Major |
| Bug fix / clarification | Patch |

**Current version:** 2.0.0 (CC format standard)

---

## 16. Legacy Format Support

The validator and harness accept the legacy format indefinitely.
No migration is required for existing squads to continue working.

### Legacy Agent Format

```yaml
---
agent:
  name: my-agent
  id: my-agent
  title: "Agent Title"
  icon: "🤖"
  whenToUse: "When to use"
persona:
  role: "Role description"
  style: "Communication style"
  core_principles:
    - "Principle 1"
commands:
  - name: "*command"
    description: "What it does"
greeting_levels:
  minimal: "Ready"
  standard: "Agent ready"
---

Body content here.
```

### Legacy Task Format

```yaml
---
task: myTask()
owner: "agent-name"
owner_type: Agent
atomic_layer: Molecule
---

Task body here.
```

### Differences from CC Format

| Aspect | Legacy | CC |
|--------|--------|-----|
| Agent identity | Nested `agent:` block | Flat `name:` + `description:` |
| Persona | YAML in frontmatter | Prose in body |
| Principles | YAML array | Body ## Guidelines |
| Commands | YAML array | Body ## Process |
| Task ownership | `owner:` in task | Workflow `agent:` field |
| Token waste | ~18% on metadata | 0% |

### Migration Path

See `references/09-upgrade.md` and `references/cc-squad-standard.md`
for the complete migration guide.

---

*End of Squad Protocol Specification v2.0.0*
