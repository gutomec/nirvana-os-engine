// runner.ts — verifyEntity / verifyAll / verifyPack, all in-process.
//
// No LLM, no spawned loader: the check of one entity is a function call, so
// `--all` over 555 clones costs seconds, not minutes (business-audit-criteria
// spawns loader.ts per business with a 30 s timeout — `--all` must not
// inherit that). The `--fix` loop is the port of improve-squad.ts:98-134
// without the consensus step: check → mechanical fixers → backup → apply in
// the module's fixed order → re-check → roll back when a fixer threw, the
// manifest stopped parsing, or a NEW error appeared. A second `--fix` run is
// a no-op by construction: every fixer writes only when something differs.

import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { paths } from "../bun-helpers.ts";
import { detectKind } from "../surface.ts";
import { applyBaseline, debtOf, defaultBaselinePath, loadBaseline, recordBaseline, type Baseline } from "./baseline.ts";
import { agenticFix, type AgenticOptions } from "./agentic.ts";
import { createBackup, restoreBackup } from "./backup.ts";
import { businessModule } from "./kinds/business.ts";
import { mindCloneModule } from "./kinds/mind-clone.ts";
import { squadModule } from "./kinds/squad.ts";
import { countFindings, exitCodeFor, type BatchReport } from "./report.ts";
import {
  KINDS, VERIFY_EXIT, findingKey,
  type CheckContext, type Finding, type FixOutcome, type FixResult, type Kind, type KindModule, type VerifyReport,
} from "./types.ts";

export const MODULES: Record<Kind, KindModule> = {
  squad: squadModule,
  business: businessModule,
  "mind-clone": mindCloneModule,
};

const PLURAL: Record<Kind, string> = { squad: "squads", business: "businesses", "mind-clone": "mind-clones" };

/** Bad usage or an entity nobody can find: exit 64. */
export class VerifyUsageError extends Error {
  exit = VERIFY_EXIT.USAGE;
}

export type Emitter = (event: string, payload: Record<string, unknown>) => void;

export interface VerifyOptions {
  fix?: false | "mechanical" | "agentic";
  strict?: boolean;
  /** default true; false skips the self-retrieval axis */
  retrieval?: boolean;
  /** undefined = the machine's baseline; null = no baseline at all */
  baselinePath?: string | null;
  /** `hook` grandfathers an entity when no baseline exists yet */
  mode?: "cli" | "hook";
  /** undefined = SQUADS_STATE_DIR; null = do not persist */
  stateDir?: string | null;
  backupRoot?: string;
  /** undefined = the audit log; null = silent */
  emit?: Emitter | null;
  registries?: unknown;
  cloneRegistry?: Record<string, unknown>;
  /** test seam: a module standing in for the kind's */
  module?: KindModule;
  /** `--fix=agentic`: runtime, budget, confirmation and the test seams. */
  agentic?: AgenticOptions;
}

let _audit: Emitter | null = null;
function auditEmit(): Emitter {
  if (_audit) return _audit;
  try {
    const req = createRequire(import.meta.url);
    const audit = req(path.join(import.meta.dir, "..", "..", "..", "harness", "lib", "audit.js"));
    _audit = (event, payload) => { try { audit.emit(event, payload); } catch { /* audit never breaks the gate */ } };
  } catch {
    _audit = () => {};
  }
  return _audit;
}

export function kindFromAlias(s: string): Kind | null {
  const k = s.toLowerCase();
  if (k === "squad" || k === "squads") return "squad";
  if (k === "business" || k === "businesses" || k === "biz") return "business";
  if (k === "mind-clone" || k === "mind-clones" || k === "mindclone" || k === "clone" || k === "clones" || k === "mc") return "mind-clone";
  return null;
}

function countsOf(findings: Finding[]) {
  const c = countFindings(findings);
  return { errors: c.errors, warnings: c.warnings };
}

// ── the fix loop ────────────────────────────────────────────────────────────

