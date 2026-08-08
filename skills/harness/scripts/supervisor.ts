#!/usr/bin/env bun
// supervisor.ts — the never-stall guarantee (routing-360 Phase 4).
//
// "O sistema não pode travar desta forma, sempre deve entregar o que foi solicitado."
// A dispatched run may NEVER be silently forgotten. This script sweeps the
// dispatch ledger (lib/run-ledger.ts) for runs whose lease expired and
// recovers them:
//
//   lease valid                  → skip (the heartbeat sidecar is renewing it)
//   expired + child pid DEAD     → auto-resume (revise.ts session machinery),
//                                  retries++, audit x_ledger_auto_resumed
//   expired + pid ALIVE          → one more activity check; truly stalled →
//                                  SIGTERM the LEDGERED pid, mark failed,
//                                  re-dispatch via cascade-runner (runtime
//                                  failover), audit x_ledger_redispatched
//   retries exhausted            → mark stalled + human_notification_required
//                                  + loud stderr block + macOS notification
//
// Layered supervision (launchd-style): the lazy maybeSweep() piggybacks on
// every nrv find/route/dispatch (mirrors preflight-index.ts), and
// `nrv supervisor install` adds a launchd LaunchAgent (RunAtLoad +
// StartInterval 120) as the outer layer, so recovery happens even when the
// user never runs another nrv command.
//
// Anti-respawn guards (hard rules):
//   - the supervisor NEVER signals a pid that is not row.child_pid of a
//     ledgered run;
//   - it never touches itself or its parent (process.pid / process.ppid);
//   - `sweep` ALWAYS exits 0 — a supervisor crash must never fail a caller.
//
// Subcommands: sweep [--quiet] · status · watch [--interval=120] ·
//              install [--print] · uninstall
//
// Env: NRV_SUPERVISOR=0 disables maybeSweep; NRV_IN_SWEEP=1 is the recursion
// guard (set for every child the sweep spawns).

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  openLedger, getRun, markState, renewLease, incrementRetries, findNonTerminal,
  countNonTerminal, resumeInfo, pidAlive, latestMtimeMs, isTerminal, canTransition,
  getSupervisorMeta, setSupervisorMeta,
  type LedgerHandle, type RunRow, type RunState,
} from "../lib/run-ledger.ts";

const requireCjs = createRequire(import.meta.url);
const SUPERVISOR_PATH = fileURLToPath(import.meta.url);

const STALL_BUDGET_MS = 5 * 60_000;   // matches the driver's default stall budget
const GRACE_LEASE_SEC = 600;          // lease extension when a live run shows activity
const SWEEP_MIN_INTERVAL_MS = 5 * 60_000;
const RESUME_TIMEOUT_MS = 50 * 60_000;
const LAUNCHD_LABEL = "sh.nirvana.supervisor";

// Heavy deps (cascade-runner → host-agent-driver → …) load lazily so
// maybeSweep stays feather-weight on the nrv find/route/dispatch hot path.
function lazyCascade(): { runWithCascade: (args: any) => any } {
  return requireCjs("../lib/cascade-runner.ts");
}
function lazyDriver(): { AUTONOMOUS_DIRECTIVE: string } {
  return requireCjs("../lib/host-agent-driver.ts");
}
function emitAudit(event: string, payload: Record<string, unknown>, row?: RunRow | null): void {
  try {
    const audit = requireCjs("../lib/audit.js");
    audit.emit(event, payload, { trace_id: row?.trace_id ?? undefined, project_id: row?.project_id ?? undefined });
  } catch (e) {
    console.error(`[supervisor] audit emit failed for '${event}': ${(e as Error)?.message ?? e}`);
  }
}

// ── recovery seams (injectable for tests) ─────────────────────────────────

export interface RecoveryResult {
  ok: boolean;
  /** Terminal-ish outcome the sweep should record: delivered | withheld | failed. */
  finalState?: Extract<RunState, "delivered" | "withheld" | "failed">;
  detail?: string;
}

export interface SweepDeps {
  handle?: LedgerHandle;
  /** Injectable clock (ms) so tests can fast-forward leases/heartbeats. */
  now?: number;
  resumeImpl?: (row: RunRow) => RecoveryResult;
  redispatchImpl?: (row: RunRow) => RecoveryResult;
  killImpl?: (pid: number) => void;
  notifyImpl?: (row: RunRow, message: string) => void;
  quiet?: boolean;
}

export interface SweepSummary {
  scanned: number;
  skipped: number;
  graced: number;
  resumed: number;
  redispatched: number;
  recovered: number;
  escalated: number;
  errors: number;
}

