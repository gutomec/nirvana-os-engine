// evaluation-contract.ts — what an independent Gauntlet evaluator receives and
// what it must write back.
//
// The evaluator is any dispatch target (an installed squad or agent-x) that runs
// as a subprocess of dispatch.ts (see evaluator-adapter.ts). It receives one
// evaluation brief (PT-BR, the language of every brief the engine hands an
// executor) and one machine-readable request, both inside an isolated
// evaluation directory, and it writes exactly one file, scorecard.json, into
// the outputs root the adapter hands the subprocess: `<evaluationDir>/outputs/`,
// empty before the spawn. The adapter's own files stay one level up, so the
// child dispatch can never count them as artifacts of an executor that wrote
// nothing.
//
// The scorecard file is validated strictly against the plan's SuccessContract:
// one dimension per requirement, ids exactly as declared, scores in [0, 1], no
// pass below a requirement's minimum, no `pass` verdict with a failed dimension.
// Anything else (a missing file, invalid JSON, an unknown key, a dimension the
// contract never declared, a requirement left unscored) turns into an
// `indeterminate` scorecard whose blocking dimensions all fail with the reason
// as evidence. A pass is never implied.
//
// Documentation: docs/architecture/gauntlet-evaluator-contract.md.

import { z } from "zod";
import { scopeGuard } from "../../../_shared/lib/scope-guard.ts";
import type { EvaluationScorecard, GauntletPlan, ScoreDimension, SuccessRequirement } from "./types.ts";

export const SCORECARD_FILE = "scorecard.json";
export const EVALUATION_BRIEF_FILE = "evaluation-brief.md";
export const EVALUATION_REQUEST_FILE = "evaluation-request.json";
/** Outputs root handed to the evaluator subprocess, under the evaluation directory; the scorecard lives here. */
export const EVALUATION_OUTPUTS_DIR = "outputs";
export const SCORECARD_SCHEMA_VERSION = "nirvana.gauntlet-scorecard/v1alpha1";
export const EVALUATION_REQUEST_SCHEMA_VERSION = "nirvana.gauntlet-evaluation-request/v1alpha1";
/** Rubric the adapter stamps on every scorecard it builds from a file. */
export const EVALUATION_RUBRIC_VERSION = "gauntlet-evaluator/v1";

/** The request the adapter writes beside the brief: everything a tool (or a test fake) needs without parsing markdown. */
export interface EvaluationRequest {
  schemaVersion: typeof EVALUATION_REQUEST_SCHEMA_VERSION;
  projectId: string;
  runId: string;
  candidateId: string;
  revisionId: string;
  revision: number;
  round: number;
  holdout: boolean;
  /** Read-only for the evaluator. */
  candidateRoot: string;
  /** The one file the evaluator writes: `<evaluationDir>/outputs/scorecard.json`, inside its output_path. */
  scorecardPath: string;
  briefDigest: string;
  requirements: SuccessRequirement[];
  gauntletIds: string[];
}

const unitInterval = z.number().min(0).max(1);

const dimensionSchema = z.strictObject({
  id: z.string().min(1),
  score: unitInterval,
  confidence: unitInterval,
  blocking: z.boolean(),
  passed: z.boolean(),
  evidenceRefs: z.array(z.string()),
});

const revisionRequestSchema = z.strictObject({
  requirementId: z.string().min(1),
  evidenceRefs: z.array(z.string()),
});

/** Shape of scorecard.json. `schemaVersion` is optional so a minimal file validates; when present it must match. */
export const scorecardFileSchema = z.strictObject({
  schemaVersion: z.literal(SCORECARD_SCHEMA_VERSION).optional(),
  verdict: z.enum(["pass", "revise", "reject", "indeterminate"]),
  dimensions: z.array(dimensionSchema).min(1),
  revisionRequests: z.array(revisionRequestSchema),
  regressions: z.array(z.string()),
});

export type ScorecardFile = z.infer<typeof scorecardFileSchema>;

export type ScorecardValidation =
  | { ok: true; scorecard: ScorecardFile }
  | { ok: false; reason: string };

