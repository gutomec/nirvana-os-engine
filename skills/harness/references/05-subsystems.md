# Reference 05 — Optional subsystems (nirvana-evolution)

These ship in the harness and are available when the brief warrants them. **None is mandatory** — reach for them when the situation fits. Loaded on demand; not part of the core pipeline.

## Semantic memory (cross-session context reuse)

To carry context across dispatches or ground a mind-clone in prior work:

```ts
import { MemoryStore } from "~/.nirvana/skills/_shared/lib/memory-store.ts";
const mem = new MemoryStore(businessRoot);
const hits = mem.retrieve(query, { business: slug, k: 5 });
```

Offline hash-TF-IDF embedder (zero deps). `nrv memory gc <business>` runs TTL eviction + dedup (permanent scope never expires). Use when a project spans multiple sessions or when an employee should recall earlier decisions.

## Streaming outputs (long-form deliverables)

For books, long reports, or anything generated in chunks, persist + sanity-check each chunk as it lands:

```ts
import { ChunkWriter } from "~/.nirvana/skills/harness/lib/chunk-writer.ts";
import { checkChunk } from "~/.nirvana/skills/harness/lib/chunk-gate.ts";
```

`checkChunk` runs cheap per-chunk heuristics (min length, truncation marks, em-dash overuse, JSON validity) so corruption is caught mid-stream instead of after the whole artifact. Non-blocking warnings.

## Self-improvement (Meta-Nirvana)

The system mines its own audit log and proposes improvements. Run periodically (not per-dispatch):

```bash
nrv improver run [--days=N]    # mine audit, write proposals
nrv improver list              # review proposals
nrv improver show <id>         # detail
nrv improver accept/reject <id>
```

Detects LOW_GATE_PASS_RATE, REVISION_HOTSPOT, COST_OUTLIER, AMPLIFICATION_GAP, SQUAD_FAILURE_RATE. Proposals are human-reviewed, never auto-applied. Quality depends on audit completeness — run after the audit chain is healthy (`nrv validate-chain --all`).

## Observability (inspect what happened)

```bash
nrv baseline --days=30 --save  # snapshot KPIs
nrv glance                     # web cockpit → /observability for trace tree + anomalies
nrv audit-view <project>       # terminal audit chain
```

The trace-builder correlates Claude Code hook events (`session_id`) with harness events (`trace_id`). Without it, cost/latency per dispatch is unmeasurable.

## Quick commands

| Command | Description |
|---|---|
| `nrv run <business> "<brief>"` / `nrv auto "<brief>"` | Process a brief end to end (dispatch + gate + deliver) |
| `nrv find "<intent>"` / `*find` | BM25 discovery (`fast` mode; diagnostic in agentic) |
| `nrv list-squads` / `nrv list-businesses` / `nrv list-clones` | List registry contents |
| `nrv inspect-clone <slug>` | Inspect a mind-clone; squads/businesses: read their manifests |
| `nrv index` / `*index` | Rebuild registries |
| `nrv audit <project>` / `*audit` | Show audit trail |
| `nrv baseline` · `nrv glance` (cost tab) | Cost/KPI summary |
| `nrv glance [--allow-actions]` / `*glance` | Open the Glance web cockpit |

When the user types "abra o glance" / "open the cockpit" / "show me the project state", invoke `glance --allow-actions`.

## Diagnostic helpers (never authoritative in agentic mode)

| Tool | Purpose | When to use |
|---|---|---|
| `bun scripts/find.ts --json "<brief>"` | BM25 + keyword discovery (`fast` mode engine) | The fast-mode pick; in agentic mode, a sanity-check peek |
| `bun scripts/route.ts "<brief>"` | Full BM25 routing pipeline (`fast` mode) | Same + budget pre-flight |
| `bun scripts/index.ts` | Rebuild registries | After adding/editing businesses or squads |
| `bun scripts/validate.ts` | Self-test (registries, BM25, audit) | Before a big production run |
| `glance --allow-actions` | Web cockpit (live audit + decisions + gates) | When watching a run live |

### The `fast` router (BM25 + optional dense fallback) — state, and when to still prefer agentic

The `fast` router was calibrated across routing-360 (full detail: `references/01-routing.md`):
- Manifest `keywords` / `example_briefs` / `produces` are indexed with field weights, so narrow-vocabulary specialists are no longer invisible.
- The intent FILTER is opt-in (`NIRVANA_ROUTER_INTENT_FILTER=1`) — measured against the census it only destroyed accuracy, so business nouns can no longer hide squad capabilities by class.
- Stage 0 abstains on generic-object patterns (landing/page/copy/...), letting the matching decide by domain.
- Alternatives come out score-ordered, and business-first promotes only the best business as a TIEBREAK (a materially better squad wins).
- Coverage gates make NO_MATCH honest: an out-of-domain brief abstains instead of dispatching a confident wrong target.
- **Optional dense arm — fallback slot only:** `nrv embeddings enable` turns on a local neural model consulted ONLY when BM25 ends at NO_MATCH, returning an AMBIGUOUS suggestion (never a dispatch). The BM25/dense RRF fusion was measured twice and retired; without the backend the router is purely lexical (zero-dep).

