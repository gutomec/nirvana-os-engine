# Harness Protocol Specification

```
Title:    Harness Protocol Specification
Version:  1.0.0-draft
Status:   DRAFT (peer review pending)
Date:     2026-05-02
Author:   Luiz Gustavo Vieira Rodrigues (Prospecteezy)
License:  MIT
Scope:    Top-level orchestration of squads + businesses with token economy and zero-human safety
Related:  Squad Protocol v5 (`SQUAD_PROTOCOL_V5.md`), Business Protocol v1 (`BUSINESS_PROTOCOL_V1.md`)
```

## About This Spec

The Harness Protocol defines how a runtime (Claude Code, Codex, Gemini-CLI) orchestrates Squad Protocol v5 capabilities and Business Protocol v1 organizations as a unified consumption layer. It is the entry point that a user actually talks to.

The harness:

1. Receives natural language briefs from the user.
2. Classifies intent (work vs run-org vs both).
3. Discovers candidate squads (via Squad v5 §24) and businesses (via Business v1 §13).
4. Routes the brief with three explicit signals (HIGH / AMBIGUOUS / NO_MATCH).
5. Invokes the chosen target with token economy primitives (lazy load, prompt caching, fork over spawn, bounded handoffs).
6. Enforces budget caps and emits OpenTelemetry GenAI telemetry.
7. Maintains audit trail.
8. Manages project memory isolation and zero-human escalation.

The harness is a skill (in Claude Code), a CLI command (in Codex), or equivalent in any adapter. It does not require a server. It runs in-process within the runtime that hosts it.

This spec is the smallest of the three protocols (squad, business, harness) because it sits on top of the other two. Its job is orchestration, not capability provision.

---

## Table of Contents

1. Introduction and Scope
2. Terminology
3. Design Principles (HP1-HP8)
4. Architecture
5. Configuration
6. Five-Stage Routing Algorithm
7. Token Economy Mechanisms
8. Budget Enforcement
9. OpenTelemetry GenAI Conventions
10. Audit Trail
11. Project Memory Isolation
12. Zero-Human Escalation Bridge
13. Skill Layout (Claude Code reference)
14. CLI Commands
15. Validation
16. Versioning & Adapter Compatibility
17. Pattern Maturity
App-A: Configuration Schema
App-B: Telemetry Attribute Reference
App-C: Reference Implementation Pseudo-Code

---

## §1 Introduction and Scope

### 1.1 Purpose

The Harness Protocol defines the contract by which a runtime exposes Squad and Business Protocol consumption to the user. It standardizes:

- How natural language briefs become routed invocations.
- How the runtime decides between squad (atomic capability) and business (continuous operation).
- How token economy is realized in practice (not just promised).
- How budget caps are enforced (not just declared).
- How telemetry is emitted in OpenTelemetry GenAI conventions.
- How project memory isolation is guaranteed at the harness level.
- How zero-human escalation triggers are bridged to the runtime's notification primitives.

### 1.2 What this protocol IS

- A spec for the orchestration layer that consumes Squad v5 and Business v1.
- A 5-stage routing algorithm with explicit signals.
- A budget enforcement contract.
- An OpenTelemetry conventions binding.
- A project memory isolation guarantee mechanism.

### 1.3 What this protocol is NOT

- Not a runtime. Implemented inside Claude Code (as a skill), Codex (as a CLI command), etc.
- Not a replacement for Squad or Business protocols. It consumes them.
- Not an UI specification. UI surface is adapter-specific.
- Not a workflow engine. Workflow logic lives in squads (workflows.yaml) and businesses (processes/).

### 1.4 Audience

Adapter authors implementing the harness for a specific runtime. Operations teams configuring budgets and telemetry. Users who want to understand how their brief becomes work.

---

## §2 Terminology

| Term | Definition |
|---|---|
| **Harness** | The orchestration layer (this protocol). One harness per runtime. Implemented as skill or CLI per adapter. |
| **Brief** | Natural language input from user. Unit of orchestration. |
| **Intent** | Classified meaning of a brief: WORK (atomic capability), RUN_ORG (org-level operation), or BOTH. |
| **Routing** | Decision process that maps a brief to a target (squad+capability, business, or combination). |
| **Signal** | Routing output: MATCH_HIGH, MATCH_AMBIGUOUS, NO_MATCH. |
| **Project** | Scope of work bound to a project_id. Outputs and memory isolated per project. |
| **Budget** | Constraints on cost (USD), tokens, handoffs, duration per invocation. |
| **Lazy Load** | Token economy: load only metadata until target is selected, then load full definition. |
| **Fork** | Spawn a sub-agent that inherits parent's context (preserves prompt cache). Cheaper than spawn. |
| **Spawn** | Create a fresh sub-agent with no inherited context. |
| **Audit Trail** | Append-only log of every routing decision, invocation, cost, escalation. |

---

## §3 Design Principles

### HP1: Harness is Stateless Between Briefs

The harness holds no in-memory state between briefs (other than caches that can be evicted). All state lives in:
- Squad / business filesystem
- Project outputs and memory
- Adapter-managed audit log

This makes the harness restart-safe. A crash never loses orchestration state.

