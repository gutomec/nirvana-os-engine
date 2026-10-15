// stall-guard.ts — a dispatch ends itself on a confirmed stall.
//
// A dispatch is awaited through the runtime's background-task notice, and that
// notice arrives only when the dispatch process ends. A worker that hangs (an
// interactive TUI parked on a trust dialog, a CLI waiting on a dead socket) used
// to keep it open forever: on 2026-10-15 an agy worker sat on "Do you trust the
// contents of this project?" for 94 minutes, the heartbeat sidecar saw nothing
// and stopped renewing, the Orca wait loop re-armed 15-minute windows against a
// 7-day deadline, and the user found out by asking.
//
// One owner per phase. While the dispatcher is alive it owns stall decisions,
// through its heartbeat sidecar, the only process awake while the dispatcher is
// blocked inside the worker call. Once the dispatcher is dead the supervisor
// owns them, as before.
//
// A stall is CONFIRMED only when everything is silent:
//   - no worker output (the capture files) and no file written under the run's
//     folders (scaffold root, outputs root, the watched directory);
//   - no hook-recorded tool activity of the run in the audit;
//   - no live child run of the same project (a squad the worker dispatched);
//   - no strong CPU growth of the worker's tree (a secondary signal: an idle TUI
//     polling its backend spends ~0.4 s a minute, a worker receiving a model's
//     stream spends more, and below STALL_CPU_MIN_MS_PER_MIN it does not count).
// Two rules, both settings (0 = off):
//   silence        nothing at all for execution.stall_timeout_min (90);
//   never_started  nothing at all since the worker started, for
//                  execution.stall_no_start_min (45).
// Calibration (213 delivered runs, 2026-08-28 to 10-15): longest silent gap
// 71.8 min, longest wait for a first sign of life 25.5 min.
//
// On a confirmed stall the row goes to `stalled` with meta.stall (rule,
// evidence) and meta.salvaged (the supervisor leaves it to the orchestrating
// agent), the worker's process tree is ended (and its Orca terminal closed),
// and the unblocked dispatcher skips the gate, writes _STATUS.json and exits 76.
//
// Static imports stay light on purpose: the heartbeat sidecar imports this
// module, and the settings core and the Orca module load only when used.

import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import {
  emitLedgerAudit, findRelatedRuns, getRun, isTerminal, killProcessTree, latestHookActivityMs, latestMtimeMs,
  markState, pidAlive, dispatcherAlive, type LedgerHandle, type RunRow,
} from "./run-ledger.ts";
import { processCommands } from "./process-cpu.ts";

/** Exit code of a dispatch (or revise) that ended its worker on a confirmed
 *  stall. 0-4 and 75 were taken. */
export const STALLED_EXIT = 76;

/** How long past the stall threshold a live dispatcher's run may stay silent
 *  before the supervisor and `nrv run-track wait` stop trusting it to decide:
 *  the backstop for a wedged dispatcher or sidecar. */
export const STALL_GRACE_MS = 15 * 60_000;

/** CPU growth, in ms per minute of samples, that counts toward the stall rule. */
export const STALL_CPU_MIN_MS_PER_MIN = 1_000;

export const STALL_TIMEOUT_DEFAULT_MIN = 90;
export const STALL_NO_START_DEFAULT_MIN = 45;

export interface StallThresholds { silenceMs: number; noStartMs: number }

function settingMinutes(key: string, fallback: number): number {
  try {
    const { resolveSetting } = createRequire(import.meta.url)("../../_shared/lib/settings.ts");
    const v = Number(resolveSetting(key).value);
    return Number.isFinite(v) && v >= 0 ? v : fallback;
  } catch { return fallback; }
}

/** The two thresholds, resolved through the settings core, in ms (0 = off). */
export function resolveStallThresholds(): StallThresholds {
  return {
    silenceMs: Math.round(settingMinutes("execution.stall_timeout_min", STALL_TIMEOUT_DEFAULT_MIN) * 60_000),
    noStartMs: Math.round(settingMinutes("execution.stall_no_start_min", STALL_NO_START_DEFAULT_MIN) * 60_000),
  };
}

