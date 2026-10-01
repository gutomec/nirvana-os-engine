# Squad Protocol Specification, v6

```
Title:    Squad Protocol Specification
Version:  6.1.2 (complete)
Status:   ACTIVE
Date:     2026-09-30
Author:   Luiz Gustavo Vieira Rodrigues (Prospecteezy)
License:  SUL-1.0
Scope:    Package layout, manifest, agents, tasks, the workflow document,
          capabilities, discovery, acceptance, evaluator, composition,
          execution binding, admission and migration. Runtime-agnostic core.
```

This document is complete and self-contained. Earlier versions (v2, v4, v5) are archived in the repository's `docs/legacy/protocols/squads/` and are history only.

## How to read this document

- **Section numbers are stable.** Code, tests and docs cite them (§28.6, §33.1, §16bis, App-G). A section that no longer applies keeps its heading with one line saying what replaced it.
- **The code is the ground truth.** The Zod schemas in `skills/_shared/validators/validators.ts`, the generated JSON schemas (App-G), the admission gate (`skills/_shared/lib/verify/kinds/squad.ts`) and the templates in `skills/squads/templates/` define what is enforced. Where this text and the code disagree, the code wins and the text is a defect.
- **Severity follows the manifest's `protocol`** (§34). A rule that is an error under `protocol: "6.0"` is a warning under `"5.0"`.
- **A contract wired halfway says so.** The word **limit** marks a rule the schema accepts and a reader consumes, while the path that would close the loop has no production caller yet.
- New squads declare `protocol: "6.0"`. Squads declaring `4.0`, `4.1` or `5.0` keep loading (§21).

---

## 1. Introduction and scope

### 1.1 Purpose

The Squad Protocol is a portable standard for multi-agent AI work. A **squad** is a self-contained package of agents, tasks, workflows and metadata that delivers one domain of work, and it must run on more than one agentic runtime without modification.

### 1.2 What the protocol is

A conceptual model of agents, tasks, workflows and capabilities; a file-and-folder contract (`squad.yaml`, `agents/*.md`, `tasks/*.md`, `workflows/*.md`); portable schemas with namespaced extensions; validation rules enforced by the admission gate (§34); and the design principles of §3.

### 1.3 What it is not

It is not a runtime and does not execute agents. It does not choose an LLM. It does not promise that every runtime enforces every concept: a feature a runtime lacks degrades (§18.2) instead of crashing.

### 1.4 Runtime neutrality

This document names no runtime-specific memory file, tool name, CLI flag or token budget. Those live in adapters (`skills/_shared/adapters/`). Audience: squad authors, harness implementers, adapter authors and tool builders.

---

## 2. Terminology

| Term | Definition |
|---|---|
| **Squad** | A package of agents, tasks, workflows and metadata under one `squad.yaml`. |
| **Agent** | A Markdown file: YAML frontmatter (runtime config) plus a prose body (the system prompt). |
| **Task** | A Markdown file describing one unit of work: outcome, input, output, acceptance criteria. |
| **Workflow** | A Markdown document whose frontmatter is a step graph and whose body is prose per step (§28). |
| **Capability** | A named, discoverable promise of the squad, bound to a workflow, task or agent (§22). The unit of discovery. |
| **Adapter** | A document mapping core concepts to one runtime's primitives (§18.5). |
| **Work card** | A one-page map of a squad compiled per run from frontmatter, read by an agent that uses the squad without dispatching it (§32.3). |
| **Admission gate** | `nrv validate squad`, the check a squad passes to enter the library (§34). |
| **Contract surface** | `.nirvana-surface.json`: the stable identifiers of a squad and a hash of each body, so change between versions is computed, not narrated (§5.4). |

The **harness** or **orchestrator** is the software that routes a brief, dispatches work and judges results. A **runtime** is the LLM environment that runs an agent (Claude Code, Codex, Gemini CLI and others).

---

## 3. Design principles

Every rule in this protocol traces to at least one of these.

- **P1. Separation of audiences.** Information belongs to one audience: the runtime or harness (frontmatter, `squad.yaml`), the LLM (agent and task bodies), or the UI and marketplace (descriptions, tags). A field serving two audiences is a bug.
- **P2. Prose over structure.** The LLM reads the body, so persona, guidelines, process and output format go there as prose, not in frontmatter as nested arrays.
- **P3. Token budget discipline.** Every token in an agent body must earn its place. Target 1,000 to 2,500 tokens; a body that outgrows that has more than one job, so split the agent.
- **P4. Bounded iteration.** Every agent declares `maxTurns`; no runtime default is assumed (§14).
- **P5. Fail-closed defaults.** No tool whitelist means no tools. A missing capability is rejected, never auto-granted. An unknown runtime field is ignored, never applied.
- **P6. Task-first.** Tasks say what to do; the workflow says who does what. A task never names its agent.
- **P7. Runtime neutrality.** The core has no runtime-specific values.
- **P8. Technical honesty.** Every pattern carries a maturity label (§19) and half-wired contracts are labelled **limit**. The protocol does not promise enforcement that does not exist.
- **P9. Graceful degradation.** A missing optional feature is logged and substituted. A missing required feature fails the load, cleanly and loudly.
- **P10. Namespaced extensions.** Runtime-specific configuration goes under `runtimes.{runtime_id}.*`; other runtimes ignore foreign namespaces.
- **P11. Output humanization.** Human-facing output is written without the tells of generated text, at the source, through the writing contract in the runtime memory file (§27).

---

## 4. Architecture layers

### 4.1 Two layers

The **core protocol** (this document) holds the model, contracts, schemas, validation rules and principles. **Adapters** (`skills/_shared/adapters/{runtime}.md`) map the core to one runtime. A claim true on every runtime belongs here; a number, a file name or a flag belongs in an adapter.

### 4.2 Core versus adapter

The core owns agent, task, workflow and capability, the mandatory `maxTurns`, the handoff shape, the memory scopes and the iteration verdicts. Adapters own compaction values, the subagent mechanism, tool whitelist enforcement strength, CLI flags, memory file names, hooks, fork and teammate primitives and runtime-specific validators.

### 4.3 How a squad chooses a runtime

```yaml
runtime_requirements:
  policy: active        # default
  incompatible: []
```

`policy: active` (the default since 6.1.2) runs the squad on the runtime hosting the session, on that runtime's model and effort; `minimum` and `compatible` are then information, not an allowlist. A squad built around one runtime's tools sets `policy: declared`, which restricts the run to `minimum` plus `compatible` and requires `minimum` to name at least one runtime. `incompatible` is a hard denial under either policy. The engine never installs, starts or switches runtimes (§18).

### 4.4 Who runs a squad

A squad runs in one of two ways. Neither involves a chain of seats, directors or seat subagents.

1. **On its own.** The orchestrator dispatches it with `nrv dispatch --squad <slug>[:<capabilityId>]` (`nrv run --squad` also executes). One agent plays the squad end to end (§32.2).
2. **Inside a business.** A business runs as ONE agent. It uses a squad by reading its work card (`nrv cards squad <slug>`) and working as the squad's agents. A business never dispatches a squad (§32.3).

---

## 5. Squad structure

### 5.1 The manifest

Every squad has a `squad.yaml` at its root, validated by `SquadManifestSchema`. A minimal v6 manifest:

```yaml
name: report-writer                 # kebab-case, ^[a-z][a-z0-9-]{1,63}$
version: "1.0.0"
protocol: "6.0"
description: "Writes structured market reports from a topic brief."
license: SUL-1.0
capabilities:
  - id: research.report.write
    description: "Writes a structured market report from a topic brief: outline, sourced sections, executive summary."
    domains: [research, content]
    invoke: { type: workflow, ref: workflows/main-pipeline }
    examples: ["write a market report on electric scooters"]
    produces: [market-report]
    acceptance:
      - { id: outline_covered, description: "every outline section appears in the report", blocking: true }
components:
  agents: [orchestrator.md, specialist.md]
  tasks: [plan.md, execute.md]
  workflows: [main-pipeline]
runtime_requirements: { policy: active }
```

| Field | Rule |
|---|---|
| `name` | required; `^[a-z][a-z0-9-]{1,63}$` |
| `version` | required; semver |
| `protocol` | required; `4.0`, `4.1`, `5.0` or `6.0` |
| `description` | at least 20 characters when present |
| `author`, `license`, `slashPrefix`, `tags` | optional metadata |
| `capabilities[]` | required under 5.0 and 6.0 (`capabilities_missing`); at most 50 (`LIMITS.squad_capabilities_max`); entries per §22 |
| `experimental_domains` | boolean, default `false`; allows domains outside the catalog (App-C) |
| `components` | strict: `agents[]`, `tasks[]`, `workflows[]`, `schemas[]`; every entry must exist (`components_missing`) |
| `runtime_requirements` | §4.3, §18.1 |
| `features_required[]` | closed enum (App-B); the load fails if the runtime lacks one |
| `features_optional[]` | free strings; a missing one degrades (§18.2) |
| `output` | accepted, ignored: the engine owns the output path (§16bis) |
| `legacy`, `io`, `memory`, `instrumentation` | accepted blocks, carried, not interpreted |

Unknown top-level keys are tolerated and passed through, and the capability validator warns on each. `components` and each capability are `.strict()`: an unknown key there fails `manifest_schema`.

### 5.2 Directory layout

```
{squad-name}/
├── squad.yaml            REQUIRED   manifest
├── agents/*.md           REQUIRED   agent definitions
├── tasks/*.md            REQUIRED   task definitions
├── workflows/*.md        REQUIRED   workflow documents (first level only)
├── dependencies.yaml     recommended  host dependencies (§5.3)
├── README.md             recommended
├── schemas/*.json        optional   output schemas
├── references/ data/ templates/ scripts/ tools/ checklists/    optional
└── .nirvana-surface.json engine-owned (§5.4)
```

Only the first level of `workflows/` is protocol surface; nested trees are neither read nor charged. Agent, task and workflow names match `^[a-z][a-z0-9_-]*$`, equal their file stem and are unique within their kind.

### 5.3 Host dependencies

`dependencies.yaml` declares what the engine cannot install and what an installer must know. Absent means self-contained, and the gate warns (`dependencies_missing`). Sections: `system:` (programs on PATH: `name`, `check`, per-platform `install`), `python:` and `node:` (packages, installed into shared environments), `env_vars:` (credentials by name, with `required:` and `description:`) and `mcps:` (`name`, `purpose`, `required`). `nrv activate <slug>` installs what is missing. Credentials and MCP servers belong to the host runtime and the operator (§9.3).

