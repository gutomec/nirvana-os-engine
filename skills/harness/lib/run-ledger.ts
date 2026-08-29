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
// (alongside the global state.db fallback of _shared/lib/state-db.js). The FILE
// is global because a machine-wide supervisor invocation (`watch` with no
// project context, or an explicit `--all-projects`) must reach every run on
// the machine in one indexed query. Override with NIRVANA_RUN_LEDGER_DB (tests).
//
// VISIBILITY is not global, and that distinction is the whole point. Every row
// records the `project_root` it belongs to, and every read and every write here
// filters by the root the calling process is serving (resolveProjectRoot:
// NIRVANA_PROJECT_ROOT, else the first marker-bearing ancestor of cwd). The
// supervisor is the one documented exception — it asks for the machine-wide
// scope explicitly (`--all-projects`, or no project found at all).
//
// Why: on 2026-08-27 a session working in ~/nirvana-os listed the open runs,
// saw rows belonging to ~/venda-mundial-pro and consultorio-dr-paulo, and
// closed one of them. One project could pollute — and terminate — another's
// work. Rows written before the column exists carry `project_root = NULL`,
// which reads as "legacy": visible only in the machine-wide scope, never lost.
//
// This is about SEEING other projects' runs. Reading and writing FILES outside
// the project stays allowed — a dispatched job may need any directory, and
// nothing here touches file permissions or the scope guard.
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
import { spawnSync } from "node:child_process";

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
  /** Normalized root of the project this run belongs to. NULL = legacy row,
   *  written before the column existed and with nothing to derive it from. */
  project_root: string | null;
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

// ── project scope ───────────────────────────────────────────────────────
// The scope of a ledger operation is the project root the process is serving.
// It is resolved exactly as the rest of the engine resolves it —
// NIRVANA_PROJECT_ROOT, else the first ancestor of cwd carrying a project
// marker — but the walk is repeated here instead of imported from
// _shared/lib/scope.ts on purpose: run-ledger.ts is `require()`d from CJS
// callers (handoff.js, brief-squad.ts, brief-business.ts), scope.ts's
// dependency chain contains a top-level await, and Bun refuses to `require()`
// an async module. Keep the two walks in step if the marker list changes.

const PROJECT_MARKERS = [".env", ".nirvana", ".git", "package.json", "pyproject.toml"];

export type RealpathFn = (p: string) => string;

/** The OS's own resolver. `realpathSync.native` is the one that expands a
 *  Windows 8.3 SHORT path; the JS `realpathSync` resolves symlinks but can hand
 *  the 8.3 form straight back. Named so a test can substitute it. */
const osRealpath: RealpathFn = (p) =>
  (fs.realpathSync.native ? fs.realpathSync.native(p) : fs.realpathSync(p));

/**
 * The one form of a path that every process on this machine agrees on.
 *
 * Two processes serving the SAME project must produce the same root string, or
 * the scope filter silently splits one project in two. Two aliases break that,
 * and the OS resolver collapses both:
 *   - macOS hands out /var/folders/… for a /private/var/folders/… directory;
 *   - Windows hands out the 8.3 short form (C:\Users\RUNNER~1\…) for a profile
 *     or temp path whose long form is C:\Users\runneradmin\… . `mkdtemp` under
 *     %TEMP% returns the short form on a GitHub runner, which is how this was
 *     caught: the row carried the long root and the fixture compared the short.
 *
 * `realpath` is injectable because the alias table lives in the OS, not in code
 * — it is how the Windows rule is proven on a platform that has no 8.3 paths.
 */
export function normalizeRoot(dir: string, realpath: RealpathFn = osRealpath): string {
  const resolved = path.resolve(dir);
  try {
    return realpath(resolved);
  } catch {
    return resolved;   // not on disk (yet): the resolved form is all we can honestly compare
  }
}

/** Is `descendant` strictly inside `ancestor`? Both must already be
 *  normalized. Mirrors project-root.js's `isUnder` — case-insensitive on
 *  win32, where a path can arrive in 8.3 short form on one side. */
function isStrictlyUnder(descendant: string, ancestor: string): boolean {
  const prefix = ancestor.endsWith(path.sep) ? ancestor : ancestor + path.sep;
  return process.platform === "win32"
    ? descendant.toLowerCase().startsWith(prefix.toLowerCase())
    : descendant.startsWith(prefix);
}

/** Walk up from `start` to the first directory carrying a project marker.
 *  HOME and the filesystem root are never projects — a stray marker in either
 *  would collapse every project into one scope. Missing directories are walked
 *  THROUGH, not stopped at: an outputs dir that was deleted still names the
 *  project it lived under.
 *
 * The walk STOPS as soon as it reaches HOME, or as soon as HOME becomes
 * strictly nested under the current directory: climbing further would leave
 * the boundary that contains HOME and enter real, unrelated ancestry above
 * it. On `os.tmpdir()` resolving *inside* HOME (the Windows CI runner shape),
 * a walk that starts in a temp fixture directory climbs through HOME's own
 * ancestry before it would reach the filesystem root — without this check it
 * keeps going and can match a marker up there instead of correctly reporting
 * "no project in reach" (see log-paths.ts's own history for the same fix). */
