# harness · Top-Level Agentic Orchestrator

> **Harness Protocol v2.0 (Agentic Mode)** · the model carrying this skill **is** the maestro · audit-trail jsonl · zero-deps BM25 fallback

This skill turns the runtime model into the **maestro**: it reads a free-form brief, optionally researches the web, consults the three registries (businesses + squads + mind-clones), **dispatches** the right targets, runs a quality gate, and verifies the artifact. It does **not** produce the deliverable itself — its output is *dispatches*, and every dispatch leaves a real audit event on disk.

**The source of truth for behavior is [`SKILL.md`](./SKILL.md).** This README is the operator/reference companion: install, scope, CLI helpers, config, troubleshooting. When the two disagree, `SKILL.md` wins.

---

## Two routing modes

Routing is a system property (`config.yaml → routing.mode`, env `NIRVANA_ROUTING_MODE`, flag `--mode`).

| Mode | Who decides the target | Cost | Quality |
|---|---|---|---|
| **agentic** (default) | *You* (the model) reason over the registries and pick | tokens | high |
| **fast** | The BM25/keyword router (`lib/router.js`, `scripts/find.ts`, `scripts/route.ts`) | zero-token, deterministic | lower |

In **agentic** mode the BM25 router is only a **diagnostic peek** — never the verdict. The router has known mis-routing failure modes (Stage 0 keyword short-circuit emits HIGH at a 0.5 score; meta-intent detection is keyword-fragile; it has no notion of "the right mind-clone for this voice"). `SKILL.md` documents when to overrule it. In **fast** mode the router *is* the decision — opt into it only for cost-sensitive runs that tolerate lower quality.

---

## What the maestro actually does (agentic pipeline)

Full contract in `SKILL.md`. Summary of the loop, each step with an audit event:

```
Phase 0  Declare operating window + budget
Phase 1  Understand the brief (verbatim) → brief_received
Phase 1.5 Conversational briefing ONLY when material info is missing
Phase 2  Optional web research → research_completed
Phase 3  Registry consult (two-pass: shortlist → deep confirm) across all 3 pillars
Phase 4  Dispatch cascade: business → squad → agent-x (never produce inline)
Phase 5  Self-administered execution (dispatched entity runs end-to-end, no human in loop)
Phase 6  Quality gate (verify-deliverable + rubric/visual gate) → gate_passed | gate_failed
Phase 7  Verify & deliver (artifact path + audit chain + what was actually used)
```

The **fast**-mode BM25 engine, by contrast, runs a 6-stage classify→match→decide→budget→plan pipeline and stops at a plan (it does not execute). That pipeline is documented in `references/01-routing.md` and `HARNESS_PROTOCOL_V1.md` (legacy spec); it now lives *inside* fast mode.

---

## Execution contract (the rules that make completion honest)

1. **You orchestrate; you don't delegate routing to the script.** Reason over the registries.
2. **Audit-first, fiction-never.** Every dispatch emits a real `dispatch_business`/`dispatch_squad`/`dispatch_agent_x` event; every gate emits `gate_passed`/`gate_failed`. No event → no honest "done".
3. **Don't ship without a quality gate.**
4. **Respect the budget** (see *Budget* below — `0` means unlimited).
5. **Never invent** a business/squad/mind-clone that isn't in the registry; never mark complete without an audit chain.
6. **Dispatch, don't make.** `Write`/`Edit`/`Bash` are for trace artifacts only (audit logs, enriched briefs, plans), never the user's deliverable.

`nrv validate-chain --verify-disk` flags a `gate_passed` with no real on-disk artifact as a `PROTOCOL_VIOLATION`.

---

## Installation

Zero external deps beyond the Bun/Node stdlib.

```bash
mkdir -p ~/.harness-logs
bun ~/.claude/skills/harness/scripts/validate.ts   # auto-bootstrap config + smoke
```