### 5.4 What the engine owns and what stays out

- **`.nirvana-surface.json`** is generated, deterministic (no timestamp, sorted keys) and excluded from what it measures. Never edit it. `surface_missing` (error) and `surface_stale` (warning) are fixed by `surface_regen`.
- **No run output inside the squad.** A directory named `outputs/` or `output/` is `outputs_pollution` (error); `runs/` and `results/` warn.
- **No per-buyer artifacts** in a source squad: `PROVENANCE.json`, `LICENSE.txt` and `SQUAD-DOCTOR-REPORT.md` belong to an installed copy (`distribution_artifacts`).
- **No machine-local paths** (`portability`).
- **No memory** (§11.2).

---

## 6. Agent specification

### 6.1 File format

`agents/{agent-name}.md`: YAML frontmatter, then a Markdown body. The runtime separates them, and the LLM receives the body.

### 6.2 Frontmatter

```yaml
---
name: agent-name
description: "Verb domain. Use when trigger. Do NOT use for anti-pattern."
maxTurns: 25
tools: [read, write, grep, bash]
model: inherit
runtimes:
  claude-code: { tools: [Read, Write, Grep, Bash] }
---
```

| Field | Status | Purpose |
|---|---|---|
| `name` | required | identity; equals the file stem |
| `description` | required | the selection criterion |
| `maxTurns` | required (P4) | loop bound; absence is `agent_frontmatter_incomplete` |
| `tools` | required by the gate | portable whitelist (§10) |
| `model` | recommended | family hint: `haiku`, `sonnet`, `opus`, `fable`, `inherit` |
| `version` | optional | agent version |
| `runtimes.{id}` | optional | runtime-specific overrides (P10) |

### 6.3 Description pattern

The `description` is how a planner picks the agent: `[Verb] [domain]. Use when [trigger]. Do NOT use for [anti-pattern].` Example: "Investigates topics using web search. Use when the task needs current data or sourced claims. Do NOT use for opinion pieces."

### 6.4 Body

In order: an opening paragraph (identity and scope in two or three specific sentences, no roleplay); `# Guidelines` with `## DO` and `## DO NOT`; `# Process` (numbered steps); `# Output` (format and location, with a `## GOOD example` and a `## BAD example`); `# Safety Boundaries` (§10.5). The scaffold is `templates/agent.md.tmpl`.

### 6.5 Body size

A discipline relative to the runtime's context window (P3). If the body outgrows the adapter's recommended target, split the agent. Portable tool names are in §10.7.

---

## 7. Task specification

### 7.1 File format

`tasks/{task-name}.md`: frontmatter `name` and `description`, then the sections of §36.2 (`## Outcome`, `## Input`, `## Output`, `## Acceptance Criteria`, optional `## Output Schema`).

### 7.2 Tasks have no owners

A task never names an agent and has no `owner:` field. The workflow step binds an agent to a task, so the same task can run under different agents.

### 7.3 Acceptance criteria are binary and verifiable

"Every target file was scanned" is verifiable by comparing lists. "Each finding has file, line, severity, fix" is verifiable by a schema check. "Output is high quality" is a goal, not a criterion: make it measurable or drop it. A task with neither `## Acceptance Criteria` nor `outputs:` raises `task_acceptance_missing`.

### 7.4 Output schemas

A task whose output feeds another step declares an output schema, so a violation is caught at handoff: a file listed in `components.schemas` and referenced by `capabilities[].outputs[].schema`, or an inline `## Output Schema`.

---

## 8. Workflow orchestration

The file format is §28. This section is about shape.

**Patterns.** A pipeline (each step requires the previous), parallel steps (no dependencies), a DAG (steps declare `requires`) and a loop (a bounded review and fix cycle, described in the step body, §14.3).

**Layers.** Steps at the same dependency depth form a layer. Layers run in order; steps within one may run in parallel when the runtime can spawn work and the steps are `parallel_safe`. On a runtime without `subagent_spawning` the executor runs steps sequentially in topological order. That is a runtime decision, and the author does not rewrite the workflow.

**Failure.** A step or the workflow may declare `on_failure`: `abort`, `retry`, `escalate` or `continue`. The graph carries it and shows it to the executor; the engine does not enforce it (**limit**, §32.4). A structured or non-enum `on_failure`, such as a nested fallback chain, is preserved verbatim in `meta.on_failure` and not interpreted: describe a fallback in the step's body instead.

---

## 9. Communication and handoff

### 9.1 Escalation

A step that cannot proceed escalates to a human or a higher-tier agent instead of guessing. `on_failure: escalate` and the `ESCALATE` verdict (§14.4) are the two ways a squad says so.

### 9.2 Handoff artifact

When one agent plays every step, the handoff is the files each step writes under the run directory, plus this short summary when a squad wants one:

```json
{
  "schemaVersion": "1.0.0",
  "from_agent": "agent-a", "to_agent": "agent-b",
  "summary": "one paragraph",
  "key_decisions": ["at most 5"],
  "files_modified": ["at most 10"],
  "blockers": ["at most 3"],
  "next_action": "what the receiver does first",
  "artifacts": ["output/findings.json"]
}
```

Target under 500 tokens. It is small, structured and self-describing, so it survives compaction (§13).

### 9.3 Credentials and MCP servers

A squad never runs an MCP server and never carries a secret. The runtime that executes the squad runs MCP servers from its own configuration. The squad declares what it needs in `dependencies.yaml` (`mcps:`, `env_vars:`), and `nrv activate`, `nrv doctor` and the dispatch preflight report what is not configured. They never block.

### 9.4 Error categories

`transient` (retry with backoff), `state` (roll back, retry), `configuration` (skip or escalate), `dependency` (recovery step), `contract` (output does not match its schema: repair prompt, retry) and `fatal` (escalate to a human). The v4 message types (`REQUEST`, `INFORM`, `DELEGATE`, `ESCALATE`) and the JSON error envelope are retired: no reader consumes them.

---

## 10. Tool declaration

### 10.1 Declaration, not enforcement

A squad declares which tools each agent may use. The runtime enforces it to a degree that varies, and the adapter documents the level: `enforced` (unlisted tools do not exist in the schema sent to the LLM), `advisory` (the list is instruction and the model may ignore it), `hybrid` or `unsupported`.

### 10.2 Grammar

```yaml
tools: [read, grep, glob]            # portable semantic names
runtimes:
  claude-code: { tools: [Read, Grep, Glob, Bash] }   # native names
  codex: { allowedTools: [read, grep] }
```

An agent that declares no tools and no runtime override has none (P5): it can only reason and write text.

### 10.5 Safety boundaries in the body

The whitelist is the first defense. The second is prose against misuse of tools the agent legitimately has:

```markdown
# Safety Boundaries
- NEVER delete files outside the run directory
- NEVER rewrite git history
- If uncertain about a destructive action, write it to pending-actions.json instead
```

### 10.6 Retired: `required_enforcement`

The v5 manifest field `required_enforcement` and the adapter field `tool_enforcement` are retired: no reader consumes either. Enforcement strength is documented per adapter (§18.5).

### 10.7 Portable tool names

`read` (read a file), `write` (create or overwrite), `edit` (modify), `grep` (search contents), `glob` (find by pattern), `bash` or `shell` (run commands), `web_search`, `web_fetch`, `git`, `http`. Adapters map them to native names. The `tools:` field accepts free strings, and validators warn on unknown ones.

---

## 11. Memory model

### 11.1 Scopes

| Scope | Lifetime | Seen by |
|---|---|---|
| Ephemeral | one invocation | the current agent |
| Session | one run | every step, through the run directory |
| Project | one project | work on that project |
| Global | the machine | work on that machine |

Runtimes implement them with different files. Under the engine, project and global memory are the two homes in `skills/_shared/lib/entity-memory.ts`.

### 11.2 Memory never lives inside the squad

A squad directory is the product: it is replaced wholesale on a pack update, on `nrv migrate` and on reinstall, so anything accumulated there sits on a surface designed to be overwritten. Memory goes to:

```
<~/.nirvana>/memory/squads/<slug>/{permanent.md,learned.md}            machine scope
<projectRoot>/.nirvana/memory/squads/<slug>/{permanent.md,learned.md}  project scope
```

`permanent.md` is curated by the owner; `learned.md` is promoted from past runs. Scope is a judgment by whoever records the fact, from its meaning, never inferred from the working directory. A write states its scope and a read returns both, labelled. A `memory/permanent.md` shipped inside a squad is a seed, read once into an empty machine home and never written.

The manifest's `memory:` block is carried but not read, and the v4 garbage-collection fields (`max_learned_facts`, `review_interval_days`, `conflict_resolution`) are retired for the same reason. Memory files put rules above learned facts, because the top of a file is seen first.

### 11.3 Retired: `business_scope`

The v5 fifth scope (§11bis) is retired. A business that uses a squad reads its card and works as its agents inside one agent (§32.3), so there is no separate squad memory per business invocation. The business keeps its own.

---

## 12. Context engineering

Budgets are relative: an agent body at most about 1.5% of the runtime's context window, a handoff at most 0.25%, session artifacts at most 5% cumulatively. Adapters publish absolute numbers. Compaction is a runtime event, so the author's lever is design: small agents, narrow tasks, clean handoffs. A handoff that drags the whole history between steps costs more than a large body ever does.

---

## 13. Context preservation

Four practices let information survive compaction: put critical instructions in the initial prompt, which runtimes preserve verbatim; put runtime-critical context in a tagged block the LLM can reference (`<protocol-context>…</protocol-context>`); put file paths and line numbers in output, since compactors keep them and drop descriptive prose; and prefer small agents and short histories. The handoff artifact (§9.2) survives because it is small, structured and self-describing.

---

## 14. Bounded iteration

### 14.1 `maxTurns` is mandatory

Every agent declares `maxTurns`. No runtime default is assumed.

### 14.2 Turn budgets

Typical values: 3 to 5 for a single-file read and report, 10 to 20 for a review pass, 15 to 30 for a targeted fix and test, 25 to 50 for research with several searches, 50 to 100 for a multi-file refactor. Tune to the task.

### 14.3 Four kinds of loop

