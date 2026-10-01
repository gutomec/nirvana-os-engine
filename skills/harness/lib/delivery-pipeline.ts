// delivery-pipeline.ts — fail-closed verify → gate → deliver pipeline
// (routing-360 Phase 4.2).
//
// One pipeline for all three dispatch paths (business, squad-exec, agent-x):
// every path that produces artifacts goes through the SAME verification, the
// SAME gate surface and the SAME delivery decision.
//
// What a failed gate leads to (owner rule A, 2026-10-01):
//
//   - A SERIOUS finding keeps being corrected past quality_gate.max_revisions,
//     up to SERIOUS_EXTRA_ROUNDS more rounds; still serious after them, the
//     delivery is WITHHELD (exit 2, never `delivered`, --force-deliver
//     included). Serious = the secret-leak rubric failed; a validity rubric
//     failed (json/html/pdf/yaml-valid, image sanity); the judge reported a
//     material defect; a blocking "Done when" criterion of a business brief
//     has no claim whose evidence names a file that exists under the outputs
//     root; the solo review left a blocking criterion unconfirmed.
//   - A finding that is not serious (style, wiki-lint, structure) stops at the
//     limit and is DELIVERED WITH RESERVATIONS (exit 0, _QA-RESERVATIONS.md).
//     A caller that runs unattended may ask for `gateExhaustedPolicy:
//     "withhold"` instead.
//
// The LLM judge follows quality_gate.judge_enabled (reports | true | false);
// the heuristics cover everything else, and secret-leak and the validity
// rubrics run in both modes.
//
// Exit-code contract (BREAKING vs pre-Phase-4 — see CHANGELOG):
//   0 = delivered (gate pass), delivered with reservations, or fail-forced
//   1 = run failed (no verifiable deliverable: nothing, or only run state)
//   2 = withheld (a serious finding, the strict policy, or the completeness
//       ceiling)
//   3 = indeterminate (zero gateable artifacts — nothing was judged;
//       no gate_passed, no delivered)
//
// Every outcome is also written to <outputsRoot>/_STATUS.json:
//   {state, gate: "pass"|"fail"|"skipped", serious: [], reservations, exit_code}
// with state delivered | delivered_with_reservations | withheld |
// indeterminate | failed, the field the dispatch reads its final message from.
//
// Ledger: the pipeline keeps marking verifying → gated → delivered|withheld
// (never-stall guarantee, bd750d6e), renews the run's lease while it judges and
// publishes, and clears the worker's pid once the worker is done. Ledger
// failures never break a delivery.
//
// deliverAfterRuntimeError() (bottom of this file) is the entry point for a
// run whose runtime returned an error verdict: with artifacts on disk it
// recovers into this same pipeline instead of abandoning them unjudged, under
// a completeness ceiling (a crashed worker may have left half the set).
//
// DeliveryArgs.completenessCeiling caps the outcome for callers whose run was
// INTERRUPTED: the gate judges quality, never completeness, so a full
// `delivered` stays reachable only through a passing manifest verification.

import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { runHeadless, runtimeAvailable, AUTONOMOUS_DIRECTIVE, type Runtime } from "./host-agent-driver.ts";
import type { DispatchRole } from "../../_shared/lib/dispatch-depth.ts";
import { scopeGuard } from "../../_shared/lib/scope-guard.ts";
import { isRunStatePath } from "../../_shared/lib/run-state.ts";
import { isRunStateFile } from "../../_shared/lib/run-plumbing.ts";
import { soloDirective } from "./business-solo.ts";
import { claimProblems, criteriaFromBrief, SERIOUS_EXTRA_ROUNDS, type ClaimProblem } from "./solo-review.ts";
import { runFolderOf } from "../../_shared/lib/run-workspace.ts";
import { detectKind } from "../../_shared/lib/surface.ts";
import { GATEABLE_EXTS } from "../scripts/quality-gate.ts";
import { harnessLogsDir } from "../../_shared/lib/log-paths.ts";
import { resolveSetting } from "../../_shared/lib/settings.ts";
import { judgeScope, type HarnessConfig } from "./harness-config.ts";
import * as runLedger from "./run-ledger.ts";

// ── deliverable surface (moved verbatim from scripts/dispatch.ts) ─────────

/** Anti-stub floor: files under 200 bytes are drafts — EXCEPT when the brief
 * names the file explicitly (a legitimate haiku.md has ~60 bytes; the user's
 * explicit ask outweighs the size heuristic). Empty (0 bytes) never passes. */
export const MIN_DELIVERABLE_BYTES = 200;

export function briefNamedFiles(briefText: string): Set<string> {
  const out = new Set<string>();
  // name.ext with a short alphabetic extension ("haicai.md", "report.html");
  // "v7.0.0" does not match (extension requires letters).
  for (const m of briefText.matchAll(/[\p{L}\p{N}_-]+\.[a-z]{1,5}\b/giu)) out.add(m[0].toLowerCase());
  return out;
}

export function isDeliverable(f: string, named: Set<string>): boolean {
  try {
    const size = fs.statSync(f).size;
    return size >= MIN_DELIVERABLE_BYTES || (size > 0 && named.has(path.basename(f).toLowerCase()));
  } catch { return false; }
}

export function listFiles(dir: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(full));
    else if (e.isFile()) out.push(full);
  }
  return out;
}

/** Legacy text-only gate surface (.md/.txt/.json). Kept exported because the
 * pre-Phase-4 tests pin it; the pipeline itself gates gateableFiles(). */
export function nonStubText(dir: string, named: Set<string>): string[] {
  return listFiles(dir).filter(f => /\.(md|txt|json)$/i.test(f) && isDeliverable(f, named));
}

/**
 * True when a path under an outputs root holds RUN STATE rather than work
 * product. Three sources, none of them a name list invented here:
 *
 *  - `isRunStateFile` (skills/_shared/lib/run-plumbing.ts) — what the run
 *    writes about itself: the worker's `_SUMMARY.md` and `_CLAIMS.json`, the
 *    gate's `_QA-RESERVATIONS.md` and `_STATUS.json`, `_work/`, `_review/`,
 *    the prompt, the session. The one list every counter, gate, verifier,
 *    report and export asks, so a run that left only these is not a delivery.
 *  - `isRunStatePath` (skills/_shared/lib/run-state.ts) — the canonical list
 *    the installer, the uninstaller and the pack builder already read. An
 *    outputs root may belong to a squad or to a business, so every kind is
 *    asked. Asked ONE KIND AT A TIME, never kindless: the kindless branch
 *    matches bare first segments, and run-state.ts documents what that cost
 *    the last time — `memory/projects` collapsing to `memory` took
 *    `memory/permanent.md` out of forty-six businesses.
 *  - a DIRECTORY segment opening with `.` or `_` — the two namespaces the
 *    engine reserves for itself.
 */
