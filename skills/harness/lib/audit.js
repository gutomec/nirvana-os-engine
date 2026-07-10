/**
 * Audit logger (JSONL append-only) for the Harness Protocol v1.
 *
 * Writes events to ~/.harness-logs/<YYYY-MM-DD>/audit.jsonl.
 * Schema: ~/.nirvana/skills/_shared/schemas/core-schemas.json#/definitions/audit_event
 *
 * Events (closed enum):
 *   brief_received | routing_decision | invocation_start | invocation_end
 *   cost_emission | handoff | ticket_opened | ticket_resolved
 *   escalation_trigger_fired | human_notification_required | human_response_received
 *   resume | approval_checkpoint | approval_granted | approval_rejected
 *   budget_violation | memory_write | isolation_violation | validation_failed
 *   humanization_applied | humanization_skipped
 *
 * On invalid event names: throw to fail loud (HP2).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const SKILLS_ROOT = process.env.NIRVANA_SKILLS_DIR
  || (fs.existsSync(path.join(os.homedir(), '.nirvana', 'skills')) ? path.join(os.homedir(), '.nirvana', 'skills') : path.join(os.homedir(), '.claude', 'skills'));

const ALLOWED_EVENTS = new Set([
  'brief_received', 'brief_amplified', 'routing_decision', 'invocation_start', 'invocation_end',
  'cost_emission', 'handoff', 'ticket_opened', 'ticket_resolved',
  'escalation_trigger_fired', 'human_notification_required', 'human_response_received',
  'resume', 'approval_checkpoint', 'approval_granted', 'approval_rejected',
  'budget_violation', 'memory_write', 'isolation_violation', 'validation_failed',
  'humanization_applied', 'humanization_skipped', 'loop_detected', 'context_budget_warning',
  'stall_detected', 'stall_retry', 'gate_failed', 'gate_passed',
  // Phase A — dispatch quality invariants (see docs/plans/dispatch-quality-gate-and-mind-clone-injection.md)
  'dispatch_business',         // maestro dispatched a business (agentic path) — canonical business_slug
  'dispatch_squad',            // maestro dispatched a squad (agentic path) — canonical squad_name
  'dispatch_agent_x',          // maestro dispatched the generalist fallback
  'target_plan_committed',     // maestro commits to a plan with mind-clones / squads / businesses
  'mind_clone_injected',       // canonical DNA loaded into the dispatch prompt — REQUIRED for every declared mind-clone
  'dispatch_blocked',          // dispatch refused (missing mind-clone, capability, etc.) — terminal
  'dispatch_audit',             // pre-execution auditor ran (Layer 2)
  'dispatch_audit_revision',    // auditor returned needs_revision; maestro retried with adjustments
  // Phase 3 — quality gate with revision loop (nirvana-evolution)
  'judge_invoked',             // judge LLM call started for an output
  'critique_generated',        // structured critique returned from judge
  'revision_dispatched',       // revision re-invocation queued
  'revision_loop_exhausted',   // max_revisions reached without converging
  // Phase 4 — brief amplification (nirvana-evolution)
  'brief_scored',              // heuristic scorer ran on incoming brief
  'clarification_emitted',     // clarifying questions returned to caller
  'clarification_received',    // user answered the questions
  // Phase 7 — streaming outputs (nirvana-evolution)
  'chunk_emitted',             // a streaming chunk was written by chunk-writer
  'chunk_gate_passed',         // per-chunk partial gate passed
  'chunk_gate_failed',         // per-chunk partial gate failed (warning, non-blocking)
]);

// Per-project when invoked inside a project (walk up to find .nirvana/.env/.git),
// else fallback ~/.harness-logs. $HARNESS_LOGS_DIR still wins for explicit
// override. Computed lazily so a single long-running process could in principle
// serve many projects correctly.
function harnessLogsRoot() {
  if (process.env.HARNESS_LOGS_DIR) return path.resolve(process.env.HARNESS_LOGS_DIR);
  try {
    const { harnessLogsDir } = require(path.join(SKILLS_ROOT, '_shared/lib/log-paths.ts'));
    return harnessLogsDir();
  } catch { return path.join(os.homedir(), '.harness-logs'); }
}

/**
 * Compute today's date in UTC, formatted as YYYY-MM-DD.
 */
function todayDir() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Resolve audit log file path for a given date (default = today).
 */
function logPath(dateStr) {
  const dir = path.join(harnessLogsRoot(), dateStr || todayDir());
  return { dir, file: path.join(dir, 'audit.jsonl') };
}

/**
 * Ensure the log directory exists. Idempotent.
 */
function ensureLogDir(dateStr) {
  const { dir, file } = logPath(dateStr);
  fs.mkdirSync(dir, { recursive: true });
  return file;
}

/**
 * Emit an audit event. Validates the event type and writes a single JSONL line.
 *
 * @param {string} event one of ALLOWED_EVENTS
 * @param {object} payload arbitrary fields (project_id, target_id, score, etc.)
 * @param {object} ctx optional context: {trace_id, project_id, business_slug, squad_name, agent_or_employee}
 * @returns {{path: string, event: object}}
 */
