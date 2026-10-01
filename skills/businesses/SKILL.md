---
name: businesses
description: "Business lifecycle skill (DOMAIN-AGNOSTIC). Creates, lists, inspects, validates, and migrates businesses — autonomous multi-agent organizations — following the Business Protocol v2 (v1 businesses still load unchanged). Works for ANY domain: marketing, healthcare, engineering, legal, real-estate, gaming, foodtech, trading, education, research, government, etc. Triggers: list businesses, inspect business, create business, validate business, migrate business, manage org chart, library/dna ops. For EXECUTION of production briefs ('use as empresas', 'produza X via empresa Y'), hand it to the harness (read `~/.nirvana/skills/harness/SKILL.md` and follow it) instead — it carries the maestro intelligence. Default: zero_human."
compatibility: "Requires the Nirvana-OS engine: the `nrv` CLI and Bun on PATH. Install: npx @nirvana-os/cli. Runtime-agnostic — no dependency on any specific agent CLI. Creation flows need an interactive question primitive; without one, use the non-interactive list/inspect/validate paths."
tools: [Read, Write, Edit, Glob, Grep, Bash, AskUserQuestion]
maxTurns: 100
metadata:
  # Hidden from skills.sh discovery: this skill is not standalone (it needs the
  # engine at ~/.nirvana). The `nirvana` skill is the one to install there.
  internal: true
  openclaw:
    emoji: "🏢"
    requires:
      # Todo script do Nirvana é Bun-nativo: sem bun a skill aparece e falha.
      bins: ["bun"]
---

# Business Protocol Engine v2.0

> Requires the Nirvana-OS engine (`nrv` on PATH). If it is absent, use the `nirvana` skill, which installs it. This skill is not standalone.

Business lifecycle and structure following `BUSINESS_PROTOCOL_V2.md`. Runtime-agnostic (Claude Code, Codex, Gemini-CLI). Zero external dependencies beyond the runtime and the centralized validators in `~/.nirvana/skills/_shared/`.

---

## Scope of this skill

This skill is for **business lifecycle operations**: list / inspect / create / validate / migrate businesses; manage the `~/businesses/_library/dna/` mind-clone library; bootstrap structure; consult registries.

For **execution requests** ("use as empresas", "rode pela empresa X", "produza um livro/post/vídeo", any production brief), hand it to the **harness** (read `~/.nirvana/skills/harness/SKILL.md` and follow it) instead. The harness picks the business, writes it a brief and dispatches it; the engine then runs it as one agent, gates it and delivers. This skill is not the entry point for orchestration.

### Verifying real dispatch (when execution does happen via harness)

After delivery, confirm in `~/.harness-logs/$(date +%Y-%m-%d)/audit.jsonl`:
- `event=brief_received` (from brief-business.ts)
- `event=dispatch_business` (or `dispatch_squad` for fallback) with this trace_id
- `event=x_business_solo_started` (its `voices` are the clones offered), then `x_seat_credited` for each seat and `x_clone_credited` for each clone the worker declares it used
- `event=handoff_phase_advanced` for `plan → execute` and `execute → complete`
- `event=verify_passed` (from verify-deliverable.ts)
- `event=gate_passed` (from quality-gate.ts) with the rubrics list
- The actual artifact at the dispatched target's declared `outputs[]` location

If absent, the orchestration didn't happen — claiming "I used business X + squad Y" without those events is fiction. Iterate, don't fake.

---

## How a business runs

A dispatched business runs as ONE agent (`harness/lib/business-solo.ts`). It
reads the brief the orchestrator wrote for it and re-reads it at every phase,
plays the seats from their files, writes in a clone's voice only after loading
that clone's persona (its seats' own voices, plus up to three the engine
finds for the request), and uses a squad by reading its card
(`nrv cards squad <slug>`) and working as its agents. It never dispatches: not a
squad, not a seat, not another business.

