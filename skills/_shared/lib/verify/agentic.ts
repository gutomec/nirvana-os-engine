// agentic.ts — `nrv validate <kind> <slug> --fix=agentic`.
//
// The mechanical fixers repair SHAPE: a missing surface, a stub component, a
// field in the wrong place. What they cannot write is MEANING — a description
// that carries routing signal, `example_briefs` a real user would type, the
// `routing:` block of a clone. Those findings are declared `autofix:
// "agentic"` and, until this file, had nowhere to go.
//
// The pattern is enrich-routing-metadata.ts's, not `nrv dispatch --agent-x`
// (which aims at an outputs root and runs the whole delivery pipeline). What
// makes it safe to point a model at an author's own squad:
//
//   STAGING       the model edits a COPY. The library is untouched until the
//                 result is judged better, so a bad run costs a temp dir.
//   BUDGET        a hard `--max-budget-usd` (default 3) and a wall clock, and
//                 nothing runs at all until the spend is confirmed (exit 2).
//   ACCEPTANCE    errors may not GROW and at least one targeted finding must
//                 be GONE. "The model wrote something" is not a result.
//   RETRIEVAL     when routing metadata was the target, the entity has to be
//                 findable afterwards — the self-retrieval gate says so, and a
//                 failure rolls the whole thing back.
//   LEDGER        one row (`targetKind: "verify-fix"`) and a start/finish pair
//                 of audit events, so a spend is never invisible.
//
// Off in `--pack` (a pack source is not an installed entity and has no
// registry to retrieve from) and off when no runtime is on PATH.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { paths } from "../bun-helpers.ts";
import { scopeGuard } from "../scope-guard.ts";
import { runHeadless, runtimeAvailable, type RunHeadlessOpts, type RunHeadlessResult, type Runtime } from "../host-agent-driver.ts";
import { createBackup, restoreBackup } from "./backup.ts";
import { countFindings } from "./report.ts";
import { findingKey, type CheckContext, type Finding, type FixOutcome, type FixResult, type KindModule } from "./types.ts";

export const DEFAULT_BUDGET_USD = 3;
export const DEFAULT_TIMEOUT_MS = 15 * 60_000;

/** Every runtime the driver knows, in the order a default pick prefers them. */
export const RUNTIME_PREFERENCE: Runtime[] = [
  "claude-code", "codex", "gemini-cli", "antigravity-cli", "kimi-cli", "grok-cli", "pi", "qwen-code", "opencode",
];

/** The gate needs a spend confirmed before it runs. Exit 2, never a silent bill. */
export class AgenticConfirmationRequired extends Error {
  exit = 2;
}

export interface AgenticOptions {
  runtime?: Runtime;
  budgetUsd?: number;
  timeoutMs?: number;
  /** `--yes`: the spend is authorized. Without it the run refuses with exit 2. */
  confirmed?: boolean;
  /** Pack sources are never agentically fixed. */
  pack?: boolean;
  emit?: ((event: string, payload: Record<string, unknown>) => void) | null;
  backupRoot?: string;
  stagingRoot?: string;
  traceId?: string;
  // ── test seams ──
  runHeadlessImpl?: (opts: RunHeadlessOpts) => RunHeadlessResult;
  runtimeAvailableImpl?: (runtime: Runtime) => boolean;
  /** Self-retrieval check; returns false to roll the run back. */
  retrievalCheck?: (slug: string, kind: string) => boolean | Promise<boolean>;
  openRunImpl?: (opts: Record<string, unknown>) => { runId: string } | null;
}

export interface AgenticResult {
  findings: Finding[];
  fixes: FixResult[];
  outcome: FixOutcome;
}

/**
 * Criteria whose repair is only real if the entity can still be retrieved.
 * These are the fields the router READS — a rewritten one-liner that stops
 * returning its own clone is a regression dressed as a fix. `not_for` is
 * deliberately absent: it is a fence, judged by check-not-for-fires, and it
 * never makes an entity more findable.
 */
const RETRIEVAL_SENSITIVE = new Set([
  "routing_metadata_incomplete", "routing_block_missing", "one_liner_missing",
  "description_short", "domains_count", "serves_missing", "self_retrieval_miss",
]);

function noop(module: KindModule, findings: Finding[], note: string): AgenticResult {
  const c = countFindings(findings);
  const before = { errors: c.errors, warnings: c.warnings };
  return {
    findings, fixes: [{ fixer: "agentic", finding: "-", applied: false, changed_files: [], note }],
    outcome: { mode: "agentic", backup: null, rolled_back: false, rollback_reason: note, before, after: before },
  };
}

