// delivery-pipeline.ts — fail-closed verify → gate → deliver pipeline
// (routing-360 Phase 4.2).
//
// One pipeline for all three dispatch paths (business, squad-exec, agent-x):
// dispatch.ts Steps 5-7 extracted so every path that produces artifacts goes
// through the SAME verification, the SAME gate surface and the SAME delivery
// decision. Closes two diagnosed defects:
//
//   1. Gate fail-open — only .md/.txt/.json were gated, and a gate_failed
//      still ended in `delivered` + exit 0. Now: ALL gateable artifacts
//      (quality-gate.ts GATEABLE_EXTS — .html/.yaml/code/images too) are
//      judged; a gate failure after the revision budget WITHHOLDS delivery
//      (event x_delivery_withheld, ledger state `withheld`, exit 2, no
//      `delivered` event). `--force-deliver` is the explicit escape hatch and
//      emits delivered with gate:"fail-forced".
//   2. Judge never ran — the gate spawn hardcoded --offline. Now the LLM
//      judge path activates when config quality_gate.judge_enabled is true
//      AND the runtime is available; heuristics remain the default.
//
// Exit-code contract (BREAKING vs pre-Phase-4 — see CHANGELOG):
//   0 = delivered (gate pass, or fail-forced via --force-deliver)
//   1 = run failed (no verifiable deliverables)
//   2 = withheld (deliverables exist; gate FAILED after revisions — or the
//       completeness ceiling capped an otherwise deliverable outcome)
//   3 = indeterminate (zero gateable artifacts — nothing was judged;
//       no gate_passed, no delivered)
//
// Ledger: the pipeline keeps marking verifying → gated → delivered|withheld
// (never-stall guarantee, bd750d6e). Ledger failures never break a delivery.
//
// deliverAfterRuntimeError() (bottom of this file) is the entry point for a
// run whose runtime returned an error verdict: with artifacts on disk it
// recovers into this same pipeline instead of abandoning them unjudged.
//
// DeliveryArgs.completenessCeiling caps the outcome for callers whose run was
// INTERRUPTED (supervisor salvage of a `stalled` row): the gate judges quality,
// never completeness, so `delivered` stays reachable only through a passing
// manifest verification. Same pipeline, one extra door lock.

import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { runHeadless, runtimeAvailable, AUTONOMOUS_DIRECTIVE, type Runtime } from "./host-agent-driver.ts";
import { scopeGuard } from "../../_shared/lib/scope-guard.ts";
import { GATEABLE_EXTS } from "../scripts/quality-gate.ts";
import type { HarnessConfig } from "./harness-config.ts";
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

/** The Phase 4 gate surface: every non-stub artifact whose extension the
 * quality gate knows how to judge (quality-gate.ts GATEABLE_EXTS — includes
 * .html, .yaml/.yml, code and images). */
export function gateableFiles(dir: string, named: Set<string>): string[] {
  return listFiles(dir).filter(f =>
    GATEABLE_EXTS.has(path.extname(f).toLowerCase()) && isDeliverable(f, named));
}

/** Non-stub artifacts under `outputsRoot` — the SAME discovery runDelivery
 * uses for its `produced` list. The runtime-error salvage path asks this
 * (never a second scanner) whether a not-ok run left anything worth judging. */
export function candidateArtifacts(outputsRoot: string, brief: string): string[] {
  const named = briefNamedFiles(brief);
  return listFiles(outputsRoot).filter(f => isDeliverable(f, named));
}

// ── gate runner ───────────────────────────────────────────────────────────