/** The thresholds this row's sidecar is applying (meta.stall_guard), else the settings. */
export function stallThresholdsOf(row: RunRow): StallThresholds {
  const g = row.meta?.stall_guard as { silence_ms?: unknown; no_start_ms?: unknown } | undefined;
  if (g && typeof g === "object" && Number.isFinite(Number(g.silence_ms)) && Number.isFinite(Number(g.no_start_ms))) {
    return { silenceMs: Number(g.silence_ms), noStartMs: Number(g.no_start_ms) };
  }
  return resolveStallThresholds();
}

export type StallRule = "silence" | "never_started";

export interface StallVerdict { rule: StallRule; silent_ms: number; threshold_ms: number }

/** The rule a run breaks at `now`, or null. `lastActivityAt` is the newest sign
 *  of life of any kind (it starts at `startedAt`). */
export function stallVerdict(o: { startedAt: number; lastActivityAt: number; everActive: boolean; now: number; thresholds: StallThresholds }): StallVerdict | null {
  const { silenceMs, noStartMs } = o.thresholds;
  if (!o.everActive && noStartMs > 0 && o.now - o.startedAt >= noStartMs) {
    return { rule: "never_started", silent_ms: o.now - o.startedAt, threshold_ms: noStartMs };
  }
  if (silenceMs > 0 && o.now - o.lastActivityAt >= silenceMs) {
    return { rule: "silence", silent_ms: o.now - o.lastActivityAt, threshold_ms: silenceMs };
  }
  return null;
}

/** The run's folders a worker may write in: the scaffold root (brief, handoff,
 *  squad audit), the outputs root, the project dir, and any extra given. */
export function runFolders(row: RunRow | null, extra: Array<string | null | undefined> = []): string[] {
  const meta = row?.meta ?? {};
  const dirs = new Set<string>();
  for (const v of [meta.scaffold_root, meta.outputs_root, meta.project_dir, ...extra]) {
    if (typeof v === "string" && v) dirs.add(path.resolve(v));
  }
  // A folder already covered by another one in the set is walked once.
  const list = [...dirs];
  return list.filter((d) => !list.some((o) => o !== d && d.startsWith(o + path.sep)));
}

export interface WideActivity { at: number; source: "files" | "hook" | "child_run"; detail: string | null }

/** Newest activity of the run outside the worker's own output: files under its
 *  folders, hook-recorded tool events of its trace or folder, a live child run.
 *  Null when none since `now - windowMs`. */
export function latestWideActivity(handle: LedgerHandle | null, row: RunRow | null, dirs: string[], now: number, windowMs: number): WideActivity | null {
  const since = now - windowMs;
  let best: WideActivity | null = null;
  const consider = (at: number, source: WideActivity["source"], detail: string | null) => {
    if (at > since && at <= now + 60_000 && (!best || at > best.at)) best = { at: Math.min(at, now), source, detail };
  };
  for (const d of dirs) {
    try { consider(latestMtimeMs(d), "files", d); } catch { /* a folder that vanished says nothing */ }
  }
  if (row) {
    try { consider(latestHookActivityMs(row, now, windowMs), "hook", null); } catch { /* the audit is best-effort */ }
    if (handle) {
      try {
        for (const child of findRelatedRuns(handle, row)) {
          if (!["dispatched", "running", "verifying", "gated"].includes(child.state)) continue;
          const touched = Math.max(Date.parse(child.updated_at) || 0, child.heartbeat_at ? Date.parse(child.heartbeat_at) || 0 : 0);
          consider(touched, "child_run", child.run_id);
        }
      } catch { /* the ledger is best-effort here */ }
    }
  }
  return best;
}

export interface StallRecord {
  confirmed_at: string;
  rule: StallRule;
  silent_ms: number;
  threshold_ms: number;
  /** Who decided: the heartbeat sidecar, or the Orca wait loop. */
  decided_by: "heartbeat" | "orca-wait";
  worker_pid: number | null;
  runtime: string | null;
  /** What was checked and found silent, and when each last moved. */
  signals: Record<string, unknown>;
}

/** One line a person reads: what was silent, for how long. */
export function stallReason(s: Pick<StallRecord, "rule" | "silent_ms" | "threshold_ms">): string {
  const min = (ms: number) => `${Math.round(ms / 6_000) / 10} min`;
  return s.rule === "never_started"
    ? `the worker never started: no output, no file writes, no tool activity and no child run in ${min(s.silent_ms)} since it was launched (execution.stall_no_start_min = ${min(s.threshold_ms)})`
    : `the worker went silent: no output, no file writes, no tool activity and no live child run for ${min(s.silent_ms)} (execution.stall_timeout_min = ${min(s.threshold_ms)})`;
}

