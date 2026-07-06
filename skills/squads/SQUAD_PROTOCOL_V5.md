# Squad Protocol Specification

```
Title:    Squad Protocol Specification
Version:  5.0.0-draft
Status:   DRAFT (peer review pending)
Date:     2026-05-02
Author:   Luiz Gustavo Vieira Rodrigues (Prospecteezy)
license: SUL-1.0
Scope:    Runtime-agnostic core + capability discovery layer
Predecessor: v4.0.0 (`SQUAD_PROTOCOL_V4.md`)
```

## About This Version

v5.0 is a **strict additive layer over v4.0** focused on solving the protocol's biggest practical failure mode: **capability discovery**.

Squads written against v4.0 are valid in v5.0 without modification (they are treated as having no declared capabilities and degrade gracefully to name-based discovery). New squads written against v5.0 declare atomic capabilities, register them in a global index, and enable a runtime to route an intent to the correct squad on the first try instead of through trial-and-error.

This spec adds:
- §22 Capability Manifest (declarative, in `squad.yaml`)
- §23 Global Registry and Indexing (filesystem + JSON)
- §24 Discovery Protocol (BM25 baseline, optional embedding)
- §25 Three-Signal Routing (HIGH / AMBIGUOUS / NO_MATCH)
- §26 Telemetry Conventions (OpenTelemetry GenAI)
- §27 Output Humanization (P11, novo princípio)
- §10bis tightening, §11bis (business_scope), §15bis (capability validation)
- App-C Canonical Capability Catalog (controlled taxonomy)
- App-D Capability Schema (JSON Schema reference)
- App-E Migration guide v4 → v5
- App-F Anti-patterns
- App-Z Version history

This spec also tightens:
- §10 Tool Whitelist enforcement requirements (when adapter supports it)
- §11 Memory Scopes adds `business_scope` for inter-protocol bridges
- §15 Validation adds Stage 1.5 (capability schema validation) between Core and Adapter

This spec does **not** change:
- §1 through §9 of v4 (terminology, principles, structure, agents, tasks, workflows, communication)
- §12 through §14 (context engineering, preservation, bounded iteration)
- §16 through §21 (security, versioning, runtime compatibility, pattern maturity, proposed, legacy)

For sections that are unchanged from v4.0, see `SQUAD_PROTOCOL_V4.md`. This document only documents the delta. A full consolidated v5 spec will be published as `SQUAD_PROTOCOL_V5_COMPLETE.md` once peer review closes.

**Two-layer rule reaffirmed:** runtime-specific values continue to live in `adapters/{runtime_id}.{md,yaml}`. The capability layer is runtime-neutral.

---

## What v4 squads must do to upgrade to v5

Nothing required. Squads written against v4.0 are accepted as v5.0 with `capabilities: []` implicit and discovery falls back to v4 name-based.

To gain v5 discovery benefits:
1. Add `protocol: "5.0"` to `squad.yaml`.
2. Add `capabilities:` block declaring atomic units (see §22).
3. Run `squads index` once to register in `${SQUADS_REGISTRY_PATH}`.

---

## §22 Capability Manifest

### 22.1 Why this exists

The v4 unit of discovery is the **squad** itself. A planner LLM (or harness) reads `squad.description` and decides "is this squad relevant to my intent?" In practice this fails when:

- A squad's value is in one task or one tool nested inside, while the squad's description is generic ("ULTIMATE marketing intelligence v5.4").
- The squad serves multiple unrelated capabilities and no single description covers them all.
- The discoverer is searching for a verb-object pair ("transcribe video") and the squad name is a noun ("instagram-intelligence-nirvana").

**Capability manifest fixes this** by declaring a list of atomic, named, hierarchically-namespaced capabilities. The unit of discovery becomes the capability, not the squad. The squad becomes the implementation container.

### 22.2 Where it lives

In `squad.yaml`, top-level field `capabilities:`. Optional but strongly recommended for v5 squads.

```yaml
# squad.yaml (excerpt)
name: instagram-intelligence-nirvana
version: "5.4.0"
protocol: "5.0"

# ... existing v4 fields (description, components, runtime_requirements, etc.) ...

capabilities:
  - id: "media.video.analyze"
    description: "Analyze video file (mp4/mov/webm) with multimodal LLM. Extracts transcript, on-screen text, key frames, hook analysis. Produces structured JSON."
    domains: [media, content, social_media]
    inputs:
      - {name: video_file, type: file, formats: [mp4, mov, webm]}
    outputs:
      - {name: analysis, type: json, schema: schemas/video-analysis.json}
    tools_required: [gemini_api]
    invoke:
      type: task
      ref: ii-media-analyst-analyze-video
      agent: ii-media-analyst
    examples:
      - "transcrever vídeo do Instagram"
      - "analisar criativos de campanha em vídeo"
      - "extrair textos da tela de um Reel"
    not_for:
      - "análise de vídeo de aula educacional com slides (use media.video.educational)"
      - "transcrição puramente de áudio sem visual (use media.audio.transcribe)"
    fidelity:
      ground_truth_dir: capabilities/media.video.analyze/ground-truth/
      eval_results: capabilities/media.video.analyze/eval-results.json
      status: validated  # validated | experimental | drifted
```