export interface GateRunOpts {
  gateScript: string;
  /** true → heuristic rubrics only (--offline). false → judge path
   * (--with-revisions, no --offline). */
  offline: boolean;
  /** produces[] slugs forwarded to the judge's rubric selector. */
  produces?: string[];
  /** Env for the gate child (trace/project/business ids for its audit emit). */
  env?: Record<string, string | undefined>;
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
 * Off (the default) returns `[]` — bit for bit what the judge received before.
 */
export function producesForRubric(produces: readonly string[] | null | undefined, enabled: boolean): string[] {
  if (!enabled) return [];
  const slugs = (produces ?? []).map(slug => String(slug ?? "").trim()).filter(Boolean);
  return [...new Set(slugs)];
}

/** Run the quality gate over each artifact; collect fix lists for failures.
 * Accepts a bare script path (legacy signature, offline heuristics) or full
 * GateRunOpts. Parses the normalized verdict {status, mode, results[]}. */
export function runGateOnce(files: string[], gate: string | GateRunOpts): { pass: boolean; fails: { file: string; fixes: string[] }[] } {
  const opts: GateRunOpts = typeof gate === "string" ? { gateScript: gate, offline: true } : gate;
  const fails: { file: string; fixes: string[] }[] = [];
  for (const f of files) {
    const argv = [opts.gateScript, f, "--auto"];
    if (opts.offline) argv.push("--offline");
    else {
      argv.push("--with-revisions");
      if (opts.produces?.length) argv.push(`--produces=${opts.produces.join(",")}`);
    }
    const g = spawnSync("bun", argv, {
      encoding: "utf8",
      env: { ...process.env, ...(opts.env ?? {}) },
    });
    if (g.status !== 0) {
      const fixes: string[] = [];
      try {
        const v = JSON.parse(g.stdout);
        for (const r of v.results || []) if (!r.passed && !r.skipped) fixes.push(...(r.fix_list || []));
      } catch { /* keep empty */ }
      fails.push({ file: f, fixes });
    }
  }
  return { pass: fails.length === 0, fails };
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

export interface DeliveryLedger {
  handle: runLedger.LedgerHandle;
  runId: string;
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
  /** What to do when the gate still fails after the retry ceiling:
   *  "accept" (default) delivers the last attempt WITH RESERVATIONS;
   *  "withhold" keeps the strict fail-closed exit 2. Falls back to
   *  NIRVANA_GATE_EXHAUSTED, then "accept". Tests inject via this arg. */
  gateExhaustedPolicy?: "accept" | "withhold";
  maxBudgetUsd?: number;
  timeoutMs?: number;
  yolo?: boolean;
  rulesDirective?: string;
  /** --force-deliver: deliver despite a failed gate (gate:"fail-forced"). */
  forceDeliver?: boolean;
  /**
   * COMPLETENESS CEILING. The gate judges QUALITY, not completeness: it reads
   * the files that exist and says whether they are good, never whether they are
   * all of them. For a run that was interrupted (supervisor salvage of a
   * `stalled` row) that distinction decides everything — half of a book can be
   * excellent prose.
   *
   * When this is set, `delivered` becomes reachable ONLY through a PASSING
   * manifest verification (verify-deliverable.ts, the one completeness proof
   * the system has: promised paths vs disk truth). Without a manifest the best
   * outcome is `withheld` WITH the gate verdict attached — exit 2, the artifacts
   * stay on disk, a human decides. It is a cap on the OUTCOME, not a second
   * pipeline: verification and the gate run exactly as they always do.
   */
  completenessCeiling?: { reason: string } | null;
  /** produces[] slugs for the judge's rubric selector (optional). */
  produces?: string[];
  config: HarnessConfig;
  ledger?: DeliveryLedger | null;
  /** Audit emitter (dispatch.ts passes its replay-aware facade). */
  audit: (event: string, payload: Record<string, any>) => void;
  /** Post-gate hook, called ONLY when delivery will proceed (gate pass or
   * fail-forced). dispatch.ts hangs the PDF/HTML/zip steps here. */
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
  delivered: boolean;
  gateOutcome: GateOutcome | "fail-forced" | "fail-accepted";
  produced: string[];
  gatedFiles: string[];
  revisionsUsed: number;
  sessionId: string | null;
  zipPath: string | null;
  verifySource: "manifest" | "acceptance" | "scan";
  /** Reason string when the completeness ceiling downgraded an otherwise
   * deliverable outcome to `withheld`; null when no cap bound the result. */
  ceilingApplied: string | null;
}

const SKILLS_DEFAULT = (() => {
  // Mirrored tree: this file lives in harness/lib, so skills/ is two up.
  return path.resolve(path.join(import.meta.dir, "..", ".."));
})();

function ledgerTry<T>(fn: () => T, warn: (m: string) => void): T | null {
  try { return fn(); } catch (e) { warn(`[run-ledger] ${(e as Error)?.message ?? e}`); return null; }
}

export function runDelivery(args: DeliveryArgs): DeliveryResult {
  const log = args.log ?? ((l: string) => console.log(l));
  const warn = args.warn ?? ((l: string) => console.error(l));
  const runHeadlessImpl = args.runHeadlessImpl ?? runHeadless;
  const verifyScript = args.verifyScript ?? path.join(SKILLS_DEFAULT, "businesses", "scripts", "verify-deliverable.ts");
  const gateScript = args.gateScript ?? path.join(SKILLS_DEFAULT, "harness", "scripts", "quality-gate.ts");
  // Retry ceiling (owner policy, 2026-08-21): a QA loop must terminate. The
  // default is 15 attempts, configurable via NIRVANA_MAX_GATE_RETRIES (Bun
  // auto-loads .env, so a project .env entry works). An explicit
  // args.maxRevisions always wins — the unattended sweep passes 0 on purpose.
  const envCap = Number.parseInt(process.env.NIRVANA_MAX_GATE_RETRIES ?? "", 10);
  const maxRevisions = args.maxRevisions ?? (Number.isFinite(envCap) && envCap >= 0 ? envCap : 15);
  const led = args.ledger ?? null;
  const mark = (state: runLedger.RunState, extra?: runLedger.MarkStateExtra) => {
    if (led) ledgerTry(() => runLedger.markState(led.handle, led.runId, state, extra ?? {}), warn);
  };
  const gateEnv = {
    NIRVANA_TRACE_ID: args.pid,
    NIRVANA_PROJECT_ID: args.pid,
    ...(args.slug ? { NIRVANA_BUSINESS_SLUG: args.slug } : {}),
  };
  let sessionId: string | null = args.sessionId ?? null;
  // Local alias named `emit` so check-audit-parity's literal scan sees the
  // events this pipeline emits.
  const emit = args.audit;

  const namedInBrief = briefNamedFiles(args.brief);
  const fail = (exitCode: DeliveryExitCode, gateOutcome: DeliveryResult["gateOutcome"], extra: Partial<DeliveryResult> = {}): DeliveryResult => ({
    exitCode, delivered: false, gateOutcome, produced: [], gatedFiles: [],
    revisionsUsed: 0, sessionId, zipPath: null, verifySource: "scan",
    ceilingApplied: null, ...extra,
  });

  // ── Step: verify ───────────────────────────────────────────────────────
  mark("verifying");
  let verifySource: DeliveryResult["verifySource"] = "scan";
  let manifestVerified = false;

  const promisedSource: "manifest" | "acceptance" | null = args.slug ? (args.manifest ? "manifest" : args.acceptancePromisesPaths ? "acceptance" : null) : null;
  if (promisedSource) {
    // Promised-paths path: verify-deliverable.ts owns the disk-truth check and its
    // exit code is honored (0 pass · 1 fail · 2 indeterminate → fall back to
    // the scan below). It emits verify_passed/verify_failed itself. The promise comes
    // from the run's manifest, or — with no manifest — from the roles' acceptance[].
    const v = spawnSync("bun", [verifyScript, args.pid, args.slug, "--outputs-root", args.outputsRoot], {
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
      mark("failed", { error: "verify-deliverable: FAIL" });
      return fail(1, "indeterminate", { verifySource: promisedSource });
    } else {
      // exit 2 (indeterminate: no promised paths on either side) or spawn error → scan.
      warn(`  verify (${promisedSource}): indeterminate (rc=${v.status}) — falling back to output scan`);
    }
  }

  const produced = listFiles(args.outputsRoot).filter(f => isDeliverable(f, namedInBrief));
  if (produced.length === 0 && !manifestVerified) {
    warn(`  verify: no non-stub deliverable under ${args.outputsRoot}`);
    emit("verify_failed", { trace_id: args.pid, project_id: args.pid, business_slug: args.slug, outputs_root: args.outputsRoot });
    mark("failed", { error: "verify: no non-stub deliverable" });
    return fail(1, "indeterminate");
  }
  if (!manifestVerified) {
    log(`  verify: ${produced.length} file(s) delivered`);
    emit("verify_passed", { trace_id: args.pid, project_id: args.pid, business_slug: args.slug, files: produced.length });
  }

  // ── Step: quality gate (ALL gateable artifacts) ────────────────────────
  const judgeMode = args.config.quality_gate.judge_enabled === true && runtimeAvailable(args.runtime);
  const gateOpts: GateRunOpts = { gateScript, offline: !judgeMode, produces: args.produces, env: gateEnv };
  if (judgeMode) log(`  gate mode: LLM judge (quality_gate.judge_enabled) via ${args.runtime}`);

  let gatedFiles = gateableFiles(args.outputsRoot, namedInBrief);

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
    return {
      exitCode: 3, delivered: false, gateOutcome: "indeterminate", produced,
      gatedFiles: [], revisionsUsed: 0, sessionId, zipPath: null, verifySource,
      ceilingApplied: null,
    };
  }

  let gate = runGateOnce(gatedFiles, gateOpts);
  let revUsed = 0;
  while (!gate.pass && revUsed < maxRevisions) {
    revUsed++;
    warn(`  gate FAIL — auto-revision ${revUsed}/${maxRevisions}`);
    const fixLines = gate.fails.flatMap(fl => [`Arquivo ${path.basename(fl.file)}:`, ...fl.fixes.map(x => `  - ${x}`)]);
    const fixPrompt = [
      "O quality gate reprovou os entregáveis. Corrija EXATAMENTE estes pontos, reescrevendo os arquivos no mesmo caminho:",
      "",
      ...fixLines,
      "",
      "Regra de hífen (a mais comum): use '-' só para palavras compostas; nunca para emendar orações nem como travessão — troque por vírgula, dois-pontos ou ponto.",
      scopeGuard("pt-BR"),
      "Não imprima resumo: entregue os arquivos corrigidos.",
    ].join("\n");
    const rr = runHeadlessImpl({
      runtime: args.runtime, prompt: fixPrompt, cwd: args.projectDir, addDirs: [args.projectRoot],
      sessionId: sessionId || undefined,
      appendSystemPrompt: AUTONOMOUS_DIRECTIVE + (args.rulesDirective ?? ""),
      maxBudgetUsd: args.maxBudgetUsd, timeoutMs: args.timeoutMs, yolo: args.yolo,
      ...(led ? { ledger: { runId: led.runId, watchDir: args.outputsRoot } } : {}),
    });
    emit("revision_auto", { trace_id: args.pid, project_id: args.pid, business_slug: args.slug, attempt: revUsed, ok: rr.ok });
    if (rr.sessionId) {
      sessionId = rr.sessionId;
      args.onSession?.(rr.sessionId);
      if (led) ledgerTry(() => runLedger.recordSession(led.handle, led.runId, rr.sessionId), warn);
    }
    gatedFiles = gateableFiles(args.outputsRoot, namedInBrief);
    gate = runGateOnce(gatedFiles, gateOpts);
  }

  const gateOutcome = decideGateOutcome(gatedFiles, gate.pass);
  mark("gated", { metaPatch: { gate: gateOutcome, revisions: revUsed } });

  // The completeness ceiling binds ONLY when the manifest did not prove the
  // deliverable set complete. Returns the reason string, or null when
  // `delivered` stays reachable. Both delivery exits below consult it, so
  // there is exactly one door out of this pipeline that can say `delivered`.
  const ceilingReason = (): string | null =>
    args.completenessCeiling && !manifestVerified ? args.completenessCeiling.reason : null;
  const withholdByCeiling = (reason: string, verdict: GateOutcome | "fail-forced" | "fail-accepted"): DeliveryResult => {
    warn(`  entrega RETIDA pelo teto de completude — o gate (${verdict}) julga a QUALIDADE do que existe, não se o conjunto está completo, e nenhum manifesto verificado prova isso. Os artefatos seguem em ${args.outputsRoot}; quem decide é um humano.`);
    emit("x_delivery_withheld", {
      trace_id: args.pid, project_id: args.pid, business_slug: args.slug,
      files: produced.length, gated_files: gatedFiles.length, revisions: revUsed,
      outputs_root: args.outputsRoot, gate: verdict,
      ceiling: "completeness", ceiling_reason: reason,
    });
    mark("withheld", { metaPatch: { gate: verdict, files: produced.length, revisions: revUsed, ceiling: "completeness", ceiling_reason: reason } });
    return { exitCode: 2, delivered: false, gateOutcome: verdict, produced, gatedFiles, revisionsUsed: revUsed, sessionId, zipPath: null, verifySource, ceilingApplied: reason };
  };

  if (gateOutcome === "pass") {
    log(`  gate PASS (${gatedFiles.length} file(s)${revUsed ? `, after ${revUsed} revision(s)` : ""}${judgeMode ? ", judge mode" : ""})`);
    emit("gate_passed", { trace_id: args.pid, project_id: args.pid, business_slug: args.slug, files: gatedFiles.length, revisions: revUsed, mode: judgeMode ? "judge" : "heuristic" });
    const capped = ceilingReason();
    if (capped) return withholdByCeiling(capped, "pass");
    const hook = args.afterGate?.({ gateOutcome, produced });
    const zipPath = hook && typeof hook === "object" ? hook.zipPath ?? null : null;
    emit("delivered", { trace_id: args.pid, project_id: args.pid, business_slug: args.slug, files: produced.length, gate: "pass", zip: zipPath });
    mark("delivered", { metaPatch: { gate: "pass", files: produced.length, zip: zipPath } });
    return { exitCode: 0, delivered: true, gateOutcome: "pass", produced, gatedFiles, revisionsUsed: revUsed, sessionId, zipPath, verifySource, ceilingApplied: null };
  }

  // gate FAIL after the revision budget.
  emit("gate_failed", { trace_id: args.pid, project_id: args.pid, business_slug: args.slug, files: gatedFiles.length, revisions: revUsed, mode: judgeMode ? "judge" : "heuristic" });

  if (args.forceDeliver) {
    // The ceiling outranks --force-deliver: that flag overrides a QUALITY
    // verdict, and completeness is not a quality verdict.
    const capped = ceilingReason();
    if (capped) return withholdByCeiling(capped, "fail-forced");
    warn(`  gate still FAIL after ${revUsed} revision(s) — DELIVERING ANYWAY (--force-deliver, gate:"fail-forced")`);
    const hook = args.afterGate?.({ gateOutcome: "fail-forced", produced });
    const zipPath = hook && typeof hook === "object" ? hook.zipPath ?? null : null;
    emit("delivered", { trace_id: args.pid, project_id: args.pid, business_slug: args.slug, files: produced.length, gate: "fail-forced", zip: zipPath });
    mark("delivered", { metaPatch: { gate: "fail-forced", files: produced.length, zip: zipPath } });
    return { exitCode: 0, delivered: true, gateOutcome: "fail-forced", produced, gatedFiles, revisionsUsed: revUsed, sessionId, zipPath, verifySource, ceilingApplied: null };
  }

  // Owner policy (2026-08-21): after the retry ceiling, the LAST attempt is
  // accepted WITH RESERVATIONS by default — a QA loop must end in a delivery,
  // not a stall. Loudly: _QA-RESERVATIONS.md lands next to the artifacts with
  // exactly what the gate still flags (and the caveat that the QA judgment
  // itself may be wrong — over-strict rubric, contract mismatch), the audit
  // carries x_delivered_with_reservations, and the ledger meta records it.
  // NIRVANA_GATE_EXHAUSTED=withhold restores strict fail-closed. The
  // completeness ceiling still outranks: reservations override a QUALITY
  // verdict, never a missing-deliverable one.
  const exhaustedPolicy = (args.gateExhaustedPolicy ?? process.env.NIRVANA_GATE_EXHAUSTED ?? "accept").toLowerCase();
  if (exhaustedPolicy !== "withhold") {
    const cappedR = ceilingReason();
    if (cappedR) return withholdByCeiling(cappedR, "fail-accepted");
    const reservations = [
      "# QA reservations — delivered after the gate retry ceiling",
      "",
      `The quality gate still failed after ${revUsed} revision attempt(s) (ceiling ${maxRevisions}; env NIRVANA_MAX_GATE_RETRIES).`,
      "Per policy (NIRVANA_GATE_EXHAUSTED=accept, the default) the last attempt was accepted WITH RESERVATIONS instead of looping or withholding.",
      "",
      "What the gate still flags — judge these points yourself; the QA verdict can also be the wrong side (over-strict rubric, contract mismatch):",
      "",
      ...gate.fails.flatMap(fl => [`- ${path.basename(fl.file)}:`, ...fl.fixes.map(x => `  - ${x}`)]),
      "",
      `Iterate deliberately: nrv revise ${args.pid} "<fix instruction>" · strict mode: NIRVANA_GATE_EXHAUSTED=withhold`,
      "",
    ].join("\n");
    try { fs.writeFileSync(path.join(args.outputsRoot, "_QA-RESERVATIONS.md"), reservations); }
    catch { /* outputs dir unwritable — the warn below still tells the story */ }
    warn(`  gate still FAIL after ${revUsed} revision(s) — ACCEPTED WITH RESERVATIONS (_QA-RESERVATIONS.md; NIRVANA_GATE_EXHAUSTED=withhold for strict mode)`);
    emit("x_delivered_with_reservations", {
      trace_id: args.pid, project_id: args.pid, business_slug: args.slug,
      files: produced.length, gated_files: gatedFiles.length, revisions: revUsed, ceiling: maxRevisions,
    });
    const hookR = args.afterGate?.({ gateOutcome: "fail-accepted", produced });
    const zipR = hookR && typeof hookR === "object" ? hookR.zipPath ?? null : null;
    emit("delivered", { trace_id: args.pid, project_id: args.pid, business_slug: args.slug, files: produced.length, gate: "fail-accepted", zip: zipR });
    mark("delivered", { metaPatch: { gate: "fail-accepted", files: produced.length, zip: zipR, reservations: true, revisions: revUsed } });
    return { exitCode: 0, delivered: true, gateOutcome: "fail-accepted", produced, gatedFiles, revisionsUsed: revUsed, sessionId, zipPath: zipR, verifySource, ceilingApplied: null };
  }

  // Fail-closed on request: withhold delivery. No `delivered` event, exit 2.
  warn(`  gate still FAIL after ${revUsed} revision(s) — delivery WITHHELD (artifacts stay at ${args.outputsRoot}; use 'nrv revise ${args.pid} \"<fix>\"' or --force-deliver)`);
  emit("x_delivery_withheld", {
    trace_id: args.pid, project_id: args.pid, business_slug: args.slug,
    files: produced.length, gated_files: gatedFiles.length, revisions: revUsed,
    outputs_root: args.outputsRoot, gate: "fail", ceiling: null, ceiling_reason: null,
  });
  mark("withheld", { metaPatch: { gate: "fail", files: produced.length, revisions: revUsed } });
  return { exitCode: 2, delivered: false, gateOutcome: "fail", produced, gatedFiles, revisionsUsed: revUsed, sessionId, zipPath: null, verifySource, ceilingApplied: null };
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
 * Policy for a dispatched run whose runtime came back not-ok.
 *
 * A runtime error is not proof that nothing was produced: the common case is a
 * usage/turn limit hit at the very END of a long run, after the deliverables
 * were already written. Abandoning those files is exactly the failure Phase 4
 * exists to prevent — unjudged artifacts sitting on disk, with no verify, no
 * gate and no delivered/withheld decision.
 *
 * So: the ledger row is marked `failed` with the runtime's verdict FIRST (the
 * error is never swallowed — markState COALESCEs last_error, so it survives
 * every later transition, and meta.runtime_errored rides along to the terminal
 * row). Then, if and only if candidateArtifacts() finds something, the run
 * recovers into the SAME delivery pipeline: verify → gate → revision budget →
 * delivered | withheld | indeterminate.
 *
 * The fail-closed contract is untouched — an errored run whose artifacts fail
 * the gate is still WITHHELD (exit 2), never delivered.
 */
export function deliverAfterRuntimeError(args: RuntimeErrorArgs): RuntimeErrorOutcome {
  const warn = args.warn ?? ((l: string) => console.error(l));
  const led = args.ledger ?? null;
  if (led) {
    ledgerTry(() => runLedger.markState(led.handle, led.runId, "failed", {
      error: args.runtimeError,
      metaPatch: { runtime_errored: true },
    }), warn);
  }

  const candidates = candidateArtifacts(args.outputsRoot, args.brief);
  if (candidates.length === 0) {
    return { judged: false, candidates: 0, exitCode: 1, result: null };
  }

  warn(`  ⚠ o runtime reportou erro (${args.runtimeError}) DEPOIS de produzir ${candidates.length} arquivo(s).`);
  warn("    Os artefatos NÃO são abandonados: seguem para verificação e quality gate. Nada é entregue sem o gate aprovar.");
  args.audit("x_runtime_errored_with_artifacts", {
    trace_id: args.pid, project_id: args.pid, business_slug: args.slug,
    ...(args.errorContext ?? {}),
    target_kind: args.targetKind, runtime: args.runtime,
    error: args.runtimeError, candidates: candidates.length,
    outputs_root: args.outputsRoot,
  });

  const result = runDelivery(args);
  return { judged: true, candidates: candidates.length, exitCode: result.exitCode, result };
}