It works in phases with its state in `_work/PROGRESS.md`, writes the
deliverables under the outputs root and nothing elsewhere, and ends with
`_SUMMARY.md` (one page, the orchestrator's only read), `_CLAIMS.json` (one
pointer per "Done when" item) and `participation.json` (the seats, squads and
clones it actually used). The engine then decides whether to review, runs the
gate and delivers.

An event outside the closed enum (`references/03-audit.md` in the harness
skill) gets the explicit `x_` prefix at the call site, never a bare invented
name.

---

## First invocation (auto-bootstrap)

When this skill activates for the first time, ensure the minimal structure exists. Idempotent:

```bash
mkdir -p ~/businesses ~/businesses/_library/dna ~/businesses/_library/frameworks
mkdir -p ~/.businesses-state ~/.businesses-logs/$(date +%Y-%m-%d)
[ -f ~/.businesses-registry.json ] || echo '{"schema_version":"1.0.0","generated_at":"","businesses":{}}' > ~/.businesses-registry.json
```

Report: number of businesses found, registry status, dependencies (Python 3.9+, Node 18+ — only for validators).

## Project scoping

When invoked from inside a project whose scope (`scope` in `<project>/.nirvana/project.yaml`, set with `nrv init --scope=<mode>`) is `project` or `merge`, all loaders (list/index/inspect/validate) honor that scope automatically. Project-local businesses live at `<project>/.nirvana/businesses/<slug>/` and the registry persists at `<project>/.nirvana/.businesses-registry.json`. From global cwd or with `NIRVANA_SCOPE=global` (default), behavior is identical to the home installation. Full contract: `~/.nirvana/skills/_shared/SCOPE_CONTRACT.md`.

## Protocol source

Source of truth, in this directory: `BUSINESS_PROTOCOL_V2.md`. Version 1.0 is archived in the repository's `docs/legacy/protocols/`, not installed; a v1 business still loads, routes and dispatches, and v2 fields are optional.

**The validator that runs is Zod**, in `~/.nirvana/skills/_shared/validators/validators.ts`. `validators.py` is the canonical mirror for hosts with Python. `~/.nirvana/skills/_shared/schemas/business.schema.json` and `core-schemas.json` are **documentation mirrors** — they describe the contract, they do not execute it, and a divergence between them and the Zod schema is a defect in the JSON. Always delegate validation to the validators instead of re-implementing it.

DNA library of mind-clones in `~/businesses/_library/dna/` (61 categories, 393 validated canonical mind-clones).

Canonical domain catalog in `~/.nirvana/skills/_shared/catalogs/CAPABILITY_CATALOG_V1.yaml`.

Read on demand. NEVER preemptively load the full protocol into context.

## Principles (BP1-BP13 + inherited Squad P1-P11)

- BP1 Zero-human is the default. A run that needs a human says so explicitly; nothing pauses on its own.
- BP2 Hierarchy is real, not decorative: the single agent reads the org chart and honors it (v2 §8).
- BP3 Work is structured, not free-form: brief in, phases in `_work/PROGRESS.md`, three closing files out (v2 §14). Runtime handoffs between seats are retired (v2 §10).
- BP4 Acceptance is declared per seat (`acceptance[]`), judged by the gate, not self-scored by the author (v2 §11).
- BP5 Two curated memory scopes (machine, project) in `.nirvana`, isolated by construction (v2 §9).
- BP6 Brief is the unit of entry. Routing via `routing.yaml`.
- BP7 Antagonist mandatory above 5 employees.
- BP8 Default `functional_specialist`, not `mind_clone`.
- BP9 Retired in v2 (approval chains were never implemented; adversarial review is BP7).
- BP10 Retired in v2 (heartbeats were never scheduled; recurring work belongs to the host scheduler).
- BP11 Project outputs are source-of-truth, memory is cache.
- BP12 Audit trail is non-negotiable.
- BP13 Writing contract — every prose deliverable follows the contract appended to `AGENTS.md` / `CLAUDE.md` / `GEMINI.md` (prevention-by-injection, no post-hoc rewrite).

## Filesystem layout (canonical)

