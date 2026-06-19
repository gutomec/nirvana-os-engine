# Business Protocol Specification

```
Title:    Business Protocol Specification
Version:  1.0.0-draft
Status:   DRAFT (peer review pending)
Date:     2026-05-02
Author:   Luiz Gustavo Vieira Rodrigues (Prospecteezy)
License:  MIT
Scope:    Runtime-agnostic core for autonomous business operation
Related:  Squad Protocol v5 (`SQUAD_PROTOCOL_V5.md`), Harness Protocol v1 (`HARNESS_PROTOCOL_V1.md`)
```

## About This Spec

The Business Protocol defines a portable standard for **zero-human operation of multi-agent organizations**. A business is a self-contained package of employees (persistent specialized agents), an org chart (hierarchy + routing), processes (organizational workflows), memory (3-tier with project isolation), and handoff mechanisms (mentions, tickets, escalation, delegation, auto-routing) that together accomplish ongoing work for clients without human-in-the-loop.

A business reads briefs, decomposes them, routes work between employees according to its org chart and routing rules, manages handoffs with structured context preservation, runs self-evaluation gates before each handoff, escalates to human only when configured triggers fire, and persists project state in isolation per client.

Business Protocol v1.0 is the spiritual successor to Paperclip's company model. Paperclip introduced the operational primitives (mentions, tickets, hierarchy routing, context preservation, self-scoring) that make zero-human teams work. v1.0 codifies those primitives as a runtime-agnostic protocol so the same business can run on Claude Code, Codex, Gemini-CLI, or any other adapter, without depending on a centralized server.

### Two-layer rule (inherited from Squad Protocol v4)

This document is the **Core Protocol**: conceptual model, contracts, and rules valid on every runtime. Runtime-specific mechanics (heartbeat scheduling, mention notification mechanics, ticket persistence) live in `adapters/{runtime_id}.{md,yaml}`.

### Zero-human as a first-class concept

v1.0 treats zero-human as the default operating mode, not as an aspiration. Every primitive in this protocol is designed so that the business can operate continuously without human intervention, with explicit and configurable triggers for the rare cases where human input is required (legal review, budget exception, hard escalation). Business authors who want human-in-the-loop must opt-in explicitly via configuration.

---

## Table of Contents

1. Introduction and Scope
2. Terminology
3. Design Principles (BP1-BP12)
4. Architecture Layers
5. Business Structure (filesystem layout)
6. Manifest (`business.yaml`)
7. Employees (persistent specialized agents)
8. Org Chart (hierarchy + reporting + routing)
9. Memory Model (3-tier with project isolation)
10. Handoff Mechanisms (the 5 paperclip primitives, formalized)
11. Self-Scoring Contracts
12. Zero-Human Operation Mode
13. Brief Routing (entry point)
14. Workflow Patterns (heartbeat, brief processing, approval chain, escalation cascade)
15. Tool Whitelist (per employee, per project)
16. Validation
17. Security & Sandboxing
18. Versioning & Compatibility
19. Pattern Maturity
20. Proposed (Not Implemented)
21. Paperclip Migration (legacy compatibility)
App-A: Canonical Employee Roles Catalog
App-B: Canonical Capability Domains for Businesses
App-C: JSON Schemas (business.yaml, employee.md, org-chart.yaml, ticket.json, mention.json)
App-D: Example Business (`agency-marketing-conglomerate-x`)
App-E: Migration Guide from Paperclip Company

---

## §1 Introduction and Scope

### 1.1 Purpose

The Business Protocol defines a portable standard for autonomous multi-agent organizations that:

- Operate continuously without human-in-the-loop (zero-human default).
- Receive client briefs and decompose them into work for specialized employees.
- Route work between employees through structured handoffs (mentions, tickets, escalation, delegation, auto-routing).
- Maintain hierarchy, reporting lines, and approval chains.
- Persist memory per business (institutional, cross-session) and per project (isolated, per-client).
- Run on any agentic runtime with a compatible adapter.

A **business** is a self-contained package of:

- A manifest declaring identity, capabilities, employees, runtime requirements.
- A culture document (institutional CLAUDE.md).
- Employee definitions (persistent specialized agents).
- Org chart (hierarchy + reporting + routing).
- Processes (organizational workflows).
- Memory (institutional + per-project + per-session).
- Routing rules (how briefs enter, how work is escalated/delegated).
- Handoff conventions (mention syntax, ticket schema, escalation triggers).

### 1.2 What this protocol IS

- A conceptual model for autonomous organizations of AI agents.
- A file-and-folder contract (`business.yaml`, `employees/*.md`, `org-chart.yaml`, `processes/`, `memory/`).
- Portable schemas with namespaced runtime extensions.
- A formal specification of the 5 handoff mechanisms (mention, ticket, escalation, delegation, auto-routing).
- A specification for zero-human operation with explicit human-escalation triggers.

### 1.3 What this protocol is NOT

- Not a runtime. Does not execute employees.
- Not a replacement for Squad Protocol. A business uses squads; squads do not use businesses.
- Not a CRM, ticketing system, or project management tool. It defines minimal primitives that adapters implement.
- Not a guarantee that every runtime enforces every concept. Optional features degrade gracefully (per Squad Protocol P9).
- Not a license to deploy AI agents in regulated industries without human oversight. Businesses operating under regulatory constraints MUST configure escalation triggers per applicable law.

### 1.4 Relationship to Squad Protocol v5

| Aspect | Squad Protocol v5 | Business Protocol v1 |
|---|---|---|
| Unit of work | Atomic capability with finite output | Continuous operation across multiple capabilities |
| Lifetime | One workflow execution | Ongoing (heartbeats, projects, briefs) |
| State | Stateless or session-scoped | Persistent institutional + per-project memory |
| Composition | Workflow DAG (pre-defined) | Dynamic routing via handoffs (mention-driven) |
| Hierarchy | Flat (agents are peers within a workflow) | Strict (employees report to other employees) |
| Discovery | Capability index + BM25 | Brief routing via routing.yaml + mention parsing |
| Output convention | `.squads-outputs/{squad}/{ts}/` | `.projects-outputs/{project}/businesses/{biz}/` |
| Invokes | Tools, sub-agents | Squads (declared in `squads_authorized`), other employees |
| Orchestration model | Static workflow + (occasionally) AgentTool spawn | Dynamic via handoff mechanisms (§10) |

A business invokes squads to deliver atomic capabilities. A squad does not invoke a business. The harness routes between them (Harness Protocol v1).

### 1.5 Audience

Business authors, harness implementers, adapter authors. Operations teams responsible for monitoring and configuring zero-human triggers. Compliance officers who configure regulatory escalation rules.

---

## §2 Terminology

| Term | Definition |
|---|---|
| **Business** | A self-contained package of employees, org chart, processes, memory, and routing, packaged under `business.yaml`. The unit of organizational coherence. |
| **Employee** | A persistent specialized agent within a business. Defined by a Markdown file with YAML frontmatter (config) and a body (system prompt). Has a role, reports to another employee (or none, if CEO), may manage other employees. |
| **Org Chart** | A YAML declaration of reporting lines and management spans across employees. Used by routing rules to resolve escalation and delegation. |
| **Brief** | An incoming work request from a client (or another business). The unit of input that triggers business activity. |
| **Project** | A scope of work for one client. Briefs are bound to projects. Memory and outputs are isolated per project. |
| **Mention** | A handoff primitive. Syntax `@employee_name` in any content (markdown body, ticket field, response). Triggers notification + handoff to the mentioned employee. |
| **Ticket** | A handoff primitive. Structured work item opened by one employee for another. Has type (request, review, approval), priority, due_date, body, expected output schema. |
| **Escalation** | A handoff primitive. Sending work upward in the org chart (employee → manager → CEO) when scope/budget/decision exceeds employee authority. |
| **Delegation** | A handoff primitive. Sending work downward in the org chart (manager → direct report). |
| **Auto-routing** | A handoff primitive. Routing rules in `routing.yaml` that map brief patterns to employees automatically (skip mention/ticket overhead for known categories). |
| **Self-Score** | Self-evaluation by an employee against declared success criteria before emitting a handoff. |
| **Heartbeat** | Periodic invocation of an employee to check goals, process pending work, emit reports. Cadence defined per employee. |
| **Zero-Human Mode** | Operation without human intervention except at explicitly configured escalation triggers. Default mode. |
| **Escalation Trigger** | A configured condition under which the business pauses operation and requests human input (budget exceeded, regulatory red flag, repeated failure, etc.). |
| **Approval Chain** | A sequence of employees who must approve a deliverable before it goes to the client (typically: producer → reviewer → manager → CEO). |
| **Handoff Artifact** | Structured data passed between employees on handoff. Inherits Squad Protocol v4 §9 schema with business extensions (mention, ticket_id, project_id). |
| **Project Memory** | Memory scoped to one client/project. Isolated by construction (`${PROJECTS_OUTPUT_DIR}/{project}/`). |
| **Permanent Memory** | Memory scoped to the business institutionally (cross-session, cross-project). Voice, patterns, learned facts about own organization. |
| **Antagonist** | An employee whose role is to challenge consensus and surface anti-patterns. Required for businesses with >5 employees. |
| **DNA Reference** | A pointer from an employee (when `type: mind_clone`) to a canonical mind-clone in `${DNA_LIBRARY}/`. |