const RUN_STATE_KINDS = ["squads", "businesses", "mind-clones"] as const;

function isRunStateUnderOutputs(rel: string): boolean {
  if (isRunStateFile(rel)) return true;
  if (RUN_STATE_KINDS.some(kind => isRunStatePath(rel, kind))) return true;
  const segs = rel.split(/[\\/]/).filter(Boolean);
  return segs.slice(0, -1).some(s => s.startsWith(".") || s.startsWith("_"));
}

/**
 * True when a path sits inside a CAPTURED ENTITY — a squad, business or
 * mind-clone copied whole into the outputs root (`detectKind` finds its
 * manifest there). The run put those bytes on disk; it did not write them.
 *
 * Why identity and not the name: in trace 70341260 the directory was called
 * `backup-before`, so a reserved-prefix convention would have missed it — a
 * rule that needs the offending agent's cooperation is a request, not a rule.
 * A copied squad carries `squad.yaml` whatever the directory is called.
 */
function insideCapturedEntity(root: string, rel: string, memo: Map<string, boolean>): boolean {
  const dirs = rel.split(/[\\/]/).filter(Boolean).slice(0, -1);
  let acc = "";
  for (const seg of dirs) {
    acc = acc ? `${acc}/${seg}` : seg;
    let hit = memo.get(acc);
    if (hit === undefined) {
      hit = detectKind(path.join(root, acc)) !== null;
      memo.set(acc, hit);
    }
    if (hit) return true;
  }
  return false;
}

/** The Phase 4 gate surface: every non-stub artifact whose extension the
 * quality gate knows how to judge (quality-gate.ts GATEABLE_EXTS — includes
 * .html, .yaml/.yml, code and images), minus what the run did not write.
 *
 * Run state is dropped outright — it is never a deliverable, and if dropping
 * it empties the surface the outcome is INDETERMINATE, which is the honest
 * answer. A captured entity is dropped only while the run has work of its own
 * left to judge: when the entity IS the deliverable (a run asked to build a
 * squad) it stays, so this filter can narrow noise and never silence signal. */
export function gateableFiles(dir: string, named: Set<string>): string[] {
  const all = listFiles(dir).filter(f =>
    GATEABLE_EXTS.has(path.extname(f).toLowerCase()) && isDeliverable(f, named));
  const own = all.filter(f => !isRunStateUnderOutputs(path.relative(dir, f)));
  const memo = new Map<string, boolean>();
  const authored = own.filter(f => !insideCapturedEntity(dir, path.relative(dir, f), memo));
  return authored.length > 0 ? authored : own;
}

/** Non-stub artifacts under `outputsRoot` that are work, not run state — the
 * SAME discovery runDelivery uses for its `produced` list. The runtime-error
 * salvage path asks this (never a second scanner) whether a not-ok run left
 * anything worth judging: a worker that died leaving only `_work/` did not. */
export function candidateArtifacts(outputsRoot: string, brief: string): string[] {
  const named = briefNamedFiles(brief);
  return listFiles(outputsRoot).filter(f => isDeliverable(f, named) && !isRunStateFile(path.relative(outputsRoot, f)));
}

// ── gate runner ───────────────────────────────────────────────────────────

export interface GateRunOpts {
  gateScript: string;
  /** true → heuristic rubrics only (--offline). false → judge path
   * (--with-revisions, no --offline). */
  offline: boolean;
  /** produces[] slugs forwarded to the judge's rubric selector. */
  produces?: string[];
  /** The brief, on disk, for the judge to grade the artifact against it. */
  briefFile?: string;
  /** Judge mode only: the extensions the judge takes. A file outside the set
   *  keeps its offline heuristic rubrics. Absent = the judge takes every file. */
  judgeExts?: ReadonlySet<string>;
  /** Env for the gate child (trace/project/business ids for its audit emit). */
  env?: Record<string, string | undefined>;
  /** Called before each file is judged (the pipeline renews the run's lease
   *  here: a judge on a long report can think for minutes per file). */
  beforeFile?: (file: string) => void;
}

/**
 * The `produces[]` slugs the judge's rubric selector receives.
 *
 * `deliveryArgs()` never passed `produces`, so `selectRubricsForProduces` was
 * always called with `[]` and every deliverable — a landing page, a dataset, a
 * video script — was judged by `prose_shortform`. The declaration exists on both
 * sides (a squad capability's `produces`, a business manifest's), so the fix is
 * to forward it; `delivery.produces_to_rubric` gates the forwarding because the
 * rubrics cover roughly 45 of the 3.024 slugs the library declares, and a slug
 * with no rubric must degrade to the fallback, never to a refusal.
 *
 * On by default: a produces slug with no rubric falls back to the rubric the
 * file's extension implies (quality-gate.ts), never to a refusal. Off returns
 * `[]`, and the judge uses the extension's rubric for every file.
 */
export function producesForRubric(produces: readonly string[] | null | undefined, enabled: boolean): string[] {
  if (!enabled) return [];
  const slugs = (produces ?? []).map(slug => String(slug ?? "").trim()).filter(Boolean);
  return [...new Set(slugs)];
}

/** The deliverables `judge_enabled: "reports"` sends to the LLM judge: the
 *  text deliverables, reports and research the offline heuristics cannot hold
 *  to the brief, HTML reports included. The gate hands the judge no text for a
 *  PDF, so it keeps its heuristics. */
export const REPORT_EXTS: ReadonlySet<string> = new Set([".md", ".txt", ".html"]);

/** Rubrics whose failure is SERIOUS (owner rule A): a leaked secret, or a file
 *  that is not what its extension promises. Style, wiki-lint and structure
 *  findings are not here, and a failure among them stops at the normal limit. */
export const SERIOUS_RUBRICS: ReadonlySet<string> = new Set([
  "secret-leak", "json-valid", "html-valid", "pdf-valid", "yaml-valid", "brief-fidelity",
]);

export interface GateFail {
  file: string;
  fixes: string[];
  /** Names of the rubrics that failed on this file. */
  failedRubrics: string[];
  /** The judge reported a material defect (a `high` critique item). */
  material: boolean;
}

export interface GateRun {
  pass: boolean;
  fails: GateFail[];
  /** How each file was REALLY judged: "judge" only when the judge returned a
   *  verdict; a judge that gave none falls back to the heuristics, and says so. */
  modes: Record<string, "judge" | "heuristic">;
}

/** Run the quality gate over each artifact; collect fix lists for failures.
 * Accepts a bare script path (legacy signature, offline heuristics) or full
 * GateRunOpts. Parses the normalized verdict {status, mode, results[]}. */
