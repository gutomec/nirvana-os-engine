// run-ledger.ts — the Dispatch Ledger: durable, SQLite-backed record of every
// headless run, so a dispatched run can NEVER be silently forgotten.
//
// Design (routing-360 Phase 4, "never-stall guarantee"): every `--exec`
// dispatch opens a row here; a heartbeat sidecar renews a lease while the
// child shows activity (Temporal-style heartbeats over a SQLite journal); the
// supervisor (scripts/supervisor.ts) sweeps expired leases and resumes,
// re-dispatches, or escalates to a human. State transitions are enforced in
// code — an illegal transition throws instead of silently corrupting history.
//
// DB location: ONE GLOBAL DB at <NIRVANA_HOME>/.nirvana/run-ledger.sqlite
// (alongside the global state.db fallback of _shared/lib/state-db.js). Unlike
// state-db, the ledger is deliberately NOT project-scoped: the launchd
// supervisor runs with no project context and must see every run on the
// machine in one indexed query. Override with NIRVANA_RUN_LEDGER_DB (tests).
//
// This file is also the heartbeat sidecar entry point:
//   bun run-ledger.ts heartbeat --run-id <id> --out <f> --err <f> ...
// (see heartbeatMain below — spawned detached by host-agent-driver.ts).
//
// Substrate: bun:sqlite (Bun-native, per the repo's Bun-only runtime rule),
// WAL + busy_timeout 5000 for safe concurrent access from dispatch processes,
// sidecars and the supervisor.

import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

// ── states ──────────────────────────────────────────────────────────────

export type RunState =
  | "dispatched"   // row opened; child not yet confirmed running
  | "running"      // headless child executing
  | "verifying"    // deliverable verification in progress
  | "gated"        // quality gate completed
  | "delivered"    // TERMINAL — artifacts delivered (gate pass or indeterminate)
  | "withheld"     // TERMINAL — artifacts exist but gate failed; delivery withheld
  | "stalled"      // recoverable — supervisor exhausted retries, human notified
  | "failed"       // recoverable — run errored; supervisor may resume/redispatch
  | "abandoned";   // TERMINAL — only via abandon(runId, reason)

export const TERMINAL_STATES: ReadonlySet<RunState> = new Set(["delivered", "withheld", "abandoned"]);
export const ACTIVE_STATES: readonly RunState[] = ["dispatched", "running", "verifying", "gated", "failed", "stalled"];

// Legal transitions. `abandoned` is intentionally absent from every list:
// it is reachable ONLY through abandon(), which demands a reason.
//
// `failed → verifying` is the runtime-error salvage path (see
// delivery-pipeline.ts deliverAfterRuntimeError): a runtime can return an
// error verdict — a usage/turn limit hit at the very end, typically — AFTER
// the deliverables were already written. The run is honestly marked `failed`
// with the runtime's verdict, and then recovers straight into verification
// instead of being re-dispatched: the work already exists on disk and MUST be
// judged (artifacts are never delivered, nor abandoned, without the gate).
// `failed` is documented as recoverable, so this widens an existing recovery
// edge rather than piercing the machine.
//
// `stalled → verifying` is the SUPERVISOR SALVAGE path (see
// scripts/supervisor.ts salvageStalledRun): when the supervisor exhausts its
// retries it marks the run `stalled` and notifies a human — but whatever the
// run already wrote is still sitting in the outputs dir, unjudged. That is the
// same abandoned-artifact defect as above, arriving through a narrower door.
// So the escalated run walks ONCE into verification (read-only: heuristic gate,
// zero revisions, no runtime spawn) and lands on a real delivered/withheld
// decision instead of nothing. `stalled` is documented as recoverable and
// already reaches `dispatched`/`running`; this adds the cheapest recovery edge
// of the three rather than piercing the machine.
const LEGAL: Record<RunState, readonly RunState[]> = {
  dispatched: ["running", "failed", "stalled"],
  running: ["verifying", "gated", "delivered", "withheld", "failed", "stalled"],
  verifying: ["gated", "delivered", "withheld", "failed", "stalled"],
  gated: ["delivered", "withheld", "failed", "stalled"],
  failed: ["dispatched", "running", "verifying", "stalled"],
  stalled: ["dispatched", "running", "verifying", "failed"],
  delivered: [],
  withheld: [],
  abandoned: [],
};

