#!/usr/bin/env bun
// supervisor.ts — the never-stall guarantee (routing-360 Phase 4).
//
// "O sistema não pode travar desta forma, sempre deve entregar o que foi solicitado."
// A dispatched run may NEVER be silently forgotten. This script sweeps the
// dispatch ledger (lib/run-ledger.ts) for runs whose lease expired and
// recovers them:
//
//   lease valid                  → skip (the heartbeat sidecar is renewing it)
//   expired + child pid DEAD     → auto-resume (revise.ts session machinery,
//                                  which delivers through the same pipeline and
//                                  answers with its exit code: 0 delivered ·
//                                  2 withheld · 3 indeterminate), retries++,
//                                  audit x_ledger_auto_resumed
//   expired + pid ALIVE          → one more activity check; truly stalled →
//                                  SIGTERM the LEDGERED pid, mark failed,
//                                  re-dispatch via cascade-runner (runtime
//                                  failover), audit x_ledger_redispatched, and
//                                  hand the fresh run's output to the delivery
//                                  pipeline (verify → gate → delivered |
//                                  withheld | indeterminate)
//   retries exhausted            → mark stalled + SALVAGE the artifacts left on
//                                  disk (read-only verify → gate → withheld |
//                                  delivered) + human_notification_required
//                                  + loud stderr block + macOS notification,
//                                  all three now carrying the salvage verdict
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
// Subcommands: sweep [--quiet] [--all-projects] · status [--all-projects] ·
//              watch [--interval=120] [--all-projects] · install [--print] ·
//              uninstall
//
// PROJECT SCOPE — the supervisor is the exception, and the only one.
// Every other reader of the ledger sees just the project it is serving, because
// a session working in one project must not see (or close) another project's
// runs. Recovery cannot work that way: a run whose session died has nobody left
// in its project to sweep it. So:
//
//   --all-projects            the whole machine. How launchd invokes it
//                             (renderLaunchdPlist writes the flag), and how an
//                             operator asks for the machine-wide picture.
//   no flag, project found    only the project this process stands in — the
//                             lazy sweep piggybacking on a user's nrv command.
//   no flag, no project       the whole machine, with a note on stderr saying
//                             why. This is launchd's own shape (cwd `/`, no
//                             NIRVANA_PROJECT_ROOT): the never-stall guarantee
//                             must not depend on an operator remembering to
//                             re-run `nrv supervisor install` after upgrading.
//
// Env: NRV_SUPERVISOR=0 disables maybeSweep; NRV_IN_SWEEP=1 is the recursion
// guard (set for every child the sweep spawns).

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { notifyDesktop } from "../lib/os-notify.ts";
import {
  openLedger,
  getRun,
  markState,
  renewLease,
  incrementRetries,
  findNonTerminal,
  countNonTerminal,
  resumeInfo,
  pidAlive,
  latestMtimeMs,
  isTerminal,
  AGENTIC_LEASE_SEC,
  resolveAgenticLiveness,
  canTransition,
  getSupervisorMeta,
  setSupervisorMeta,
  patchMeta,
  resolveProjectRoot,
  type LedgerHandle,
  type RunRow,
  type RunState,
  resolveLedgerDbPath,
} from "../lib/run-ledger.ts";
import { acquireLockSync } from "../../_shared/lib/file-lock.ts";
import type { DeliveryArgs, DeliveryResult, GateOutcome } from "../lib/delivery-pipeline.ts";
import { resolveSetting } from "../../_shared/lib/settings.ts";

const requireCjs = createRequire(import.meta.url);
const SUPERVISOR_PATH = fileURLToPath(import.meta.url);

const STALL_BUDGET_MS = resolveSetting("supervisor.stall_threshold_ms").value;   // the driver's stall budget reads the same setting
const GRACE_LEASE_SEC = 600;          // lease extension when a live run shows activity
const SWEEP_MIN_INTERVAL_MS = 5 * 60_000;
const RESUME_TIMEOUT_MS = 50 * 60_000;
const PID_EXIT_WAIT_MS = 2000;        // bounded wait for a SIGTERMed child before salvage
/** How often a still-running run reports in. The owner asked to be kept in the
 *  loop, not only told at the end: an hour of silence is indistinguishable from
 *  a dead run. Rate-limited per row, so a 120s sweep never becomes spam.
 *  0 disables it (the supervisor.progress_ping_sec setting: env
 *  NIRVANA_PROGRESS_PING_SEC, else the project or global config). */
const PROGRESS_PING_SEC = resolveSetting("supervisor.progress_ping_sec").value;
const LAUNCHD_LABEL = "sh.nirvana.supervisor";

/** Why an escalated run's artifacts can never be called complete: the run was
 *  interrupted, so the file set on disk is whatever it managed to write. */
const SALVAGE_CEILING_REASON =
  "supervisor salvage: the run was interrupted, so the deliverable set is unproven; only a passing manifest verification can call it complete";

