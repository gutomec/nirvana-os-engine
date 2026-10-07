#!/usr/bin/env bun
// revise.ts — request changes to an autopilot deliverable, keeping the session.
//
// Resumes the SAME runtime conversation (claude --resume <session_id>) so the
// agent has full context of what it produced, applies the change, then re-runs
// verify + gate + (re)export. State lives in the session.json `nrv dispatch
// --exec` leaves beside the worker's scaffold (lib/run-session.ts):
// <run>/businesses/<slug>/, <run>/squads/<slug>/ or <run>/agent-x/, and in the
// run's ledger row.
//
// The revision continues the ORIGINAL worker: the same role (a business runs
// as one `solo` worker with the solo directive, a squad as `squad`, the
// generalist as `agent-x`; none of them may open anything), on the runtime that
// finished the run, pinned when the owner chose it (flag or brief). A run whose
// runtime returned no session id, a run from before squad and agent-x runs
// recorded one, and a route of several squads have no single conversation to
// continue, and are refused (exit 4): a change to them is a new dispatch.
//
// Usage:
//   nrv revise <project_id> "<change request>"
//   nrv revise <project_id> "<change>" --zip --max-budget=10 --timeout=20 --yolo
//
// Exit codes (SAME TABLE as dispatch.ts — BREAKING, see CHANGELOG):
//   0 = revised + DELIVERED (gate pass, or with reservations for findings
//       that are not serious)
//   1 = failed (runtime error, or no verifiable deliverable on disk)
//   2 = delivery WITHHELD — a serious finding after the corrections (in the
//       supervisor's sweep, any gate failure)
//   3 = delivery INDETERMINATE — zero gateable artifacts; nothing was judged
//   4 = invalid args, or a run this command cannot continue (EXIT.INVALID_ARGS)
//
// 0 means DELIVERED, and only that. This script used to exit 0 whenever the
// text-only gate had nothing to chew on, while emitting `delivered` with
// gate:"pass" — see the delivery block below.

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawnSync } from "node:child_process";
import { runtimeAvailable, AUTONOMOUS_DIRECTIVE, type Runtime } from "../lib/host-agent-driver.ts";
import { findRunSessions, type RunSessionFile } from "../lib/run-session.ts";
import { resolveCascadeRoot } from "../lib/cascade.ts";
import { formatRulesForDirective, loadRuntimeRules } from "../lib/runtime-rules.ts";
import { paths } from "../../_shared/lib/bun-helpers.ts";
import { runWithCascade } from "../lib/cascade-runner.ts";
import { soloDirective } from "../lib/business-solo.ts";
import { runDelivery, deliverAfterRuntimeError, type DeliveryArgs, type DeliveryResult } from "../lib/delivery-pipeline.ts";
import * as runLedger from "../lib/run-ledger.ts";
import type { DispatchRole } from "../../_shared/lib/dispatch-depth.ts";
import { loadHarnessConfig } from "../lib/harness-config.ts";
import { harnessLogsDir } from "../../_shared/lib/log-paths.ts";
import { scopeGuard } from "../../_shared/lib/scope-guard.ts";
import { stamp } from "../../_shared/lib/audit-provenance.ts";

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
const projectId = positional[0];
const change = positional[1];
const wantZip = process.argv.includes("--zip");
// Default = full trust (same criterion as dispatch.ts). --safe opts into restricted.
const yolo = !process.argv.includes("--safe");
const maxBudget = arg("--max-budget");
const timeoutMin = arg("--timeout");

if (!projectId || !change) {
  console.error('Usage: nrv revise <project_id> "<change>" [--zip] [--max-budget=<usd>] [--timeout=<min>] [--safe]');
  process.exit(4);   // EXIT.INVALID_ARGS — 2 now means WITHHELD (see the table above)
}

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

/** The run folders a project id can live in, nearest first. */
function runRoots(pid: string): string[] {
  return [
    path.join(process.cwd(), "outputs", pid),            // new visible default
    path.join(os.homedir(), ".nirvana", "outputs", pid),
    path.join(process.cwd(), ".nirvana", "outputs", pid),
    path.join(os.homedir(), pid),
  ];
}