export function findProjectRootFrom(start: string): string | null {
  let cur = path.resolve(start);
  const home = normalizeRoot(process.env.HOME || os.homedir());
  for (let i = 0; i < 40; i++) {
    const norm = normalizeRoot(cur);
    if (norm === path.parse(norm).root) return null;
    if (sameNormalizedRoot(norm, home)) return null;
    if (isStrictlyUnder(home, norm)) return null;
    for (const m of PROJECT_MARKERS) {
      if (fs.existsSync(path.join(cur, m))) return norm;
    }
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
  return null;
}

/** Compare two roots that ALREADY went through `normalizeRoot` — the marker
 *  walk normalizes each level once and must not pay the syscall twice. */
function sameNormalizedRoot(a: string, b: string): boolean {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** Two roots are the same project. BOTH sides go through `normalizeRoot`, so a
 *  Windows 8.3 short path and its long form are one project, and so are /var
 *  and /private/var — comparing the raw strings is exactly how one project
 *  splits in two. Windows compares case-insensitively; a trailing separator
 *  never makes a different project. */
export function sameProjectRoot(a: string | null, b: string | null, realpath: RealpathFn = osRealpath): boolean {
  if (a == null || b == null) return a == null && b == null;
  return sameNormalizedRoot(normalizeRoot(a, realpath), normalizeRoot(b, realpath));
}

let _rootMemo: { key: string; root: string | null } | null = null;

/** The project root THIS process is serving, or null when it is not inside any
 *  project. Memoized per (env, cwd) so the marker walk runs once per process
 *  without ever going stale for a test that moves the root. */
export function resolveProjectRoot(cwd?: string): string | null {
  const base = cwd ?? process.cwd();
  const env = process.env.NIRVANA_PROJECT_ROOT || "";
  const key = `${env}\0${base}`;
  if (_rootMemo && _rootMemo.key === key) return _rootMemo.root;
  const root = env ? normalizeRoot(env) : findProjectRootFrom(base);
  _rootMemo = { key, root };
  return root;
}

export interface ScopeOpts {
  /** See every project's runs. The supervisor's exception, nobody else's. */
  allProjects?: boolean;
  /** Scope to this root instead of the process's own (tests, supervisor). */
  projectRoot?: string | null;
}

/** The `AND …` fragment that confines a query to one project.
 *  - allProjects → no fragment at all;
 *  - a root      → rows of that root;
 *  - no root     → rows that have none either, so a process outside any project
 *                  sees the legacy/rootless runs and never a stranger's work. */
function scopeClause(opts?: ScopeOpts): { sql: string; params: unknown[] } {
  if (opts?.allProjects) return { sql: "", params: [] };
  const root = opts?.projectRoot !== undefined
    ? (opts.projectRoot ? normalizeRoot(opts.projectRoot) : null)
    : resolveProjectRoot();
  return root
    ? { sql: " AND project_root = ?", params: [root] }
    : { sql: " AND project_root IS NULL", params: [] };
}

/** The project root of a pre-migration row, from what the row already carries.
 *  On the agentic path `meta.project_root` / `meta.project_dir` hold an OUTPUTS
 *  dir (openAgenticRun fills them from outputsRoot) and may be relative to
 *  `meta.cwd` — so each candidate is anchored, then walked up to its project,
 *  the same resolution a live process does for itself. Nothing usable → null. */
function projectRootFromMeta(meta: Record<string, unknown>): string | null {
  const cwd = typeof meta.cwd === "string" && meta.cwd ? meta.cwd : null;
  for (const key of ["project_root", "project_dir", "cwd"]) {
    const v = meta[key];
    if (typeof v !== "string" || !v) continue;
    const anchored = path.isAbsolute(v) ? v : (cwd ? path.resolve(cwd, v) : null);
    if (!anchored) continue;
    const root = findProjectRootFrom(anchored);
    if (root) return root;
  }
  return null;
}

/** One-shot backfill, run only when the column is added. Rows we cannot place
 *  keep NULL: a wrong project is worse than an honest "legacy". */
function backfillProjectRoots(db: Database): void {
  const rows = db.query("SELECT run_id, meta FROM runs WHERE project_root IS NULL").all() as { run_id: string; meta: string }[];
  const placed: { runId: string; root: string }[] = [];
  for (const r of rows) {
    let meta: Record<string, unknown> = {};
    try { meta = JSON.parse(String(r.meta ?? "{}")); } catch { continue; }
    const root = projectRootFromMeta(meta);
    if (root) placed.push({ runId: r.run_id, root });
  }
  if (!placed.length) return;
  const update = db.prepare("UPDATE runs SET project_root = ? WHERE run_id = ?");
  db.transaction((items: { runId: string; root: string }[]) => {
    for (const it of items) update.run(it.root, it.runId);
  })(placed);
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
    project_root TEXT,
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
  // project_root arrived after the table did. The migration is idempotent by
  // PRAGMA table_info, and the backfill runs exactly once — on the open that
  // adds the column — because every later row is stamped at INSERT.
  const columns = db.query("PRAGMA table_info(runs)").all() as { name: string }[];
  if (!columns.some(c => c.name === "project_root")) {
    db.exec("ALTER TABLE runs ADD COLUMN project_root TEXT");
    try { backfillProjectRoots(db); }
    catch (e) { console.error(`[run-ledger] project_root backfill failed (${(e as Error)?.message ?? e}); those rows stay legacy`); }
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_runs_state ON runs(state)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_runs_lease ON runs(state, lease_expires_at)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_runs_project ON runs(project_root, state)");
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

interface AuditLib {
  emit: (e: string, p: Record<string, unknown>, ctx?: Record<string, unknown>) => unknown;
  readRecent: (limit: number, dateStr?: string, cwd?: string) => Record<string, unknown>[];
  logPath: (dateStr?: string, cwd?: string) => { dir: string; file: string };
}
let _audit: AuditLib | null = null;
function auditLib(): AuditLib {
  if (!_audit) _audit = createRequire(import.meta.url)("./audit.js");
  return _audit!;
}
function emitLedgerAudit(event: string, payload: Record<string, unknown>, row?: Pick<RunRow, "trace_id" | "project_id"> | null): void {
  try {
    auditLib().emit(event, payload, {
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

/** Most recent run with this trace_id — the door for a caller that only kept
 *  the trace it dispatched with, not the run_id the ledger generated. Unscoped
 *  like getRun: the caller decides what to do about a foreign project's row
 *  (see run-track.ts's refuseForeignRun). */
export function findByTraceId(handle: LedgerHandle, traceId: string): RunRow | null {
  // created_at has millisecond resolution (Date.now()), so two rows opened in
  // the same millisecond (a resumed run right after its predecessor failed)
  // tie on it — ORDER BY created_at DESC alone then returns whichever the
  // scan happens to visit first, not the actual newer row. rowid is SQLite's
  // own monotonically-increasing insertion order (this table has no INTEGER
  // PRIMARY KEY, so run_id never aliases it) and breaks the tie correctly.
  const r = handle.db
    .query("SELECT * FROM runs WHERE trace_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1")
    .get(traceId) as Record<string, unknown> | null;
  return parseRow(r);
}

/** True when the pid exists (EPERM counts as alive: exists, not ours). */
export function pidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return (e as NodeJS.ErrnoException)?.code === "EPERM"; }
}

/** The OS's own process-start timestamp for `pid` (`ps -o lstart=`), as the
 *  raw string `ps` prints — opaque and exact, never reparsed into a Date, so
 *  two calls agree byte-for-byte or don't agree at all. POSIX only (macOS +
 *  Linux, both of which this codebase already targets for the supervisor);
 *  null on any failure, INCLUDING "no ps binary" (Windows) — callers must
 *  treat null as "cannot verify", never as "does not exist". */
export function processStartedAt(pid: number): string | null {
  if (!Number.isFinite(pid) || pid <= 0) return null;
  try {
    const r = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" });
    if (r.status !== 0) return null;
    const line = (r.stdout || "").trim();
    return line || null;
  } catch { return null; }
}

/** The pid of the one live direct child of `parentPid`, `excludePid` skipped
 *  (the heartbeat sidecar is itself a child of the dispatcher it watches, so
 *  without the exclusion it can find itself instead of the CLI runtime it
 *  exists to observe). POSIX only, same caveat as `processStartedAt`: null
 *  means "nothing found or can't ask", not "no child exists". Picks the
 *  first match — this architecture runs at most one spawnSync child under a
 *  ledgered dispatcher at a time. */
export function findChildPid(parentPid: number, excludePid?: number): number | null {
  if (!Number.isFinite(parentPid) || parentPid <= 0) return null;
  try {
    const r = spawnSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" });
    if (r.status !== 0) return null;
    for (const line of (r.stdout || "").trim().split("\n")) {
      const [pidStr, ppidStr] = line.trim().split(/\s+/);
      const pid = parseInt(pidStr, 10);
      const ppid = parseInt(ppidStr, 10);
      if (ppid === parentPid && Number.isFinite(pid) && pid !== excludePid) return pid;
    }
    return null;
  } catch { return null; }
}

/** One file the sweep found newer than the mark it was given. */
export interface TouchedFile { path: string; mtimeMs: number; sizeBytes: number }

export interface DirScan {
  /** Newest mtime (ms) anywhere under dir, noise included. 0 when missing/empty. */
  latestMs: number;
  /** Files newer than `sinceMs`, noise excluded, oldest first, at most `limit`. */
  changed: TouchedFile[];
  /** Files that qualified and were dropped by `limit`. */
  omitted: number;
}

// Names that are never a deliverable. Same rules as scripts/watch-fs.ts, kept
// here as a copy on purpose: this list decides what gets REPORTED, and the
// walk still descends into every one of them, because pruning the traversal
// would change `latestMs` and with it the liveness signal the supervisor
// reads. Noise counts as "the run is alive"; it never counts as progress.
const NOISE_DIR_SEGMENTS: readonly string[] = [".git", "node_modules", "__pycache__", ".idea", ".vscode", ".harness-logs", ".bun", "dist", "build"];
const NOISE_FILE_PATTERNS: readonly RegExp[] = [/\.swp$/, /~$/, /^\.#/, /\.tmp$/, /\.pyc$/, /^\.DS_Store$/];

function isNoise(root: string, full: string): boolean {
  const base = path.basename(full);
  for (const re of NOISE_FILE_PATTERNS) if (re.test(base)) return true;
  const rel = path.relative(root, full);
  const segments = rel.split(/[\\/]/).slice(0, -1);
  if (segments.some(s => NOISE_DIR_SEGMENTS.includes(s))) return true;
  // .nirvana/ under the outputs root is the harness's own scaffolding (state,
  // briefs, logs) — written by the dispatcher, not by the agent being watched.
  return segments.includes(".nirvana");
}

/**
 * One recursive sweep of `dir`, capped so it never crawls a runaway tree.
 *
 * Returns both answers the heartbeat needs from a single walk: the newest
 * mtime (is anything happening at all?) and WHICH files moved (what is
 * happening). The second answer is the whole reason this exists — the sidecar
 * used to compute the first and throw the rest away, so seven minutes of a run
 * writing 113 files reported "still alive", eleven times, and nothing else.
 */
export function scanDir(dir: string, sinceMs: number, opts: { cap?: number; limit?: number } = {}): DirScan {
  const cap = opts.cap ?? 5000;
  const limit = Math.max(0, opts.limit ?? 0);
  let latest = 0;
  let seen = 0;
  const qualified: TouchedFile[] = [];
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
        if (e.isDirectory()) { stack.push(full); continue; }
        if (limit > 0 && st.mtimeMs > sinceMs && !isNoise(dir, full)) {
          qualified.push({ path: full, mtimeMs: st.mtimeMs, sizeBytes: st.size });
        }
      } catch { /* raced deletion */ }
    }
  }
  // Oldest first: the order the files appeared IS the progress, and when the
  // tick overflows the cap it is the FIRST touches that survive the slice.
  qualified.sort((a, b) => a.mtimeMs - b.mtimeMs);
  return { latestMs: latest, changed: qualified.slice(0, limit), omitted: Math.max(0, qualified.length - limit) };
}

/** Newest mtime (ms) under dir, recursive, capped so a sweep never crawls a
 *  runaway tree. 0 when the dir is missing/empty. */
export function latestMtimeMs(dir: string, cap = 5000): number {
  return scanDir(dir, Number.POSITIVE_INFINITY, { cap }).latestMs;
}

// ── done-sentinel: a caller can wait on this without polling the process
// table ─────────────────────────────────────────────────────────────────
// markState() already lands every run on a decision; this mirrors that
// decision into a small file on disk so a DIFFERENT process can learn it — a
// caller that backgrounded the dispatch with `nohup … &` and returned, or a
// session that reconnects after its own crash. The file is the notification;
// the ledger row underneath stays the source of truth (a reconnecting caller
// can always re-derive the same fact — see findByTraceId/getRun, and
// scripts/run-track.ts's `status`/`wait`).
//
// `failed` counts as a sentinel state even though the ledger keeps it
// recoverable (LEGAL.failed can still walk back to `running`): a caller
// waiting on ONE dispatch attempt is asking "how did THIS run end", and by
// the time markState reaches `failed` the process that was running it has
// already decided it is done. If the supervisor later resumes the same
// run_id, the resumed attempt overwrites this file again when IT reaches a
// decision — same file, newest truth, exactly like the ledger row it mirrors.
const SENTINEL_STATES: ReadonlySet<RunState> = new Set(["delivered", "withheld", "abandoned", "failed"]);

/** Directory the sentinel files live in, next to the ledger DB they mirror —
 *  so NIRVANA_RUN_LEDGER_DB alone isolates it in tests, no second env var. */
export function runSignalDir(): string {
  return path.join(path.dirname(resolveLedgerDbPath()), "run-signals");
}

/** The done-sentinel path for one run. `nrv run-track wait` watches this
 *  directory (fs.watch — event-driven, no polling timer) for exactly this
 *  file to appear. */
export function runSignalPath(runId: string): string {
  return path.join(runSignalDir(), `${runId}.json`);
}

export interface RunSignal {
  run_id: string;
  trace_id: string | null;
  project_id: string | null;
  state: string;
  outputs_root: string | null;
  ended_at: string;
  error: string | null;
}

/** Best-effort, atomic (tmp + rename) so a reader never observes a
 *  half-written file. A signal failure must never break the state transition
 *  that triggered it — the ledger row is already the truth on disk. */
function writeRunSignal(row: RunRow): void {
  try {
    const dir = runSignalDir();
    fs.mkdirSync(dir, { recursive: true });
    const signal: RunSignal = {
      run_id: row.run_id,
      trace_id: row.trace_id,
      project_id: row.project_id,
      state: row.state,
      outputs_root: metaString(row.meta, "outputs_root") ?? metaString(row.meta, "project_dir"),
      ended_at: row.terminal_at ?? row.updated_at,
      error: row.last_error,
    };
    const tmp = path.join(dir, `.${row.run_id}.${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(signal));
    fs.renameSync(tmp, runSignalPath(row.run_id));
  } catch (e) {
    console.error(`[run-ledger] could not write run-signal for '${row.run_id}' (${(e as Error)?.message ?? e})`);
  }
}

// ── mutations ───────────────────────────────────────────────────────────

export interface OpenRunOpts {
  runId?: string;
  traceId?: string | null;
  projectId?: string | null;
  /** Project this run belongs to. Default: the root this process is serving. */
  projectRoot?: string | null;
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
  const projectRoot = opts.projectRoot !== undefined
    ? (opts.projectRoot ? normalizeRoot(opts.projectRoot) : null)
    : resolveProjectRoot();
  handle.db.run(
    `INSERT INTO runs (run_id, trace_id, project_id, project_root, target_slug, target_kind, state, child_pid, session_id,
      runtime, lease_expires_at, heartbeat_at, retries, max_retries, created_at, updated_at, meta)
     VALUES (?, ?, ?, ?, ?, ?, 'dispatched', ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
    [
      runId, opts.traceId ?? null, opts.projectId ?? null, projectRoot, opts.targetSlug ?? null, opts.targetKind ?? null,
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

/** Lease for an agent-orchestrated run. Longer than the scripted default (900s)
 *  because an in-session dispatch legitimately thinks for a long time between
 *  writes, and the supervisor's file-activity check keeps a working run alive
 *  anyway. Short enough that an ABANDONED run surfaces the same hour. */
export const AGENTIC_LEASE_SEC = 1800;

export interface AgenticRunOpts {
  projectId: string;
  traceId?: string | null;
  targetSlug: string;
  targetKind: string;
  /** Where the run writes. One of the run's proofs of life (see
   *  resolveAgenticLiveness): the supervisor reads the newest mtime under it,
   *  so a run that is producing files is never mistaken for a dead one — no
   *  cooperation from the agent required. */
  outputsRoot?: string | null;
  projectDir?: string | null;
  runtime?: string | null;
  meta?: Record<string, unknown>;
}

/**
 * Open a ledger run for the AGENTIC path — the dispatch an agent orchestrates
 * inside its own session, with no child process of ours to watch.
 *
 * The scripted path (`nrv dispatch --exec`) has always been ledgered; the
 * agentic path was not, so a brief dispatched in-session was invisible to the
 * supervisor and could finish, fail or die with the owner never told. This is
 * the door that closes that gap, and it is called from the prep scripts the
 * agent must run anyway (brief-squad / brief-business) — so coverage is a side
 * effect of dispatching, not something an agent has to remember.
 *
 * Two deliberate differences from `openRun`:
 *  - **No child_pid.** There is no child: the only pid in reach is the shell
 *    that ran this script, dead seconds later, and a recycled pid could get a
 *    stranger's process SIGTERMed by a sweep. `null` says the truth — nothing
 *    here is ours to signal.
 *  - **No pid means no process to watch.** Proof of life is read from the
 *    trace instead: the row's own beats, the child runs of the same project,
 *    the hook activity of the session and the files under outputs_root — see
 *    resolveAgenticLiveness.
 *
 * Fail-soft by contract: returns `null` and warns on any ledger failure. Losing
 * the tracking of a run is bad; losing the RUN because tracking broke is worse.
 */
export function openAgenticRun(opts: AgenticRunOpts): { runId: string; handle: LedgerHandle } | null {
  try {
    const handle = openLedger();
    const row = openRun(handle, {
      projectId: opts.projectId,
      traceId: opts.traceId ?? opts.projectId,
      targetSlug: opts.targetSlug,
      targetKind: opts.targetKind,
      runtime: opts.runtime ?? process.env.NIRVANA_RUNTIME ?? null,
      childPid: null,
      initialLeaseSec: AGENTIC_LEASE_SEC,
      meta: {
        path: "agentic",
        outputs_root: opts.outputsRoot ?? null,
        project_dir: opts.projectDir ?? opts.outputsRoot ?? null,
        project_root: opts.projectDir ?? opts.outputsRoot ?? null,
        ...(opts.meta ?? {}),
      },
    });
    markState(handle, row.run_id, "running", { error: null });
    return { runId: row.run_id, handle };
  } catch (e) {
    console.error(`[run-ledger] could not open an agentic run (${(e as Error)?.message ?? e}) — this dispatch will NOT be tracked`);
    return null;
  }
}

/** Extend the lease by `seconds` from now and advance heartbeat_at. Returns
 *  false (with a stderr warn) on terminal/missing runs — a heartbeat must
 *  never resurrect a finished run. `source` names who beat (a handoff script,
 *  brief-squad) so the audit can say why the run stayed alive. */
export function renewLease(handle: LedgerHandle, runId: string, seconds: number, source?: string): boolean {
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
  emitLedgerAudit("x_ledger_lease_renewed", { run_id: runId, lease_expires_at: lease, ...(source ? { source } : {}) }, row);
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
  // last_error rides along: a `withheld` reached through a stall keeps the
  // supervisor's reason, one reached through the gate does not, and that is how
  // a reader of the trail (Glance included) tells the two apart.
  emitLedgerAudit("x_ledger_state_changed", {
    run_id: runId, from: row.state, to: next, error: extra.error ?? null, last_error: extra.error ?? row.last_error ?? null,
  }, row);
  const updated = getRun(handle, runId)!;
  if (SENTINEL_STATES.has(next)) writeRunSignal(updated);
  return updated;
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

/**
 * Record the REAL worker's pid — the CLI runtime process a ledgered
 * `spawnSync` launches, discovered by the heartbeat sidecar (see
 * heartbeatMain) walking the process table for a live child of the
 * dispatcher — never the dispatcher's own pid. `startedAt` (processStartedAt
 * at discovery time) rides along so a later reader (the supervisor) can tell
 * a still-live pid from one the OS has since handed to an unrelated process:
 * see `child_pid_started_at` in RunRow['meta'].
 */
export function recordChildPid(handle: LedgerHandle, runId: string, pid: number, startedAt: string | null): void {
  const row = getRun(handle, runId);
  if (!row) { console.error(`[run-ledger] recordChildPid: run '${runId}' not found`); return; }
  handle.db.run(
    "UPDATE runs SET child_pid = ?, meta = ?, updated_at = ? WHERE run_id = ?",
    [pid, JSON.stringify({ ...row.meta, child_pid_started_at: startedAt }), nowIso(), runId],
  );
  emitLedgerAudit("x_ledger_child_pid_recorded", { run_id: runId, child_pid: pid, started_at: startedAt }, row);
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

/** Active runs OF THIS PROJECT. `scope.allProjects` is the supervisor's door
 *  to the whole machine; every other caller gets its own project. */
export function findNonTerminal(handle: LedgerHandle, scope?: ScopeOpts): RunRow[] {
  const s = scopeClause(scope);
  const rows = handle.db
    .query(`SELECT * FROM runs WHERE state IN (${ACTIVE_IN})${s.sql} ORDER BY created_at ASC`)
    .all(...ACTIVE_STATES, ...s.params) as Record<string, unknown>[];
  return rows.map(r => parseRow(r)!);
}

export function countNonTerminal(handle: LedgerHandle, scope?: ScopeOpts): number {
  const s = scopeClause(scope);
  const r = handle.db
    .query(`SELECT COUNT(*) AS n FROM runs WHERE state IN (${ACTIVE_IN})${s.sql}`)
    .get(...ACTIVE_STATES, ...s.params) as { n: number };
  return r?.n ?? 0;
}

/** Non-terminal runs of this project whose lease has expired at `now`
 *  (default: real now). A NULL lease counts as expired — a run that never got
 *  a lease is exactly the kind of forgotten run this ledger exists to catch. */
export function findExpired(handle: LedgerHandle, now?: Date | number, scope?: ScopeOpts): RunRow[] {
  const cutoff = nowIso(typeof now === "number" ? now : now?.getTime());
  const s = scopeClause(scope);
  const rows = handle.db
    .query(`SELECT * FROM runs WHERE state IN (${ACTIVE_IN}) AND (lease_expires_at IS NULL OR lease_expires_at < ?)${s.sql} ORDER BY created_at ASC`)
    .all(...ACTIVE_STATES, cutoff, ...s.params) as Record<string, unknown>[];
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

// ── proof of life of an agentic run ─────────────────────────────────────
// An agentic run has no pid of ours to watch, and a business that delegates
// does not write under its own outputs root: its employee dispatches a squad
// (a child row in the same project, writing under the squad's dir), the
// session's hooks log tool_invoked / artifact_touched / bash_completed for the
// trace, and the handoff scripts keep advancing. Measured 2026-08-26: 35 of 39
// business runs withheld since 2026-08-01 carried "agentic run stopped
// reporting (no heartbeat, no file activity)" — none had failed a gate. The
// supervisor read only the mtime under outputs_root. So life is any of these
// signals inside the window, cheapest first.

export type LivenessSource = "heartbeat" | "child_run" | "child_delivered" | "hook_activity" | "file_activity";

export interface AgenticLiveness {
  alive: boolean;
  /** Which signal proved life; null when none did. */
  source: LivenessSource | null;
  /** When that signal was last seen (ms epoch); 0 when none. */
  at: number;
  /** The child run behind a child_* source; null otherwise. */
  childRunId: string | null;
}

/** A child in a supervisor recovery state (failed, stalled) is not proof that
 *  anyone is working; a child that is dispatched, running or being judged is. */
const CHILD_ACTIVE_STATES: ReadonlySet<RunState> = new Set(["dispatched", "running", "verifying", "gated"]);

/** The hook events audit-emit-from-hook.ts writes while an agent works. */
const HOOK_EVENTS: ReadonlySet<string> = new Set(["tool_invoked", "artifact_touched", "bash_completed"]);
/** Newest lines read per daily audit file; a 30-minute window is well inside it. */
const HOOK_SCAN_LIMIT = 4000;

function metaString(meta: Record<string, unknown>, key: string): string | null {
  const v = meta?.[key];
  return typeof v === "string" && v ? v : null;
}

/** Runs of the same project or trace, other than `row` — the squads and
 *  employees the run dispatched (a `dispatch --exec` or brief-squad under the
 *  same --project opens one). Newest first.
 *
 *  Scoped to `row`'s OWN project root, not the caller's: this answers "what
 *  else is this run's project doing", and the supervisor asks it while sweeping
 *  rows of many projects. project_id is a directory basename, so two projects
 *  can genuinely collide on it — the root is what separates them.
 *
 *  A LEGACY row (project_root NULL, nothing to derive it from) keeps the
 *  pre-migration match by id alone, so an upgrade never blinds the liveness
 *  check to a run's own children. The tolerance is one-way on purpose: a row
 *  that knows its project never accepts a rootless sibling. */
export function findRelatedRuns(handle: LedgerHandle, row: RunRow): RunRow[] {
  if (!row.project_id && !row.trace_id) return [];
  const rows = handle.db
    .query(`SELECT * FROM runs WHERE run_id != ? AND (project_id = ? OR trace_id = ?)
            AND (? IS NULL OR project_root = ?) ORDER BY updated_at DESC`)
    .all(row.run_id, row.project_id ?? "", row.trace_id ?? "", row.project_root, row.project_root) as Record<string, unknown>[];
  return rows.map(r => parseRow(r)!);
}

/** Does a hook event belong to this run's trace? By id when the hook carried
 *  one (run_id, project_id, trace_id), else by the path it touched or ran in
 *  falling under the project's dir — the squad dir, a handoff — which the
 *  outputs-root mtime never sees. */
function hookEventOfRun(ev: Record<string, unknown>, row: RunRow, prefix: string | null): boolean {
  if (ev.run_id && ev.run_id === row.run_id) return true;
  if (ev.project_id && ev.project_id === row.project_id) return true;
  if (ev.trace_id && ev.trace_id === row.trace_id) return true;
  if (!prefix) return false;
  const under = (p: unknown) => typeof p === "string" && p.length > 0 && path.resolve(p).startsWith(prefix);
  return under(ev.file_path) || under(ev.cwd);
}

export interface TraceActivity { ts: number; event: Record<string, unknown>; }

/**
 * Newest event of the run's trace since `now - windowMs` whose `event` name is
 * in `eventTypes`, or `null` when none — the event itself, not only its
 * timestamp, so a caller can say WHAT happened, not only THAT something did.
 * Hooks write to the daily audit of the HOME root (audit-emit-from-hook.ts),
 * so that root is read first; the project's own root is read too when it
 * differs. Same reader as every other consumer of the audit
 * (audit.readRecent) — no parser of its own.
 *
 * `eventTypes` is a parameter, not a hardcoded set, because two callers need
 * two different slices of the same scan: resolveAgenticLiveness only cares
 * whether HOOK_EVENTS fired (liveness, below); supervisor.ts's `status` DOING
 * column also wants the coarser trace-tagged milestones (dispatch_*, gate_*,
 * delivered, …) hook events never carry. One scan, one match
 * (hookEventOfRun), because that matcher is the part worth not re-deriving:
 * a hook event's `trace_id` is the Claude Code SESSION id
 * (audit-emit-from-hook.ts's own doc comment says so), not the ledger row's
 * trace_id, so a caller that matched on `trace_id` alone would silently find
 * nothing for the exact runs — agentic ones — this exists to cover.
 */
export function latestTraceActivity(row: RunRow, now: number, windowMs: number, eventTypes: ReadonlySet<string>): TraceActivity | null {
  const since = now - windowMs;
  const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const days = [dayOf(now)];
  if (dayOf(since) !== days[0]) days.push(dayOf(since));
  const scope = metaString(row.meta, "brief_path");
  const prefix = scope ? path.resolve(path.dirname(scope)) + path.sep
    : metaString(row.meta, "outputs_root") ? path.resolve(metaString(row.meta, "outputs_root")!) + path.sep : null;
  const anchors = [os.homedir(), metaString(row.meta, "project_dir")].filter((a): a is string => !!a);
  let audit: AuditLib;
  try { audit = auditLib(); } catch { return null; }
  const seen = new Set<string>();
  let best: TraceActivity | null = null;
  for (const anchor of anchors) {
    for (const day of days) {
      let file: string;
      try { file = audit.logPath(day, anchor).file; } catch { continue; }
      if (seen.has(file)) continue;
      seen.add(file);
      let events: Record<string, unknown>[] = [];
      try { events = audit.readRecent(HOOK_SCAN_LIMIT, day, anchor); } catch { continue; }
      for (const ev of events) {
        if (!eventTypes.has(String(ev.event))) continue;
        const t = Date.parse(String(ev.ts ?? ""));
        if (!(t > since) || (best && t <= best.ts)) continue;
        if (hookEventOfRun(ev, row, prefix)) best = { ts: t, event: ev };
      }
    }
  }
  return best;
}

/** Newest HOOK_EVENTS activity of the run's trace (ms epoch), 0 when none —
 *  the ms-only view resolveAgenticLiveness needs. */
export function latestHookActivityMs(row: RunRow, now: number, windowMs: number): number {
  return latestTraceActivity(row, now, windowMs, HOOK_EVENTS)?.ts ?? 0;
}

/**
 * Is this agentic run alive at `now`? Signals, cheapest first, any one inside
 * `windowMs` is enough:
 *   1. heartbeat_at of the row itself (run-track beat, or the beats the
 *      handoff scripts and brief-squad make as a side effect);
 *   2. a child run of the same project/trace: active and updated inside the
 *      window (`child_run`), or delivered inside the window
 *      (`child_delivered` — the grace for the employee to integrate the
 *      delivery; after it the normal rule applies again);
 *   3. a hook event of the trace in the audit;
 *   4. file activity under outputs_root.
 * The source is reported so the audit (`x_ledger_grace_extended`) and Glance
 * can say what kept the run alive.
 */
export function resolveAgenticLiveness(handle: LedgerHandle, row: RunRow, now: number, windowMs: number): AgenticLiveness {
  const since = now - windowMs;
  const hb = row.heartbeat_at ? Date.parse(row.heartbeat_at) : 0;
  if (hb > since) return { alive: true, source: "heartbeat", at: hb, childRunId: null };
  for (const child of findRelatedRuns(handle, row)) {
    const touched = Math.max(Date.parse(child.updated_at) || 0, child.heartbeat_at ? Date.parse(child.heartbeat_at) : 0);
    if (CHILD_ACTIVE_STATES.has(child.state) && touched > since) {
      return { alive: true, source: "child_run", at: touched, childRunId: child.run_id };
    }
    const delivered = child.state === "delivered" && child.terminal_at ? Date.parse(child.terminal_at) : 0;
    if (delivered > since) return { alive: true, source: "child_delivered", at: delivered, childRunId: child.run_id };
  }
  const hook = latestHookActivityMs(row, now, windowMs);
  if (hook > since) return { alive: true, source: "hook_activity", at: hook, childRunId: null };
  const oroot = metaString(row.meta, "outputs_root");
  if (oroot) {
    const m = latestMtimeMs(oroot);
    if (m > since) return { alive: true, source: "file_activity", at: m, childRunId: null };
  }
  return { alive: false, source: null, at: 0, childRunId: null };
}

export interface BeatAgenticRunsOpts {
  projectId?: string | null;
  traceId?: string | null;
  /** A specific run to beat as well — the run a handoff belongs to. */
  runId?: string | null;
  /** Who is beating (rides into x_ledger_lease_renewed as `source`). */
  source: string;
}

/**
 * Beat the agentic business row(s) of a project — and `runId` when given — as a
 * side effect of a script the employee runs anyway (updateHandoffPhase,
 * brief-squad). The employee never has to remember a heartbeat: delegating,
 * or advancing a phase, IS the heartbeat. Fail-soft by contract: never throws,
 * returns how many rows were beaten (0 when the ledger is unavailable).
 *
 * Confined to the caller's project, `runId` included: keeping another project's
 * run alive is as much a cross-project write as closing it, and a handoff that
 * names a foreign id names it by mistake.
 */
export function beatAgenticRuns(opts: BeatAgenticRunsOpts): number {
  try {
    const handle = openLedger();
    const s = scopeClause();
    const rows = handle.db
      .query(`SELECT * FROM runs WHERE state IN (${ACTIVE_IN}) AND (run_id = ? OR (target_kind = 'business' AND (project_id = ? OR trace_id = ?)))${s.sql}`)
      .all(...ACTIVE_STATES, opts.runId ?? "", opts.projectId ?? "", opts.traceId ?? opts.projectId ?? "", ...s.params) as Record<string, unknown>[];
    let beaten = 0;
    for (const row of rows.map(r => parseRow(r)!)) {
      if (row.meta?.path !== "agentic") continue;
      if (renewLease(handle, row.run_id, AGENTIC_LEASE_SEC, opts.source)) beaten++;
    }
    return beaten;
  } catch (e) {
    console.error(`[run-ledger] beat from ${opts.source} skipped (${(e as Error)?.message ?? e})`);
    return 0;
  }
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
// It also NAMES what it saw. The same sweep that answers "is anything
// happening" already knows which files moved, so every tick with activity
// emits one `artifact_touched` per new file (--touch-max caps the run; 0 turns
// the reporting off). Before this, a squad writing 113 files over 418s left
// sixteen audit events, eleven of them a content-free "still alive", and the
// Glance — which has read `artifact_touched` all along — had nothing to show
// for seven minutes.
//
// Exit conditions (no dangling process, ever): done-sentinel written by the
// parent, parent pid gone, run row missing, or run reached a terminal state.

/** Ceiling per tick. The poll interval is the coalescing window; this is the
 *  ceiling INSIDE one window, so a step that unpacks a tarball cannot turn a
 *  single sweep into ten thousand audit lines. */
const TOUCH_EVENTS_PER_TICK = 25;

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
  // Absent flag = 0 = report nothing, so a caller that never asked for file
  // reporting keeps the old event stream byte for byte.
  let touchBudget = Math.max(0, parseInt(heartbeatArg("--touch-max") || "0", 10));

  const handle = openLedger(dbPath);
  let lastBytes = fileSize(outFile) + fileSize(errFile);
  let lastMtime = watchDir ? latestMtimeMs(watchDir) : 0;
  let lastActivityAt = Date.now();
  let stallRecorded = false;

  // Identity discovery: the dispatcher recorded no child_pid (it can't know
  // one — it's about to block inside spawnSync, and spawnSync exposes the
  // real pid only once the child has already exited). This sidecar is the
  // one process that is both alive concurrently with that child AND started
  // async (so its OWN pid is known immediately) — it looks up the live
  // direct child of --parent and hands the ledger the pid the supervisor is
  // actually allowed to signal. Bounded poll: the dispatcher calls spawnSync
  // right after spawning this sidecar, but "right after" still races module
  // load and any prep work on the dispatcher's side.
  if (parentPid > 0) {
    const discoveryBudgetMs = 5000;
    const discoveryStepMs = 100;
    // Bounded by Date.now(), not a step count: each iteration shells out to
    // `ps` (findChildPid scans the WHOLE process table, processStartedAt adds
    // a second `ps` call on a match), and under real system load a single
    // `ps -A` can run well past 100ms. A `waited += discoveryStepMs` counter
    // assumes every iteration costs exactly its nominal step, so it silently
    // stretches this "5 second" budget to however long N slow syscalls
    // actually take — observed ballooning past 8s under full-suite load,
    // which is what a caller polling for the sidecar's exit actually sees.
    const discoveryDeadline = Date.now() + discoveryBudgetMs;
    while (Date.now() < discoveryDeadline) {
      const childPid = findChildPid(parentPid, process.pid);
      if (childPid) { recordChildPid(handle, runId, childPid, processStartedAt(childPid)); break; }
      if (!pidAlive(parentPid)) break; // dispatcher already gone; nothing to discover
      Bun.sleepSync(discoveryStepMs);
    }
  }

  for (;;) {
    Bun.sleepSync(intervalMs);
    if (doneFile && fs.existsSync(doneFile)) break;
    if (parentPid > 0 && !pidAlive(parentPid)) break;
    const row = getRun(handle, runId);
    if (!row || isTerminal(row.state)) break;

    const bytes = fileSize(outFile) + fileSize(errFile);
    // `sinceMs` is the PREVIOUS high-water mark, so the sweep reports only what
    // moved since the last tick and never re-reports a file it already named.
    const scan = watchDir
      ? scanDir(watchDir, lastMtime, { limit: Math.min(TOUCH_EVENTS_PER_TICK, touchBudget) })
      : { latestMs: 0, changed: [], omitted: 0 };
    const mtime = scan.latestMs;
    const activity = bytes !== lastBytes || mtime > lastMtime;
    lastBytes = bytes;
    if (mtime > lastMtime) lastMtime = mtime;

    const now = Date.now();
    if (activity) {
      lastActivityAt = now;
      stallRecorded = false;
      renewLease(handle, runId, leaseSec);
      for (let i = 0; i < scan.changed.length; i++) {
        const f = scan.changed[i];
        // Always "modify": a poller sees that a file moved, never that it was
        // born. Claiming "create" from an mtime would be exactly the kind of
        // assertion-without-evidence this signal exists to replace.
        emitLedgerAudit("artifact_touched", {
          run_id: runId, action: "modify", file_path: f.path, size_bytes: f.sizeBytes,
          cwd: watchDir, source: "ledger-heartbeat",
          // The overflow rides on the last event of the tick rather than
          // disappearing: a truncated sweep says so.
          ...(i === scan.changed.length - 1 && scan.omitted > 0 ? { omitted: scan.omitted } : {}),
        }, row);
        touchBudget--;
      }
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
