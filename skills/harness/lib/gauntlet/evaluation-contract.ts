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
  dimensions: [{ id: "<id do requisito>", score: 0.6, confidence: 0.9, blocking: true, passed: false, evidenceRefs: ["<caminho ou trecho dentro do candidate>"] }],
  revisionRequests: [{ requirementId: "<id do requisito>", evidenceRefs: ["<o que falta ou está errado, com referência>"] }],
  regressions: [],
};

/**
 * The evaluation brief (PT-BR, like every brief the engine hands an executor).
 * Deterministic for one request and one original brief, so a repeated
 * evaluation of the same revision writes the same file.
 */
export function renderEvaluationBrief(request: EvaluationRequest, originalBrief: string): string {
  const requirementRows = request.requirements.map(requirement =>
    `| \`${requirement.id}\` | \`${requirement.capability}\` | ${requirement.blocking ? "sim" : "não"} | ${requirement.minimumScore} | ${requirement.description} |`);
  return [
    "# Avaliação independente de candidate (Gauntlet)",
    "",
    `Você é o avaliador independente da rodada ${request.round} do Run \`${request.runId}\` (projeto \`${request.projectId}\`).`,
    `Objeto da avaliação: candidate \`${request.candidateId}\`, revisão ${request.revision} (\`${request.revisionId}\`).`,
    "",
    "## Regra inegociável",
    "",
    "Você não produz nem edita o entregável. Sua única saída é o scorecard descrito abaixo.",
    `O diretório do candidate é somente leitura: \`${request.candidateRoot}\`. Não crie, altere nem remova arquivos nele.`,
    "Não escreva em nenhum outro lugar além do arquivo de scorecard.",
    "A tarefa não exige shell nem execução de comandos: ler os arquivos do candidate com a ferramenta de leitura basta.",
    scopeGuard("pt-BR"),
    "",
    "## Brief original (o que o candidate deveria entregar)",
    "",
    originalBrief.trim(),
    "",
    "## Contrato de sucesso (uma dimensão por requisito)",
    "",
    "| id | capability | bloqueante | nota mínima | descrição |",
    "|---|---|---|---|---|",
    ...requirementRows,
    "",
    "## O que escrever",
    "",
    `Escreva exatamente um arquivo, \`${SCORECARD_FILE}\`, no seu output_path (caminho absoluto: \`${request.scorecardPath}\`), com este formato JSON:`,
    "",
    "```json",
    JSON.stringify(SCORECARD_EXAMPLE, null, 2),
    "```",
    "",
    "Regras do scorecard:",
    "",
    "- Uma dimensão por requisito do contrato, com o `id` exatamente como declarado; nenhuma dimensão fora do contrato.",
    "- `score` e `confidence` entre 0 e 1. `blocking` igual ao contrato.",
    "- `passed` só pode ser `true` com `score` maior ou igual à nota mínima do requisito.",
    "- `verdict` é `pass` somente com todas as dimensões aprovadas; senão `revise`, `reject` ou `indeterminate`.",
    "- `revisionRequests` aponta os requisitos a revisar, com evidências verificáveis (caminho de arquivo, trecho, linha).",
    "- `regressions` lista requisitos que pioraram em relação à revisão anterior, quando você tiver essa informação; senão `[]`.",
    "- `evidenceRefs` são caminhos ou referências verificáveis dentro do candidate.",
    "",
    "Scorecard ausente, inválido ou com dimensão fora do contrato conta como `indeterminate` e reprova a avaliação. Nunca há aprovação implícita.",
    ...(request.holdout ? ["", "Este plano marca a avaliação como holdout `evaluator_only`: seus critérios e evidências não são compartilhados com o produtor."] : []),
    "",
  ].join("\n");
}