async function fixLoop(module: KindModule, ctx: CheckContext, findings0: Finding[], backupRoot?: string): Promise<{ findings: Finding[]; fixes: FixResult[]; outcome: FixOutcome }> {
  const before = countsOf(findings0);
  const targets = findings0.filter((f) => f.autofix === "mechanical" && f.fixer && module.fixers[f.fixer]);
  if (targets.length === 0) {
    return { findings: findings0, fixes: [], outcome: { mode: "mechanical", backup: null, rolled_back: false, before, after: before } };
  }
  const backup = createBackup(ctx.dir, ctx.kind, ctx.slug, backupRoot);
  const fixes: FixResult[] = [];
  const ran = new Set<string>();
  let anyApplied = false;
  let threw: string | null = null;
  try {
    for (const name of module.fixOrder) {
      for (const f of targets.filter((t) => t.fixer === name)) {
        const r = module.fixers[name]({ kind: ctx.kind, slug: ctx.slug, dir: ctx.dir, finding: f });
        fixes.push(r);
        ran.add(name);
        if (r.applied) anyApplied = true;
      }
    }
    // A fixer that rewrote the manifest changed the contract surface; keep it
    // fresh so the second run is a no-op instead of reporting surface_stale.
    if (anyApplied && module.fixers.surface_regen && !ran.has("surface_regen")) {
      const synthetic: Finding = { id: "surface_stale", severity: "warning", autofix: "mechanical", message: "regenerated after mechanical fixes", evidence: "", baselined: false, fixer: "surface_regen" };
      fixes.push(module.fixers.surface_regen({ kind: ctx.kind, slug: ctx.slug, dir: ctx.dir, finding: synthetic }));
    }
  } catch (e: any) {
    threw = String(e?.message ?? e);
  }

  let findings1 = threw ? findings0 : await module.check(ctx);
  const errorsBefore = new Set(findings0.filter((f) => f.severity === "error").map(findingKey));
  const newErrors = findings1.filter((f) => f.severity === "error" && !errorsBefore.has(findingKey(f)));
  let reason: string | undefined;
  if (threw) reason = `fixer threw: ${threw}`;
  else if (newErrors.some((f) => f.id === "manifest_parse")) reason = "the manifest no longer parses";
  else if (newErrors.length) reason = `new error(s): ${newErrors.map(findingKey).join(", ")}`;

  let rolled_back = false;
  if (reason) {
    restoreBackup(backup, ctx.dir);
    rolled_back = true;
    findings1 = await module.check(ctx);
  }
  return { findings: findings1, fixes, outcome: { mode: "mechanical", backup, rolled_back, ...(reason ? { rollback_reason: reason } : {}), before, after: countsOf(findings1) } };
}

// ── one entity ──────────────────────────────────────────────────────────────