| Loop | Bound | Default | When exhausted |
|---|---|---|---|
| Turn budget (per agent) | `maxTurns` | required | the agent stops |
| QA loop (review and fix) | `max_iterations` | 5 | accept best effort, flag for review |
| Retry (transient errors) | `max_retries` | 3 | roll back, escalate |
| Recovery (state errors) | `max_recoveries` | 3 | escalate |

Only `maxTurns` is a frontmatter field. The other three are conventions a squad states in the step body, since the graph is acyclic (`workflow_cycle`). The engine keeps its own guards outside the manifest: cost caps (`--max-budget`) and a stuck-loop detector in the harness.

### 14.4 Verdicts

A review step returns `APPROVE` (complete the step), `REJECT` (send back, within the loop budget), `BLOCKED` (cannot review: escalate) or `ESCALATE` (out of scope: human or higher tier).

### 14.5 Recovery cascade

Transient error: retry with backoff. State error: roll back and retry. Contract error: repair prompt and retry. Configuration error: skip or escalate. Fatal: escalate. Each step is bounded. If the same error returns, redesign the squad.

---

## 15. Validation

Validation is the admission gate (§34), in stages. **Stage 1** is the core: manifest, components, workflows, hygiene and quality; the v4 list of core checks is now the criteria catalog of §34. **Stage 1.5** (§15bis) validates capability entries. **Stage 2** is the target adapter's own validators, when it declares any. A blocking failure stops the squad. The load-bearing core checks: `squad.yaml` parses (`manifest_parse`), name, version and protocol are valid (`manifest_schema`), every declared component exists (`components_missing`), every step's agent and task resolve (`workflow_ref_unresolved`), the step graph is acyclic (`workflow_cycle`), and every agent has `name`, `description` and `maxTurns`. Everything else in §34 marked as a warning is advice and does not block. Commands are in §34.

### 15bis. Capability validation (Stage 1.5)

Runs when the squad declares `capabilities`. `CapabilitySchema` is authoritative, with a structural pre-check in `skills/squads/lib/capability-validator.js`. The rules are those of §22.9, plus: `description` is 20 to 1,500 characters, `domains` has 1 to 5 snake_case entries (one outside the catalog warns unless `experimental_domains: true`), `fidelity.status` is a known value and `score_boost` is between 0 and 2.

---

## 16. Security and outputs

### 16.1 Trust boundaries

L0, the runtime (harness and adapter), is trusted. L1, a squad that passed the gate, is verified. L2, data (user input, API responses, web content), is untrusted. L3, squad output, is audited before anyone acts on it.

### 16.2 Capability declaration and sandboxing (retired)

The v4 `capabilities: {required, forbidden}` block collided with the v5 `capabilities[]` list, and the v4 `execution:` block is not read. Tool grants are declared per agent (`tools:`, §10) and per capability (`tools_required`). Sandboxing is a runtime feature: a squad that needs it lists `sandboxing` in `features_required`, and the load fails on a runtime without it.

### 16.3 Secrets

A secret never appears in a manifest, agent, task, workflow, handoff artifact or log. It is referenced by name in `dependencies.yaml` (`env_vars:`) and resolved by the host at run time.

### 16.4 Audit trail

Every run is recorded in the harness audit log. An agent records a milestone with:

```bash
nrv audit emit <event> --squad=<slug> --trace=<trace_id> --json='{"short":"summary"}'
```

An event name is in the engine's closed enum or carries the `x_` prefix, and an `x_` event names the squad emitting it. The gate checks both as the squad's files express them (`audit_event_unprefixed`, `audit_event_unattributed`, both baselineable). Keep payloads short: never the whole brief, a full output or a secret.

### 16bis. Output artifact convention

The engine decides where output goes, and a manifest `output:` block is silently ignored. A squad dispatched by the orchestrator receives its output directory in the prompt. A squad run standalone resolves `{project-root}/.squads-outputs/{squad-name}/{YYYY-MM-DDTHHMMSS}-{slug}/` through `skills/squads/lib/output-resolver.js`, which writes `.squads-outputs/README.md` on first use and never edits `.gitignore`. The project root is `$NIRVANA_PROJECT_ROOT`, then `$SQUADS_PROJECT_ROOT`, then the nearest declared project, then the engine's store. Run output never lives inside the squad (§5.4).

---

## 17. Versioning

**Protocol.** SemVer: a new optional field is a minor bump, a breaking schema change is major, a clarification is a patch. The current version is 6.1.2.

**Squad.** Its own semver: a breaking change to output schema is major, a new agent, task or workflow is minor, a prompt improvement or workflow fix is patch.

**Adapter.** Its own semver. A squad declares `protocol: "6.0"` and its own `version`; the `protocol` field also drives gate severity (§34).

---

## 18. Runtime compatibility

### 18.1 `runtime_requirements`

```yaml
runtime_requirements:
  policy: active                   # active (default) | declared
  minimum:    [{ runtime: claude-code, version: ">=2.0.0" }]
  compatible: [{ runtime: codex }]
  incompatible: [{ runtime: gemini-cli, reason: "needs the Agent tool" }]
```

Under `declared`, `minimum` is required and the run is restricted to `minimum` plus `compatible`. Under `active`, the host runtime is used without allowlist membership, and `features_required` must be provable by a registered adapter or an explicit runtime bridge. `incompatible` denies under both. The fixer for a missing policy never pins `minimum: claude-code`.

### 18.2 Features and degradation

`features_required` and `features_optional` name what a squad needs or prefers (App-B). A runtime lacking a required feature fails the load; one lacking an optional feature degrades, and the harness logs it. Documented fallbacks: no `subagent_spawning` runs sequentially, no `hooks` skips pre and post behavior (the squad is responsible), no `project_memory` falls back to session-scope memory, and no `sandboxing` refuses to load a squad that requires it. Each adapter's section 2 and `skills/_shared/adapters/README.md` hold the feature matrix per runtime.

### 18.5 Adapter contract

An adapter is `skills/_shared/adapters/{runtime_id}.md` with fifteen sections: 1 metadata, 2 feature support matrix, 3 concept mapping, 4 frontmatter mapping, 5 tool whitelist mechanics, 6 max-turns mechanics, 7 subagent spawning, 8 memory storage, 9 context window and compaction, 10 hook system, 11 invocation examples, 12 runtime-specific validators, 13 known limitations, 14 source references, 15 version history. Sections 1, 2, 3, 6, 11 and 13 are the required minimum. Under the active policy a runtime without an adapter file can still be used through the runtime catalog and bridge. To write one, start from `skills/squads/adapters/_template-adapter.md` and `skills/squads/references/11-adapters-guide.md`.

---

## 19. Pattern maturity

**Functional.** Router and handoff (a lightweight classifier picks the specialist). Sequential pipeline (fixed order, with handoff artifacts instead of full histories). Fan-out and fan-in (independent steps in parallel, merged by an aggregator, degrading to sequential).

**Problematic, use with bounds.** Hierarchical manager and workers: fragile and expensive, so use it only when decomposition needs dynamic reasoning, and bound re-planning depth to 3. Group chat or full mesh: degenerates without a finite-state script.

**Aspirational, do not rely on.** Adaptive agent selection by problem complexity. Squad-of-squads as a black-box subroutine (`requires` declares the dependency, §31, but execution is not composed). Resumable human-in-the-loop suspension, which needs a durable workflow engine.

---

## 20. Proposals

Retired. What v4 proposed is now harness behavior, not manifest fields: a stuck-loop detector (`skills/_shared/lib/loop-guard.js`) and cost caps (`--max-budget`, `skills/harness/lib/budget.js`). A manifest `budgets:` block is accepted and ignored. Live progress is the audit log (§16.4). Cross-agent memory is the run directory (§11).

---

## 21. Legacy support

The engine reads `protocol: "4.0"`, `"4.1"` and `"5.0"` manifests for as long as such squads stay installed.

- A squad without `capabilities[]` loads and is listable. The registry synthesizes virtual capabilities from its workflows (`v4-capability-inferrer.js`) so intent routing can find it, and a dispatch with no declared capability runs it as `squad.execute` (§32.2).
- Gate severity depends on the declared protocol (§34), and `protocol_below_6` advises migration.
- Both workflow encodings, `.md` and `.yaml`/`.yml`, are read forever (§28.4).
- `nrv migrate <slug> --to 6` converts to v6 (§35). `skills/squads/lib/migrate-v4-to-v5.js` remains for the single hop from v4 to v5.
- Formats older than 4.0 (the v2 layouts, v3.1) are only detected for listing (`discovery.js`). There is no conversion shim: author the squad again against §5 to §8.

---

## 22. Capability manifest

### 22.1 Why it exists

The unit of discovery is the capability, not the squad. A squad's value often sits in one task while its description is generic, and a discoverer searches verb-object pairs ("transcribe video") while the squad name is a noun. A capability is atomic, named and hierarchically namespaced. The squad is the implementation container.

### 22.2 Where it lives

`capabilities:` in `squad.yaml`, mandatory under `protocol` 5.0 and 6.0. A squad without any is invisible to intent routing (`capabilities_missing`).

```yaml
capabilities:
  - id: media.video.analyze
    description: "Analyzes a video file (mp4, mov, webm) with a multimodal model and returns transcript, on-screen text, key frames and hook analysis as structured JSON."
    domains: [media, content, social_media]
    inputs:  [{ name: video_file, type: file, formats: [mp4, mov, webm] }]
    outputs: [{ name: analysis, type: json, schema: schemas/video-analysis.json }]
    invoke: { type: workflow, ref: workflows/analyze-video }
    examples: ["transcribe an Instagram video", "transcrever vídeo do Instagram"]
    produces: [video-analysis]
    keywords: ["video analysis", "análise de vídeo", "analise de video"]
    example_briefs:
      - "analyze this reel and tell me why the hook works"
      - "preciso transcrever e analisar os criativos em vídeo da campanha"
      - "quero entender o gancho dos primeiros três segundos do vídeo"
    not_for: ["lecture slides", "audio only"]
    acceptance:
      - { id: transcript_present, description: "the analysis has a timestamped transcript", blocking: true }
    fidelity: { status: experimental, threshold: 0.85 }
```

### 22.3 Required fields

Enforced by `CapabilitySchema` (`.strict()`):

| Field | Rule |
|---|---|
| `id` | dotted, three or more segments, `^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){2,}$`; namespaces from App-C; unique within the squad |
| `description` | 20 to 1,500 characters (`LIMITS.capability_description_max`); canonical English, concrete, front-loaded, never truncated |
| `domains` | 1 to 5 snake_case entries from the catalog; others need `experimental_domains: true` |
| `invoke` | §22.5 |
| `examples` | at least one, each 5 characters or more: natural intents that must resolve here |