### 22.3 Required fields per capability

| Field | Type | Required | Purpose |
|---|---|---|---|
| `id` | string, dotted hierarchical | YES | Unique identifier across all squads. Format: `domain.subdomain.verb` (e.g. `media.video.analyze`). Must come from the canonical catalog (App-C) or be marked as `experimental`. |
| `description` | string, 1 paragraph | YES | What this capability does in concrete terms. The discovery layer indexes this. Avoid abstractions. |
| `domains` | array of strings | YES | At least one domain from canonical catalog (App-C). Used as filter primitive in discovery. |
| `invoke` | object | YES | How the harness should invoke this capability. See §22.5. |

### 22.4 Recommended fields per capability

| Field | Type | Recommended | Purpose |
|---|---|---|---|
| `inputs` | array of `{name, type, formats?, schema?}` | YES | Declarative input contract. Used for validation before invoke. |
| `outputs` | array of `{name, type, format?, schema?}` | YES | Declarative output contract. Enables downstream binding. |
| `tools_required` | array of strings | YES | What runtime tools the capability needs. Adapter validates availability. |
| `examples` | array of natural-language strings | YES | Free-form intents that should resolve to this capability. Used by discovery as positive training signal. |
| `not_for` | array of natural-language strings | YES | Anti-patterns. Each must mention the alternative capability when known. |
| `fidelity` | object | RECOMMENDED for capabilities used in production | See §22.6. |

### 22.5 Invoke contract

The `invoke` field tells the harness what to do when this capability is selected. Three valid types:

```yaml
# Type 1: invoke a workflow (most common for multi-step capabilities)
invoke:
  type: workflow
  ref: workflows/full-funnel-creation.yaml
  inputs_mapping:
    brief: "$input.brief"  # mapping from capability inputs to workflow inputs

# Type 2: invoke a single task with a specific agent
invoke:
  type: task
  ref: tasks/sfm-hormozi-craft-offer.md
  agent: agents/sfm-hormozi.md

# Type 3: invoke an agent directly (no pre-defined task)
invoke:
  type: agent
  ref: agents/sfm-orchestrator.md
  prompt_template: "Address the following intent: ${input.intent}"
```

The harness materializes the invocation according to the runtime adapter. A runtime that lacks `subagent_spawning` may degrade `type: agent` to a sequential prompt; a runtime with `teammate_primitive` may treat it as a teammate spawn. See adapter mappings.

### 22.6 Fidelity (optional but strongly recommended)

For capabilities whose output quality is critical (revenue-generating, customer-facing, regulatory), declare a fidelity contract:

```yaml
fidelity:
  ground_truth_dir: capabilities/{cap_id}/ground-truth/
  eval_results: capabilities/{cap_id}/eval-results.json
  status: validated   # validated | experimental | drifted
  last_eval: "2026-05-01T12:00:00Z"
  judge_model: "claude-opus-4-7"
  threshold: 0.85
```

The harness MAY refuse to invoke capabilities with `status: drifted` unless explicitly overridden by the user. Capabilities with `status: experimental` are invoked with a disclaimer in the response.

The fidelity directory layout:

```
capabilities/{cap_id}/
├── ground-truth/
│   ├── case-001.input.json
│   ├── case-001.expected.json
│   ├── case-002.input.json
│   ├── case-002.expected.json
│   └── ... (10-20 cases recommended)
├── eval-config.yaml
├── synthetic-baseline.json   # outputs of the capability for the same inputs (regenerable)
└── eval-results.json         # latest LLM-judge scores
```

`eval-results.json` shape:

```json
{
  "schema_version": "1.0.0",
  "evaluated_at": "2026-05-01T12:00:00Z",
  "judge_model": "claude-opus-4-7",
  "overall_score": 0.87,
  "threshold": 0.85,
  "status": "validated",
  "per_case": [
    {"case_id": "case-001", "score": 0.92, "notes": "..."},
    {"case_id": "case-002", "score": 0.81, "notes": "..."}
  ]
}
```

### 22.7 Capability vs task vs workflow

Common confusion to avoid:

| Concept | What it is | Granularity |
|---|---|---|
| Capability | What the squad **promises** to deliver, by name. Discoverable. | Atomic from outside view |
| Workflow | How the capability is **realized**, internally. Multi-step DAG. | Composable from inside |
| Task | A single **unit of work** inside a workflow. | Smallest internal unit |

