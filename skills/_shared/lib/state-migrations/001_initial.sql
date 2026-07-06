-- 001_initial.sql — Reduced-scope authoritative state schema.
-- Three tables that suffer most from race conditions today:
--   audit_events       (replaces audit.jsonl)
--   quality_gates      (replaces ad-hoc gate verdict files)
--   decisions_history  (memory-lite — append-only project decisions)
-- Plus schema_migrations for versioning.
--
-- Registries, HANDOFF.json, dag-state.json stay JSON for now (see
-- ~/.claude/skills/harness/FUTURE_IMPROVEMENTS.md Item 5 for full migration).

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- audit_events — single source of truth for cross-cutting events.
CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trace_id TEXT NOT NULL,
  project_id TEXT,
  ts TEXT NOT NULL,
  event TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_trace_ts ON audit_events(trace_id, ts);
CREATE INDEX IF NOT EXISTS idx_audit_project_event ON audit_events(project_id, event);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_events(ts);

-- quality_gates — verdicts from quality-judge runs.
CREATE TABLE IF NOT EXISTS quality_gates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT,
  task_id TEXT,
  phase TEXT NOT NULL,
  verdict TEXT NOT NULL,
  score INTEGER,
  failed_checks TEXT,
  evidence TEXT,
  deterministic_findings TEXT,
  host TEXT,
  ran_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gates_project_phase ON quality_gates(project_id, phase);
CREATE INDEX IF NOT EXISTS idx_gates_ran_at ON quality_gates(ran_at);

-- decisions_history — Item 4a (memory-lite). Append-only, never mutated.
CREATE TABLE IF NOT EXISTS decisions_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  decision_id TEXT NOT NULL,
  text TEXT NOT NULL,
  source TEXT,
  rationale TEXT,
  superseded_by INTEGER REFERENCES decisions_history(id),
  recorded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_decisions_project_ts ON decisions_history(project_id, recorded_at);
CREATE INDEX IF NOT EXISTS idx_decisions_id ON decisions_history(decision_id);