### 22.4 Optional fields

| Field | Rule |
|---|---|
| `inputs[]` | `name` (snake_case), `type` (`file`, `string`, `json`, `array`, `number`, `boolean`, `url`), `formats[]`, `schema`, `required` (default `true`), `description` |
| `outputs[]` | `name` (snake_case), `type` (`file`, `string`, `json`, `array`, `markdown`, `html`, `binary`), `format`, `schema`, `description`. The singular `output:` is rejected (`capability_outputs_shape`) |
| `tools_required[]` | semantic tool names (§10.7) |
| `produces[]` | artifact-type slugs, kebab-case, 3 to 80 characters, 1 to 40 entries. One slug per artifact type; synonyms go in `keywords` |
| `keywords[]` | 2 to 60 characters each, at most 60 entries |
| `example_briefs[]` | 20 to 1,000 characters each, at most 20 |
| `not_for[]` | 5 characters or more in the schema; at most 25 under the 6.0 gate (§33) |
| `fidelity` | §22.6 |
| `score_boost` | 0 to 2, default 1; multiplies the discovery score |
| `model_hint` | `haiku`, `sonnet`, `opus`, `fable` or `inherit` (default) |
| `estimated_cost_usd` | optional estimate for budget pre-flight |
| `parallel_safe` | boolean, default `false`; read by the multi-target planner |
| `writes_paths[]` | paths the capability writes; read by the race detector |
| `contributions[]` | behavior overlay, at most 8: `into` (`employee`, `squad`, `mind_clone`, `synthesizer`), `at` (`plan:pre`, `execute:pre`, `execute:post`, `verify:pre`), `fragment` (exactly one of `path` or `inline`, inline at most 4,000 characters), `when`, `produces`, `consumes`. Absent means no overlay |
| `acceptance[]` | §29 |
| `evaluator` | §30 |
| `requires[]`, `consumes[]` | §31 |

The routing fields (`produces`, `keywords`, `example_briefs`, `not_for`) have their own contract in `skills/_shared/ROUTING_METADATA_CONTRACT.md`. In short: at least three `example_briefs`, at least one in English and one in Portuguese, phrased as a real user would, in conjugated and infinitive verb forms, never containing the squad's own slug; `keywords` ship each concept as an English, Portuguese and unaccented group; `not_for` follows §33. The gate reports gaps as `routing_metadata_incomplete`, and creation is not finished until the self-retrieval gate (`bun skills/_shared/scripts/self-retrieval-gate.ts <slug>`) passes.

### 22.5 Invoke contract

```yaml
invoke: { type: workflow, ref: workflows/full-funnel }                    # most common
invoke: { type: task, ref: tasks/craft-offer, agent: agents/hormozi }     # one task, one agent
invoke: { type: agent, ref: agents/orchestrator, prompt_template: "Address: ${input.intent}" }
```

`inputs_mapping` maps capability inputs to the target's inputs. A workflow ref names the workflow, not its encoding (§28.6). A task or agent ref resolves as the literal path, with `.md`, or under `tasks/` or `agents/`. A ref that resolves to nothing is `invoke_ref_unresolved` (error).

### 22.6 Fidelity

```yaml
fidelity:
  ground_truth_dir: evals/media.video.analyze/ground-truth/
  eval_results: evals/media.video.analyze/eval-results.json
  status: validated        # validated | experimental | drifted | retired
  last_eval: "2026-09-01T12:00:00Z"
  judge_model: claude-opus-4-7
  threshold: 0.85          # 0 to 1, default 0.85
```

`status` defaults to `experimental`. Together with `score_boost` it scales the discovery score, and evaluator selection excludes `retired` (§30.3). A `validated` status with neither `ground_truth_dir` nor `eval_results` on disk is `fidelity_validated_unproven` (warning), so never declare it without evidence. A ground-truth directory holds `case-NNN.input.json` and `case-NNN.expected.json` pairs (10 to 20 recommended) and an `eval-results.json` with `evaluated_at`, `judge_model`, `overall_score`, `threshold`, `status` and `per_case`.

### 22.7 Capability, workflow, task

A capability is what the squad promises, by name, and is discoverable. A workflow is how it is realized, a multi-step graph. A task is the smallest internal unit of work. A capability may map to one task or to a workflow; the id is the contract and the implementation is hidden.

### 22.8 Lifecycle

`PROPOSED` (declared, not yet in the catalog), `EXPERIMENTAL` (discoverable, no ground truth), `VALIDATED` (evidence at or above threshold), then `DRIFTED` (last eval below threshold) or `RETIRED` (superseded).

### 22.9 Validation rules

1. The id matches the pattern and is unique in the squad.
2. Every domain is in the catalog, or `experimental_domains: true` is set (a warning otherwise).
3. `invoke.ref` resolves.
4. Every `examples` entry is non-empty natural language.
5. A `validated` fidelity is backed by evidence on disk.
6. Every `not_for` entry follows §33. This replaces the v5 rule that asked an entry to name the alternative capability, which §33 forbids.

### 22.10 The index is per capability

`buildMatchDocs` emits one document per capability plus one for the squad, each normalized by its own length. Declaring another capability does not dilute the others. What costs precision is padding one description or stacking a fourth synonym of a concept already covered twice, and that costs only that document. There is no retrieval argument for a small squad, only for sharp capabilities.

### 22.11 Never cut for cost

Cutting for **precision** is legitimate: a redundant keyword, a fourth synonym, a sentence a router cannot match on. Measure it: run the self-retrieval gate before and after, and on the neighbours. If retrieval does not improve, the cut was loss.

Cutting for **cost** is prohibited: removing capabilities, shortening descriptions or dropping example briefs to save tokens. The default router is agentic and reads for meaning, so a more accurate description is strictly better, and `fast` mode is BM25 indexed per capability, so it does not pay for squad size either. Descriptions here were once truncated mid-word at 500 characters, and the fix was a rewrite as complete text. If a corpus does not fit a context budget, tier the digest or split the file; never make the library know less. A reviewer rejects a change justified by token cost and asks for the retrieval measurement.

---

## 23. Registry and indexing

### 23.1 Purpose and location

Discovery reads a pre-computed index instead of walking every `squad.yaml`. The registry is `${SQUADS_REGISTRY_PATH}`, resolved per scope (a project-level `.squads-registry.json`, otherwise under the engine home). It is a cache and never the source of truth, which is the `squad.yaml` files.

### 23.2 Shape

```json
{
  "schema_version": "1.0.0",
  "squads": { "<slug>": { "version": "…", "protocol": "6.0", "manifest_path": "…", "manifest_hash": "sha256:…", "domains": [], "capabilities": ["…"] } },
  "capabilities": { "<capability id>": [ { "squad": "<slug>", "description": "…", "domains": [], "examples": [], "not_for": [], "fidelity_status": "experimental", "invoke": {}, "score_boost": 1.0 } ] },
  "domains": { "<domain>": ["<slug>"] }
}
```

A capability entry carries those keys always, and the others only when declared: `produces`, `example_briefs`, `keywords`, `body_text` (the BM25 corpus), `estimated_cost_usd`, `parallel_safe`, `writes_paths`, `model_hint`, `tools_required`, `inputs`, `outputs`, `contributions`, the whole `fidelity` block and the v6 fields `acceptance`, `evaluator`, `requires`, `consumes`. The schema is `core-schemas.json#/registry_squads`.

### 23.3 Indexing and invalidation

`nrv index` (`skills/squads/scripts/index-squads.ts`, `lib/registry.js rebuild`) walks `${SQUADS_DIR}`, `${SQUADS_LEGACY_DIR}` when set, and `./squads` (depth at most 2), parses and hashes each manifest, builds the capability and domain inverted indexes and writes the registry atomically. On a name collision `./squads` beats `${SQUADS_DIR}`, which beats `${SQUADS_LEGACY_DIR}`. The rebuild is full. The per-squad `manifest_hash` detects edits, so re-run `nrv index` after changing a manifest. A runtime with post-edit hooks can run it automatically; the syntax is adapter-specific (adapter section 10).

---

## 24. Discovery

### 24.1 Routing mode

The `routing.mode` setting picks the matcher. `agentic` (default): an agent inspects the registries and reasons about the best target. `cards`: one tool-less call over compiled one-line cards. `fast`: deterministic BM25 over the registry indexes, with no LLM call. Every mode sees the same input: the routing metadata a squad declares (§22.4). An entity with poor metadata does not exist for any of them.

### 24.2 The BM25 matcher

BM25 is `fast` mode and the fallback. It indexes per capability (§22.10): `description`, `examples`, `keywords` (weight ×3), `example_briefs` (×2), `produces` and the workflow's `body_text`. `not_for` is not indexed: it is a penalty applied after retrieval (§33). `score_boost` and `fidelity.status` scale the score, and a domain outside the catalog costs a penalty. An optional dense retrieval (`routing.dense: fallback`, set by `nrv embeddings enable`) is consulted only when BM25 yields no match, and it can return only an ambiguous suggestion, never dispatch.

### 24.3 Three signals

| Signal | Condition (defaults in `skills/harness/config.yaml`) | Action |
|---|---|---|
| `MATCH_HIGH` | top score ≥ 0.80 and lead over second ≥ 0.15 | may auto-run |
| `MATCH_AMBIGUOUS` | two or more candidates ≥ 0.60 within 0.15 of the top | present the candidates |
| `NO_MATCH` | best score < 0.60 | dispatch no squad |

The thresholds are `match_high_threshold`, `match_high_lead`, `match_ambiguous_threshold` and `match_ambiguous_window`.

### 24.4 Fail loud

A matcher emits a typed signal and never silently picks the best of bad options. A brief that a capability's `not_for` matches is penalized (×0.4), so it falls out of `MATCH_HIGH` instead of being routed to a squad that said it does not do that.

### 24.5 CLI

```bash
nrv find "transcrever vídeo do Instagram"      # dry-run discovery: signal, capability, squad, score
nrv index                                      # rebuild the registry
nrv list-squads                                # what is installed
```

---

## 25. Three-signal routing