A capability MAY map 1:1 to a task (simple cases). A capability MAY map to a workflow (complex cases). The capability id is the contract; the implementation is hidden.

### 22.8 Capability lifecycle

```
PROPOSED → EXPERIMENTAL → VALIDATED → (DRIFTED | RETIRED)
```

- **PROPOSED**: declared in `squad.yaml` but not yet in the canonical catalog (App-C). Not searchable in registry until catalog accepts.
- **EXPERIMENTAL**: in catalog, no fidelity ground-truth yet. Discoverable but flagged in responses.
- **VALIDATED**: fidelity ground-truth exists, eval score >= threshold. Default invoke.
- **DRIFTED**: last eval score < threshold. Harness refuses by default.
- **RETIRED**: superseded. `replaces:` field points to successor.

### 22.9 Validation rules (Core)

A v5 squad with `capabilities:` MUST satisfy:

1. Every `id` matches `^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){2,}$` (dotted hierarchical, **3+ segments** `namespace.segment.verb`, all lowercase, underscores allowed within segment).
2. Every `id` is unique within the squad.
3. Every `domains` entry is in the canonical catalog (App-C) OR the squad declares `experimental_domains: true`.
4. Every `invoke.ref` resolves to an existing file in the squad.
5. Every `examples` entry is non-empty natural language.
6. Every `not_for` entry mentions an alternative capability id when known (validator emits warning if not).
7. If `fidelity` is declared, `ground_truth_dir` exists with at least 1 case file.

Validators are runtime-neutral and live in `~/.claude/skills/squads/lib/validators/`.

---

## §23 Global Registry and Indexing

### 23.1 Why this exists

In v4, discovery is `find ~/squads ./squads -name squad.yaml` followed by parsing each manifest. For 133 squads this is inefficient and provides no semantic indexing. v5 introduces a pre-computed global registry that the harness reads in O(1).

### 23.2 Where it lives

```
${SQUADS_REGISTRY_PATH}        # canonical, regenerable
${SQUADS_REGISTRY_PATH}.lock   # hash + timestamp for invalidation detection
```

The registry is **cache, not source-of-truth**. Source of truth remains the `squad.yaml` files on disk. The registry is regenerated by `squads index`.

### 23.3 Registry shape

```json
{
  "schema_version": "1.0.0",
  "generated_at": "2026-05-02T15:00:00Z",
  "host_protocol_version": "5.0",
  "squads_root_dirs": ["${SQUADS_DIR}", "/Volumes/guto1/squads"],
  "squads": {
    "instagram-intelligence-nirvana": {
      "version": "5.4.0",
      "protocol": "5.0",
      "manifest_path": "${SQUADS_DIR}/instagram-intelligence-nirvana/squad.yaml",
      "manifest_hash": "sha256:abc123...",
      "domains": ["social_media", "media", "content"],
      "capabilities": ["media.video.analyze", "media.image.analyze", "social.competitor.benchmark"]
    }
  },
  "capabilities": {
    "media.video.analyze": [
      {
        "squad": "instagram-intelligence-nirvana",
        "description": "Analyze video file with multimodal LLM...",
        "domains": ["media", "content"],
        "examples": ["transcrever vídeo do Instagram", "analisar criativos..."],
        "not_for": ["análise de aula longa..."],
        "fidelity_status": "validated",
        "invoke": {"type": "task", "ref": "...", "agent": "..."},
        "score_boost": 1.0
      },
      {
        "squad": "nirvana-produtora-video",
        "description": "...",
        "fidelity_status": "experimental",
        "score_boost": 0.85
      }
    ],
    "marketing.campaign.full_funnel": [...]
  },
  "domains": {
    "media": ["instagram-intelligence-nirvana", "nirvana-produtora-video", "nirvana-video-creator"],
    "marketing": ["sales-funnel-masters", "brandcraft-nirvana", ...]
  },
  "bm25_index": {
    "comment": "Lunr.js / FlexSearch serialized index (binary, base64), indexed on description + examples + not_for"
  }
}
```

### 23.4 Indexing command

```bash
# Full rebuild (after major changes)
$ squads index

# Incremental (only changed squad.yaml files)
$ squads index --incremental

# Dry-run (show what would be indexed without writing)
$ squads index --dry-run

# Specific roots
$ squads index --roots ${SQUADS_DIR},${BUSINESSES_DIR}/squads
```

The indexer:

1. Walks all configured roots looking for `squad.yaml`.
2. Parses each manifest, validates against §22.9.
3. Computes `manifest_hash` (sha256 of normalized YAML).
4. Builds inverted indexes: capability_id → [squads], domain → [squads].
5. Builds BM25 index over (description + examples + not_for) per capability entry.
6. Writes `${SQUADS_REGISTRY_PATH}` and `${SQUADS_REGISTRY_PATH}.lock`.

### 23.5 Invalidation

