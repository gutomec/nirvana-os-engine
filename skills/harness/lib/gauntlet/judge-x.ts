// judge-x.ts — the Gauntlet judge the engine ships.
//
// judge-x is the evaluator every installation has without a variable, a squad or an
// install step: the same headless driver and the same persona mechanism as agent-x,
// under its own identity. Its TargetRef is `{ kind: "agent-x", slug: "judge-x" }`:
// `targetsAreIndependent` (evaluator-registry.ts) compares kind and slug, so the judge
// is independent of the agent-x producer, of every squad and of every business, while
// the kernel, Glance and the validators, which only read `kind`, accept it unchanged.
// A kind of its own would have touched every `kind` union of the engine for no gain.
//
// The prompt is the persona plus the evaluation brief, and nothing else: no autonomous
// directive, no squad catalog, no runtime rules, no routing. The agent-x evaluator of
// the first real smoke (2026-08-26) spent USD 0.82 on its first turn under a USD 0.625
// cap because it carried the whole agent-x prompt; a lean prompt and a budget floor
// (agent-x-cutover.ts GAUNTLET_EVALUATION_FLOOR_USD) are the fix.
//
// Persona resolution is strict: `judge-x.<flavor>.md` for the runtime's flavor, in the
// engine's agents dir or the installed skills' one, never another runtime's file. A
// runtime without a persona has no judge, and the Gauntlet does not start
// (evaluator-selection.ts).

import * as fs from "node:fs";
import * as path from "node:path";
import { scopeGuard } from "../../../_shared/lib/scope-guard.ts";
import { runWithCascade } from "../cascade-runner.ts";
import { agentsDirCandidates } from "../dispatch-cascade.ts";
import { runtimeAvailable, type Runtime } from "../host-agent-driver.ts";
import type { TargetRef } from "../run-kernel/types.ts";
import { SCORECARD_FILE, validateScorecardFile, type ScorecardFile } from "./evaluation-contract.ts";
import type { SuccessRequirement } from "./types.ts";

export const JUDGE_X_SLUG = "judge-x";
export const JUDGE_X_TARGET: TargetRef = { kind: "agent-x", slug: JUDGE_X_SLUG };
/** Line the judge child prints to stderr when its spend cap ended the run before the scorecard; the adapter reads it. */
export const JUDGE_X_BUDGET_EXHAUSTED_MARK = "judge-x: budget_exhausted";
/** claude-code's result subtype for a run that hit `--max-budget-usd`. */
export const BUDGET_EXHAUSTED_SUBTYPE = "error_max_budget_usd";

export function isJudgeX(target: TargetRef): boolean {
  return target.kind === "agent-x" && target.slug === JUDGE_X_SLUG;
}

function flavorOf(runtime: Runtime): string {
  return String(runtime).replace(/-cli$/, "");
}