---

## §3 Design Principles

The Business Protocol inherits Squad Protocol v4 principles P1-P10 (separation of audiences, prose over structure, token discipline, bounded iteration, fail-closed defaults, task-first, runtime neutrality, technical honesty, graceful degradation, namespaced extensions). It adds twelve business-specific principles.

### BP1: Zero-Human is the Default

Every primitive is designed so the business operates without human intervention. Human-in-the-loop is opt-in via explicit escalation triggers. Operations that cannot be automated (final legal sign-off, regulatory review, sensitive client conversations) are escalated, not blocked silently.

### BP2: Hierarchy is Real, Not Decorative

Employees report to other employees. Managers can delegate; subordinates can escalate. The org chart is enforced by routing rules. An employee cannot bypass their manager to talk directly to the CEO unless the routing rules permit it (and the violation is logged).

### BP3: Handoffs are Structured, Not Free-Form

The five handoff mechanisms (mention, ticket, escalation, delegation, auto-routing) are the only ways work moves between employees. Free-form chat is not a handoff. Every handoff produces a Handoff Artifact (inheriting Squad v4 §9 schema) with mention metadata, ticket reference (if any), project_id, and self-score.

### BP4: Self-Score Before Handoff

Every employee declares success criteria for their work. Before emitting a handoff, the employee performs self-evaluation against those criteria. The self-score is part of the Handoff Artifact. Receiving employees use self-score to decide whether to accept, reject, or escalate.

### BP5: Memory is Three-Tiered with Construction-Time Isolation

Permanent (cross-session, business-level), Project (per-client, isolated by construction), Session (per-invocation, runtime-native). The harness refuses to read project memory from a project other than the current one. Cross-project contamination is impossible by file path access.

### BP6: Brief is the Unit of Entry

The unit of incoming work is the Brief. Briefs are routed via `routing.yaml` rules to an entry employee (typically CEO or designated brief intake role). Once a brief is accepted, it becomes a Project (or extends an existing Project), and all internal work flows from there.

### BP7: Antagonists are Mandatory for Coherent Businesses

Every business with more than 5 employees MUST declare at least one employee with `is_antagonist: true`. The antagonist's role is to challenge consensus, surface anti-patterns, and force consideration of alternative paradigms. Validators reject businesses that violate this rule.

### BP8: Default to functional_specialist, Not mind_clone

Employees default to `type: functional_specialist` (composes frameworks from N sources without claiming any single identity). Use `type: mind_clone` only when the business explicitly trades on a specific person's identity (and disclosure flags are required). This reduces legal risk and token bloat.

### BP9: Approval Chains are Mandatory for Client-Facing Output

Any deliverable that reaches a client (not internal) MUST traverse an Approval Chain declared in the business manifest or in the relevant process. The minimum chain is producer → reviewer → final approver. The chain is enforced by the harness.

### BP10: Heartbeats are Bounded, Not Indefinite

An employee's heartbeat MUST declare maximum cadence (e.g., hourly, daily, weekly) and budget per cycle. The harness refuses to start unbounded loops. Heartbeats that produce no output for N consecutive cycles are paused (not killed) and flagged for review.

### BP11: Project Outputs are Source-of-Truth, Memory is Cache

The output of a project lives in `${PROJECTS_OUTPUT_DIR}/{project}/` as files (markdown, JSON, code). Project memory is a derived cache for fast LLM retrieval. The files are canonical; if memory and files disagree, files win. This makes rollback trivial (delete memory, re-derive from files).

### BP12: Audit Trail is Non-Negotiable

