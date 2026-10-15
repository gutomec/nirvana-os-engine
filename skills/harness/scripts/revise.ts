#!/usr/bin/env bun
// revise.ts — request changes to an autopilot deliverable, keeping the session.
//
// Resumes the SAME runtime conversation (claude --resume <session_id>) so the
// agent has full context of what it produced, applies the change, then re-runs
// verify + gate + (re)export. State lives in the run's session file:
//   <project>/businesses/<slug>/session.json   a business run (dispatch.ts)
//   <project>/squads/<slug>/session.json       a squad-only run
//   <project>/agent-x/session.json             an agent-x run
// (run-session.ts finds all three.)
//
// When there is no conversation to continue (a run whose runtime returned no
// id, a run from before squad and agent-x runs recorded one, a session the
// runtime pruned, or `--runtime` naming another runtime), the revision does
// not fail: it runs a FRESH session seeded with the run's brief, its
// deliverables as the work to revise, the gate's reservations and the change,
// and says so on screen and in the audit (`x_revise_fresh_session`, with the
// reason). A route of several squads has no single worker to continue and is
// refused (exit 4).
//
// The revision's worker runs under the run ledger, so the heartbeat sidecar's
// stall guard (stall-guard.ts) ends a worker that hangs: exit 76.
//
// Usage:
//   nrv revise <project_id> "<change request>"
//   nrv revise --last [<business|squad|agent-x>] "<change>"   the newest run (of that worker)
//   nrv revise <project_id> "<change>" --zip --max-budget=10 --timeout=20 --runtime=<rt> --safe
//
// Exit codes (SAME TABLE as dispatch.ts — BREAKING, see CHANGELOG):
//   0 = revised + DELIVERED (gate pass)
//   1 = failed (runtime error, or no verifiable deliverable on disk)
//   2 = delivery WITHHELD — gate FAILED after the revision budget
//   3 = delivery INDETERMINATE — zero gateable artifacts; nothing was judged
//   4 = invalid args (EXIT.INVALID_ARGS per SCRIPT_CONTRACT; was 2)
//  75 = waiting on quota — the revision, a correction or the judge met a spent
//       quota; nothing more ran, and the run resumes at or after the reset
//  76 = STALLED — the worker showed no activity for execution.stall_timeout_min
//       (or never started within execution.stall_no_start_min); it was ended,
//       nothing was judged
//
// 0 means DELIVERED, and only that. This script used to exit 0 whenever the
// text-only gate had nothing to chew on, while emitting `delivered` with
// gate:"pass" — see the delivery block below.

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawnSync } from "node:child_process";
import { runHeadless, runtimeAvailable, AUTONOMOUS_DIRECTIVE, type Runtime } from "../lib/host-agent-driver.ts";
import { onLedgerStall } from "../../_shared/lib/host-agent-driver.ts";
import { looksLikeMissingSession } from "../../_shared/lib/session-capture.ts";
import { reportStall, STALLED_EXIT } from "../lib/stall-guard.ts";
import { findRunSessions, latestRunSession, runRoots as projectRunRoots, type RunSessionFile } from "../lib/run-session.ts";
import { detectExecutionRuntime } from "../lib/control-plane/execution-runner.ts";
import * as runLedger from "../lib/run-ledger.ts";
import { runDelivery, deliverAfterRuntimeError, type DeliveryArgs, type DeliveryResult } from "../lib/delivery-pipeline.ts";
import { loadHarnessConfig } from "../lib/harness-config.ts";
import { harnessLogsDir } from "../../_shared/lib/log-paths.ts";
import { scopeGuard } from "../../_shared/lib/scope-guard.ts";
import { stamp } from "../../_shared/lib/audit-provenance.ts";
import { squadRunEnv } from "../../_shared/lib/squad-env.ts";
import { briefWorkDirs } from "../../_shared/lib/brief-work-dirs.ts";
import { paths } from "../../_shared/lib/bun-helpers.ts";
import type { DispatchRole } from "../../_shared/lib/dispatch-depth.ts";

