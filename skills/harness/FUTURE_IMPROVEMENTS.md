# Harness — Future Improvements (Items 5–7)

> **Status:** specification only — not yet implemented.
> **Owner:** Nirvana harness team.
> **Last updated:** 2026-05-04
> **Source:** synthesized from `(base de conhecimento interna)` (17 sources, May 2026)

This document specifies three reliability improvements deferred from the current phase. Items 1–4 (LoopGuard, Quality Judge, HANDOFF/resume, Context Budget Probe) are already shipped. Items 5–7 are higher effort and lower urgency, but together they close the remaining gaps between Nirvana's current single-machine harness and the durable, multi-tenant, multi-session pattern adopted by GSD 2.0, LangGraph Cloud, Mastra, and Temporal-style systems.

Each item below is structured the same way:

- **Goal** — what problem this solves.
- **Why now / why not now** — strict criteria for when this becomes worth the cost.
- **Design overview** — the data model, lib API, and integration shape.
- **Schema / API sketch** — concrete tables, function signatures, file layout.
- **Integration points** — exactly which existing files would change.
- **Esforço estimado** — engineering days, including migration of existing data.
- **Dependencies** — what must already exist before this item can be started.
- **Tradeoffs accepted** — what we are explicitly choosing not to solve.
- **References** — anchors back into the research synthesis.

---

## Item 5 — SQLite Authoritative State

### Goal

Replace markdown + JSON files (HANDOFF.json, dag-state.json, audit.jsonl, project-plan.json, registry index) as the source of truth for project state with a single SQLite database per project. Markdown stays as a human-readable view, generated from the DB.

The crux: today, multiple parallel sessions on the same project (e.g. user editing while a maestro batch is running) can race on these files. There is no transaction boundary, no foreign keys, no atomic queries. SQLite gives us all three for free at zero infra cost.

### Why now / why not now

**Now if:**
- The user runs more than one Claude Code session against the same project simultaneously (ever observed conflicts).
- A second machine or CI agent needs to read project state while the primary session is active.
- We hit a real bug from concurrent writes (e.g. dag-state.json corruption mid-write).

**Not now because:**
- Today's flow is single-session, single-machine. Files-as-state has not produced a real incident.
- Migration cost is high: every loader (paths.js, scope.ts, project-plan.ts, audit.js, dag-state.ts, registry-loader.js) reads from disk paths. Switching the substrate touches >20 files.
- Markdown is grep-able and commit-able. SQLite is opaque without tools. Adoption friction is real for the user.

### Design overview

One DB file per project at `<project_root>/.nirvana/state.db`. Schema versioned with `PRAGMA user_version`. Read paths cached in memory; write paths use short transactions. Markdown views (HANDOFF.md, audit.md, dag.md) generated on-demand by a `state-snapshot.ts` script — never authoritative, just rendered.

Key insight from GSD 2.0 (`.gsd/gsd.db`): they ship a single SQLite file with a `migrations/` table for schema evolution and a `views/` set of saved queries that the Pi SDK and CLI both call. Same shape works for us.

### Schema / API sketch

```sql
-- migrations
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- one row per project
CREATE TABLE projects (
  id TEXT PRIMARY KEY,                  -- e.g. proj-20260505-ads-intelligence
  business_slug TEXT NOT NULL,
  brief_original TEXT NOT NULL,
  amplified_brief TEXT,
  phase TEXT NOT NULL CHECK(phase IN ('plan','execute','verify','ship','complete')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  fingerprint TEXT NOT NULL             -- sha1 of last meaningful state
);

-- DAG nodes (replaces dag-state.json)
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  wave INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','running','done','failed','skipped')),
  acceptance_criteria TEXT,             -- JSON array
  artifact_path TEXT,
  started_at TEXT,
  finished_at TEXT,
  error TEXT
);
CREATE INDEX idx_tasks_project_wave ON tasks(project_id, wave);
CREATE INDEX idx_tasks_status ON tasks(status);

CREATE TABLE task_deps (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  PRIMARY KEY(task_id, depends_on)
);

-- handoffs (replaces HANDOFF.json + handoffs/*.md)
CREATE TABLE handoffs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  handoff_timestamp TEXT NOT NULL,
  phase TEXT NOT NULL,
  last_task_completed TEXT,
  next_task_id TEXT,
  decisions TEXT NOT NULL DEFAULT '[]', -- JSON array
  open_questions TEXT NOT NULL DEFAULT '[]',
  resumption_prompt_hint TEXT,
  fingerprint TEXT NOT NULL
);
CREATE INDEX idx_handoffs_project_ts ON handoffs(project_id, handoff_timestamp);

-- audit (replaces audit.jsonl)
CREATE TABLE audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trace_id TEXT NOT NULL,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  ts TEXT NOT NULL,
  event TEXT NOT NULL,                  -- enum from audit.js ALLOWED_EVENTS
  payload TEXT NOT NULL                 -- JSON blob
);
CREATE INDEX idx_audit_trace ON audit_events(trace_id, ts);
CREATE INDEX idx_audit_project_event ON audit_events(project_id, event);

-- quality gate verdicts (one row per gate run)
CREATE TABLE quality_gates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  phase TEXT NOT NULL,                  -- 'plan' | 'post_execution' | 'pre_ship'
  verdict TEXT NOT NULL,                -- 'pass' | 'fail' | 'needs_revision' | 'skipped'
  score INTEGER,
  failed_checks TEXT,                   -- JSON array
  evidence TEXT,                        -- JSON array
  ran_at TEXT NOT NULL
);
```