- **`MATCH_HIGH`** may run without confirmation.
- **`MATCH_AMBIGUOUS`** goes to the user, or to the agentic router with the registries open, with each candidate's id, squad and score.
- **`NO_MATCH`** dispatches no squad. The orchestrator falls back to the generalist, or offers to scaffold a new capability.
- **Override.** Naming the squad skips the router: `nrv dispatch --squad <slug>[:<capabilityId>]`, or a Glance message beginning `use squad <slug>[:<cap>]:`. The caller is in command (§32.2).

---

## 26. Telemetry

Retired as a normative spec. The OpenTelemetry span and metric conventions and the `instrumentation.trace_attributes_*` fields of v5 are not read by the engine. The `instrumentation:` block is accepted and carried. What the engine records is the audit log (§16.4), the run ledger and cost accounting in the harness (`skills/harness/references/02-budget.md`, `03-audit.md`).

---

## 27. Output humanization (P11)

Human-facing output leaves the squad without the tells of generated text. The mechanism is the **writing contract** in the runtime memory file (`CLAUDE.md`, `AGENTS.md` or `GEMINI.md`), which enters the context of every dispatched agent, so prose is written right from the first token. It is not a post-processing step, a capability field (the schema rejects `humanize`), an adapter pass or a skill. Prevention costs nothing per dispatch because the contract sits in the stable cached prefix, and a business that runs a squad applies the same contract.

---

## 28. The workflow document

### 28.1 Canonical form

A workflow is one file, `workflows/<stem>.md`. The frontmatter is the graph and the body is prose.

```markdown
---
name: main-pipeline
description: "Plans the artifact, then builds it"
version: "1.0.0"
steps:
  - id: plan
    agent: orchestrator
    task: plan
    creates: [outline]
  - id: build
    agent: specialist
    task: execute
    requires: [plan]
    creates: [deliverable]
    on_failure: abort
success_indicators:
  - "the deliverable exists at the declared path"
  - "every outline section is covered"
---

## plan

What this step reads, what it decides and what it hands to the next.

## build

What this step assembles from the previous one, and what "done" means here.
```

`WorkflowSchema` (`.strict()`) validates the graph:

| Field | Rule |
|---|---|
| `name` | equals the file stem, lowercase, `^[a-z][a-z0-9_-]*$` |
| `description`, `version` | optional strings |
| `steps[]` | at least one |
| `steps[].id` | `^[a-z][a-z0-9_-]*$`, unique in the workflow |
| `steps[].agent` | required; names `agents/<agent>.md` |
| `steps[].task` | optional; always a reference to `tasks/<task>.md`, never prose |
| `steps[].requires[]` | ids of steps in this workflow; default `[]` |
| `steps[].creates[]` | artifact names; default `[]` |
| `steps[].on_failure` | `abort`, `retry`, `escalate` or `continue` |
| `steps[].parallel_safe` | boolean |
| `steps[].meta{}` | legacy step keys kept verbatim (`validation`, `inputs`, `phase`, `gates`, …); default `{}` |
| `success_indicators[]` | optional; §29 turns them into acceptance |
| `on_failure` | same enum, workflow level |
| `extensions{}` | legacy top-level keys kept verbatim (`harness`, `retry_policy`, `triggers`, `config`, …); default `{}` |

`meta` and `extensions` exist so nothing is discarded: a key v6 does not know survives any number of round trips through the reader. The template is `templates/workflow.md.tmpl`.

### 28.2 The body

The body is split per step under `## <step.id>`. A heading that matches no id is not an error, because the body is for the model, which reads the whole file. A step's prose belongs under its id so a reader of the graph knows where to look.

The ceiling is `LIMITS.workflow_body_words_max`, currently **2,500 words** (`skills/_shared/validators/limits.ts`, configurable from 200 to 20,000). Exceeding it is a warning under any protocol, because it is a fact about authoring. A long method that serves one step belongs in `tasks/<task>.md`.

### 28.3 Lint

`lintWorkflow` in `skills/squads/lib/workflow-reader.ts` runs inside the gate. Each rule has an id, and the id is part of the contract.

| Id | Finding | Under `6.0` | Under `5.0` | Fixer |
|---|---|---|---|---|
| `workflow_parse` | not a valid YAML mapping | error | error | none |
| `workflow_inline_prose` | a step carries its prompt in `task: \|` or `action:` | error | warning | `workflow_inline_prose_to_body` |
| `workflow_ref_unresolved` | a step's `agent` or `task` is not on disk | error | warning | `workflow_refs_repair` |
| `workflow_twin` | one stem in two encodings (§28.5) | error | warning | `twin_merge` |
| `workflow_step_id_duplicate` | two steps share an `id` | error | warning | none |
| `workflow_dangling_requires` | a `requires` names no step | error | warning | none |
| `workflow_requires_by_output` | a dependency names another step's output, not its id | error | warning | `requires_by_output_name` |
| `workflow_cycle` | the step graph has a cycle | error | warning | none |
| `workflow_shape_legacy` | the graph is in a legacy dialect (§28.4) | error | warning | `workflow_normalize_shape` |
| `workflow_stem_case` | the stem is not `^[a-z][a-z0-9_-]*$` | error | warning | none |
| `workflow_event_router` | the document is an `event_routes` router | info | info | none |
| `workflow_body_too_long` | the body passed the ceiling | warning | warning | none |
| `workflow_orphan` | no capability invokes this workflow | warning | warning | none |

A long body and an orphan workflow are advice under any protocol. `workflow_event_router` is not even advice: an `event_routes` document declares independent routes (channel, condition, priority, own chain), so no order between them exists to derive, and an empty step list is the correct reading of a correct file. It stays in the report as `info`, which counts toward neither the verdict nor the passed criteria, so the empty graph is explained.

Fixers never invent: they rename, move and reformat what is already there. The one exception is `components_files_stub` (§34), which predates the gate. A reference that resolves to nothing stays a finding, because writing the missing task would be fabricating the squad's method.

### 28.4 Legacy dialects and dual reading

`normalizeWorkflow()` is the single implementation of this table. Each match emits `legacy-dialect:<tag>`, which the lint reports and `nrv migrate` prints.

| Legacy form | Normalizes to | Tag |
|---|---|---|
| `steps[]` with `depends_on`, `deps` or `after` | `requires`, their union | `steps_depends_on` |
| `workflow:` header plus `sequence[]` | header to the top; `task: "x.md"` becomes `x` | `workflow_sequence` |
| `agent_sequence[]`, bare `sequence[]` | one chained step per entry | `agent_sequence`, `sequence` |
| `flow.steps`, `pipeline.steps` | `steps[]` (`flow.type` goes to `extensions.flow_type`) | `flow_steps`, `pipeline_steps` |
| `flow.phases[]`, `phases[]`, `stages[]`, `phases[].agents[]` | flattened; a phase requires the last ids of the previous one when nothing is explicit; the phase goes to `meta.phase` | `flow_phases`, `phases`, `stages` |
| `workflow: {agents: [...]}` | one step per agent; `command` goes to `extensions.command` | `workflow_agents` |
| `depends_on` naming another step's `output:` | the step that creates it, when unique | `requires_by_output` |
| a step with no agent and no task (`type: approval`, `human-gate`) | a gate on the edge, not a node: dependents inherit what it waited on and carry it in `meta.gate_before[]`; a gate nobody depends on goes to `extensions.trailing_gates[]` | `gate_steps` |
| `{type: parallel, id: x, steps: [...]}` in `sequence[]` | one layer: children get `meta.group = x`, require the step before the group, and the next step requires them all | `nested_group` |
| `event_routes` with `agent_chain[]` in every route | a forest: a chain of `<route>-<agent>` steps per route, `meta.route` on all, the trigger in `meta.event` of the first | `event_routes_chained` |
| `event_routes` with a route lacking `agent_chain` | does not normalize: a router, no order derivable; `nrv migrate` refuses | `event_routes` |
| `workflow_name`, `success_criteria`, `on_fail`, `output` | `name`, `success_indicators`, `on_failure`, `creates` | `workflow_name`, `success_criteria`, `on_fail` |

Step aliases: `step_id`, `step` and `name` map to `id`; `owner` and `role` to `agent`; `outputs` and `output` to `creates`; `deps`, `after` and `depends_on` to `requires`.

**Dual reading is permanent.** The engine reads `.yaml` and `.yml` forever, because authored squads will never all be migrated. What v6 changes is severity: under `protocol: "6.0"` a legacy dialect is an error. When two files compete for a stem the order is `.md`, `.yaml`, `.yml`.

### 28.5 The twin rule

`x.md` and `x.yaml` in the same `workflows/` is an error under 6.0: one stem, one graph, one file. The `twin_merge` fixer acts only when it is a merge and not a choice, that is, when the `.yaml` normalizes to a graph and the `.md` carries none. The Markdown keeps its prose, the YAML's graph becomes its frontmatter and the YAML is removed. Any other twin is left to a human.

### 28.6 References without extension

A capability names the workflow, not its encoding:

```yaml
invoke: { type: workflow, ref: workflows/main-pipeline }   # not main-pipeline.md
components: { workflows: [main-pipeline] }                  # same
```

`resolveWorkflowRef()` accepts a ref with or without extension: the literal, then `.md`, `.yaml`, `.yml`, first as a path and then under `workflows/`. A ref with an extension works but binds the capability to a file instead of a workflow, so changing the encoding means editing the manifest. Two precision notes:

1. `invoke_ref_extension` fires only on `invoke.ref`, only under 6.0, and only when the ref resolves. A `components.workflows` entry with `.md` raises nothing.
2. The `invoke_ref_extension` fixer normalizes both surfaces, so `components.workflows: [main-pipeline.md]` is rewritten on the first `--fix`. The template writes both without extension, the only form that is a fixed point of `--fix`.

---

## 29. Acceptance contract

### 29.1 What it is

`capabilities[].acceptance[]` declares what the judge charges for a run of this capability. Without it, the list lives in the author's head or in `success_indicators`, which nothing else reads.

```yaml
acceptance:
  - id: outline_covered
    description: "every outline section appears in the deliverable"
    blocking: true
    minimumScore: 0.85
  - id: report_file
    description: "the report file exists and is not a stub"
    path: report.md
    min_bytes: 400
```

Schema (`CapabilitySchema.acceptance`, `.strict()`, **at most 12 entries**):

| Field | Rule |
|---|---|
| `id` | `^[a-z][a-z0-9_-]*$`, unique within the squad |
| `description` | non-empty; the sentence the judge reads |
| `blocking` | boolean, optional |
| `minimumScore` | number from 0 to 1, optional |
| `path` | optional: a file the criterion promises, relative to the output directory |
| `min_bytes` | optional: integer ≥ 0, the size below which the promised file is a stub |