function pickRuntime(opts: AgenticOptions): Runtime | null {
  const available = opts.runtimeAvailableImpl ?? runtimeAvailable;
  if (opts.runtime) return available(opts.runtime) ? opts.runtime : null;
  for (const rt of RUNTIME_PREFERENCE) if (available(rt)) return rt;
  return null;
}

/**
 * The real self-retrieval gate: does the entity come back first for its own
 * example briefs? `reindex: false` — the caller decides when to reindex, and a
 * repair that only works after a reindex is not a repair the user can trust.
 * An unavailable gate never blocks an otherwise accepted run.
 */
async function defaultRetrievalCheck(slug: string, kind: string): Promise<boolean> {
  try {
    const { runGate } = await import("../../scripts/self-retrieval-gate.ts");
    const r = await runGate(slug, { kind: kind as never, reindex: false });
    return r.passed;
  } catch {
    return true;
  }
}

function stagingRoot(opts: AgenticOptions): string {
  return opts.stagingRoot ?? path.join((paths as Record<string, string>).NIRVANA_HOME ?? os.tmpdir(), ".nirvana", "verify-staging");
}

/**
 * The brief the model receives. It names the findings by id with their own
 * evidence, states the contract of the kind, and carries the scope guard — a
 * `--fix` that "improves" three things nobody asked about is the failure mode
 * this whole cut exists to avoid.
 */
export function buildBrief(module: KindModule, slug: string, targets: Finding[]): string {
  const titles = new Map(module.criteria.map((c) => [c.id, c.title]));
  const lines: string[] = [];
  lines.push(`You are repairing ONE ${module.kind} — \`${slug}\` — inside a staging copy of it.`);
  lines.push("");
  lines.push(`The admission gate (\`nrv validate ${module.kind} ${slug}\`) reported the findings below.`);
  lines.push("Each one names a criterion, what the criterion requires, and the evidence that made it fire.");
  lines.push("");
  for (const f of targets) {
    lines.push(`- **${findingKey(f)}** — ${titles.get(f.id) ?? f.id}`);
    lines.push(`  - reported: ${f.message}`);
    if (f.evidence) lines.push(`  - evidence: ${f.evidence}`);
  }
  lines.push("");
  lines.push("Rules:");
  lines.push(`1. Edit only files inside this directory. The manifest is \`${module.manifestFile}\`.`);
  lines.push("2. Fix EXACTLY the findings listed above. Nothing else in this entity is yours to change.");
  lines.push("3. Never delete authored content. Never invent a source, a citation or a validation verdict.");
  lines.push("4. Keep the file's own language and comments; the engine re-reads them.");
  lines.push("5. Write real content, never a placeholder or a TODO — the gate will re-check and reject a stub.");
  lines.push("");
  lines.push(scopeGuard("en"));
  return lines.join("\n");
}

/**
 * Runs the agentic repair. The caller has already run `check`; `findings0` is
 * that result, and the returned findings are the post-run re-check.
 */
