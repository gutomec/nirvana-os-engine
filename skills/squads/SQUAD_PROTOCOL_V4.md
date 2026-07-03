# Squad Protocol Specification

```
Title:    Squad Protocol Specification
Version:  4.0.0
Status:   ACTIVE
Date:     2026-04-04
Author:   Luiz Gustavo Vieira Rodrigues (Prospecteezy)
license: SUL-1.0
Scope:    Runtime-agnostic core
```

## About This Version

v4.0 is a **runtime-agnostic** reformulation of the Squad Protocol.

The spec now has two layers:

1. **Core Protocol** (this document) — conceptual model, contracts, and rules that hold on **every** agentic runtime. No numeric thresholds, no runtime file names, no source-code references.
2. **Runtime Adapters** (`adapters/{runtime}.md`) — runtime-specific mechanics (compaction buffers, tool whitelist flags, subagent primitives, memory file names, SRC-N citations).

A squad written against v4.0 declares which runtimes it supports. The harness loads the matching adapter. Features that a runtime cannot provide **degrade gracefully**; they do not crash.

**Supported runtimes at publication:** Claude Code, Codex, Gemini CLI, Antigravity, Cursor. See [§18 Runtime Compatibility](#18-runtime-compatibility).

**Two-layer rule:** if a claim is true on every runtime, it belongs here. If it is runtime-specific (a number, a file name, a flag), it belongs in an adapter.

---

## Table of Contents

1.  [Introduction and Scope](#1-introduction-and-scope)
2.  [Terminology](#2-terminology)
3.  [Design Principles](#3-design-principles)
4.  [Architecture Layers](#4-architecture-layers)
5.  [Squad Structure](#5-squad-structure)
6.  [Agent Specification](#6-agent-specification)
7.  [Task Specification](#7-task-specification)
8.  [Workflow Orchestration](#8-workflow-orchestration)
9.  [Communication and Handoff](#9-communication-and-handoff)
10. [Tool Declaration](#10-tool-declaration)
11. [Memory Model](#11-memory-model)
12. [Context Engineering](#12-context-engineering)
13. [Context Preservation](#13-context-preservation)
14. [Bounded Iteration](#14-bounded-iteration)
15. [Validation](#15-validation)
16. [Security](#16-security)
17. [Versioning](#17-versioning)
18. [Runtime Compatibility](#18-runtime-compatibility)
19. [Pattern Maturity Classification](#19-pattern-maturity-classification)
20. [Proposed (Not Implemented)](#20-proposed-not-implemented)
21. [Legacy Support](#21-legacy-support)

---

## 1. Introduction and Scope

### 1.1 Purpose

The Squad Protocol defines a portable standard for multi-agent AI systems.

A **squad** is a self-contained package of agents, tasks, workflows, and artifacts that collectively accomplish a domain of work. A squad is meant to run on more than one agentic runtime without modification.

### 1.2 What This Protocol Is

- A **conceptual model** for agents, tasks, workflows, and their interactions.
- A **file-and-folder contract** (`squad.yaml`, `agents/*.md`, `tasks/*.md`, `workflows/*.yaml`).
- A set of **portable schemas** with namespaced extensions for runtime-specific fields.
- A set of **validation rules** that hold on every runtime.
- A set of **design principles** that keep squads honest and portable.

### 1.3 What This Protocol Is NOT

- Not a runtime. It does not execute agents.
- Not a prescription of which LLM to use.
- Not a guarantee that every runtime enforces every concept. Some features degrade gracefully on runtimes that lack the underlying primitive.
- Not a claim about harness-level enforcement. Enforcement varies by runtime and is documented in each adapter.

### 1.4 Runtime Neutrality Promise

This document **does not mention**:
- Runtime-specific memory file names.
- Runtime-specific tool names or CLI flags.
- Numeric compaction thresholds, token budgets expressed in absolute numbers, buffer sizes.
- Source-code citations to any runtime's implementation.

These live exclusively in adapter documents. Any reader should be able to read this specification end-to-end and not be able to tell which runtime is the "reference" runtime. They are all peers.

### 1.5 Audience

Squad authors, harness implementers, adapter authors, and tool builders who want their work to be portable across agentic runtimes.

---

## 2. Terminology

| Term | Definition |
|------|------------|
| **Squad** | A self-contained package of agents, tasks, workflows, and metadata bundled under `squad.yaml`. |
| **Agent** | A Markdown file with YAML frontmatter (runtime config) and a prose body (system prompt). |
| **Task** | A Markdown file describing a unit of work: inputs, steps, outputs, acceptance criteria. |
| **Workflow** | A YAML file binding agents to tasks in a directed acyclic graph of execution. |
| **Harness** | The software that loads, validates, and executes a squad. Examples: the Claude Code subagent system, an orchestrator script, a CI job. |
| **Runtime** | The LLM execution environment that runs agents (Claude Code, Codex, Gemini CLI, Antigravity, Cursor, etc.). |
| **Adapter** | A document + manifest pair that maps core concepts to a specific runtime's primitives. |
| **Context Window** | The finite token budget an agent can address in a single generation. |
| **Compaction** | Reducing context size while preserving essential information. Mechanism varies by runtime. |
| **Handoff Artifact** | Structured data passed from one agent to the next, encoding decisions, outputs, and next steps. |
| **Bounded Iteration** | Any loop with an explicit maximum (maxTurns, QA iterations, retry count). |
| **Feature Flag** (squad) | A named capability (`subagent_spawning`, `tool_whitelist`, etc.) declared in `features_required` or `features_optional`. |
| **Graceful Degradation** | Behavior when a runtime cannot provide an `features_optional` capability: the squad loads, the feature is skipped, and the harness logs the degradation. |
| **Namespace** | A top-level key under `runtimes.{runtime_id}` that holds runtime-specific configuration. Other runtimes ignore foreign namespaces. |

---

## 3. Design Principles

The ten principles that govern this protocol. Every rule in this document traces back to at least one principle.

### P1: Separation of Audiences

Information belongs to exactly one of three audiences:

| Audience | Location | Example |
|----------|----------|---------|
| **Runtime / Harness** | YAML frontmatter, `squad.yaml`, adapter manifests | `name`, `tools`, `maxTurns`, feature flags |
| **LLM** | Agent body prose, task body prose | Identity, guidelines, process, output format |
| **UI / Marketplace** | `squad.yaml` → `ui` block, `agents_metadata` | Icons, archetypes, category tags |

Never mix the three. A field that serves two audiences is a bug, not a feature.

### P2: Prose Over Structure

The LLM reads the agent body. LLMs process natural-language prose better than nested YAML arrays. Persona, guidelines, process steps, and output formats belong in the body as prose, not in frontmatter as structured data.

Frontmatter is for the **runtime**. Body is for the **LLM**. They do not overlap.

### P3: Token Budget Discipline

Agent bodies should be small enough that every token earns its place.

The Core spec expresses this as a **discipline**, not a numeric limit. Recommended target: agent bodies in the 1000–2500 token range, scaled down aggressively when the runtime's context window is small. Specific numeric limits are adapter decisions.

If an agent body grows past the recommended target, the usual cause is that the agent has multiple responsibilities. Split it. Write two narrowly-scoped agents instead of one broad one.

### P4: Bounded Iteration is Universal

Every agent declares `maxTurns` in its frontmatter. This is **mandatory**.

Without a turn bound, a runtime may loop forever, exhaust a budget, or produce unbounded waste. Some runtimes apply implicit defaults; others do not. The protocol requires the squad author to declare the bound explicitly rather than relying on runtime defaults.

`maxTurns` is the only universal loop guard in this specification. Doom-loop detection, similarity thresholds, and circuit breakers are runtime proposals (see [§20](#20-proposed-not-implemented)) and must not be relied on as present.

### P5: Fail-Closed Defaults

Security-relevant fields default to the most restrictive option:

- Tool whitelist absent → no tools granted.
- Parse failure on a concurrency declaration → treat as non-concurrent.
- Missing capability → reject, do not auto-grant.
- Unknown runtime field → ignore, do not apply.

Squads that rely on permissive defaults are fragile across runtimes.

### P6: Task-First Architecture

Tasks describe **what** to do. Workflows decide **who** does **what**. Agents do not own tasks; tasks do not reference agents.

This decoupling lets the same task run under different agents on different runtimes. It also lets adapters substitute agents transparently when a runtime lacks a specific primitive.

### P7: Runtime Neutrality (new in v4)

The Core spec contains no runtime-specific values, file names, or source references. Squads declare which runtimes they target through `runtime_requirements`. Runtime-specific configuration lives in namespaced blocks (`runtimes.{id}.*`). Other runtimes ignore foreign namespaces.

### P8: Technical Honesty (new in v4)

The protocol labels every pattern with its maturity level (Functional, Problematic, Aspirational, Proposed — see [§19](#19-pattern-maturity-classification)). It does not promise enforcement that does not exist. When a pattern is a proposal, it says so in writing.

Squad authors make informed decisions by seeing accurate labels, not by trusting hopeful tags.

### P9: Graceful Degradation (new in v4)

When a squad declares `features_optional: [...]` and the target runtime cannot provide one of them, the harness:

1. Logs the degradation explicitly.
2. Substitutes the documented fallback (usually sequential execution for missing parallel primitives).
3. Continues to load and run the squad.

A squad must not crash because an optional feature is missing. A squad must fail cleanly and loudly when a `features_required` feature is missing.

### P10: Namespaced Extensions (new in v4)

Runtime-specific configuration belongs under `runtimes.{runtime_id}.*`. Examples:

```yaml
runtimes:
  claude-code:
    # CC-specific config here
  codex:
    # Codex-specific config here
  gemini-cli:
    # Gemini-specific config here
```

Adapters read their own namespace. Other runtimes ignore foreign namespaces. This lets one squad file carry configuration for multiple runtimes without conflict.

---

## 4. Architecture Layers

### 4.1 Two Layers

```
┌─────────────────────────────────────────────┐
│  CORE PROTOCOL (runtime-agnostic)           │
│  • Conceptual model                         │
│  • Contracts and schemas                    │
│  • Universal validation rules               │
│  • Principles P1–P10                        │
└─────────────────────────────────────────────┘
                     │
        ┌────────────┼────────────┬──────────────┐
        ▼            ▼            ▼              ▼
  ┌──────────┐ ┌──────────┐ ┌──────────┐  ┌──────────┐
  │ Adapter: │ │ Adapter: │ │ Adapter: │  │ Adapter: │
  │ runtime A│ │ runtime B│ │ runtime C│  │ runtime D│
  └──────────┘ └──────────┘ └──────────┘  └──────────┘
```

### 4.2 What Belongs to Core

Universal concepts that exist in every agentic runtime:

- Agent = identity + instructions + tool whitelist declaration.
- Task = a contract of inputs, outputs, acceptance criteria.
- Workflow = an ordered or DAG execution of task invocations.
- Bounded iteration (`maxTurns`) as a mandatory declaration.
- Separation of audiences (runtime / LLM / UI).
- Handoff artifact shape.
- Memory scopes (ephemeral, session, project, global).
- Iteration verdicts (approve, reject, blocked, escalate).

### 4.3 What Belongs to Adapters

Runtime-specific mechanics:

- Compaction numeric values and trigger thresholds.
- Subagent spawning mechanism (or its absence).
- Tool whitelist enforcement (hard vs advisory).
- CLI flag names and invocation syntax.
- Memory file names and locations.
- Hook systems (events, payloads, abort semantics).
- Fork/teammate primitives.
- Runtime-specific validators beyond Core.
- Source-code references (SRC citations).

### 4.4 Adapter Contract

Every adapter provides two files:

1. **`adapters/{runtime_id}.md`** — human-readable documentation.
2. **`adapters/{runtime_id}.yaml`** — machine-readable manifest.

The manifest declares which features the adapter supports and how Core concepts map to runtime primitives. The manifest is validated against `schemas/adapter-schema.json`.

See [§18 Runtime Compatibility](#18-runtime-compatibility) for the full adapter contract.

### 4.5 How a Squad Chooses a Runtime

A squad declares `runtime_requirements` in its manifest:

```yaml
runtime_requirements:
  minimum:                        # at least one must match host
    - runtime: runtime-a
      version: ">=2.0.0"
  compatible:                     # works with graceful degradation
    - runtime: runtime-b
      version: ">=1.0.0"
  incompatible: []                # explicit non-support
```

The harness resolves the effective runtime, loads the adapter, validates features, and degrades optional features that are missing. See [§18](#18-runtime-compatibility) for details.

---

## 5. Squad Structure

### 5.1 The Manifest

Every squad has a `squad.yaml` at its root.

**Required fields:**

```yaml
name: my-squad                    # kebab-case, 2-50 chars
version: "1.0.0"                  # semver
protocol: "4.0"                   # squad protocol version this squad targets
```

**Recommended fields:**

```yaml
description: "What this squad does"
author: "name or handle"
license: SUL-1.0
slashPrefix: my-squad
tags: [domain, keywords]
```

**Runtime compatibility (recommended):**

```yaml
runtime_requirements:
  minimum:
    - runtime: runtime-a
      version: ">=2.0.0"
  compatible:
    - runtime: runtime-b
      version: ">=1.0.0"
  incompatible: []

features_required:
  - max_turns
  - tool_whitelist
  - handoff_artifacts

features_optional:
  - subagent_spawning
  - project_memory
  - hooks
```

**Components (required):**

```yaml
components:
  agents:
    - agents/researcher.md
    - agents/reviewer.md
  tasks:
    - tasks/research-topic.md
    - tasks/review-findings.md
  workflows:
    - workflows/main-pipeline.yaml
```

**Runtime-specific namespaces (optional):**

```yaml
runtimes:
  runtime-a:
    # namespace read only by the runtime-a adapter
  runtime-b:
    # namespace read only by the runtime-b adapter
```

**UI metadata (optional, marketplace only):**

```yaml
ui:
  icon: "🔬"
  category: "research"
  agents_metadata:
    researcher:
      icon: "🔬"
      archetype: Builder
    reviewer:
      icon: "🛡️"
      archetype: Guardian
```

**Inter-task contracts (optional but recommended):**

```yaml
contracts:
  research-topic → review-findings: schemas/research-findings.json
```

### 5.2 Directory Layout

```
{squad-name}/
├── squad.yaml              # REQUIRED: manifest
├── agents/                 # REQUIRED: agent definitions
│   └── {agent-name}.md
├── tasks/                  # REQUIRED: task definitions
│   └── {task-name}.md
├── workflows/              # REQUIRED: workflow definitions
│   └── {workflow-name}.yaml
├── schemas/                # OPTIONAL: output schemas for contracts
│   └── {schema-name}.json
├── references/             # OPTIONAL: reference material loaded on demand
│   └── {name}.md
├── checklists/             # OPTIONAL: quality checklists
├── templates/              # OPTIONAL: reusable templates
├── tools/                  # OPTIONAL: tool scripts
├── scripts/                # OPTIONAL: automation scripts
└── data/                   # OPTIONAL: static data
```

### 5.3 Name Rules

- Squad names, agent names, task names, workflow names: **kebab-case**, `[a-z][a-z0-9-]*`, 2–64 chars.
- Names are unique within their kind in a squad.
- File names match the declared name (`agents/researcher.md` declares `name: researcher`).

---

## 6. Agent Specification

### 6.1 Agent File Format

**Location:** `agents/{agent-name}.md`

**Structure:** YAML frontmatter followed by Markdown body.

**The runtime separates frontmatter from body. The LLM receives only the body.**

### 6.2 Frontmatter

**Universal required fields:**

```yaml
---
name: agent-name
description: "When to use this agent — one paragraph explaining trigger conditions and scope"
maxTurns: 25
---
```

**Universal recommended fields:**

```yaml
tools: [read, write, grep, bash]    # portable semantic tool names
model: inherit                        # model family hint (adapter resolves)
version: 1.0.0
```

**Namespaced runtime-specific fields (optional):**

```yaml
runtimes:
  runtime-a:
    # runtime-a-specific config
  runtime-b:
    # runtime-b-specific config
```

### 6.3 Required vs Optional

| Field | Status | Purpose |
|-------|--------|---------|
| `name` | **Required** | Routing, identity, validation |
| `description` | **Required** | Agent selection criterion |
| `maxTurns` | **Required** | Loop bound (P4) |
| `tools` | Recommended | Portable tool whitelist |
| `model` | Recommended | Model family hint |
| `runtimes.{id}` | Optional | Runtime-specific config |

### 6.4 Description Pattern

The `description` is the agent-selection criterion. When a runtime presents agents to a planner LLM (or to the user), it presents them by description. A good description matches queries deterministically.

**Recommended pattern:**

```
"[Verb] [domain]. Use when [trigger]. Do NOT use for [anti-pattern]."
```

**Example:**

```
"Investigates topics using web search. Use when the task requires finding
current data, comparing alternatives, or validating claims with sources.
Do NOT use for opinion pieces or creative writing."
```

### 6.5 Body

The body is what the LLM receives. It consists of four sections in order:

```markdown
[Opening paragraph: identity and scope in 2–3 specific sentences.
Not generic, not roleplay, not backstory.]

# Guidelines

## DO
- [Specific actionable principle 1]
- [Principle 2]
- [Principle 3]

## DO NOT
- [Specific anti-pattern 1]
- [Anti-pattern 2]

# Process

1. [Step 1 with action verb]
2. [Step 2]
3. [Step 3]

# Output

[Format] at [location]

## GOOD example
[A concrete, complete example of desired output]

## BAD example (do NOT produce)
[What to avoid, and one sentence on why]
```

### 6.6 Body Size

Body size is a **discipline** expressed relative to the runtime's context window. Recommended target: agent bodies should fit comfortably inside what the adapter documents as "small context window" for that runtime. Specific numeric budgets are adapter decisions.

If the body grows past the adapter-recommended target, split the agent.

### 6.7 Portable Tool Names

The Core spec recognizes a small set of **semantic tool names** that every adapter maps to runtime primitives:

| Semantic name | Meaning |
|--------------|---------|
| `read` | Read a file |
| `write` | Create or overwrite a file |
| `edit` | Modify an existing file |
| `grep` | Search content in files |
| `glob` | Find files by pattern |
| `bash` / `shell` | Execute shell commands |
| `web_search` | Search the web |
| `web_fetch` | Fetch a URL |

Squads write portable tool lists in the universal `tools:` field. Each adapter maps these to its local tool names. Squads that need runtime-specific tools override with `runtimes.{id}.tools`:

```yaml
tools: [read, grep, glob]           # portable default
runtimes:
  runtime-a:
    tools: [Read, Grep, Glob, Bash]  # override with runtime-a names
  runtime-b:
    allowedTools: [read, grep]       # runtime-b uses a different field name
```

### 6.8 Agent Lifecycle

```
UNLOADED → LOADED → ACTIVE → EXECUTING → UNLOADED
                      ↕
                  SUSPENDED (handoff)
```

- **UNLOADED**: Definition exists on disk; not in memory.
- **LOADED**: Parsed, validated, ready to activate.
- **ACTIVE**: Selected to handle a task.
- **EXECUTING**: Currently calling the LLM.
- **SUSPENDED**: Handed off; waiting for control to return or not at all.

Runtimes implement these states differently (see each adapter's §7 Subagent Spawning). The state machine is conceptual.

---

## 7. Task Specification

### 7.1 Task File Format

**Location:** `tasks/{task-name}.md`

**Frontmatter:**

```yaml
---
name: task-name
description: "What this task accomplishes"
---
```

**Body:**

```markdown
# {Task Title}

## Input
[What this task receives]

## Steps
1. [Specific actions]
2. ...

## Output
[What to produce, where to save]

## Acceptance Criteria
[Verifiable completion conditions, binary]

## Output Schema (optional but recommended)
[JSON schema or inline description]
```

### 7.2 Tasks Do Not Have Owners

In v4, tasks describe **what** to do. The workflow binds an agent to a task. A task never references an agent. The same task can execute under different agents in different workflows.

### 7.3 Acceptance Criteria Must Be Binary and Verifiable

| Good criterion | Verifiable? | How |
|---------------|-------------|-----|
| "Every target file was scanned" | Yes | Compare lists |
| "Each finding has file, line, severity, fix" | Yes | Schema validation |
| "No false positives above 5%" | Yes | Sampling |
| "Output is high quality" | **No** | Subjective, not a criterion |

Criteria that require subjective judgment are not acceptance criteria. They are goals. Make them measurable or drop them.

### 7.4 Output Schemas

For any task whose output is consumed by another task (a **downstream handoff**), declare an output schema. Schema violations are caught at handoff time before the next agent runs.

The schema can be:

- A JSON Schema file referenced from `squad.yaml` under `contracts:`.
- An inline description in the task body under `## Output Schema`.

### 7.5 Task Lifecycle

```
PENDING → QUEUED → RUNNING → { COMPLETED | FAILED | CANCELLED }
                     ↕
                  PAUSED
                     ↓
                  RETRYING → RUNNING
```

---

## 8. Workflow Orchestration

### 8.1 Workflow File Format

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

**Required fields:** `name` (or `workflow_name`), `steps` with at least one step.

**Each step requires:** `id`, `agent`, `task`, `depends_on`.

### 8.2 Execution Patterns

| Pattern | When to use |
|---------|-------------|
| **Pipeline** | Steps run sequentially; each depends on the previous |
| **Parallel** | Steps without dependencies run concurrently |
| **DAG** | Steps declare `depends_on` to form a dependency graph |
| **Loop** | Bounded review-fix cycles (QA loop) |

### 8.3 Wave Execution

Steps at the same dependency level form a **wave**. Waves execute sequentially; steps within a wave execute in parallel (when the runtime supports subagent spawning; see [§18](#18-runtime-compatibility)).

```
Wave 1: [step-1, step-2, step-3]   ← parallel (no deps)
Wave 2: [step-4, step-5]           ← parallel (depend on wave 1)
Wave 3: [step-6]                   ← depends on wave 2
```

### 8.4 Graceful Degradation for Parallelism

If the runtime's adapter declares `subagent_spawning: unsupported`, the harness executes the workflow **sequentially** in topological order instead of by waves. This is a runtime decision, not a squad decision. The squad author does not need to rewrite the workflow.

The harness logs the degradation on load:

```
INFO: runtime 'runtime-b' does not support subagent_spawning.
      Executing workflow 'main_pipeline' sequentially.
```

### 8.5 Failure Handling at Step Level

Each step may declare a fallback chain:

```yaml
steps:
  - id: analyze
    agent: fast-analyzer
    task: analyze-code
    on_failure:
      retry: 2
      then:
        agent: deep-analyzer
        task: analyze-code
      on_failure:
        type: human-escalation
```

Fallback chains are a squad-level concern. The harness honors them independently of any runtime primitive.

---

## 9. Communication and Handoff

### 9.1 Message Types

| Type | Direction | Purpose |
|------|-----------|---------|
| `REQUEST` | Agent → Agent | Ask for work |
| `INFORM` | Agent → Agent | Share results |
| `DELEGATE` | Agent → Agent | Hand off a task |
| `ESCALATE` | Agent → Human | Request intervention |

### 9.2 Handoff Artifact

When an agent finishes a step that feeds into another step, it emits a **handoff artifact**. This is the next agent's input.

Runtimes that provide structured handoff containers (argument capture, tool-result schemas) wrap the artifact automatically. Runtimes without such containers require the squad to treat the artifact as free text output. Either way, the schema below is the canonical shape.

**Portable handoff artifact schema:**

```json
{
  "schemaVersion": "1.0.0",
  "from_agent": "agent-a",
  "to_agent": "agent-b",
  "summary": "Single-paragraph natural-language summary",
  "key_decisions": [
    "Decision 1",
    "Decision 2"
  ],
  "files_modified": [
    "path/to/file1.ts",
    "path/to/file2.md"
  ],
  "blockers": [],
  "next_action": "What the receiving agent should do first",
  "artifacts": [
    "output/findings.json",
    "output/report.md"
  ]
}
```

**Size limits:**

- `key_decisions`: at most 5.
- `files_modified`: at most 10.
- `blockers`: at most 3.
- Total artifact: target under 500 tokens.

### 9.3 Why the Artifact is Not Optional

On most runtimes, a spawned subagent **does not inherit the parent's context**. The subagent receives only the prompt the parent chose to send. If that prompt does not include the artifact, the subagent starts with nothing.

The handoff artifact is the squad's portable mechanism for passing context between steps. It works on every runtime because it is just JSON inside a string.

### 9.4 Error Message Format

```json
{
  "type": "error",
  "source": {
    "agent_id": "agent-a",
    "task_name": "analyze",
    "step_id": "step-2"
  },
  "error": {
    "code": "TASK_STEP_FAILED",
    "category": "transient | state | configuration | dependency | contract | fatal",
    "message": "Human-readable description",
    "recovery_hint": "Suggested action"
  },
  "context": {
    "attempt": 1,
    "max_attempts": 3
  }
}
```

### 9.5 Error Categories

| Category | Examples | Default strategy |
|----------|----------|------------------|
| `transient` | Timeout, network blip | Retry with backoff |
| `state` | Corrupted artifact, inconsistent file | Rollback + retry |
| `configuration` | Missing env var, misconfigured adapter | Skip or escalate |
| `dependency` | Missing package, unreachable service | Recovery workflow |
| `contract` | Handoff schema mismatch | Repair prompt + retry |
| `fatal` | Out of memory, unrecoverable | Escalate to human |

---

## 10. Tool Declaration

### 10.1 Declaration, Not Enforcement

A squad **declares** which tools each agent may use. The runtime **enforces** (or does not enforce) that declaration. Enforcement varies:

- Some runtimes restrict tools at the API schema level (the model cannot even see unlisted tools).
- Some runtimes enforce via CLI flags (`--allowed-tools`, `--allowedTools`).
- Some runtimes treat the list as advisory and rely on system prompt instructions.

The Core spec requires the declaration. The adapter documents the enforcement level.

### 10.2 Tool Whitelist Grammar

**Agent frontmatter:**

```yaml
tools: [read, grep, glob]                 # portable semantic names
```

**Namespaced override:**

```yaml
runtimes:
  runtime-a:
    tools: [Read, Grep, Glob, Bash]       # runtime-a local names
  runtime-b:
    allowedTools: [read, grep]            # runtime-b uses a different field
```

The adapter is responsible for reading whichever field name is correct for its runtime.

### 10.3 Enforcement Levels

Every adapter declares an enforcement level for the tool whitelist:

| Level | Meaning |
|-------|---------|
| `enforced` | Tools not listed literally do not exist in the schema sent to the LLM |
| `advisory` | The list is passed to the LLM as instruction; the model may ignore it |
| `hybrid` | Some tools enforced, others advisory |
| `unsupported` | The runtime has no tool-gating mechanism |

See each adapter's §5 Tool Whitelist Mechanics.

### 10.4 Fail-Closed

If an agent declares no tools and no runtime-specific override is present, the agent has **no tool access**. It can only reason and produce text output. This is the safe default.

### 10.5 Safety Boundaries in Body

Tool whitelist is the first line of defense. The second line is safety-boundary prose in the agent body:

```markdown
# Safety Boundaries
- NEVER delete files outside output/
- NEVER execute commands that modify git history
- NEVER make network requests to domains not in the approved list
- If uncertain about destructive action → write to output/pending-actions.json
```

Squad authors use body guardrails against **misuse** of tools the agent legitimately has access to.

---

## 11. Memory Model

### 11.1 Four Memory Scopes

| Scope | Lifetime | Who sees it |
|-------|----------|-------------|
| **Ephemeral** | One invocation | The current agent only |
| **Session** | One conversation | All agents in this session |
| **Project** | One project/repository | All squads operating on this project |
| **Global** | Indefinite, cross-project | All invocations on this machine or account |

### 11.2 Conceptual, Not Physical

The four scopes are **conceptual**. Each runtime implements them differently (different file names, different locations, different persistence guarantees). The adapter documents the physical implementation. The Core spec documents the semantics.

### 11.3 Semantics of Each Scope

**Ephemeral.** The working memory of a single agent invocation. Lost when the agent returns.

**Session.** Context shared across agents in one workflow execution. Typically manifests as a shared artifacts directory (e.g., `output/`) that agents read and write.

**Project.** Persistent facts about the codebase, conventions, learned patterns. Injected into every agent that runs against this project. Typically a single markdown file at the project root.

**Global.** Preferences and facts that persist across projects. Useful for per-user calibration. Typically a markdown file in the user's home directory.

### 11.4 Memory Selection Decision Tree

**Does the squad execute isolated invocations with no reuse?**
- Yes → Use Ephemeral + Session only. Skip persistent memory.
- No → Continue.

**Do the squad's agents need to remember facts between invocations?**
- No → Use Ephemeral + Session only.
- Yes → Use Project memory.

**Do cross-project preferences matter?**
- No → Use Project memory only.
- Yes → Use Project + Global memory.

**Does the volume of facts exceed what fits in a markdown file without inflating context?**
- No → Stick with markdown.
- Yes → Use a vector store or retrieval-augmented memory (not covered by this protocol; a runtime extension).

### 11.5 Garbage Collection Policy

Persistent memory files grow unbounded without discipline. Every squad that uses Project or Global memory **must** declare a garbage collection policy:

```yaml
# squad.yaml
memory:
  persistent:
    enabled: true
    scope: project
    garbage_collection:
      max_learned_facts: 200
      review_interval_days: 30
      conflict_resolution: replace  # replace | append | prompt
```

**Conflict resolution semantics:**

- `replace`: a new fact that contradicts an existing one replaces it.
- `append`: both are kept with timestamps.
- `prompt`: the agent asks for disambiguation.

**Default:** `replace`. New facts supersede old ones.

### 11.6 Memory Layout in Files

Persistent memory files follow this structure for LLM efficiency:

```markdown
# Persistent Memory

## Project Rules (always relevant)
- Rule 1
- Rule 2

## Learned Facts (auto-curated, replaced on conflict)
- {date}: {fact}
- {date}: {fact}
```

Information at the top is seen first by the LLM. Rules go above learned facts. Learned facts are periodically pruned per the GC policy.

---

## 12. Context Engineering

### 12.1 Three Metrics

| Metric | Formula | Detects |
|--------|---------|---------|
| **Token Utility Ratio** | actionable tokens ÷ total tokens | Inflated prompts |
| **Context Density** | unique information ÷ token count | Repetition across agents |
| **Handoff Overhead** | handoff tokens ÷ total tokens | Over-fragmentation |

### 12.2 Budget Discipline (Relative, Not Absolute)

The Core spec expresses budgets as **relative fractions**, not absolute numbers:

- Agent body: target ≤1.5% of the runtime's context window.
- Handoff artifact: target ≤0.25% of the runtime's context window.
- Session artifacts cumulatively: target ≤5% of the runtime's context window.

Adapters publish **absolute** numbers for their runtime in their §9 Context Window & Compaction section.

### 12.3 Compaction Is a Runtime Event

When token usage approaches the runtime's limit, the runtime may compact — summarize older messages, drop tool results, rewrite history. Details (when it triggers, what it preserves, what it discards) are runtime-specific.

The squad author's lever is the squad's design: small agents, clean handoffs, narrow tasks. The Core spec does not describe compaction mechanics. See the adapter §9 for each runtime.

### 12.4 Why Handoffs Matter More Than Size

Cutting a 3K-token body down to 1.5K saves half the body. But handoffs that drag the full conversation history between steps multiply token costs by the number of steps. The bigger lever is handoff discipline (structured artifacts, not full history).

---

## 13. Context Preservation

### 13.1 What "Surviving Compaction" Means

When a runtime compacts, some data survives and some is discarded. The data that survives depends on what the compactor considers important. Squads that need specific information to persist through compaction must **place it where the compactor looks**.

The Core spec does not specify compaction templates (they are runtime-specific). It does specify the squad-author practices that generalize.

### 13.2 Four Practices for Context Survival

**1. Put critical instructions in the initial prompt.** The original prompt is the part most runtimes preserve verbatim.

**2. Put runtime-critical context in a tagged block.** Use a self-describing tag the LLM can reference:

```markdown
<protocol-context>
This agent is part of the code-review workflow.
Input: output/findings.json from the bug-detector.
Output: output/consolidated-report.md
Constraint: critical findings must appear verbatim in the final report.
</protocol-context>
```

Tagged blocks survive across compaction windows because the LLM is prompted to reference them.

**3. Put file paths and line numbers in output.** Most compactors summarize code regions with file paths and line numbers preserved. Free-form descriptive prose about code tends to get cut.

**4. Prefer small agents and short histories.** The cheapest compaction is the one that never happens. Design agents so they finish inside the runtime's pre-compaction window.

### 13.3 Handoff Artifact Survives

The handoff artifact is designed to survive compaction because it is:

- Small (target ≤500 tokens).
- Structured JSON (compactors preserve structured content well).
- Self-describing (field names explain themselves).

Squads that rely on handoff artifacts rather than long conversation history are inherently more compaction-resilient.

---

## 14. Bounded Iteration

### 14.1 maxTurns Is Mandatory

Every agent declares `maxTurns` in its frontmatter. No exceptions.

```yaml
---
name: researcher
description: "..."
maxTurns: 25
---
```

Runtimes that apply implicit defaults still accept the explicit declaration. Runtimes that do not apply defaults rely on it. The squad author never assumes a default.

### 14.2 Turn Budgets by Task Type

| Task type | Typical maxTurns |
|-----------|-----------------|
| Single-file read + report | 3–5 |
| Code review pass | 10–20 |
| Targeted fix + test | 15–30 |
| Research with multiple searches | 25–50 |
| Multi-file refactor | 50–100 |

These are guidelines. Tune to the task, not the other way around.

### 14.3 Four Kinds of Bounded Loops

| Loop | Bound | Default maximum | When exhausted |
|------|-------|-----------------|----------------|
| **Turn budget** (per agent) | `maxTurns` | — (required) | Agent stops |
| **QA loop** (review ↔ fix) | `max_iterations` | 5 | Accept best-effort + flag review |
| **Retry** (transient errors) | `max_retries` | 3 | Rollback + escalate |
| **Recovery** (state errors) | `max_recoveries` | 3 | Escalate |

All four are defined in the squad/workflow. None rely on runtime primitives.

### 14.4 Verdict Semantics

Review steps return one of four verdicts:

| Verdict | Meaning | Next action |
|---------|---------|-------------|
| `APPROVE` | Output meets criteria | Complete step |
| `REJECT` | Output does not meet criteria | Send back for fix (within loop budget) |
| `BLOCKED` | Cannot review (missing input, invalid state) | Escalate |
| `ESCALATE` | Out of scope for this agent | Human or higher-tier agent |

### 14.5 Recovery Cascade

```
transient error → retry with backoff (max 3)
  → state error → rollback + retry (max 3)
    → contract error → repair prompt + retry (max 3)
      → configuration error → skip or escalate
        → fatal → escalate to human
```

Each step is bounded. The cascade is not a replacement for structural fixes: if the same error keeps appearing, the squad needs redesign, not more retries.

---

## 15. Validation

### 15.1 Two-Stage Validation

Validation runs in two stages:

**Stage 1: Core validation.** Universal rules that hold on every runtime. Blocking if failed.

**Stage 2: Adapter validation.** Runtime-specific rules declared in the adapter's validators list. Blocking if the target adapter requires them.

### 15.2 Core Blocking Checks

| # | Check |
|---|-------|
| 1 | `squad.yaml` exists and parses as valid YAML |
| 2 | `name` is kebab-case matching `[a-z][a-z0-9-]{1,63}` |
| 3 | `version` is valid semver |
| 4 | `protocol` is declared and supported |
| 5 | All files listed in `components.*` exist on disk |
| 6 | Every agent has `name`, `description`, `maxTurns` |
| 7 | Every agent frontmatter is valid YAML |
| 8 | Every task has `name` |
| 9 | Every workflow has `name` (or `workflow_name`) |
| 10 | Agent names are unique |
| 11 | Task names are unique |
| 12 | Workflow step `agent` and `task` references resolve |
| 13 | Workflow DAG is acyclic |
| 14 | If `contracts:` is present, referenced schemas exist and are valid JSON Schema |
| 15 | `runtime_requirements.minimum` declares at least one runtime |
| 16 | Every runtime in `runtime_requirements` has a corresponding adapter available |

### 15.3 Non-Blocking Checks (Advisories)

- `tools:` is declared (recommended).
- `description` follows the "[verb] [domain]. Use when… Do NOT use for…" pattern.
- Agent body contains the four canonical sections (identity, guidelines, process, output).
- `features_required` list is non-empty.
- Memory GC policy is declared if persistent memory is used.

### 15.4 Adapter Validation Stage

After Core validation passes, the harness loads the target adapter and runs adapter-declared validators. Adapter validators enforce runtime-specific rules (e.g., model name resolution, flag format checks, body-size limits specific to the runtime).

### 15.5 Fix Reports

When validation fails, the validator emits a structured fix report:

```bash
squads validate ./my-squad --report    # human-readable markdown
squads validate ./my-squad --fix       # auto-fix safe issues
squads validate ./my-squad --json      # machine-readable
```

The report groups errors by file, shows the expected shape, and suggests specific edits.

---

## 16. Security

### 16.1 Trust Boundaries

| Layer | Trust level | What belongs |
|-------|-------------|--------------|
| **L0: Runtime** | Trusted | The harness itself, the adapter |
| **L1: Squad** | Verified | Validated squads from known sources |
| **L2: Data** | Untrusted | User input, external API responses, web content |
| **L3: Output** | Audited | Squad outputs (reviewed before action) |

### 16.2 Capability Declaration

A squad declares its capability needs:

```yaml
# squad.yaml
capabilities:
  required:
    - filesystem_read
    - filesystem_write_scoped   # only to output/
  forbidden:
    - network_egress
    - git_write
    - shell_privileged
```

The harness enforces these at tool-grant time. Capabilities map to adapter primitives differently per runtime.

### 16.3 Secret Handling

Secrets never appear in:
- Squad manifests
- Agent frontmatter
- Agent body
- Task body
- Workflow definitions
- Handoff artifacts
- Logs

Secrets are referenced by name:

```yaml
env_required: [GITHUB_TOKEN, OPENAI_API_KEY]
```

The harness resolves them at runtime from environment variables, encrypted stores, or secret managers. How resolution happens is adapter-specific.

### 16.4 Audit Trail

Every handoff, every tool invocation, and every state transition is logged with timestamp, agent, tool, arguments (sanitized), and result summary. Audit trail emission is a harness responsibility; the adapter documents the format.

### 16.5 Sandboxing

Squads that require sandboxed execution (restricted filesystem, no network, memory limits) declare this in the manifest:

```yaml
execution:
  sandbox: true
  filesystem: restricted   # only output/ writable
  network: denied
```

Adapters map sandbox declarations to runtime mechanisms (containers, seatbelts, restricted profiles). Runtimes that cannot sandbox **must refuse to load** squads that require it (fail-closed).

---

## 17. Versioning

### 17.1 Protocol Version

This specification follows SemVer 2.0.0 at the **protocol** level:

| Change | Bump |
|--------|------|
| New optional field in Core schema | Minor |
| Breaking schema change in Core | Major |
| Clarification, bug fix, editorial | Patch |

**Current Core protocol version: 4.0.0.**

### 17.2 Squad Version

Each squad has its own semver:

| Change | Bump |
|--------|------|
| Breaking change to squad output schema | Major |
| New agent, new task, new workflow | Minor |
| Prompt improvement, workflow fix | Patch |

### 17.3 Adapter Version

Each adapter has its own semver, declared in its manifest:

| Change | Bump |
|--------|------|
| Breaking change to adapter contract | Major |
| New feature supported, new validator | Minor |
| Runtime version update, clarification | Patch |

### 17.4 Compatibility Declarations

```yaml
# squad.yaml
protocol: "4.0"         # Core protocol this squad targets
version: "1.2.3"        # squad's own version
```

```yaml
# adapters/{runtime}.yaml
protocol_version: "4.0"     # Core protocol this adapter supports
adapter_version: "1.0.0"    # adapter's own version
```

The harness loads the newest adapter version compatible with the squad's declared `protocol`.

---

## 18. Runtime Compatibility

### 18.1 runtime_requirements Declaration

```yaml
runtime_requirements:
  minimum:
    - runtime: runtime-a
      version: ">=2.0.0"
  compatible:
    - runtime: runtime-b
      version: ">=1.0.0"
    - runtime: runtime-c
      version: ">=0.5.0"
  incompatible:
    - runtime: runtime-d
      reason: "Does not support required subagent spawning primitive"
```

**Semantics:**

- `minimum`: at least one listed runtime MUST be available at load time. Fail-closed.
- `compatible`: the squad loads and degrades optional features gracefully on these runtimes.
- `incompatible`: explicit non-support. The harness refuses to load on these runtimes.

### 18.2 Feature Flags

Features are named capabilities the squad either requires or prefers:

```yaml
features_required:
  - max_turns
  - tool_whitelist
  - handoff_artifacts

features_optional:
  - subagent_spawning
  - project_memory
  - hooks
  - sandboxing
```

**Canonical feature names:**

| Feature | Meaning |
|---------|---------|
| `max_turns` | Runtime enforces turn bound declared in agent frontmatter |
| `tool_whitelist` | Runtime restricts tools to declared list |
| `handoff_artifacts` | Runtime can pass structured data between agents |
| `subagent_spawning` | Runtime can launch sub-invocations in parallel |
| `sequential_execution` | Runtime can chain agents serially |
| `project_memory` | Runtime supports per-project persistent memory |
| `global_memory` | Runtime supports cross-project persistent memory |
| `hooks` | Runtime exposes pre/post tool-use hooks |
| `sandboxing` | Runtime can constrain filesystem/network/compute |
| `web_search` | Runtime provides web search |
| `file_write` | Runtime allows file creation/modification |
| `shell_exec` | Runtime allows shell command execution |
| `fork_context` | Runtime can fork a conversation with inherited context |
| `teammate_primitive` | Runtime supports peer-to-peer teammate messaging |

Adapters declare `features_supported` in their manifest. The harness rejects squads whose `features_required` contain any feature the adapter does not support.

### 18.3 Feature × Runtime Compatibility Matrix

The authoritative matrix lives in each adapter's §2 Feature Support Matrix. Core maintains only the canonical feature names.

Legend: ✅ supported · 🟡 partial / advisory · ⚠️ degrades · ❌ unsupported

Squad authors check each adapter's matrix before declaring `runtime_requirements`.

### 18.4 Graceful Degradation Contract

When `features_optional` contains a feature the adapter lists as unsupported:

1. The harness logs the degradation at load time.
2. The harness substitutes the documented fallback for that feature.
3. Execution continues.

**Documented fallbacks:**

| Missing feature | Fallback |
|----------------|----------|
| `subagent_spawning` | Sequential execution |
| `hooks` | Pre/post behavior skipped; squad responsible |
| `project_memory` | Session-scope memory only |
| `sandboxing` | Refuses to load if sandbox is `required` |

### 18.5 Adapter Contract (Full)

Every adapter provides the following:

**Manifest (`adapters/{runtime_id}.yaml`):**

- `adapter.runtime_id`, `adapter.runtime_name`, `adapter.vendor`
- `adapter.adapter_version`, `adapter.protocol_version`
- `adapter.minimum_runtime_version`
- `features_supported[]`, `features_unsupported[]`
- `concept_mapping.*`
- `numeric_values.*` (all runtime-specific numbers live here)
- `validators[]`
- `invocation.examples[]`

**Documentation (`adapters/{runtime_id}.md`):**

Fifteen sections:
1. Adapter Metadata
2. Feature Support Matrix
3. Concept Mapping
4. Frontmatter Mapping
5. Tool Whitelist Mechanics
6. Max-Turns Mechanics
7. Subagent Spawning
8. Memory Storage
9. Context Window & Compaction
10. Hook System
11. Invocation Examples
12. Runtime-Specific Validators
13. Known Limitations
14. Source References
15. Version History

**Required minimum** (adapters must document at least these): 1, 2, 3, 6, 11, 13.

### 18.6 Writing a New Adapter

See `adapters/_template-adapter.md` for the authoring template and `references/11-adapters-guide.md` for the authoring guide.

---

## 19. Pattern Maturity Classification

Every composition pattern in this protocol is labeled with a maturity level.

### 19.1 Functional Patterns (Production-Ready)

These patterns work reliably on all mainstream runtimes.

**Router / Handoff.** A lightweight classifier selects which specialist handles the request. Low cost, predictable, supported natively on runtimes with agent lists.

**Sequential Pipeline.** Fixed linear order. Each step depends on the previous. Risk: token multiplication across steps if histories are not compacted. Mitigation: handoff artifacts instead of full histories.

**Fan-Out / Fan-In.** Independent steps execute in parallel; an aggregator merges results. Requires `subagent_spawning` or degrades to sequential.

### 19.2 Problematic Patterns

These patterns work but come with costly tradeoffs.

**Hierarchical Manager + Workers.** A manager agent decomposes work, delegates to workers, aggregates results. Fragile and expensive: re-planning loops and context inflation compound. Use only when decomposition genuinely requires dynamic reasoning (not when it can be expressed as a static DAG). Bound re-planning depth to 3.

**Group Chat / Full Mesh.** All agents see all messages, any agent may speak. Without constraints, degenerates into non-deterministic chaos with 100K+ tokens burned on debate. Viable only with finite-state-machine constraints (fixed roles, scripted transitions).

### 19.3 Aspirational Patterns

These patterns are researched and promising, but **not reliably implemented** on current runtimes. Do not rely on them in production.

**Adaptive Agent Selection.** A router that selects agents based on problem complexity, not just domain. Current routers dispatch by topic keywords; true complexity-aware routing is not production-ready.

**Squad-of-Squads.** One squad invokes another as a black-box subroutine. Conceptually clean; runtime support is partial at best.

**Formal Human-in-the-Loop with Suspension.** A workflow suspends, serializes, waits for human input, then resumes. Most runtimes support only blocking-terminal human input. Resumable suspension typically requires an external durable workflow engine.

### 19.4 How to Read the Label

| Label | Production use? |
|-------|-----------------|
| Functional | Yes |
| Problematic | Yes, with caution and bounds |
| Aspirational | No; document as future work |
| Proposed (see §20) | No; under discussion |

---

## 20. Proposed (Not Implemented)

This section lists features the protocol **proposes** but does not require adapters or harnesses to implement. They are honest aspirations, not silent contracts.

### 20.1 Doom-Loop Detection

A harness-level mechanism that detects when an agent produces N consecutive outputs with similarity above a threshold T, and takes corrective action (change strategy, escalate, abort).

**Status:** No mainstream runtime implements this at the harness level. `maxTurns` is the only universal safeguard.

**Proposed spec:**

- Method: Jaccard similarity over token sets.
- Default threshold: 0.90.
- Default trigger: 3 consecutive outputs above threshold.
- Actions: `abort`, `change-strategy`, `escalate`.

Squad authors who need this behavior should implement it in a workflow-level reviewer agent.

### 20.2 Circuit Breakers for Cost

A harness-level mechanism that aborts a squad when cumulative cost exceeds a declared budget.

**Status:** Partial. Some runtimes track cost but do not enforce budget caps. Squad-level budgets are an aspirational feature.

**Proposed spec:**

```yaml
budgets:
  max_cost_usd: 5.00
  max_tokens: 500000
  on_exceed: abort | warn
```

### 20.3 Cross-Agent Memory Sharing

A formalized API for one agent to publish a fact that another agent subsequently reads, outside of handoff artifacts.

**Status:** Implementable via the filesystem (shared `output/` directory), but no standardized read-write API exists at the harness level.

### 20.4 Live Progress Streaming

A standardized event stream from an executing squad to a monitor UI.

**Status:** Runtime-specific telemetry exists but not a portable format. OpenTelemetry GenAI conventions are the emerging candidate.

### 20.5 How to Track Proposals

Proposals move to Functional or are removed when at least one adapter implements them and at least one production squad depends on them. The version history in each adapter documents when a proposal became supported.

---

## 21. Legacy Support

### 21.1 Accepted Versions

v4 harnesses accept squads written against:

- **v4.0** (this spec) — native.
- **v3.1** — auto-upgraded at load with warnings.
- **v2.0** CC flat format — auto-upgraded at load with warnings.
- **v2.0** legacy nested YAML format — auto-upgraded via shim, deprecated with warnings.

### 21.2 Version Detection

The validator inspects `squad.yaml` to detect the declared version:

| Indicator | Detected version |
|-----------|-----------------|
| `protocol: "4.0"` present | v4.0 |
| `protocol` absent, `maxTurns` mandatory in all agents | v3.1 (assumed) |
| `protocol` absent, agents use flat frontmatter | v2.0 CC flat |
| Agent files contain nested `agent:` / `persona:` blocks | v2.0 legacy nested |

### 21.3 Auto-Upgrade Shims

**v2.0 → v4.0 shim (at load):**

1. Inject `protocol: "4.0"` into the manifest (in-memory only).
2. Assume `runtime_requirements.minimum = [claude-code]` (the original v2 target).
3. Wrap all flat frontmatter under `runtimes.claude-code.*`.
4. Inject default `maxTurns: 25` for any agent missing it; log a warning per agent.
5. Move `agents_metadata` from top-level (v2) to `ui.agents_metadata` (v4).
6. Map `harness.*` (v2) to the corresponding adapter namespace.

**v3.1 → v4.0 shim (at load):**

1. Inject `protocol: "4.0"` into the manifest.
2. Move runtime-specific values (compaction thresholds, CLI flags, file names) from root-level fields into `runtimes.{detected_runtime}.*`.
3. Detect runtime from SRC citations and filename references; default to `claude-code` if unclear.
4. Convert pattern-maturity-uncategorized patterns to Core §19 labels with warnings.

### 21.4 Persistent Migration

Auto-upgrade is an in-memory transformation only. To persist the upgrade to disk:

```bash
squads migrate --from v2 --to v4 ./my-squad
squads migrate --from v3.1 --to v4 ./my-squad
```

The migration tool:

- Rewrites `squad.yaml` with explicit `protocol` and `runtime_requirements`.
- Moves runtime-specific fields into `runtimes.{id}.*` namespaces.
- Injects mandatory `maxTurns` where missing.
- Renames `harness.*` → adapter-specific namespaces.
- Writes a `MIGRATION.md` log of changes.

### 21.5 Deprecation Timeline

| Version | v2 flat | v2 nested | v3.1 | v4.0 |
|---------|---------|-----------|------|------|
| v4.0 (this) | accepted | accepted (warn) | accepted | native |
| v4.1 (planned) | accepted | accepted (stronger warn) | accepted | native |
| v5.0 (planned) | accepted with shim | removed | accepted with shim | native |

v2 nested YAML format is scheduled for removal at v5.0. All other legacy formats continue to be accepted with shims.

### 21.6 Writing New Squads

New squads **must** declare `protocol: "4.0"` and use the v4 schema. Writing a new squad in v2 or v3.1 format is a protocol violation even though the harness will load it.

---

## Appendix A: Portable Tool Names (Canonical)

| Semantic name | Category | Typical mapping |
|--------------|----------|-----------------|
| `read` | File I/O | File read tool |
| `write` | File I/O | File create/overwrite tool |
| `edit` | File I/O | File modification tool |
| `grep` | Search | Content search tool |
| `glob` | Search | File pattern search |
| `bash` / `shell` | Exec | Shell command tool |
| `web_search` | Web | Web search tool |
| `web_fetch` | Web | URL fetch tool |
| `git` | VCS | Git operations |
| `http` | Network | HTTP client |

Adapters map these to runtime-local tool names.

---

## Appendix B: Canonical Feature Names

Normative list of feature names used in `features_required` / `features_optional` / `features_supported`:

- `max_turns`
- `tool_whitelist`
- `handoff_artifacts`
- `subagent_spawning`
- `sequential_execution`
- `project_memory`
- `global_memory`
- `session_memory`
- `hooks`
- `sandboxing`
- `web_search`
- `file_write`
- `shell_exec`
- `fork_context`
- `teammate_primitive`

Adapters MAY declare additional runtime-specific features; Core recognizes only the names above for `features_required` / `features_optional` matching.

---

## §16bis Output Artifact Convention (v4.1)

The `output:` block in squad.yaml is **optional**. When absent or set to `default`, the runtime resolves a standard output path. Squad developers MAY override it with a custom path.

**Rationale:** Squads serve hundreds of projects. Without a convention, each squad invented its own path (`./video-output`, `./squads-output`, etc), polluting projects. v4.1 establishes a standard default while preserving squad developer freedom.

**Default convention:** The runtime (via skill/adapter) resolves output paths using:

```
{project-root}/.squads-outputs/{squad-name}/{YYYY-MM-DDTHHMMSS}-{slug}/
```

**`output:` field behavior (3 modes):**

| squad.yaml | Behavior |
|------------|----------|
| `output:` absent | Default — `.squads-outputs/{squad-name}/{timestamp}-{slug}/` |
| `output.base_dir: default` | Explicit default — same as absent |
| `output.base_dir: ./custom-path` | Custom — runtime uses `{project-root}/{custom-path}/{squad-name}/{timestamp}-{slug}/` |

**Rules:**
1. Squads reference their output directory via the environment variable `$SQUAD_RUN_DIR` injected by the runtime at execution time.
2. The runtime auto-creates `.squads-outputs/README.md` on first run for AI-discoverability.
3. The runtime does NOT auto-modify `.gitignore` — the user decides per-project.
4. Project root is resolved via: `$SQUADS_PROJECT_ROOT` env var > walk-up to `.git/` > fallback cwd().

**Resolver:** `lib/output-resolver.js` implements path resolution. Runtimes MUST use this resolver.

---

## Appendix C: Version History

| Version | Date | Changes |
|---------|------|---------|
| 4.1.0 | 2026-04-05 | Deprecated `output:` in squad.yaml. Output convention owned by skill/runtime. `.squads-outputs/` standard. §16bis. |
| 4.0.0 | 2026-04-04 | Runtime-agnostic rewrite. Two-layer architecture. `maxTurns` mandatory. Pattern maturity labels. Runtime compatibility matrix. Namespaced extensions. |
| 3.1.0 (proposal) | 2026-03 | Engineering manual; Claude-Code-verified values; mandatory `maxTurns`. Superseded by 4.0. |
| 2.0.0 | 2026-04-03 | CC flat format standard. Legacy nested format deprecated but supported. |
| 1.x | 2025-2026 | Initial squad protocol, legacy nested YAML only. |

---

*End of Squad Protocol Specification v4.0.0 Core.*

*Runtime-specific details live in `adapters/{runtime_id}.md`. To author a new adapter, see `adapters/_template-adapter.md` and `references/11-adapters-guide.md`.*
