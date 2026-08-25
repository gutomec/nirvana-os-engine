import type { TargetRef } from "../run-kernel/types.ts";

export type ExecutionMode = "standard" | "gauntlet" | "auto";
export type GauntletIntensity = "light" | "balanced" | "exhaustive";
export type GauntletStopReason =
  | "success" | "max_rounds" | "max_cost" | "max_duration" | "no_progress"
  | "critical_regression" | "judge_disagreement" | "human_required" | "execution_failure";
export type GauntletDecision = "delivered" | "withheld" | "reservations";

export interface ExecutionConfig {
  mode?: ExecutionMode;
  intensity?: GauntletIntensity;
  allowAutoGauntlet?: boolean;
}

export interface SuccessRequirement {
  id: string;
  description: string;
  capability: string;
  blocking: boolean;
  minimumScore: number;
}

export interface SuccessContract {
  schemaVersion: "nirvana.success-contract/v1alpha1";
  briefDigest: string;
  requirements: SuccessRequirement[];
  humanRequired: boolean;
  ambiguities: string[];
}

export interface GauntletDefinition {
  id: string;
  capability: string;
  blocking: boolean;
  dependsOn: string[];
  holdout: { enabled: boolean; visibility: "evaluator_only" | "shared" };
}

export interface GauntletPlan {
  schemaVersion: "nirvana.gauntlet-plan/v1alpha1";
  planId: string;
  executionMode: "gauntlet";
  intensity: GauntletIntensity;
  successContract: SuccessContract;
  candidateStrategy: {
    count: number;
    diversity: { approach: "required"; model: "preferred" | "required"; runtime: "preferred" | "required" };
  };
  gauntlets: GauntletDefinition[];
  selection: { method: "evidence_weighted"; independentJudge: "required" };
  budget: { maxCostUsd: number; maxDurationSeconds: number };
  stop: {
    maxRounds: number;
    minimumScore: number;
    minimumDelta: number;
    noProgressPatience: number;
    requireRegressionPass: true;
  };
}

export interface CandidateRevision {
  candidateId: string;
  revision: number;
  revisionId: string;
  artifactRefs: string[];
  producer: TargetRef;
  parentRevisionId?: string;
  causalEvaluationIds: string[];
  hypothesis?: string;
  createdAt: string;
}

export interface ScoreDimension {
  id: string;
  score: number;
  confidence: number;
  blocking: boolean;
  passed: boolean;
  evidenceRefs: string[];
}

export interface EvaluationScorecard {
  evaluationId: string;
  candidateId: string;
  revisionId: string;
  gauntletId: string;
  rubricVersion: string;
  verdict: "pass" | "revise" | "reject" | "indeterminate";
  dimensions: ScoreDimension[];
  regressions: string[];
  revisionRequests: Array<{ requirementId: string; evidenceRefs: string[] }>;
  evaluator: TargetRef;
  costUsd: number;
  createdAt: string;
}

export interface GauntletProjection {
  projectId: string;
  runId: string;
  traceId: string;
  plan: GauntletPlan;
  state: "ready" | "producing" | "evaluating" | "revising" | "regression_testing" | "selecting" | "stopped";
  round: number;
  spentUsd: number;
  startedAt: string;
  bestScore: number;
  flatRounds: number;
  decision?: GauntletDecision;
  stopReason?: GauntletStopReason;
  selectedRevisionId?: string;
  reservations: string[];
  version: number;
}

export interface EvaluatorDescriptor {
  id: string;
  target: TargetRef;
  capabilities: string[];
  priority?: number;
}