function defaultKill(pid: number): void {
  if (!Number.isFinite(pid) || pid <= 1) return; // never signal init/invalid
  try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
}

function defaultNotify(row: RunRow, message: string): void {
  const block = [
    "",
    "╔══════════════════════════════════════════════════════════════════╗",
    "║  NIRVANA-OS SUPERVISOR — HUMAN ATTENTION REQUIRED                ║",
    "╚══════════════════════════════════════════════════════════════════╝",
    `  run:      ${row.run_id}`,
    `  target:   ${row.target_kind ?? "?"}/${row.target_slug ?? "?"}`,
    `  project:  ${row.project_id ?? "?"}`,
    `  retries:  ${row.retries}/${row.max_retries} (exhausted)`,
    `  reason:   ${message}`,
    `  action:   nrv revise ${row.project_id ?? "<project>"} \"<instruction>\"  ·  or: nrv supervisor status`,
    "",
  ].join("\n");
  console.error(block);
  if (process.platform === "darwin") {
    try {
      spawnSync("osascript", ["-e",
        `display notification ${JSON.stringify(`Run ${row.run_id} needs attention: ${message}`)} with title "Nirvana-OS supervisor"`,
      ], { timeout: 5000, stdio: "ignore" });
    } catch { /* best-effort */ }
  }
}

/** Move a run to `running` regardless of which active state it crashed in.
 *  Illegal direct hops route through `failed` (always legal from active). */
function toRunning(h: LedgerHandle, runId: string, why: string): RunRow {
  let row = getRun(h, runId)!;
  if (row.state === "running") return row;
  if (canTransition(row.state, "running")) return markState(h, runId, "running", { error: why });
  row = markState(h, runId, "failed", { error: why });
  return markState(h, runId, "running");
}

function toState(h: LedgerHandle, runId: string, target: RunState, why: string): RunRow {
  const row = getRun(h, runId)!;
  if (row.state === target) return row;
  if (canTransition(row.state, target)) return markState(h, runId, target, { error: why });
  // Route through failed when the direct hop is illegal (e.g. verifying → stalled is legal,
  // but keep this defensive for any future table change).
  const mid = markState(h, runId, "failed", { error: why });
  return canTransition(mid.state, target) ? markState(h, runId, target) : mid;
}

function hasRecentActivity(row: RunRow, now: number): boolean {
  if (row.heartbeat_at && now - Date.parse(row.heartbeat_at) < STALL_BUDGET_MS) return true;
  const oroot = typeof row.meta?.outputs_root === "string" ? (row.meta.outputs_root as string) : null;
  if (oroot) {
    const m = latestMtimeMs(oroot);
    if (m > 0 && now - m < STALL_BUDGET_MS) return true;
  }
  return false;
}

// ── default recovery implementations ──────────────────────────────────────

const CONTINUE_PROMPT = [
  "The previous autonomous run was interrupted before completion (detected by the dispatch-ledger supervisor).",
  "Resume from where it stopped and FINISH every deliverable required by the original brief,",
  "writing the final files under the outputs root of this project. Do not print a summary; deliver files.",
].join(" ");

/** cwd from which revise.ts's findSessionFile can locate the project. */
function reviseCwdFor(meta: Record<string, unknown>): string {
  const pr = typeof meta.project_root === "string" ? (meta.project_root as string) : null;
  if (pr) {
    let d = path.dirname(pr);                       // …/outputs
    if (path.basename(d) === "outputs") {
      d = path.dirname(d);                          // base or base/.nirvana
      return path.basename(d) === ".nirvana" ? path.dirname(d) : d;
    }
  }
  return os.homedir();
}

function defaultResume(h: LedgerHandle, row: RunRow): RecoveryResult {
  const info = resumeInfo(h, row.run_id);
  if (!info) return { ok: false, finalState: "failed", detail: "resumeInfo: run vanished" };
  if (!info.sessionId || !info.projectId) {
    // No session to resume (crashed before session.json) → cold re-dispatch.
    return defaultRedispatch(h, row);
  }
  const reviseScript = path.join(import.meta.dir, "revise.ts");
  const r = spawnSync(process.execPath, [reviseScript, info.projectId, CONTINUE_PROMPT, "--no-color"], {
    cwd: reviseCwdFor(info.meta),
    encoding: "utf8",
    timeout: RESUME_TIMEOUT_MS,
    env: { ...process.env, NRV_IN_SWEEP: "1" },
  });
  // revise.ts: exit 0 = revised + verify + gate PASS · 1 = failed or gate fail.
  if (r.status === 0) return { ok: true, finalState: "delivered", detail: "resumed via revise session" };
  const gateFail = /gate FAIL/i.test((r.stdout || "") + (r.stderr || ""));
  return {
    ok: false,
    finalState: gateFail ? "withheld" : "failed",
    detail: `revise exit ${r.status ?? "?"}${gateFail ? " (gate fail)" : ""}`,
  };
}