const ANSI = { reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m", green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m", cyan: "\x1b[36m", lime: "\x1b[38;5;154m" };
const noColor = process.argv.includes("--no-color") || !process.stdout.isTTY;
function c(k: keyof typeof ANSI, s: string): string { return noColor ? s : `${ANSI[k]}${s}${ANSI.reset}`; }

function arg(name: string): string | undefined {
  const eq = process.argv.find(a => a.startsWith(`${name}=`));
  if (eq) return eq.split("=").slice(1).join("=");
  const i = process.argv.indexOf(name);
  if (i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")) return process.argv[i + 1];
  return undefined;
}

const SKILLS = process.env.NIRVANA_SKILLS_DIR || (fs.existsSync(path.join(os.homedir(), ".nirvana", "skills")) ? path.join(os.homedir(), ".nirvana", "skills") : path.join(os.homedir(), ".claude", "skills"));
// Skip space-form value-flag values so they aren't mistaken for positionals.
const VALUE_FLAGS = new Set(["--max-budget", "--timeout", "--runtime"]);
const positional: string[] = [];
{
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) { if (!a.includes("=") && VALUE_FLAGS.has(a)) i++; continue; }
    positional.push(a);
  }
}
// `--last [<target>]`: the change is the last positional; a target before it
// narrows the search to that worker's runs.
const wantLast = process.argv.includes("--last");
const lastPick = wantLast ? latestRunSession({ target: positional.length >= 2 ? positional[0] : null }) : null;
const projectId = wantLast ? lastPick?.projectId : positional[0];
const change = wantLast ? positional[positional.length - 1] : positional[1];
const runtimeFlag = arg("--runtime");
const wantZip = process.argv.includes("--zip");
// Default = full trust (same criterion as dispatch.ts). --safe opts into restricted.
const yolo = !process.argv.includes("--safe");
const maxBudget = arg("--max-budget");
const timeoutMin = arg("--timeout");

if (wantLast && !lastPick && change) {
  console.error(`✗ --last: no run with a session file${positional.length >= 2 ? ` of '${positional[0]}'` : ""} under ${path.join(process.cwd(), "outputs")} or ~/.nirvana/outputs.`);
  console.error("  List the project's runs with `nrv run-track list`, then name one: nrv revise <project> \"<change>\".");
  process.exit(4);
}
if (!projectId || !change) {
  console.error('Usage: nrv revise <project_id> "<change>" [--zip] [--max-budget=<usd>] [--timeout=<min>] [--runtime=<rt>] [--safe]');
  console.error('       nrv revise --last [<business|squad|agent-x>] "<change>"');
  process.exit(4);   // EXIT.INVALID_ARGS — 2 now means WITHHELD (see the table above)
}
if (lastPick) console.log(`  --last → ${projectId} (${lastPick.kind === "agent-x" ? "agent-x" : `${lastPick.kind} ${lastPick.slug}`})`);

function appendAudit(payload: Record<string, any>, projectRoot?: string): void {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const dir = path.join(harnessLogsDir({ cwd: projectRoot }), today);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "audit.jsonl"), JSON.stringify(stamp({ ts: new Date().toISOString(), ...payload })) + "\n");
  } catch { /* non-fatal */ }
}

function readIfExists(p: string): string | null {
  try { return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null; } catch { return null; }
}

/** The session files of the run, from the nearest run folder that holds any. */
function findSessions(pid: string): RunSessionFile[] {
  for (const root of projectRunRoots(pid)) {
    const found = findRunSessions(root);
    if (found.length) return found;
  }
  return [];
}

/** The run's ledger row (the newest attempt of this trace), when the ledger has one. */
const ledger = (() => {
  try {
    const handle = runLedger.openLedger();
    return { handle, row: runLedger.findByTraceId(handle, projectId) };
  } catch (e) {
    console.error(c("dim", `  (run ledger unavailable: ${(e as Error)?.message ?? e}; the revision is not tracked)`));
    return null;
  }
})();

/** What kind of run this id is when it has no session file: the ledger says
 *  it, or the run folder's shape does. A squad or agent-x run dispatched before
 *  those runs wrote one keeps none. */