export function isTerminal(state: string): boolean {
  return TERMINAL_STATES.has(state as RunState);
}

/** True when `from → to` is a legal markState transition. */
export function canTransition(from: RunState, to: RunState): boolean {
  return (LEGAL[from] ?? []).includes(to);
}

// ── db handle ───────────────────────────────────────────────────────────

export interface LedgerHandle {
  db: Database;
  path: string;
  close(): void;
}

export interface RunRow {
  run_id: string;
  trace_id: string | null;
  project_id: string | null;
  target_slug: string | null;
  target_kind: string | null;
  state: RunState;
  child_pid: number | null;
  session_id: string | null;
  runtime: string | null;
  lease_expires_at: string | null;
  heartbeat_at: string | null;
  retries: number;
  max_retries: number;
  created_at: string;
  updated_at: string;
  terminal_at: string | null;
  last_error: string | null;
  meta: Record<string, unknown>;
}

export function resolveLedgerDbPath(): string {
  if (process.env.NIRVANA_RUN_LEDGER_DB) return process.env.NIRVANA_RUN_LEDGER_DB;
  const home = process.env.NIRVANA_HOME || os.homedir();
  return path.join(home, ".nirvana", "run-ledger.sqlite");
}

const _openCache = new Map<string, LedgerHandle>();

export function openLedger(dbPath?: string): LedgerHandle {
  const p = dbPath || resolveLedgerDbPath();
  const cached = _openCache.get(p);
  if (cached) return cached;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const db = new Database(p);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec(`CREATE TABLE IF NOT EXISTS runs (
    run_id TEXT PRIMARY KEY,
    trace_id TEXT,
    project_id TEXT,
    target_slug TEXT,
    target_kind TEXT,
    state TEXT NOT NULL,
    child_pid INTEGER,
    session_id TEXT,
    runtime TEXT,
    lease_expires_at TEXT,
    heartbeat_at TEXT,
    retries INTEGER NOT NULL DEFAULT 0,
    max_retries INTEGER NOT NULL DEFAULT 2,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    terminal_at TEXT,
    last_error TEXT,
    meta TEXT NOT NULL DEFAULT '{}'
  )`);
  db.exec("CREATE INDEX IF NOT EXISTS idx_runs_state ON runs(state)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_runs_lease ON runs(state, lease_expires_at)");
  // supervisor bookkeeping (e.g. last-sweep timestamp for the lazy sweep)
  db.exec("CREATE TABLE IF NOT EXISTS supervisor_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const handle: LedgerHandle = {
    db,
    path: p,
    close: () => { try { db.close(); } catch { /* already closed */ } _openCache.delete(p); },
  };
  _openCache.set(p, handle);
  return handle;
}

// ── audit bridge ────────────────────────────────────────────────────────
// Every ledger mutation emits an x_ledger_* audit event through lib/audit.js
// (open namespace — no enum churn). Audit failures are WARNED on stderr,
// never thrown and never silently swallowed: the ledger write is the source
// of truth and must not be blocked by a log path problem.

let _audit: { emit: (e: string, p: Record<string, unknown>, ctx?: Record<string, unknown>) => unknown } | null = null;
function emitLedgerAudit(event: string, payload: Record<string, unknown>, row?: Pick<RunRow, "trace_id" | "project_id"> | null): void {
  try {
    if (!_audit) _audit = createRequire(import.meta.url)("./audit.js");
    _audit!.emit(event, payload, {
      trace_id: row?.trace_id ?? undefined,
      project_id: row?.project_id ?? undefined,
    });
  } catch (e) {
    console.error(`[run-ledger] audit emit failed for '${event}': ${(e as Error)?.message ?? e}`);
  }
}