### 29.2 Why 12

Each requirement becomes a sequential gauntlet, a line in the judge's brief and a required dimension in the scorecard. `validateScorecardFile` demands exactly N dimensions for N requirements, so a missing one makes the scorecard `indeterminate` and holds the deliverable. Twelve, `brief-conformance` included, is the ceiling at which judging still fits a run's budget.

### 29.3 Fallback order

`requirementsFor` in `skills/harness/lib/gauntlet/success-requirements.ts` resolves the judge's contract. `brief-conformance` always comes first, and the first rung below it that answers wins:

| Rung | Source | Blocks |
|---|---|---|
| `acceptance` | `capabilities[].acceptance[]` | yes, unless `blocking: false` |
| `success_indicators` | the invoked workflow's `success_indicators[]`, read by the v6 reader | no |
| `task_acceptance_criteria` | `## Acceptance Criteria` of the invoked task | no |
| `brief-conformance` | nothing declared | yes |

Derived ids are namespaced (`acceptance.<id>`, `indicator.<n>`, `criterion.<n>`) so no capability can shadow the brief. A `minimumScore` with no value falls back to the capability's `fidelity.threshold`, then to the intensity profile's score. The last two rungs do not block: an indicator written as prose was never promised as a gate.

**Switch.** `gauntlet.requirements_source` is `brief` (default) or `capability`. By default the contract is the single `brief-conformance` and the compiled plan is bit-for-bit the earlier one. Under `capability` the contract is this section's, and the audit event `x_gauntlet_requirements_resolved` says which rung answered.

---

## 30. Evaluator contract

### 30.1 What it is

A squad that offers the capability `quality.specification_conformance` is an evaluator: the harness may choose it to judge another squad's work. The block says what it judges with.

```yaml
- id: quality.specification_conformance
  evaluator:
    scorecard: scorecards/spec-conformance.json
    rubric: rubrics/spec-conformance.md
    dimensions: [completeness, fidelity, format]
    max_cost_usd: 0.40
```

Schema (`.strict()`): `scorecard` (required string), `rubric` (required string), `dimensions[]` (optional), `max_cost_usd` (number ≥ 0, optional).

### 30.2 When it is charged

`evaluator_missing` fires for the capability `quality.specification_conformance` that declares no block. It is an error under 6.0 and a warning under 5.0. The repair is agentic, because only the author knows the scorecard.

### 30.3 Selection order

Among installed evaluators independent of the producer (`rankConformanceEvaluators`): `fidelity.status` `validated` before `experimental` before `drifted`, `retired` out; ties break by ascending `max_cost_usd` (a capability with no `evaluator` block declares no cost and ranks behind any that does), then by slug. A library with no v6 metadata has only the last key and keeps the alphabetical answer.

`max_cost_usd` also caps the budget passed to the evaluator: the subprocess `--max-budget` is `min(run slice, max_cost_usd)`, so the declared ceiling limits spend and never raises it. `nrv doctor` prints why the winner won. The `NIRVANA_GAUNTLET_EVALUATOR` override, `squad:<slug>[:<cap>]`, sits above all of this, honored or refused, never reinterpreted.

---

## 31. Composition

### 31.1 `requires[]` and `consumes[]`

`requires[]` lists capability ids this one depends on, optionally qualified by the providing squad:

```yaml
requires:
  - research.market.scan                 # this squad
  - brandcraft:branding.voice.define     # another squad
```

Pattern `^(?:[a-z][a-z0-9-]{1,63}:)?[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){2,}$`, at most 8 entries. `consumes[]` lists slugs of `produces` this capability takes as input: strings of 3 to 80 characters, at most 20.

### 31.2 What the gate charges

`requires_no_provider` (warning): an unprefixed `requires` entry must match a capability of this squad; a prefixed one must match a capability declared in the sibling squad's `squad.yaml` in the same parent directory. A `consumes` entry must match some `produces` of this squad.

### 31.3 The graph

`readSquadComposition()` in `skills/_shared/lib/entity-graph.ts` reads each installed squad's `squad.yaml` and turns the lists into edges. A `requires` resolves to the squad that declares that capability id and becomes `depends_on` consumer to provider; a `consumes` resolves by `produces` and becomes `feeds` provider to consumer. `dependencyPair()` inverts the drawn direction of `depends_on`, so the provider exists first, and `nrv graph order` and installation order read the composition with no second rule.

An edge exists only with an unambiguous provider. Repeating a capability id is by design (many squads carry `media.video.compose` and the router picks by brief), so two providers yield no edge and one report line, and a `slug:` prefix names the provider and settles it. A reference the squad satisfies itself is neither an edge nor a finding. `nrv graph check` reports `x_requires_unresolved` (nothing provides it; fails under `--strict`), `x_requires_ambiguous`, `x_consumes_unresolved` and `x_consumes_ambiguous` (all reported only).

### 31.4 The limit

In a plan, composition is stitching, not yet behavior. `compileManifest()` in `skills/harness/lib/plan-compiler.ts` accepts the derived graph as `opts.composition`, and `inheritedCompositionEdges()` would inherit the order between two `squad` nodes the author did not order (the author always wins, and nothing is inherited for a squad the plan does not name). No production caller passes the option, so compilation is the unchanged one.

---

## 32. Execution binding

This section separates what v6 promises from what the engine does.

### 32.1 What the engine consumes

`invoke.ref` resolves through `resolveWorkflowRef`, in `.md` and `.yaml`, in the body index (`body-index.js`) and in the capability validator. The workflow text enters the `body_text` BM25 indexes; in a `.md`, frontmatter and body enter together without the delimiters, so the same graph yields the same text in either encoding. `components` feeds the contract surface, which is what a buyer sees change between versions. `produces`, `domains`, `keywords`, `example_briefs` and `not_for` feed the router.

### 32.2 A squad dispatched on its own

`nrv dispatch --squad <slug>[:<capabilityId>]` (`skills/harness/lib/squad-exec.ts`) runs one agent as the squad. `capability-resolver.ts` decides which capability and says which rung answered:

| Rung | When it answers |
|---|---|
| `explicit` | the caller named it: `--squad <slug>:<cap>`, `use squad <slug>:<cap>:` at the head of a Glance message, or a plan node with several targets |
| `single` | the squad declares exactly one capability |
| `bm25` | the squad declares several: scored against the brief over the documents the router indexes, restricted to this squad |
| `legacy` | the squad declares none (a v4 manifest): `squad.execute` |

Every resolution emits `x_capability_resolved` with the rung, how many ids the squad declares and, when BM25 decided, the score (`0` when no brief term matched, so a missing signal shows instead of passing for a hit). An id the caller named and the squad does not declare is dispatched anyway, with a `warning` on the event: the caller is in command.

With a capability resolved, `buildSquadPrompt` assembles these sections:

- `YOUR IDENTITY (squad.yaml)`: the manifest minus routing-only fields (`keywords`, `example_briefs`, `examples`, `not_for`, `domains`, `score_boost`, `fidelity` on the dispatched capability), with every other capability reduced to id and description.
- `YOUR CAPABILITY`: id, description, `produces` and the acceptance criteria under **done when**, each marked blocking and with a minimum score when declared. The agent checks each before it finishes.
- `YOUR WORKFLOW (<file>)`: the step table (`#`, step, agent, task, requires, creates) from the canonical graph, then the Markdown body when the workflow is `.md`, presented as **the author's reference method** (§36): the `requires` dependencies hold and the rest is the executor's call.
- `YOUR AGENTS` and `YOUR TASKS`: every component the workflow references, in step order, each whole and never cut for size. The pair is measured against the target `LIMITS.squad_prompt_components_bytes_max` (65,536 bytes by default), a target and not a quota: past it, the tasks block closes with a note giving the total and the excess, for whoever reviews the workflow.
- `WHAT ELSE THIS SQUAD CARRIES`: every directory beyond `agents/`, `tasks/` and `workflows/`, one level deep, as a map and not as content. The engine grants the squad directory to the dispatch, so the agent opens what it needs when it needs it. Run state (`isRunStatePath`) and build or dependency output (`node_modules/`, `dist/`, `build/`, `__pycache__/`, `.venv/`) are left out. What a step must obey stays inline, since a path is a request and inline text is a fact. This is the one section that does not need a resolved capability.
- `HOW TO REPORT EVENTS`: the `nrv audit emit` command, the `--squad=<slug>` flag and the `x_` rule (§16.4).

**Compatibility.** Without a resolved capability (the legacy `squad.execute`, an unreadable manifest, an id the manifest does not declare) the capability, workflow and event sections do not appear, and the components fall back to the first three agents and tasks in alphabetical order under a `(top 3)` heading. `squad-exec.test.ts` pins that string whole. A capability whose `invoke.ref` names no readable workflow keeps `YOUR CAPABILITY` and says so in one line, and when every agent reference in the workflow dangles the components also stay on the historical collection, so a squad never lacks a persona.

### 32.3 A squad used by a business

A business runs as ONE agent (`skills/harness/lib/business-solo.ts`). It reads the brief the orchestrator wrote, plays its own seats, and uses a squad by reading the squad's work card and working as its agents. It opens no subagent, dispatches no squad and calls no other business.

```bash
nrv cards squad <slug>        # skills/_shared/lib/work-cards.ts
```

The card is compiled per run from frontmatter only, so it is never stale, never cached and needs no model. It holds the squad's version and description, then one line per capability (id, description, the workflow it runs, `produces`, the acceptance ids with `*` for blocking), per agent, per task and per workflow (with its step line `id (agent) → id (agent)`), each ending in the file to open. It closes with the rule: pick the capability, open its workflow or task, work as each step's agent, open nothing else unless a step needs it, and do not dispatch the squad. For authors, the card shows the frontmatter `description` of each agent, task and workflow, clipped (about 200 characters for a capability, 160 for the others, 300 for the squad), so front-load the deliverable and the trigger.

### 32.4 The limit that remains

The graph has no typed executor. The step table is an instruction to the agent reading the prompt or the card, not an input to an engine: nothing verifies that a step started only after what `requires` names, nothing keeps state per step, nothing retries a failed step, and `on_failure` is carried, not enforced. A better workflow changes what the squad reads, what the gate admits, what the router indexes and what migration derives. It does not change who executes.

---

## 33. Short `not_for`