The lock file tracks `(file_path, mtime, hash)` for every squad.yaml indexed. On every `squads find` invocation:

1. Compare lock file against current filesystem mtimes.
2. If any drift detected, refuse to use registry, suggest re-index.
3. Optional: `squads find --auto-index` rebuilds incremental on drift.

For long-running sessions, a hook in the harness re-checks lock every N minutes. See §26 telemetry on cache hit/miss tracking.

### 23.6 Hook for automatic invalidation

Recommended `~/.claude/settings.json` entry:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": {
          "tool": ["Edit", "Write"],
          "file_pattern": "*/squad.yaml"
        },
        "command": "squads index --incremental --quiet"
      }
    ]
  }
}
```

This is **adapter-specific** (Claude Code uses settings.json hooks; other runtimes have different mechanisms). See adapter §10 for the runtime-specific hook syntax.

---

## §24 Discovery Protocol

### 24.1 Two-tier discovery

v5 mandates a two-tier discovery strategy:

**Tier 1 · BM25 + grep (mandatory, zero LLM cost):**
- Match the user intent against the BM25 index.
- Match domain keywords (intent verb-object pairs vs. registered capability domains).
- Filter by `tools_required` (only capabilities the runtime can actually invoke).
- Apply `score_boost` from fidelity status.

**Tier 2 · Embedding similarity (optional, paid):**
- Only invoked when Tier 1 returns ambiguous results.
- Embed the intent and the candidate capability descriptions.
- Re-rank by cosine similarity.

The default for v5 is **Tier 1 only**. Embedding (Tier 2) requires explicit opt-in via `~/.claude/settings.json`:

```json
{
  "squads": {
    "discovery": {
      "tier2_embedding": "enabled",
      "tier2_provider": "voyage-ai|openai|local",
      "tier2_threshold": 0.6
    }
  }
}
```

### 24.2 Discovery input

```typescript
type DiscoveryInput = {
  intent: string;              // natural language from user or planner LLM
  domain_filter?: string[];    // restrict to these domains
  tools_available: string[];   // tools the calling runtime has
  min_fidelity?: 'validated' | 'experimental' | 'any';  // default: 'experimental'
}
```

### 24.3 Discovery output (3 signals)

```typescript
type DiscoveryOutput =
  | { signal: 'MATCH_HIGH', capability: string, squad: string, score: number, invoke: InvokeRef }
  | { signal: 'MATCH_AMBIGUOUS', candidates: Array<{capability, squad, score, why}> }
  | { signal: 'NO_MATCH', best_score: number, suggestion: string };
```

### 24.4 Routing thresholds

The default thresholds are conservative. They prevent silent wrong invocations.

| Signal | Condition | Action |
|---|---|---|
| `MATCH_HIGH` | Top score ≥ 0.80 AND second-place score < (top - 0.15) | Auto-invoke |
| `MATCH_AMBIGUOUS` | At least 2 candidates with score ≥ 0.60 within 0.15 of each other | Present to user/planner via AskUserQuestion |
| `NO_MATCH` | Best score < 0.60 | Refuse to invoke. Suggest creating a new capability. |

Thresholds are configurable in `~/.claude/settings.json`:

```json
{
  "squads": {
    "routing": {
      "match_high_threshold": 0.80,
      "match_high_lead": 0.15,
      "match_ambiguous_threshold": 0.60,
      "match_ambiguous_window": 0.15
    }
  }
}
```

### 24.5 Fail-loud principle

v5 makes failure-modes explicit. The discovery protocol MUST emit a clearly typed signal. It MUST NOT silently pick the best of bad options.

The original v4 failure case ("user asks for video analysis, system silently invokes wrong squad") becomes impossible in v5 because:

1. The capability `media.video.analyze` has explicit `not_for` entries excluding "aula educacional".
2. Tier 1 BM25 match against "vídeo de aula educacional" returns score < 0.80 because of penalty from `not_for`.
3. Discovery emits `NO_MATCH` with suggestion: "Create capability `media.video.educational` or use `media.video.analyze` with adaptation."
4. The harness shows this to the user instead of guessing.

### 24.6 Discovery CLI

```bash
$ squads find "transcrever vídeo do Instagram"
{
  "signal": "MATCH_HIGH",
  "capability": "media.video.analyze",
  "squad": "instagram-intelligence-nirvana",
  "score": 0.94,
  "invoke": {"type": "task", "ref": "ii-media-analyst-analyze-video", "agent": "ii-media-analyst"}
}

$ squads find "preciso analisar vídeo de aula educacional com slides"
{
  "signal": "NO_MATCH",
  "best_score": 0.62,
  "suggestion": "No capability indexed for educational video analysis. Closest match was 'media.video.analyze' but it explicitly excludes this case (see not_for). Consider creating capability 'media.video.educational' or invoking 'media.video.analyze' with explicit override."
}