function sessionlessKind(pid: string): "squad" | "agent-x" | null {
  const kind = ledger?.row?.target_kind;
  if (kind === "squad" || kind === "agent-x") return kind;
  for (const root of projectRunRoots(pid)) {
    if (fs.existsSync(path.join(root, "squads"))) return "squad";
    if (fs.existsSync(path.join(root, "agent-x"))) return "agent-x";
  }
  return null;
}

/** A session for a run that kept no session.json (a squad or agent-x run from
 *  before those runs wrote one): its one worker folder, read from the run
 *  folder, with no id. The revision then runs fresh and seeded, and the file is
 *  written when the new session comes back. */
function legacySession(pid: string): (RunSessionFile & { legacy: Record<string, unknown> }) | null {
  const kind = sessionlessKind(pid);
  if (!kind) return null;
  for (const root of projectRunRoots(pid)) {
    const dirs = kind === "agent-x" ? (fs.existsSync(path.join(root, "agent-x")) ? ["agent-x"] : [])
      : (() => { try { return fs.readdirSync(path.join(root, "squads"), { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); } catch { return []; } })();
    if (dirs.length !== 1) continue;
    const projectDir = kind === "agent-x" ? path.join(root, "agent-x") : path.join(root, "squads", dirs[0]);
    const meta: Record<string, any> = ledger?.row?.meta ?? {};
    const deliverables = path.join(root, "deliverables");
    const data = {
      project_id: pid, target_kind: kind, target_slug: kind === "agent-x" ? "agent-x" : dirs[0],
      runtime: ledger?.row?.runtime ?? null, session_id: null, project_dir: projectDir,
      project_root: ledger?.row?.project_root ?? meta.project_root ?? process.cwd(),
      outputs_root: meta.outputs_root ?? (fs.existsSync(deliverables) ? deliverables : root),
      workspace: null, manifest: null, created_at: new Date().toISOString(),
    };
    return { file: path.join(projectDir, "session.json"), kind, slug: data.target_slug, legacy: data };
  }
  return null;
}

let sessions: RunSessionFile[] = findSessions(projectId);
if (!sessions.length) {
  const legacy = legacySession(projectId);
  if (legacy) sessions = [legacy];
  else {
    console.error(c("red", `✗ no run '${projectId}' with a session to continue was found (looked for businesses/<slug>/, squads/<slug>/ and agent-x/session.json under ${projectRunRoots(projectId).join(", ")}).`));
    console.error("  Was this project created with 'nrv run' / 'nrv dispatch --exec'?");
    process.exit(1);
  }
}
if (sessions.length > 1) {
  console.error(c("red", `✗ '${projectId}' ran ${sessions.length} workers (${sessions.map(s => s.kind === "agent-x" ? "agent-x" : `${s.kind} ${s.slug}`).join(", ")}), and nrv revise continues one worker's own session.`));
  console.error("  A change to that run is a new dispatch to the worker it concerns.");
  process.exit(4);
}
const { file: sessionFile, kind } = sessions[0];
const legacyData = (sessions[0] as RunSessionFile & { legacy?: Record<string, unknown> }).legacy;
const session: Record<string, any> = legacyData ? { ...legacyData } : JSON.parse(fs.readFileSync(sessionFile, "utf8"));
// The runtime that owns the session: the conversation can be resumed only
// there. The ledger's runtime is the fallback for a session that never named one.
const sessionRuntime = ((session.runtime as string) || ledger?.row?.runtime || "") as Runtime;
const sessionId = session.session_id as string | null;
// The worker's slug: the business's, the squad's, or "agent-x".
const slug = ((kind === "business" ? session.business_slug : session.target_slug) as string) || sessions[0].slug;
const projDir = session.project_dir as string;
const projectRoot = session.project_root as string;
const oroot = session.outputs_root as string;
// A squad and agent-x keep their stamp: they may open nothing. A business
// revision keeps the unstamped call it always made.
const role: DispatchRole | undefined = kind === "squad" ? "squad" : kind === "agent-x" ? "agent-x" : undefined;

// ── continue, or start fresh and say why ───────────────────────────────────
//
// The conversation is continued whenever it exists. When it cannot be, the
// revision is not refused: it runs in a fresh session seeded with what the
// original worker knew (freshPrompt below). The reasons, as audited:
//   legacy_run          the run predates session files
//   no_session_id       the runtime returned no id
//   runtime_changed     --runtime names another runtime than the session's
//   runtime_unavailable the session's runtime is not installed, and nobody named one
//   resume_failed       the runtime no longer knows the session (pruned, deleted)
let freshReason: string | null = legacyData ? "legacy_run" : !sessionId ? "no_session_id" : null;
let rt: Runtime = sessionRuntime;
if (runtimeFlag && runtimeFlag !== sessionRuntime) { rt = runtimeFlag as Runtime; freshReason ??= "runtime_changed"; }
if (!rt) rt = detectExecutionRuntime().runtime;
if (!runtimeAvailable(rt) && !runtimeFlag) {
  const fallback = detectExecutionRuntime();
  if (fallback.available && fallback.runtime !== rt) { rt = fallback.runtime; freshReason ??= "runtime_unavailable"; }
}
const FRESH_WHY: Record<string, string> = {
  legacy_run: "the run is from before runs recorded their session",
  no_session_id: `the ${kind} run's runtime${sessionRuntime ? ` (${sessionRuntime})` : ""} returned no session id`,
  runtime_changed: `--runtime ${runtimeFlag} is not the session's runtime (${sessionRuntime || "unknown"})`,
  runtime_unavailable: `the session's runtime (${sessionRuntime}) is not installed`,
  resume_failed: `${sessionRuntime} no longer knows session ${sessionId}`,
};

/** The squads whose environments (squad-env.ts) the run worked with: a
 *  business's mandatory squads, each under `<outputs_root>/_squads/<slug>`, or
 *  the squad itself. */
function envSquads(): string[] {
  if (kind === "squad") return [slug];
  try {
    return fs.readdirSync(path.join(oroot, "_squads"), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch { return []; }
}
const reviseEnv = squadRunEnv(envSquads());

console.log("");
console.log(c("lime", "▶") + c("bold", ` nrv revise — ${projectId} (${rt})`));
if (freshReason) console.log(c("yellow", `  FRESH session: ${FRESH_WHY[freshReason]}. Seeded with the brief, the deliverables and the gate's reservations.`));
else console.log(c("dim", `  resume session: ${sessionId}`));

if (!runtimeAvailable(rt)) {
  console.error(c("red", `✗ runtime '${rt}' is not on the PATH${runtimeFlag ? " (named with --runtime, so no other runtime takes the revision)" : ""}.`));
  process.exit(1);
}

/** The brief the run answered: the run's scaffold root keeps it (`<run>/brief.md`,
 *  two levels above businesses/<slug> or squads/<slug>; agent-x's is
 *  `<run>/brief-enriched.md`, one level above agent-x/). */
const scaffoldRoot = path.resolve(projDir, kind === "agent-x" ? ".." : "../..");
const brief = readIfExists(path.join(projectRoot, "brief.md"))
  ?? readIfExists(path.join(scaffoldRoot, kind === "agent-x" ? "brief-enriched.md" : "brief.md"));

// The ledger row this revision moves. A live row (the supervisor marked it
// `running` before spawning us, or a run a human picks up mid-way) is carried
// on; a finished one is history, so the revision opens a new attempt of the
// same trace, which `nrv run-track status <trace>` then reports. A run the
// ledger never saw gets its first row here. The worker runs under it, so the
// heartbeat sidecar's stall guard covers the revision.
const ledgerRun: { handle: runLedger.LedgerHandle; runId: string } | null = (() => {
  if (!ledger) return null;
  const { handle, row } = ledger;
  const mine = { dispatcher_pid: process.pid, dispatcher_started_at: runLedger.processStartedAt(process.pid) };
  try {
    if (row && !runLedger.isTerminal(row.state)) {
      // This process now drives the row: the stall decision is its own while it
      // lives (stall-guard.ts dispatcherOwnsStall). The earlier values come
      // back on exit, while the row is still ours.
      const previous = { dispatcher_pid: row.meta?.dispatcher_pid ?? null, dispatcher_started_at: row.meta?.dispatcher_started_at ?? null };
      runLedger.patchMeta(handle, row.run_id, mine);
      process.on("exit", () => {
        try {
          const now = runLedger.getRun(handle, row.run_id);
          if (now && !runLedger.isTerminal(now.state) && Number(now.meta?.dispatcher_pid) === process.pid) runLedger.patchMeta(handle, row.run_id, previous);
        } catch { /* the ledger is closing with the process */ }
      });
      // `verifying` and `gated` have no direct edge back to `running`: the hop
      // goes through `failed`, as the supervisor's own resume does.
      if (row.state !== "running") {
        if (!runLedger.canTransition(row.state, "running")) runLedger.markState(handle, row.run_id, "failed", { error: "taken over by nrv revise" });
        runLedger.markState(handle, row.run_id, "running");
      }
      return { handle, runId: row.run_id };
    }
    const fresh = runLedger.openRun(handle, {
      traceId: projectId, projectId, targetSlug: row?.target_slug ?? slug, targetKind: kind, runtime: rt,
      meta: { ...(row?.meta ?? {}), ...(row ? { revision_of: row.run_id } : {}), ...mine,
        project_dir: projDir, project_root: projectRoot, outputs_root: oroot,
        scaffold_root: (row?.meta?.scaffold_root as string | undefined) ?? scaffoldRoot,
        mode: "revise" },
    });
    runLedger.markState(handle, fresh.run_id, "running");
    return { handle, runId: fresh.run_id };
  } catch (e) {
    console.error(c("dim", `  (run ledger: ${(e as Error)?.message ?? e}; the revision is not tracked)`));
    return null;
  }
})();

// A revision whose worker stalls ends like a dispatch that stalls: the sidecar
// ended the worker; nothing is judged, _STATUS.json says why, exit 76.
onLedgerStall((stall, result, opts) => {
  let row: runLedger.RunRow | null = null;
  try { row = runLedger.getRun(ledgerRun?.handle ?? runLedger.openLedger(opts.ledger?.dbPath), opts.ledger!.runId); } catch { row = null; }
  if (row) reportStall(row, stall as never, { audit: (event, payload) => appendAudit({ event, ...payload, revision: true }, projectRoot) });
  else console.error(c("red", `■ STALLED (exit ${STALLED_EXIT}): ${String(result.error ?? "the worker stalled")}`));
  process.exit(STALLED_EXIT);
});

// The folders the brief places the work in: a revision works there too, and is
// never told to move that work under the outputs root (2026-10-14, a resumed
// worker copied the whole project it was fixing into its deliverables).
const workDirs = briefWorkDirs(brief, oroot);
const revisePrompt = [
  "INSTRUÇÃO DE REVISÃO (mesma sessão — você tem o contexto completo do que produziu):",
  "",
  change,
  "",
  `Reescreva/atualize os entregáveis nos lugares que o brief indica. Os entregáveis escritos sob ${oroot} continuam lá; o trabalho que o brief coloca em outra pasta (um projeto a revisar ou corrigir, um projeto novo a criar) é feito lá, no lugar, e nunca copiado para dentro de ${oroot}.${workDirs.length ? ` O brief coloca trabalho em: ${workDirs.join(", ")}.` : ""}`,
  scopeGuard("pt-BR"),
  'Não imprima resumo: entregue os arquivos atualizados. Atualize a seção "## Premissas assumidas" se algo mudou.',
].join("\n");

/** The prompt of a revision that cannot continue the conversation: what the
 *  original worker knew, rebuilt from disk, then the change. */
function freshPrompt(reason: string): string {
  const reservationsFile = path.join(oroot, "_QA-RESERVATIONS.md");
  const reservations = readIfExists(reservationsFile)?.trim();
  const capped = reservations && reservations.length > 8000 ? `${reservations.slice(-8000)}\n(older text cut; the whole file is ${reservationsFile})` : reservations;
  return [
    `REVISION INSTRUCTION (NEW session: ${FRESH_WHY[reason] ?? reason}, so you do not have the conversation that produced this work).`,
    "",
    "The brief this work answered:",
    "",
    brief?.trim() || "(the run recorded no brief; the deliverables below are the whole record)",
    "",
    `The delivered work is in ${oroot}${workDirs.length ? ` and in ${workDirs.join(", ")}` : ""}. Read it before you change anything: it is the input of this revision, not a draft to redo. Change what the request below asks and keep the rest as it is.`,
    ...(capped ? ["", `The quality gate's reservations on that work (${reservationsFile}):`, "", capped] : []),
    "",
    "The change requested:",
    "",
    ...revisePrompt.split("\n").slice(2),
  ].join("\n");
}

appendAudit({ event: "revision_requested", trace_id: projectId, project_id: projectId, business_slug: kind === "business" ? slug : null,
  target_kind: kind, target_slug: slug, runtime: rt, session_id: freshReason ? null : sessionId,
  ...(freshReason ? { fresh_session: freshReason } : {}) }, projectRoot);

function auditFresh(reason: string): void {
  appendAudit({ event: "x_revise_fresh_session", trace_id: projectId, project_id: projectId, business_slug: kind === "business" ? slug : null,
    target_kind: kind, target_slug: slug, runtime: rt, previous_runtime: sessionRuntime || null, previous_session_id: sessionId ?? null, reason }, projectRoot);
}
if (freshReason) auditFresh(freshReason);

/** A squad's own tree, granted again as the run granted it: its resource map
 *  names files under it, and claude-code and agy refuse an ungranted path. */
const squadTree = kind === "squad" && fs.existsSync(path.join(paths.SQUADS_DIR, slug)) ? [path.join(paths.SQUADS_DIR, slug)] : [];

const runRevision = (resume: string | undefined, prompt: string) => runHeadless({
  runtime: rt,
  prompt,
  cwd: projectRoot,
  addDirs: [projDir, oroot, ...squadTree, ...workDirs],
  // The folder the session was started in (absent on runs from before runs
  // had one): claude resumes a session only from its own folder.
  workspace: session.workspace || undefined,
  // The same squad packages and Python the run had, on the revision's child only.
  env: reviseEnv,
  sessionId: resume,
  appendSystemPrompt: AUTONOMOUS_DIRECTIVE,
  ...(role ? { dispatchRole: role } : {}),
  maxBudgetUsd: maxBudget ? parseFloat(maxBudget) : undefined,
  timeoutMs: timeoutMin ? parseInt(timeoutMin, 10) * 60 * 1000 : undefined,
  yolo,
  label: `revise ${projectId}`,
  ...(ledgerRun ? { ledger: { runId: ledgerRun.runId, watchDir: oroot } } : {}),
});
let res = freshReason ? runRevision(undefined, freshPrompt(freshReason)) : runRevision(sessionId!, revisePrompt);
// The runtime no longer knows the session: the change runs once more, in a
// fresh seeded session, instead of failing. A spent quota or a model error is
// not this, and is reported as it is.
if (!freshReason && !res.ok && looksLikeMissingSession([res.error, res.stderr, res.result].filter(Boolean).join("\n"))) {
  freshReason = "resume_failed";
  console.error(c("yellow", `⚠ The session did not resume (${FRESH_WHY.resume_failed}): the revision runs in a FRESH session, seeded with the brief, the deliverables and the gate's reservations.`));
  auditFresh(freshReason);
  res = runRevision(undefined, freshPrompt(freshReason));
}

// claude --resume can mint a fresh session id, and a fresh revision has a new
// one; persist whatever we got back, so the next revision continues it.
if ((res.sessionId && res.sessionId !== sessionId) || rt !== sessionRuntime) {
  if (res.sessionId) session.session_id = res.sessionId;
  session.runtime = rt;
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
  fs.writeFileSync(sessionFile, JSON.stringify(session, null, 2));
}
if (ledgerRun && res.sessionId) {
  try { runLedger.recordSession(ledgerRun.handle, ledgerRun.runId, res.sessionId); } catch { /* the session file has it */ }
}
// The runtime ran the revision in another conversation (agy's `--continue`
// with nothing to continue): the change was applied blind to the run's work.
if (res.resumeLost) {
  console.error(c("yellow", "⚠ The revision did NOT resume the run's conversation: it ran without the previous context."));
  for (const w of res.warnings ?? []) console.error(c("dim", `  ${w}`));
  appendAudit({ event: "x_resume_lost", trace_id: projectId, project_id: projectId, business_slug: kind === "business" ? slug : null,
    target_kind: kind, runtime: rt, requested_session_id: sessionId, session_id: res.sessionId, revision: true }, projectRoot);
}
console.log(c("dim", `  ${res.durationMs}ms${res.costUsd != null ? ` · $${res.costUsd.toFixed(4)}` : ""}`));

// ── delivery (verify → gate → deliver) ────────────────────────────────────
//
// The SAME pipeline as the dispatch path and the supervisor. What lived here
// before was a private copy of both steps, and it failed open twice over: a
// 200-byte verify, a .md/.txt/.json-only gate, and an `allPass` flag that
// started at TRUE — so a revision producing only an .html, a PDF or an image
// was judged by nothing and still emitted `delivered` with gate:"pass". A real
// gate FAIL also emitted `delivered` (gate:"fail") before exiting 1. Phase 4
// closed exactly that at dispatch time; the route the WITHHELD message sends
// users to (`nrv revise <pid> "<fix>"`) kept it open.
//
// Revision budget: `nrv revise` is the human's own iteration loop, so the
// config budget applies — EXCEPT when the SUPERVISOR spawned us (NRV_IN_SWEEP=1,
// set by supervisor.ts defaultResume). An unattended sweep (`watch`'s loop or
// a lazy background trigger) runs with nobody watching; a revision loop there
// spends LLM money and can re-trigger on the next sweep. There the gate
// verdict goes straight back to the supervisor, which withholds and escalates
// to a human. Do NOT raise this number to "make recovery work": deliberate
// iteration is the human's call.
const inSweep = process.env.NRV_IN_SWEEP === "1";
const config = loadHarnessConfig();
const zipWanted = Boolean(session.zip_path) || wantZip;

/** Re-export the zip. Hangs off afterGate, so a WITHHELD delivery never
 *  refreshes the artifact a user might ship. */
function rezip(): string | null {
  if (!zipWanted) return null;
  const exportScript = path.join(SKILLS, "harness/scripts/export.ts");
  const out = (session.zip_path as string | null) || path.resolve(`./${projectId}.zip`);
  const z = spawnSync("bun", [exportScript, projectId!, "--format=zip", "--deliverables-only", `--output=${out}`], { windowsHide: true, encoding: "utf8", stdio: "inherit" });
  if (z.status !== 0) return null;
  session.zip_path = out;
  fs.writeFileSync(sessionFile, JSON.stringify(session, null, 2));
  return out;
}

const deliveryArgs: DeliveryArgs = {
  // Only widens the deliverable floor for files named explicitly (see
  // delivery-pipeline briefNamedFiles); the change request is the closest
  // thing to a brief this script has when the project has no brief.md.
  brief: brief ?? change,
  outputsRoot: oroot,
  // The dispatch records its --manifest in session.json, so a revision keeps
  // the completeness proof instead of silently falling back to the disk scan.
  // Older sessions predate the field: null there, and verify degrades as before.
  manifest: (typeof session.manifest === "string" && session.manifest) ? session.manifest : null,
  pid: projectId,
  slug: kind === "agent-x" ? null : slug,
  targetKind: kind,
  ...(role ? { producerRole: role } : {}),
  runtime: rt,
  projectDir: projDir,
  projectRoot,
  workingDir: process.cwd(),
  // A fresh revision's corrections continue the fresh session, never the lost one.
  sessionId: (session.session_id as string | null) ?? (freshReason ? null : sessionId),
  maxRevisions: inSweep ? 0 : config.quality_gate.max_revisions,
  // nrv revise is the DELIBERATE iteration tool: one revision per invocation,
  // a human (or the sweep, via NRV_IN_SWEEP) reading the verdict. Its 0/2/3
  // exit contract stays strict — the accept-with-reservations default applies
  // to the dispatch pipeline's autonomous loop, not to the tool the
  // reservations note tells you to reach for.
  gateExhaustedPolicy: "withhold",
  maxBudgetUsd: maxBudget ? parseFloat(maxBudget) : undefined,
  timeoutMs: timeoutMin ? parseInt(timeoutMin, 10) * 60 * 1000 : undefined,
  yolo,
  config,
  // The revision's ledger row: its correction rounds run under it too (so the
  // stall guard covers them), and the verdict closes it.
  ledger: ledgerRun ? { handle: ledgerRun.handle, runId: ledgerRun.runId } : null,
  env: reviseEnv,                       // its gate revision rounds continue the same work
  audit: (event, payload) => appendAudit({ event, ...payload, revision: true }, projectRoot),
  afterGate: () => ({ zipPath: rezip() }),
  onSession: (sid) => {
    session.session_id = sid;
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(sessionFile, JSON.stringify(session, null, 2));
  },
  verifyScript: path.join(SKILLS, "businesses/scripts/verify-deliverable.ts"),
  gateScript: path.join(SKILLS, "harness/scripts/quality-gate.ts"),
  log: (l) => console.log(c("dim", l)),
  warn: (l) => console.error(c("yellow", l)),
};

/** One outcome report for both doors: a clean revision and a salvaged one. */
function printOutcome(result: DeliveryResult): void {
  console.log("");
  if (result.quotaWait) {
    console.log(c("yellow", `⏸ Waiting on quota (exit ${result.exitCode}): ${result.quotaWait.hint}. Nothing more ran; nothing was delivered.`));
    console.log(c("dim", `  Resets: ${result.quotaWait.resetAt}${result.quotaWait.named ? "" : " (estimated)"}.`));
  } else if (result.exitCode === 0) {
    console.log(c("green", "✓ Revision applied and delivered."));
  } else if (result.exitCode === 2) {
    console.log(c("yellow", "⚠ Revision applied, delivery WITHHELD — the quality gate failed (exit 2)."));
    console.log(c("dim", "  The files stay on disk; nothing was marked as delivered."));
  } else if (result.exitCode === 3) {
    console.log(c("yellow", "⚠ Delivery INDETERMINATE — no artifact the gate knows how to judge (exit 3)."));
    console.log(c("dim", "  Nothing was judged, so nothing was delivered."));
  } else {
    console.log(c("red", "✗ Revision with no verifiable deliverable."));
  }
  console.log(c("dim", `  Deliverables: ${oroot}`));
  if (result.zipPath) console.log(c("dim", `  Zip:          ${result.zipPath}`));
  console.log("");
}

if (!res.ok) {
  const runtimeError = `revision run: ${res.error || res.stderr || `exit ${res.exitCode}`}`;
  console.error(c("red", `✗ revision failed (exit ${res.exitCode}): ${res.error || res.stderr || "unknown"}`));
  appendAudit({ event: "revision_failed", trace_id: projectId, project_id: projectId, business_slug: kind === "business" ? slug : null,
    target_kind: kind, exit_code: res.exitCode, error: res.error || res.stderr }, projectRoot);
  // A failed revision does NOT mean nothing changed on disk: the usual case is
  // a limit hit after the edits were written. Judge what exists instead of
  // abandoning it — same policy the dispatch path applies (deliverAfterRuntimeError).
  // No artifacts -> the historical exit 1 stands.
  const outcome = deliverAfterRuntimeError({ ...deliveryArgs, runtimeError, errorContext: { revision: true } });
  if (!outcome.result) {
    if (ledgerRun) {
      try {
        const now = runLedger.getRun(ledgerRun.handle, ledgerRun.runId);
        if (now && !runLedger.isTerminal(now.state) && now.state !== "failed") runLedger.markState(ledgerRun.handle, ledgerRun.runId, "failed", { error: runtimeError });
      } catch { /* the audit has it */ }
    }
    process.exit(1);
  }
  printOutcome(outcome.result!);
  process.exit(outcome.exitCode);
}

const result = runDelivery(deliveryArgs);
printOutcome(result);
process.exit(result.exitCode);