// Lazy-loaded SQLite-backed state-db. Optional: when SQLite is unavailable
// (e.g. inside a Node-only runtime without bun:sqlite), we fall back to
// JSONL-only and the harness keeps working.
let _stateDb = null;
function loadStateDb() {
  if (_stateDb !== null) return _stateDb;
  try {
    const sdb = require(path.join(SKILLS_ROOT, '_shared', 'lib', 'state-db.js'));
    const handle = sdb.openDb(null);
    _stateDb = handle.available ? { sdb, handle } : false;
  } catch { _stateDb = false; }
  return _stateDb;
}

function emit(event, payload, ctx) {
  if (!ALLOWED_EVENTS.has(event)) {
    throw new Error(`audit.emit: unknown event type '${event}'. Allowed: ${[...ALLOWED_EVENTS].join(', ')}`);
  }
  const ts = new Date().toISOString();
  const base = { ts, event };
  if (ctx) {
    if (ctx.trace_id) base.trace_id = ctx.trace_id;
    if (ctx.project_id) base.project_id = ctx.project_id;
    if (ctx.business_slug) base.business_slug = ctx.business_slug;
    if (ctx.squad_name) base.squad_name = ctx.squad_name;
    if (ctx.agent_or_employee) base.agent_or_employee = ctx.agent_or_employee;
    // session_id helps trace-builder correlate hook-emitted cost events
    // (which use claude-code session_id as trace_id) with harness events.
    if (ctx.session_id) base.session_id = ctx.session_id;
  }
  const ev = Object.assign(base, payload || {});
  // Dual-write: SQLite primary (when available) + JSONL fallback. The JSONL
  // continues to be authoritative for legacy readers; SQLite is the new
  // race-safe substrate. When SQLite is rolled out across all readers, we
  // can flip the priority.
  const sd = loadStateDb();
  if (sd && sd.handle?.available) {
    try {
      sd.sdb.emitAudit(sd.handle, {
        trace_id: ev.trace_id || null,
        project_id: ev.project_id || null,
        event,
        payload: ev,
      });
    } catch { /* non-fatal: JSONL still writes */ }
  }
  const file = ensureLogDir();
  fs.appendFileSync(file, JSON.stringify(ev) + '\n', 'utf8');
  return { path: file, event: ev };
}

/**
 * Read audit events with filters. Prefers SQLite when available (race-safe,
 * filterable, indexed); falls back to JSONL scan for backwards compat.
 */
function readAuditEvents(filters = {}, limit = 200) {
  const sd = loadStateDb();
  if (sd && sd.handle?.available) {
    try { return sd.sdb.listAudit(sd.handle, filters, limit); }
    catch { /* fall through */ }
  }
  // JSONL fallback: scan today + yesterday's file
  const out = [];
  for (const date of [todayDir(), prevDay(todayDir())]) {
    const { file } = logPath(date);
    if (!fs.existsSync(file)) continue;
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    for (const ln of lines) {
      try {
        const ev = JSON.parse(ln);
        if (filters.event && ev.event !== filters.event) continue;
        if (filters.trace_id && ev.trace_id !== filters.trace_id) continue;
        if (filters.project_id && ev.project_id !== filters.project_id) continue;
        out.push(ev);
        if (out.length >= limit) return out;
      } catch {}
    }
  }
  return out;
}

function prevDay(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/**
 * Rotate (delete) audit log directories older than retentionDays.
 * Default retention: 90 days for harness session logs (per spec §10.4).
 *
 * @param {number} retentionDays
 * @returns {{kept: string[], deleted: string[]}}
 */
function rotate(retentionDays) {
  const days = Number.isFinite(retentionDays) ? retentionDays : 90;
  const kept = [];
  const deleted = [];
  const root = harnessLogsRoot();
  if (!fs.existsSync(root)) return { kept, deleted };

  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.name)) continue;
    const d = Date.parse(entry.name + 'T00:00:00Z');
    if (Number.isFinite(d) && d < cutoff) {
      const full = path.join(root, entry.name);
      try {
        fs.rmSync(full, { recursive: true, force: true });
        deleted.push(entry.name);
      } catch (_) {
        kept.push(entry.name);
      }
    } else {
      kept.push(entry.name);
    }
  }
  return { kept, deleted };
}

/**
 * Read recent audit events (most recent first) up to `limit`.
 * Useful for diagnostics. Reads the current day file by default.
 */
function readRecent(limit = 100, dateStr) {
  const { file } = logPath(dateStr);
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const tail = lines.slice(-limit);
  return tail.map((l) => {
    try { return JSON.parse(l); } catch { return { _parse_error: true, line: l }; }
  }).reverse();
}

module.exports = { emit, rotate, readRecent, readAuditEvents, ensureLogDir, logPath, ALLOWED_EVENTS, harnessLogsRoot };