function formatIssues(error: z.ZodError): string {
  return error.issues.slice(0, 5).map(issue => `${issue.path.join(".") || "<root>"}: ${issue.message}`).join("; ");
}

/**
 * Strict validation of a parsed scorecard file against the plan's requirements.
 * Shape first (zod, unknown keys rejected), then the contract rules: every
 * requirement scored exactly once, no dimension outside the contract, `blocking`
 * as the contract declares it, no pass below the minimum score, a `pass` verdict
 * only when every dimension passed, and revision requests and regressions that
 * name contract requirements.
 */
export function validateScorecardFile(raw: unknown, requirements: SuccessRequirement[]): ScorecardValidation {
  const parsed = scorecardFileSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: `scorecard.json does not match the schema: ${formatIssues(parsed.error)}` };
  const scorecard = parsed.data;
  const byId = new Map(requirements.map(requirement => [requirement.id, requirement]));
  const seen = new Set<string>();
  for (const dimension of scorecard.dimensions) {
    const requirement = byId.get(dimension.id);
    if (!requirement) return { ok: false, reason: `dimension '${dimension.id}' is not in the success contract (${[...byId.keys()].join(", ")})` };
    if (seen.has(dimension.id)) return { ok: false, reason: `dimension '${dimension.id}' is scored twice` };
    seen.add(dimension.id);
    if (dimension.blocking !== requirement.blocking) {
      return { ok: false, reason: `dimension '${dimension.id}' declares blocking=${dimension.blocking}; the contract says ${requirement.blocking}` };
    }
    if (dimension.passed && dimension.score < requirement.minimumScore) {
      return { ok: false, reason: `dimension '${dimension.id}' passed with score ${dimension.score} below the minimum ${requirement.minimumScore}` };
    }
  }
  for (const requirement of requirements) {
    if (!seen.has(requirement.id)) return { ok: false, reason: `requirement '${requirement.id}' was not scored` };
  }
  const allPassed = scorecard.dimensions.every(dimension => dimension.passed);
  if (scorecard.verdict === "pass" && !allPassed) return { ok: false, reason: "verdict 'pass' with a failed dimension" };
  if (scorecard.verdict !== "pass" && allPassed) return { ok: false, reason: `verdict '${scorecard.verdict}' with every dimension passed` };
  for (const request of scorecard.revisionRequests) {
    if (!byId.has(request.requirementId)) return { ok: false, reason: `revision request for unknown requirement '${request.requirementId}'` };
  }
  for (const regression of scorecard.regressions) {
    if (!byId.has(regression)) return { ok: false, reason: `regression on unknown requirement '${regression}'` };
  }
  return { ok: true, scorecard };
}

/** The dimensions of an evaluation that could not judge: every requirement fails, blocking as declared, the reason as evidence. */
export function indeterminateDimensions(requirements: SuccessRequirement[], reason: string): ScoreDimension[] {
  return requirements.map(requirement => ({
    id: requirement.id, score: 0, confidence: 1, blocking: requirement.blocking, passed: false, evidenceRefs: [`indeterminate: ${reason}`],
  }));
}

/** Gauntlet id recorded on a scorecard built from one evaluation of the whole contract. */
export function scorecardGauntletId(plan: GauntletPlan): string {
  return plan.gauntlets.map(gauntlet => gauntlet.id).join(",");
}

export type ScorecardIdentity = Pick<EvaluationScorecard, "evaluationId" | "candidateId" | "revisionId" | "gauntletId" | "evaluator" | "costUsd" | "createdAt">;

/** An `EvaluationScorecard` from a validated file plus the identity the adapter owns. */
export function scorecardFromFile(file: ScorecardFile, identity: ScorecardIdentity): EvaluationScorecard {
  return {
    ...identity, rubricVersion: EVALUATION_RUBRIC_VERSION, verdict: file.verdict,
    dimensions: file.dimensions.map(dimension => ({ ...dimension, evidenceRefs: [...dimension.evidenceRefs] })),
    regressions: [...file.regressions],
    revisionRequests: file.revisionRequests.map(request => ({ requirementId: request.requirementId, evidenceRefs: [...request.evidenceRefs] })),
  };
}