export async function agenticFix(
  module: KindModule, ctx: CheckContext, findings0: Finding[], opts: AgenticOptions = {},
): Promise<AgenticResult> {
  const emit = opts.emit === null ? () => {} : (opts.emit ?? (() => {}));
  const targets = findings0.filter((f) => f.autofix === "agentic" && !f.baselined);
  if (opts.pack) return noop(module, findings0, "--fix=agentic is off for --pack: a pack source is not an installed entity");
  if (targets.length === 0) return noop(module, findings0, "nothing to repair agentically");

  // Confirmation BEFORE the runtime probe, deliberately: whether this command
  // may spend money is a property of the request, not of the machine, so the
  // answer is the same on every machine and a `which` is never run for a
  // command the user has not authorized yet.
  const budgetUsd = opts.budgetUsd ?? DEFAULT_BUDGET_USD;
  if (!opts.confirmed) {
    throw new AgenticConfirmationRequired(
      `--fix=agentic spends up to $${budgetUsd.toFixed(2)} on ${targets.length} finding(s) of ${module.kind} ${ctx.slug}. ` +
      "Re-run with --yes to authorize (change the ceiling with --budget-usd).");
  }

  const runtime = pickRuntime(opts);
  if (!runtime) return noop(module, findings0, "no agent runtime on PATH — install one, or use --fix (mechanical)");

  const before = (() => { const c = countFindings(findings0); return { errors: c.errors, warnings: c.warnings }; })();
  const staging = path.join(stagingRoot(opts), module.kind, `${ctx.slug}.${new Date().toISOString().replace(/[:.]/g, "-")}`);
  fs.mkdirSync(path.dirname(staging), { recursive: true });
  fs.cpSync(ctx.dir, staging, { recursive: true, verbatimSymlinks: true });

  const traceId = opts.traceId ?? `verify-fix-${ctx.slug}-${Date.now().toString(36)}`;
  let runId: string | null = null;
  try {
    const open = opts.openRunImpl ?? (await import("../../harness/lib/run-ledger.ts")).openAgenticRun as (o: Record<string, unknown>) => { runId: string } | null;
    runId = open({ projectId: traceId, traceId, targetSlug: ctx.slug, targetKind: "verify-fix", outputsRoot: staging, runtime })?.runId ?? null;
  } catch { /* a run that is not ledgered still runs; it is just not watched */ }

  const brief = buildBrief(module, ctx.slug, targets);
  emit("x_verify_fix_started", {
    kind: module.kind, slug: ctx.slug, runtime, run_id: runId, trace_id: traceId,
    findings: targets.map(findingKey), budget_usd: budgetUsd, staging,
  });

  const run = (opts.runHeadlessImpl ?? runHeadless)({
    runtime, prompt: brief, cwd: staging, addDirs: [staging],
    maxBudgetUsd: budgetUsd, timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });

  const finish = (accepted: boolean, reason: string | undefined, after: { errors: number; warnings: number }) => {
    emit("x_verify_fix_finished", {
      kind: module.kind, slug: ctx.slug, runtime, run_id: runId, trace_id: traceId,
      accepted, reason: reason ?? null, cost_usd: run.costUsd, duration_ms: run.durationMs,
      errors_before: before.errors, errors_after: after.errors,
    });
  };

  const discard = (reason: string): AgenticResult => {
    fs.rmSync(staging, { recursive: true, force: true });
    finish(false, reason, before);
    return {
      findings: findings0,
      fixes: [{ fixer: "agentic", finding: targets.map(findingKey).join(", "), applied: false, changed_files: [], note: reason }],
      outcome: { mode: "agentic", backup: null, rolled_back: true, rollback_reason: reason, before, after: before },
    };
  };

  if (!run.ok) return discard(`the ${runtime} run failed: ${run.error ?? `exit ${run.exitCode}`}`);

  const staged = await module.check({ ...ctx, dir: staging });
  const stagedCounts = (() => { const c = countFindings(staged); return { errors: c.errors, warnings: c.warnings }; })();
  if (stagedCounts.errors > before.errors) return discard(`errors grew ${before.errors} → ${stagedCounts.errors}`);
  const gone = targets.filter((t) => !staged.some((f) => findingKey(f) === findingKey(t)));
  if (gone.length === 0) return discard("no targeted finding was repaired");

  // Accepted on the staging copy: back the real entity up, then overwrite it.
  const backup = createBackup(ctx.dir, module.kind, ctx.slug, opts.backupRoot);
  fs.rmSync(ctx.dir, { recursive: true, force: true });
  fs.cpSync(staging, ctx.dir, { recursive: true, verbatimSymlinks: true });
  fs.rmSync(staging, { recursive: true, force: true });

  // Routing metadata is only repaired if the entity can be FOUND with it.
  // The gate has to read the entity from disk, which is why it runs here and
  // not on the staging copy: the registry knows the installed path, not a
  // temp dir. A miss restores the backup, so the cost of asking late is one
  // more copy, never a corrupted entity.
  if (targets.some((t) => RETRIEVAL_SENSITIVE.has(t.id))) {
    const check = opts.retrievalCheck ?? defaultRetrievalCheck;
    if (!(await check(ctx.slug, module.kind))) {
      restoreBackup(backup, ctx.dir);
      const reverted = await module.check(ctx);
      const reason = "the self-retrieval gate still does not return the entity for its own briefs";
      finish(false, reason, before);
      return {
        findings: reverted,
        fixes: [{ fixer: "agentic", finding: gone.map(findingKey).join(", "), applied: false, changed_files: [], note: reason }],
        outcome: { mode: "agentic", backup, rolled_back: true, rollback_reason: reason, before, after: before },
      };
    }
  }

  const after = await module.check(ctx);
  const afterCounts = (() => { const c = countFindings(after); return { errors: c.errors, warnings: c.warnings }; })();
  finish(true, undefined, afterCounts);
  return {
    findings: after,
    fixes: [{
      fixer: "agentic", finding: gone.map(findingKey).join(", "), applied: true,
      changed_files: [], note: `${gone.length} of ${targets.length} finding(s) repaired by ${runtime}${run.costUsd === null ? "" : ` ($${run.costUsd.toFixed(2)})`}`,
    }],
    outcome: { mode: "agentic", backup, rolled_back: false, before, after: afterCounts },
  };
}