export function runGateOnce(files: string[], gate: string | GateRunOpts): GateRun {
  const opts: GateRunOpts = typeof gate === "string" ? { gateScript: gate, offline: true } : gate;
  const fails: GateFail[] = [];
  const modes: GateRun["modes"] = {};
  for (const f of files) {
    opts.beforeFile?.(f);
    const argv = [opts.gateScript, f, "--auto"];
    const offline = opts.offline || (opts.judgeExts !== undefined && !opts.judgeExts.has(path.extname(f).toLowerCase()));
    if (offline) argv.push("--offline");
    else {
      argv.push("--with-revisions");
      if (opts.produces?.length) argv.push(`--produces=${opts.produces.join(",")}`);
      if (opts.briefFile) argv.push(`--brief-file=${opts.briefFile}`);
    }
    const g = spawnSync("bun", argv, {
      windowsHide: true,
      encoding: "utf8",
      env: { ...process.env, ...(opts.env ?? {}) },
    });
    let v: any = null;
    try { v = JSON.parse(g.stdout); } catch { v = null; }
    modes[f] = v?.mode === "judge" ? "judge" : "heuristic";
    if (g.status !== 0) {
      const fixes: string[] = [];
      const failedRubrics: string[] = [];
      for (const r of v?.results || []) {
        if (r.passed || r.skipped) continue;
        fixes.push(...(r.fix_list || []));
        if (r.name) failedRubrics.push(String(r.name));
      }
      const material = Array.isArray(v?.critique) && v.critique.some((c: any) => c?.severity === "high");
      fails.push({ file: f, fixes, failedRubrics, material });
    }
  }
  return { pass: fails.length === 0, fails, modes };
}

/** The SERIOUS findings of one gate run, one line each, relative to the root. */
export function seriousGateFindings(run: GateRun, outputsRoot: string): string[] {
  const out: string[] = [];
  for (const fl of run.fails) {
    const rel = path.relative(outputsRoot, fl.file) || path.basename(fl.file);
    for (const r of fl.failedRubrics) if (SERIOUS_RUBRICS.has(r)) out.push(`${rel}: ${r} failed`);
    if (fl.material) out.push(`${rel}: the judge reports a material defect`);
  }
  return out;
}

/** "judge" when every judged file got a judge verdict, "heuristic" when none
 *  did, "mixed" otherwise. Never "judge" for a file the judge did not grade. */
export function gateModeOf(run: Pick<GateRun, "modes">): "judge" | "heuristic" | "mixed" {
  const values = Object.values(run.modes);
  const judged = values.filter(m => m === "judge").length;
  if (judged === 0) return "heuristic";
  return judged === values.length ? "judge" : "mixed";
}

export type GateOutcome = "pass" | "fail" | "indeterminate";

/**
 * Gate decision wrapper. runGateOnce([]) is vacuously {pass:true}, which used
 * to emit `gate_passed` with files:0 for runs delivering only non-gateable
 * artifacts. An empty gated-file list is an INDETERMINATE outcome, never a
 * pass. Exported for tests.
 */
export function decideGateOutcome(files: string[], gatePass: boolean): GateOutcome {
  if (files.length === 0) return "indeterminate";
  return gatePass ? "pass" : "fail";
}

// ── the delivery pipeline ─────────────────────────────────────────────────

export type DeliveryExitCode = 0 | 1 | 2 | 3;

/** The outcome in one word: what the dispatch prints its final message from,
 *  and what `_STATUS.json` records beside the deliverables. */
export type DeliveryState = "delivered" | "delivered_with_reservations" | "withheld" | "indeterminate" | "failed";

export interface DeliveryLedger {
  handle: runLedger.LedgerHandle;
  runId: string;
}

/** Lease the pipeline holds on the run while it judges (renewed before every
 *  file and every correction) and while the publication runs after the gate.
 *  Without it a run that was only being gated looked dead to the supervisor. */
const GATE_LEASE_SEC = 900;
const PUBLISH_LEASE_SEC = 1800;

export interface CompletenessCeiling {
  reason: string;
  /** What the cap does to an outcome that would otherwise be delivered.
   *  "withhold" (default): a human decides (supervisor salvage of a stalled
   *  run). "reservations": it ships WITH RESERVATIONS naming the reason, never
   *  as a full pass (a worker that crashed or timed out after writing). A
   *  serious finding is withheld either way. */
  mode?: "withhold" | "reservations";
}

export interface DeliveryArgs {
  brief: string;
  outputsRoot: string;
  /** Manifest path the dispatch was given (--manifest). When set (and a
   * business slug exists), verification runs through verify-deliverable.ts
   * and its exit code is honored; otherwise the homegrown scan applies. */
  manifest?: string | null;
  /**
   * The business promised files through its roles' `acceptance[]` (Business Protocol
   * 2.0 §11, businesses/lib/acceptance.ts). Those entries are a completeness proof the
   * same way a manifest is, so verification runs through verify-deliverable.ts for them
   * too — a business that never wrote a `deliverables.json` stops falling back to the
   * output scan, which only knows whether SOMETHING was written.
   */
  acceptancePromisesPaths?: boolean;
  pid: string;
  /** Business slug; null for squad-only / agent-x paths. */
  slug: string | null;
  targetKind: "business" | "squad" | "agent-x";
  runtime: Runtime;
  /** cwd for revision runs (the project scaffold dir). */
  projectDir: string;
  projectRoot: string;
  /** cwd for the verify-deliverable spawn (must see <cwd>/outputs/<pid>). */
  workingDir?: string;
  /** Session to resume for auto-revisions. */
  sessionId?: string | null;
  maxRevisions?: number;
  /** Rounds a SERIOUS finding gets beyond `maxRevisions` (rule A). Default
   *  SERIOUS_EXTRA_ROUNDS, and 0 when `maxRevisions` is 0: that is how an
   *  unattended caller (the supervisor's salvage, the sweep, the Gauntlet's
   *  final gate) says no correction runs here at all. */
  seriousExtraRounds?: number;
  /** What a NON-serious failure becomes once the corrections are spent:
   *  "accept" (default) delivers the last attempt WITH RESERVATIONS;
   *  "withhold" keeps the strict exit 2, for a caller nobody watches. A
   *  serious finding is withheld under both. */
  gateExhaustedPolicy?: "accept" | "withhold";
  /** The cheap claims check: every blocking "Done when" criterion of the brief
   *  needs a claim in `_CLAIMS.json` whose evidence names a file that exists
   *  under the outputs root; one that has none is serious. Default: on for a
   *  business (its worker writes the claims), off otherwise. */
  claimsCheck?: boolean;
  /** Blocking criteria the solo review left unconfirmed
   *  (SoloReviewOutcome.blockingMissed). Each one is serious; the pipeline
   *  cannot re-run the review, so they withhold the delivery. */
  reviewBlockingMissed?: string[];
  maxBudgetUsd?: number;
  timeoutMs?: number;
  yolo?: boolean;
  /** The role the producing run carried. A revision round continues that run,
   *  so it carries the same stamp, and a `solo` producer (a business) gets the
   *  solo directive too. Absent when the producer ran without one. */
  producerRole?: DispatchRole;
  rulesDirective?: string;
  /** --force-deliver: deliver despite a failed gate (gate:"fail-forced").
   *  Never over a serious finding or the completeness ceiling. */
  forceDeliver?: boolean;
  /**
   * COMPLETENESS CEILING. The gate judges QUALITY, not completeness: it reads
   * the files that exist and says whether they are good, never whether they are
   * all of them. For a run that was interrupted that distinction decides
   * everything — half of a book can be excellent prose.
   *
   * When this is set, a full `delivered` becomes reachable ONLY through a
   * PASSING manifest verification (verify-deliverable.ts, the one completeness
   * proof the system has: promised paths vs disk truth). Without one the best
   * outcome is what `mode` says: withheld (default) or delivered with
   * reservations. It is a cap on the OUTCOME, not a second pipeline:
   * verification and the gate run exactly as they always do.
   * deliverAfterRuntimeError sets `{ mode: "reservations" }` when the caller
   * passes none.
   */
  completenessCeiling?: CompletenessCeiling | null;
  /** produces[] slugs for the judge's rubric selector (optional). */
  produces?: string[];
  config: HarnessConfig;
  ledger?: DeliveryLedger | null;
  /** Audit emitter (dispatch.ts passes its replay-aware facade). */
  audit: (event: string, payload: Record<string, any>) => void;
  /** Post-gate hook, called ONLY when delivery will proceed. dispatch.ts hangs
   * the PDF/HTML/zip steps here. A throw is reported, never fatal: the
   * publication is not the deliverable. */
  afterGate?: (ctx: { gateOutcome: GateOutcome | "fail-forced" | "fail-accepted"; produced: string[] }) => { zipPath?: string | null } | void;
  /** Called whenever a revision run rotates the session id. */
  onSession?: (sessionId: string) => void;
  // ── test seams ──
  runHeadlessImpl?: typeof runHeadless;
  verifyScript?: string;
  gateScript?: string;
  log?: (line: string) => void;
  warn?: (line: string) => void;
}