JS API (`~/.claude/skills/_shared/lib/state-db.js`):

```js
function openDb(projectRoot)              // returns { db, close }
function migrate(db)                       // runs pending migrations
function upsertProject(db, partial)        // by id; returns row
function recordTaskTransition(db, task_id, status, fields?)  // atomic
function appendHandoff(db, partial)        // INSERT, never UPDATE
function emitAudit(db, event, payload)     // INSERT into audit_events
function snapshotMarkdown(db, project_id)  // returns { handoff_md, audit_md, dag_md }
```

Reads return plain JS objects with the same shape as today's JSON files, so callers don't change interface — only substrate.

### Integration points

Files that today read/write project state (and would migrate):

- `~/.claude/skills/_shared/lib/handoff.js` (already created in Item 3) — swap fs read/write for `state-db` calls; keep the same exports.
- `~/squads/business-nirvana-maestro/scripts/dag-status.ts` — read DAG from DB, render markdown view.
- `~/.claude/skills/businesses/scripts/brief-business.ts` — `INSERT` into `projects`, drop initial handoff via `appendHandoff`.
- `~/.claude/skills/harness/lib/audit.js` — dual-write to JSONL and DB during transition; cut JSONL once stable.
- `~/.claude/skills/_shared/scripts/resume-project.ts` — read latest handoff via SQL query, not file scan.
- `~/.claude/skills/glance/server.ts` — read everything from DB; massive simplification of the `/api/projects` endpoint.

A `state-snapshot.ts` script generates `HANDOFF.md`, `audit.md`, `dag.md` for human reading. Run automatically after every `appendHandoff`.

### Esforço estimado

- **Lib + migrations:** 1 day.
- **Migration of existing markdown projects to DB:** 1 day (one-time `migrate-projects-to-db.ts` script that walks `.nirvana/logs/` + `.projects-outputs/`).
- **Refactor 6 callers:** 2 days.
- **Glance UI updates:** 1 day.
- **Smoke matrix + regression:** 1 day.
- **Total: ~6 engineering days.**

### Dependencies

- Need `bun:sqlite` (already in Bun runtime, zero deps).
- Need a one-shot migration script that reads existing markdown projects and seeds the DB. Existing data must not be lost.
- Item 3 (HANDOFF.json) must be fully adopted first — it provides the schema we're porting.

### Tradeoffs accepted

- **Markdown becomes secondary.** Power users who grep `audit.jsonl` will need to either run `state-snapshot` or learn `sqlite3 .nirvana/state.db "select event from audit_events…"`.
- **No multi-region replication.** SQLite is local-file. If we ever go multi-machine, we add LiteFS or move to Postgres later (Item 5.5, undocumented).
- **Single writer assumption stays.** SQLite handles concurrent reads fine, but heavy parallel writes need WAL mode + retry logic. We enable WAL by default; if write contention shows up, we add a write queue.

### References

- GSD 2.0 architecture: `(base de conhecimento interna)` § "GSD as reference architecture".
- LangGraph checkpointer pattern: same doc § "State-as-database in production frameworks".
- Mastra Observational layer: same doc § "Observability and state separation".

---

## Item 6 — Memory Layer with Semantic Recall

### Goal

