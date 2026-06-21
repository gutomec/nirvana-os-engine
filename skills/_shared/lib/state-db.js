/**
 * state-db.js — SQLite-backed authoritative state for race-prone surfaces.
 *
 * Reduced-scope substitute for what was previously scattered across
 * audit.jsonl, ad-hoc gate JSONs and inline decisions in HANDOFF.json. Three
 * tables: audit_events, quality_gates, decisions_history. Registries,
 * HANDOFF.json and dag-state.json continue as JSON files.
 *
 * Substrate: bun:sqlite (built-in to Bun ≥1.0). WAL mode + busy_timeout for
 * safe concurrent reads/writes from multiple processes.
 *
 * Path resolution:
 *   1. NIRVANA_STATE_DB env var (absolute)
 *   2. <projectRoot>/.nirvana/state.db when inside a project
 *   3. ~/.nirvana/state.db (global fallback — shared across all runtimes)
 *
 * The lib is host-agnostic and OS-agnostic. No bash, no /tmp paths, no
 * platform-specific APIs.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

let _Database = null;
function loadSqlite() {
  if (_Database) return _Database;
  try {
    // Bun runtime
    const m = require('bun:sqlite');
    _Database = m.Database;
    return _Database;
  } catch { /* fall through */ }
  try {
    // Node fallback (better-sqlite3) if installed somewhere
    const m = require('better-sqlite3');
    _Database = m;
    return _Database;
  } catch {}
  return null;
}

function resolveDbPath(projectRoot) {
  if (process.env.NIRVANA_STATE_DB) return process.env.NIRVANA_STATE_DB;
  // HOME and OS root are never valid project roots — fall through to global db.
  // (Defends against callers that wrongly resolved scope to HOME when it had
  // .env/.nirvana markers — those creates a stray ~/.nirvana/state.db.)
  const home = path.resolve(os.homedir());
  if (projectRoot && fs.existsSync(projectRoot)) {
    const resolved = path.resolve(projectRoot);
    if (resolved !== home && resolved !== '/') {
      return path.join(resolved, '.nirvana', 'state.db');
    }
  }
  return path.join(os.homedir(), '.nirvana', 'state.db');
}

function ensureDirFor(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

const _openCache = new Map(); // path -> { db, close }
function openDb(projectRoot) {
  const Database = loadSqlite();
  if (!Database) return { db: null, close: () => {}, available: false, reason: 'sqlite-unavailable' };
  const dbPath = resolveDbPath(projectRoot);
  if (_openCache.has(dbPath)) return _openCache.get(dbPath);
  ensureDirFor(dbPath);
  const db = new Database(dbPath);
  // Bun's Database.exec is the way; for better-sqlite3 we'd use db.pragma()/exec
  try { db.exec('PRAGMA journal_mode = WAL'); } catch {}
  try { db.exec('PRAGMA busy_timeout = 5000'); } catch {}
  try { db.exec('PRAGMA synchronous = NORMAL'); } catch {}
  migrate(db);
  const handle = {
    db,
    available: true,
    path: dbPath,
    close: () => { try { db.close(); } catch {} _openCache.delete(dbPath); },
  };
  _openCache.set(dbPath, handle);
  return handle;
}

function migrate(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  const applied = new Set();
  try {
    const rows = db.query('SELECT version FROM schema_migrations').all();
    for (const r of rows) applied.add(r.version);
  } catch {}
  const dir = path.join(__dirname, 'state-migrations');
  if (!fs.existsSync(dir)) return;
  const files = fs.readdirSync(dir)
    .filter(f => /^\d+_.+\.sql$/.test(f))
    .sort();
  for (const f of files) {
    const m = f.match(/^(\d+)_/);
    if (!m) continue;
    const version = Number(m[1]);
    if (applied.has(version)) continue;
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    // Each migration runs in a single transaction.
    try { db.exec('BEGIN'); db.exec(sql); db.run('INSERT INTO schema_migrations (version) VALUES (?)', [version]); db.exec('COMMIT'); }
    catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
  }
}

// ── audit_events ─────────────────────────────────────────────────────

function emitAudit(handle, { trace_id, project_id, event, payload }) {
  if (!handle?.available) return false;
  const ts = new Date().toISOString();
  const tid = trace_id || (process.env.NIRVANA_TRACE_ID || crypto.randomBytes(8).toString('hex'));
  handle.db.run(
    'INSERT INTO audit_events (trace_id, project_id, ts, event, payload) VALUES (?, ?, ?, ?, ?)',
    [tid, project_id || null, ts, String(event), JSON.stringify(payload || {})],
  );
  return true;
}

function listAudit(handle, filters = {}, limit = 100) {
  if (!handle?.available) return [];
  const where = [];
  const args = [];
  if (filters.trace_id) { where.push('trace_id = ?'); args.push(filters.trace_id); }
  if (filters.project_id) { where.push('project_id = ?'); args.push(filters.project_id); }
  if (filters.event) { where.push('event = ?'); args.push(filters.event); }
  if (filters.since) { where.push('ts >= ?'); args.push(filters.since); }
  const sql = 'SELECT id, trace_id, project_id, ts, event, payload FROM audit_events'
    + (where.length ? ' WHERE ' + where.join(' AND ') : '')
    + ' ORDER BY id DESC LIMIT ?';
  args.push(limit);
  const rows = handle.db.query(sql).all(...args);
  return rows.map(r => ({ ...r, payload: safeJson(r.payload) }));
}

// ── quality_gates ───────────────────────────────────────────────────

function recordGate(handle, gateData) {
  if (!handle?.available) return false;
  const ran_at = gateData.ran_at || new Date().toISOString();
  handle.db.run(
    'INSERT INTO quality_gates (project_id, task_id, phase, verdict, score, failed_checks, evidence, deterministic_findings, host, ran_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      gateData.project_id || null,
      gateData.task_id || null,
      String(gateData.phase || ''),
      String(gateData.verdict || 'unknown'),
      Number.isFinite(gateData.score) ? gateData.score : null,
      JSON.stringify(gateData.failed_checks || []),
      JSON.stringify(gateData.evidence || []),
      JSON.stringify(gateData.deterministic_findings || null),
      gateData.host || null,
      ran_at,
    ],
  );
  return true;
}