export interface DeliveryResult {
  exitCode: DeliveryExitCode;
  /** True for `delivered` and `delivered_with_reservations`. */
  delivered: boolean;
  state: DeliveryState;
  gateOutcome: GateOutcome | "fail-forced" | "fail-accepted";
  produced: string[];
  gatedFiles: string[];
  revisionsUsed: number;
  sessionId: string | null;
  zipPath: string | null;
  verifySource: "manifest" | "acceptance" | "scan";
  /** Reason string when the completeness ceiling capped an otherwise
   * deliverable outcome; null when no cap bound the result. */
  ceilingApplied: string | null;
  /** The serious findings left at the end (empty unless withheld for them). */
  serious: string[];
  /** `_QA-RESERVATIONS.md` when one sits beside the deliverables, else null. */
  reservations: string | null;
}

/** What `<outputsRoot>/_STATUS.json` holds. */
export interface DeliveryStatus {
  state: DeliveryState;
  gate: "pass" | "fail" | "skipped";
  serious: string[];
  reservations: string | null;
  exit_code: DeliveryExitCode;
}

export const STATUS_FILE = "_STATUS.json";

export function writeDeliveryStatus(outputsRoot: string, status: DeliveryStatus): void {
  try {
    fs.mkdirSync(outputsRoot, { recursive: true });
    fs.writeFileSync(path.join(outputsRoot, STATUS_FILE), JSON.stringify(status, null, 2) + "\n", "utf8");
  } catch { /* an unwritable outputs root: the returned result carries the same fields */ }
}

const SKILLS_DEFAULT = (() => {
  // Mirrored tree: this file lives in harness/lib, so skills/ is two up.
  return path.resolve(path.join(import.meta.dir, "..", ".."));
})();

function ledgerTry<T>(fn: () => T, warn: (m: string) => void): T | null {
  try { return fn(); } catch (e) { warn(`[run-ledger] ${(e as Error)?.message ?? e}`); return null; }
}

/** Append a block to `_QA-RESERVATIONS.md`, keeping what is already there:
 *  the solo review, the producer or an earlier round may have written to it,
 *  and a reader handed only the newest note concludes the others never happened. */
function appendReservations(outputsRoot: string, block: string): string | null {
  const file = path.join(outputsRoot, "_QA-RESERVATIONS.md");
  let existing = "";
  try { existing = fs.readFileSync(file, "utf8").trim(); } catch { /* none yet */ }
  try {
    fs.writeFileSync(file, existing ? `${existing}\n\n---\n\n${block}` : block, "utf8");
    return file;
  } catch { return null; }
}