### HP2: Routing is Explicit, Not Inferred

Three signals (HIGH / AMBIGUOUS / NO_MATCH) are emitted explicitly. The harness MUST NOT silently pick a low-confidence target. Failure-loud over silent-wrong.

### HP3: Budget Caps are Hard, Not Advisory

Budget enforcement is hard-stop, not warning. When the cap is reached, the invocation halts. No "best effort to stay under." Predictable cost is more valuable than maximum effort.

### HP4: Telemetry is Not Optional

If the adapter supports OpenTelemetry GenAI conventions, the harness MUST emit. If the adapter doesn't, the harness logs to JSONL fallback (`${HARNESS_LOGS_DIR}/`). Token economy claims without instrumentation are not credible.

### HP5: Lazy Load by Default

Squads and businesses are NOT eagerly loaded. Their metadata (from registries) is loaded; the full definition only loads when selected for invocation. This is the single biggest token economy lever.

### HP6: Fork Over Spawn

When the runtime supports `forkSubagent`, the harness MUST prefer fork (inherits prompt cache) over spawn (cold start). For Claude Code this saves 30-50% of input tokens on sub-agent invocations.

### HP7: Project Isolation by Construction (inherited from BP5)

The harness sets the working project root at invocation time and refuses any filesystem operation outside that root (or the squad/business own scope). Cross-project leak is impossible by path.

### HP8: Zero-Human Bridge

The harness recognizes Business Protocol's escalation triggers and bridges them to the runtime's notification mechanism (terminal prompt, webhook, email per adapter). When `notify: human` fires, the harness pauses the project and emits a structured request that any adapter can surface.

---

## §4 Architecture

### 4.1 Component diagram

```
User brief
    ↓
┌─────────────────────────────────────┐
│  Harness skill (this protocol)      │
│                                     │
│  ┌─────────────────────────────┐   │
│  │ Stage 1: Intent Classifier  │   │
│  └─────────────────────────────┘   │
│  ┌─────────────────────────────┐   │
│  │ Stage 2: Capability Match   │←──┼── Squads registry (${SQUADS_REGISTRY_PATH})
│  │         (BM25, Tier 1)      │←──┼── Businesses registry (${BUSINESSES_REGISTRY_PATH})
│  └─────────────────────────────┘   │
│  ┌─────────────────────────────┐   │
│  │ Stage 3: Routing Decision   │   │
│  │    HIGH / AMBIG / NO_MATCH  │   │
│  └─────────────────────────────┘   │
│  ┌─────────────────────────────┐   │
│  │ Stage 4: Budget + Telemetry │   │
│  │         pre-flight          │   │
│  └─────────────────────────────┘   │
│  ┌─────────────────────────────┐   │
│  │ Stage 5: Lazy Invocation    │   │
│  │         (fork or spawn)     │   │
│  └─────────────────────────────┘   │
└─────────────────────────────────────┘
    ↓
[Squad workflow OR Business operation]
    ↓
Project outputs in ${PROJECTS_OUTPUT_DIR}/{project}/
Audit trail in ${PROJECTS_OUTPUT_DIR}/{project}/audit.jsonl
Telemetry to OTel collector (or JSONL fallback)
```

### 4.2 What the harness owns

- Routing logic
- Budget enforcement
- Telemetry emission
- Project memory isolation guards
- Zero-human escalation bridge

### 4.3 What the harness delegates

- Capability discovery → Squad Protocol v5 §24
- Business operations → Business Protocol v1
- Workflow execution → Squad / Business own primitives
- Tool execution → Runtime tools

---

## §5 Configuration

The harness reads configuration from three sources, in order of precedence (later wins):

1. `~/.claude/settings.json` (global defaults)
2. `${PROJECT_ROOT}/.claude/settings.json` (per-project overrides)
3. `${PROJECT_ROOT}/.env` (env var overrides)
4. CLI flags (highest precedence)

### 5.1 Global defaults (`~/.claude/settings.json`)

```json
{
  "harness": {
    "version": "1.0",
    "routing": {
      "match_high_threshold": 0.80,
      "match_high_lead": 0.15,
      "match_ambiguous_threshold": 0.60,
      "match_ambiguous_window": 0.15,
      "tier2_embedding": "disabled",
      "auto_invoke_validated_capabilities": true
    },
    "budget": {
      "default_max_cost_usd": 2.00,
      "default_max_tokens": 200000,
      "default_max_handoffs": 20,
      "default_max_duration_seconds": 600,
      "on_budget_exceeded": "abort"
    },
    "telemetry": {
      "provider": "otel",
      "otlp_endpoint": "http://localhost:4317",
      "fallback_jsonl_path": "${HARNESS_LOGS_DIR}/",
      "service_name": "harness"
    },
    "memory": {
      "isolation_enforcement": "strict"
    },
    "audit": {
      "enabled": true,
      "retention_days": 365
    },
    "skills": {
      "squads_dir": "${SQUADS_DIR}",
      "squads_legacy_dir": "${SQUADS_LEGACY_DIR}",
      "businesses_dir": "${BUSINESSES_DIR}"
    }
  }
}
```