/** The judge persona for a runtime: `judge-x.<flavor>.md`, exact flavor only. */
export function resolveJudgeXPromptPath(runtime: Runtime, agentsDir?: string): string | null {
  const file = `judge-x.${flavorOf(runtime)}.md`;
  for (const dir of agentsDir ? [agentsDir] : agentsDirCandidates()) {
    const candidate = path.join(dir, file);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

export type JudgeXAvailability = { available: true; personaPath: string } | { available: false; reason: string };

/** Whether judge-x can run on a runtime: a persona for that runtime and the runtime's CLI on the PATH. */
export function judgeXAvailability(runtime: Runtime, options: { agentsDir?: string; runtimeOnPath?: (runtime: Runtime) => boolean } = {}): JudgeXAvailability {
  const personaPath = resolveJudgeXPromptPath(runtime, options.agentsDir);
  if (!personaPath) return { available: false, reason: `no judge-x persona for runtime '${runtime}' (judge-x.${flavorOf(runtime)}.md)` };
  if (!(options.runtimeOnPath ?? runtimeAvailable)(runtime)) return { available: false, reason: `runtime '${runtime}' is not on the PATH` };
  return { available: true, personaPath };
}

/** The judge's whole first turn: persona, dispatch block, evaluation brief, scope guard. */
export function buildJudgeXPrompt(args: { persona: string; brief: string; projectId: string; outputsRoot: string; scorecardPath: string }): string {
  return [
    args.persona,
    "",
    "============================================================",
    "# JUDGE-X DISPATCH (independent Gauntlet evaluation)",
    `- trace_id: ${args.projectId}`,
    `- output_path: ${args.outputsRoot}`,
    `- scorecard_path: ${args.scorecardPath}`,
    "",
    "## Evaluation brief",
    args.brief,
    "",
    "## Output",
    `Write exactly one file, ${SCORECARD_FILE}, at the scorecard_path above. Do not print a verdict; write the file.`,
    scopeGuard("en"),
  ].join("\n");
}

export interface RunJudgeXArgs {
  /** The evaluation brief (evaluation-contract.ts renderEvaluationBrief), reproduced in the prompt. */
  brief: string;
  runtime: Runtime;
  projectId: string;
  projectDir: string;
  projectRoot: string;
  outputsRoot: string;
  scorecardPath: string;
  /** Read-only root of the candidate, granted to the runtime beside the project root. */
  candidateRoot?: string;
  maxBudgetUsd?: number;
  timeoutMs?: number;
  yolo?: boolean;
  audit: (event: string, payload: Record<string, any>) => void;
  agentsDir?: string;
  /** Test seam: canned cascade runner (zero-token tests). */
  runWithCascadeImpl?: typeof runWithCascade;
}

export interface JudgeXResult {
  ok: boolean;
  sessionId: string | null;
  costUsd: number | null;
  durationMs: number;
  exitCode?: number;
  error?: string;
  stderr?: string;
  /** The runtime ended the run on its spend cap before the judge finished. */
  budgetExhausted: boolean;
  promptPath: string | null;
  promptChars: number;
  finalRuntime: Runtime;
}

/** Run judge-x once: persona + evaluation brief through the cascade runner, no directive, no ledger, no delivery pipeline. */
export function runJudgeX(args: RunJudgeXArgs): JudgeXResult {
  const emit = args.audit;
  const promptPath = resolveJudgeXPromptPath(args.runtime, args.agentsDir);
  if (!promptPath) {
    return { ok: false, sessionId: null, costUsd: null, durationMs: 0, exitCode: 1, budgetExhausted: false, promptPath: null, promptChars: 0,
      finalRuntime: args.runtime, error: `no judge-x persona for runtime '${args.runtime}' (judge-x.${flavorOf(args.runtime)}.md)` };
  }
  const prompt = buildJudgeXPrompt({ persona: fs.readFileSync(promptPath, "utf8"), brief: args.brief, projectId: args.projectId,
    outputsRoot: args.outputsRoot, scorecardPath: args.scorecardPath });
  emit("x_dispatch_judge_x", { trace_id: args.projectId, project_id: args.projectId, runtime: args.runtime, persona_file: promptPath,
    outputs_root: args.outputsRoot, scorecard_path: args.scorecardPath, prompt_chars: prompt.length, max_budget_usd: args.maxBudgetUsd ?? null });
  const res = (args.runWithCascadeImpl ?? runWithCascade)({
    runtime: args.runtime, prompt, cwd: args.projectDir,
    addDirs: [args.projectRoot, ...(args.candidateRoot ? [args.candidateRoot] : [])],
    maxBudgetUsd: args.maxBudgetUsd, timeoutMs: args.timeoutMs, yolo: args.yolo,
    brief: args.brief, projectRoot: args.projectRoot, outputsRoot: args.outputsRoot,
    taskHint: "judge-x (Gauntlet evaluation)", projectId: args.projectId,
  });
  const budgetExhausted = !res.ok && res.resultSubtype === BUDGET_EXHAUSTED_SUBTYPE;
  emit("agent_executed", { trace_id: args.projectId, project_id: args.projectId, employee: JUDGE_X_SLUG, runtime: res.finalRuntime,
    session_id: res.sessionId, cost_usd: res.costUsd, duration_ms: res.durationMs, mode: JUDGE_X_SLUG,
    handoffs: res.handoffs.length ? res.handoffs : undefined, ...(budgetExhausted ? { budget_exhausted: true } : {}) });
  return { ok: res.ok, sessionId: res.sessionId, costUsd: res.costUsd, durationMs: res.durationMs, exitCode: res.exitCode,
    error: res.error, stderr: res.stderr, budgetExhausted, promptPath, promptChars: prompt.length, finalRuntime: res.finalRuntime };
}

export type JudgeXOutcome =
  | { exitCode: 0; gateOutcome: "pass"; scorecard: ScorecardFile }
  | { exitCode: 2; gateOutcome: "fail"; reason: string; budgetExhausted: boolean };

/**
 * What the judge child reports after the runtime returns. The scorecard file is the
 * contract: present and valid against the requirements, the Run is `completed` (exit 0),
 * whatever the runtime said; absent or invalid, the Run is `withheld` (exit 2) with the
 * reason, and a spent cap is named `budget_exhausted` instead of an anonymous error.
 */
export function judgeXOutcome(input: { scorecardPath: string; requirements: SuccessRequirement[]; run: Pick<JudgeXResult, "budgetExhausted" | "error">; maxBudgetUsd?: number }): JudgeXOutcome {
  const withheld = (reason: string): JudgeXOutcome => ({ exitCode: 2, gateOutcome: "fail", budgetExhausted: input.run.budgetExhausted,
    reason: input.run.budgetExhausted
      ? `${JUDGE_X_BUDGET_EXHAUSTED_MARK}: the spend cap${typeof input.maxBudgetUsd === "number" ? ` of USD ${input.maxBudgetUsd}` : ""} ended the run before ${SCORECARD_FILE} was written (${reason})`
      : reason });
  if (!fs.existsSync(input.scorecardPath)) return withheld(`${SCORECARD_FILE} not found at ${input.scorecardPath}${input.run.error ? `; runtime: ${input.run.error}` : ""}`);
  let raw: unknown;
  try { raw = JSON.parse(fs.readFileSync(input.scorecardPath, "utf8")); }
  catch (error) { return withheld(`${SCORECARD_FILE} is not valid JSON: ${(error as Error).message}`); }
  const validation = validateScorecardFile(raw, input.requirements);
  if (!validation.ok) return withheld(validation.reason);
  return { exitCode: 0, gateOutcome: "pass", scorecard: validation.scorecard };
}