Every handoff, every ticket transition, every escalation, every approval, every cost emission is logged with timestamp, employee, project, and structured payload. Audit trail is enforced at the Harness level. A business cannot operate without audit trail enabled (the runtime adapter MUST support this; if it can't, the business refuses to load).

---

## §4 Architecture Layers

### 4.1 Three Layers

```
┌─────────────────────────────────────────────────────┐
│  CORE PROTOCOL (this document)                      │
│  • Conceptual model                                 │
│  • business.yaml + employees/ + org-chart.yaml      │
│  • Handoff mechanisms (5 primitives)                │
│  • Memory tiers + project isolation                 │
│  • Self-score contracts                             │
│  • Zero-human operation mode                        │
│  • BP1-BP12 + inherited Squad P1-P10                │
└─────────────────────────────────────────────────────┘
                       │
                       │ uses
                       ▼
┌─────────────────────────────────────────────────────┐
│  SQUAD PROTOCOL v5 (`SQUAD_PROTOCOL_V5.md`)         │
│  • Capabilities the business invokes                │
│  • Atomic, finite-output workflows                  │
└─────────────────────────────────────────────────────┘
                       │
                       │ orchestrated by
                       ▼
┌─────────────────────────────────────────────────────┐
│  HARNESS PROTOCOL v1 (`HARNESS_PROTOCOL_V1.md`)     │
│  • Routes briefs to businesses                      │
│  • Routes capabilities to squads                    │
│  • Enforces budget, telemetry, audit                │
└─────────────────────────────────────────────────────┘
                       │
                       │ implemented by
                       ▼
┌─────────────────────────────────────────────────────┐
│  Adapters (claude-code, codex, gemini-cli, ...)     │
│  • How handoffs notify (signal, polling, event bus) │
│  • How heartbeats schedule (cron, runtime daemon)   │
│  • How tickets persist (JSON files, DB)             │
└─────────────────────────────────────────────────────┘
```

### 4.2 What belongs to Core

- The 5 handoff mechanisms (mention, ticket, escalation, delegation, auto-routing) as conceptual primitives.
- The org chart structure and routing rule semantics.
- The memory tier semantics and isolation contract.
- The self-score contract.
- The zero-human operation mode and its escalation trigger taxonomy.
- The brief routing entry point.
- The handoff artifact extensions (mention, ticket_id, project_id, self_score).
- The approval chain enforcement requirement.

### 4.3 What belongs to Adapters

- How mentions trigger notifications (filesystem watch, event bus, polling).
- How tickets persist (JSON in `tickets/`, SQLite, external API).
- How heartbeats schedule (Cron + Claude Code, runtime daemon, scheduled remote agents).
- How approval chains are surfaced (terminal prompts, web UI, async messaging).
- Numeric values: heartbeat cadence ranges, ticket TTLs, escalation timeouts.
- Source citations to runtime implementations.

---

## §5 Business Structure (filesystem layout)

### 5.1 Canonical layout

```
{business-name}/
├── business.yaml             # REQUIRED: manifest
├── culture.md                # REQUIRED: institutional CLAUDE.md (voice, rules, patterns)
├── employees/                # REQUIRED: at least 1 employee
│   ├── ceo.md
│   ├── cmo.md
│   ├── ...
│   └── skeptic-in-residence.md   # required if employee_count > 5 (BP7)
├── org-chart.yaml            # REQUIRED: hierarchy + reporting
├── routing.yaml              # REQUIRED: brief routing rules + mention/escalation policy
├── processes/                # OPTIONAL: organizational workflows (analogous to squad workflows)
│   ├── client-onboarding.yaml
│   ├── quarterly-review.yaml
│   └── ...
├── memory/                   # PERMANENT memory (cross-session, business-level)
│   ├── patterns.md           # learned patterns
│   ├── learned-facts.md      # auto-curated, GC-policied
│   └── voice.md              # institutional voice and tone (extends culture.md)
├── tickets/                  # OPTIONAL: persistent ticket store (adapter-dependent)
│   └── (managed by adapter)
├── secrets-manifest.yaml     # references to env vars, NEVER values
├── budgets.yaml              # max_cost_usd, hard_stop, warning_pct, per-employee budgets
├── escalation-triggers.yaml  # explicit conditions for human-in-the-loop
├── approval-chains.yaml      # OPTIONAL: declared approval chains by output type
├── README.md                 # human-readable overview
└── legacy/                   # OPTIONAL: preserved artifacts from paperclip migration
    ├── paperclip-company-id  # UUID original
    ├── paperclip-export.json # raw export from companyPortabilityService
    ├── goals.yaml            # if still used
    ├── org-analysis.yaml
    ├── anti-pattern-report.yaml
    ├── payloads/
    └── deploy.sh
```

### 5.2 Name rules

- Business names: kebab-case `[a-z][a-z0-9-]{1,63}`.
- Employee names: kebab-case, matching the file name (`employees/cmo-strategy.md` declares `name: cmo-strategy`).
- Process names: kebab-case.
- Capability ids referenced in `business.yaml` follow Squad Protocol v5 §22 (dotted hierarchical).

---

## §6 Manifest (`business.yaml`)

### 6.1 Required fields

```yaml
name: marketing-conglomerate-x
version: "1.0.0"
protocol: "1.0"
description: "Conglomerate operating zero-human across 4 marketing domains."
author: "you@yourdomain.com"
license: MIT
```

### 6.2 Domains and capabilities

```yaml
domains: [marketing, growth, branding, content]   # canonical from App-B

capabilities:
  # Capabilities the business EXPOSES (clients can request these)
  - business.strategy.positioning
  - marketing.campaign.full_funnel
  - branding.identity.create
  - content.production.scale

squads_authorized:
  # Whitelist: which squads any employee in this business can invoke.
  # OMITTED or EMPTY = all squads in the registry are permitted (open delegation).
  # Declare the list only to RESTRICT to a subset.
  - awwwards-singularity-studio
  - brandcraft-nirvana
  - instagram-intelligence-nirvana
  - copywriting-infoprodutos
```

**Authorization rule.** `squads_authorized` is a restriction, not a requirement.
When it is omitted or empty, every squad in the registry is permitted — a
business with no whitelist can delegate to anything it discovers. When present,
it is the closed set; an employee invoking a squad outside it is a logged
violation. Per-employee `squads_authorized` (in employee frontmatter) further
restricts to a subset of the business list.

### 6.3 Operation mode

```yaml
operation_mode: zero_human   # zero_human | hybrid | human_in_loop

# zero_human: operates autonomously; only escalates per escalation-triggers.yaml
# hybrid: requires human approval at marked checkpoints in approval-chains.yaml
# human_in_loop: every client-facing output requires explicit human approval
```

### 6.4 Output and memory

```yaml
output:
  base_dir: default            # = ${PROJECTS_OUTPUT_DIR}/{project}/businesses/{slug}/
  # OR: base_dir: ./custom-outputs (relative to project root)

memory:
  permanent:
    enabled: true
    files:
      - patterns.md
      - learned-facts.md
      - voice.md
    garbage_collection:
      max_facts: 500
      review_interval_days: 60
      conflict_resolution: replace   # replace | append | prompt
  project:
    isolation: by_construction   # by_construction | advisory
    layout:
      memory_file: memory.md
      handoff_history: handoffs/
      tickets: tickets/
      audit_log: audit.jsonl
```

### 6.5 Runtime requirements

```yaml
runtime_requirements:
  minimum:
    - {runtime: claude-code, version: ">=1.0.0"}
  compatible:
    - {runtime: codex, version: ">=0.20.0"}
    - {runtime: gemini-cli, version: ">=0.4.0"}

features_required:
  - max_turns
  - tool_whitelist
  - subagent_spawning
  - audit_trail              # Business Protocol BP12

features_optional:
  - hooks
  - sandboxing
  - scheduled_invocation    # for heartbeats; degrades to manual cron if missing
  - event_bus               # for native mention notifications; degrades to filesystem watch
```

### 6.6 Environment

```yaml
env_required:
  - ANTHROPIC_API_KEY
  - GEMINI_API_KEY           # if any squad invoked uses it
```

### 6.7 Legacy reference (optional)

```yaml
legacy:
  paperclip_company_id: "0084d097-cdf9-4bdb-a181-ffdd7f02eede"
  paperclip_instance: default
  paperclip_data_dir: ${NIRVANA_HOME}/nirvana-command/.paperclip-data
  migration_date: "2026-05-15T10:00:00Z"
  migration_audit_log: ~/.migration-logs/2026-05-15/marketing-conglomerate-x.json
```

### 6.8 UI metadata (optional, marketplace only)

```yaml
ui:
  icon: "🏢"
  category: "marketing-agencies"
  client_facing_name: "Marketing Conglomerate X"
  pitch: "Brief in. Empire out."
  employees_metadata:
    ceo:
      icon: "👑"
      title: "Chief Executive"
```

---

## §7 Employees (persistent specialized agents)

### 7.1 Structure

Employees are defined as Markdown files with YAML frontmatter. The frontmatter is for the runtime; the body is for the LLM. (Inherits Squad v4 P1.)

```markdown
---
name: cmo-strategy
role: "Chief Marketing Officer"
type: functional_specialist          # functional_specialist | mind_clone (default: functional_specialist)
reports_to: ceo
manages: [head-of-content, head-of-growth, head-of-brand]
description: "Strategic marketing leader. Use when brief involves multi-channel decisions or repositioning."
maxTurns: 30
tools: [read, write, web_search, web_fetch]
model: inherit
budget_monthly_usd: 200
heartbeat:
  cadence: hourly                    # hourly | daily | weekly | manual
  max_cost_per_cycle_usd: 0.50

is_antagonist: false
is_brief_intake: false               # only one employee per business may have this true (typically CEO)

# Squads this employee is authorized to invoke (subset of business.squads_authorized)
squads_authorized:
  - awwwards-singularity-studio
  - brandcraft-nirvana

# DNA composition (only when type=functional_specialist)
draws_from:
  - {source: alex-hormozi, weight: 0.4, use_for: [offer-design, lead-gen]}
  - {source: dan-kennedy, weight: 0.3, use_for: [direct-response]}
  - {source: jay-abraham, weight: 0.3, use_for: [strategy, ltv]}

# DNA reference (only when type=mind_clone)
# dna_reference: ${DNA_LIBRARY}/47-creative-director/david-droga.md
# disclosure_required: true
# commercial_use_allowed: review

# Self-score contract (BP4)
self_score_contract:
  required_before_handoff: true
  criteria:
    - id: clarity
      description: "Output is unambiguous and actionable for the receiving employee"
      threshold: 0.7
    - id: completeness
      description: "Output addresses all explicit asks in the input"
      threshold: 0.8
    - id: alignment
      description: "Output respects the business culture (voice, anti-patterns)"
      threshold: 0.8
  on_below_threshold: revise          # revise | escalate | annotate

memory:
  permanent_path: memory/cmo.md       # this employee's slice of permanent memory

# Mention handling (§10.1)
mentions:
  receives:
    - "@cmo"
    - "@cmo-strategy"
    - "@chief-marketing"
  notification_priority: high          # high | normal | low
---

# CMO · Marketing Strategy

[Body: identity, guidelines, process, output format, anti-patterns. Same structure as Squad Agent v4 §6.5.]

## Identity
You are the CMO of {business.name}. Your scope is strategic, not operational. You read briefs, decide priorities, delegate execution to direct reports, validate deliverables before client-facing approval.

## Guidelines

### DO
- Decide allocation of budget across channels
- Delegate execution to head-of-content, head-of-growth, head-of-brand via @mention or ticket
- Validate deliverables from direct reports before they go up to CEO
- Invoke authorized squads when an atomic capability accelerates the work
- Self-score every output against your declared criteria before handoff
- Escalate to @ceo when scope exceeds R$50k or requires legal review

### DO NOT
- Execute campaigns yourself (delegate)
- Approve budgets > R$50k without CEO sign-off
- Create client-facing deliverables without validation by a head
- Skip self-score on handoffs

## Process
1. Receive brief from @ceo or auto-routed from routing.yaml
2. Read project memory at ${PROJECT_OUTPUT_DIR}/${project_id}/businesses/${business_slug}/memory.md
3. Decompose brief into sub-objectives
4. For each sub-objective: decide whether to delegate (open ticket, @mention head), invoke a squad, or both
5. Receive deliverables from heads, validate against business culture
6. Consolidate, self-score, emit handoff artifact to @ceo (escalation) or to client output (final)

## Output

For internal handoffs:
- Handoff artifact in `${PROJECT_OUTPUT_DIR}/${project_id}/handoffs/${ts}-cmo-to-${target}.json`
- Self-score in handoff artifact

For client-facing:
- Final deliverable in `${PROJECT_OUTPUT_DIR}/${project_id}/final/`
- Decisions log in `${PROJECT_OUTPUT_DIR}/${project_id}/businesses/${business_slug}/cmo-decisions.json`

## Anti-patterns
- Never approve a campaign without ROI projection
- Never delegate without writing the success criteria into the ticket
- Never escalate without first attempting one round of clarification with the requester
```

### 7.2 Required frontmatter fields

| Field | Type | Purpose |
|---|---|---|
| `name` | kebab-case | Identity, mention target, validation |
| `role` | string | Human-readable title |
| `type` | enum | `functional_specialist` (default) or `mind_clone` |
| `description` | string | Selection criterion (when harness routes) |
| `maxTurns` | int | Loop bound (Squad v4 P4) |
| `reports_to` | string or null | Manager employee name; null only for top of org chart (CEO) |
| `self_score_contract` | object | BP4: criteria + thresholds |

### 7.3 Recommended frontmatter fields

| Field | Type | Purpose |
|---|---|---|
| `manages` | array | Direct reports |
| `tools` | array | Tool whitelist |
| `model` | string | Model family hint |
| `budget_monthly_usd` | number | Per-employee monthly budget cap |
| `heartbeat` | object | Cadence + cost cap per cycle |
| `is_antagonist` | bool | BP7 antagonist flag |
| `is_brief_intake` | bool | One per business |
| `squads_authorized` | array | Subset of business squads_authorized |
| `mentions.receives` | array | Mention aliases this employee responds to |

### 7.4 Body structure

Inherits Squad Protocol v4 §6.5 (Identity, Guidelines DO/DO NOT, Process, Output, Anti-patterns). Adds Business-specific sections:

- **Handoff conventions**: how this employee emits and receives handoffs (mention vs ticket, expected schemas).
- **Escalation rules**: under what conditions this employee escalates upward.
- **Delegation rules**: under what conditions this employee delegates downward.

### 7.5 Mind-clone employees (special case)

When `type: mind_clone`, the employee references a canonical DNA in `${DNA_LIBRARY}/` (consolidated from `/Volumes/guto1/mindclones/`, `~/.claude/agents/`, `${SQUADS_DIR}/sales-funnel-masters/specialists/`).

```yaml
type: mind_clone
dna_reference: ${DNA_LIBRARY}/47-creative-director/david-droga.md
disclosure_required: true                # mandatory true for type=mind_clone
commercial_use_allowed: review           # never | review | allowed
disclosure_template: |
  This output was generated in the style of {dna_reference.name}.
  See ${DNA_LIBRARY}/{dna_reference.path}/fidelity/ for source attribution.
```

The harness MUST prepend the disclosure to any output emitted by a mind_clone employee when `disclosure_required: true`.

The DNA reference loads the canonical mind-clone definition (frontmatter + body) and merges it into the employee's system prompt at runtime. The employee.md body is short (just business-specific scoping); the DNA file provides the cognitive substrate.

### 7.6 Employee lifecycle

```
UNLOADED → LOADED → IDLE → ACTIVE → IDLE → UNLOADED
                      ↑              ↓
                      └──────────────┘
                       (next handoff)

Special transitions:
- HEARTBEAT: IDLE → ACTIVE (scheduled, every cadence)
- ESCALATED: ACTIVE → ESCALATED (waiting on human, runtime adapter notifies)
- DRAINED: ACTIVE → DRAINED (graceful shutdown for cutover/migration)
```

The harness manages lifecycle transitions. Adapter implements heartbeat scheduling per §18.

---

## §8 Org Chart (hierarchy + reporting + routing)

### 8.1 Structure

```yaml
# org-chart.yaml
chart:
  - employee: ceo
    reports: []                 # CEO has no manager
    direct_reports: [cmo-strategy, cto, cfo, skeptic-in-residence]

  - employee: cmo-strategy
    reports: [ceo]
    direct_reports: [head-of-content, head-of-growth, head-of-brand]

  - employee: head-of-content
    reports: [cmo-strategy]
    direct_reports: [content-writer, social-manager]

  - employee: skeptic-in-residence
    reports: [ceo]              # antagonist reports to CEO directly
    direct_reports: []
    is_antagonist: true
    antagonizes: [cmo-strategy, head-of-growth]   # whose paradigm they challenge

# Routing rules (used by escalation, delegation, auto-routing)
routing_rules:
  escalation_path:
    # When an employee escalates, who receives by default
    head-of-content: cmo-strategy
    cmo-strategy: ceo
    head-of-growth: cmo-strategy
    head-of-brand: cmo-strategy

  default_skip_levels: false   # escalation can skip levels only if flag is true

  cross_team_handoff_allowed: true   # employees can handoff sideways (head-of-content → head-of-growth)
                                     # without going through their managers

  antagonist_invocation:
    # Conditions under which antagonist is automatically pulled in
    triggers:
      - "any deliverable >= R$10k of impact"
      - "any decision involving 3+ employees"
      - "any escalation to ceo"
```

### 8.2 Validation rules

A valid `org-chart.yaml` MUST satisfy:

1. Exactly one employee has `reports: []` (the CEO equivalent).
2. Every employee in `direct_reports` of any other has matching `reports:` pointing back.
3. No cycles (tree structure).
4. Every employee in the chart exists in `employees/`.
5. Antagonists are marked with `is_antagonist: true` AND in employee's frontmatter.
6. `routing_rules.escalation_path` covers every non-CEO employee.

---

## §9 Memory Model (3-tier with project isolation)

### 9.1 The three tiers

```
PERMANENT (cross-session, business-level)
  Path: ${BUSINESSES_DIR}/{biz-slug}/memory/
  Files: patterns.md, learned-facts.md, voice.md, {employee-slug}.md
  Lifetime: indefinite
  Writable: only in maintenance mode (`businesses memory edit {biz}`)

PROJECT (per-client, isolated by construction)
  Path: ${PROJECTS_OUTPUT_DIR}/{project}/businesses/{biz-slug}/
  Files: memory.md, employees/{emp-slug}/memory.md, handoffs/, tickets/, audit.jsonl
  Lifetime: as long as project is active
  Writable: by employees during normal operation (filtered by §9.4 isolation)

SESSION (per-invocation, runtime-native)
  Path: runtime-managed
  Lifetime: one invocation
  Writable: ephemeral
```

### 9.2 What goes where

| Content | Tier |
|---|---|
| Business voice, brand rules, anti-patterns | Permanent (`voice.md`, `patterns.md`) |
| Learned facts about the business itself ("we don't take healthcare clients") | Permanent (`learned-facts.md`) |
| Client brief + decisions made for that client | Project (`memory.md`) |
| Handoff history between employees on this project | Project (`handoffs/`) |
| Tickets opened on this project | Project (`tickets/`) |
| Cost audit trail | Project (`audit.jsonl`) |
| Working state mid-invocation | Session (runtime) |

### 9.3 Isolation by construction

The Harness MUST refuse to read project memory from a project_id different from the current invocation's project_id. The mechanism is path-based: the harness sets the working project root at invocation time, and `ProjectMemoryReader` only opens paths that begin with that root.

```typescript
// Harness pseudo-code
function loadProjectMemory(employee, currentProjectId) {
  const projectRoot = `${PROJECTS_OUTPUT_DIR}/${currentProjectId}`;
  const memoryPath = `${projectRoot}/businesses/${employee.business}/employees/${employee.name}/memory.md`;

  // GUARD: refuse to load anything outside currentProjectId's root
  if (!memoryPath.startsWith(projectRoot)) {
    throw new IsolationViolation(`Refused to load memory outside project ${currentProjectId}`);
  }

  return readFile(memoryPath);
}
```

Cross-project contamination is impossible because the path mechanism makes it impossible to even reference another project's memory file from within an invocation scoped to a project.

### 9.4 Test for isolation (mandatory in onboarding)

Every business added to production MUST pass the isolation test:

```bash
# Run two briefs for two different projects in the same business
$ harness brief --project cliente-A --business marketing-x "Brief A: launch product X..."
$ harness brief --project cliente-B --business marketing-x "Brief B: rebrand for client Y..."

# Verify no cross-contamination
$ grep -r "cliente-A" .projects-outputs/cliente-B/  # MUST be empty
$ grep -r "cliente-B" .projects-outputs/cliente-A/  # MUST be empty
$ grep -r "produto X" .projects-outputs/cliente-B/  # MUST be empty
```

The Harness includes `harness test isolation {business}` that automates this check.

### 9.5 Permanent memory garbage collection

```yaml
# in business.yaml
memory:
  permanent:
    garbage_collection:
      max_facts: 500             # hard cap on total learned facts
      review_interval_days: 60   # frequency of GC review
      conflict_resolution: replace
        # replace: new fact replaces conflicting old fact
        # append: both kept with timestamps
        # prompt: ask in next maintenance cycle
```

GC runs automatically when `businesses memory gc {biz}` is invoked, OR weekly via heartbeat schedule.

---

## §10 Handoff Mechanisms (the 5 paperclip primitives, formalized)

This section is the heart of the Business Protocol. The five mechanisms below are how work moves between employees. They are the only sanctioned ways. Free-form chat is not a handoff.

### 10.1 Mention (`@employee_name`)

**Purpose:** Lightweight, in-content handoff. Used inside markdown bodies, ticket fields, response messages.

**Syntax:** `@{employee_name}` or `@{role-alias}` where role-alias is declared in employee's `mentions.receives:` array.

**Examples:**
- `@cmo please review this campaign plan and approve before launch`
- `@head-of-growth take this from here and run the AB test`
- `@ceo escalating this because budget exceeds my authority`

**Handoff artifact:**

```json
{
  "schemaVersion": "1.0.0",
  "type": "mention",
  "from": "head-of-content",
  "to": "cmo-strategy",
  "mention_text": "@cmo please review this campaign plan and approve before launch",
  "context_path": "${PROJECT_OUTPUT_DIR}/${project_id}/handoffs/2026-05-02T15-30-00-content-to-cmo.json",
  "self_score": {
    "clarity": 0.85,
    "completeness": 0.90,
    "alignment": 0.80
  },
  "expected_response": "approval | revisions | escalation",
  "deadline": "2026-05-02T18:00:00Z"
}
```

**Adapter responsibility:**
- Detect mentions in any output emitted by employees.
- Notify mentioned employee (event bus, filesystem watch, polling — adapter choice).
- Schedule mentioned employee for next active turn.

### 10.2 Ticket (structured work item)

**Purpose:** Heavier-weight handoff for work that needs tracking (open/in-progress/resolved). Used for significant requests, reviews, approvals.

**Schema** (`~/.claude/skills/_shared/schemas/core-schemas.json#/definitions/ticket`):

```json
{
  "ticket_id": "TKT-2026-05-02-0001",
  "schemaVersion": "1.0.0",
  "type": "request | review | approval | bug | escalation",
  "priority": "low | normal | high | urgent",
  "from": "head-of-content",
  "to": "cmo-strategy",
  "project_id": "cliente-x",
  "business": "marketing-conglomerate-x",
  "subject": "Approve Q4 campaign creative direction",
  "body": "Markdown body with full context, including links to artifacts in project output...",
  "expected_output": {
    "type": "approval | revisions | rejection",
    "schema": "schemas/approval-response.json"
  },
  "due_date": "2026-05-03T18:00:00Z",
  "self_score": {...},
  "linked_handoff": "handoffs/2026-05-02T15-30-00-content-to-cmo.json",
  "status": "open | in_progress | resolved | rejected",
  "created_at": "2026-05-02T15:30:00Z",
  "resolved_at": null,
  "history": [
    {"event": "opened", "by": "head-of-content", "at": "2026-05-02T15:30:00Z"},
    {"event": "in_progress", "by": "cmo-strategy", "at": "2026-05-02T16:00:00Z"}
  ]
}
```

**Persistence:**
- Default: JSON files in `${PROJECT_OUTPUT_DIR}/${project_id}/businesses/${biz}/tickets/`
- Adapter MAY persist in alternative store (SQLite, external API). Adapter MUST document.

**State machine:**

```
open → in_progress → resolved
  ↓        ↓             ↓
  ↓     paused        rejected
  ↓        ↓
  └──→ cancelled
```

**SLA defaults (configurable in `business.yaml`):**

```yaml
tickets:
  default_sla:
    low: 5 days
    normal: 2 days
    high: 1 day
    urgent: 4 hours
  on_sla_breach:
    action: escalate     # escalate | notify | nothing
    escalate_to: manager # manager | ceo | antagonist
```

### 10.3 Escalation (upward in org chart)

**Purpose:** When work scope, budget, or decision authority exceeds the current employee's, push it up the org chart.

**Triggers (configurable per employee in frontmatter):**

```yaml
# In employee frontmatter
escalation_triggers:
  - condition: budget_exceeds
    threshold: 50000
    currency: USD
    escalate_to: cmo-strategy
  - condition: legal_review_required
    detect: "matches /legal|compliance|gdpr|lgpd|hipaa/i in brief"
    escalate_to: legal-counsel
  - condition: scope_change_proposed
    escalate_to: ceo
  - condition: client_complaint_received
    escalate_to: head-of-customer-success
  - condition: confidence_below
    threshold: 0.5    # employee unsure of their own output
    escalate_to: skeptic-in-residence    # antagonist for stress-test
```

**Mechanism:** Escalation generates a ticket with `type: escalation` and high priority, plus a `@mention` of the target employee, plus an audit log entry.

**Routing:** The org chart's `routing_rules.escalation_path` determines where escalation goes by default. The frontmatter `escalation_triggers` can override per condition.

**Skip-level escalation:** Disabled by default. To enable, set `routing_rules.default_skip_levels: true` in `org-chart.yaml`. When enabled, escalation MAY skip the immediate manager (e.g., directly to CEO) when condition warrants. Always logged.

### 10.4 Delegation (downward in org chart)

**Purpose:** Manager assigns work to a direct report.

**Syntax:** Open a ticket with `from: {manager}, to: {direct-report}, type: request`. Optionally include `@mention`.

**Constraints:**
- Manager can only delegate to employees in their `manages:` array (declared in employee.md).
- Cross-team delegation requires `routing_rules.cross_team_handoff_allowed: true`.
- Delegated work MUST include success criteria (used by direct report for self-score).

**Example:**

```markdown
@head-of-content I need a content calendar for cliente-X for Q4. Goals: engagement +20%, lead-gen +15%. Budget: $5k. Deadline: 2026-05-10. Use brandcraft-nirvana squad for visual brief.

[Manager opens ticket TKT-...-0042 with type=request, attaches success criteria, expected output schema]
```

### 10.5 Auto-routing (skip mention/ticket overhead)

**Purpose:** For brief patterns that always go to the same employee, skip the dance.

**Configuration in `routing.yaml`:**

```yaml
auto_routes:
  # When a brief matches these patterns, auto-route to the named employee
  - pattern: "rebrand|reposition|brand identity"
    route_to: head-of-brand
    confidence_threshold: 0.7

  - pattern: "performance|paid ads|conversion"
    route_to: head-of-growth

  - pattern: "content calendar|editorial|blog"
    route_to: head-of-content

  - pattern: "compliance|gdpr|lgpd|legal"
    route_to: legal-counsel
    requires_escalation_to: ceo    # also CC the CEO

  - pattern: ".*"   # catch-all: brief goes to brief-intake (CEO by default)
    route_to: ceo
```

**Mechanism:** When a brief enters via `harness brief --business {biz}`, the routing engine matches it against `auto_routes` patterns in order. First match wins. If no match, falls through to `ceo` (or whoever has `is_brief_intake: true`).

**Override:** User can force routing with `--route-to {employee}` flag.

### 10.6 The handoff artifact (extension of Squad v4 §9)

Every handoff (mention or ticket) produces a Handoff Artifact stored in `${PROJECT_OUTPUT_DIR}/${project_id}/handoffs/`. Schema extends Squad v4 §9.2:

```json
{
  "schemaVersion": "1.0.0",
  "from_agent": "head-of-content",
  "to_agent": "cmo-strategy",
  "summary": "Content calendar for Q4 ready for review",
  "key_decisions": [
    "Focus on educational long-form to feed retargeting funnel",
    "Two pillar topics: data privacy + AI productivity",
    "Cadence: 2 long-form/week + 5 short-form/week"
  ],
  "files_modified": [
    ".projects-outputs/cliente-x/businesses/marketing-x/employees/head-of-content/content-calendar-q4.md",
    ".projects-outputs/cliente-x/businesses/marketing-x/employees/head-of-content/topic-research.md"
  ],
  "blockers": [],
  "next_action": "Review content calendar and approve or request revisions",
  "artifacts": [
    "content-calendar-q4.md",
    "topic-research.md"
  ],

  "business_extensions": {
    "type": "mention | ticket | escalation | delegation | auto_route",
    "mention_text": "@cmo please review",
    "ticket_id": "TKT-2026-05-02-0042",
    "project_id": "cliente-x",
    "business_slug": "marketing-x",
    "self_score": {
      "clarity": 0.85,
      "completeness": 0.90,
      "alignment": 0.80,
      "passes_threshold": true
    },
    "expected_response": "approval | revisions | escalation",
    "deadline": "2026-05-03T18:00:00Z",
    "audit_trail_id": "audit-2026-05-02-15-30-00"
  }
}
```

Size limits (inherits Squad v4 §9.2): key_decisions ≤ 5, files_modified ≤ 10, blockers ≤ 3, total ≤ 800 tokens.

---

### 10.7 Writing contract (BP13)

Every prose deliverable that lands in front of a human follows the **writing contract** appended to `AGENTS.md` / `CLAUDE.md` / `GEMINI.md`. The contract is auto-loaded by every supported runtime (Claude Code, Antigravity CLI, Gemini CLI, Codex, Cursor) before the agent generates anything, so the rules are present in the agent's system prompt from turn 1.

The contract bans: dash-stitching, filler openers ("In summary", "Moreover", "It's worth noting"), chat artifacts ("Great question!", "Let me know if"), cutoff disclaimers, vague attribution ("Experts say"), copula avoidance ("serves as", "boasts"), negative parallelism, decorative emojis in headings, and orphan widows. It requires varied sentence length and concrete voice (opinions, "I"/"eu" when fitting, specific over vague).

**Enforcement model — prevention only.** The contract is a prompt-injection contract; there is no post-hoc rewrite pass and no skill invocation. The `wiki-lint` rubric in the quality gate is a cheap regex pass/fail check for the structural patterns above; if it fails, the gate fails the build. Audit emits `wiki_lint_passed` or `wiki_lint_failed` accordingly.

**Rationale (BP13):** prose with AI tells breaks the "zero-human operation" perception the moment the client reads it. Putting the contract in the runtime-loaded memory file (CLAUDE.md / AGENTS.md / GEMINI.md) means every dispatched agent gets the rules in context for free — no extra token cost per dispatch, full cache hits on the stable prefix.

---

## §11 Self-Scoring Contracts (BP4)

### 11.1 The contract

Every employee declares success criteria in their frontmatter. Before emitting a handoff, the employee MUST self-score against those criteria. The score is part of the handoff artifact.

```yaml
# In employee frontmatter
self_score_contract:
  required_before_handoff: true
  criteria:
    - id: clarity
      description: "Output is unambiguous and actionable for the receiving employee"
      threshold: 0.7
      weight: 1.0
    - id: completeness
      description: "Output addresses all explicit asks in the input"
      threshold: 0.8
      weight: 1.5
    - id: alignment
      description: "Output respects the business culture (voice, anti-patterns)"
      threshold: 0.8
      weight: 1.2
    - id: confidence
      description: "Producer's confidence in correctness"
      threshold: 0.6
      weight: 1.0
  on_below_threshold: revise   # revise | escalate | annotate
  max_revise_iterations: 2     # bounded loop
```

### 11.2 Mechanism

After the employee produces an output (artifact, decision, response), the harness invokes a self-score sub-prompt:

```
You produced the following output for {receiver}:
{output}

Score yourself against these criteria:
{criteria}

For each criterion: {0.0-1.0} score and 1-2 sentence justification.

Return JSON: {"clarity": 0.85, "clarity_justification": "...", ...}
```

The score is stored in the handoff artifact. If any criterion is below its threshold:

- `on_below_threshold: revise`: employee gets one more turn to revise (bounded by `max_revise_iterations`)
- `on_below_threshold: escalate`: handoff goes to manager instead of intended target (manager decides whether to send anyway or send back)
- `on_below_threshold: annotate`: handoff proceeds but is annotated with `passes_threshold: false`; receiver knows to be cautious

### 11.3 Why self-score before handoff

The receiving employee can decide whether to accept the work, send back for revision, or escalate further. Without self-score, the receiver has to do their own evaluation from scratch (expensive). With self-score, the producer surfaces known issues, the receiver decides triage cheaply.

This implements the paperclip "self-scoring before handoff" mechanism.

### 11.4 Validation

Self-score is part of every handoff artifact when `required_before_handoff: true`. The harness validates presence at handoff emission. Missing self-score blocks the handoff.

---

## §12 Zero-Human Operation Mode (BP1)

### 12.1 Default mode

`operation_mode: zero_human` in `business.yaml` is the default. The business operates without human intervention except at explicitly configured escalation triggers.

### 12.2 Escalation triggers (when human MUST intervene)

`escalation-triggers.yaml`:

```yaml
escalation_triggers:
  # Budget triggers
  - id: budget_monthly_exceeds
    condition: "monthly_cost_usd > 1000"
    severity: high
    notify: human    # human | manager | ceo | antagonist
    action: pause    # pause | warn | continue
    timeout_minutes: 60   # if no human response, action taken automatically

  - id: budget_per_brief_exceeds
    condition: "brief_cost_usd > 50"
    severity: medium
    notify: ceo
    action: warn

  # Quality triggers
  - id: consecutive_self_score_failures
    condition: "self_score_below_threshold_consecutive_count >= 3"
    severity: high
    notify: human
    action: pause

  - id: client_complaint_received
    condition: "incoming_message contains pattern (complaint|cancel|refund|terminate)"
    severity: high
    notify: human
    action: pause

  # Regulatory / legal triggers
  - id: legal_keyword_detected
    condition: "any output contains pattern (gdpr|lgpd|hipaa|gdpr|lawsuit|court|attorney)"
    severity: high
    notify: legal-counsel  # employee role
    action: pause_until_resolved

  # Operational triggers
  - id: heartbeat_unproductive
    condition: "consecutive_heartbeats_without_progress >= 5"
    severity: low
    notify: ceo
    action: pause_employee    # pause this employee, business continues

  - id: ticket_sla_breached_critical
    condition: "ticket.priority == urgent AND time_since_open > 4h AND status != resolved"
    severity: high
    notify: ceo + human
    action: warn

  # Scope triggers
  - id: scope_creep_detected
    condition: "project.deliverables_count > 1.5 * project.original_estimate"
    severity: medium
    notify: ceo
    action: warn

  # Anti-pattern triggers (self-policing via antagonist)
  - id: antagonist_red_flag
    condition: "antagonist explicit veto on deliverable"
    severity: high
    notify: ceo + human
    action: pause_until_resolved
```

### 12.3 What "notify human" means

When `notify: human` fires:

1. The business pauses the relevant scope (per `action`).
2. Audit log entry created: `{event: "human_notification_required", trigger_id: ..., context: ..., timestamp: ...}`.
3. Adapter delivers the notification per its mechanism:
   - Claude Code: emits a structured message in the next session
   - Codex: writes to a configured webhook
   - Gemini-CLI: pushes to a configured email/slack
4. Resume command: `harness resume {project} {trigger_id}` after human input.

### 12.4 The "no humans available" fallback

If escalation fires `notify: human` and no human responds within `timeout_minutes`:

- The trigger's `action` is enforced (pause, warn, continue).
- A second-level audit entry is created.
- The business continues with reduced confidence (subsequent operations annotated).

### 12.5 Audit trail

Every escalation, every "human required" event, every resume is logged in `${PROJECT_OUTPUT_DIR}/${project_id}/audit.jsonl` (append-only, JSONL format):

```json
{"ts": "...", "event": "trigger_fired", "trigger_id": "...", "context": "...", "severity": "high"}
{"ts": "...", "event": "notification_sent", "trigger_id": "...", "channel": "..."}
{"ts": "...", "event": "human_response_received", "trigger_id": "...", "response": "..."}
{"ts": "...", "event": "resume", "trigger_id": "...", "by": "human|automatic"}
```

### 12.6 Hybrid mode

For businesses that operate in regulated industries or with cautious clients, `operation_mode: hybrid` requires human approval at marked checkpoints in `approval-chains.yaml`. The business runs autonomously between checkpoints; at each checkpoint, it pauses and emits notification.

```yaml
# business.yaml
operation_mode: hybrid

# approval-chains.yaml
approval_chains:
  client_facing_deliverable:
    chain:
      - producer: head-of-content
      - reviewer: cmo-strategy
      - approver: ceo
      - human_checkpoint: required    # explicit human approval
    on_approval: deliver_to_client
    on_rejection: send_back_to_producer
```

### 12.7 Human-in-loop mode

`operation_mode: human_in_loop` requires explicit human approval for every client-facing output. The business is essentially a tool used by humans, not autonomous. Acceptable for early adoption, cautious clients, or specific regulatory requirements.

---

## §13 Brief Routing (entry point)

### 13.1 The brief flow

```
External brief (client, harness, schedule)
  ↓
harness routes to business via Harness Protocol §3
  ↓
business receives brief via routing.yaml
  ↓
auto_routes pattern match → entry employee selected
  (or fallback to is_brief_intake: true employee, typically CEO)
  ↓
entry employee processes:
  1. Reads project memory (creates if first brief in project)
  2. Decomposes brief
  3. Delegates to direct reports via tickets/mentions
  4. (or) invokes squad for atomic capability
  5. Heartbeat may continue work asynchronously (per cadence)
  ↓
brief moves through org chart per handoff mechanisms
  ↓
final deliverable validated through approval chain (if declared)
  ↓
output to ${PROJECT_OUTPUT_DIR}/${project_id}/final/
  ↓
audit trail closed for this brief
```

### 13.2 routing.yaml

```yaml
# routing.yaml
brief_intake:
  default_employee: ceo            # who receives if no auto_route matches
  alternates:
    - condition: "brief contains URGENT prefix"
      route_to: ceo
      bypass_auto_routes: true

auto_routes:
  - pattern: "rebrand|reposition|brand identity"
    route_to: head-of-brand
    confidence_threshold: 0.7

  - pattern: "performance|paid ads|conversion"
    route_to: head-of-growth

mention_routing:
  # When an external mention (e.g., from another business or harness) arrives
  - mention: "@business"
    route_to: ceo
  - mention: "@cmo"
    route_to: cmo-strategy

ticket_intake:
  # External tickets (from another business or external system)
  default_assignee: ceo
  by_type:
    bug: cto
    legal_review: legal-counsel
    creative_review: head-of-brand
```

### 13.3 Project lifecycle from brief

```
First brief for project_id
  → harness creates ${PROJECT_OUTPUT_DIR}/${project_id}/ (if not exists)
  → harness creates ${PROJECT_OUTPUT_DIR}/${project_id}/businesses/${biz}/ (if not exists)
  → harness creates audit.jsonl, handoffs/, tickets/ subdirs
  → harness writes brief to ${PROJECT_OUTPUT_DIR}/${project_id}/brief.md
  → harness invokes business with brief content + project_id

Subsequent briefs same project
  → same project root
  → entry employee reads project memory before processing
```

### 13.4 Squad delegation (mode-aware)

A business employee is an orchestrator, not just a doer. Before producing an
atomic deliverable by hand, it should ask "is there a squad for this?" — squads
are the reusable, audited capability units; composition beats regeneration.

The employee acts the way the maestro acts when a squad is requested, with one
difference: it has a role and (when `type: mind_clone`) an incorporated persona.
So it does not pass the raw brief down — it builds a **brief-context** shaped by
its role and mind-clone (framing, priorities, constraints, voice) and hands that
to the squad, then integrates the squad's output back into the business's work.

**Discovery is governed by the system routing mode** (see Harness config
`routing.mode`, env `NIRVANA_ROUTING_MODE`):

- **agentic** (default) — the employee reasons over the squad registry
  (`capabilities[].domains` + `produces` + `example_briefs` + `keywords`) and
  picks the best-fit squad, the same way the maestro routes.
- **fast** — the employee uses zero-token BM25 discovery
  (`nrv find "<need>"` / `lib/router.js`) and takes the top match.

The flow:

```
employee has a sub-need it could delegate
  → is a specific squad named in the brief? → use it (always honored)
  → else discover a squad for the need, using the active routing mode
       → candidate must be permitted by squads_authorized
         (omitted/empty list = all permitted; see §6.2)
  → found? → build brief-context (role + mind-clone framing) → invoke squad
           → integrate squad output → continue
  → none fit? → the employee produces the deliverable itself
```

Invoking a squad outside the business's `squads_authorized` (when that list is
declared) is a logged violation, not a silent override.