$ squads find "fazer copy de página de vendas"
{
  "signal": "MATCH_AMBIGUOUS",
  "candidates": [
    {"capability": "marketing.copy.persuasive", "squad": "sales-funnel-masters", "score": 0.78, "why": "..."},
    {"capability": "content.copy.create", "squad": "copywriting-infoprodutos", "score": 0.71, "why": "..."},
    {"capability": "sales.copy.write", "squad": "high-conversion-copywriting", "score": 0.69, "why": "..."}
  ]
}
```

The `--json` flag is the default for machine consumption. `--pretty` for human reading.

### 24.7 Discovery telemetry

Every `squads find` call MUST emit (when telemetry enabled):

```
attribute: squad.discovery.intent_length     # int
attribute: squad.discovery.signal             # MATCH_HIGH | MATCH_AMBIGUOUS | NO_MATCH
attribute: squad.discovery.top_score          # float
attribute: squad.discovery.tier_used          # 1 | 2
attribute: squad.discovery.duration_ms        # int
attribute: squad.discovery.candidates_count   # int
attribute: squad.discovery.tools_filter_count # int
counter:   squad.discovery.calls_total        # incremented
```

See §26 for OpenTelemetry conventions.

---

## §25 Three-Signal Routing (formalized)

This section formalizes the routing policy that consumers (the harness, or a custom planner) MUST implement when integrating §24 discovery.

### 25.1 MATCH_HIGH handling

The harness MAY auto-invoke without user confirmation if:

- The capability is `validated` (not `experimental`)
- The user has not enabled `confirm_all` mode
- The estimated cost is below `auto_invoke_budget_usd` (default $1.00)

Otherwise, the harness presents the match and asks for confirmation.

### 25.2 MATCH_AMBIGUOUS handling

The harness MUST present candidates to the user via the runtime's question primitive (AskUserQuestion in Claude Code, equivalent in others). Format:

```
Multiple capabilities could handle "{intent}":

1. {capability_id} (score {score})
   Squad: {squad}
   Why: {why}
   Anti-pattern check: {not_for matches against intent, if any}

2. {capability_id} (score {score})
   ...

[ Choose by number, or type "none" to refuse all. ]
```

Runtimes without an interactive question primitive MUST default to refusing the invocation and emit a clear error.

### 25.3 NO_MATCH handling

The harness MUST NOT invoke any capability. It MUST present the suggestion to the user. The user has 3 paths:

1. Create a new capability (the harness offers a scaffold).
2. Force-invoke a near match with explicit override.
3. Abandon the intent.

### 25.4 Override mechanism

Force-invocation (when user knows better than discovery):

```bash
$ squads invoke media.video.analyze --override --intent "analyze educational video" --input video=lesson.mp4
```

The `--override` flag bypasses signal validation but is logged in telemetry as `squad.discovery.override: true`.

### 25.5 Routing decision tree (canonical)

```
intent received
  ↓
discovery (Tier 1)
  ↓
signal = ?
  ├─ MATCH_HIGH ── validated? ── auto-invoke (if budget OK) ── done
  │                  experimental? ── show + confirm ── invoke if confirmed
  │                  drifted? ── refuse, require --force-drifted
  ├─ MATCH_AMBIGUOUS ── AskUserQuestion ── invoke selection or none
  └─ NO_MATCH ── (Tier 2 enabled?) ── retry with embedding
                  ── still NO_MATCH? ── present suggestion, await user direction
```

---

## §26 Telemetry Conventions (OpenTelemetry GenAI)

### 26.1 Why this exists

v4 §20.4 marked live progress streaming as Proposed (Not Implemented). v5 mandates OpenTelemetry GenAI conventions for any squad that declares `instrumentation:` in its manifest. This is the only way to honestly measure token economy claims.

### 26.2 Manifest declaration

```yaml
# squad.yaml
instrumentation:
  enabled: true
  provider: otel  # otel | none
  trace_attributes_required:
    - squad.name
    - squad.version
    - capability.id
    - workflow.name
    - agent.name
    - tokens.input
    - tokens.output
    - tokens.cached
    - cost.usd
    - duration_ms
  trace_attributes_optional:
    - intent.user
    - handoff.size_tokens
    - tool.name
    - tool.duration_ms