// Heavy deps (cascade-runner → host-agent-driver → …) load lazily so
// maybeSweep stays feather-weight on the nrv find/route/dispatch hot path.
function lazyCascade(): { runWithCascade: (args: any) => any } {
  return requireCjs("../lib/cascade-runner.ts");
}
function lazyDriver(): { AUTONOMOUS_DIRECTIVE: string } {
  return requireCjs("../lib/host-agent-driver.ts");
}
function lazyDelivery(): typeof import("../lib/delivery-pipeline.ts") {
  return requireCjs("../lib/delivery-pipeline.ts");
}
function lazyConfig(): typeof import("../lib/harness-config.ts") {
  return requireCjs("../lib/harness-config.ts");
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

/** What the salvage of an escalated run concluded. Rides into the audit
 *  payloads, the ledger row (meta.salvage) and the human notification, so a
 *  human can decide from the message instead of doing archaeology on disk. */
export interface SalvageVerdict {
  /** true when the delivery pipeline actually judged the artifacts. */
  judged: boolean;
  /** Why nothing was judged; null when `judged`. */
  skipReason: "no_outputs_root" | "no_artifacts" | "live_writer" | "pipeline_error" | null;
  /** Non-stub artifacts found under the outputs root. */
  artifacts: number;
  /** How many of them the quality gate knows how to judge. */
  gateable: number;
  gate: GateOutcome | "fail-forced" | null;
  delivered: boolean;
  /** Completeness-ceiling reason when the ceiling bound the outcome. */
  ceiling: string | null;
  outputsRoot: string | null;
  /** Ledger state the run ended in, read back after the salvage. */
  finalState: RunState | null;
  detail: string | null;
}

export interface SweepDeps {
  handle?: LedgerHandle;
  /** Sweep every project instead of the one this process is serving. The
   *  supervisor's exception — see the PROJECT SCOPE block at the top. */
  allProjects?: boolean;
  /** Injectable clock (ms) so tests can fast-forward leases/heartbeats. */
  now?: number;
  resumeImpl?: (row: RunRow) => RecoveryResult;
  redispatchImpl?: (row: RunRow) => RecoveryResult;
  killImpl?: (pid: number) => void;
  notifyImpl?: (row: RunRow, message: string, verdict?: SalvageVerdict | null) => void;
  /** Artifact salvage at escalation (default: salvageStalledRun). */
  salvageImpl?: (row: RunRow) => SalvageVerdict;
  /** Bounded wait for a SIGTERMed child to exit before salvaging (tests: 0). */
  pidExitWaitMs?: number;
  /** Periodic "still working" notice (default: desktop notification). */
  pingImpl?: (row: RunRow, elapsedMin: number) => void;
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
  salvaged: number;
  errors: number;
}

function defaultKill(pid: number): void {
  if (!Number.isFinite(pid) || pid <= 1) return; // never signal init/invalid
  try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
}

/** Why the salvage landed where it landed, in one human-readable clause. */
function salvageWhy(v: SalvageVerdict): string {
  if (v.ceiling) return "gate passed, completeness unproven (no manifest)";
  if (v.gate === "fail") return "quality gate rejected the artifacts";
  if (v.gate === "indeterminate") return "no artifact the gate knows how to judge";
  if (v.delivered) return "gate passed and the manifest proved the set complete";
  return v.detail ?? "see the audit trail";
}

const SKIP_WHY: Record<NonNullable<SalvageVerdict["skipReason"]>, string> = {
  no_outputs_root: "the ledger row has no outputs dir on disk",
  no_artifacts: "the outputs dir holds no non-stub artifact",
  live_writer: "the run's child process is still alive; judging it would race a writer",
  pipeline_error: "the delivery pipeline itself errored",
};

/** The salvage block of the escalation notice: what was found, what the gate
 *  said, what was decided, and where the files are. */
function salvageLines(v: SalvageVerdict | null | undefined): string[] {
  if (!v) return [];
  if (!v.judged) {
    return [
      `  salvage:  nothing judged — ${SKIP_WHY[v.skipReason ?? "no_artifacts"]}`,
      ...(v.outputsRoot ? [`  outputs:  ${v.outputsRoot}`] : []),
    ];
  }
  return [
    `  salvage:  ${v.artifacts} artifact(s) on disk · ${v.gateable} gateable · gate ${String(v.gate ?? "n/a").toUpperCase()}`,
    `  decision: ${v.delivered ? "DELIVERED" : "WITHHELD"} — ${salvageWhy(v)}`,
    `  outputs:  ${v.outputsRoot ?? "?"}`,
  ];
}

/** One-line salvage summary for the OS notification (no room for a block). */
function salvageOneLiner(v: SalvageVerdict | null | undefined): string {
  if (!v) return "";
  if (!v.judged) return ` — artifacts not judged (${v.skipReason ?? "unknown"})`;
  return ` — ${v.artifacts} artifact(s), gate ${String(v.gate ?? "n/a")}, ${v.delivered ? "delivered" : "WITHHELD"}`;
}

/** The boxed stderr escalation block. Exported so tests can pin its text
 *  without the osascript side effect of defaultNotify. */
export function renderEscalationNotice(row: RunRow, message: string, verdict?: SalvageVerdict | null): string {
  return [
    "",
    "╔══════════════════════════════════════════════════════════════════╗",
    "║  NIRVANA-OS SUPERVISOR — HUMAN ATTENTION REQUIRED                ║",
    "╚══════════════════════════════════════════════════════════════════╝",
    `  run:      ${row.run_id}`,
    `  target:   ${row.target_kind ?? "?"}/${row.target_slug ?? "?"}`,
    `  project:  ${row.project_id ?? "?"}`,
    `  retries:  ${row.retries}/${row.max_retries} (exhausted)`,
    `  reason:   ${message}`,
    ...salvageLines(verdict),
    `  action:   nrv revise ${row.project_id ?? "<project>"} \"<instruction>\"  ·  or: nrv supervisor status`,
    "",
  ].join("\n");
}

function defaultNotify(row: RunRow, message: string, verdict?: SalvageVerdict | null): void {
  console.error(renderEscalationNotice(row, message, verdict));
  notifyDesktop("Nirvana-OS supervisor", `Run ${row.run_id} needs attention: ${message}${salvageOneLiner(verdict)}`);
}

function defaultPing(row: RunRow, elapsedMin: number): void {
  notifyDesktop("Nirvana-OS", `${row.target_kind ?? "run"}/${row.target_slug ?? row.run_id}: em andamento há ${elapsedMin} min (${row.state})`);
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

function hasRecentActivity(row: RunRow, now: number, budgetMs: number = STALL_BUDGET_MS): boolean {
  if (row.heartbeat_at && now - Date.parse(row.heartbeat_at) < budgetMs) return true;
  const oroot = typeof row.meta?.outputs_root === "string" ? (row.meta.outputs_root as string) : null;
  if (oroot) {
    const m = latestMtimeMs(oroot);
    if (m > 0 && now - m < budgetMs) return true;
  }
  return false;
}

/** True for a run opened by the agentic door (brief-squad / brief-business /
 *  run-track), as opposed to one this supervisor's scripted dispatch spawned. */
function isAgentic(row: RunRow): boolean {
  return row.meta?.path === "agentic";
}

/** Tell the owner a long run is still alive, at most once per PROGRESS_PING_SEC.
 *  The stamp lives in meta so the interval survives across sweeps and restarts;
 *  created_at seeds it, so the first ping lands one interval after the start and
 *  never at the moment of dispatch. */
function maybePing(h: LedgerHandle, row: RunRow, now: number, deps: SweepDeps): void {
  if (PROGRESS_PING_SEC <= 0) return;
  const last = Date.parse(String(row.meta?.last_ping_at ?? row.created_at ?? "")) || 0;
  if (!last || now - last < PROGRESS_PING_SEC * 1000) return;
  const started = Date.parse(String(row.created_at ?? "")) || now;
  const elapsedMin = Math.max(1, Math.round((now - started) / 60_000));
  patchMeta(h, row.run_id, { last_ping_at: new Date(now).toISOString() });
  emitAudit("x_ledger_progress_ping", { run_id: row.run_id, elapsed_min: elapsedMin, state: row.state }, row);
  (deps.pingImpl ?? defaultPing)(row, elapsedMin);
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
    // Rows written before the dispatch had one answer for "which project is this?" stored the
    // SCAFFOLD here (`<project>/outputs/<pid>`, or `<project>/.nirvana/outputs/<pid>`), so those
    // are still walked back. A row written since already names the project: take it as it is,
    // instead of falling through to HOME because it does not look like an outputs path.
    let d = path.dirname(pr);                       // …/outputs
    if (path.basename(d) === "outputs") {
      d = path.dirname(d);                          // base or base/.nirvana
      return path.basename(d) === ".nirvana" ? path.dirname(d) : d;
    }
    return pr;
  }
  return os.homedir();
}

function defaultResume(h: LedgerHandle, row: RunRow): RecoveryResult {
  const info = resumeInfo(h, row.run_id);
  if (!info) return { ok: false, finalState: "failed", detail: "resumeInfo: run vanished" };
  if (!info.sessionId || !info.projectId) {
    // No session to resume (crashed before session.json) → cold re-dispatch.
    return redispatchRun(h, row);
  }
  const reviseScript = path.join(import.meta.dir, "revise.ts");
  const r = spawnSync(process.execPath, [reviseScript, info.projectId, CONTINUE_PROMPT, "--no-color"], {
    cwd: reviseCwdFor(info.meta),
    encoding: "utf8",
    timeout: RESUME_TIMEOUT_MS,
    // NRV_IN_SWEEP is the recursion guard AND revise.ts's signal that nobody is
    // watching: it drops its revision budget to 0 and hands the verdict back.
    env: { ...process.env, NRV_IN_SWEEP: "1" },
  });
  // revise.ts speaks the delivery pipeline's exit table (same as dispatch.ts):
  // 0 delivered · 2 withheld (gate FAIL) · 3 indeterminate (nothing judged) ·
  // anything else failed. Read the CODE — the previous version grepped stdout
  // for "gate FAIL", and prose is not a control-flow signal.
  return resumeOutcome(r.status);
}

/** revise.ts exit code → recovery outcome. Exported so the mapping is pinned by
 *  a test instead of only by a live spawn. */
export function resumeOutcome(status: number | null): RecoveryResult {
  switch (status) {
    case 0: return { ok: true, finalState: "delivered", detail: "resumed via revise session (delivered)" };
    case 2: return { ok: false, finalState: "withheld", detail: "resumed but delivery WITHHELD (revise exit 2: gate FAIL)" };
    case 3: return { ok: false, finalState: "withheld", detail: "resumed but INDETERMINATE (revise exit 3: no gateable artifact; nothing judged)" };
    default: return { ok: false, finalState: "failed", detail: `revise exit ${status ?? "?"}` };
  }
}

export interface RedispatchOverrides extends Partial<DeliveryArgs> {
  /** Test seam standing in for cascade-runner's runWithCascade — the fresh run
   *  the supervisor starts. Everything else here is a DeliveryArgs override. */
  runCascadeImpl?: (args: any) => { ok: boolean; error?: string; stderr?: string; sessionId?: string | null; finalRuntime?: string };
}

/** The pipeline's verdict, restated in the ledger/sweep vocabulary. The
 *  pipeline has ALREADY driven the row to its terminal state; this only names
 *  it for finalize() and the sweep counters, so `recovered` keeps meaning
 *  "actually delivered" and never "we ran something".
 *
 *  exit 0 delivered · 2 withheld (gate FAIL, or the ceiling when a caller sets
 *  one) · 3 indeterminate — nothing gateable was judged, so the ledger row is
 *  `withheld` with gate:"indeterminate" and NOTHING is delivered · 1 failed. */
function recoveryFromDelivery(res: DeliveryResult): RecoveryResult {
  const files = res.produced.length;
  switch (res.exitCode) {
    case 0:
      return {
        ok: true, finalState: "delivered",
        detail: `redispatched: delivered (${files} file(s), ${res.gatedFiles.length} judged, gate ${res.gateOutcome}${res.revisionsUsed ? `, ${res.revisionsUsed} revision(s)` : ""})`,
      };
    case 2:
      return {
        ok: false, finalState: "withheld",
        detail: `redispatched: WITHHELD (gate ${res.gateOutcome}, ${res.gatedFiles.length} judged, ${res.revisionsUsed} revision(s))${res.ceilingApplied ? " — completeness ceiling" : ""}`,
      };
    case 3:
      return {
        ok: false, finalState: "withheld",
        detail: `redispatched: INDETERMINATE — no gateable artifact among ${files} file(s); nothing judged, nothing delivered`,
      };
    default:
      return { ok: false, finalState: "failed", detail: "redispatched: verification found no deliverable" };
  }
}

/**
 * Re-dispatch a stalled/orphaned run, then judge what it produced through the
 * SAME delivery pipeline the dispatch path (delivery-pipeline.runDelivery) and
 * the salvage (salvageStalledRun) use — third caller, zero re-implementation.
 *
 * This used to hand-roll its own verify (a private 200-byte rule) and its own
 * gate (.md/.txt/.json only), and then FAIL OPEN: a run producing only
 * .html/.pdf/images/code was declared `delivered` with "gate indeterminate",
 * i.e. delivered without a single rubric ever running. The pipeline closes all
 * three: isDeliverable/manifest verification, the full GATEABLE_EXTS surface,
 * and exit 3 = INDETERMINATE = never delivered.
 *
 * Two policy choices distinguish this caller from the salvage:
 *
 *   - NO completeness ceiling. The ceiling encodes "the run was INTERRUPTED, so
 *     the file set on disk is whatever it managed to write" — false here: this
 *     run was started by the supervisor and returned ok, the same completion
 *     evidence the dispatch path delivers on. Capping it would make every
 *     manifest-less redispatch permanently un-deliverable and turn the
 *     never-stall guarantee into a never-deliver one. Fail-closed is preserved
 *     by the pipeline itself, not by the cap: no gateable artifact → exit 3 →
 *     withheld; gate FAIL → exit 2 → withheld.
 *   - `maxRevisions: 0`, for BUDGET — not for the read-only reason the salvage
 *     has. The sweep runs unattended every 120s under launchd; a revision loop
 *     there spends LLM money with nobody watching, and re-triggers on the next
 *     sweep. The supervisor's job is recovery, not iterative improvement: a
 *     failing gate is WITHHELD and escalated, and the human then runs
 *     `nrv revise` deliberately. Do NOT raise this number to "make recovery
 *     work" — that is the unattended spend this zero exists to prevent.
 */
export function redispatchRun(h: LedgerHandle, row: RunRow, overrides: RedispatchOverrides = {}): RecoveryResult {
  const { runCascadeImpl, ...deliveryOverrides } = overrides;
  const meta = row.meta || {};
  const promptPath = metaStr(meta, "prompt_path");
  const briefPath = metaStr(meta, "brief_path");
  const projectDir = metaStr(meta, "project_dir");
  const projectRoot = metaStr(meta, "project_root");
  const outputsRoot = metaStr(meta, "outputs_root");
  let prompt: string | null = null;
  try { if (promptPath && fs.existsSync(promptPath)) prompt = fs.readFileSync(promptPath, "utf8"); } catch { /* fall through */ }
  let brief = "";
  try { if (briefPath && fs.existsSync(briefPath)) brief = fs.readFileSync(briefPath, "utf8"); } catch { /* keep "" */ }
  if (!prompt) prompt = brief || null;
  if (!prompt || !projectDir || !projectRoot || !outputsRoot) {
    return { ok: false, finalState: "failed", detail: "meta lacks prompt/paths; cannot re-dispatch" };
  }
  const runCascade = runCascadeImpl ?? lazyCascade().runWithCascade;
  const { AUTONOMOUS_DIRECTIVE } = lazyDriver();
  const res = runCascade({
    runtime: (row.runtime as any) || "claude-code",
    prompt,
    cwd: projectRoot,
    addDirs: [projectDir, outputsRoot],
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

  const delivery = lazyDelivery();
  const args: DeliveryArgs = {
    ...baseDeliveryArgs(h, row, brief || prompt, outputsRoot),
    sessionId: typeof res.sessionId === "string" ? res.sessionId : null,
    // The runtime the cascade actually landed on, not the one the row asked for.
    runtime: (res.finalRuntime as DeliveryArgs["runtime"]) || (row.runtime as DeliveryArgs["runtime"]) || "claude-code",
    maxRevisions: 0,
    // Unattended path stays strict: nobody is awake to read the reservations
    // note, so the owner's accept-with-reservations default (delivery-pipeline)
    // does not apply here — a failing gate is withheld and escalated, as the
    // salvage doctrine documents.
    gateExhaustedPolicy: "withhold",
    ...deliveryOverrides,
  };
  try {
    return recoveryFromDelivery(delivery.runDelivery(args));
  } catch (e) {
    return { ok: false, finalState: "failed", detail: `delivery pipeline errored: ${(e as Error)?.message ?? e}` };
  }
}

// ── the supervisor's two doors into the delivery pipeline ─────────────────

function metaStr(meta: Record<string, unknown>, key: string): string | null {
  const v = meta[key];
  return typeof v === "string" && v ? v : null;
}

/** Identity, paths, ledger and audit wiring shared by BOTH supervisor entries
 *  into the delivery pipeline (redispatchRun, salvageStalledRun). Policy —
 *  revision budget, judge mode, completeness ceiling, runtime seam — is the
 *  caller's, and each one states it right where a reader can weigh it. */
function baseDeliveryArgs(h: LedgerHandle, row: RunRow, brief: string, outputsRoot: string): DeliveryArgs {
  const meta = row.meta || {};
  const kind = row.target_kind === "business" || row.target_kind === "squad" ? row.target_kind : "agent-x";
  return {
    brief,
    outputsRoot,
    manifest: metaStr(meta, "manifest"),
    pid: row.project_id ?? row.run_id,
    slug: kind === "business" ? row.target_slug : null,
    targetKind: kind,
    runtime: (row.runtime as DeliveryArgs["runtime"]) || "claude-code",
    projectDir: metaStr(meta, "project_dir") ?? outputsRoot,
    projectRoot: metaStr(meta, "project_root") ?? outputsRoot,
    workingDir: reviseCwdFor(meta),
    config: lazyConfig().loadHarnessConfig(),
    ledger: { handle: h, runId: row.run_id },
    audit: (event, payload) => emitAudit(event, payload, row),
  };
}

/** Brief text for the salvage. It only widens the deliverable floor for small
 *  files the brief named explicitly (delivery-pipeline briefNamedFiles), so an
 *  empty string is a safe, conservative fallback. */
function briefTextFor(meta: Record<string, unknown>): string {
  const pr = metaStr(meta, "project_root");
  for (const p of [metaStr(meta, "brief_path"), pr ? path.join(pr, "brief.md") : null]) {
    try { if (p && fs.existsSync(p)) return fs.readFileSync(p, "utf8"); } catch { /* try the next */ }
  }
  return "";
}

/** Bounded wait for a SIGTERMed child to actually exit. The live-pid branch
 *  signals the ledgered pid and escalates in the same breath; without this the
 *  salvage would meet a still-flushing writer and skip judging for good. */
function awaitPidExit(pid: number, budgetMs: number): void {
  const step = 100;
  for (let waited = 0; waited < budgetMs && pidAlive(pid); waited += step) Bun.sleepSync(step);
}

/**
 * Judge what an escalated run left on disk.
 *
 * The supervisor used to mark a run `stalled`, shout at a human and walk away —
 * leaving whatever artifacts existed unjudged, which is precisely the defect
 * the delivery pipeline exists to prevent, arriving through a narrower door.
 * So the escalated run walks ONCE into the SAME pipeline (verify → gate →
 * delivered | withheld | indeterminate) instead of nothing.
 *
 * Read-only by construction — the salvage never writes into the outputs dir:
 *   - `maxRevisions: 0` — the revision loop's condition is false, so no fix run;
 *   - `judge_enabled: false` — the gate runs offline heuristics, never the LLM
 *     judge whose --with-revisions loop rewrites artifacts;
 *   - `runHeadlessImpl` throws — any future path that tries to spawn a runtime
 *     from here fails loudly instead of racing a live writer;
 *   - a live ledgered child aborts the salvage outright (`live_writer`).
 *
 * And it can never over-claim: `completenessCeiling` caps the outcome at
 * `withheld` unless a manifest verification proves the deliverable set complete
 * (see DeliveryArgs.completenessCeiling).
 */
export function salvageStalledRun(h: LedgerHandle, row: RunRow, overrides: Partial<DeliveryArgs> = {}): SalvageVerdict {
  const meta = row.meta || {};
  const outputsRoot = metaStr(meta, "outputs_root");
  const verdict: SalvageVerdict = {
    judged: false, skipReason: null, artifacts: 0, gateable: 0, gate: null,
    delivered: false, ceiling: null, outputsRoot, finalState: row.state, detail: null,
  };
  if (!outputsRoot || !fs.existsSync(outputsRoot)) return { ...verdict, skipReason: "no_outputs_root" };

  // Second guard behind the call site (see escalate): never judge files a live
  // child may still be writing.
  const pid = row.child_pid ?? 0;
  if (pid > 0 && pidAlive(pid)) return { ...verdict, skipReason: "live_writer" };

  const delivery = lazyDelivery();
  const brief = briefTextFor(meta);
  const artifacts = delivery.candidateArtifacts(outputsRoot, brief);
  if (artifacts.length === 0) return { ...verdict, skipReason: "no_artifacts" };

  const base = baseDeliveryArgs(h, row, brief, outputsRoot);
  const cfg = base.config;
  const args: DeliveryArgs = {
    ...base,
    maxRevisions: 0,
    // Unattended path stays strict: nobody is awake to read the reservations
    // note, so the owner's accept-with-reservations default (delivery-pipeline)
    // does not apply here — a failing gate is withheld and escalated, as the
    // salvage doctrine documents.
    gateExhaustedPolicy: "withhold",
    config: { ...cfg, quality_gate: { ...cfg.quality_gate, judge_enabled: false } },
    completenessCeiling: { reason: SALVAGE_CEILING_REASON },
    runHeadlessImpl: (() => { throw new Error("supervisor salvage is read-only: no runtime spawn"); }) as any,
    ...overrides,
  };

  try {
    const res = delivery.runDelivery(args);
    return {
      ...verdict, judged: true, artifacts: artifacts.length, gateable: res.gatedFiles.length,
      gate: res.gateOutcome, delivered: res.delivered, ceiling: res.ceilingApplied,
      detail: `exit ${res.exitCode}`,
    };
  } catch (e) {
    return { ...verdict, skipReason: "pipeline_error", artifacts: artifacts.length, detail: (e as Error)?.message ?? String(e) };
  }
}

/** The salvage verdict as audit/meta fields — one shape, three consumers. */
function salvageFields(v: SalvageVerdict): Record<string, unknown> {
  return {
    salvage_judged: v.judged,
    salvage_skip_reason: v.skipReason,
    artifacts: v.artifacts,
    gateable: v.gateable,
    gate: v.gate,
    delivered: v.delivered,
    ceiling: v.ceiling,
    outputs_root: v.outputsRoot,
    final_state: v.finalState,
    detail: v.detail,
  };
}

// ── the sweep ─────────────────────────────────────────────────────────────

/**
 * Cross-process sweep lock. TWO triggers can fire at once: the LaunchAgent
 * (StartInterval 120) and the lazy maybeSweep() a user command spawns. Without
 * a lock both sweeps see the same row and both act on it — two re-dispatches of
 * the same work, paid twice, writing into the SAME outputs dir concurrently,
 * which corrupts the artifacts the recovery exists to save. `last_sweep_at`
 * only throttles the lazy trigger; it cannot bind launchd.
 *
 * Try-lock semantics, not wait: a sweeper that finds the lock held returns
 * immediately, because the holder is already doing this exact work. Stale locks
 * (crashed sweeper) are reclaimed by file-lock's pid+mtime check — a recovery
 * can legitimately run for many minutes, so the staleness window is generous.
 */
const SWEEP_LOCK_STALE_MS = 30 * 60_000;

/**
 * How wide this supervisor invocation looks — the one place that decides it.
 * See the PROJECT SCOPE block at the top of the file: the flag wins, a
 * resolvable project scopes to itself, and a supervisor with no project at all
 * (launchd) stays machine-wide rather than quietly recovering nothing.
 */
export function resolveSweepScope(flagged: boolean, quiet = false): { allProjects: boolean; projectRoot: string | null } {
  if (flagged) return { allProjects: true, projectRoot: null };
  const projectRoot = resolveProjectRoot();
  if (projectRoot) return { allProjects: false, projectRoot };
  if (!quiet) {
    console.error(
      "[supervisor] no project root here (no NIRVANA_PROJECT_ROOT, no marker above the cwd) — " +
      "sweeping ALL projects. Pass --all-projects to say so explicitly, or run from inside a project to scope it.",
    );
  }
  return { allProjects: true, projectRoot: null };
}

export function sweep(deps: SweepDeps = {}): SweepSummary {
  const summary: SweepSummary = { scanned: 0, skipped: 0, graced: 0, resumed: 0, redispatched: 0, recovered: 0, escalated: 0, salvaged: 0, errors: 0 };
  // deps.handle => a test drives its own ledger; skip the global lock so
  // in-process tests never contend with a real sweeper on this machine.
  if (deps.handle) return sweepLocked(deps, summary);
  let lock: { release(): void };
  try {
    lock = acquireLockSync(resolveLedgerDbPath(), { timeoutMs: 0, staleMs: SWEEP_LOCK_STALE_MS });
  } catch {
    console.error("[supervisor] another sweep is in progress — skipping this one");
    return summary;
  }
  try { return sweepLocked(deps, summary); }
  finally { lock.release(); }
}

function sweepLocked(deps: SweepDeps, summary: SweepSummary): SweepSummary {
  let h: LedgerHandle;
  try { h = deps.handle ?? openLedger(); } catch (e) {
    console.error(`[supervisor] cannot open ledger: ${(e as Error)?.message ?? e}`);
    summary.errors++;
    return summary;
  }
  const now = deps.now ?? Date.now();
  let rows: RunRow[] = [];
  try { rows = findNonTerminal(h, { allProjects: deps.allProjects }); } catch (e) {
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
  // notification spam, not supervision — so a stalled row is swept exactly
  // ONCE more, and only to salvage the artifacts it left behind (rows escalated
  // before salvage existed, or escalated while a writer was still alive).
  // meta.salvaged is that one-shot record; after it the row is skipped forever.
  // The skip is per-row, so it can never hide a NEW stalled run: that row
  // carries no meta.salvaged and gets its own escalation.
  if (row.state === "stalled") {
    if (row.meta?.salvaged) { summary.skipped++; return; }
    escalate(h, row, deps, summary, String(row.last_error || "stalled run; retries exhausted").replace(/^supervisor:\s*/, ""));
    return;
  }
  const lease = row.lease_expires_at ? Date.parse(row.lease_expires_at) : 0;
  if (lease > now) { maybePing(h, row, now, deps); summary.skipped++; return; }

  const pid = row.child_pid ?? 0;
  // NEVER touch ourselves or our parent, no matter what the ledger says.
  if (pid && (pid === process.pid || pid === process.ppid)) {
    console.error(`[supervisor] self-guard: run ${row.run_id} claims pid ${pid} (this process/parent); skipping`);
    emitAudit("x_ledger_self_guard_skip", { run_id: row.run_id, pid }, row);
    summary.skipped++;
    return;
  }

  // An AGENTIC run is orchestrated inside a live agent session — nothing here is
  // a child of ours. Both scripted recoveries are wrong for it: there is no pid
  // we own to signal (the ledger deliberately records none, so a recycled pid can
  // never get a stranger's process SIGTERMed), and there is no prompt or session
  // to relaunch from. The third door is the right one: judge what it left on disk
  // and tell the human. So it escalates on the first expired lease instead of
  // burning two retries against recoveries that cannot apply — and, crucially, it
  // consults the trace's proof of life FIRST, which the pid-less path below never
  // would: the row's own beats, the child runs its employee dispatched, the hook
  // activity of the session, and only then the files under outputs_root
  // (resolveAgenticLiveness). A business that delegates writes nothing under its
  // own dir while its squad works; judged by that dir alone it was escalated
  // while working.
  //
  // It also asks the liveness question on the right scale. The 5-minute stall
  // budget belongs to a driver that heartbeats every few seconds; an agentic run
  // has no heartbeat at all, and a squad legitimately thinks for ten minutes
  // between writes. Judged by that budget it would be declared dead while
  // working. So the window here is the lease itself: "anything at all since we
  // last looked?" — and a yes buys another full lease.
  if (isAgentic(row)) {
    const life = resolveAgenticLiveness(h, row, now, AGENTIC_LEASE_SEC * 1000);
    if (life.alive) {
      renewLease(h, row.run_id, AGENTIC_LEASE_SEC);
      emitAudit("x_ledger_grace_extended", {
        run_id: row.run_id, lease_sec: AGENTIC_LEASE_SEC, path: "agentic",
        liveness_source: life.source, liveness_at: new Date(life.at).toISOString(), child_run_id: life.childRunId,
      }, row);
      summary.graced++;
      return;
    }
    escalate(h, row, deps, summary, "agentic run stopped reporting (no heartbeat, no child run, no hook activity, no file activity)");
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
    const res = (deps.redispatchImpl ?? ((r: RunRow) => redispatchRun(h, r)))(getRun(h, row.run_id)!);
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
  if (!row) return;
  // A recovery that walked the delivery pipeline (redispatchRun) has ALREADY
  // driven the row to its terminal state. Record what the ledger says instead
  // of re-transitioning it — but still emit the recovery result and count it,
  // or the sweep would report `recovered=0` for the runs it actually saved.
  const finalState = isTerminal(row.state) || row.state === target
    ? row.state
    : toState(h, runId, target, res.detail ?? "").state;
  emitAudit("x_ledger_recovery_result", { run_id: runId, ok: res.ok, final_state: finalState, detail: res.detail ?? null }, row);
  if (res.ok) summary.recovered++;
}

function escalate(h: LedgerHandle, row: RunRow, deps: SweepDeps, summary: SweepSummary, reason: string): void {
  toState(h, row.run_id, "stalled", `supervisor: ${reason}`);
  // Idempotence stamp written BEFORE the salvage: sweepOne skips a row that
  // carries meta.salvaged, so a crash mid-salvage can never become a re-judge
  // loop on the next sweep.
  patchMeta(h, row.run_id, { salvaged: true, salvaged_at: new Date().toISOString() });

  // ── salvage ────────────────────────────────────────────────────────────
  // Confined to this function BY CONSTRUCTION, and this function is reached
  // from exactly three places in sweepOne — the dead-pid exhaustion branch,
  // the live-pid exhaustion branch (after the SIGTERM) and the
  // already-stalled-never-salvaged branch — each of which `return`s
  // immediately. The recovery seams (resumeImpl / redispatchImpl) live in the
  // NOT-exhausted branches, which return before ever reaching here, so no
  // re-dispatch can be writing into the outputs dir while the gate reads it.
  // The bounded wait below closes the one gap the control flow leaves: a
  // SIGTERMed child that has not finished dying yet.
  const pid = row.child_pid ?? 0;
  if (pid > 0) awaitPidExit(pid, deps.pidExitWaitMs ?? PID_EXIT_WAIT_MS);
  const salvage = deps.salvageImpl ?? ((r: RunRow) => salvageStalledRun(h, r, {
    log: deps.quiet ? () => {} : (l: string) => console.error(l),
    warn: deps.quiet ? () => {} : (l: string) => console.error(l),
  }));
  const verdict = salvage(getRun(h, row.run_id) ?? row);

  // The salvage may have driven the row to a terminal state (delivered /
  // withheld). Any other state goes back to `stalled`: an escalated run is
  // never left looking recoverable to the next sweep.
  const after = getRun(h, row.run_id);
  if (after && !isTerminal(after.state) && after.state !== "stalled") {
    toState(h, row.run_id, "stalled", `supervisor: ${reason}`);
  }
  verdict.finalState = (getRun(h, row.run_id) ?? row).state;
  if (verdict.judged) summary.salvaged++;
  patchMeta(h, row.run_id, { salvage: salvageFields(verdict) });
  emitAudit("x_ledger_salvage_result", { run_id: row.run_id, reason, ...salvageFields(verdict) }, row);

  // Escalation is ENRICHED by the salvage, never replaced by it: every channel
  // still fires, now carrying the verdict.
  // human_notification_required is in the audit enum; the ledger trail gets
  // the x_ variant too so `grep x_ledger_` tells the whole recovery story.
  emitAudit("human_notification_required", {
    run_id: row.run_id, reason, retries: row.retries, max_retries: row.max_retries,
    target_slug: row.target_slug, target_kind: row.target_kind,
    ...salvageFields(verdict),
  }, row);
  emitAudit("x_ledger_notify_human", { run_id: row.run_id, reason, ...salvageFields(verdict) }, row);
  (deps.notifyImpl ?? defaultNotify)(row, reason, verdict);
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
    // Count what the child will actually sweep. Counting a different scope than
    // the one it sweeps is how a pending run gets skipped forever.
    const scope = resolveSweepScope(false, true);
    if (countNonTerminal(h, { allProjects: scope.allProjects }) === 0) return false;
    const child = spawn(process.execPath, [SUPERVISOR_PATH, "sweep", "--quiet", ...(scope.allProjects ? ["--all-projects"] : [])], {
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
    // launchd has no project context; the flag says out loud that this is the
    // machine-wide supervisor, the one exception to the ledger's project scope.
    `    <string>--all-projects</string>`,
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

function cliStatus(allProjects: boolean): number {
  const h = openLedger();
  const scope = resolveSweepScope(allProjects);
  const rows = findNonTerminal(h, { allProjects: scope.allProjects });
  const where = scope.allProjects ? "all projects" : scope.projectRoot;
  if (rows.length === 0) { console.log(`supervisor: no non-terminal runs in ${where}. Ledger is clean.`); return 0; }
  console.log(`scope: ${where}`);
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
  const allProjects = process.argv.includes("--all-projects");
  switch (sub) {
    case "sweep": {
      // Anything spawned below must not recursively trigger maybeSweep.
      process.env.NRV_IN_SWEEP = "1";
      try {
        const s = sweep({ quiet, allProjects: resolveSweepScope(allProjects, quiet).allProjects });
        if (!quiet) {
          console.log(`sweep: scanned=${s.scanned} skipped=${s.skipped} graced=${s.graced} resumed=${s.resumed} redispatched=${s.redispatched} recovered=${s.recovered} escalated=${s.escalated} salvaged=${s.salvaged} errors=${s.errors}`);
        }
      } catch (e) {
        console.error(`[supervisor] sweep crashed: ${(e as Error)?.message ?? e}`);
      }
      process.exit(0); // sweep ALWAYS exits 0 (anti-respawn guard)
    }
    case "status":
      process.exit(cliStatus(allProjects));
    case "watch": {
      const intervalSec = Math.max(10, parseInt(argValue("--interval", "120") || "120", 10));
      process.env.NRV_IN_SWEEP = "1";
      const watchScope = resolveSweepScope(allProjects, quiet);
      console.log(`supervisor watch — sweeping ${watchScope.allProjects ? "all projects" : watchScope.projectRoot} every ${intervalSec}s (Ctrl-C to stop)`);
      for (;;) {
        try {
          const s = sweep({ quiet, allProjects: watchScope.allProjects });
          if (!quiet) console.log(`[${new Date().toISOString()}] scanned=${s.scanned} graced=${s.graced} resumed=${s.resumed} redispatched=${s.redispatched} escalated=${s.escalated} salvaged=${s.salvaged}`);
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
        "usage: nrv supervisor <sweep|status|watch|install|uninstall> [--all-projects]",
        "",
        "  sweep [--quiet]        one recovery pass over the dispatch ledger (always exits 0)",
        "  status                 table of non-terminal runs",
        "  watch [--interval=120] loop sweep forever",
        "  install [--print]      write + load the launchd LaunchAgent (--print: show plist only)",
        "  uninstall              unload + remove the launchd LaunchAgent",
        "",
        "  --all-projects         every project on the machine. Without it, sweep/status/watch",
        "                         see only the project of the cwd — the supervisor is the ONE",
        "                         reader allowed the machine-wide view. With no project around",
        "                         (launchd) it goes machine-wide anyway and says so.",
        "",
        "env: NRV_SUPERVISOR=0 disables the lazy sweep on nrv find/route/dispatch",
      ].join("\n"));
      process.exit(sub === "help" || sub === "--help" ? 0 : 2);
  }
}