Residuals that keep agentic mode the source of truth:
- Stage 0 and Stage -1 remain keyword-based (pruned and gated, but not semantic).
- The router has no notion of "the right mind-clone for this voice" — that is pure agentic reasoning; the script does not do it.
- Without the dense fallback active, matching is lexical.

## Scripted autopilot: routing fallbacks and exit codes

The scripted autopilot (`nrv dispatch --auto ... --exec`, `nrv run`, `nrv auto`) resolves the same Business → Squad → agent-x cascade deterministically (`lib/dispatch-cascade.ts`):

- A `no_match` route dispatches agent-x instead of exiting: NO_MATCH changes *who* executes, never *whether*.
- An ambiguous route offers a numbered TTY choice or auto-picks the top candidate (`x_route_ambiguous_autopicked`); `--strict-route` fails instead.
- A router transport failure rides the ladder retry → agent-x (`routing.on_router_failure: agent-x-only`, the default: a keyword match never substitutes for a broken agentic transport; `fail` dispatches nothing).
- A brief that opens by naming an installed target (`use squad <slug>:` / `use business <slug>:`) goes straight to it with no router.
- A squad-only route dispatches the squad (`lib/squad-exec.ts`), and every path flows into the fail-closed delivery pipeline (`lib/delivery-pipeline.ts`).

Exit codes: `0` delivered · `1` run failed · `2` delivery WITHHELD (gate failed after the revision budget) · `3` INDETERMINATE (nothing judged: zero gateable artifacts, or a scaffold-only run without `--exec`) · `4` invalid args. A runtime that returns an error verdict but left artifacts on disk does not abandon them: the run is marked `failed` with its error (`x_runtime_errored_with_artifacts`, `meta.runtime_errored`) and recovers into the same verify → gate pipeline, so an errored run still ends delivered, withheld or indeterminate, never unjudged.

## Run ledger & supervisor internals

What happens to a run nobody closed. The orchestrator-facing side (who opens, who closes, `status` / `wait`) is in the harness SKILL; the kernel view is `docs/architecture/run-kernel-operations.md`.

**Liveness.** `nrv supervisor sweep` finds expired leases, `nrv supervisor status|watch` inspects them, and every `nrv dispatch`/`nrv run` triggers a lazy background sweep on start (`maybeSweep`, under 20ms when nothing is pending). A scripted run is resumed or re-dispatched. An agentic run cannot be (no session to resume, no pid of ours to signal), so the sweep asks whether the trace has shown any life since it last looked: a beat on the row, an active or freshly delivered child run in the same project (the squad an employee dispatched), a hook event of the trace, or a write under `--outputs`. The audit records which one (`x_ledger_grace_extended.liveness_source`). With life, the lease is extended; with none, the run escalates at once, its artifacts go once through the same verify → gate path, and the human is notified with what was found. Long runs report in every 30 minutes (`x_ledger_progress_ping`; `NIRVANA_PROGRESS_PING_SEC=0` silences it).

**Recovery ends in the delivery pipeline, never in a private verdict.** A re-dispatch hands its fresh output to `runDelivery()` (verify → gate → delivered | withheld | indeterminate), and a resume reads `nrv revise`'s exit code (0 delivered · 2 withheld · 3 indeterminate). Both run with zero auto-revisions: an unattended sweep must not spend LLM budget in a fix loop nobody is watching, so a failing gate is withheld and escalated for a human to run `nrv revise`. A re-dispatch that ran to completion is not capped by the completeness ceiling, which is for interrupted runs.

**Salvage.** When the retries are exhausted the sweep marks the run `stalled` and escalates, and before it does, it salvages what the run left on disk: the artifacts go once through verify → quality gate, read-only (zero revisions, offline rubrics, no runtime spawn). Because an interrupted run's file set is unproven, `delivered` is reachable only when a manifest verification passes; otherwise the best outcome is `withheld` with the gate verdict attached. The escalation (`human_notification_required`, `x_ledger_notify_human`, the stderr block and the OS notification) carries the verdict: artifacts found, gateable count, gate outcome, decision, where the files are. The salvage runs once per run (`meta.salvaged`).