```

### 26.3 Span conventions

| Span name | Trigger | Required attributes |
|---|---|---|
| `squad.discovery` | `squads find` invocation | intent_length, signal, top_score, tier_used, duration_ms |
| `squad.invoke` | capability invocation | capability.id, squad.name, invoke.type, total_duration_ms, total_cost_usd |
| `workflow.execute` | workflow execution | workflow.name, steps_count, success, duration_ms |
| `agent.execute` | per-agent LLM call | agent.name, model, tokens.input, tokens.output, tokens.cached, cost.usd, duration_ms |
| `tool.invoke` | per-tool call within agent | tool.name, duration_ms, success |
| `handoff.emit` | handoff artifact creation | from_agent, to_agent, size_tokens |

### 26.4 Metric conventions

```
counter   squad.invocations_total{squad, capability, signal}
counter   squad.discovery_calls_total{signal}
counter   squad.tokens_total{squad, capability, agent, kind=input|output|cached}
counter   squad.cost_usd_total{squad, capability}
histogram squad.invoke_duration_ms{squad, capability}
histogram squad.discovery_duration_ms{signal}
histogram squad.handoff_size_tokens{from_agent, to_agent}
gauge     squad.cache_hit_ratio{cache=registry|prompt}
```

### 26.5 Adapter responsibility

Each runtime adapter MUST document:

1. Which OTel exporter is used (OTLP HTTP, OTLP gRPC, stdout, none).
2. Where traces/metrics/logs are persisted by default.
3. How to override the destination (env var or config file).

Runtimes that cannot emit OTel MUST mark `features_supported: [..., -telemetry_otel]` in their manifest. Squads that declare `instrumentation.required: true` will fail to load on those runtimes (P5 fail-closed).

### 26.6 Cost calculation contract

Cost is computed at the `agent.execute` span level using the model's published pricing:

```
cost_usd = (tokens_input * input_price_per_token)
         + (tokens_output * output_price_per_token)
         - (tokens_cached * cache_discount)
```

Pricing tables live in adapter manifests under `numeric_values.model_pricing`. Squads MUST NOT hardcode prices; they declare model family and let the adapter resolve.

---

## §10bis Tool Whitelist enforcement (tightened)

v5 tightens v4 §10 by mandating that adapter manifests declare an `enforcement_level` per tool category. Squads MAY refuse to load on adapters with insufficient enforcement.

```yaml
# adapter manifest excerpt (claude-code.yaml)
tool_enforcement:
  level: hybrid  # enforced | advisory | hybrid | unsupported
  enforced_categories: [bash, file_write, network_egress]
  advisory_categories: [read, grep, glob]
```

```yaml
# squad.yaml
required_enforcement:
  - tool: bash
    level: enforced  # squad refuses to load if adapter's bash enforcement is < enforced
  - tool: file_write
    level: enforced
```

This addresses sandboxing requirements without requiring a full sandbox primitive (which v4 §16.5 marks as adapter-specific).

---

## §11bis Memory: business_scope

v5 adds a fifth memory scope to v4 §11.1 to support inter-protocol bridges (Squad ↔ Business):

| Scope | Lifetime | Who sees it | Where |
|---|---|---|---|
| business_scope | One business invocation chain | Squads invoked by a business in the same project | `${PROJECTS_OUTPUT_DIR}/{project}/businesses/{biz}/squads/{squad}/memory.md` |

This scope exists only when a Squad is invoked from within a Business context (via the Harness Protocol). Standalone squad invocations do not use this scope.

The full hierarchy is now: Ephemeral → Session → business_scope (optional) → Project → Global.

---

## §15bis Validation Stage 1.5

Inserted between Core (Stage 1) and Adapter (Stage 2) validation:

**Stage 1.5: Capability Schema Validation**

Runs only if the squad declares `capabilities:`. Validates each entry against the capability JSON Schema (App-D). Failures are blocking.

Checks:
1. `id` matches the canonical regex.
2. `id` is unique within the squad.
3. `domains` are all in catalog (or `experimental_domains: true` flag set).
4. `invoke.ref` points to existing component.
5. `examples`, `not_for` are non-empty arrays of non-empty strings.
6. `fidelity.ground_truth_dir`, if declared, exists with at least 1 case.
7. `fidelity.status` is one of: `validated`, `experimental`, `drifted`.

---

## App-C · Canonical Capability Catalog (controlled taxonomy)

The catalog is a flat list of acceptable `domains` and a hierarchical tree of acceptable `id` prefixes. Squads MUST use entries from this catalog unless they declare `experimental_domains: true` (which excludes the squad from default discovery).

### App-C.1 Canonical domains (59 entries, v1)

```
Marketing & Sales:
  marketing, sales, branding, copy, growth, performance, ads, retention, lifecycle, crm

Content & Media:
  content, media, video, audio, voice, tts, image, social_media, podcasting, journalism

Engineering & Tech:
  software_engineering, frontend, backend, mobile, data_engineering, devops, security,
  infrastructure, ai_engineering, qa, observability

Business & Strategy:
  strategy, business_operations, finance, accounting, legal, compliance, hr, recruiting,
  consulting, analytics

Vertical Domains:
  healthcare, education, real_estate, fintech, crypto, gaming, ecommerce, hospitality,
  energy, agriculture, government, foodtech

Cross-cutting:
  research, knowledge_management, document_processing, automation, integration,
  multi_agent_orchestration