---

## §14 Workflow Patterns (heartbeat, brief processing, approval chain, escalation cascade)

### 14.1 Heartbeat pattern

Periodic invocation of an employee. Configured per employee in frontmatter:

```yaml
# In employee frontmatter
heartbeat:
  cadence: hourly        # hourly | daily | weekly | manual
  max_cost_per_cycle_usd: 0.50
  enabled: true
  on_unproductive_cycle: continue   # continue | pause_after_n
  pause_after_n_unproductive: 5
```

When fired, the employee:

1. Reads project memory (across all active projects, OR scoped if specified)
2. Reviews open tickets assigned to them
3. Reviews mentions received since last heartbeat
4. Decides: act on something, or stay idle
5. If acts, emits handoff artifacts as needed
6. Updates project memory + permanent memory (if learned a pattern)
7. Self-scores

Adapter implementation:
- Claude Code: scheduled via Cron + `claude --print "/businesses heartbeat {biz} {emp}"`
- Codex: scheduled remote agent
- Gemini-CLI: scheduled via cron + `gemini --print ...`

### 14.2 Brief processing pattern

```
brief arrives → entry employee
  ↓
[entry employee turn]
  read project memory
  decompose brief into N sub-objectives
  for each sub-objective:
    decide: delegate (open ticket + @mention) | invoke squad | do directly
  emit decisions + handoffs
  self-score
  exit turn
  ↓
[delegated employees turn, asynchronously via heartbeat or immediately if event_bus]
  receive ticket + @mention
  process work
  emit handoff back to entry employee (or onward to another)
  self-score
  exit turn
  ↓
[entry employee next turn]
  receives handoffs from delegates
  consolidates
  if final deliverable: trigger approval chain
  if more work: more decomposition
```