```
~/businesses/                              # business root (one folder per business)
├── _library/
│   ├── dna/                               # canonical mind-clones (symlinks to disk)
│   └── frameworks/                        # reusable frameworks
└── <business-slug>/
    ├── business.yaml                      # manifest (protocol 1.0 or 2.0)
    ├── employees/<slug>.md                # employee frontmatter + body
    ├── org-chart.yaml                     # hierarchy + reporting + escalation_path
    ├── routing.yaml                       # brief intake + auto_routes (the only place auto_routes live)
    ├── .nirvana-surface.json              # contract surface — engine-owned, never hand-edited
    └── memory/permanent.md                # shipped seed; live memory is in .nirvana (v2 §9)

~/.businesses-registry.json                # index generated by `*business index`
~/.businesses-state/                       # local skill state
~/.businesses-logs/<YYYY-MM-DD>/           # audit trail jsonl
```

Project outputs live in `${PROJECTS_OUTPUT_DIR}/<project-id>/businesses/<biz-slug>/` (default: `<repo-root>/.projects-outputs/`).

Project-root resolution:
1. `$PROJECTS_OUTPUT_DIR` env var
2. `$NIRVANA_PROJECT_ROOT`, else walk up to the nearest folder with `.nirvana/project.yaml` (written by `nrv init`; `nrv init --adopt` declares an existing folder)
3. No project: the engine's store, `~/.nirvana/outputs/`

## Intent classification

When the user invokes this skill, map the input to one of the actions below. Use AskUserQuestion to disambiguate when needed.

| Intent (keywords) | Action | Reference |
|---|---|---|
| **CREATE**: create, new business, scaffold, init | `*business init <name>` | §Wizard flow (in this file) |
| **LIST**: list, view all, which businesses | `*business list` | `scripts/list-businesses.ts` |
| **INSPECT**: view, show, inspect, detail | `*business inspect <slug>` | `scripts/inspect-business.ts` |
| **VALIDATE**: validate, check, verify | `nrv validate business <slug>` | `scripts/validate-business.ts` |
| **INDEX**: index, rebuild, refresh registry | `*business index` | `scripts/index-businesses.ts` |
| **BRIEF**: brief, process, execute, run | `*business brief <slug> "<text>"` | `scripts/brief-business.ts` |
| **EMPLOYEES**: add employee, new employee, hire | `BUSINESS_PROTOCOL_V2.md` §7 |
| **ORG**: org chart, hierarchy, reporting | `org-chart.yaml` + `nrv validate business <slug>` |
| **ROUTING / EXECUTION**: route, auto_routes, how a business runs | `BUSINESS_PROTOCOL_V2.md` §13 and §14 |
| **MEMORY**: edit memory, maintenance | `*business memory edit <slug>` |

Multi-intent: process in dependency order. Always lazy-load (never load the full protocol).

## Quick commands (operational)

> ⛔ **Run loaders from your PROJECT's working directory, with the ABSOLUTE path
> below. NEVER `cd` into the skill directory to run a loader.** Scope is detected
> by walking up from the current directory; `cd`-ing into `~/.nirvana/skills/businesses`
> moves your shell out of the project tree, so the loader silently resolves
> `scope=global` and lists the home registry instead of your project's. From a
> scoped project (scope `project` or `merge`) that means you get the WRONG
> answer. If a loader prints `scope=global` when you expected `project`, you
> almost certainly `cd`-ed out. (Pin it cwd-independently with
> `export NIRVANA_PROJECT_ROOT=<project>`.)