```

### App-C.2 Canonical id namespaces (top-level segments, v1)

```
marketing.*    branding.*     sales.*           growth.*
content.*      media.*        social.*          ads.*
business.*     strategy.*     analytics.*       finance.*
legal.*        compliance.*   research.*        knowledge.*
software.*     frontend.*     backend.*         data.*
devops.*       security.*     ai.*              qa.*
healthcare.*   education.*    real_estate.*     fintech.*
crypto.*       gaming.*       ecommerce.*       hr.*
```

### App-C.3 Sample capability ids per namespace (illustrative, not exhaustive)

```
marketing.campaign.full_funnel       marketing.campaign.launch
marketing.copy.persuasive            marketing.copy.headline
branding.identity.create             branding.voice.define
sales.funnel.design                  sales.offer.craft
growth.experiment.design             growth.loop.identify
content.production.scale             content.editorial.calendar
media.video.analyze                  media.video.educational
media.video.transcribe               media.image.analyze
social.competitor.benchmark          social.engagement.audit
ads.creative.brief                   ads.budget.optimize
business.strategy.positioning        business.org.design
analytics.dashboard.build            analytics.report.executive
finance.model.unit_economics         finance.fundraise.deck
legal.contract.review                legal.compliance.audit
research.market.intelligence         research.competitor.scan
software.review.code                 software.architecture.design
frontend.ui.design                   frontend.component.build
backend.api.design                   backend.database.schema
data.pipeline.build                  data.quality.validate
devops.deploy.automate               security.audit.application
ai.eval.design                       ai.prompt.optimize
healthcare.documentation.clinical    education.curriculum.design
real_estate.deal.analyze             fintech.product.compliance
```

### App-C.4 Catalog governance

- Catalog versioned alongside protocol: `App-C v1` ↔ `Squad Protocol 5.0`.
- Additions: PR against `~/.claude/skills/squads/v5/CATALOG.yaml`.
- Removals: deprecation cycle of one minor version (e.g. removed in 5.2 means deprecated in 5.1).
- Custom domains: squads MAY use `experimental_domains: true` to skip catalog check, but they receive `score_boost: 0.7` penalty in discovery.

---

## App-D · Capability JSON Schema (reference)

Full JSON Schema published at `~/.claude/skills/squads/v5/schemas/capability.schema.json`.

Inline summary:

```json
{
  "$id": "https://squads.protocol/v5/schemas/capability.schema.json",
  "type": "object",
  "required": ["id", "description", "domains", "invoke"],
  "properties": {
    "id": {
      "type": "string",
      "pattern": "^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*){2,}$"
    },
    "description": {"type": "string", "minLength": 20},
    "domains": {
      "type": "array",
      "items": {"type": "string"},
      "minItems": 1
    },
    "inputs": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["name", "type"],
        "properties": {
          "name": {"type": "string"},
          "type": {"enum": ["file", "string", "json", "array", "number", "boolean"]},
          "formats": {"type": "array", "items": {"type": "string"}},
          "schema": {"type": "string"}
        }
      }
    },
    "outputs": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["name", "type"],
        "properties": {
          "name": {"type": "string"},
          "type": {"enum": ["file", "string", "json", "array", "markdown"]},
          "format": {"type": "string"},
          "schema": {"type": "string"}
        }
      }
    },
    "tools_required": {
      "type": "array",
      "items": {"type": "string"}
    },
    "invoke": {
      "type": "object",
      "required": ["type", "ref"],
      "properties": {
        "type": {"enum": ["workflow", "task", "agent"]},
        "ref": {"type": "string"},
        "agent": {"type": "string"},
        "prompt_template": {"type": "string"},
        "inputs_mapping": {"type": "object"}
      }
    },
    "examples": {
      "type": "array",
      "items": {"type": "string", "minLength": 5}
    },
    "not_for": {
      "type": "array",
      "items": {"type": "string", "minLength": 5}
    },
    "fidelity": {
      "type": "object",
      "required": ["status"],
      "properties": {
        "ground_truth_dir": {"type": "string"},
        "eval_results": {"type": "string"},
        "status": {"enum": ["validated", "experimental", "drifted", "retired"]},
        "last_eval": {"type": "string", "format": "date-time"},
        "judge_model": {"type": "string"},
        "threshold": {"type": "number", "minimum": 0, "maximum": 1}
      }
    }
  }
}
```

---

## App-E · Migration v4 → v5 (squad author guide)

For each existing v4 squad, the upgrade path is:

```
1. Set protocol: "5.0" in squad.yaml
2. Add capabilities: [] block
3. For each "interesting unit" the squad delivers:
   - Identify a capability id (consult App-C)
   - Write description (1 paragraph, concrete)
   - List inputs/outputs
   - Write 3-5 examples (positive intents)
   - Write 2-3 not_for (anti-patterns, with alternative pointers)
   - Identify tools_required
   - Identify invoke.{type, ref, agent}