### 14.3 Approval chain pattern

Declared in `approval-chains.yaml`:

```yaml
approval_chains:
  client_facing_deliverable:
    chain:
      - producer: any   # any employee can produce
      - reviewer: cmo-strategy
      - final_approver: ceo
    on_approval: deliver_to_client
    on_rejection_at_review: send_back_to_producer
    on_rejection_at_approval: escalate_to_human   # rejection at top means re-think

  internal_decision_above_50k_usd:
    chain:
      - proposer: any
      - approver: ceo
      - human_checkpoint: required   # if zero_human, escalates trigger
```

Mechanism:
- When an employee produces output marked as `client_facing: true`, harness routes through declared chain.
- Each step is a ticket of type `approval` with the producer's self-score attached.
- Approver can: approve, reject (back to producer), or escalate (skip-level).
- Final approver's approval emits `output_approved` event; deliverable copied to `${PROJECT_OUTPUT_DIR}/${project_id}/final/`.

### 14.4 Escalation cascade pattern

When an employee fails to handle, escalates upward:

```
employee A (e.g., content-writer)
  hits trigger (e.g., budget exceeds threshold)
  ↓
escalation ticket → manager (head-of-content)
  manager evaluates: can resolve, or escalate further
  ↓
if escalates further → cmo-strategy
  ↓
if further → ceo
  ↓
if ceo can't resolve → human (per escalation-triggers.yaml)
```

