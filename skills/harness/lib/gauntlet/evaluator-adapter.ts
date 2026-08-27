// evaluator-adapter.ts — a Gauntlet evaluator backed by a real dispatch target.
//
// The three canaries in scripts/dispatch.ts used to judge candidates with a
// heuristic (the share of gateable files that pass the offline quality gate),
// signed by a nominal target that is not installed anywhere. This adapter runs
// the evaluation through an installed squad, judge-x or agent-x instead: one
// subprocess of dispatch.ts per candidate revision, explicit target selection
// (`--squad <slug>`, `--judge-x` or `--agent-x`, never the router), standard
// execution mode (a Gauntlet must not judge itself with another Gauntlet), an
// isolated evaluation directory, and the scorecard contract of
// evaluation-contract.ts. judge-x (judge-x.ts) is the engine's own judge: a lean
// prompt, no cascade, no delivery gate, and a child Run that is `completed` only
// with a valid scorecard.
//
// Independence is checked before anything runs: a producer never evaluates its
// own candidate (evaluator-registry.ts `targetsAreIndependent`). The controller
// checks it again when the scorecards are recorded; this adapter fails earlier,
// before a single token is spent.
//
// Cost source: the same as the multi-target adapters, `agent_executed.cost_usd`
// in the harness audit log filtered by trace and target. Every evaluation runs
// under its own project id (`<projectId>-evl-<revisionId>`), so the sum is the
// cost of that evaluation alone and the evaluator never resumes the producer's
// session or scaffold.
//
// The cutover (agent-x-cutover.ts) is synchronous, so the subprocess runs with
// spawnSync: the timeout kills the child, and an AbortSignal is honoured at the
// boundaries (before the spawn and after it), which is where a synchronous
// caller can observe it.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { harnessLogsDir } from "../../../_shared/lib/log-paths.ts";
import { settingsEnvForChild } from "../../../_shared/lib/settings.ts";
import type { TargetRef } from "../run-kernel/types.ts";
import type { AgentXGauntletEvaluationInput, AgentXGauntletEvaluator } from "./agent-x-cutover.ts";
import {
  EVALUATION_BRIEF_FILE, EVALUATION_OUTPUTS_DIR, EVALUATION_REQUEST_FILE, EVALUATION_REQUEST_SCHEMA_VERSION, SCORECARD_FILE,
  indeterminateScorecard, renderEvaluationBrief, scorecardFromFile, scorecardGauntletId, validateScorecardFile,
  type EvaluationRequest, type ScorecardIdentity,
} from "./evaluation-contract.ts";
import { targetsAreIndependent } from "./evaluator-registry.ts";
import { JUDGE_X_BUDGET_EXHAUSTED_MARK, JUDGE_X_SLUG, isJudgeX } from "./judge-x.ts";
import { costMatcher, observedCostUsd } from "./multi-target-dispatch-adapters.ts";
import type { EvaluationScorecard, GauntletPlan } from "./types.ts";

export interface EvaluatorSpawnRequest {
  command: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
}

export interface EvaluatorSpawnResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type EvaluatorSpawn = (request: EvaluatorSpawnRequest) => EvaluatorSpawnResult;

export type DispatchEvaluatorTarget = Extract<TargetRef, { kind: "squad" | "agent-x" }>;

export interface DispatchEvaluatorInput {
  /** The evaluator: an installed squad (with the capability it is invoked for), judge-x or agent-x. */
  target: DispatchEvaluatorTarget;
  /** The candidates' producer; the evaluator must be independent of it. */
  producer: TargetRef;
  plan: GauntletPlan;
  /** The original brief, reproduced in the evaluation brief. */
  brief: string;
  /** Root of the Run: evaluations live under `.nirvana/gauntlet/<runId>/evaluations/<revisionId>/`. */
  projectRoot: string;
  projectId: string;
  runtime?: string;
  /** Defaults to NIRVANA_DISPATCH_SCRIPT, then the repository's dispatch.ts. */
  dispatchScriptPath?: string;
  spawn?: EvaluatorSpawn;
  /** `--max-budget` of the evaluator subprocess; omitted when absent or zero. */
  budgetUsd?: number;
  /** `evaluator.max_cost_usd` the chosen capability declares (Squad Protocol v6 §30).
   *  The spend cap is the LOWER of the two: the plan's slice never buys more than the
   *  evaluator says one judgement costs, and a declared ceiling never raises the slice. */
  maxCostUsd?: number | null;
  /** Wall-clock cap of one evaluation; defaults to the plan's `maxDurationSeconds`. */
  timeoutMs?: number;
  signal?: AbortSignal;
  env?: Record<string, string>;
  audit?: (event: string, payload: Record<string, unknown>) => void;
  now?: () => string;
}

/** The `--max-budget` an evaluation runs under: the plan's slice capped by the
 *  capability's declared `max_cost_usd`. Null when neither is a positive number. */