### 5.2 Per-project overrides (`.claude/settings.json` in project root)

```json
{
  "harness": {
    "budget": {
      "default_max_cost_usd": 5.00     # this project allows higher per-brief budget
    },
    "routing": {
      "auto_invoke_validated_capabilities": false   # this project requires confirmation
    }
  }
}
```

### 5.3 .env overrides

```bash
PROJECTS_OUTPUT_DIR=.projects-outputs
SQUADS_OUTPUT_DIR=.squads-outputs
SQUADS_DIR=~/squads
SQUADS_LEGACY_DIR=
BUSINESSES_DIR=~/businesses
BUSINESSES_LIBRARY=~/businesses/_library
HARNESS_TELEMETRY=otel
HARNESS_DEFAULT_BUDGET_USD=2.00
HARNESS_DEFAULT_BUDGET_TOKENS=200000
```

### 5.4 CLI flag overrides

```bash
$ harness brief --max-cost-usd 10.00 --project cliente-x "..."
$ harness brief --route-to business=marketing-x "..."
$ harness brief --no-auto-invoke "..."
```

---

## §6 Five-Stage Routing Algorithm

### 6.1 The pipeline

```
brief (string) → Stage 1 → Stage 2 → Stage 3 → Stage 4 → Stage 5 → outcome
```

### 6.2 Stage 1: Intent Classification

**Input:** raw brief string + project context (if any)
**Output:** `{intent: WORK | RUN_ORG | BOTH, domains: [...], verbs: [...], confidence: float}`
**Cost:** ~500 tokens (one cheap LLM call, e.g., Claude Haiku)

**Rules:**
- WORK = brief asks for an atomic capability with finite output ("transcribe this video", "create copy for landing page", "audit this code")
- RUN_ORG = brief asks for organizational operation, ongoing work, or multi-capability orchestration ("manage marketing for client X this quarter", "rebuild the brand from scratch", "respond to this client complaint")
- BOTH = brief has both characteristics ("set up an ongoing marketing operation AND deliver the first campaign by Friday")

**Adapter implementation:** uses runtime's cheapest model (`haiku` in Claude Code, equivalent in others). Prompt template lives in `~/.claude/skills/harness/lib/intent-classifier.md`.

### 6.3 Stage 2: Capability Matching

**Input:** intent classification result
**Output:** ranked candidates from squads and businesses
**Cost:** zero LLM (BM25 over registries)

**Algorithm:**

```
candidates = []

if intent in [WORK, BOTH]:
  squads_registry = read ${SQUADS_REGISTRY_PATH}
  for each capability in squads_registry.capabilities:
    if capability.domains intersects intent.domains:
      score = bm25(intent.brief, capability.description + capability.examples)
      score *= capability.fidelity_score_boost
      score *= penalize_if_in_not_for(intent.brief, capability.not_for)
      candidates.append({type: "squad_capability", target: capability, score})

if intent in [RUN_ORG, BOTH]:
  businesses_registry = read ${BUSINESSES_REGISTRY_PATH}
  for each business in businesses_registry.businesses:
    if business.domains intersects intent.domains:
      score = bm25(intent.brief, business.description + business.capabilities_descriptions)
      score *= business_active_score_boost(business)  # online, healthy, recent activity
      candidates.append({type: "business", target: business, score})

return sort_desc_by_score(candidates)
```

**Penalty mechanism:** if brief content matches a capability's `not_for` entry, score is multiplied by 0.4 (effectively excluded unless no other candidates).

### 6.4 Stage 3: Routing Decision

**Input:** ranked candidates from Stage 2
**Output:** signal HIGH / AMBIGUOUS / NO_MATCH

**Thresholds (configurable per §5):**

```
top_score = candidates[0].score
second_score = candidates[1].score if len(candidates) > 1 else 0

if top_score >= match_high_threshold AND (top_score - second_score) >= match_high_lead:
  signal = MATCH_HIGH
elif top_score >= match_ambiguous_threshold AND (any candidate within match_ambiguous_window of top):
  signal = MATCH_AMBIGUOUS
else:
  signal = NO_MATCH
```

**Default thresholds:**
- match_high_threshold: 0.80
- match_high_lead: 0.15
- match_ambiguous_threshold: 0.60
- match_ambiguous_window: 0.15

### 6.5 Stage 4: Budget + Telemetry Pre-flight

**Input:** routing decision + selected target
**Output:** invocation context with budget caps + telemetry trace_id

**Steps:**

