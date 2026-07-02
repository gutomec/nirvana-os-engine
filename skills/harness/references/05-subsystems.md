# Reference 05 — Optional subsystems (nirvana-evolution)

These ship in the harness and are available when the brief warrants them. **None is mandatory** — reach for them when the situation fits. Loaded on demand; not part of the core pipeline.

## Semantic memory (cross-session context reuse)

To carry context across dispatches or ground a mind-clone in prior work:

```ts
import { MemoryStore } from "~/.claude/skills/_shared/lib/memory-store.ts";
const mem = new MemoryStore(businessRoot);
const hits = mem.retrieve(query, { business: slug, k: 5 });
```

Offline hash-TF-IDF embedder (zero deps). `memory-gc` handles TTL eviction + dedup. Use when a project spans multiple sessions or when an employee should recall earlier decisions.

## Streaming outputs (long-form deliverables)

For books, long reports, or anything generated in chunks, persist + sanity-check each chunk as it lands:

```ts
import { ChunkWriter } from "~/.claude/skills/harness/lib/chunk-writer.ts";
import { checkChunk } from "~/.claude/skills/harness/lib/chunk-gate.ts";
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
| `*brief "<text>" [--project <id>]` | Process a brief (Agentic Mode by default) |
| `*find "<intent>"` | BM25 discovery (`fast` mode; diagnostic in agentic) |
| `*list squads` / `*list businesses` / `*list capabilities` | List registry contents |
| `*list mind-clones [category]` | List mind-clones by category |
| `*inspect <target>` | Show full manifest of a target |
| `*index` | Rebuild registries |
| `*audit <project>` | Show audit trail |
| `*cost [--project <id>] [--business <slug>]` | Cost summary |
| `*glance [--allow-actions]` | Open the Glance web cockpit |

When the user types "abra o glance" / "open the cockpit" / "show me the project state", invoke `glance --allow-actions`.

## Diagnostic helpers (never authoritative in agentic mode)

| Tool | Purpose | When to use |
|---|---|---|
| `bun scripts/find.ts --json "<brief>"` | BM25 + keyword discovery (`fast` mode engine) | The fast-mode pick; in agentic mode, a sanity-check peek |
| `bun scripts/route.ts "<brief>"` | Full BM25 routing pipeline (`fast` mode) | Same + budget pre-flight |
| `bun scripts/index.ts` | Rebuild registries | After adding/editing businesses or squads |
| `bun scripts/validate.ts` | Self-test (registries, BM25, audit) | Before a big production run |
| `glance --allow-actions` | Web cockpit (live audit + decisions + gates) | When watching a run live |

### Known issues with the BM25 (`fast`) router — when to overrule it in agentic mode

- Stage 0 keyword short-circuit can emit `signal=HIGH` at score 0.5 (one keyword of two matched in a route pattern). This routinely picks an unrelated target when a brief shares one common word with any registered route pattern.
- Stage -1 meta-intent detection requires specific keywords or 3+ action verbs; many simple briefs miss it.
- The router has no notion of "the right mind-clone for this voice" — that is pure agentic reasoning; the script cannot do it.