The cascade stops at the first level that can resolve, OR at the configured human-notification trigger.

---

## §15 Tool Whitelist (per employee, per project)

Inherits Squad Protocol v4 §10. Adds:

### 15.1 Per-project tool restriction

```yaml
# business.yaml
project_tool_overrides:
  # Restrict tools for sensitive projects
  by_project_pattern:
    "healthcare-*":
      forbidden_tools: [web_search, web_fetch]   # PHI never leaves the system
      reason: "HIPAA compliance"
    "legal-*":
      forbidden_tools: [bash]   # no shell exec
      reason: "Audit-trail integrity"
```

### 15.2 Per-employee tool inheritance

Employee inherits tools from the union of:
1. Business `default_tools` (declared in business.yaml)
2. Employee frontmatter `tools:`
3. Minus business `project_tool_overrides.forbidden_tools` (if applicable to current project)

Final tool set is enforced by the adapter at invocation time.

---

## §16 Validation

### 16.1 Two-stage validation (inherits Squad v4 §15)

Stage 1: Core (universal)
Stage 1.5: Business-specific
Stage 2: Adapter (runtime-specific)

### 16.2 Business core validation rules

| # | Check |
|---|---|
| 1 | `business.yaml` exists and parses |
| 2 | `name` is kebab-case |
| 3 | `protocol` is "1.0" or compatible |
| 4 | `culture.md` exists |
| 5 | `org-chart.yaml` exists and is valid (§8.2) |
| 6 | `routing.yaml` exists with brief_intake |
| 7 | At least 1 employee in `employees/` |
| 8 | Every employee in org-chart exists in `employees/` |
| 9 | If `employee_count > 5`: at least 1 employee with `is_antagonist: true` (BP7) |
| 10 | Exactly 1 employee with `is_brief_intake: true` |
| 11 | Every employee has `self_score_contract` declared (BP4) |
| 12 | Every employee's `reports_to` resolves to existing employee or null |
| 13 | `escalation-triggers.yaml` exists OR `operation_mode: human_in_loop` |
| 14 | `budgets.yaml` exists with hard_stop |
| 15 | All squads in `squads_authorized` exist in registry |
| 16 | All capabilities in `capabilities:` exist (or are declared experimental) |
| 17 | `runtime_requirements` declares features_required including `audit_trail` (BP12) |