function listGates(handle, filters = {}, limit = 50) {
  if (!handle?.available) return [];
  const where = [];
  const args = [];
  if (filters.project_id) { where.push('project_id = ?'); args.push(filters.project_id); }
  if (filters.phase) { where.push('phase = ?'); args.push(filters.phase); }
  if (filters.verdict) { where.push('verdict = ?'); args.push(filters.verdict); }
  const sql = 'SELECT * FROM quality_gates'
    + (where.length ? ' WHERE ' + where.join(' AND ') : '')
    + ' ORDER BY id DESC LIMIT ?';
  args.push(limit);
  return handle.db.query(sql).all(...args).map(r => ({
    ...r,
    failed_checks: safeJson(r.failed_checks),
    evidence: safeJson(r.evidence),
    deterministic_findings: safeJson(r.deterministic_findings),
  }));
}

// ── decisions_history ───────────────────────────────────────────────

function appendDecision(handle, decision) {
  if (!handle?.available) return null;
  const recorded_at = decision.recorded_at || new Date().toISOString();
  const r = handle.db.run(
    'INSERT INTO decisions_history (project_id, decision_id, text, source, rationale, recorded_at) VALUES (?, ?, ?, ?, ?, ?)',
    [
      String(decision.project_id || ''),
      String(decision.decision_id || ''),
      String(decision.text || ''),
      decision.source || null,
      decision.rationale || null,
      recorded_at,
    ],
  );
  return r.lastInsertRowid;
}

function listDecisions(handle, projectId, opts = {}) {
  if (!handle?.available) return [];
  const limit = opts.limit ?? 20;
  const sql = projectId
    ? 'SELECT * FROM decisions_history WHERE project_id = ? ORDER BY id DESC LIMIT ?'
    : 'SELECT * FROM decisions_history ORDER BY id DESC LIMIT ?';
  const args = projectId ? [projectId, limit] : [limit];
  return handle.db.query(sql).all(...args);
}

function findDecision(handle, decisionId) {
  if (!handle?.available) return null;
  const rows = handle.db.query('SELECT * FROM decisions_history WHERE decision_id = ? ORDER BY id ASC').all(decisionId);
  return rows.length ? rows : null;
}

// ── helpers ─────────────────────────────────────────────────────────

function safeJson(s) {
  if (typeof s !== 'string' || s === '') return null;
  try { return JSON.parse(s); } catch { return s; }
}

function fingerprint(handle, projectId) {
  if (!handle?.available) return null;
  const rows = handle.db.query(
    "SELECT event || '|' || ts AS k FROM audit_events WHERE project_id = ? ORDER BY id DESC LIMIT 50",
  ).all(projectId);
  const concat = rows.map(r => r.k).join('::');
  return crypto.createHash('sha1').update(concat).digest('hex').slice(0, 12);
}

module.exports = {
  openDb,
  migrate,
  resolveDbPath,
  emitAudit,
  listAudit,
  recordGate,
  listGates,
  appendDecision,
  listDecisions,
  findDecision,
  fingerprint,
};