function defaultRedispatch(h: LedgerHandle, row: RunRow): RecoveryResult {
  const meta = row.meta || {};
  const promptPath = typeof meta.prompt_path === "string" ? (meta.prompt_path as string) : null;
  const briefPath = typeof meta.brief_path === "string" ? (meta.brief_path as string) : null;
  const projectDir = typeof meta.project_dir === "string" ? (meta.project_dir as string) : null;
  const projectRoot = typeof meta.project_root === "string" ? (meta.project_root as string) : null;
  const outputsRoot = typeof meta.outputs_root === "string" ? (meta.outputs_root as string) : null;
  let prompt: string | null = null;
  try { if (promptPath && fs.existsSync(promptPath)) prompt = fs.readFileSync(promptPath, "utf8"); } catch { /* fall through */ }
  let brief = "";
  try { if (briefPath && fs.existsSync(briefPath)) brief = fs.readFileSync(briefPath, "utf8"); } catch { /* keep "" */ }
  if (!prompt) prompt = brief || null;
  if (!prompt || !projectDir || !projectRoot || !outputsRoot) {
    return { ok: false, finalState: "failed", detail: "meta lacks prompt/paths; cannot re-dispatch" };
  }
  const { runWithCascade } = lazyCascade();
  const { AUTONOMOUS_DIRECTIVE } = lazyDriver();
  const res = runWithCascade({
    runtime: (row.runtime as any) || "claude-code",
    prompt,
    cwd: projectDir,
    addDirs: [projectRoot],
    appendSystemPrompt: AUTONOMOUS_DIRECTIVE,
    yolo: true,
    brief: brief || prompt.slice(0, 4000),
    projectRoot,
    outputsRoot,
    projectId: row.project_id,
    taskHint: `supervisor auto-redispatch · ${row.target_slug ?? "?"}`,
    ledger: { runId: row.run_id, watchDir: outputsRoot },
  });
  if (!res.ok) return { ok: false, finalState: "failed", detail: `redispatch failed: ${res.error || res.stderr || "unknown"}` };
  // Verify: at least one non-stub deliverable on disk.
  const produced = listFiles(outputsRoot).filter(f => { try { return fs.statSync(f).size >= 200; } catch { return false; } });
  if (produced.length === 0) return { ok: false, finalState: "failed", detail: "redispatch produced no non-stub deliverable" };
  // Gate: offline quality gate over text artifacts (same rubric dispatch runs).
  const gateScript = path.join(import.meta.dir, "quality-gate.ts");
  const textFiles = produced.filter(f => /\.(md|txt|json)$/i.test(f));
  let allPass = true;
  for (const f of textFiles) {
    const g = spawnSync(process.execPath, [gateScript, f, "--auto", "--offline"], { encoding: "utf8", env: { ...process.env, NRV_IN_SWEEP: "1" } });
    if (g.status !== 0) allPass = false;
  }
  if (textFiles.length === 0) return { ok: true, finalState: "delivered", detail: `redispatched (${produced.length} files; gate indeterminate)` };
  return allPass
    ? { ok: true, finalState: "delivered", detail: `redispatched (${produced.length} files; gate pass)` }
    : { ok: false, finalState: "withheld", detail: `redispatched but gate FAIL (${textFiles.length} text files)` };
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(full));
    else if (e.isFile()) out.push(full);
  }
  return out;
}

// ── the sweep ─────────────────────────────────────────────────────────────