### 16.3 Validation CLI

```bash
$ businesses validate {biz-slug}
$ businesses validate --all
$ businesses validate {biz-slug} --fix    # auto-fix safe issues
```

### 16.4 Isolation test (mandatory)

```bash
$ businesses test isolation {biz-slug}
```

Runs the §9.4 test. Fails if cross-project contamination detected.

---

## §17 Security & Sandboxing

Inherits Squad Protocol v4 §16. Business-specific extensions:

### 17.1 Capability declaration

```yaml
# business.yaml
capabilities_required:
  filesystem_read:
    - ${PROJECTS_OUTPUT_DIR}/${project_id}/**
    - ${BUSINESSES_DIR}/${name}/**
  filesystem_write:
    - ${PROJECTS_OUTPUT_DIR}/${project_id}/businesses/${name}/**   # only own scope in current project
  network_egress:
    - "*.openai.com"
    - "*.anthropic.com"
    - "api.gemini.google.com"
  shell_exec: forbidden_by_default
```

### 17.2 Cross-project access guard

Harness MUST refuse any filesystem operation that crosses project boundaries:

```typescript
function guardProjectAccess(employee, currentProjectId, requestedPath) {
  const allowedRoot = `${PROJECTS_OUTPUT_DIR}/${currentProjectId}`;
  if (!requestedPath.startsWith(allowedRoot) && !requestedPath.startsWith(`${BUSINESSES_DIR}/${employee.business}/`)) {
    throw new SecurityViolation(`Refused access to ${requestedPath} from project ${currentProjectId}`);
  }
}
```

### 17.3 Secret handling

Inherits Squad v4 §16.3. Secrets referenced by name in `secrets-manifest.yaml`, resolved by adapter from environment / Keychain / vault.

### 17.4 Audit trail (BP12 enforcement)

`audit_trail` is in `features_required`. If adapter doesn't support it, business refuses to load.

Audit log file: `${PROJECT_OUTPUT_DIR}/${project_id}/audit.jsonl`

Contains:
- Every handoff (mention, ticket, escalation, delegation, auto-route)
- Every ticket state transition
- Every approval chain checkpoint
- Every escalation trigger fired
- Every cost emission per employee turn
- Every memory write (permanent)

Retention: indefinite by default; configurable via `business.yaml`:

```yaml
audit_trail:
  retention:
    days: 365
    on_expiry: archive   # archive | delete | rotate
```

---

## §18 Versioning & Compatibility

Inherits Squad v4 §17.

### 18.1 Business protocol version

Currently 1.0.0. SemVer at the protocol level. Backward-compat shims for v0.x experimental versions (none exist yet; this is v1).

### 18.2 Business own version

Each business has its own SemVer in `business.yaml`. Independent of protocol version.

### 18.3 Runtime compatibility

```yaml
runtime_requirements:
  minimum:
    - {runtime: claude-code, version: ">=1.0.0"}
  compatible:
    - {runtime: codex, version: ">=0.20.0"}
    - {runtime: gemini-cli, version: ">=0.4.0"}
  incompatible: []
```

Features required by Business Protocol that may not be in all runtimes:

| Feature | Why needed | Fallback |
|---|---|---|
| `audit_trail` | BP12 | Refuse to load |
| `subagent_spawning` | Heartbeats + delegations | Refuse if heartbeats enabled |
| `scheduled_invocation` | Heartbeats | Manual cron + claude --print fallback |
| `event_bus` | Mention notifications | Filesystem watch fallback |
| `tool_whitelist` | §15 | Refuse |

---

## §19 Pattern Maturity

Inherits Squad v4 §19 maturity labels. Business-specific patterns:

### Functional (production-ready)

- **Brief processing** (§14.2): receive brief, decompose, delegate, consolidate
- **Heartbeat** (§14.1): periodic employee invocation
- **Mention-driven handoff** (§10.1): @employee_name in any content
- **Ticket-driven handoff** (§10.2): structured work items
- **Self-score before handoff** (BP4)
- **Project memory isolation by construction** (§9.3)
- **Auto-routing for known brief patterns** (§10.5)

### Problematic (works but tradeoffs)

- **Skip-level escalation**: convenient but disrupts org chart authority. Use only with explicit `routing_rules.default_skip_levels: true`.
- **Cross-team handoff**: bypasses managers. Use with `routing_rules.cross_team_handoff_allowed: true`. Logs prominently.
- **Hybrid operation mode** (§12.6): adds latency at every checkpoint. Use only when regulation requires.

### Aspirational (researched, not reliably implemented)

- **Multi-business orchestration**: harness routes brief to 2+ businesses simultaneously, each works on their slice. Conceptually clean but coordination overhead high.
- **Live human takeover**: human steps into a project mid-flight, takes over an employee's role. Requires runtime support for state inspection that no adapter currently provides cleanly.
- **Cross-business memory sharing**: business A learned a pattern that's useful to business B. Privacy + governance hard.