// ── helpers ─────────────────────────────────────────────────────────────

function nowIso(now?: number): string {
  return new Date(now ?? Date.now()).toISOString();
}

function parseRow(r: Record<string, unknown> | null): RunRow | null {
  if (!r) return null;
  let meta: Record<string, unknown> = {};
  try { meta = JSON.parse(String(r.meta ?? "{}")); } catch { /* keep {} */ }
  return { ...(r as unknown as RunRow), meta };
}

export function getRun(handle: LedgerHandle, runId: string): RunRow | null {
  const r = handle.db.query("SELECT * FROM runs WHERE run_id = ?").get(runId) as Record<string, unknown> | null;
  return parseRow(r);
}

/** True when the pid exists (EPERM counts as alive: exists, not ours). */
export function pidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return (e as NodeJS.ErrnoException)?.code === "EPERM"; }
}

/** Newest mtime (ms) under dir, recursive, capped so a sweep never crawls a
 *  runaway tree. 0 when the dir is missing/empty. */
export function latestMtimeMs(dir: string, cap = 5000): number {
  let latest = 0;
  let seen = 0;
  const stack = [dir];
  while (stack.length && seen < cap) {
    const d = stack.pop()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (seen++ >= cap) break;
      const full = path.join(d, e.name);
      try {
        const st = fs.statSync(full);
        if (st.mtimeMs > latest) latest = st.mtimeMs;
        if (e.isDirectory()) stack.push(full);
      } catch { /* raced deletion */ }
    }
  }
  return latest;
}

// ── mutations ───────────────────────────────────────────────────────────

export interface OpenRunOpts {
  runId?: string;
  traceId?: string | null;
  projectId?: string | null;
  targetSlug?: string | null;
  targetKind?: string | null;  // business | squad | agent-x | clone …
  runtime?: string | null;
  childPid?: number | null;
  sessionId?: string | null;
  maxRetries?: number;         // default 2
  /** Initial lease in seconds (default 900). Negative values are allowed for
   *  tests that need an already-expired lease. */
  initialLeaseSec?: number;
  meta?: Record<string, unknown>;
}

export function openRun(handle: LedgerHandle, opts: OpenRunOpts): RunRow {
  const runId = opts.runId || `run-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const now = nowIso();
  const leaseSec = opts.initialLeaseSec ?? 900;
  const lease = nowIso(Date.now() + leaseSec * 1000);
  handle.db.run(
    `INSERT INTO runs (run_id, trace_id, project_id, target_slug, target_kind, state, child_pid, session_id,
      runtime, lease_expires_at, heartbeat_at, retries, max_retries, created_at, updated_at, meta)
     VALUES (?, ?, ?, ?, ?, 'dispatched', ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
    [
      runId, opts.traceId ?? null, opts.projectId ?? null, opts.targetSlug ?? null, opts.targetKind ?? null,
      opts.childPid ?? null, opts.sessionId ?? null, opts.runtime ?? null,
      lease, now, opts.maxRetries ?? 2, now, now, JSON.stringify(opts.meta ?? {}),
    ],
  );
  const row = getRun(handle, runId)!;
  emitLedgerAudit("x_ledger_run_opened", {
    run_id: runId, target_slug: row.target_slug, target_kind: row.target_kind,
    runtime: row.runtime, lease_expires_at: row.lease_expires_at, max_retries: row.max_retries,
  }, row);
  return row;
}

/** Extend the lease by `seconds` from now and advance heartbeat_at. Returns
 *  false (with a stderr warn) on terminal/missing runs — a heartbeat must
 *  never resurrect a finished run. */