Today, agents have no persistent memory across sessions. Decisions, lessons learned, prior project briefs, and entity facts (about the user, about a business, about a squad's track record) are either lost or re-discovered every run. We want a unified memory lib with three tiers — working, long-term, entity — and a single retrieval API: "recall the 5 most relevant memories for this prompt".

CrewAI's Memory (working / long / entity / contextual), Mastra's Observational + Memory, and Mem0's recall-by-vector-similarity all converge on this pattern. The research synthesis explicitly calls this out as the bridge between "agent that finishes a task" and "agent that learns over time".

### Why now / why not now

**Now if:**
- We see the same user correction more than twice in different sessions ("don't use bash", "humanize outputs"). That's a memory leak.
- Maestro auditor needs to recall past failures of a squad to weight its current verdict.
- The user complains "you forgot what we discussed yesterday." Today, that's actually true — context is gone unless they re-paste.

**Not now because:**
- The auto-memory system in `~/.claude/projects/.../memory/MEMORY.md` already covers ~80% of the working/long-term need for the user themselves.
- Vector store adds a real dependency (faiss-cpu, Chroma, or a hosted service like Pinecone). We've stayed dependency-light on purpose.
- Without Item 5 (SQLite), there's no clean substrate to attach memory rows to — we'd be adding a third state layer.

### Design overview

Three memory types, all behind one lib:

| Type        | Purpose                             | Substrate                                     | TTL           |
| ----------- | ----------------------------------- | --------------------------------------------- | ------------- |
| working     | Within a single project run         | DB rows tagged with `project_id`              | until project completes |
| long_term   | Cross-project lessons, decisions    | DB rows + vector embedding for semantic recall | forever (user can prune) |
| entity      | Facts about people / squads / businesses | DB rows keyed by entity_id + type             | forever        |

Single retrieval API:

```js
const memories = await recall({
  query: "should i use bash for this script",
  scope: ['long_term', 'entity'],     // which tiers to search
  k: 5,
  filters: { entity_type: 'user' }
});
// → [{ type, text, source, embedding_distance, recorded_at }, ...]
```

Storage uses two paths:
1. **Lexical fallback:** SQLite FTS5 (built into Bun's sqlite). Always works.
2. **Semantic recall:** local embedding model (`@xenova/transformers` with `all-MiniLM-L6-v2`, 23MB, runs in WASM). Optional — if model not present, fall back to FTS5-only.

Embeddings stored in a `memory_embeddings` table with cosine similarity computed in JS over the result set. For ≤10K memories, this is sub-100ms — fine. Beyond that, switch to faiss or sqlite-vss.

### Schema / API sketch

Extends the SQLite schema from Item 5:

```sql
CREATE TABLE memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL CHECK(type IN ('working','long_term','entity')),
  scope TEXT NOT NULL,                  -- project_id for 'working', 'global' for long_term, entity_id for 'entity'
  entity_type TEXT,                     -- 'user' | 'squad' | 'business' | 'project' | null
  text TEXT NOT NULL,
  source TEXT,                          -- where it was learned ('user_correction', 'audit_finding', 'gate_verdict', ...)
  recorded_at TEXT NOT NULL,
  superseded_by INTEGER REFERENCES memories(id),
  metadata TEXT                         -- JSON
);
CREATE INDEX idx_memories_scope_type ON memories(scope, type);
CREATE VIRTUAL TABLE memories_fts USING fts5(text, content=memories, content_rowid=id);

CREATE TABLE memory_embeddings (
  memory_id INTEGER PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
  model TEXT NOT NULL,                  -- e.g. 'all-MiniLM-L6-v2'
  vector BLOB NOT NULL                  -- Float32Array as bytes
);
```

Lib API (`~/.claude/skills/_shared/lib/memory.js`):

```js
async function record({ type, scope, text, source, entity_type?, metadata? })
async function recall({ query, scope?, k=5, filters? }): Memory[]
async function supersede(old_id, new_id)
async function prune({ older_than?, scope?, type? })
function stats(): { by_type, by_scope, embedding_coverage }
```

Auto-record hooks:
- After `runQualityJudge` returns `fail`: record the failed_checks as long_term memory tagged `source: 'gate_verdict'`.
- After Maestro auditor rejects a squad output: record the reason as entity memory keyed to that squad.
- After a user correction matches the patterns in `~/.claude/CLAUDE.md`'s feedback rules: record as long_term.

### Integration points

- New file `~/.claude/skills/_shared/lib/memory.js`.
- Wire into `~/.claude/skills/_shared/lib/quality-judge.js` (auto-record failures).
- Wire into `~/.claude/skills/squads/lib/squad-audit-consensus.js` (record per-round verdicts as entity memory).
- Inject recall into `~/.claude/skills/_shared/lib/host-agent-driver.js` persona builder: prepend top-3 long_term memories matching the user prompt to the persona, marked as "Prior context you should be aware of". This is the actual leverage — agents wake up already knowing relevant lessons.
- Glance UI: new Memory tab listing memories by type with prune controls.

### Esforço estimado

- **Lib + schema migration:** 1 day.
- **Embedding integration (`@xenova/transformers`):** 1 day. Includes graceful degradation when model not downloaded.
- **Auto-record hooks (3 sites):** 1 day.
- **Persona injection:** 0.5 day.
- **Glance Memory tab:** 1.5 days.
- **Smoke matrix:** 0.5 day.
- **Total: ~5.5 engineering days.**

### Dependencies

- **Item 5 must be done.** Memory lives in the same SQLite DB; without it we'd build a parallel substrate.
- `@xenova/transformers` (~25MB download on first use; offline-capable after that). Optional — lib works without it, just no semantic recall.

### Tradeoffs accepted

- **No cloud sync.** Memory is per-machine. If user moves laptops, memory doesn't follow. Acceptable for now; revisit if multi-device becomes real.
- **No memory editing UI in CLI.** Glance handles it. CLI users edit via SQL.
- **Embedding drift over time.** If we change models, old embeddings become incompatible. Mitigation: store `model` column, recompute lazily on next recall when model mismatch detected.

### References

- CrewAI Memory: `(base de conhecimento interna)` § "Memory layers in production frameworks".
- Mem0 architecture: same doc § "Vector stores for agent recall".
- Mastra Observational pattern: same doc § "Memory as observability".

---

## Item 7 — Durable Execution (Temporal / Restate / DBOS adapter)

### Goal

Long-running workflows (a 6-hour Maestro plan execution; an audit batch over 153 squads; a 408-mind-clone translation run) should survive process crashes, machine reboots, and host-runtime version changes — and resume from the exact point of failure with zero re-work and zero double-execution.

Today, if Maestro crashes at wave 4 of 7, we have HANDOFF.json to bootstrap context, but every prior wave's effects re-execute the moment we resume because we don't journal individual operation outcomes. Quality Judge calls, file writes, audit emissions — all replay-unsafe.

Temporal, Restate, and DBOS solve this with the same primitive: **journal every effectful operation; on resume, replay the journal and skip operations that already succeeded.** The agent code stays imperative; the runtime makes it durable.

### Why now / why not now

**Now if:**
- A workflow runs longer than 1 hour and a crash mid-way costs >$1 of LLM calls to recover from.
- Maestro starts running on a remote/CI environment where reboots are routine.
- We need exactly-once semantics for external side effects (sending emails, posting to APIs, charging cards).

**Not now because:**
- Today's longest workflow is the 408 translation run (~hours), and it already has its own checkpoint cache. Generic durability isn't the bottleneck.
- Temporal is heavy: requires a service (Cassandra/Postgres), a worker pool, and a re-architecture of agent code into "workflows" + "activities". Restate is lighter but still a service. DBOS embeds in Postgres but pulls in PG.
- For local-first single-user use, the marginal benefit over HANDOFF + journaled audit log is small.

### Design overview

Two-layer approach, in order of cost:

**Layer A — embedded journal (low effort, high coverage of common cases).**

Add a `workflow_journal` table to the SQLite DB. Wrap effectful operations (LLM calls, file writes, audit emissions, gate runs) in a `journaled(opId, fn)` helper that:
1. Computes a stable opId from the call site + args hash.
2. Checks `workflow_journal` for `opId` with `status='completed'`. If found, returns the cached result.
3. Otherwise runs `fn`, writes result to journal, returns it.
4. On crash + restart, the same workflow re-runs; journaled ops short-circuit to cached results; un-journaled ops execute fresh.

This is "poor-man's Temporal" — no separate service, no DSL, just disciplined op wrapping. Covers ~80% of the value at ~10% of the cost.

**Layer B — adapter to a real durable runtime (deferred until justified).**

When Layer A's limits hurt (e.g. we need timer-based workflows: "wait 24h, then retry"; or signal-based: "external system pings us, resume"), we add a thin adapter that exposes the same `journaled()` API but routes to Restate or DBOS underneath. Agent code doesn't change.

Restate is the leading candidate per the research: TypeScript-native, ships as a single binary, no Cassandra. DBOS is second choice if we already have Postgres for other reasons.

### Schema / API sketch

Layer A schema (extends Item 5 DB):

```sql
CREATE TABLE workflow_journal (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id TEXT NOT NULL,            -- e.g. 'maestro-exec-<project_id>' or 'audit-batch-<ts>'
  op_id TEXT NOT NULL,                  -- stable hash of call_site + args
  status TEXT NOT NULL CHECK(status IN ('running','completed','failed')),
  result_json TEXT,                     -- serialized return value
  error TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  attempt INTEGER NOT NULL DEFAULT 1,
  UNIQUE(workflow_id, op_id)
);
CREATE INDEX idx_journal_workflow_status ON workflow_journal(workflow_id, status);
```

API (`~/.claude/skills/_shared/lib/durable.js`):

```js
function startWorkflow(workflow_id, projectRoot)
async function journaled(workflow_id, op_id, fn): Promise<T>
function listIncomplete(): Workflow[]
async function resume(workflow_id): Promise<void>
async function abort(workflow_id, reason)
```

Usage at call site:

```js
// before:
const verdict = await runQualityJudge({ phase, artifact, rubric_path });

// after:
const verdict = await journaled(
  workflow_id,
  `gate:${phase}:${task_id}`,
  () => runQualityJudge({ phase, artifact, rubric_path })
);
```

Op IDs must be deterministic across resumes — hash of (call site location + stable args), not random. The discipline here is real but bounded: there are ~6 effectful surfaces in the harness today (LLM call, file write, audit emit, gate run, handoff write, dag transition).

### Integration points

- New file `~/.claude/skills/_shared/lib/durable.js`.
- Wrap calls in:
  - `~/squads/business-nirvana-maestro/scripts/executor.ts` (per-task LLM dispatch).
  - `~/.claude/skills/squads/scripts/audit-batch-orchestrator.ts` (per-squad pipeline).
  - `~/.claude/skills/squads/scripts/improve-squad.ts` (per-stage: score, consensus, validate, judge, verifier).
  - `~/.claude/skills/_shared/lib/quality-judge.js` (the LLM call itself — caches per artifact hash).
- New CLI `~/.claude/skills/_shared/scripts/resume-workflow.ts` — lists incomplete workflows, resumes by ID. Sister to `resume-project.ts`.
- Glance UI: incomplete-workflows widget in the dashboard.

### Esforço estimado

**Layer A only (recommended scope):**
- Lib + schema: 1 day.
- Wrap 6 effectful surfaces: 2 days.
- Resume CLI + Glance widget: 1 day.
- Smoke matrix (kill -9 mid-workflow, verify resume idempotence): 1 day.
- **Total: ~5 engineering days.**

**Layer B (Restate adapter, if and when needed):**
- Adapter lib: 2 days.
- Restate operator deployment doc: 1 day.
- Migration of existing workflows: 1 day.
- **Total: +4 engineering days on top of Layer A.**

### Dependencies

- **Item 5 must be done.** Journal lives in SQLite.
- Stable op-site identification (each effectful call site needs a stable identifier — straightforward but requires care during refactors).

### Tradeoffs accepted

- **Layer A alone doesn't handle timers or external signals.** Workflows that need "wait 24h then retry" still need cron + state. Layer B fills that gap.
- **Determinism discipline is real.** If a wrapped function depends on `Date.now()` or `Math.random()`, we have to inject those as args, or the op won't be replayable. We document the rules; we can't enforce them automatically without a runtime.
- **Journal grows unbounded.** Add a TTL prune (default 30 days for completed workflows) in the same script that prunes audit events.

### References

- Temporal pattern: `(base de conhecimento interna)` § "Durable execution: Temporal as the canonical reference".
- Restate evaluation: same doc § "Lightweight alternatives — Restate and DBOS".
- Journal-and-replay primitive: same doc § "Journaling effectful operations".

---

## Cross-cutting notes

### Dependency order

These three items have a strict order:

```
Item 5 (SQLite state) → Item 6 (Memory) ↘
                                          → composable
                      → Item 7 (Durable) ↗
```

Items 6 and 7 both depend on Item 5's substrate. Doing 6 or 7 first means building the SQLite layer twice or maintaining two substrates indefinitely.

### Risk gradient

- **Item 5** is the safest. Migration script is one-shot and reversible (markdown stays as backup).
- **Item 6** has the most user-visible behavior change. If memory injection makes agents worse (over-conditioning on stale lessons), we need a kill switch from day one.
- **Item 7** is the most invasive technically. The discipline of stable op-IDs is non-trivial; bugs here cause silent skipped operations on resume, which is worse than crashing.

### When to revisit

Reassess this document quarterly, or when any of these triggers fires:

- A real incident caused by file-state race (→ trigger Item 5).
- User repeats the same correction in 3+ separate sessions (→ trigger Item 6).
- A workflow longer than 1 hour crashes and we lose >$1 of LLM work (→ trigger Item 7 Layer A).
- Multiple machines or CI agents need to coordinate on the same project (→ Item 5 + possibly Item 7 Layer B).

Until then: ship features on the existing substrate, watch for the triggers, don't pre-build.