export function evaluatorSpendCapUsd(budgetUsd?: number, maxCostUsd?: number | null): number | null {
  const slice = Number.isFinite(budgetUsd) && (budgetUsd as number) > 0 ? budgetUsd as number : null;
  const declared = typeof maxCostUsd === "number" && Number.isFinite(maxCostUsd) && maxCostUsd > 0 ? maxCostUsd : null;
  if (slice === null) return declared;
  return declared === null ? slice : Math.min(slice, declared);
}

const DEFAULT_DISPATCH_SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "dispatch.ts");

const defaultSpawn: EvaluatorSpawn = (request) => {
  const child = spawnSync(request.command[0], request.command.slice(1), {
    cwd: request.cwd, env: request.env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    timeout: request.timeoutMs, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024,
  });
  const timedOut = (child.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
  return { exitCode: child.status, stdout: child.stdout ?? "", stderr: child.stderr ?? "", timedOut };
};

export function describeTarget(target: TargetRef): string {
  return target.kind === "squad" ? `squad:${target.slug}:${target.capabilityId}` : `${target.kind}:${target.slug}`;
}

/** The `agent_executed` events of one evaluator: by `squad_slug` for a squad, by `employee` for judge-x and agent-x. */
export function evaluatorCostMatcher(target: DispatchEvaluatorTarget): (event: Record<string, unknown>) => boolean {
  if (isJudgeX(target)) return (event) => event.employee === JUDGE_X_SLUG;
  return costMatcher({ kind: target.kind, id: target.slug });
}

/** Project id the evaluation subprocess runs under: unique per revision, so cost, scaffold and sessions never mix with the producer's. */
export function evaluationProjectId(projectId: string, revisionId: string): string {
  return `${projectId}-evl-${revisionId}`;
}

export function evaluationDirFor(projectRoot: string, runId: string, revisionId: string): string {
  return path.join(projectRoot, ".nirvana", "gauntlet", runId, "evaluations", revisionId);
}

function summarizeStderr(stderr: string): string {
  const flat = stderr.replace(/\s+/g, " ").trim();
  if (!flat) return "no stderr";
  return flat.length > 300 ? `…${flat.slice(-300)}` : flat;
}

export function createDispatchEvaluator(input: DispatchEvaluatorInput): AgentXGauntletEvaluator {
  const { target, producer, plan } = input;
  if (!targetsAreIndependent(producer, target)) {
    throw new Error(`gauntlet evaluator: ${describeTarget(target)} cannot evaluate candidates produced by ${describeTarget(producer)}; `
      + "the evaluator must be a different target (evaluator-registry.ts targetsAreIndependent)");
  }
  const projectRoot = path.resolve(input.projectRoot);
  const dispatchScript = path.resolve(input.dispatchScriptPath ?? process.env.NIRVANA_DISPATCH_SCRIPT ?? DEFAULT_DISPATCH_SCRIPT);
  const spawn = input.spawn ?? defaultSpawn;
  const now = input.now ?? (() => new Date().toISOString());
  const timeoutMs = input.timeoutMs ?? plan.budget.maxDurationSeconds * 1000;
  const requirements = plan.successContract.requirements;
  const gauntletId = scorecardGauntletId(plan);

  const evaluate = (evaluation: AgentXGauntletEvaluationInput): EvaluationScorecard[] => {
    const evaluationDir = evaluationDirFor(projectRoot, evaluation.runId, evaluation.revisionId);
    // The subprocess gets its own outputs root under the evaluation directory, empty before the
    // spawn. The request and the brief stay one level up, so the child dispatch never counts the
    // adapter's files as artifacts, and a scorecard left by an earlier attempt is never read as
    // this one's.
    const outputsRoot = path.join(evaluationDir, EVALUATION_OUTPUTS_DIR);
    fs.rmSync(outputsRoot, { recursive: true, force: true });
    fs.mkdirSync(outputsRoot, { recursive: true });
    const scorecardPath = path.join(outputsRoot, SCORECARD_FILE);
    const request: EvaluationRequest = {
      schemaVersion: EVALUATION_REQUEST_SCHEMA_VERSION, projectId: evaluation.projectId, runId: evaluation.runId,
      candidateId: evaluation.candidateId, revisionId: evaluation.revisionId, revision: evaluation.revision, round: evaluation.round,
      holdout: evaluation.holdout, candidateRoot: path.resolve(evaluation.candidateRoot), scorecardPath,
      briefDigest: plan.successContract.briefDigest, requirements, gauntletIds: plan.gauntlets.map(gauntlet => gauntlet.id),
    };
    fs.writeFileSync(path.join(evaluationDir, EVALUATION_REQUEST_FILE), JSON.stringify(request, null, 2), "utf8");
    const briefFile = path.join(evaluationDir, EVALUATION_BRIEF_FILE);
    fs.writeFileSync(briefFile, renderEvaluationBrief(request, input.brief), "utf8");

    const projectId = evaluationProjectId(evaluation.projectId, evaluation.revisionId);
    const identity: ScorecardIdentity = {
      evaluationId: `evl_${evaluation.revisionId}`, candidateId: evaluation.candidateId, revisionId: evaluation.revisionId,
      gauntletId, evaluator: target, costUsd: 0, createdAt: now(),
    };
    const finish = (scorecard: EvaluationScorecard, detail: Record<string, unknown>): EvaluationScorecard[] => {
      input.audit?.("x_gauntlet_evaluation_completed", {
        trace_id: evaluation.projectId, project_id: evaluation.projectId, run_id: evaluation.runId,
        candidate_id: evaluation.candidateId, revision_id: evaluation.revisionId, round: evaluation.round,
        evaluator: describeTarget(target), evaluation_project_id: projectId, evaluation_dir: evaluationDir, outputs_root: outputsRoot,
        verdict: scorecard.verdict, cost_usd: scorecard.costUsd, ...detail,
      });
      return [scorecard];
    };
    const indeterminate = (reason: string, detail: Record<string, unknown> = {}): EvaluationScorecard[] =>
      finish(indeterminateScorecard(requirements, reason, { ...identity, costUsd: Number(detail.observed_cost_usd ?? 0) }), { reason, ...detail });
    // judge-x names a spent cap on its stderr; the reason then says `budget_exhausted`, not "error verdict".
    const budgetExhausted = (spawned: EvaluatorSpawnResult): boolean => isJudgeX(target) && spawned.stderr.includes(JUDGE_X_BUDGET_EXHAUSTED_MARK);

    if (input.signal?.aborted) return indeterminate(`aborted before the evaluator ran: ${String(input.signal.reason)}`);

    const command = ["bun", dispatchScript];
    if (target.kind === "squad") command.push("--squad", target.slug);
    else command.push(isJudgeX(target) ? "--judge-x" : "--agent-x");
    command.push("--brief-file", briefFile, "--exec", "--project", projectId, "--outputs-root", outputsRoot,
      "--execution-mode=standard", "--max-revisions", "0");
    if (input.runtime) command.push("--runtime", input.runtime);
    const spendCap = evaluatorSpendCapUsd(input.budgetUsd, input.maxCostUsd);
    if (spendCap !== null) command.push("--max-budget", String(spendCap));
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries({ ...process.env, ...input.env })) if (value !== undefined) env[key] = value;
    // The effective settings, as the variables the child reads (settings.ts settingsEnvForChild).
    Object.assign(env, settingsEnvForChild({ env, projectRoot }));
    // The child writes its audit where this adapter reads the cost from.
    const logsDir = env.HARNESS_LOGS_DIR ? path.resolve(env.HARNESS_LOGS_DIR) : harnessLogsDir({ projectRoot });
    env.HARNESS_LOGS_DIR = logsDir;

    const spawned = spawn({ command, cwd: projectRoot, env, timeoutMs });
    const costUsd = observedCostUsd(logsDir, projectId, evaluatorCostMatcher(target));
    const detail = { exit_code: spawned.exitCode, observed_cost_usd: costUsd };
    if (spawned.timedOut) return indeterminate(`evaluator timed out after ${timeoutMs} ms`, detail);
    if (input.signal?.aborted) return indeterminate(`aborted while the evaluator ran: ${String(input.signal.reason)}`, detail);
    if (!fs.existsSync(scorecardPath)) {
      if (budgetExhausted(spawned)) {
        return indeterminate(`budget_exhausted: the evaluator's spend cap of USD ${spendCap} ended the run before ${SCORECARD_FILE} was written `
          + `(dispatch exit ${spawned.exitCode ?? "signal"}: ${summarizeStderr(spawned.stderr)})`,
          { ...detail, reason_code: "budget_exhausted", budget_usd: spendCap, plan_slice_usd: input.budgetUsd ?? null, max_cost_usd: input.maxCostUsd ?? null });
      }
      return indeterminate(`${SCORECARD_FILE} not found at ${scorecardPath} (dispatch exit ${spawned.exitCode ?? "signal"}: ${summarizeStderr(spawned.stderr)})`, detail);
    }
    let raw: unknown;
    try { raw = JSON.parse(fs.readFileSync(scorecardPath, "utf8")); }
    catch (error) { return indeterminate(`${SCORECARD_FILE} is not valid JSON: ${(error as Error).message}`, detail); }
    const validation = validateScorecardFile(raw, requirements);
    if (!validation.ok) return indeterminate(validation.reason, detail);
    return finish(scorecardFromFile(validation.scorecard, { ...identity, costUsd }), detail);
  };

  return { target, evaluate };
}