export function renewLease(handle: LedgerHandle, runId: string, seconds: number): boolean {
  const row = getRun(handle, runId);
  if (!row) { console.error(`[run-ledger] renewLease: run '${runId}' not found`); return false; }
  if (isTerminal(row.state)) {
    console.error(`[run-ledger] renewLease: run '${runId}' is terminal (${row.state}); refusing`);
    return false;
  }
  const now = nowIso();
  const lease = nowIso(Date.now() + seconds * 1000);
  handle.db.run(
    "UPDATE runs SET lease_expires_at = ?, heartbeat_at = ?, updated_at = ? WHERE run_id = ?",
    [lease, now, now, runId],
  );
  emitLedgerAudit("x_ledger_lease_renewed", { run_id: runId, lease_expires_at: lease }, row);
  return true;
}

export interface MarkStateExtra {
  error?: string;
  childPid?: number | null;
  sessionId?: string | null;
  metaPatch?: Record<string, unknown>;
}

/** Transition the run's state. Illegal transitions THROW: transitions out of
 *  a terminal state, same-state no-ops, unknown states, and any attempt to
 *  reach `abandoned` (use abandon()). */
export function markState(handle: LedgerHandle, runId: string, next: RunState, extra: MarkStateExtra = {}): RunRow {
  const row = getRun(handle, runId);
  if (!row) throw new Error(`run-ledger: markState on unknown run '${runId}'`);
  if (next === "abandoned") throw new Error("run-ledger: 'abandoned' is only reachable via abandon(runId, reason)");
  if (!(next in LEGAL)) throw new Error(`run-ledger: unknown state '${next}'`);
  if (isTerminal(row.state)) {
    throw new Error(`run-ledger: illegal transition ${row.state} → ${next} for '${runId}' (terminal states are final)`);
  }
  if (row.state === next) {
    throw new Error(`run-ledger: illegal same-state transition ${row.state} → ${next} for '${runId}'`);
  }
  if (!LEGAL[row.state].includes(next)) {
    throw new Error(`run-ledger: illegal transition ${row.state} → ${next} for '${runId}'`);
  }
  const now = nowIso();
  const terminalAt = isTerminal(next) ? now : null;
  const meta = extra.metaPatch ? { ...row.meta, ...extra.metaPatch } : row.meta;
  handle.db.run(
    `UPDATE runs SET state = ?, updated_at = ?, terminal_at = COALESCE(?, terminal_at),
       last_error = COALESCE(?, last_error),
       child_pid = COALESCE(?, child_pid),
       session_id = COALESCE(?, session_id),
       meta = ?
     WHERE run_id = ?`,
    [next, now, terminalAt, extra.error ?? null, extra.childPid ?? null, extra.sessionId ?? null, JSON.stringify(meta), runId],
  );
  emitLedgerAudit("x_ledger_state_changed", {
    run_id: runId, from: row.state, to: next, error: extra.error ?? null,
  }, row);
  return getRun(handle, runId)!;
}

/** Record the runtime session id (revise/resume machinery) without a state
 *  transition, so the supervisor can resume the same conversation. */
export function recordSession(handle: LedgerHandle, runId: string, sessionId: string | null, childPid?: number | null): void {
  if (!sessionId && childPid == null) return;
  const row = getRun(handle, runId);
  if (!row) { console.error(`[run-ledger] recordSession: run '${runId}' not found`); return; }
  handle.db.run(
    "UPDATE runs SET session_id = COALESCE(?, session_id), child_pid = COALESCE(?, child_pid), updated_at = ? WHERE run_id = ?",
    [sessionId ?? null, childPid ?? null, nowIso(), runId],
  );
  emitLedgerAudit("x_ledger_session_recorded", { run_id: runId, session_id: sessionId, child_pid: childPid ?? null }, row);
}

/** Merge `patch` into the run's meta WITHOUT a state transition. The
 *  supervisor uses it to stamp salvage bookkeeping (meta.salvaged) on an
 *  escalated row before the salvage runs, so a crash mid-salvage can never
 *  become a re-judge loop on the next sweep. */
