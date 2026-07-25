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

### O router `fast` (BM25 + denso) — estado e quando ainda preferir o agêntico

O router `fast` foi calibrado e recebeu um braço semântico opcional:
- `keywords` / `example_briefs` / `produces` dos manifestos agora entram no índice BM25 (com peso), então especialistas de vocabulário estreito não ficam mais invisíveis.
- O intent gate não trata mais substantivos de negócio (empresa/cliente/business) como verbos de gestão — deixar de ocultar as squad_capabilities.
- Stage 0 se abstém quando o pattern é só objeto genérico (landing/page/copy…), deixando o matching decidir por domínio.
- As alternativas saem ordenadas por score, e o business-first promove só o melhor business (não soterra squads).
- **Braço denso opcional:** `nrv embeddings enable` liga um modelo neural local (ONNX, sem Python) fundido ao BM25 por Reciprocal Rank Fusion — recupera sinônimo/paráfrase que o BM25 não pega. Sem ele, o router é lexical (fallback zero-dep).

Resíduos que ainda justificam o modo agêntico como fonte da verdade:
- Stage 0 e Stage -1 seguem keyword-based (agora podados/gateados, mas não semânticos por si).
- O router não tem noção de "o mind-clone certo para esta voz" — isso é raciocínio agêntico puro; o script não faz.
- Sem o braço denso ativo, o matching é lexical.