async function runOne(
  module: KindModule, dir: string, slug: string, opts: VerifyOptions,
  baseline: Baseline | null, baselineFile: string | null, persist: boolean,
): Promise<VerifyReport> {
  const kind = module.kind;
  const ctx: CheckContext = { kind, slug, dir, retrieval: opts.retrieval !== false, registries: opts.registries, cloneRegistry: opts.cloneRegistry };
  const emit: Emitter = opts.emit === null ? () => {} : (opts.emit ?? auditEmit());

  let findings = await module.check(ctx);
  let fixes: FixResult[] = [];
  let fix_outcome: FixOutcome | null = null;
  if (opts.fix === "mechanical") {
    const r = await fixLoop(module, ctx, findings, opts.backupRoot);
    findings = r.findings; fixes = r.fixes; fix_outcome = r.outcome;
  } else if (opts.fix === "agentic") {
    // The mechanical pass runs first on purpose: shape before meaning, so the
    // model is never asked to hand-write what a fixer writes for free — and
    // never spends the budget on an entity a fixer would have admitted.
    const mech = await fixLoop(module, ctx, findings, opts.backupRoot);
    findings = mech.findings; fixes = mech.fixes;
    const r = await agenticFix(module, ctx, findings, { emit, backupRoot: opts.backupRoot, ...(opts.agentic ?? {}) });
    findings = r.findings;
    fixes = [...fixes, ...r.fixes];
    fix_outcome = { ...r.outcome, before: mech.outcome.before };
  }

  const baselineable = new Set(module.criteria.filter((c) => c.baselineable).map((c) => c.id));
  applyBaseline(kind, slug, findings, baselineable, baseline);

  // Day one: a hook caller with no baseline yet grandfathers what it finds
  // instead of failing every installed entity at once. The CLI stays honest.
  let baselinePresent = !!baseline;
  if (opts.mode === "hook" && !baseline && baselineFile) {
    const debt = debtOf(findings, baselineable);
    if (debt.length) {
      const r = recordBaseline(baselineFile, [{ kind, slug, debt }], { allowRegression: true });
      emit("x_verify_baseline_recorded", { path: r.path, reason: "hook_grandfathering", entity: `${kind}:${slug}`, debt });
      applyBaseline(kind, slug, findings, baselineable, loadBaseline(baselineFile));
      baselinePresent = true;
    }
  }

  const c = countFindings(findings);
  const fired = new Set(findings.filter((f) => f.severity !== "info").map((f) => f.id));
  const exit_code = exitCodeFor(findings, !!opts.strict);
  const report: VerifyReport = {
    schema: "nirvana.verify-report/v1",
    kind, slug, dir,
    verdict: exit_code === VERIFY_EXIT.ADMITTED ? "ADMITTED" : "REJECTED",
    summary: { errors: c.errors, warnings: c.warnings, debt: c.debt, passed: module.criteria.filter((x) => x.severity !== "info").length - fired.size },
    findings, fixes, fix_outcome,
    baseline: { present: baselinePresent, debt: c.debt },
    exit_code,
    strict: !!opts.strict,
    checked_at: new Date().toISOString(),
  };

  if (persist && opts.stateDir !== null) {
    try {
      const stateDir = path.join(opts.stateDir ?? (paths as Record<string, string>).SQUADS_STATE_DIR, slug);
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(path.join(stateDir, "verify.json"), JSON.stringify(report, null, 2) + "\n", "utf8");
    } catch { /* state is a convenience, never a gate */ }
  }
  emit(`x_verify_${kind.replace("-", "_")}`, {
    kind, slug, verdict: report.verdict, errors: c.errors, warnings: c.warnings, debt: c.debt,
    fix_mode: fix_outcome?.mode ?? "none", rolled_back: fix_outcome?.rolled_back ?? false, exit_code,
  });
  return report;
}

/**
 * Verifies one entity by slug or path. `kind` may be "auto" when the target
 * is a path (detected from the manifest on disk).
 */
export async function verifyEntity(kind: Kind | "auto", target: string, opts: VerifyOptions = {}): Promise<VerifyReport> {
  let k: Kind | null = kind === "auto" ? null : kind;
  if (!k) {
    const asPath = path.resolve(target);
    k = fs.existsSync(asPath) ? detectKind(asPath) : null;
    if (!k) throw new VerifyUsageError(`cannot detect the kind of ${target}: pass squad|business|mind-clone, or a directory holding squad.yaml, business.yaml or MANIFEST.yaml`);
  }
  const module = opts.module ?? MODULES[k];
  const dir = module.resolveDir(target);
  if (!dir) throw new VerifyUsageError(`unknown ${k}: ${target}`);
  const baselineFile = opts.baselinePath === null ? null : (opts.baselinePath ?? defaultBaselinePath());
  const baseline = baselineFile ? loadBaseline(baselineFile) : null;
  return runOne(module, dir, path.basename(dir), opts, baseline, baselineFile, true);
}

export interface BatchOptions extends VerifyOptions {
  roots?: string[];
  record?: boolean;
  allowRegression?: boolean;
}

function batchExit(reports: VerifyReport[], strict: boolean, refused: boolean): number {
  if (refused) return VERIFY_EXIT.REJECTED;
  if (reports.some((r) => r.summary.errors > 0)) return VERIFY_EXIT.REJECTED;
  if (strict && reports.some((r) => r.summary.warnings > 0)) return VERIFY_EXIT.STRICT_WARNINGS;
  return VERIFY_EXIT.ADMITTED;
}