| Command | Implementation | Description |
|---|---|---|
| `*business init <name>` | `bun ~/.nirvana/skills/businesses/scripts/init-business.ts <name>` + wizard via AskUserQuestion | Scaffold new business in `~/businesses/<slug>/` |
| `nrv validate business <slug>` | `bun ~/.nirvana/skills/businesses/scripts/validate-business.ts <slug>` | Admission gate: the 41 criteria of `BUSINESS_PROTOCOL_V2.md` §16.2 (`--fix` applies the mechanical repairs, `--strict` also fails on warnings, `--all` walks the library, `--report` writes the JSON under `.audit-state/<slug>/`) |
| `*business index` | `bun ~/.nirvana/skills/businesses/scripts/index-businesses.ts` | Regenerates `~/.businesses-registry.json` |
| `*business list` | `bun ~/.nirvana/skills/businesses/scripts/list-businesses.ts` | Table of businesses from the registry |
| `*business inspect <slug>` | `bun ~/.nirvana/skills/businesses/scripts/inspect-business.ts <slug>` | Manifest + employees + org-chart formatted |
| `*business brief <slug> "<text>"` | `bun ~/.nirvana/skills/businesses/scripts/brief-business.ts <slug> "<text>"` | Records brief, validates, prepares invocation plan |
| `*business memory edit <slug>` | opens `~/businesses/<slug>/memory/permanent.md` in write mode | Maintenance mode |
| `*business audit <project> --business <slug>` | tail `~/.businesses-logs/.../audit.jsonl` filtered | Audit trail |

Interactive wizards follow the round pattern below (§Wizard flow), which is the full detail — there is no separate reference file.

## Wizard flow (executed by the skill when intent = CREATE)

When intent = CREATE, follow this sequence without skipping steps.

> **This flow IS the system's business creator** — creation is engine work,
> executed agentically by this skill, never dispatched to a creator squad.
> The goal is the best possible business for the role, not a valid one.

**Round 0 — Archaeology + research (before asking anything)**
- Intent archaeology: which recurring pain the business serves, who consumes
  the outputs, and what already exists in the portfolio that covers part of it
  (`nrv find --no-amplify` with 3-5 hypothetical briefs). Overlap is legitimate
  — the owner may want two organisations covering the same sector, to name one
  when they want it and let the maestro choose when they do not. What the
  search tells you is what this business must be visibly better at. Never fence
  a neighbour off; boundaries carry genuine refusals only.
- Domain research (web, mandatory): CURRENT practices, tools, and services of
  the sector, with date and source — they become the employees' knowledge and
  the real vocabulary of `domains`/`example_briefs`/keywords (PT and EN).
- Mind-clones by NEED: for each planned role, search the library
  (`nrv find-clone "<necessidade do papel>"`) and pre-select
  `assigned_mind_clones` with grounding — an employee without the right clone
  is a generic persona. Empty library (clean engine install, no pack)? Two
  honest paths: create the clone first (`_shared/MIND_CLONE_CREATION_PIPELINE.md`)
  or proceed without a clone, declaring the employee as a built persona, never
  as a clone that does not exist.

**Round 1 — Identity**
- AskUserQuestion: "What is the business name?" (single, with hint about kebab-case)
- AskUserQuestion: "Brief description (≥20 chars)? Include domains."
- Validate that the slug does not collide with an existing `~/businesses/<slug>/`.

**Round 2 — Template**
- AskUserQuestion with options: solo (1 employee), council (5 advisors + CEO), agency (CEO + 4-7 specialists + antagonist), custom.
- Each option has a preview in the appropriate `templates/example-business/`.

**Round 3 — Employees**
- For each employee in the template, AskUserQuestion confirming role + adjustments.
- If template = custom, ask for the role list (multi-select of canonical roles + "Other").
- Auto-promote the first alphabetically to CEO if none is explicit. BP7 force-adds an antagonist if there are >5 employees and none is marked.

**Round 4 — Review**
- Generate `business.yaml`, `org-chart.yaml`, `employees/*.md` in a staging directory.
- Run `scripts/validate-business.ts` against staging.
- AskUserQuestion: "Confirm creation?" showing the preview.
- If approved, move to `~/businesses/<slug>/` and update the registry.

**Round 5 — Readiness gate (MANDATORY, after the registry update — creation is NOT done until it passes)**
- **Admission gate (blocking).** Run and require exit 0:
  `nrv validate business <slug> --strict`
  It is the single verb that carries the criteria catalog of `BUSINESS_PROTOCOL_V2.md` §16 — manifest, employees, org chart, routing metadata, acceptance, surface. `--fix` repairs the mechanical findings; authorship (fences, acceptance, thin seats) stays with you. `init-business.ts` already ran it in `--fix` mode over the scaffold, so the engine-owned `.nirvana-surface.json` is on disk before you start writing.
