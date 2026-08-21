# The graph the engine already needed

**Status:** P0 executed and benchmarked (PR #57, 2026-08-20) · P1/P2 routed
**Origin:** PR #41 (`marciobisognin`) · **First draft:** 2026-08-16 · **Rewritten:** 2026-08-20
**Grounding:** research trace `1bdc5f75` (47 sources; `graph-harness-integration-report.md`)

PR #41 contributes a visual conglomerate builder. Reviewing it surfaced
something worth separating from the question of whether to merge it: **the
graph model inside that PR is a description the engine was missing**, and one
of its consumers was a bug we were living with. The first draft of this
document proposed splitting the contribution in two — a model that belongs in
the engine, and a surface that belongs in `glance`. The research validated the
split, and the P0 half now exists in code with measured results. This rewrite
records what shipped, what the research added that the draft lacked, and the
remaining route.

---

## 1. The defect, now with closed numbers

The engine had no written statement of what relates to what. A business staffs
employees; an employee embodies a mind-clone; a squad covers capabilities.
Those relationships existed in files and in everyone's head, and nowhere as a
contract.

The measured cost (benchmark, 2026-08-20, live library: 60 businesses, 556
clones):

- **The build-time resolver guessed.** `build-all-packs.sh` resolved a
  business's clones with 556 recursive word-match greps per business. Over
  the live library: 109 seconds, **346 clones "referenced" of which only 104
  are declared** — 242 prose-mention false positives (~3.3× over-promotion),
  including wrong-clone shipments (`pedro-sobral` word-matched for
  `pedro-sobral-paid`). Historically it also under-resolved: tracking-360
  shipped 5 of its 17 declared clones.
- **The installer installed in reverse dependency order** (businesses before
  the clones their employees embody) and degraded silently on a missing
  dependency.
- **No machine-readable answer existed** for "what does executing this
  business need?" — the dispatch-facing question.

## 2. What shipped (P0 — PR #57, `feat/dependency-graph`)

The pure algebra of PR #41's `graph-store.ts`, derived with credit
(co-author trailer + file header), entered the engine:

| Piece | Where | Result |
|---|---|---|
| Typed algebra | `skills/_shared/lib/dependency-graph.ts` | compatibility table, `dependencyPair` (the load-bearing reversal: `employee embodies clone` → clone first), `buildOrder` (cycles as data; `buildOrderOrThrow` keeps PR #41 semantics), `closure()`, `toDagNodes()` |
| Declaration reader | `skills/_shared/lib/entity-graph.ts` | the graph is ALWAYS rebuilt from prose declarations; `check-clone-bindings.ts` consumes it, stdout byte-identical |
| Ordered install | both installer twins | squads → mind-clones → businesses; `dependency missing: mind-clone 'x' required by <biz>/<emp>` named, never silent |
| Dispatch query | `nrv graph closure\|order\|check` | tracking-360 closure: 30 ms, 17/17 clones, 51 edges, 100% recall |
| Pack resolver | `scripts/list-clone-refs.ts` | 28 ms/business vs 2,366 ms grep (84×); full pass 31 ms vs 109 s (~3,500×), zero false positives |
| Run compiler | `skills/harness/lib/plan-compiler.ts` | plan graph → standard multi-target manifest (§4 below) |

Hot path proof: route/dispatch/index import no graph lib (static test) and
route timing is unchanged. Full suite 938 tests, 0 fail; 3-OS CI green.

## 3. The five constraints (research-derived; they govern everything below)

1. **The graph is a projection.** It compiles to dispatches through the
   cascade; it never executes itself. Every surviving 2026 framework
   converged on "model writes the graph, deterministic runtime executes it,
   human can read/diff/rerun it" (Claude Code dynamic workflows 2026-05-28;
   AFlow ICLR 2025). A canvas that IS the runtime hits the export gap that
   killed the visual builders.
2. **No runtime offers a graph primitive to lean on.** All ten adapter
   runtimes are capped trees; the graph layer compiles down to per-runtime
   trees via the adapters. `manifest.json` is the compilation target.
3. **MAST's three failure categories (NeurIPS 2025) map onto structural
   validation, typed edges + cascade, and the fail-closed gate.** Integration
   strengthens all three, never bypasses them.
4. **Graph builds need durable-execution semantics** (§5).
5. **The whole layer is opt-in.** Single-target briefs pay zero graph tax
   (locked by test).

## 4. Run compilation — the piece the first draft lacked

The draft treated the graph as an install-order tool and never mentioned the
engine's own multi-target DAG. That is now the center of the build story:

`compileManifest(graph)` (shipped, tested) turns a validated plan graph into
the exact `manifest.json` contract of `references/04-multi-target.md` —
`phases[].depends_on`/`consumed_by` from `dependencyPair`, `parallel_waves[]`
from `planDag` layering. The existing dispatch loop owns execution, gating,
audit and resume. Studio's SSE progress becomes a read-only view over that
run's state. **There is exactly one executor.** A cyclic or invalid graph
returns issues; no manifest ships.

Merge shape for PR #41 v1: **plan → validate → export-to-manifest**, with
entity materialization gated off until the creator wiring (§7 P1-1) lands.
PR #41's own refusal — "Studio will not mark an unmaterialized seat as
built" — stays verbatim as the guard.

## 5. Durability — the second missing piece

An interrupted 12-seat build must not re-dispatch finished creator runs or
double-spend gate cycles. The rule, applied from LangGraph checkpointing /
Temporal replay / Claude Code workflow resume (all [verified] in the research):

- per-node build results persist as **phase status in the compiled manifest**
  (`finished_at`, `status`) — never as graph-layer checkpoints;
- `nrv resume` replays the manifest **skipping every phase with
  `gate_passed`**, reusing `run-state.ts` / `resume-project.ts` semantics;
- manifest-level granularity is accepted: a half-finished phase re-runs
  whole, because per-step checkpoints inside a creator dispatch would leak
  execution state into the graph layer (constraint 1).

## 6. Audit taxonomy — the third missing piece

Live today (open namespace, deliberate): `x_install_order_resolved`,
`x_dependency_missing`. Promotion to the closed `ALLOWED_EVENTS` enum follows
`audit.js`'s own documented policy — real events with real consumers — and
happens in P1 when glance and chain validation consume them:

`graph_planned` · `graph_validated` · `graph_build_started` ·
`graph_node_materialized` · `graph_build_completed`

Each promotion updates the enum, regenerates the doc
(`gen-audit-events-doc.ts --write`) and keeps `check:audit-parity` green.
Chain validators must keep recognizing `dispatch_* → gate_passed` sequences
with graph events interleaved.

## 7. The route from here

**P1 — after the PR #57 merge, where the value compounds**

1. **Build wires to the creator, not the scaffold.** Each seat-bearing node
   dispatches the agentic creator (`skills/businesses/SKILL.md`) as a phase
   of the compiled manifest; `init-business.ts` stays the primitive the
   creator calls. The four fixed templates stop being the ceiling; the build
   button unlocks.
2. **Graph events into the closed enum** (§6).
3. **Durable resume** (§5).
4. **The canvas lands in glance, editing before creating.** The measured gap
   stands: 74 of 574 employees declare a clone; 43 of 60 businesses have no
   grounding at all. A view that shows ungrounded seats and lets you bind
   them solves a countable problem; creation stays the marked exception.
   `studio-server.ts` and standalone `studio.html` do not come across —
   glance already has the server, job runner and design system.

**P2 — opt-in, only after P1 proves use:** gates as declarable graph nodes
(add-only, never remove); the typed-edge table as a versioned protocol
schema; graph-aware routing behind the pre-dispatch auditor
(`seat-sufficiency` is the natural first consumer). pi's benchmark evidence
stands as the warning: below a task-size threshold, structure subtracts value.

**Protocol gap surfaced by the benchmark:** no declaration form exists for
business → squad ("this business uses squad X"), so squads enter the graph
as isolated nodes and closure covers two of the three pillars fully. A small
schema addition completes it; it should ride with P1.

**Hardening deferred:** `dependency missing` stays a warning at buyer install
for one rollout cycle (the pack build gate is the hard failure), then becomes
an error.

## 8. What this document still does not decide

**Whether Marcio carries the Studio half himself.** The one human decision
left, and the ground shifted in his favor: the engine half is done WITH
credit (he is co-author of the algebra commit), his two hardest design calls
(cycle rejection in the entity graph; refusing fake materialization) are
confirmed correct by independent evidence, and `maintainerCanModify` is on —
the mechanical work (rebase, planner rewire, type fixes, builder tests) can
be carried on his branch by the maintainer while authorship stays his. What
he needs to supply is consent and direction, both of which are a comment on
the PR, not a git operation.

**The community registry question** stays out of this repo, unchanged:
`check-engine-purity` keeps entity content out, and P2's versioned schema is
the only hook a future registry would need.