async function runBatch(mode: "all" | "pack", targets: Array<{ module: KindModule; slug: string; dir: string }>, opts: BatchOptions, persist: boolean): Promise<BatchReport> {
  // Load the clone registry once for the whole batch (the module caches one
  // BM25 index per registry object).
  if (opts.retrieval !== false && !opts.cloneRegistry && targets.some((t) => t.module.kind === "mind-clone")) {
    try { const { loadCloneRegistry } = await import("../clone-resolver.ts"); opts = { ...opts, cloneRegistry: loadCloneRegistry() }; } catch { /* no registry: registry_absent per entity */ }
  }
  const baselineFile = opts.baselinePath === null ? null : (opts.baselinePath ?? defaultBaselinePath());
  const baseline = baselineFile ? loadBaseline(baselineFile) : null;
  const reports: VerifyReport[] = [];
  for (const t of targets) reports.push(await runOne(t.module, t.dir, t.slug, opts, baseline, baselineFile, persist));

  let recorded = false;
  let regressions: Array<{ entity: string; added: string[] }> | undefined;
  if (opts.record) {
    if (!baselineFile) throw new VerifyUsageError("--record needs a baseline path");
    const scanned = targets.map((t, i) => ({
      kind: t.module.kind, slug: t.slug,
      debt: debtOf(reports[i].findings, new Set(t.module.criteria.filter((c) => c.baselineable).map((c) => c.id))),
    }));
    const r = recordBaseline(baselineFile, scanned, { allowRegression: !!opts.allowRegression });
    recorded = r.ok;
    if (!r.ok) regressions = r.regressions;
    else {
      const fresh = loadBaseline(baselineFile);
      for (let i = 0; i < reports.length; i++) {
        const m = targets[i].module;
        applyBaseline(m.kind, targets[i].slug, reports[i].findings, new Set(m.criteria.filter((c) => c.baselineable).map((c) => c.id)), fresh);
        const c = countFindings(reports[i].findings);
        reports[i].summary = { ...reports[i].summary, errors: c.errors, warnings: c.warnings, debt: c.debt };
        reports[i].baseline = { present: true, debt: c.debt };
        reports[i].exit_code = exitCodeFor(reports[i].findings, !!opts.strict);
        reports[i].verdict = reports[i].exit_code === 0 ? "ADMITTED" : "REJECTED";
      }
      (opts.emit === null ? () => {} : (opts.emit ?? auditEmit()))("x_verify_baseline_recorded", { path: r.path, reason: "record", entities: r.entities_with_debt, mode });
    }
  }

  const summary = {
    admitted: reports.filter((r) => r.exit_code === 0).length,
    rejected: reports.filter((r) => r.exit_code !== 0).length,
    errors: reports.reduce((a, r) => a + r.summary.errors, 0),
    warnings: reports.reduce((a, r) => a + r.summary.warnings, 0),
    debt: reports.reduce((a, r) => a + r.summary.debt, 0),
  };
  return {
    schema: "nirvana.verify-batch/v1",
    mode,
    kinds: [...new Set(targets.map((t) => t.module.kind))],
    entities: reports.length,
    summary,
    reports,
    baseline: { present: !!baseline || recorded, path: baselineFile, ...(opts.record ? { recorded } : {}), ...(regressions ? { regressions } : {}) },
    exit_code: batchExit(reports, !!opts.strict, !!regressions),
    strict: !!opts.strict,
    checked_at: new Date().toISOString(),
  };
}

/** Every installed entity of a kind (or every entity under `roots`). */
export async function verifyAll(kind: Kind, opts: BatchOptions = {}): Promise<BatchReport> {
  const module = opts.module ?? MODULES[kind];
  const targets = module.listAll(opts.roots).map((e) => ({ module, slug: e.slug, dir: e.dir }));
  return runBatch("all", targets, opts, true);
}

/**
 * A pack content dir (`<dir>/{squads,businesses,mind-clones}/<slug>`). Pack
 * entities are not installed: no state file, and self-retrieval is off unless
 * the caller injects registries.
 */
export async function verifyPack(packDir: string, opts: BatchOptions & { kinds?: Kind[] } = {}): Promise<BatchReport> {
  if (!fs.existsSync(packDir) || !fs.statSync(packDir).isDirectory()) throw new VerifyUsageError(`pack content dir not found: ${packDir}`);
  const targets: Array<{ module: KindModule; slug: string; dir: string }> = [];
  for (const kind of opts.kinds ?? KINDS) {
    const root = path.join(packDir, PLURAL[kind]);
    if (!fs.existsSync(root)) continue;
    const module = MODULES[kind];
    for (const e of module.listAll([root])) targets.push({ module, slug: e.slug, dir: e.dir });
  }
  return runBatch("pack", targets, { retrieval: !!opts.registries || !!opts.cloneRegistry, ...opts, stateDir: null }, false);
}