- Optimization pass: reread each employee as a hostile reviewer — a generic
  persona, a role without a clear deliverable, or knowledge Round 0 researched
  that the employee does not use are defects; fix them before declaring ready.
- **Seat sufficiency (blocking script gate).** Under the per-task clone model
  a dispatch may legitimately run with no clone, so every seat must stand on
  its own method. Run and require exit 0:
  `bun ~/.nirvana/skills/_shared/scripts/check-seat-sufficiency.ts <slug> --strict`
  The measure is sections + decision lines (seat-sufficiency.js), calibrated
  against the whole library — a dense-short seat passes, a role label does not.
- **Routing metadata, contract-complete** — fill `business.yaml` (+
  `routing.yaml`) per `~/.nirvana/skills/_shared/ROUTING_METADATA_CONTRACT.md`.
  No field may be left empty or truncated:
  - `description`: canonical English, concrete, front-loaded (§1);
  - `domains`: from `CAPABILITY_CATALOG_V1.yaml` (§2);
  - `produces`: artifact-type slugs (§3);
  - `keywords`: multilingual synonym groups — EN + PT (+ES where natural),
    accented AND unaccented forms (§4);
  - `example_briefs`: ≥3, at least one EN and one PT, symptom-phrased, covering
    conjugated and infinitive verb forms (§5);
  - `not_for`: short token lists of 2-4 content words, never sentences (§6);
  - `auto_routes` in `routing.yaml`: patterns derived from the example_briefs,
    firing on infinitive AND conjugated forms (§7).
- **Self-retrieval gate (blocking):**
  ```bash
  bun ~/.nirvana/skills/_shared/scripts/self-retrieval-gate.ts <slug>
  ```
  Every `example_brief` must route back to this business top-1 (exit 0). Also
  probe 2-3 extra SYMPTOM briefs (as the owner would type them in a panic, PT)
  and confirm the home briefs of the Round 0 neighbor businesses still route to
  their owners. On a miss, the defect is in the discovery metadata — never "the
  router"; iterate the metadata and rerun until the gate exits 0. **Do not
  report the business as created while this gate is red.**

## Memory isolation (BP5 enforcement)

During brief invocation, REFUSE any operation outside `${PROJECTS_OUTPUT_DIR}/<current-project>/`. Allowed exceptions:
- Read-only on `~/businesses/<current-biz>/` (manifest, employees, org-chart, permanent memory).
- Read-only on `~/businesses/_library/dna/` (mind-clone refs).
- Append on `~/.businesses-logs/<date>/audit.jsonl`.

Permanent memory (`~/businesses/<slug>/memory/permanent.md`) is writable ONLY in `*business memory edit` mode.

**Two files, two owners.** `permanent.md` (or `memory/permanent/`) ships with the business and is **replaced on pack update** — it is curated content, not a place to accumulate. `memory/learned.md` is where a human promotes what past runs proposed; it is in `RUNSTATE_EXCLUDES` and **survives pack updates**. Both are read at dispatch; only `learned.md` grows. A run never writes either one — it writes its own project's memory and lists promotion candidates in the final report (see `harness/SKILL.md` → Memory levels).

A violation emits `audit_event: isolation_violation` and aborts.

## Handoffs (v2 §10)

Runtime handoffs between seats (mentions, tickets, delegation, escalation) are retired: a run is one agent that plays the seats it needs (`BUSINESS_PROTOCOL_V2.md` §14). What remains is `routing.yaml`: the first `auto_routes` pattern that fires on the brief names the seat the request belongs to (v2 §13.2), and a decision that belongs to another seat or to the user goes into `_SUMMARY.md` as an open item.

## Acceptance per seat (BP4, v2 §11)

Each seat declares `acceptance[]` in its frontmatter: `{id, description, blocking, minimum_score, capability?, path?, min_bytes?}`. Every entry maps 1:1 onto a `SuccessRequirement`, the same shape squad capabilities use, so the judge and `verify-deliverable.ts` evaluate a seat's output against what the seat itself declared. Ids are unique within the business.