The harness consumes registries created by the `businesses` and `squads` skills:
- `${BUSINESSES_REGISTRY_PATH}` (with `_business_routing` extra for fast-mode Stage 0)
- `${SQUADS_REGISTRY_PATH}` (with `capabilities` + `domains` index for fast-mode Stage 2)

Both paths are env-overridable (precedence: `process.env` → project `.nirvana/` → global `$HOME`). If the registries don't exist yet, the harness loads with empty stubs and emits warnings.

---

## Glance — instant browser-based visualizer

Read-only ephemeral control panel. Apple HIG / Apple Dark / Awwwards themes. Zero install:

```bash
bun ~/.claude/skills/harness/scripts/glance.ts
```

Opens at `http://localhost:<auto-port>` with all squads, businesses, Maestro projects (live D3 DAG), mind-clones, scope info, and a live SSE log tail. Auto-shuts after 30min idle or `Ctrl+C`. Full reference: `GLANCE.md`.

---

## Budget

Defaults live in `config.yaml → budget` and `lib/budget.js`. **A cap of `0` (or any value ≤ 0) means unlimited** — the budget pre-flight is a no-op and Nirvana stays out of the way. Set a positive value to enforce a hard cap (cost / tokens / handoffs / duration); tighten per-business in `business.yaml → run_budget_usd`.

```yaml
budget:
  default_max_cost_usd: 0        # 0 = unlimited
  default_max_tokens: 0          # 0 = unlimited
  default_max_handoffs: 0        # 0 = unlimited
  default_max_duration_seconds: 0
  on_budget_exceeded: warn       # warn | abort | escalate (only when a cap > 0 is set)
```

When a positive cap is set, `lib/budget.js → check()` returns `ok=false` once the estimate exceeds it; `on_budget_exceeded` decides the reaction.

---

## Project scoping (NIRVANA_SCOPE)

The harness is **scope-aware via `paths.js`**: it consumes whichever registries the current scope resolves to. From inside a project with `NIRVANA_SCOPE=project` in `.env`, routing only sees that project's squads/businesses, and logs land in `<project>/.nirvana/logs/harness/`. From global cwd it sees the home installation.

```bash
cd <project>                                            # scope=project → routes over project registries
bun ~/.claude/skills/harness/scripts/find.ts "build me a sales funnel"
bun ~/.claude/skills/harness/scripts/route.ts "..." --scope=merge   # force a scope without editing .env
```

Full contract: `~/.claude/skills/_shared/SCOPE_CONTRACT.md`. Bootstrap a scoped project: `bun ~/.claude/skills/_shared/scripts/init-project.ts <dir>`.

---

## Diagnostic CLI (fast-mode engine + helpers — never authoritative in agentic mode)

| Script | Purpose |
|---|---|
| `find.ts "<brief>"` | BM25 discovery; top-3 matches + decision + invocation plan |
| `route.ts "<brief>"` | Full fast-mode pipeline JSON (all stages) + budget pre-flight |
| `index.ts` | Rebuild registries after adding/editing businesses or squads |
| `validate.ts` | Self-test (config, registries, BM25, audit) |
| `glance.ts` | Web cockpit |
| `quality-gate.ts <artifact> [--auto] [--with-revisions]` | Phase 6 gate (rubrics + visual + LLM judge) |

In agentic mode treat `find.ts`/`route.ts` output as a *suggestion*; override when reasoning disagrees.

---

## Tuning fast-mode thresholds

`config.yaml → routing`:

```yaml
routing:
  mode: agentic                       # agentic (default) | fast
  match_high_threshold: 0.80          # min top score for HIGH
  match_high_lead: 0.15               # min lead over second place
  match_ambiguous_threshold: 0.60     # min for AMBIGUOUS cluster
  match_ambiguous_window: 0.15        # cluster width
```

---

## Audit trail

Every event is one JSON line appended to `${HARNESS_LOGS_DIR}/<YYYY-MM-DD>/audit.jsonl`:

```json
{"ts":"2026-05-02T22:21:34Z","event":"brief_received","trace_id":"...","brief":"audita portfolio"}
{"ts":"2026-05-02T22:21:34Z","event":"dispatch_business","trace_id":"...","business":"strategy-consulting"}
{"ts":"2026-05-02T22:21:34Z","event":"gate_passed","trace_id":"...","artifact":".../board-memo.md"}
```

Query:
```bash
cat ${HARNESS_LOGS_DIR}/$(date +%F)/audit.jsonl | jq -s 'group_by(.event) | map({event: .[0].event, count: length})'
```

Event taxonomy: `references/03-audit.md`. Schema: `~/.claude/skills/_shared/schemas/core-schemas.json#audit_event`.

---

## Architecture

```
~/.claude/skills/harness/
├── SKILL.md                       ← source of truth (Agentic Mode)
├── README.md                      ← this file (operator/reference companion)
├── HARNESS_PROTOCOL_V1.md         ← legacy spec (fast-mode 6-stage pipeline, ~1200 lines)
├── config.yaml                    ← routing mode + thresholds, budget, telemetry
├── lib/
│   ├── router.js                  ← fast-mode 6-stage pipeline (stages -1, 0, 1-5)
│   ├── bm25.js                    ← classic BM25, snake_case-aware, normalized
│   ├── registry-loader.js         ← reads both registries with graceful fallback
│   ├── audit.js                   ← jsonl append-only event logger
│   ├── budget.js                  ← budget estimation (0 = unlimited)
│   ├── dispatch.ts                ← injectMindClones, audit emitters, trace validation
│   ├── dag-planner.ts             ← parallel dispatch over independent targets
│   └── … (chunk-writer, judge, amplifier, glance/, …)
├── scripts/                       ← CLI entrypoints (find, route, index, validate, glance, quality-gate, …)
├── rubrics/                       ← quality-gate rubrics (.md weighted + .ts heuristic)
├── templates/                     ← dispatch-instruction, amplification, intent-classifier
├── references/                    ← 01-routing · 02-budget · 03-audit (deep dives)
└── tests/                         ← unit + smoke + regression snapshot + routing-eval
```

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Maestro follows a bad BM25 pick | Treating fast-mode router as authoritative in agentic mode | Override it; the router is a diagnostic, not a verdict |
| `NO_MATCH` everywhere | Registries empty | `bun scripts/index.ts`, then re-run `index-businesses.ts` / `index-squads.ts` |
| BM25 returns wrong squad (fast mode) | Brief vocabulary far from the examples | `keywords`/`example_briefs` are now indexed — align them; or `nrv embeddings enable` for semantic matching (BM25 + dense via RRF) |
| Regression snapshot shows drift | Live registry grew (benign) | Expected; the snapshot is informational. Real guardrail: `tests/routing-eval/`. Refresh with `regression-runner.ts --save-golden` |
| Audit log not appearing | Permissions or `HARNESS_LOGS_DIR` wrong | `mkdir -p ${HARNESS_LOGS_DIR} && chmod 755 ${HARNESS_LOGS_DIR}` |

---

## Related skills

- **businesses** — provides the businesses registry (fast-mode Stages 0 + 2) and the dispatch primitives the maestro calls
- **squads** — provides the squads registry (fast-mode Stage 2)
- **_shared** — schemas, validators, capability catalog, `agent-x` fallback, `paths.js`

---

## Spec & versioning

- Protocol: **Harness Protocol v2.0 (Agentic Mode)** — `SKILL.md` is canonical.
- Legacy spec: **v1.0** fast-mode 6-stage pipeline — `HARNESS_PROTOCOL_V1.md` (still powers `fast` mode).
- Tests: smoke 6/6 + unit suites; routing behavior guarded by `tests/routing-eval/` (tolerance-based). The exact-match golden snapshot (`tests/regression-runner.ts`) is informational and drifts with the live registry by design.