export function runDelivery(args: DeliveryArgs): DeliveryResult {
  const log = args.log ?? ((l: string) => console.log(l));
  const warn = args.warn ?? ((l: string) => console.error(l));
  const runHeadlessImpl = args.runHeadlessImpl ?? runHeadless;
  const verifyScript = args.verifyScript ?? path.join(SKILLS_DEFAULT, "businesses", "scripts", "verify-deliverable.ts");
  const gateScript = args.gateScript ?? path.join(SKILLS_DEFAULT, "harness", "scripts", "quality-gate.ts");
  // Retry ceiling (owner policy, 2026-08-21): a QA loop must terminate. It has
  // ONE home — `quality_gate.max_revisions`, default 2. The scripted callers
  // pass that setting (dispatch.ts, revise.ts); `NIRVANA_MAX_GATE_RETRIES`
  // still overrides, and an explicit args.maxRevisions always wins — the
  // unattended sweep passes 0 on purpose.
  const envCap = Number.parseInt(process.env.NIRVANA_MAX_GATE_RETRIES ?? "", 10);
  const settingCap = (() => {
    try { return Number(resolveSetting("quality_gate.max_revisions").value); }
    catch { return 2; }
  })();
  const maxRevisions = args.maxRevisions
    ?? (Number.isFinite(envCap) && envCap >= 0 ? envCap : (Number.isFinite(settingCap) && settingCap >= 0 ? settingCap : 2));
  const seriousExtra = args.seriousExtraRounds ?? (maxRevisions > 0 ? SERIOUS_EXTRA_ROUNDS : 0);
  const led = args.ledger ?? null;
  const mark = (state: runLedger.RunState, extra?: runLedger.MarkStateExtra) => {
    if (!led) return;
    ledgerTry(() => {
      // Already there (deliverAfterRuntimeError walks an errored run straight
      // into verification): keep what is new instead of a same-state throw.
      const row = runLedger.getRun(led.handle, led.runId);
      if (row?.state === state) { if (extra?.metaPatch) runLedger.patchMeta(led.handle, led.runId, extra.metaPatch); return; }
      runLedger.markState(led.handle, led.runId, state, extra ?? {});
    }, warn);
  };
  const renew = (seconds: number) => {
    if (led) ledgerTry(() => runLedger.renewLease(led.handle, led.runId, seconds, "delivery-pipeline"), warn);
  };
  // The worker has ended: its pid is history. Left on the row, a reader that
  // finds it dead while the gate still runs calls a live delivery "killed".
  const workerEnded = () => {
    if (led) ledgerTry(() => runLedger.clearChildPid(led.handle, led.runId), warn);
  };
  // quality-gate.ts and verify-deliverable.ts each anchor their audit on the artifact they
  // were handed. With an outputs root outside the project tree that walk finds no project and
  // lands in `~/.harness-logs`, which is how one trace's `gate_passed` ended up in a different
  // file from its own `dispatch_squad`. The run already knows which project it belongs to, so
  // it says so — an explicit HARNESS_LOGS_DIR the caller can still override.
  const gateEnv = {
    NIRVANA_TRACE_ID: args.pid,
    NIRVANA_PROJECT_ID: args.pid,
    // Resolved from the project root the same way the dispatch resolves its own — walking up
    // from it — so the two answers cannot disagree even when the root carries no marker.
    HARNESS_LOGS_DIR: harnessLogsDir({ cwd: args.projectRoot }),
    ...(args.slug ? { NIRVANA_BUSINESS_SLUG: args.slug } : {}),
  };
  let sessionId: string | null = args.sessionId ?? null;
  // Local alias named `emit` so check-audit-parity's literal scan sees the
  // events this pipeline emits.
  const emit = args.audit;

  const namedInBrief = briefNamedFiles(args.brief);
  let verifySource: DeliveryResult["verifySource"] = "scan";
  let produced: string[] = [];
  let gatedFiles: string[] = [];
  let revUsed = 0;
  let gateRan = false;
  const reservationsOnDisk = (): string | null => {
    const file = path.join(args.outputsRoot, "_QA-RESERVATIONS.md");
    return fs.existsSync(file) ? file : null;
  };
  /** Every exit goes through here: the result, and `_STATUS.json` beside the work. */
  const finish = (r: {
    exitCode: DeliveryExitCode; state: DeliveryState; gateOutcome: DeliveryResult["gateOutcome"];
    serious?: string[]; reservations?: string | null; zipPath?: string | null; ceilingApplied?: string | null;
  }): DeliveryResult => {
    const res: DeliveryResult = {
      exitCode: r.exitCode, delivered: r.state === "delivered" || r.state === "delivered_with_reservations",
      state: r.state, gateOutcome: r.gateOutcome, produced, gatedFiles, revisionsUsed: revUsed, sessionId,
      zipPath: r.zipPath ?? null, verifySource, ceilingApplied: r.ceilingApplied ?? null,
      serious: r.serious ?? [], reservations: r.reservations ?? null,
    };
    writeDeliveryStatus(args.outputsRoot, {
      state: res.state,
      gate: !gateRan ? "skipped" : r.gateOutcome === "pass" ? "pass" : "fail",
      serious: res.serious, reservations: res.reservations, exit_code: res.exitCode,
    });
    return res;
  };

  // ── Step: verify ───────────────────────────────────────────────────────
  mark("verifying");
  workerEnded();
  renew(GATE_LEASE_SEC);
  let manifestVerified = false;

  const promisedSource: "manifest" | "acceptance" | null = args.slug ? (args.manifest ? "manifest" : args.acceptancePromisesPaths ? "acceptance" : null) : null;
  if (promisedSource) {
    // Promised-paths path: verify-deliverable.ts owns the disk-truth check and its
    // exit code is honored (0 pass · 1 fail · 2 indeterminate → fall back to
    // the scan below). It emits verify_passed/verify_failed itself. The promise comes
    // from the run's manifest, or — with no manifest — from the roles' acceptance[].
    const v = spawnSync("bun", [verifyScript, args.pid, args.slug!, "--outputs-root", args.outputsRoot], {
      windowsHide: true,
      encoding: "utf8",
      cwd: args.workingDir ?? process.cwd(),
      env: { ...process.env, ...gateEnv },
    });
    if (v.status === 0) {
      verifySource = promisedSource;
      manifestVerified = true;
      log(`  verify (${promisedSource}): PASS`);
    } else if (v.status === 1) {
      warn(`  verify (${promisedSource}): FAIL — deliverables missing or stubbed`);
      warn((v.stdout || v.stderr || "").trim().slice(0, 800));
      verifySource = promisedSource;
      mark("failed", { error: "verify-deliverable: FAIL" });
      return finish({ exitCode: 1, state: "failed", gateOutcome: "indeterminate" });
    } else {
      // exit 2 (indeterminate: no promised paths on either side) or spawn error → scan.
      warn(`  verify (${promisedSource}): indeterminate (rc=${v.status}) — falling back to output scan`);
    }
  }

  // The work, never the run's own bookkeeping: a worker that wrote only its
  // summary, its claims or its scratch folder delivered nothing.
  const nonStub = listFiles(args.outputsRoot).filter(f => isDeliverable(f, namedInBrief));
  produced = nonStub.filter(f => !isRunStateFile(path.relative(args.outputsRoot, f)));
  if (produced.length === 0 && !manifestVerified) {
    const onlyState = nonStub.length > 0;
    warn(onlyState
      ? `  verify: only run state under ${args.outputsRoot} (summary, claims, scratch): that is not a delivery`
      : `  verify: no non-stub deliverable under ${args.outputsRoot}`);
    emit("verify_failed", { trace_id: args.pid, project_id: args.pid, business_slug: args.slug, outputs_root: args.outputsRoot, ...(onlyState ? { reason: "only run state" } : {}) });
    mark("failed", { error: onlyState ? "verify: only run state, no deliverable" : "verify: no non-stub deliverable" });
    return finish({ exitCode: 1, state: "failed", gateOutcome: "indeterminate" });
  }
  if (!manifestVerified) {
    log(`  verify: ${produced.length} file(s) delivered`);
    emit("verify_passed", { trace_id: args.pid, project_id: args.pid, business_slug: args.slug, files: produced.length });
  }

  // ── Step: quality gate (ALL gateable artifacts) ────────────────────────
  // quality_gate.judge_enabled: "reports" (default) judges the text
  // deliverables, the reports and research the offline heuristics cannot hold
  // to the brief; true judges every gateable file; false none. The judge runs
  // on the session's runtime (judge.ts); without a runtime the gate stays on
  // the heuristics, and secret-leak and the validity rubrics run either way.
  const scope = judgeScope(args.config.quality_gate.judge_enabled);
  const judgeMode = scope !== "off" && runtimeAvailable(args.runtime);
  // The judge grades against the brief (JudgeInput.brief). It lives in the
  // run's workspace, beside HANDOFF.json, never among the deliverables.
  let briefFile: string | undefined;
  if (judgeMode && args.brief?.trim()) {
    briefFile = path.join(args.projectDir, "gate-brief.md");
    try { fs.writeFileSync(briefFile, args.brief, "utf8"); } catch { briefFile = undefined; }
  }
  const gateOpts: GateRunOpts = {
    gateScript, offline: !judgeMode, produces: args.produces, briefFile, env: gateEnv,
    beforeFile: () => renew(GATE_LEASE_SEC),
    ...(judgeMode && scope === "reports" ? { judgeExts: REPORT_EXTS } : {}),
  };
  if (!judgeMode) log(`  gate mode: offline heuristics${scope === "off" ? " (quality_gate.judge_enabled=false)" : ` (no ${args.runtime} runtime for the judge)`}`);
  else if (scope === "reports") log(`  gate mode: LLM judge on text deliverables (${[...REPORT_EXTS].join(", ")}) on the session's runtime; heuristics for the rest`);
  else log("  gate mode: LLM judge on every gateable file, on the session's runtime");

  gatedFiles = gateableFiles(args.outputsRoot, namedInBrief);

  if (gatedFiles.length === 0) {
    // Zero gateable files: nothing was judged, so claiming gate_passed OR
    // delivered would be fiction. Fail-closed policy (Phase 4): withhold,
    // exit 3, human decides. Ledger reaches a TERMINAL state (withheld with
    // gate:"indeterminate") so the supervisor never re-dispatches a finished
    // run.
    warn("  gate: no gateable artifacts among the deliverables — outcome INDETERMINATE (no gate_passed, no delivered)");
    emit("x_gate_skipped_no_files", { trace_id: args.pid, project_id: args.pid, business_slug: args.slug, files: 0 });
    mark("gated", { metaPatch: { gate: "indeterminate", revisions: 0 } });
    mark("withheld", { metaPatch: { gate: "indeterminate", files: produced.length } });
    return finish({ exitCode: 3, state: "indeterminate", gateOutcome: "indeterminate", reservations: reservationsOnDisk() });
  }

  // The claims check (rule A): a business worker proves each blocking "Done
  // when" criterion with a claim whose evidence names a file on disk. Cheap,
  // no model, and the one completeness signal a run with no manifest has.
  const criteria = (args.claimsCheck ?? args.targetKind === "business") ? criteriaFromBrief(args.brief) : [];
  interface Evaluation { files: string[]; run: GateRun; claims: ClaimProblem[]; serious: string[]; pass: boolean }
  const evaluate = (): Evaluation => {
    const files = gateableFiles(args.outputsRoot, namedInBrief);
    const run = runGateOnce(files, gateOpts);
    const claims = criteria.length ? claimProblems(args.outputsRoot, criteria) : [];
    const serious = [
      ...seriousGateFindings(run, args.outputsRoot),
      ...claims.map(c => `blocking criterion ${c.id} (${c.description}): ${c.why}`),
    ];
    return { files, run, claims, serious, pass: run.pass && claims.length === 0 };
  };

  let ev = evaluate();
  gateRan = true;
  const solo = args.producerRole === "solo";
  while (!ev.pass) {
    // A serious finding keeps being corrected past the normal limit, up to
    // `seriousExtra` more rounds; the limit is read again every round, so a
    // round that clears the serious part falls back to the normal one.
    const limit = ev.serious.length ? maxRevisions + seriousExtra : maxRevisions;
    if (revUsed >= limit) break;
    revUsed++;
    warn(`  gate FAIL — auto-revision ${revUsed}/${limit}${ev.serious.length ? ` (${ev.serious.length} serious finding(s))` : ""}`);
    // Full paths and the outputs root: a round that has to start cold (below)
    // has no conversation to recover them from.
    const fixLines = [
      ...ev.run.fails.flatMap(fl => [`File ${path.resolve(fl.file)}:`, ...fl.fixes.map(x => `  - ${x}`)]),
      ...(ev.claims.length
        ? ["Blocking criteria of the brief with no proof in _CLAIMS.json:", ...ev.claims.map(c => `  - ${c.id} (${c.description}): ${c.why}`)]
        : []),
    ];
    const fixPrompt = [
      "The quality gate rejected the deliverables. Fix EXACTLY these points, rewriting the files at the same path:",
      "",
      ...fixLines,
      "",
      `The deliverables are in ${path.resolve(args.outputsRoot)}.`,
      ...(ev.claims.length
        ? [`Each blocking criterion needs an entry in _CLAIMS.json, {"id": "<id>", "evidence": "<file>:<lines>, <what it shows>"}, whose file exists under ${path.resolve(args.outputsRoot)}.`]
        : []),
      ...(solo ? ["Then update _SUMMARY.md and _CLAIMS.json wherever what they say changed."] : []),
      "Hyphen rule (the most common failure): use '-' only for compound words; never to join clauses or as a dash. Replace it with a comma, a colon or a period.",
      scopeGuard(),
      "Do not print a summary: deliver the corrected files.",
    ].join("\n");
    // A business is one solo worker: its correction runs as that worker, with
    // the directive that keeps it from dispatching, never the generic one.
    const directive = solo ? soloDirective(args.rulesDirective ?? "") : AUTONOMOUS_DIRECTIVE + (args.rulesDirective ?? "");
    const revise = (resume: string | undefined, prompt: string) => runHeadlessImpl({
      runtime: args.runtime, prompt, cwd: args.projectRoot, addDirs: [args.projectDir, args.outputsRoot],
      sessionId: resume,
      appendSystemPrompt: directive,
      maxBudgetUsd: args.maxBudgetUsd, timeoutMs: args.timeoutMs, yolo: args.yolo,
      ...(args.producerRole ? { dispatchRole: args.producerRole } : {}),
      label: `revision ${revUsed}`,
      // The producer's run folder, which is also where its session lives: a
      // runtime that keys sessions by directory resumes only from there.
      workspace: runFolderOf(args.projectDir, args.projectRoot) ?? undefined,
      ...(led ? { ledger: { runId: led.runId, watchDir: args.outputsRoot } } : {}),
    });
    let rr = revise(sessionId || undefined, fixPrompt);
    let coldRetry = false;
    if (!rr.ok && sessionId) {
      // The session could not be resumed (expired, pruned, another runtime).
      // Without a second try the gate re-ran on unchanged files and the round
      // was spent; a cold run gets the brief the resumed one would have had.
      coldRetry = true;
      warn(`  revision ${revUsed}: the session did not resume — retrying cold`);
      rr = revise(undefined, [fixPrompt, "", "The brief these deliverables answer:", args.brief].join("\n"));
    }
    emit("revision_auto", { trace_id: args.pid, project_id: args.pid, business_slug: args.slug, attempt: revUsed, ok: rr.ok, ...(coldRetry ? { cold_retry: true } : {}), ...(ev.serious.length ? { serious: ev.serious.length } : {}) });
    if (rr.sessionId) {
      sessionId = rr.sessionId;
      args.onSession?.(rr.sessionId);
      if (led) ledgerTry(() => runLedger.recordSession(led.handle, led.runId, rr.sessionId), warn);
    }
    workerEnded();
    ev = evaluate();
  }
  gatedFiles = ev.files;

  const gateOutcome = decideGateOutcome(ev.files, ev.pass);
  const mode = gateModeOf(ev.run);
  const judgedFiles = Object.values(ev.run.modes).filter(m => m === "judge").length;
  mark("gated", { metaPatch: { gate: gateOutcome, revisions: revUsed } });
  const serious = [
    ...ev.serious,
    ...(args.reviewBlockingMissed ?? []).map(id => `review: blocking criterion ${id} was not confirmed`),
  ];
  // The completeness ceiling binds ONLY when the manifest did not prove the
  // deliverable set complete.
  const ceiling = args.completenessCeiling && !manifestVerified ? args.completenessCeiling : null;
  const ceilingWithholds = !!ceiling && (ceiling.mode ?? "withhold") === "withhold";

  if (gateOutcome === "pass") {
    log(`  gate PASS (${ev.files.length} file(s)${revUsed ? `, after ${revUsed} revision(s)` : ""}, ${mode} mode)`);
    emit("gate_passed", { trace_id: args.pid, project_id: args.pid, business_slug: args.slug, files: ev.files.length, revisions: revUsed, mode, judged_files: judgedFiles });
  } else {
    emit("gate_failed", { trace_id: args.pid, project_id: args.pid, business_slug: args.slug, files: ev.files.length, revisions: revUsed, mode, judged_files: judgedFiles, serious: ev.serious.length });
  }

  const withhold = (verdict: DeliveryResult["gateOutcome"], why: { ceiling?: string; serious?: string[] }): DeliveryResult => {
    emit("x_delivery_withheld", {
      trace_id: args.pid, project_id: args.pid, business_slug: args.slug,
      files: produced.length, gated_files: ev.files.length, revisions: revUsed,
      outputs_root: args.outputsRoot, gate: verdict,
      ceiling: why.ceiling ? "completeness" : null, ceiling_reason: why.ceiling ?? null,
      ...(why.serious?.length ? { serious: why.serious } : {}),
    });
    mark("withheld", {
      metaPatch: {
        gate: verdict, files: produced.length, revisions: revUsed,
        ...(why.ceiling ? { ceiling: "completeness", ceiling_reason: why.ceiling } : {}),
        ...(why.serious?.length ? { serious: why.serious } : {}),
      },
    });
    return finish({ exitCode: 2, state: "withheld", gateOutcome: verdict, serious: why.serious, ceilingApplied: why.ceiling ?? null, reservations: reservationsOnDisk() });
  };
  const withholdByCeiling = (reason: string, verdict: DeliveryResult["gateOutcome"]): DeliveryResult => {
    warn(`  delivery WITHHELD by the completeness ceiling: the gate (${verdict}) judges the QUALITY of what exists, not whether the set is complete, and no verified manifest proves that. The artifacts stay in ${args.outputsRoot}; a human decides.`);
    return withhold(verdict, { ceiling: reason });
  };
  const deliver = (verdict: DeliveryResult["gateOutcome"], blocks: string[], ceilingApplied: string | null): DeliveryResult => {
    let reservations: string | null = null;
    for (const block of blocks) reservations = appendReservations(args.outputsRoot, block) ?? reservations;
    if (blocks.length) {
      emit("x_delivered_with_reservations", {
        trace_id: args.pid, project_id: args.pid, business_slug: args.slug,
        files: produced.length, gated_files: ev.files.length, revisions: revUsed, ceiling: maxRevisions,
        ...(ceilingApplied ? { completeness_ceiling: ceilingApplied } : {}),
      });
    }
    // Publication (PDF, HTML, zip) can run an agent of its own: the run keeps
    // its lease through it, and a publication that throws is reported, not fatal.
    renew(PUBLISH_LEASE_SEC);
    let hook: ReturnType<NonNullable<DeliveryArgs["afterGate"]>> | undefined;
    try { hook = args.afterGate?.({ gateOutcome: verdict, produced }); }
    catch (e) {
      const error = (e as Error)?.message ?? String(e);
      warn(`  ⚠ publication after the gate failed: ${error} (the deliverables are in ${args.outputsRoot})`);
      emit("x_after_gate_failed", { trace_id: args.pid, project_id: args.pid, business_slug: args.slug, error });
    }
    const zipPath = hook && typeof hook === "object" ? hook.zipPath ?? null : null;
    const withReservations = blocks.length > 0;
    emit("delivered", { trace_id: args.pid, project_id: args.pid, business_slug: args.slug, files: produced.length, gate: verdict, zip: zipPath, ...(withReservations ? { reservations: true } : {}) });
    mark("delivered", {
      metaPatch: {
        gate: verdict, files: produced.length, zip: zipPath, revisions: revUsed,
        ...(withReservations ? { reservations: true } : {}),
        ...(ceilingApplied ? { ceiling: "completeness", ceiling_reason: ceilingApplied } : {}),
      },
    });
    return finish({
      exitCode: 0, state: withReservations ? "delivered_with_reservations" : "delivered", gateOutcome: verdict,
      zipPath, reservations: reservations ?? (withReservations ? reservationsOnDisk() : null), ceilingApplied,
    });
  };
  const incompleteBlock = (reason: string): string => [
    "# QA reservations — the set may be incomplete",
    "",
    `Delivered with reservations: ${reason}.`,
    "The quality gate judges the files that exist, not whether they are all of them. Check the deliverables against the brief before relying on them as the whole.",
    "",
  ].join("\n");

  if (gateOutcome === "pass" && serious.length === 0) {
    if (ceiling && ceilingWithholds) return withholdByCeiling(ceiling.reason, "pass");
    return deliver("pass", ceiling ? [incompleteBlock(ceiling.reason)] : [], ceiling?.reason ?? null);
  }

  if (serious.length) {
    // Rule A: what is still serious after the extended corrections never ships.
    warn(`  ${serious.length} SERIOUS finding(s) left after ${revUsed} correction round(s) — delivery WITHHELD (artifacts stay at ${args.outputsRoot}):`);
    for (const s of serious) warn(`    - ${s}`);
    if (args.forceDeliver) warn("  --force-deliver overrides a quality verdict, never a serious finding.");
    return withhold(gateOutcome === "pass" ? "pass" : "fail", { serious });
  }

  if (args.forceDeliver) {
    // The ceiling outranks --force-deliver: that flag overrides a QUALITY
    // verdict, and completeness is not a quality verdict.
    if (ceiling && ceilingWithholds) return withholdByCeiling(ceiling.reason, "fail-forced");
    warn(`  gate still FAIL after ${revUsed} revision(s) — DELIVERING ANYWAY (--force-deliver, gate:"fail-forced")`);
    return deliver("fail-forced", ceiling ? [incompleteBlock(ceiling.reason)] : [], ceiling?.reason ?? null);
  }

  if ((args.gateExhaustedPolicy ?? "accept") === "withhold") {
    // Strict on request (an unattended caller): withhold. No `delivered`, exit 2.
    warn(`  gate still FAIL after ${revUsed} revision(s) — delivery WITHHELD (artifacts stay at ${args.outputsRoot}; use 'nrv revise ${args.pid} "<fix>"' or --force-deliver)`);
    return withhold("fail", {});
  }

  // Rule A: nothing serious is left, so the last attempt ships WITH
  // RESERVATIONS — a QA loop ends in a delivery, not a stall. Loudly:
  // _QA-RESERVATIONS.md names what the gate still flags (and that the QA
  // judgement itself may be wrong), the audit carries
  // x_delivered_with_reservations, the ledger meta records it. The
  // completeness ceiling still outranks: reservations cover a QUALITY verdict,
  // never a missing deliverable.
  if (ceiling && ceilingWithholds) return withholdByCeiling(ceiling.reason, "fail-accepted");
  const gateBlock = [
    "# QA reservations — delivered after the gate retry ceiling",
    "",
    `The quality gate still failed after ${revUsed} revision attempt(s) (limit ${maxRevisions}, quality_gate.max_revisions).`,
    "Nothing it flags is serious (no leaked secret, no invalid file, no material defect, no unproven blocking criterion), so the last attempt was delivered WITH RESERVATIONS instead of looping or withholding.",
    "",
    "What the gate still flags — judge these points yourself; the QA verdict can also be the wrong side (over-strict rubric, contract mismatch):",
    "",
    ...ev.run.fails.flatMap(fl => [`- ${path.basename(fl.file)}:`, ...fl.fixes.map(x => `  - ${x}`)]),
    "",
    `Iterate deliberately: nrv revise ${args.pid} "<fix instruction>"`,
    "",
  ].join("\n");
  warn(`  gate still FAIL after ${revUsed} revision(s), nothing serious — ACCEPTED WITH RESERVATIONS (_QA-RESERVATIONS.md)`);
  return deliver("fail-accepted", [...(ceiling ? [incompleteBlock(ceiling.reason)] : []), gateBlock], ceiling?.reason ?? null);
}