An entry of `not_for` is at most **25 characters**.

The reason is mechanical. The router applies the `not_for` penalty (×0.4) by lowercase substring match up to 25 characters. Above that it demands 60% token overlap between the entry and the brief, which a full sentence almost never reaches. A long fence is a fence that does not fire, the worst of both worlds, because its author believes it protects.

Form: two to four content words, no parentheses and **no id suffix**. This replaces the v5 rule that asked an entry to mention the alternative capability: the `(use X)` suffix pushed the entry past 25 characters and switched the fence off.

```yaml
not_for:
  - "logo design"         # good
  - "identidade visual"   # good, a separate entry per language
  # bad: "logo design and visual identity work (use design-system-nirvana)"
```

`not_for_too_long` is an **error under 6.0** and a warning under 5.0. The ceiling lives in the gate (`NOT_FOR_MAX_CHARS` in `kinds/squad.ts`), not in `CapabilitySchema`, which requires only 5 characters: a manifest with a long fence parses and is not admitted under 6.0. Accented and unaccented spellings are separate entries, because substring matching does not fold accents. The sibling criterion `not_for_dead` (warning, baselineable) flags an entry that fires against none of the squad's own `example_briefs`.

### 33.1 A fence declares incompetence, never neighborhood

A `not_for` entry says **what this squad does not do**. It never says "someone better exists next to it". A squad travels and its neighborhood does not: a fence written to steer around a neighbor is pure loss once the neighbor is absent, yet it ships inside the pack to every install where the neighbor never existed. The symptom is the reciprocal fence, a nutrition squad with `not_for: ["psychologist"]` beside a psychology squad with `not_for: ["nutrition"]`. The nutrition squad can handle the emotional side of an eating disorder as far as nutrition goes, and declared otherwise only because a psychologist sat beside it. Installed alone, it turns away any brief with emotional weight, to nowhere.

The test is one question: **if this squad were the only thing installed, would the sentence stay true?** `"logo design"` on a copywriting squad passes, as does `"surgery"` on a nutrition squad. `"psychologist"` on a nutrition squad fails: that is a neighbor, not a boundary. `"crypto trading"` on an EVM engineering squad passes only if it really does not trade.

The converse holds equally: **never skip building a capability because a neighbor covers it.** A squad is complete for the service it promises, as if nothing sat beside it. The router settles overlap at run time with the neighborhood that machine has, which differs per install and so cannot be frozen into the manifest. The gate cannot charge this alone, since spotting a neighbor means reading the installed library. `not_for_dead` measures whether a fence fires; whether it should exist is the author's judgment.

---

## 34. Admission

```bash
nrv validate squad <slug|path>          # report
nrv validate squad <slug> --fix         # mechanical repairs, backup and rollback
nrv validate squad <slug> --strict      # warnings reject too
nrv validate squad --all --json         # the library, nirvana.verify-batch/v1
```

Exit codes: **0** admitted, **1** an error the baseline does not cover, **2** warnings only, under `--strict`, **64** usage error or unknown entity. A baseline records existing debt for a baselineable finding, which then does not block, and recorded debt may only shrink. `init-squad.ts` runs the same gate (the `create` gate, with mechanical fixes) right after scaffolding from the templates.

### 34.1 The criteria catalog

The catalog lives in `skills/_shared/lib/verify/kinds/squad.ts` and is exactly what this table lists. Severity is the catalog's (the 6.0 target). A rule marked * is a warning under `protocol: "5.0"`.

| Id | Checks | Severity | Fix |
|---|---|---|---|
| `manifest_parse` | `squad.yaml` parses to a mapping | error | none |
| `manifest_schema` | the manifest matches `SquadManifestSchema` | error | none |
| `capabilities_missing` | a 5.0 or 6.0 squad declares a capability | error | none |
| `capability_outputs_shape` | `outputs[]` with the declared keys (no singular `output`, bare strings, `humanize`, `kind`) | error | `outputs_shape_repair` |
| `capability_examples_missing` | every capability has usable `examples[]` | error | `caps_examples_not_for` |
| `not_for_too_long` | every `not_for` entry is at most 25 characters (§33) | error * | agentic |
| `invoke_ref_unresolved` | every `invoke.ref` resolves on disk | error | none |
| `invoke_ref_extension` | a v6 ref names the workflow without extension (§28.6) | error * | `invoke_ref_extension` |
| `components_missing` | every `components.*` entry exists | error | `components_files_stub` |
| the workflow rules | §28.3 | per §28.3 | per §28.3 |
| `surface_missing` | `.nirvana-surface.json` present | error | `surface_regen` |
| `surface_stale` | the surface matches the files | warning | `surface_regen` |
| `outputs_pollution` | no run-output directory in the squad | error | none |
| `audit_event_unprefixed` | an audit event is in the closed enum or carries `x_` | error, baselineable | none |
| `audit_event_unattributed` | an `x_` event names the squad | error, baselineable | none |
| `evaluator_missing` | an evaluator capability declares its `evaluator` block (§30) | error * | agentic |
| `requires_no_provider` | every `requires` and `consumes` has a provider (§31.2) | warning | none |
| `agent_frontmatter_incomplete` | every agent has frontmatter with `maxTurns` and `tools` | warning | `agents_frontmatter_repair` |
| `task_acceptance_missing` | every task has acceptance criteria or `outputs:` | warning | `tasks_acceptance_criteria` |
| `dependencies_missing` | a dependency manifest exists | warning | `dependencies_synth` |
| `readme_missing` | `README.md` exists | warning | `readme_scaffold` |
| `routing_metadata_incomplete` | `keywords`, `example_briefs` (3 or more, English and Portuguese) and `not_for` declared | warning, baselineable | agentic |
| `not_for_dead` | every `not_for` entry can fire against a real brief | warning, baselineable | none |
| `produces_untyped` | `produces` reaches a rubric, or the capability types its outputs | warning | none |
| `fidelity_validated_unproven` | a `validated` status has evidence on disk | warning | none |
| `portability` | no machine-local path leaks out | warning | none |
| `distribution_artifacts` | no per-buyer artifact in the source | warning | none |
| `protocol_below_6` | the protocol is 6.0 | warning | none |

### 34.2 `--fix`

`--fix` runs in a fixed order (structure, manifest, files, surface), because a fixer that rewrites the manifest after the surface was frozen would leave the entity reporting `surface_stale`. It takes a backup first, runs, checks again and **rolls back** when a fixer threw, when the manifest stopped parsing, or when a **new** error appeared. A second `--fix` is a no-op by construction, since each fixer writes only when something differs. The fixers are the ones named in the Fix column above; `twin_merge`, `workflow_inline_prose_to_body`, `workflow_refs_repair`, `requires_by_output_name` and `workflow_normalize_shape` are in §28.3.

---

## 35. Migration

```bash
nrv migrate <slug|path> --to 6              # dry run: writes nothing
nrv migrate <slug|path> --to 6 --apply      # converts
nrv migrate squad --all --to 6              # the whole library, dry run
nrv migrate <slug|path> --rollback <ts>     # undo
```

**Dry run is the default.** Without `--apply` nothing is written: not the squad, not the backup, not the report.

### 35.1 What the conversion does

Per workflow: `normalizeWorkflow` maps the legacy dialect onto the canonical graph (§28.4). Prose that lived in `task: |` or `action:` leaves the graph: a step with a real prompt (≥40 words and no task reference) becomes `tasks/<workflow>-<step>.md` and the step gets `task: <workflow>-<step>`, while a short note stays in the body under `## <step.id>`. The canonical document is written to `workflows/<stem>.md`, and the `.yaml` is deleted only after the `.md` is re-read and matches `WorkflowSchema`. A twin (§28.5) becomes one file, the YAML's graph with the Markdown's body. An authored `name` that differs from the stem is relocated to `extensions.title`, not discarded.

In the manifest: `protocol: "6.0"`; `invoke.ref` and `components.workflows` without extension (§28.6); extracted tasks join `components.tasks`; and `acceptance[]` is derived from the invoked workflow's `success_indicators` with `blocking: false`. That last step turns the author's checklist into the judge's, the one thing the conversion does that changes what a run is charged to deliver.

### 35.2 What it never does

**It never invents prose.** Every word of a migrated body existed in the source: comments, `description`, `success_indicators`, `validation`, `task: |` blocks. The only text the migration writes is the scaffold of an extracted task (its frontmatter and an `## Acceptance Criteria` header with a TODO). Dangling references are reported, not fabricated.

It refuses an `event_routes` document (a router, not a DAG: no step order can be derived), an empty graph and a stem outside `^[a-z][a-z0-9_-]*$` (rename the file first). Without `--force` the whole squad is refused and **nothing** is written; with `--force` that document stays untouched in its `.yaml` and the rest of the squad migrates.

### 35.3 Safety

- **Backup** in `~/squads-legacy-v5/<slug>.<ts>/`, copied with `fs.cpSync`, never `rsync` (the CI matrix runs on Windows). Run state (`RUN_STATE_EXCLUDES`) is left out.
- **Report** JSON at `<state>/squads/<slug>/migrate-<ts>.json`, schema `nirvana.squad-migrate/v1`, never inside the squad, since it would ship in every pack built from it. Per file it records `{from, to, dialect_detected, steps_before, steps_after, unresolved_refs, inline_prompts_extracted, prose_words_moved}`; at the top, the backup, rewritten refs, created tasks, derived acceptance, tree digests before and after, `diffSurfaces(backup, migrated)` and the gate verdict.
- **`--rollback <ts>`** restores the backup and **refuses** when the squad changed after the migration (the report's tree digest is compared with today's), unless `--force`.
- **Idempotence** is decided in bytes: a second pass is a no-op exactly when every file the migration would write already holds what it would write.
- At the end of `--apply` the migration runs the gate (§34) and prints the verdict.

### 35.4 Flags

| Flag | Effect |
|---|---|
| `--to 6` | required; the only target protocol |
| `--apply` | writes; without it, dry run |
| `--all` | the whole library (or what sits under `--root`) |
| `--root <dir>` | the library root to walk |
| `--map-refs` | renames an `agent` or `task` ref when exactly one component matches by case or by `_` versus `-` |
| `--no-extract-tasks` | keeps every prompt inline in the body, creating no tasks |
| `--no-derive-acceptance` | does not derive `acceptance[]` from `success_indicators` |
| `--force` | migrates the rest of a squad with an irreducible document; with `--rollback`, restores without the unchanged-since proof |
| `--rollback <ts>` | restores that stamp's backup |
| `--json` | the `nirvana.squad-migrate/v1` report on stdout |