export function sweep(deps: SweepDeps = {}): SweepSummary {
  const summary: SweepSummary = { scanned: 0, skipped: 0, graced: 0, resumed: 0, redispatched: 0, recovered: 0, escalated: 0, errors: 0 };
  let h: LedgerHandle;
  try { h = deps.handle ?? openLedger(); } catch (e) {
    console.error(`[supervisor] cannot open ledger: ${(e as Error)?.message ?? e}`);
    summary.errors++;
    return summary;
  }
  const now = deps.now ?? Date.now();
  let rows: RunRow[] = [];
  try { rows = findNonTerminal(h); } catch (e) {
    console.error(`[supervisor] ledger query failed: ${(e as Error)?.message ?? e}`);
    summary.errors++;
    return summary;
  }
  for (const row of rows) {
    summary.scanned++;
    try { sweepOne(h, row, now, deps, summary); }
    catch (e) {
      summary.errors++;
      console.error(`[supervisor] sweep of ${row.run_id} failed: ${(e as Error)?.message ?? e}`);
    }
  }
  try { setSupervisorMeta(h, "last_sweep_at", String(Date.now())); } catch { /* bookkeeping only */ }
  return summary;
}

function sweepOne(h: LedgerHandle, row: RunRow, now: number, deps: SweepDeps, summary: SweepSummary): void {
  // Already escalated: a human owns it now. Re-notifying every sweep would be
  // notification spam, not supervision.
  if (row.state === "stalled") { summary.skipped++; return; }
  const lease = row.lease_expires_at ? Date.parse(row.lease_expires_at) : 0;
  if (lease > now) { summary.skipped++; return; }

  const pid = row.child_pid ?? 0;
  // NEVER touch ourselves or our parent, no matter what the ledger says.
  if (pid && (pid === process.pid || pid === process.ppid)) {
    console.error(`[supervisor] self-guard: run ${row.run_id} claims pid ${pid} (this process/parent); skipping`);
    emitAudit("x_ledger_self_guard_skip", { run_id: row.run_id, pid }, row);
    summary.skipped++;
    return;
  }

  const alive = pid > 0 && pidAlive(pid);

  if (alive) {
    // One more activity check before any signal — a healthy long-thinking run
    // must never be killed for a merely-expired lease.
    if (hasRecentActivity(row, now)) {
      renewLease(h, row.run_id, GRACE_LEASE_SEC);
      emitAudit("x_ledger_grace_extended", { run_id: row.run_id, lease_sec: GRACE_LEASE_SEC }, row);
      summary.graced++;
      return;
    }
    // Truly stalled with a live pid: SIGTERM the LEDGERED pid only, mark
    // failed, then fail over via the cascade (fresh runtime, fresh prompt).
    (deps.killImpl ?? defaultKill)(pid);
    toState(h, row.run_id, "failed", `supervisor: stalled >${STALL_BUDGET_MS}ms with live pid ${pid}; SIGTERM sent`);
    let fresh = getRun(h, row.run_id)!;
    if (fresh.retries >= fresh.max_retries) { escalate(h, fresh, deps, summary, "stalled with live pid; retries exhausted"); return; }
    incrementRetries(h, row.run_id);
    toRunning(h, row.run_id, "supervisor redispatch attempt");
    emitAudit("x_ledger_redispatched", { run_id: row.run_id, attempt: fresh.retries + 1, prev_pid: pid }, row);
    summary.redispatched++;
    const res = (deps.redispatchImpl ?? ((r: RunRow) => defaultRedispatch(h, r)))(getRun(h, row.run_id)!);
    finalize(h, row.run_id, res, summary);
    return;
  }

  // Lease expired and the driving process is DEAD: the run was orphaned.
  if (row.retries >= row.max_retries) { escalate(h, row, deps, summary, "orphaned run; retries exhausted"); return; }
  incrementRetries(h, row.run_id);
  toRunning(h, row.run_id, "supervisor auto-resume attempt");
  emitAudit("x_ledger_auto_resumed", { run_id: row.run_id, attempt: row.retries + 1, session_id: row.session_id }, row);
  summary.resumed++;
  const res = (deps.resumeImpl ?? ((r: RunRow) => defaultResume(h, r)))(getRun(h, row.run_id)!);
  finalize(h, row.run_id, res, summary);
}

function finalize(h: LedgerHandle, runId: string, res: RecoveryResult, summary: SweepSummary): void {
  const target = res.finalState ?? (res.ok ? "delivered" : "failed");
  const row = getRun(h, runId);
  if (!row || isTerminal(row.state)) return;
  if (row.state !== target) toState(h, runId, target, res.detail ?? "");
  emitAudit("x_ledger_recovery_result", { run_id: runId, ok: res.ok, final_state: target, detail: res.detail ?? null }, row);
  if (res.ok) summary.recovered++;
}