/**
 * Mark the run stalled with its evidence. The row also gets meta.salvaged, the
 * supervisor's "a human or the orchestrating agent owns this now" stamp, so no
 * sweep relaunches or salvages it behind the agent's back. Idempotent: a row
 * already stalled is returned as it is. Null when the row is gone or terminal.
 */
export function confirmStall(handle: LedgerHandle, runId: string, verdict: StallVerdict, o: {
  decidedBy: StallRecord["decided_by"]; workerPid?: number | null; signals?: Record<string, unknown>; now?: number;
}): RunRow | null {
  const row = getRun(handle, runId);
  if (!row || isTerminal(row.state)) return null;
  if (row.state === "stalled") return row;
  const now = o.now ?? Date.now();
  const stall: StallRecord = {
    confirmed_at: new Date(now).toISOString(), rule: verdict.rule, silent_ms: verdict.silent_ms, threshold_ms: verdict.threshold_ms,
    decided_by: o.decidedBy, worker_pid: o.workerPid ?? row.child_pid ?? null, runtime: row.runtime, signals: o.signals ?? {},
  };
  const updated = markState(handle, runId, "stalled", {
    error: `stalled: ${stallReason(stall)}`,
    metaPatch: { stall, stop_reason: "stall", salvaged: true, salvaged_at: stall.confirmed_at, salvaged_by: "dispatcher-stall" },
  });
  emitLedgerAudit("x_ledger_stall_confirmed", { run_id: runId, ...stall }, row);
  return updated;
}

/** The stall this row records, when it was confirmed at or after `sinceMs`. */
export function confirmedStallOf(row: RunRow | null, sinceMs = 0): StallRecord | null {
  if (!row || row.state !== "stalled") return null;
  const s = row.meta?.stall as StallRecord | undefined;
  if (!s || typeof s !== "object" || typeof s.confirmed_at !== "string") return null;
  return Date.parse(s.confirmed_at) >= sinceMs ? s : null;
}

/** Processes a sweep or a sidecar runs as: never a worker, never ended here. */
const ENGINE_HELPERS = /\brun-ledger\.ts\b.*\bheartbeat\b|\bsupervisor\.ts\b/;

/**
 * End the stalled worker: the recorded worker pid and every child the
 * dispatcher is blocked on (never the dispatcher itself, this process, a
 * sidecar or a sweep), each with its whole tree (taskkill /T on Windows), then
 * its Orca terminal when it ran in one. SIGTERM, then SIGKILL for what stays.
 * Ending the child is what unblocks the dispatcher's call.
 */
export function endStalledWorker(row: RunRow, o: { parentPid?: number; workerPid?: number | null; selfPid?: number; closeOrca?: (meta: Record<string, unknown>) => boolean } = {}): { ended: number[]; orcaClosed: boolean } {
  const self = o.selfPid ?? process.pid;
  const parent = o.parentPid ?? 0;
  const roots = new Set<number>();
  for (const p of [o.workerPid ?? 0, row.child_pid ?? 0]) if (p > 1 && p !== parent && p !== self && pidAlive(p)) roots.add(p);
  if (parent > 0) {
    const table = processCommands();
    for (const p of table ?? []) {
      if (p.ppid !== parent || p.pid === self || p.pid === parent) continue;
      if (ENGINE_HELPERS.test(p.command)) continue;
      roots.add(p.pid);
    }
  }
  const ended = [...new Set([...roots].flatMap((pid) => killProcessTree(pid)))].filter((p) => p !== parent && p !== self);
  let deadline = Date.now() + 5_000;
  while (ended.some(pidAlive) && Date.now() < deadline) Bun.sleepSync(100);
  for (const pid of ended.filter(pidAlive)) killProcessTree(pid, "SIGKILL");
  deadline = Date.now() + 2_000;
  while (ended.some(pidAlive) && Date.now() < deadline) Bun.sleepSync(100);
  let orcaClosed = false;
  if (row.meta?.orca_worker) {
    const close = o.closeOrca ?? defaultCloseOrca;
    try { orcaClosed = close(row.meta); } catch { orcaClosed = false; }
  }
  return { ended, orcaClosed };
}