`self_score_contract` is retired (v2 §0): the loader still accepts it, the gate warns, and `nrv validate business <slug> --fix` converts `criteria[].{id, description, threshold}` into `acceptance[]`. An author's own score was never evidence, and nothing read it.

## Zero-human operation (BP1)

Default `operation_mode: zero_human`, and it is the only mode honored this cycle — `hybrid` and `human_in_loop` parse and warn.

The org chart (`reports_to` / `manages`) says which seat owns a decision; the agent records a decision above the seat it is playing as an open item (v2 §8). `routing_rules.escalation_path` is accepted and read by nothing. `escalation_triggers` in employee frontmatter and the `escalation-triggers.yaml` file are retired (v2 §22): 234 seats declared triggers and nothing ever fired one. A run that genuinely needs a human says so in `_SUMMARY.md` and the harness surfaces it (v2 §12).

## Writing contract (BP13)

Every prose deliverable follows the writing contract appended to `AGENTS.md` / `CLAUDE.md` / `GEMINI.md`. The contract is auto-loaded by every runtime (Claude Code, Antigravity CLI, Gemini CLI, Codex) before the agent generates anything, so prevention happens at write time. No post-hoc correction loop, no separate skill invocation, no extra cost.

Employees that produce only technical artifacts (JSON, schemas, code) ignore the contract by content — none of the prose rules apply to non-prose output.

## Skill layout

```
~/.nirvana/skills/businesses/
├── SKILL.md                                # this file
├── BUSINESS_PROTOCOL_V2.md                 # the complete protocol (source of truth)
├── templates/
│   ├── business-types/<type>/              # solo · council · agency · conglomerate
│   └── example-business/                   # runnable solo template (validation passes)
├── lib/
│   ├── loader.ts                           # loads + validates an entire business
│   ├── registry.ts                         # generates ~/.businesses-registry.json
│   └── business-audit-criteria.js          # audit scoring
├── scripts/
│   ├── init-business.ts                    # scaffold + wizard kickoff
│   ├── validate-business.ts                # admission gate entry point
│   ├── index-businesses.ts                 # rebuild registry
│   ├── list-businesses.ts                  # table
│   ├── inspect-business.ts                 # formatted tree
│   ├── brief-business.ts                   # prepare invocation plan
│   └── verify-deliverable.ts               # artifact existence + acceptance paths
└── tests/
    ├── smoke.test.ts                       # E2E: init → validate → index → list
    ├── registry-description.test.ts        # what the registry emits to the router
    └── protocol-v2-spec-parity.test.ts     # §16 table == gate catalog
```

## Invocation (when intent = BRIEF)

`nrv dispatch <slug> --brief-file <brief> --exec` scaffolds the run
(`brief-business.ts`), runs the business as one agent and delivers. Started in
the background, it returns a launch receipt, not the result: the result
arrives in the `<task-notification>` the runtime delivers when the process
ends, or through `nrv run-track status` on a runtime that does not notify.
Waiting does not mean blocking; the session stays free while the business
works.

## Anti-patterns (DO NOT)

- DO NOT process briefs in `human_in_loop` mode without explicit config.
- DO NOT ship a delivery that has not passed the gate (and the review, when the rule asks for one).
- DO NOT allow filesystem access outside the project root + own business scope.
- DO NOT use `mind_clone` without `disclosure_required: true`.
- DO NOT create businesses with >5 employees without an antagonist (BP7).
- DO NOT bypass the antagonist (BP7) on client-facing output.
- DO NOT emit prose output that violates the writing contract in `AGENTS.md` / `CLAUDE.md` / `GEMINI.md` (BP13).

## Backward compat

- Squads referenced in `squads_authorized` may be v4 or v5 (the squads skill resolves both).

---

*Protocol: 2.0 (1.0 still loads) · Status: operational · Spec: BUSINESS_PROTOCOL_V2.md*