// ── runtime-error salvage ─────────────────────────────────────────────────

export interface RuntimeErrorArgs extends DeliveryArgs {
  /** The runtime's error verdict (host-agent-driver `error` / stderr). */
  runtimeError: string;
  /** Identity fields for the x_ event (squad_slug, employee, …). */
  errorContext?: Record<string, any>;
}

export interface RuntimeErrorOutcome {
  /** true when artifacts existed and the delivery pipeline ran over them. */
  judged: boolean;
  candidates: number;
  /** 1 when there was nothing to judge; otherwise the pipeline's own code
   * (0 delivered · 2 withheld · 3 indeterminate). */
  exitCode: DeliveryExitCode;
  result: DeliveryResult | null;
}

/**
 * Policy for a dispatched run whose runtime came back not-ok (a crash, a
 * timeout, a usage or turn limit).
 *
 * A runtime error is not proof that nothing was produced: the common case is a
 * limit hit at the very END of a long run, after the deliverables were already
 * written. Abandoning those files is exactly the failure Phase 4 exists to
 * prevent — unjudged artifacts sitting on disk, with no verify, no gate and no
 * delivered/withheld decision. Delivering them as a full pass is the opposite
 * failure: the worker never said it was done.
 *
 * So, with nothing on disk (run state does not count), the ledger row is
 * marked `failed` with the runtime's verdict. With artifacts, the row goes
 * STRAIGHT into verification carrying that verdict (last_error, and
 * meta.runtime_errored to the terminal row) — never through a transient
 * `failed`, which a waiter reads as final — and the run recovers into the SAME
 * delivery pipeline under a completeness ceiling: a serious finding is
 * withheld, anything else ships WITH RESERVATIONS naming the error, and only a
 * passing manifest verification lifts the cap. A caller may pass its own
 * `completenessCeiling`.
 */
