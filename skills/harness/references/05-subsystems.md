# Reference 05 — Optional subsystems (nirvana-evolution)

These ship in the harness and are available when the brief warrants them. **None is mandatory** — reach for them when the situation fits. Loaded on demand; not part of the core pipeline.

## Semantic memory (cross-session context reuse)

To carry context across dispatches or ground a mind-clone in prior work:

```ts
import { MemoryStore } from "~/.nirvana/skills/_shared/lib/memory-store.ts";
const mem = new MemoryStore(businessRoot);
const hits = mem.retrieve(query, { business: slug, k: 5 });
```

Offline hash-TF-IDF embedder (zero deps). `memory-gc` handles TTL eviction + dedup. Use when a project spans multiple sessions or when an employee should recall earlier decisions.

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