function escalate(h: LedgerHandle, row: RunRow, deps: SweepDeps, summary: SweepSummary, reason: string): void {
  toState(h, row.run_id, "stalled", `supervisor: ${reason}`);
  // human_notification_required is in the audit enum; the ledger trail gets
  // the x_ variant too so `grep x_ledger_` tells the whole recovery story.
  emitAudit("human_notification_required", {
    run_id: row.run_id, reason, retries: row.retries, max_retries: row.max_retries,
    target_slug: row.target_slug, target_kind: row.target_kind,
  }, row);
  emitAudit("x_ledger_notify_human", { run_id: row.run_id, reason }, row);
  (deps.notifyImpl ?? defaultNotify)(row, reason);
  summary.escalated++;
}

// ── lazy sweep (wired into nrv find/route/dispatch, like preflight-index) ──

/** <20ms when nothing pending: one supervisor_meta read + one indexed COUNT.
 *  When runs are pending and the last sweep is >5 min old, spawns a DETACHED
 *  background `supervisor sweep --quiet` (recovery may run LLMs — it must
 *  never block the user's command). Guards: NRV_SUPERVISOR=0 opt-out,
 *  NRV_IN_SWEEP=1 recursion guard. Returns true when a sweep was spawned. */
export function maybeSweep(): boolean {
  try {
    if (process.env.NRV_SUPERVISOR === "0" || process.env.NRV_IN_SWEEP === "1") return false;
    const h = openLedger();
    const last = getSupervisorMeta(h, "last_sweep_at");
    if (last && Date.now() - Number(last) < SWEEP_MIN_INTERVAL_MS) return false;
    setSupervisorMeta(h, "last_sweep_at", String(Date.now()));
    if (countNonTerminal(h) === 0) return false;
    const child = spawn(process.execPath, [SUPERVISOR_PATH, "sweep", "--quiet"], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, NRV_IN_SWEEP: "1" },
    });
    child.unref();
    return true;
  } catch (e) {
    console.error(`[supervisor] maybeSweep failed: ${(e as Error)?.message ?? e}`);
    return false;
  }
}

// ── launchd (outer supervision layer) ─────────────────────────────────────

export function launchdPlistPath(): string {
  return path.join(os.homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}

export function renderLaunchdPlist(): string {
  const logDir = path.join(os.homedir(), ".nirvana", "logs");
  const logFile = path.join(logDir, "supervisor.log");
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    `<dict>`,
    `  <key>Label</key><string>${LAUNCHD_LABEL}</string>`,
    `  <key>ProgramArguments</key>`,
    `  <array>`,
    `    <string>${process.execPath}</string>`,
    `    <string>${SUPERVISOR_PATH}</string>`,
    `    <string>sweep</string>`,
    `    <string>--quiet</string>`,
    `  </array>`,
    `  <key>RunAtLoad</key><true/>`,
    `  <key>StartInterval</key><integer>120</integer>`,
    `  <key>EnvironmentVariables</key>`,
    `  <dict>`,
    `    <key>PATH</key><string>${process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"}</string>`,
    `  </dict>`,
    `  <key>StandardOutPath</key><string>${logFile}</string>`,
    `  <key>StandardErrorPath</key><string>${logFile}</string>`,
    `</dict>`,
    `</plist>`,
    ``,
  ].join("\n");
}

function installLaunchd(printOnly: boolean): number {
  const content = renderLaunchdPlist();
  if (printOnly) { process.stdout.write(content); return 0; }
  if (process.platform !== "darwin") {
    console.error("supervisor install: launchd is macOS-only. On other platforms use `nrv supervisor watch` (or a cron/systemd timer running `nrv supervisor sweep --quiet`).");
    return 1;
  }
  const plist = launchdPlistPath();
  fs.mkdirSync(path.dirname(plist), { recursive: true });
  fs.mkdirSync(path.join(os.homedir(), ".nirvana", "logs"), { recursive: true });
  fs.writeFileSync(plist, content);
  try { spawnSync("launchctl", ["unload", plist], { stdio: "ignore", timeout: 10_000 }); } catch { /* not loaded */ }
  try {
    const r = spawnSync("launchctl", ["load", "-w", plist], { encoding: "utf8", timeout: 10_000 });
    if (r.status !== 0) console.error(`supervisor install: launchctl load exited ${r.status}: ${(r.stderr || "").trim()}`);
  } catch (e) { console.error(`supervisor install: launchctl failed: ${(e as Error)?.message ?? e}`); }
  console.log(`✓ launchd agent installed: ${plist} (sweep every 120s + at load)`);
  return 0;
}