function defaultCloseOrca(meta: Record<string, unknown>): boolean {
  const orca = createRequire(import.meta.url)("../../_shared/lib/orca.ts");
  const w = orca.orcaWorkerOf(meta);
  return w ? orca.closeOrcaWorker(w) : false;
}

/**
 * Whether a live dispatcher still owns this row's stall decision: it is alive
 * and its run showed a sign of life within the stall threshold plus the grace.
 * False when the stall guard is off (0), so the supervisor keeps its own
 * judgment for those runs.
 */
export function dispatcherOwnsStall(row: RunRow, now: number = Date.now(), alive: (r: RunRow) => boolean = dispatcherAlive): boolean {
  const { silenceMs } = stallThresholdsOf(row);
  if (silenceMs <= 0 || !alive(row)) return false;
  const beat = Date.parse(row.heartbeat_at ?? row.updated_at ?? "") || 0;
  return now - beat <= silenceMs + STALL_GRACE_MS;
}

/**
 * `nrv run-track wait`'s safety net for a wedged sidecar: the dispatcher is
 * alive, but the lease expired longer ago than the stall threshold plus the
 * grace, so nothing is renewing it and nothing will end it.
 */
export function leaseLongExpired(row: RunRow, now: number = Date.now()): boolean {
  const { silenceMs } = stallThresholdsOf(row);
  if (silenceMs <= 0) return false;
  const lease = Date.parse(row.lease_expires_at ?? "");
  return Number.isFinite(lease) && now - lease > silenceMs + STALL_GRACE_MS;
}

/** The commands an orchestrating agent runs next, for a stalled project. */
export function stallNextSteps(projectId: string | null): string[] {
  const p = projectId ?? "<project>";
  return [
    `nrv run-track status ${p}`,
    `nrv revise ${p} "<what to do>"   # resumes the worker's session`,
  ];
}

/**
 * The dispatcher's side of a confirmed stall: `_STATUS.json` beside the work
 * (state `stalled`, the reason and the next steps), one audit event, and an
 * actionable block on stderr. Nothing was judged and nothing was delivered.
 */
export function reportStall(row: RunRow, stall: StallRecord, o: { audit?: (event: string, payload: Record<string, unknown>) => void; write?: (line: string) => void } = {}): { statusFile: string | null; message: string } {
  const write = o.write ?? ((l: string) => console.error(l));
  const outputsRoot = typeof row.meta?.outputs_root === "string" ? row.meta.outputs_root as string
    : typeof row.meta?.project_dir === "string" ? row.meta.project_dir as string : null;
  const pid = row.project_id ?? row.trace_id ?? row.run_id;
  const reason = stallReason(stall);
  const next = stallNextSteps(pid);
  let statusFile: string | null = null;
  if (outputsRoot) {
    try {
      fs.mkdirSync(outputsRoot, { recursive: true });
      statusFile = path.join(outputsRoot, "_STATUS.json");
      fs.writeFileSync(statusFile, JSON.stringify({
        state: "stalled", gate: "skipped", serious: [], reservations: null, exit_code: STALLED_EXIT,
        stall: { ...stall, reason }, next,
      }, null, 2) + "\n", "utf8");
    } catch { statusFile = null; }
  }
  const payload = { run_id: row.run_id, trace_id: pid, project_id: pid, rule: stall.rule, silent_ms: stall.silent_ms,
    threshold_ms: stall.threshold_ms, worker_pid: stall.worker_pid, runtime: stall.runtime, outputs_root: outputsRoot, exit_code: STALLED_EXIT };
  try { if (o.audit) o.audit("x_dispatch_stalled", payload); else emitLedgerAudit("x_dispatch_stalled", payload, row); } catch { /* the status file carries it */ }
  const who = [stall.worker_pid ? `pid ${stall.worker_pid}` : null, stall.runtime ? `runtime ${stall.runtime}` : null].filter(Boolean).join(", ");
  const lines = [
    "",
    `■ STALLED (exit ${STALLED_EXIT}): ${reason}.`,
    `  The worker${who ? ` (${who})` : ""} was ended. Nothing was judged and nothing was delivered.`,
    ...(outputsRoot ? [`  Partial files: ${outputsRoot}`] : []),
    ...(statusFile ? [`  Status:        ${statusFile}`] : []),
    "  Next (pick one):",
    ...next.map((n) => `    ${n}`),
    "",
  ];
  const message = lines.join("\n");
  write(message);
  return { statusFile, message };
}