1. Compute estimated cost (based on selected target's average from telemetry history; default $0.30 if no history).
2. Compare against `max_cost_usd` from config.
3. If estimated > cap: WARN user (or abort if --strict).
4. Create OTel trace + root span `harness.brief`.
5. Emit attributes: brief_length, intent, signal, target_type, target_id, estimated_cost_usd.
6. Allocate budget tracker for this invocation.

### 6.6 Stage 5: Lazy Invocation

**Input:** target + budget context + project
**Output:** target executes, harness monitors

**Lazy load:**
- DO NOT load full squad.yaml or business.yaml at routing time. Use registry metadata only.
- Once Stage 3 selects target, load the specific manifest.
- Load only the agent/employee referenced by `invoke.agent` or by routing rules.
- Sub-agents are loaded lazily as they are spawned.

**Fork over spawn:**
- If the runtime supports `forkSubagent` AND the parent has shared context that the child needs:
  - Use fork (inherits parent's prompt cache, ~30-50% input token savings)
- Otherwise:
  - Use spawn (cold start)

**Handoff artifact convention:**
- Inter-agent handoffs use the §9 Handoff Artifact (Squad v4 §9 + Business v1 extensions).
- Free-form pass-through is discouraged — it degrades downstream context.
- Size budget: ≤ 800 tokens per artifact (convention; not blocked inline, audited post-hoc by `validate-chain --verify-disk`).

**Budget monitoring:**
- After each turn, check cumulative cost against cap.
- If exceeded:
  - `on_budget_exceeded: abort`: terminate immediately, emit error
  - `on_budget_exceeded: warn`: continue but emit warning span
  - `on_budget_exceeded: escalate`: pause, emit human-notification (via Business Protocol §12 if business invocation)

---

## §7 Token Economy Mechanisms

### 7.1 The five levers (with measured impact)

| Lever | Mechanism | Expected savings |
|---|---|---|
| **Lazy load of squads** | Read registry metadata only at discovery; load full manifest only when selected | 60-80% at discovery time |
| **Capability-targeted load** | Load only the specific agent that delivers the matched capability, not the whole squad | 70% per execution |
| **Prompt caching** | Business culture.md + employee body are cacheable; pay once per 5-min window | 30-50% on repeat invocations |
| **Fork over spawn** | Sub-agents inherit parent context via `forkSubagent` | 20-40% per sub-agent |
| **Bounded handoffs** | Handoff artifacts target ≤ 800 tokens (convention); full history not passed | 50-70% on multi-step chains |

Total compounded saving target: **30-50% vs paperclip baseline** for equivalent briefs.

### 7.2 Prompt caching contract

The harness arranges prompts so that stable content is at the start (cacheable) and variable content at the end:

```
[cached portion]
- Squad/Business manifest summary
- Agent/Employee system prompt body
- Culture.md (for businesses)
- DNA reference (for mind_clone employees)

[variable portion]
- Current brief
- Project memory excerpt
- Handoff artifact (incoming)
- Tool results (this turn)
```

Adapters that support prompt caching (Claude Code's API caching, etc.) automatically benefit. Adapters without caching support don't degrade; they just don't get the speedup.

### 7.3 Fork vs spawn decision

```
function decide_fork_or_spawn(parent_context, sub_agent_definition):
  if not runtime.supports_fork():
    return SPAWN

  if sub_agent_definition.requires_clean_context:
    return SPAWN  # security or correctness reason

  if estimated_inherited_context_size(parent_context) > runtime.fork_overhead_threshold:
    return SPAWN  # fork would be more expensive

  return FORK
```

### 7.4 Handoff artifact contract

The protocol defines the handoff contract that the dispatching agent honors:

- Schema matches Handoff Artifact (Squad v4 §9 + Business v1 extensions)
- Size budget ≤ 800 tokens (convention)
- Self-score present (if Business Protocol §11 in effect)
- mention/ticket_id present (if Business Protocol §10 in effect)

These are conventions, not an inline gate. Deviations are caught post-hoc: `validate-chain --verify-disk` flags a `gate_passed` with no real on-disk artifact, and the audit-fabrication heuristic flags suspicious traces.

---

## §8 Budget Enforcement

### 8.1 Budget primitives

Per invocation:

```yaml
budget:
  max_cost_usd: 2.00
  max_tokens: 200000
  max_handoffs: 20
  max_duration_seconds: 600
```

Per business (in business.yaml):

```yaml
budgets:
  monthly_max_usd: 1000
  per_brief_max_usd: 5.00
```

Per employee (in employee frontmatter):

```yaml
budget_monthly_usd: 200
heartbeat:
  max_cost_per_cycle_usd: 0.50
```

### 8.2 Enforcement contract

The harness MUST track:

- Cumulative cost per invocation
- Cumulative cost per business per month (rolling)
- Cumulative cost per employee per month
- Cumulative tokens per invocation
- Number of handoffs per invocation
- Wall-clock duration

When any cap is reached, the configured action fires:

- `abort` (default): terminate immediately, emit error to user
- `warn`: continue but emit warning telemetry span + add to audit log
- `escalate`: pause, emit Business Protocol escalation trigger (if applicable)

### 8.3 Cost calculation

```
cost_usd_per_call = (input_tokens * input_price) + (output_tokens * output_price) - (cached_tokens * cache_discount)
```

Pricing tables live in adapter manifests under `numeric_values.model_pricing`. The harness MUST NOT hardcode prices.

### 8.4 Telemetry of budget

Every budget-related event is emitted as OTel span attributes:

```
attribute: harness.budget.cap_usd
attribute: harness.budget.cumulative_usd
attribute: harness.budget.remaining_usd
attribute: harness.budget.cap_tokens
attribute: harness.budget.cumulative_tokens
attribute: harness.budget.action_taken (when triggered)
```

---

## §9 OpenTelemetry GenAI Conventions

### 9.1 Span hierarchy

```
harness.brief                        (root span per brief)
  ├─ harness.intent_classification   (Stage 1)
  ├─ harness.capability_match        (Stage 2)
  ├─ harness.routing_decision        (Stage 3)
  ├─ harness.preflight               (Stage 4)
  └─ harness.invoke                  (Stage 5)
        ├─ squad.invoke              (if squad target)
        │     └─ ... (squad spans per Squad v5 §26.3)
        └─ business.invoke           (if business target)
              ├─ business.brief_intake
              ├─ employee.execute    (per employee turn)
              │     ├─ agent.execute (LLM call)
              │     ├─ tool.invoke (per tool)
              │     └─ handoff.emit (per handoff)
              ├─ business.approval_chain (if applicable)
              └─ business.escalation (if triggered)
```

### 9.2 Required attributes per span

Inherits Squad v5 §26.3 conventions, adds:

| Span | Required attributes |
|---|---|
| `harness.brief` | brief_length, project_id, signal, target_type, target_id, estimated_cost_usd, actual_cost_usd, duration_ms |
| `harness.intent_classification` | brief_length, intent, domains, verbs, confidence, model, tokens_input, tokens_output, cost_usd |
| `harness.capability_match` | candidates_count, top_score, second_score, signal, duration_ms |
| `harness.routing_decision` | signal, target_type, target_id, score, override |
| `harness.preflight` | budget_cap_usd, estimated_cost_usd, telemetry_trace_id |
| `harness.invoke` | target_type, target_id, lazy_loaded, fork_used, total_handoffs, total_cost_usd |
| `business.escalation` | trigger_id, severity, action, project_id |

### 9.3 Metrics

```
counter   harness.briefs_total{signal, target_type}
counter   harness.routing_decisions_total{signal}
counter   harness.invocations_total{target_type, target_id}
counter   harness.escalations_total{severity, trigger_id}
counter   harness.budget_violations_total{action}
histogram harness.brief_duration_ms{target_type}
histogram harness.cost_usd{target_type}
histogram harness.tokens{target_type, kind=input|output|cached}
gauge     harness.cache_hit_ratio{cache=registry|prompt}
gauge     harness.fork_vs_spawn_ratio
```

### 9.4 Fallback when adapter has no OTel

The harness MUST emit equivalent JSONL to `${HARNESS_LOGS_DIR}/{date}/{trace_id}.jsonl`:

```jsonl
{"ts": "...", "event": "span_start", "span": "harness.brief", "trace_id": "...", "parent_span": null, "attributes": {...}}
{"ts": "...", "event": "span_attribute", "span_id": "...", "key": "...", "value": "..."}
{"ts": "...", "event": "span_end", "span_id": "...", "duration_ms": ...}
```

This guarantees telemetry is always present, even if OTel infrastructure is missing.

---

## §10 Audit Trail

### 10.1 What gets logged

Every:
- Brief received (with full text)
- Routing decision (signal + reasoning)
- Invocation (target + result)
- Cost emission (per turn, per agent)
- Handoff (mention/ticket/escalation/delegation/auto-route)
- Approval chain checkpoint (Business Protocol §14.3)
- Escalation trigger (Business Protocol §12.2)
- Budget violation
- Memory write (permanent only; project writes inferred from filesystem)

### 10.2 Where it lives

Per project:
```
${PROJECT_OUTPUT_DIR}/{project_id}/audit.jsonl
```

Per session (across projects, for harness operations):
```
${HARNESS_LOGS_DIR}/audit-{date}.jsonl
```

### 10.3 Format

JSONL, append-only:

```jsonl
{"ts": "...", "event": "brief_received", "project_id": "...", "brief_hash": "...", "brief_length": ...}
{"ts": "...", "event": "routing_decision", "signal": "MATCH_HIGH", "target_type": "business", "target_id": "...", "score": 0.92}
{"ts": "...", "event": "invocation_start", "target": "...", "trace_id": "..."}
{"ts": "...", "event": "cost_emission", "agent": "...", "model": "...", "tokens_input": ..., "tokens_output": ..., "cost_usd": ...}
{"ts": "...", "event": "handoff", "from": "...", "to": "...", "type": "mention", "self_score": {...}}
{"ts": "...", "event": "escalation_trigger", "trigger_id": "...", "severity": "high"}
{"ts": "...", "event": "invocation_end", "result": "completed", "total_cost_usd": ...}
```

### 10.4 Retention

Default: 365 days for project audit, 90 days for harness audit. Configurable via `~/.claude/settings.json`:

```json
{
  "harness": {
    "audit": {
      "project_retention_days": 365,
      "session_retention_days": 90,
      "on_expiry": "archive"
    }
  }
}
```

---

## §11 Project Memory Isolation (HP7 enforcement)

### 11.1 The guarantee

The harness MUST ensure that during invocation scoped to project P, no filesystem operation reads from or writes to any path that crosses out of:
- `${PROJECTS_OUTPUT_DIR}/${P}/**`
- `${SQUADS_DIR}/**` (read only, by selected squad)
- `${BUSINESSES_DIR}/**` (read only, by selected business; OR write only to its own permanent memory in maintenance mode)

### 11.2 The mechanism

The harness wraps the runtime's filesystem tools (Read, Write, Edit, Bash) with a guard:

```
guarded_read(path):
  resolved = realpath(path)
  if not (
    resolved.startswith(${PROJECTS_OUTPUT_DIR}/${current_project}/)
    OR resolved.startswith(${SQUADS_DIR}/${current_squad}/)   # if invoking squad
    OR resolved.startswith(${BUSINESSES_DIR}/${current_business}/)  # if invoking business
    OR resolved.startswith(${BUSINESSES_LIBRARY}/)           # DNA refs allowed
  ):
    raise IsolationViolation(path, current_project)
  return original_read(path)
```

### 11.3 Test

`harness test isolation {target}` runs Business v1 §9.4 isolation test. Mandatory before any business is added to production.

---

## §12 Zero-Human Escalation Bridge (HP8)

### 12.1 The bridge contract

When a Business Protocol §12.2 escalation trigger fires with `notify: human`:

1. The harness pauses the project (no further invocations until resumed).
2. Constructs a structured notification payload.
3. Delivers the notification per the runtime adapter's mechanism:
   - **Claude Code**: emits a special message in the next session (uses Plan mode or AskUserQuestion-equivalent).
   - **Codex**: writes to a configured webhook endpoint.
   - **Gemini-CLI**: pushes to email or Slack via configured connector.
4. Records the trigger in audit.jsonl.
5. Awaits human response (or `timeout_minutes` per trigger config).
6. On response: `harness resume {project} {trigger_id}` continues.
7. On timeout: enforces the trigger's `action` (pause / warn / continue).

### 12.2 Notification payload schema

```json
{
  "schema_version": "1.0.0",
  "type": "human_escalation_required",
  "trigger_id": "budget_monthly_exceeds",
  "severity": "high",
  "project_id": "cliente-x",
  "business_slug": "marketing-conglomerate-x",
  "context": {
    "summary": "Monthly cost for business marketing-conglomerate-x reached $1,050 of $1,000 cap.",
    "current_invocation": "...",
    "audit_log_excerpt": "..."
  },
  "options": [
    {"id": "increase_cap", "description": "Raise monthly cap to $1,500 for this month"},
    {"id": "pause_until_next_month", "description": "Pause business operations until next billing cycle"},
    {"id": "abort_current", "description": "Abort current invocation, keep cap"}
  ],
  "timeout_minutes": 60,
  "default_on_timeout": "abort_current"
}
```

### 12.3 Resume command

```
$ harness resume cliente-x budget_monthly_exceeds --decision increase_cap
```

The harness updates the relevant config (in this example, raises the cap), records the human decision in audit.jsonl, and resumes the paused invocation.

---

## §13 Skill Layout (Claude Code reference)

```
~/.claude/skills/harness/
├── SKILL.md                          # entry point (frontmatter + body)
├── HARNESS_PROTOCOL_V1.md            # this spec
├── lib/
│   ├── intent-classifier.md          # prompt template for Stage 1
│   ├── intent-classifier.js          # caller
│   ├── capability-matcher.js         # BM25 over registries
│   ├── router.js                     # 5-stage pipeline
│   ├── budget-tracker.js             # cumulative cost/tokens/handoffs
│   ├── telemetry.js                  # OTel SDK adapter + JSONL fallback
│   ├── audit-logger.js               # JSONL append-only logger
│   ├── isolation-guard.js            # filesystem guard
│   ├── escalation-bridge.js          # zero-human notification
│   └── fork-vs-spawn.js              # decision logic
├── schemas/
│   ├── config.schema.json            # ~/.claude/settings.json harness section
│   ├── notification.schema.json      # zero-human notification payload
│   └── audit-event.schema.json       # JSONL audit event schema
├── adapters/
│   ├── claude-code.md
│   ├── claude-code.yaml
│   ├── codex.md
│   ├── codex.yaml
│   ├── gemini-cli.md
│   └── gemini-cli.yaml
└── templates/
    └── intent-classifier-default.md
```

### 13.1 SKILL.md (Claude Code)

```markdown
---
name: harness
description: "Top-level orchestrator for squads and businesses. Use when receiving a brief that needs routing to the right capability or organization. Triggers on: brief, project, route to, send to business, invoke squad, organization, business, marketing campaign, [domain] work. Bridges zero-human escalation to user input."
tools: [Read, Write, Edit, Bash, Glob, Grep, AgentTool, TaskCreate, AskUserQuestion]
maxTurns: 100
---

# Harness Protocol Engine v1.0

You orchestrate Squad Protocol v5 capabilities and Business Protocol v1 organizations following the Harness Protocol v1.0.

## Core flow

1. Receive brief from user.
2. Classify intent (Stage 1).
3. Match against squads + businesses registries (Stage 2).
4. Decide routing (Stage 3): MATCH_HIGH, MATCH_AMBIGUOUS, NO_MATCH.
5. Enforce budget pre-flight (Stage 4).
6. Invoke target lazily, monitor (Stage 5).

## Three signals

- MATCH_HIGH (≥ 0.80, lead ≥ 0.15): auto-invoke if validated capability AND budget OK.
- MATCH_AMBIGUOUS (≥ 0.60, candidates within 0.15 of top): present via AskUserQuestion.
- NO_MATCH (best < 0.60): refuse. Suggest creating capability or routing manually.

## Token economy

Use the five levers: lazy load, capability-targeted load, prompt caching, fork over spawn, bounded handoffs.

## Memory isolation

NEVER access paths outside `${PROJECTS_OUTPUT_DIR}/${current_project}/` or the selected squad/business own scope. Guard built into every filesystem call.

## Zero-human escalation

When Business Protocol escalation fires `notify: human`, pause and use AskUserQuestion to surface the decision. Resume on response.

[Full algorithm in HARNESS_PROTOCOL_V1.md §6.]
```

---

## §14 CLI Commands

### 14.1 Primary

```
harness brief [options] "<brief text>"

Options:
  --project <id>            Project id. Required for businesses; auto-generated for squads.
  --route-to <target>       Force routing target. Format: "squad=<name>" or "business=<name>".
  --max-cost-usd <n>        Override budget cap.
  --max-tokens <n>          Override token cap.
  --no-auto-invoke          Always confirm before invoking, even on MATCH_HIGH.
  --dry-run                 Show routing decision without invoking.
  --json                    Machine-readable output.
```

### 14.2 Discovery

```
harness find "<intent>"          # show what would route here, without invoking
harness list squads               # list known squads
harness list businesses           # list known businesses
harness list capabilities         # list known capabilities (across squads + businesses)
harness inspect <target>          # show full manifest of target
```

### 14.3 Indexing

```
harness index                     # rebuild squads + businesses registries
harness index --squads            # squads only
harness index --businesses        # businesses only
harness index --incremental       # only changed manifests
```

### 14.4 Project lifecycle

```
harness project create <id> [--description "..."]
harness project list
harness project status <id>
harness project archive <id>
```

### 14.5 Escalation handling

```
harness pending                          # list pending human-required notifications
harness resume <project> <trigger_id> --decision <option_id>
harness reject <project> <trigger_id> --reason "..."
```

### 14.6 Audit and telemetry

```
harness audit <project>                  # show audit trail for project
harness audit --since <date>             # global audit since date
harness telemetry status                 # show OTel exporter status
harness telemetry test                   # send test span
```

### 14.7 Cost reporting

```
harness cost                             # cost summary for current month
harness cost --project <id>              # per-project cost
harness cost --business <slug>           # per-business cost
harness cost --employee <name>           # per-employee cost
```

---

## §15 Validation

### 15.1 Configuration validation

```
harness validate config                  # validate settings.json + .env consistency
```

Checks:
- `~/.claude/settings.json` matches schema (App-A)
- `.env` variables resolve
- Squads registry exists
- Businesses registry exists
- OTel endpoint reachable (warning, not error)

### 15.2 Routing test

```
harness test routing "<intent>" --expected <signal>:<target>
```

Verifies that a known intent resolves to a known target. Used in regression tests.

### 15.3 Isolation test

```
harness test isolation <business>
```

Runs Business v1 §9.4 isolation test for a specific business.

### 15.4 Equivalence test (Squad v5)

```
harness test equivalence <squad-name>
```

Compares squad v4 vs v5 output for canonical fixtures. See plan §7.1.

---

## §16 Versioning & Adapter Compatibility

### 16.1 Harness protocol version

1.0.0. SemVer at protocol level.

### 16.2 Adapter compatibility

Each adapter declares which harness protocol version it supports:

```yaml
# adapters/claude-code.yaml
adapter:
  runtime_id: claude-code
  protocol_version: "1.0"
  features_supported:
    - stage1_intent_classification
    - stage2_bm25_matching
    - stage3_three_signals
    - stage4_budget_enforcement
    - stage5_lazy_invocation
    - prompt_caching
    - fork_subagent
    - otel_telemetry
    - jsonl_telemetry_fallback
    - audit_trail
    - isolation_guard
    - zero_human_bridge
```

Adapters that lack any required feature MUST refuse to load the harness with a clear error.

---

## §16.5 Writing contract (HP9)

Toda prose final produzida pelo harness segue o **writing contract** anexado a `AGENTS.md` / `CLAUDE.md` / `GEMINI.md`. Como esses arquivos são carregados automaticamente pelo runtime (Claude Code, Antigravity CLI, Gemini CLI, Codex), o contract está sempre presente no contexto do agente — prevenção, não correção pós-hoc.

**Não há loop de revisão automática.** O `wiki-lint` rubric da quality gate roda como check regex pass/fail; se reprovar, o build falha e o usuário decide se re-roda ou aceita. Nenhum token é gasto silenciosamente reescrevendo prose.

**Conteúdo fora do escopo do contract:**

- JSON estruturado entre adapters (telemetria interna).
- Logs de audit (`audit.jsonl`).
- `HarnessNotification` para escalation (texto curto, machine-parseable).
- Outputs binários (imagens, áudio, vídeo).

**Rationale (HP9):** o contract vive no único lugar que TODO runtime já carrega sem fiação extra. Custo efetivo por dispatch tende a zero com prompt caching no prefixo estável do system prompt.

---

## §17 Pattern Maturity

### Functional

- 5-stage routing pipeline
- 3-signal explicit output
- Lazy load
- Fork over spawn (where supported)
- Budget pre-flight
- OTel telemetry
- Audit trail
- Project isolation guard

### Problematic

- Tier 2 embedding discovery: paid, slower. Use only when Tier 1 fails frequently.
- Cross-protocol routing (squad vs business decision): can be wrong. Mitigated by structural rule (squad = atomic finite output, business = continuous operation).

### Aspirational

- Multi-target invocation (one brief → multiple businesses in parallel)
- Self-improving routing (router learns from past success/failure)
- Live human takeover mid-invocation

---

## App-A · Configuration Schema

Full schema at `~/.claude/skills/harness/schemas/config.schema.json`. Inline summary:

```json
{
  "$id": "https://harness.protocol/v1/config.schema.json",
  "type": "object",
  "properties": {
    "harness": {
      "type": "object",
      "properties": {
        "version": {"const": "1.0"},
        "routing": {...},
        "budget": {...},
        "telemetry": {...},
        "memory": {...},
        "audit": {...},
        "skills": {...}
      },
      "required": ["version"]
    }
  }
}
```

---

## App-B · Telemetry Attribute Reference

See §9.2. Full list of canonical attributes in OTel GenAI conventions style.

---

## App-C · Reference Implementation Pseudo-Code

```typescript
// Simplified pseudo-code for the routing pipeline

async function processBrief(brief: string, projectId: string, options: BriefOptions): Promise<Result> {
  const traceId = telemetry.startTrace('harness.brief', { brief_length: brief.length, project_id: projectId });

  // Stage 1: Intent classification
  const intent = await intentClassifier.classify(brief, { traceId });
  telemetry.addAttribute(traceId, 'intent', intent.type);

  // Stage 2: Capability matching
  const candidates = capabilityMatcher.match(intent, {
    squadsRegistry: registries.squads,
    businessesRegistry: registries.businesses,
  });
  telemetry.addAttribute(traceId, 'candidates_count', candidates.length);

  // Stage 3: Routing decision
  const decision = router.decide(candidates, options);
  telemetry.addAttribute(traceId, 'signal', decision.signal);
  telemetry.addAttribute(traceId, 'target_type', decision.target?.type);
  telemetry.addAttribute(traceId, 'target_id', decision.target?.id);

  if (decision.signal === 'NO_MATCH') {
    return { success: false, suggestion: decision.suggestion };
  }

  if (decision.signal === 'MATCH_AMBIGUOUS') {
    const userChoice = await runtime.askUserQuestion({
      question: `Multiple candidates for "${brief}":`,
      options: decision.candidates.map(c => ({ label: c.target.id, description: c.why })),
    });
    decision.target = decision.candidates.find(c => c.target.id === userChoice);
  }

  // Stage 4: Budget pre-flight
  const budget = budgetTracker.allocate({
    cap_usd: options.maxCostUsd ?? config.budget.default_max_cost_usd,
    cap_tokens: options.maxTokens ?? config.budget.default_max_tokens,
    cap_handoffs: config.budget.default_max_handoffs,
    cap_duration_seconds: config.budget.default_max_duration_seconds,
  });
  telemetry.addAttribute(traceId, 'budget_cap_usd', budget.cap_usd);

  // Stage 5: Lazy invocation
  const projectRoot = `${process.env.PROJECTS_OUTPUT_DIR}/${projectId}`;
  await fs.ensureDir(projectRoot);
  isolationGuard.lockProject(projectId);

  let result;
  try {
    if (decision.target.type === 'squad_capability') {
      result = await invokeSquad(decision.target, brief, projectId, budget, traceId);
    } else if (decision.target.type === 'business') {
      result = await invokeBusiness(decision.target, brief, projectId, budget, traceId);
    }
  } catch (err) {
    if (err instanceof BudgetExceeded) {
      auditLogger.append(projectId, { event: 'budget_exceeded', ...err.context });
      if (config.budget.on_exceeded === 'abort') throw err;
      // else warn / escalate per config
    }
    throw err;
  } finally {
    isolationGuard.unlockProject(projectId);
    telemetry.endTrace(traceId, { actual_cost_usd: budget.spent_usd });
  }

  return result;
}
```

---

## Appendix Z · Version History

| Version | Date | Status | Changes |
|---|---|---|---|
| 1.0.0-draft | 2026-05-02 | DRAFT | First draft. 5-stage routing, 3 signals, budget enforcement, OTel telemetry, audit trail, project isolation guard, zero-human escalation bridge. HP1-HP8 principles. Schemas App-A. CLI commands §14. Reference pseudo-code App-C. |

---

*End of Harness Protocol Specification v1.0.0-draft.*

*Companion specs: `SQUAD_PROTOCOL_V5.md`, `BUSINESS_PROTOCOL_V1.md`. Adapters in `~/.claude/skills/harness/adapters/`. Reference implementation in `~/.claude/skills/harness/lib/`.*

*Peer review: ~/migration-tools/HARNESS_PROTOCOL_V1_REVIEW.md*