function uninstallLaunchd(): number {
  const plist = launchdPlistPath();
  try { spawnSync("launchctl", ["unload", plist], { stdio: "ignore", timeout: 10_000 }); } catch { /* not loaded */ }
  if (fs.existsSync(plist)) { fs.rmSync(plist, { force: true }); console.log(`✓ removed ${plist}`); }
  else console.log("supervisor uninstall: no launchd agent installed.");
  return 0;
}

// ── CLI ───────────────────────────────────────────────────────────────────

function cliStatus(): number {
  const h = openLedger();
  const rows = findNonTerminal(h);
  if (rows.length === 0) { console.log("supervisor: no non-terminal runs. Ledger is clean."); return 0; }
  const pad = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s.padEnd(n));
  console.log(pad("RUN", 24) + pad("STATE", 11) + pad("TARGET", 26) + pad("PID", 8) + pad("RETRIES", 8) + pad("LEASE EXPIRES", 22) + "LAST HEARTBEAT");
  const now = Date.now();
  for (const r of rows) {
    const leaseMs = r.lease_expires_at ? Date.parse(r.lease_expires_at) : 0;
    const lease = r.lease_expires_at ? `${r.lease_expires_at.slice(11, 19)}Z${leaseMs < now ? " EXPIRED" : ""}` : "(none)";
    const alive = r.child_pid && pidAlive(r.child_pid) ? "" : r.child_pid ? " dead" : "";
    console.log(
      pad(r.run_id, 24) + pad(r.state, 11) + pad(`${r.target_kind ?? "?"}/${r.target_slug ?? "?"}`, 26)
      + pad(`${r.child_pid ?? "-"}${alive}`, 8) + pad(`${r.retries}/${r.max_retries}`, 8)
      + pad(lease, 22) + (r.heartbeat_at ? `${r.heartbeat_at.slice(11, 19)}Z` : "(never)"),
    );
  }
  return 0;
}

function argValue(name: string, fallback?: string): string | undefined {
  const eq = process.argv.find(a => a.startsWith(`${name}=`));
  if (eq) return eq.split("=").slice(1).join("=");
  const i = process.argv.indexOf(name);
  if (i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")) return process.argv[i + 1];
  return fallback;
}

if (import.meta.main) {
  const sub = process.argv[2] ?? "status";
  const quiet = process.argv.includes("--quiet");
  switch (sub) {
    case "sweep": {
      // Anything spawned below must not recursively trigger maybeSweep.
      process.env.NRV_IN_SWEEP = "1";
      try {
        const s = sweep({ quiet });
        if (!quiet) {
          console.log(`sweep: scanned=${s.scanned} skipped=${s.skipped} graced=${s.graced} resumed=${s.resumed} redispatched=${s.redispatched} recovered=${s.recovered} escalated=${s.escalated} errors=${s.errors}`);
        }
      } catch (e) {
        console.error(`[supervisor] sweep crashed: ${(e as Error)?.message ?? e}`);
      }
      process.exit(0); // sweep ALWAYS exits 0 (anti-respawn guard)
    }
    case "status":
      process.exit(cliStatus());
    case "watch": {
      const intervalSec = Math.max(10, parseInt(argValue("--interval", "120") || "120", 10));
      process.env.NRV_IN_SWEEP = "1";
      console.log(`supervisor watch — sweeping every ${intervalSec}s (Ctrl-C to stop)`);
      for (;;) {
        try {
          const s = sweep({ quiet });
          if (!quiet) console.log(`[${new Date().toISOString()}] scanned=${s.scanned} graced=${s.graced} resumed=${s.resumed} redispatched=${s.redispatched} escalated=${s.escalated}`);
        } catch (e) { console.error(`[supervisor] sweep crashed: ${(e as Error)?.message ?? e}`); }
        Bun.sleepSync(intervalSec * 1000);
      }
    }
    case "install":
      process.exit(installLaunchd(process.argv.includes("--print")));
    case "uninstall":
      process.exit(uninstallLaunchd());
    default:
      console.log([
        "usage: nrv supervisor <sweep|status|watch|install|uninstall>",
        "",
        "  sweep [--quiet]        one recovery pass over the dispatch ledger (always exits 0)",
        "  status                 table of non-terminal runs",
        "  watch [--interval=120] loop sweep forever",
        "  install [--print]      write + load the launchd LaunchAgent (--print: show plist only)",
        "  uninstall              unload + remove the launchd LaunchAgent",
        "",
        "env: NRV_SUPERVISOR=0 disables the lazy sweep on nrv find/route/dispatch",
      ].join("\n"));
      process.exit(sub === "help" || sub === "--help" ? 0 : 2);
  }
}