/** The session files of the run, from the nearest run folder that holds any. */
function findSessions(pid: string): RunSessionFile[] {
  for (const root of runRoots(pid)) {
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
  for (const root of runRoots(pid)) {
    if (fs.existsSync(path.join(root, "squads"))) return "squad";
    if (fs.existsSync(path.join(root, "agent-x"))) return "agent-x";
  }
  return null;
}

const sessions = findSessions(projectId);
if (!sessions.length) {
  const kind = sessionlessKind(projectId);
  if (kind) {
    console.error(c("red", `✗ '${projectId}' is a ${kind} run from before ${kind} runs recorded their session: it keeps no session.json to continue.`));
    console.error("  Its deliverables stay where they are; a change to them is a new dispatch.");
    process.exit(4);
  }
  console.error(c("red", `✗ no run '${projectId}' with a session to continue was found (looked for businesses/<slug>/, squads/<slug>/ and agent-x/session.json under ${runRoots(projectId).join(", ")}).`));
  process.exit(1);
}
if (sessions.length > 1) {
  console.error(c("red", `✗ '${projectId}' ran ${sessions.length} workers (${sessions.map(s => s.kind === "agent-x" ? "agent-x" : `${s.kind} ${s.slug}`).join(", ")}), and nrv revise continues one worker's own session.`));
  console.error("  This run has no single conversation to continue: a change to it is a new dispatch.");
  process.exit(4);
}
const { file: sessionFile, kind } = sessions[0];
const session = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
const meta: Record<string, unknown> = ledger?.row?.meta ?? {};
const metaStr = (key: string): string | null => {
  const v = meta[key] ?? session[key];
  return typeof v === "string" && v ? v : null;
};
// The runtime that owns the session: the conversation can be resumed only
// there. The ledger's runtime is the fallback for a session that never named one.
const rt = ((session.runtime as string) || ledger?.row?.runtime || "") as Runtime;
const sessionId = session.session_id as string | null;
// The worker's slug: the business's, the squad's, or "agent-x".
const slug = ((kind === "business" ? session.business_slug : session.target_slug) as string) || sessions[0].slug;
const projDir = session.project_dir as string;
const projectRoot = session.project_root as string;
const oroot = session.outputs_root as string;

// The original worker's role, never the operator's: a business runs as one
// solo worker, a squad as `squad`, the generalist as `agent-x`. Each may open
// nothing, and the revision carries the same stamp.
const role: DispatchRole = kind === "business" ? "solo" : kind;
// The owner chose this runtime (a flag, or a mention in the brief): the
// revision stays on it and never hands off to another vendor.
const pinned = ["flag", "brief"].includes(metaStr("runtime_source") ?? "");

/** The brief the run answered: where the run recorded it, else the run's
 *  scaffold root (`<run>/brief.md`, two levels above businesses/<slug> or
 *  squads/<slug>; `<run>/brief-enriched.md`, one level above agent-x), else
 *  beside the session. Never the project root, which holds no brief. */
function readBrief(): string | null {
  const scaffoldRoot = metaStr("scaffold_root") ?? (kind === "agent-x" ? path.dirname(projDir) : path.resolve(projDir, "..", ".."));
  const briefName = kind === "agent-x" ? "brief-enriched.md" : "brief.md";
  for (const file of [metaStr("brief_path"), path.join(scaffoldRoot, briefName), path.join(projDir, "brief.md")]) {
    if (!file) continue;
    const text = readIfExists(file);
    if (text?.trim()) return text;
  }
  return null;
}
const brief = readBrief();

/** The squad's own folder, as squad-exec granted it to the run; none for a business or agent-x. */
function squadDirs(): string[] {
  if (kind !== "squad") return [];
  const dir = path.join(paths.SQUADS_DIR, slug);
  return fs.existsSync(dir) ? [dir] : [];
}

if (!sessionId) {
  console.error(c("red", `✗ '${projectId}': the ${kind} run's runtime${rt ? ` (${rt})` : ""} returned no session id, so there is no conversation to continue.`));
  console.error("  Its deliverables stay where they are; a change to them is a new dispatch (nrv dispatch).");
  process.exit(4);
}

console.log("");
console.log(c("lime", "▶") + c("bold", ` nrv revise — ${projectId} (${rt})`));
console.log(c("dim", `  resume session: ${sessionId}`));

if (!runtimeAvailable(rt)) {
  console.error(c("red", `✗ runtime '${rt}' is not on the PATH.`));
  process.exit(1);
}

// The ledger row this revision moves. A live row (the supervisor marked it
// `running` before spawning us, or a run a human picks up mid-way) is carried
// on; a finished one is history, so the revision opens a new attempt of the
// same trace, which `nrv run-track status <trace>` then reports.
const ledgerRun: { handle: runLedger.LedgerHandle; runId: string } | null = (() => {
  if (!ledger?.row) return null;
  const { handle, row } = ledger;
  try {
    if (!runLedger.isTerminal(row.state)) {
      if (row.state !== "running") runLedger.markState(handle, row.run_id, "running");
      return { handle, runId: row.run_id };
    }
    const fresh = runLedger.openRun(handle, {
      traceId: projectId, projectId, projectRoot: row.project_root, targetSlug: row.target_slug ?? slug, targetKind: kind, runtime: rt,
      // This process is the revision's dispatcher: `nrv run-track stop` ends it
      // with its worker, instead of the earlier run's pid the copied meta carries.
      sessionId, meta: { ...row.meta, revision_of: row.run_id, dispatch_role: role,
        dispatcher_pid: process.pid, dispatcher_started_at: runLedger.processStartedAt(process.pid) },
    });
    runLedger.markState(handle, fresh.run_id, "running");
    return { handle, runId: fresh.run_id };
  } catch (e) {
    console.error(c("dim", `  (run ledger: ${(e as Error)?.message ?? e}; the revision is not tracked)`));
    return null;
  }
})();

const solo = role === "solo";
// The user's USE_* rules, as the dispatch handed them to the worker.
const rulesDirective = formatRulesForDirective(loadRuntimeRules(resolveCascadeRoot(projectRoot || process.cwd())));
const revisePrompt = [
  "REVISION INSTRUCTION (same session: you have the full context of what you produced):",
  "",
  change,
  "",
  `Rewrite or update the deliverables as files under: ${oroot}`,
  solo
    ? `Then update ${path.join(oroot, "_SUMMARY.md")} and ${path.join(oroot, "_CLAIMS.json")} so they describe the revised delivery; each claim's evidence names a file that exists under ${oroot}.`
    : `Then update ${path.join(oroot, "_SUMMARY.md")} so it describes the revised delivery.`,
  scopeGuard(),
  'Do not print a summary: deliver the updated files. Update the assumptions section ("## Assumptions" or its equivalent in the language of the deliverable) if anything changed.',
].join("\n");

appendAudit({ event: "revision_requested", trace_id: projectId, project_id: projectId, business_slug: kind === "business" ? slug : null,
  target_kind: kind, target_slug: slug, runtime: rt, session_id: sessionId, dispatch_role: role, pinned }, projectRoot);

const res = runWithCascade({
  runtime: rt,
  prompt: revisePrompt,
  cwd: projectRoot,
  // A squad's own tree, granted again as the run granted it: its resource map
  // names files under it, and claude-code and agy refuse an ungranted path.
  addDirs: [projDir, oroot, ...squadDirs()],
  // The folder the session was started in (absent on runs from before runs
  // had one): claude and gemini resume a session only from its own folder.
  workspace: session.workspace || undefined,
  sessionId,
  appendSystemPrompt: solo ? soloDirective(rulesDirective) : AUTONOMOUS_DIRECTIVE + rulesDirective,
  dispatchRole: role,
  pinned,
  maxBudgetUsd: maxBudget ? parseFloat(maxBudget) : undefined,
  timeoutMs: timeoutMin ? parseInt(timeoutMin, 10) * 60 * 1000 : undefined,
  yolo,
  label: `revise ${projectId}`,
  brief: brief ?? change, projectRoot, outputsRoot: oroot, taskHint: `revise ${projectId}`, projectId,
  ...(ledgerRun ? { ledger: { runId: ledgerRun.runId, watchDir: oroot } } : {}),
});
// A run that was not pinned may have been handed to another runtime; the
// session it came back with belongs to that one.
const finalRuntime = (res.finalRuntime ?? rt) as Runtime;

// claude --resume can mint a fresh session id; persist whatever we got back.
if ((res.sessionId && res.sessionId !== sessionId) || finalRuntime !== rt) {
  if (res.sessionId) session.session_id = res.sessionId;
  session.runtime = finalRuntime;
  fs.writeFileSync(sessionFile, JSON.stringify(session, null, 2));
}
if (ledgerRun && res.sessionId) {
  try { runLedger.recordSession(ledgerRun.handle, ledgerRun.runId, res.sessionId); } catch { /* the session file has it */ }
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
// config budget applies, and the owner's rule A with it (a serious finding
// gets extra rounds and is withheld if it stays; anything else ships with
// reservations) — EXCEPT when the SUPERVISOR spawned us (NRV_IN_SWEEP=1, set
// by supervisor.ts defaultResume). An unattended sweep (`watch`'s loop or a
// lazy background trigger) runs with nobody watching; a revision loop there
// spends LLM money and can re-trigger on the next sweep. There no correction
// runs, and any gate failure goes straight back to the supervisor, which
// withholds and escalates to a human. Do NOT raise this number to "make
// recovery work": deliberate iteration is the human's call.
const inSweep = process.env.NRV_IN_SWEEP === "1";
const config = loadHarnessConfig();
const zipWanted = Boolean(session.zip_path) || wantZip;

/** Re-export the zip. Hangs off afterGate, so a WITHHELD delivery never
 *  refreshes the artifact a user might ship. */
function rezip(): string | null {
  if (!zipWanted) return null;
  const exportScript = path.join(SKILLS, "harness/scripts/export.ts");
  const out = (session.zip_path as string | null) || path.resolve(`./${projectId}.zip`);
  const z = spawnSync("bun", [exportScript, projectId, "--format=zip", "--deliverables-only", `--output=${out}`], { windowsHide: true, encoding: "utf8", stdio: "inherit" });
  if (z.status !== 0) return null;
  session.zip_path = out;
  fs.writeFileSync(sessionFile!, JSON.stringify(session, null, 2));
  return out;
}

const deliveryArgs: DeliveryArgs = {
  // The run's own brief: the claims check reads its "Done when", and the judge
  // grades against it. The change request stands in only when the run kept none.
  brief: brief ?? change,
  outputsRoot: oroot,
  // The dispatch records its --manifest in session.json, so a revision keeps
  // the completeness proof instead of silently falling back to the disk scan.
  // Older sessions predate the field: null there, and verify degrades as before.
  manifest: (typeof session.manifest === "string" && session.manifest) ? session.manifest : null,
  pid: projectId,
  slug: kind === "business" ? slug : null,
  targetKind: kind,
  runtime: finalRuntime,
  producerRole: role,
  rulesDirective,
  projectDir: projDir,
  projectRoot,
  workingDir: process.cwd(),
  sessionId: (session.session_id as string | null) ?? sessionId,
  maxRevisions: inSweep ? 0 : config.quality_gate.max_revisions,
  // Unattended, strict: the supervisor reads exit 2 and escalates. A human's
  // revision follows rule A like any delivery.
  ...(inSweep ? { gateExhaustedPolicy: "withhold" as const } : {}),
  maxBudgetUsd: maxBudget ? parseFloat(maxBudget) : undefined,
  timeoutMs: timeoutMin ? parseInt(timeoutMin, 10) * 60 * 1000 : undefined,
  yolo,
  config,
  ledger: ledgerRun,
  audit: (event, payload) => appendAudit({ event, ...payload, revision: true }, projectRoot),
  afterGate: () => ({ zipPath: rezip() }),
  onSession: (sid) => {
    session.session_id = sid;
    fs.writeFileSync(sessionFile!, JSON.stringify(session, null, 2));
  },
  verifyScript: path.join(SKILLS, "businesses/scripts/verify-deliverable.ts"),
  gateScript: path.join(SKILLS, "harness/scripts/quality-gate.ts"),
  log: (l) => console.log(c("dim", l)),
  warn: (l) => console.error(c("yellow", l)),
};

/** One outcome report for both doors: a clean revision and a salvaged one. */
function printOutcome(result: DeliveryResult): void {
  console.log("");
  if (result.state === "delivered") {
    console.log(c("green", "✓ Revision applied and delivered."));
  } else if (result.state === "delivered_with_reservations") {
    console.log(c("yellow", "✓ Revision applied and delivered WITH RESERVATIONS (nothing serious left)."));
    if (result.reservations) console.log(c("dim", `  Reservations: ${result.reservations}`));
  } else if (result.exitCode === 2) {
    console.log(c("yellow", "⚠ Revision applied, delivery WITHHELD (exit 2)."));
    for (const s of result.serious) console.log(c("dim", `  serious: ${s}`));
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
  appendAudit({ event: "revision_failed", trace_id: projectId, project_id: projectId, business_slug: kind === "business" ? slug : null, target_kind: kind, exit_code: res.exitCode, error: res.error || res.stderr }, projectRoot);
  // A failed revision does NOT mean nothing changed on disk: the usual case is
  // a limit hit after the edits were written. Judge what exists instead of
  // abandoning it — same policy the dispatch path applies (deliverAfterRuntimeError).
  // No artifacts -> the historical exit 1 stands.
  const outcome = deliverAfterRuntimeError({ ...deliveryArgs, runtimeError, errorContext: { revision: true } });
  if (!outcome.judged) process.exit(1);
  printOutcome(outcome.result!);
  process.exit(outcome.exitCode);
}

const result = runDelivery(deliveryArgs);
printOutcome(result);
process.exit(result.exitCode);