### 35.5 The three populations of an installed library

1. **Installed copies of a pack** (watermarked per buyer): **never migrate there.** Migrate the source in the packs repository; `nrv update` delivers the new version.
2. **Originals that also exist in packs:** unify first with `unify-squad.ts <slug> --authored <local>`, migrate the unified copy and let `unify-squad` write every pack byte-identical. `check-copy-drift --strict` compares the `squad.yaml` md5 across copies, so migrating a single copy fails the build.
3. **Orphans:** migrate in place, one at a time, routed ones first. The rest stays 5.0 under permanent dual reading, which is a decision and not a backlog.

---

## 36. Tasks at outcome altitude

### 36.1 The rule

Current models do best with the result, the reason, the guard rails and the definition of done, with the method left to the executor. A task therefore states its outcome and carries no mandatory step list. A prompt that inlines every task whole and ends with "execute the steps in this order" gets the opposite.

### 36.2 What a task is

`tasks/<task>.md`, with sections in this order:

| Section | Rule |
|---|---|
| frontmatter `name`, `description` | `description` is what the work card shows (§32.3) |
| `## Outcome` | what must be true when the task is done: one paragraph, result and not method |
| `## Input` | optional: what the task receives |
| `## Output` | what to produce and where |
| `## Acceptance Criteria` | binary, verifiable criteria; what the judge reads (§29.3, rung `task_acceptance_criteria`) |
| `## Steps` | **absent by default**. Write it only when the order or completeness of the steps is itself a requirement, and then say so in an acceptance criterion. Even then the executor reads it as reference method, not as an order |
| `## Output Schema` | optional |

`blocking: true` in a capability's acceptance is still what the gate checks: altitude changes how a task describes the work, not what the judge charges. The scaffold is `templates/task.md.tmpl`.

### 36.3 What the engine does with it

`buildSquadPrompt` labels the criteria **done when** and the step table as reference method (§32.2). `briefing.altitude` (`outcome` by default, `guided`, `prescriptive`) sets the shape of the enriched brief and the dispatch instruction (`skills/harness/references/05-brief.md`). `acceptance[].path` and `min_bytes` (§29.1) let a criterion promise a file, so the on-disk check reads the promise instead of hunting for paths in the brief.

### 36.4 Migrating existing content

`deprescribe-tasks.ts` (in `skills/squads/scripts/`) migrates it, always with a report:

```bash
bun skills/squads/scripts/deprescribe-tasks.ts <root> [<root>…]                    # report
bun skills/squads/scripts/deprescribe-tasks.ts <root> --apply                      # rewrite
bun skills/squads/scripts/deprescribe-tasks.ts <root> --json                       # JSON report
bun skills/squads/scripts/deprescribe-tasks.ts ~/squads --include-library --apply  # installed library, in place
```

Per task it adds `## Outcome` when missing, derived in order from the frontmatter `description`, the first paragraph after the title, or the `## Output` paragraph joined with the first acceptance criterion (a pending marker when none exists), and **removes the whole `## Steps` section**, from its heading to the next h1 or h2 or the end of file, keeping a final attribution comment line. Nothing else is touched. The report gives per file `{outcome_added, outcome_source, steps_removed, weak}`; `weak` marks a task whose `description` was no use (empty, a placeholder or under six words), for a model-assisted rewrite. The root must be passed explicitly. The installed library enters only with `--include-library`, migrated in place and never copied into a pack, because an installed copy is marked per buyer.

---

## App-A. Portable tool names

Moved to §10.7.

---

## App-B. Canonical feature names

`features_required` accepts the closed `Feature` enum in `skills/_shared/validators/validators.ts`: runtime and control (`max_turns`, `tool_whitelist`, `subagent_spawning`, `sequential_execution`, `audit_trail`, `scheduled_invocation`, `event_bus`, `hooks`, `sandboxing`, and others), memory (`session_memory`, `project_memory`, `global_memory`), handoff and context (`handoff_artifacts`, `fork_context`, `teammate_primitive`), observability (`telemetry_otel`, `feedback_tracking`, `git_isolation`, and others), tool primitives (`file_read`, `file_write`, `shell_exec`, `tools.read`, `tools.write`, `tools.exec`, and others) and agent abilities (`web_search`, `web_fetch`, `vision_input`). `features_optional` accepts free strings, so an adapter may add runtime-specific names there.

---

## App-C. Canonical capability catalog

The authoritative catalog is `skills/_shared/catalogs/CAPABILITY_CATALOG_V1.yaml` (v1.1.0: 60 domains, 57 id namespaces). It is the list a `domains` entry and the first segment of a capability `id` come from. The domains are grouped as marketing and sales (`marketing`, `sales`, `branding`, `copy`, `growth`, `ads`, `crm`, and others), content and media (`content`, `media`, `video`, `audio`, `voice`, `social_media`, and others), engineering (`software_engineering`, `frontend`, `backend`, `mobile`, `data_engineering`, `devops`, `security`, `ai_engineering`, `qa`, and others), business and strategy (`strategy`, `finance`, `legal`, `compliance`, `hr`, `analytics`, and others), verticals (`healthcare`, `education`, `real_estate`, `fintech`, `crypto`, `gaming`, `ecommerce`, and others) and cross-cutting ones (`research`, `knowledge_management`, `document_processing`, `automation`, `integration`, `design`). Namespaces follow the domains in both the short and the spelled-out form (`software` and `software_engineering`). Examples: `marketing.campaign.full_funnel`, `media.video.analyze`, `legal.contract.review`, `research.market.intelligence`.

**Governance.** An addition is a change to the YAML, and a removal goes through one minor version of deprecation. `experimental_domains: true` skips the check at the cost of a discovery penalty. `general` is non-canonical by design, because it discriminates nothing.

---

## App-D. Capability schema

Retired as a separate JSON block. The fields are in §22.3 and §22.4, and the machine-readable schema is generated from `CapabilitySchema` (App-G).

---

## App-E. Moving an older squad to v6

Run `nrv migrate <slug> --to 6` (§35). A v4 squad with no capabilities needs them first. For each unit the squad delivers, write a capability (§22): an id from the catalog, a concrete description, inputs and outputs, three to five `examples`, routing metadata (§22.4), short `not_for` entries (§33) and `invoke`. Then run `nrv index` and check that `nrv find "<an example brief>"` returns `MATCH_HIGH` for it. For production capabilities add ground truth and a `fidelity` block (§22.6).

---

## App-F. Anti-patterns

1. **Generic descriptions.** "Analyze stuff" cannot be matched. Be concrete enough for a router to match an intent.
2. **Examples that overlap `not_for`.** An `examples` entry "analyze video" beside a `not_for` entry "video analysis for education" makes the fence fight the example.
3. **A squad without a sayable boundary.** The test is not how many capabilities a squad declares but whether its purpose fits one sentence with every capability inside it. Forty coherent capabilities are healthy, six unrelated ones are not. If a squad's capabilities need `not_for` against each other, they are two squads (§22.11).
4. **Fidelity theater.** Never declare `validated` without ground truth on disk.
5. **Hardcoded prices.** Cost belongs to the adapter; declare a `model_hint` family.
6. **Hidden dependencies between capabilities.** Declare them with `requires` (§31), never as an unstated assumption that another capability ran first.
7. **Neighborhood fences and gaps** (§33.1).
8. **Business orchestration inside capabilities.** A capability is atomic; a process spanning several belongs to a business.
9. **A task as a script.** A long numbered `## Steps`, or a prescriptive agent body, takes the method away from the executor (§36).
10. **Memory or output inside the squad directory** (§5.4, §11.2).

---

## App-G. Generated JSON schemas

The JSON schemas are **generated**, never edited by hand:

```bash
bun scripts/gen-json-schemas.ts            # writes
bun scripts/gen-json-schemas.ts --check    # fails when a file differs (runs in check:all)
```

`skills/_shared/schemas/capability.schema.json` comes from `CapabilitySchema`, `squad.schema.json` from `SquadManifestSchema` and `workflow.schema.json` from `WorkflowSchema`. The validator that **runs** is the Zod code in `skills/_shared/validators/validators.ts`; the JSON is documentation, and hand-written documentation of an executable contract drifts. The projection uses `io: "input"`, so a defaulted field is published as optional. The per-squad mirrors (`squad-schema.json`, `agent-schema.json`, `task-schema.json`, `adapter-schema.json`, `handoff-schema.json`) were removed; `references/05-schemas.md` says what replaced each.

---

## App-H. Deprecated

Nothing below stops loading. Each item is tolerated by the reader, warned by the gate, converted or removed only by `--fix` or `nrv migrate`, and leaves the reader in a v7.

| Deprecated | Replacement |
|---|---|
| `workflows/*.yaml` as the canonical form | `workflows/*.md` (§28.1); reading `.yaml` is permanent |
| the legacy graph dialects, `depends_on` | canonical `steps[]` with `requires` (§28.4) |
| v5 rule: `not_for` naming the alternative capability | §33: at most 25 characters, no id suffix |
| `humanize` (field, fixer, audit criterion) | removed; the writing contract does it (§27) |
| `*squad run <name> --workflow <wf>` | `nrv run --squad <slug>[:<cap>]` |
| singular `output:` in a capability | `outputs[]` |
| `output:` block in the manifest | ignored; the engine owns the path (§16bis) |
| `ui:` and `contracts:` manifest blocks | not read; schemas go in `components.schemas` and `outputs[].schema` |
| the 500-character cap on `capabilities[].description` | `LIMITS.capability_description_max`, currently 1,500 |
| `## Steps` as the body of a task | `## Outcome` (§36) |
| `required_enforcement`, `business_scope`, OpenTelemetry conventions | retired (§10.6, §11.3, §26) |

---

## App-Z. History

| Version | Change |
|---|---|
| 4.0 | runtime-agnostic core; 4.1 added the engine-owned output convention (§16bis) |
| 5.0 | capability discovery layer (§22 to §27) |
| 6.0 | workflow document, acceptance, evaluator, composition, short `not_for`, admission, migration (§28 to §35, App-G, App-H) |
| 6.1 | tasks at outcome altitude (§36); MCP and credentials declared in `dependencies.yaml` (§9.3); `runtime_requirements.policy` defaults to `active` (§4.3); this document rewritten as one complete specification |