export function patchMeta(handle: LedgerHandle, runId: string, patch: Record<string, unknown>): RunRow | null {
  const row = getRun(handle, runId);
  if (!row) { console.error(`[run-ledger] patchMeta: run '${runId}' not found`); return null; }
  handle.db.run(
    "UPDATE runs SET meta = ?, updated_at = ? WHERE run_id = ?",
    [JSON.stringify({ ...row.meta, ...patch }), nowIso(), runId],
  );
  emitLedgerAudit("x_ledger_meta_patched", { run_id: runId, keys: Object.keys(patch) }, row);
  return getRun(handle, runId);
}

export function incrementRetries(handle: LedgerHandle, runId: string): number {
  const row = getRun(handle, runId);
  if (!row) throw new Error(`run-ledger: incrementRetries on unknown run '${runId}'`);
  if (isTerminal(row.state)) throw new Error(`run-ledger: incrementRetries on terminal run '${runId}' (${row.state})`);
  handle.db.run("UPDATE runs SET retries = retries + 1, updated_at = ? WHERE run_id = ?", [nowIso(), runId]);
  const retries = row.retries + 1;
  emitLedgerAudit("x_ledger_retry", { run_id: runId, retries, max_retries: row.max_retries }, row);
  return retries;
}

/** Explicit, reasoned abandonment — the ONLY path into 'abandoned'. */
export function abandon(handle: LedgerHandle, runId: string, reason: string): RunRow {
  if (!reason || !reason.trim()) throw new Error("run-ledger: abandon() requires a non-empty reason");
  const row = getRun(handle, runId);
  if (!row) throw new Error(`run-ledger: abandon on unknown run '${runId}'`);
  if (isTerminal(row.state)) throw new Error(`run-ledger: abandon on terminal run '${runId}' (${row.state})`);
  const now = nowIso();
  handle.db.run(
    "UPDATE runs SET state = 'abandoned', last_error = ?, terminal_at = ?, updated_at = ? WHERE run_id = ?",
    [reason, now, now, runId],
  );
  emitLedgerAudit("x_ledger_abandoned", { run_id: runId, from: row.state, reason }, row);
  return getRun(handle, runId)!;
}

// ── queries ─────────────────────────────────────────────────────────────

const ACTIVE_IN = ACTIVE_STATES.map(() => "?").join(", ");

export function findNonTerminal(handle: LedgerHandle): RunRow[] {
  const rows = handle.db
    .query(`SELECT * FROM runs WHERE state IN (${ACTIVE_IN}) ORDER BY created_at ASC`)
    .all(...ACTIVE_STATES) as Record<string, unknown>[];
  return rows.map(r => parseRow(r)!);
}

export function countNonTerminal(handle: LedgerHandle): number {
  const r = handle.db
    .query(`SELECT COUNT(*) AS n FROM runs WHERE state IN (${ACTIVE_IN})`)
    .get(...ACTIVE_STATES) as { n: number };
  return r?.n ?? 0;
}

/** Non-terminal runs whose lease has expired at `now` (default: real now).
 *  A NULL lease counts as expired — a run that never got a lease is exactly
 *  the kind of forgotten run this ledger exists to catch. */
export function findExpired(handle: LedgerHandle, now?: Date | number): RunRow[] {
  const cutoff = nowIso(typeof now === "number" ? now : now?.getTime());
  const rows = handle.db
    .query(`SELECT * FROM runs WHERE state IN (${ACTIVE_IN}) AND (lease_expires_at IS NULL OR lease_expires_at < ?) ORDER BY created_at ASC`)
    .all(...ACTIVE_STATES, cutoff) as Record<string, unknown>[];
  return rows.map(r => parseRow(r)!);
}

/** Everything the supervisor needs to resume a run. */
export function resumeInfo(handle: LedgerHandle, runId: string): {
  runId: string; state: RunState; sessionId: string | null; runtime: string | null;
  projectId: string | null; retries: number; maxRetries: number; meta: Record<string, unknown>;
} | null {
  const row = getRun(handle, runId);
  if (!row) return null;
  return {
    runId: row.run_id, state: row.state, sessionId: row.session_id, runtime: row.runtime,
    projectId: row.project_id, retries: row.retries, maxRetries: row.max_retries, meta: row.meta,
  };
}