### Proposed (see §20)

- **Approval chain delegation across businesses**: business A's CEO has approval authority over business B's deliverables. Useful for holding-company structures.
- **Reputation scoring**: employees accumulate reputation based on accepted vs rejected handoffs. Useful for routing weight.

---

## §20 Proposed (Not Implemented)

| Proposal | Status | Notes |
|---|---|---|
| 20.1 | Multi-business orchestration | Harness can route to multiple businesses for one brief. Spec needed for inter-business handoff schema. |
| 20.2 | Approval chain delegation across businesses | Holding companies may want B's deliverables approved by A's CEO. |
| 20.3 | Employee reputation scoring | Track accept/reject ratio per employee, weight routing accordingly. |
| 20.4 | Cross-project memory sharing with consent | Business learns pattern in project A, applies in project B with explicit consent. |
| 20.5 | Live human takeover | Human steps into employee's role mid-flight. |
| 20.6 | Self-improving routing rules | Routing engine learns from past resolution success, adjusts auto_routes. |

---

## §21 Paperclip Migration (legacy compatibility)

### 21.1 Paperclip company → Business v1 mapping

| Paperclip artifact | Business v1 location | Notes |
|---|---|---|
| `company.yaml` | `business.yaml` | 1:1 with field renames |
| `agents/{id}.yaml` | `employees/{name}.md` (frontmatter) | YAML → Markdown frontmatter |
| `instructions/{agent}/SOUL.md` | `employees/{name}.md` (body) | merged |
| `instructions/{agent}/AGENTS.md` | `employees/{name}.md` (body, Process section) | merged |
| `instructions/{agent}/HEARTBEAT.md` | employee frontmatter `heartbeat:` block | extracted |
| `instructions/{agent}/TOOLS.md` | employee frontmatter `tools:` | extracted |
| `goals.yaml` | `legacy/goals.yaml` (preserved, optional consumption) | not core to v1 |
| `budgets.yaml` | `budgets.yaml` (1:1) | preserved |
| `routing.yaml` | `routing.yaml` (1:1, with extensions) | preserved + extended |
| `bridges/squad-bridges.yaml` | `business.yaml` `squads_authorized:` | extracted, simplified |
| `org-analysis.yaml` | `legacy/org-analysis.yaml` | preserved as reference |
| `anti-pattern-report.yaml` | `legacy/anti-pattern-report.yaml` OR `memory/patterns.md` | judgment call per business |
| `payloads/*.json` | `legacy/payloads/` | preserved for paperclip rollback |
| `secrets-manifest.yaml` | `secrets-manifest.yaml` (1:1) | preserved |
| `deploy.sh` | `legacy/deploy.sh` | preserved for rollback |
| `.company-id` (UUID) | `business.yaml` `legacy.paperclip_company_id:` | preserved |

### 21.2 Heartbeats migration

Paperclip's runtime heartbeats (every N seconds via paperclip server) become:

- Employee frontmatter `heartbeat.cadence: hourly|daily|weekly`
- Adapter-specific scheduler (Cron + `claude --print` for Claude Code)

Paperclip continues running during migration (per main plan). Once business cutover happens, paperclip company is marked `read_only: true` and the new heartbeats fire from the native scheduler.

### 21.3 Mentions migration

Paperclip mentions (@CTO, @marketing-director) work natively. Business v1 mentions parse the same `@employee_name` syntax from any output content. The migration just ensures every paperclip employee name has a corresponding business v1 employee name (kebab-case rename if needed).

### 21.4 Tickets migration

Paperclip's internal tickets are exported via `companyPortabilityService` as part of the export bundle. Migration tool converts each paperclip ticket to a Business v1 ticket JSON in `${PROJECT_OUTPUT_DIR}/${project_id}/businesses/${biz}/tickets/`.

For active tickets at migration time: paperclip remains source-of-truth for those tickets until the project completes them (or until cutover, per main plan §Wave 8).

### 21.5 Migration tool

`~/migration-tools/paperclip-to-business-v1.ts`:

```bash
# Dry-run preview
$ paperclip-to-business-v1 --company {paperclip_company_id} --output ${BUSINESSES_DIR}/{slug} --dry-run

# Full migration
$ paperclip-to-business-v1 --company {paperclip_company_id} --output ${BUSINESSES_DIR}/{slug}
$ businesses validate {slug}
$ businesses test isolation {slug}
```

The tool produces:
- `${BUSINESSES_DIR}/{slug}/` populated per §5 layout
- `~/.migration-logs/{date}/{slug}.json` with full audit
- Original paperclip company untouched

---

## App-A · Canonical Employee Roles Catalog

A controlled vocabulary for `role:` fields. Businesses MAY use custom roles by setting `experimental_role: true` (excluded from cross-business routing/discovery).

```
C-Suite:
  ceo, cmo, cto, cfo, coo, cpo, cco (chief creative officer), cgo (chief growth officer), cai (chief ai officer)

Heads:
  head-of-content, head-of-growth, head-of-brand, head-of-engineering, head-of-design, head-of-customer-success,
  head-of-people, head-of-finance, head-of-legal, head-of-data, head-of-sales

Specialists:
  content-writer, copywriter, designer, motion-designer, brand-strategist, performance-marketer,
  data-analyst, software-engineer, qa-engineer, devops-engineer, security-engineer, product-manager,
  ux-designer, ui-designer, sales-development-rep, account-executive, customer-success-manager

Antagonists:
  skeptic-in-residence, devils-advocate, anti-pattern-hunter, contrarian-strategist

Specialized:
  legal-counsel, compliance-officer, accountant, recruiter, brand-guardian, ethics-officer
```

---

## App-B · Canonical Capability Domains for Businesses

Inherits Squad Protocol v5 App-C. Business `capabilities:` (what the business EXPOSES to clients) MUST come from the same canonical taxonomy.

---

## App-C · JSON Schemas

Full schemas at `~/.claude/skills/businesses/schemas/`:

- `business.schema.json` — manifest validation
- `employee.schema.json` — employee.md frontmatter validation
- `org-chart.schema.json` — hierarchy validation
- `routing.schema.json` — routing.yaml validation
- `ticket.schema.json` — ticket structure
- `mention.schema.json` — mention parsing rules
- `escalation-trigger.schema.json` — trigger configuration
- `approval-chain.schema.json` — chain configuration
- `handoff-artifact.schema.json` — extends Squad v4 §9 schema

(Schemas published in companion repo; this section enumerates expected files.)

---

## App-D · Example Business (`agency-marketing-conglomerate-x`)

Reference implementation at `~/.claude/skills/businesses/templates/example-business/`:

```
agency-marketing-conglomerate-x/
├── business.yaml
├── culture.md
├── employees/
│   ├── ceo.md
│   ├── cmo-strategy.md
│   ├── cto.md
│   ├── head-of-content.md
│   ├── head-of-growth.md
│   ├── head-of-brand.md
│   └── skeptic-in-residence.md
├── org-chart.yaml
├── routing.yaml
├── processes/
│   ├── client-onboarding.yaml
│   └── monthly-business-review.yaml
├── memory/
│   ├── patterns.md
│   ├── learned-facts.md
│   └── voice.md
├── secrets-manifest.yaml
├── budgets.yaml
├── escalation-triggers.yaml
├── approval-chains.yaml
└── README.md
```

This template is the starting point for new businesses. `businesses init {name} --template marketing-agency` scaffolds it.

---

## App-E · Migration Guide from Paperclip Company

See main plan `~/.claude/plans/aceito-tudo-o-que-sleepy-frost.md` Wave 4 (Pilot 1 Business: nexus-council) for the canonical first-migration walkthrough.

Step-by-step:

1. Identify paperclip company UUID and slug.
2. Backup `.paperclip-data/` (already done globally per main plan).
3. Run `paperclip-to-business-v1 --company {uuid} --output ${BUSINESSES_DIR}/{slug} --dry-run`.
4. Review dry-run output. Decide which `legacy/` artifacts to consume vs preserve.
5. Run actual migration.
6. Run `businesses validate {slug}` and fix issues.
7. Run `businesses test isolation {slug}`.
8. Decide cutover timing per main plan Wave 8.
9. Update paperclip company to `read_only: true` after cutover.

---

## Appendix Z · Version History

| Version | Date | Status | Changes |
|---|---|---|---|
| 1.0.0-draft | 2026-05-02 | DRAFT | First draft. Includes 5 paperclip handoff primitives (mention, ticket, escalation, delegation, auto-routing) formalized as §10. Self-scoring §11. Zero-human operation §12. Memory isolation by construction §9. BP1-BP12 principles (extends Squad v4 P1-P10). Catalogs App-A (roles), App-B (domains), schemas App-C. Migration guide from paperclip App-E. |

---

*End of Business Protocol Specification v1.0.0-draft.*

*Companion specs: `SQUAD_PROTOCOL_V5.md`, `HARNESS_PROTOCOL_V1.md`. Adapters in `~/.claude/skills/businesses/adapters/`. Schemas in `~/.claude/skills/businesses/schemas/`. Example template in `~/.claude/skills/businesses/templates/example-business/`.*

*Peer review: ~/migration-tools/BUSINESS_PROTOCOL_V1_REVIEW.md*