/** The `indeterminate` scorecard: never a pass, the reason visible on every dimension. */
export function indeterminateScorecard(requirements: SuccessRequirement[], reason: string, identity: ScorecardIdentity): EvaluationScorecard {
  return {
    ...identity, rubricVersion: EVALUATION_RUBRIC_VERSION, verdict: "indeterminate",
    dimensions: indeterminateDimensions(requirements, reason), regressions: [], revisionRequests: [],
  };
}

const SCORECARD_EXAMPLE = {
  schemaVersion: SCORECARD_SCHEMA_VERSION,
  verdict: "revise",
  dimensions: [{ id: "<requirement id>", score: 0.6, confidence: 0.9, blocking: true, passed: false, evidenceRefs: ["<path or excerpt inside the candidate>"] }],
  revisionRequests: [{ requirementId: "<requirement id>", evidenceRefs: ["<what is missing or wrong, with a reference>"] }],
  regressions: [],
};

/**
 * The evaluation brief (English, like every brief the engine hands an executor).
 * Deterministic for one request and one original brief, so a repeated
 * evaluation of the same revision writes the same file.
 */
export function renderEvaluationBrief(request: EvaluationRequest, originalBrief: string): string {
  const requirementRows = request.requirements.map(requirement =>
    `| \`${requirement.id}\` | \`${requirement.capability}\` | ${requirement.blocking ? "yes" : "no"} | ${requirement.minimumScore} | ${requirement.description} |`);
  return [
    "# Independent candidate evaluation (Gauntlet)",
    "",
    `You are the independent evaluator for round ${request.round} of Run \`${request.runId}\` (project \`${request.projectId}\`).`,
    `Object of the evaluation: candidate \`${request.candidateId}\`, revision ${request.revision} (\`${request.revisionId}\`).`,
    "",
    "## Non-negotiable rule",
    "",
    "You do not produce or edit the deliverable. Your only output is the scorecard described below.",
    `The candidate directory is read-only: \`${request.candidateRoot}\`. Do not create, change or remove files in it.`,
    "Do not write anywhere other than the scorecard file.",
    "You have a shell available to OBSERVE the candidate (run its tests, measure real behavior, open a browser when your environment has one), never to create, change, remove or produce anything in it. A behavior claim (\"the tests pass\", \"the UI renders X\") is not evidence until you run or see what it claims yourself; reading the files alone is not enough when the claim can be checked by running something.",
    scopeGuard(),
    "",
    "## Original brief (what the candidate was supposed to deliver)",
    "",
    originalBrief.trim(),
    "",
    "## Success contract (one dimension per requirement)",
    "",
    "| id | capability | blocking | minimum score | description |",
    "|---|---|---|---|---|",
    ...requirementRows,
    "",
    "## What to write",
    "",
    `Write exactly one file, \`${SCORECARD_FILE}\`, in your output_path (absolute path: \`${request.scorecardPath}\`), in this JSON format:`,
    "",
    "```json",
    JSON.stringify(SCORECARD_EXAMPLE, null, 2),
    "```",
    "",
    "Scorecard rules:",
    "",
    "- One dimension per contract requirement, with the `id` exactly as declared; no dimension outside the contract.",
    "- `score` and `confidence` between 0 and 1. `blocking` equal to the contract.",
    "- `passed` can only be `true` with a `score` greater than or equal to the requirement's minimum score.",
    "- `verdict` is `pass` only when every dimension passed; otherwise `revise`, `reject` or `indeterminate`.",
    "- `revisionRequests` points to the requirements to revise, with verifiable evidence (file path, excerpt, line).",
    "- `regressions` lists requirements that got worse compared with the previous revision, when you have that information; otherwise `[]`.",
    "- `evidenceRefs` are paths or verifiable references inside the candidate.",
    "",
    "A missing or invalid scorecard, or one with a dimension outside the contract, counts as `indeterminate` and fails the evaluation. There is never an implicit pass.",
    ...(request.holdout ? ["", "This plan marks the evaluation as holdout `evaluator_only`: its criteria and evidence are not shared with the producer."] : []),
    "",
  ].join("\n");
}