// ── supervisor meta (lazy-sweep bookkeeping) ────────────────────────────

export function getSupervisorMeta(handle: LedgerHandle, key: string): string | null {
  const r = handle.db.query("SELECT value FROM supervisor_meta WHERE key = ?").get(key) as { value: string } | null;
  return r?.value ?? null;
}

export function setSupervisorMeta(handle: LedgerHandle, key: string, value: string): void {
  handle.db.run(
    "INSERT INTO supervisor_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [key, value],
  );
}

// ── heartbeat sidecar entry point ───────────────────────────────────────
// Spawned detached by host-agent-driver.ts while it is BLOCKED in spawnSync
// (a blocked event loop can't run timers — the classic dangling-timer trap of
// the _shared driver — so the heartbeat lives in its own process instead).
//
// Activity signal (activity-based, never existence-based):
//   - the child's captured stdout/stderr files changed size, OR
//   - the newest mtime under --watch advanced.
// While active: renew the lease every tick. After --stall ms without
// activity: STOP renewing (the lease expires naturally; the supervisor takes
// over) and record the heartbeat gap once per stall episode. If activity
// resumes, renewal resumes.
//
// Exit conditions (no dangling process, ever): done-sentinel written by the
// parent, parent pid gone, run row missing, or run reached a terminal state.

function heartbeatArg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

function fileSize(p: string): number {
  try { return fs.statSync(p).size; } catch { return -1; }
}

export function heartbeatMain(): void {
  const runId = heartbeatArg("--run-id");
  if (!runId) { console.error("run-ledger heartbeat: --run-id required"); process.exit(2); }
  const outFile = heartbeatArg("--out") || "";
  const errFile = heartbeatArg("--err") || "";
  const doneFile = heartbeatArg("--done") || "";
  const watchDir = heartbeatArg("--watch");
  const dbPath = heartbeatArg("--db");
  const intervalMs = Math.max(250, parseInt(heartbeatArg("--interval") || "15000", 10));
  const stallMs = Math.max(500, parseInt(heartbeatArg("--stall") || String(5 * 60_000), 10));
  const leaseSec = Math.max(5, parseInt(heartbeatArg("--lease") || "600", 10));
  const parentPid = parseInt(heartbeatArg("--parent") || "0", 10);

  const handle = openLedger(dbPath);
  let lastBytes = fileSize(outFile) + fileSize(errFile);
  let lastMtime = watchDir ? latestMtimeMs(watchDir) : 0;
  let lastActivityAt = Date.now();
  let stallRecorded = false;

  for (;;) {
    Bun.sleepSync(intervalMs);
    if (doneFile && fs.existsSync(doneFile)) break;
    if (parentPid > 0 && !pidAlive(parentPid)) break;
    const row = getRun(handle, runId);
    if (!row || isTerminal(row.state)) break;

    const bytes = fileSize(outFile) + fileSize(errFile);
    const mtime = watchDir ? latestMtimeMs(watchDir) : 0;
    const activity = bytes !== lastBytes || mtime > lastMtime;
    lastBytes = bytes;
    if (mtime > lastMtime) lastMtime = mtime;

    const now = Date.now();
    if (activity) {
      lastActivityAt = now;
      stallRecorded = false;
      renewLease(handle, runId, leaseSec);
    } else if (now - lastActivityAt >= stallMs && !stallRecorded) {
      stallRecorded = true;
      emitLedgerAudit("x_ledger_stall_observed", {
        run_id: runId, gap_ms: now - lastActivityAt, stall_budget_ms: stallMs,
        heartbeat_at: row.heartbeat_at,
      }, row);
    }
  }
  process.exit(0);
}

if (import.meta.main && process.argv[2] === "heartbeat") {
  heartbeatMain();
}