4. (Optional, recommended for production capabilities):
   - Create capabilities/{id}/ground-truth/ with 5-10 cases
   - Create capabilities/{id}/eval-config.yaml
   - Run eval, get eval-results.json
   - Set fidelity.status accordingly
5. Run `squads index --incremental`
6. Verify: `squads find "{example_intent}"` returns MATCH_HIGH for your capability
```

A v4 squad without `capabilities:` block is still loadable in v5 (degraded discovery). Adding `capabilities:` is opt-in, but strongly recommended for any squad used by more than one consumer.

---

## App-F · Anti-patterns (what to NOT do in v5)

**1. Capability id collisions across squads.**
Two squads cannot declare the same capability id. The registry rejects on indexing. If two squads genuinely cover the same capability, choose: (a) make one a wrapper of the other, or (b) declare distinct capability ids with different `domains` discriminators.

**2. Empty or generic descriptions.**
"Analyze stuff" is rejected by validator (length and specificity check). Description must be concrete enough that BM25 can match against intent.

**3. Examples that overlap with not_for.**
If `examples: ["analyze video"]` and `not_for: ["analyze video for education"]`, BM25 gets confused. Examples MUST be distinct from anti-patterns.

**4. Capability id inflation.**
Don't declare 50 capabilities per squad. Most squads should have 3-10. If you have more, the squad is doing too much; consider splitting.

**5. Fidelity theater.**
Don't declare `status: validated` without actual ground-truth + eval-results.json. Validator checks file existence. The harness will refuse capabilities whose claimed status doesn't match disk reality.

**6. Hardcoded model prices in capability cost estimates.**
Pricing lives in adapter manifest. Capabilities should declare model family (e.g. `model_hint: sonnet`); cost is computed by adapter at invoke time.

**7. Capabilities that depend on side-effects from other capabilities.**
Each capability MUST be invocable independently given declared inputs. If capability B requires output of capability A, declare a workflow that chains them; don't declare B with implicit dependency on A.

**8. Mixing capability discovery with business orchestration.**
Capabilities are atomic. Business workflows that span multiple capabilities belong to the Business Protocol (separate spec). Don't try to model business processes inside capability declarations.

---

## §27 Output Humanization (P11)

P11 estende os princípios do v4 (P1-P10):

> **P11 Output Humanization** — Outputs voltados a humanos saem humanizados **na origem**, sem marcadores típicos de texto gerado por IA (em-dash excessivo, palavras órfãs em quebras de linha, "rule of three", parallelismos negativos, vocabulário inflacionado). O conteúdo factual permanece intacto; o estilo já nasce ajustado.

### 27.1 Mecanismo (writing contract)

A humanização **não é** um passo posterior à geração, nem um campo por capability, nem uma skill. As regras de escrita (writing contract) vivem nos memory files de runtime (`CLAUDE.md` / `AGENTS.md` / `GEMINI.md`) e entram no contexto de **todo agente despachado**, que produz prosa humanizada desde o primeiro token. Não existe `humanize` em `capabilities[]` (o schema enforced rejeita o campo), nem pós-processamento de adapter, nem a antiga skill `humanizer`.

### 27.2 Por que na origem

Prevenção em vez de correção. O contrato fica no prefixo estável carregado pelo runtime: custo zero de tokens por dispatch (cache hit) e sem a etapa frágil de "reescrever depois". Texto que nasce certo dispensa passada de limpeza.

### 27.3 Cross-protocol

A política completa fica em **Business Protocol v1 §10.7** (BP13). Squads herdam essa política quando rodam dentro de uma business; squads standalone aplicam o mesmo writing contract via memory file do runtime.

---

## Appendix Z · Version History

| Version | Date | Status | Changes |
|---|---|---|---|
| 5.0.0-draft | 2026-05-02 | DRAFT | First draft. Adds §22 Capabilities, §23 Registry, §24 Discovery, §25 Routing, §26 Telemetry. Tightens §10. Adds §11bis (business_scope). Adds §15bis (capability validation). Adds App-C catalog, App-D schema, App-E migration guide, App-F anti-patterns. |
| 4.1.0 | 2026-04-05 | RELEASED | Output convention §16bis. |
| 4.0.0 | 2026-04-04 | RELEASED | Runtime-agnostic rewrite. |

---

*End of Squad Protocol Specification v5.0.0-draft delta. Sections 1-21 of v4.0 unchanged; consult `SQUAD_PROTOCOL_V4.md`.*

*Runtime-specific details continue to live in `adapters/{runtime_id}.{md,yaml}`. Adapter v5 manifests MUST declare `protocol_version: "5.0"` and the new feature support flags introduced in this version (`tool_enforcement_level`, `telemetry_otel`).*

*Peer review pending. Comments to: ~/migration-tools/SQUAD_PROTOCOL_V5_REVIEW.md*