export function deliverAfterRuntimeError(args: RuntimeErrorArgs): RuntimeErrorOutcome {
  const warn = args.warn ?? ((l: string) => console.error(l));
  const led = args.ledger ?? null;
  const candidates = candidateArtifacts(args.outputsRoot, args.brief);
  if (led) {
    ledgerTry(() => {
      if (candidates.length === 0) {
        runLedger.markState(led.handle, led.runId, "failed", { error: args.runtimeError, metaPatch: { runtime_errored: true } });
        return;
      }
      if (runLedger.getRun(led.handle, led.runId)?.state === "dispatched") runLedger.markState(led.handle, led.runId, "running");
      runLedger.markState(led.handle, led.runId, "verifying", { error: args.runtimeError, metaPatch: { runtime_errored: true } });
    }, warn);
  }

  if (candidates.length === 0) {
    writeDeliveryStatus(args.outputsRoot, { state: "failed", gate: "skipped", serious: [], reservations: null, exit_code: 1 });
    return { judged: false, candidates: 0, exitCode: 1, result: null };
  }

  warn(`  ⚠ the runtime reported an error (${args.runtimeError}) AFTER producing ${candidates.length} file(s).`);
  warn("    The artifacts are NOT abandoned: they go on to verification and the quality gate. A serious finding withholds them; otherwise they ship with reservations naming the error, never as a full pass.");
  args.audit("x_runtime_errored_with_artifacts", {
    trace_id: args.pid, project_id: args.pid, business_slug: args.slug,
    ...(args.errorContext ?? {}),
    target_kind: args.targetKind, runtime: args.runtime,
    error: args.runtimeError, candidates: candidates.length,
    outputs_root: args.outputsRoot,
  });

  const completenessCeiling = args.completenessCeiling ?? {
    reason: `the worker ended with a runtime error (${args.runtimeError.slice(0, 200)}), so nothing proves the set it left is complete`,
    mode: "reservations" as const,
  };
  const result = runDelivery({ ...args, completenessCeiling });
  return { judged: true, candidates: candidates.length, exitCode: result.exitCode, result };
}
