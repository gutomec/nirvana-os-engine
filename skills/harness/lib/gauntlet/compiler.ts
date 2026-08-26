import { createHash } from "node:crypto";
import { canonicalJson } from "../run-kernel/canonical-json.ts";
import type { ExecutionConfig, GauntletIntensity, GauntletPlan, SuccessRequirement } from "./types.ts";

const PROFILES = {
  // `light` was USD 5: one candidate, two rounds, a USD 2.50 slice per candidate that the
  // evaluation floor (GAUNTLET_EVALUATION_FLOOR_USD, USD 1.50) would leave the producer USD 1.00
  // of, below what one real candidate costs (USD 1.65 in the first smoke). USD 8 gives each
  // slice USD 4: USD 2.50 to the producer, USD 1.50 to the judge.
  light: { candidates: 1, rounds: 2, cost: 8, duration: 1800, score: 0.85, delta: 0.03, patience: 1, model: "preferred", runtime: "preferred", holdout: false },
  balanced: { candidates: 3, rounds: 4, cost: 25, duration: 7200, score: 0.92, delta: 0.03, patience: 2, model: "preferred", runtime: "preferred", holdout: true },
  exhaustive: { candidates: 5, rounds: 6, cost: 100, duration: 21600, score: 0.96, delta: 0.02, patience: 2, model: "required", runtime: "required", holdout: true },
} as const;

export interface CompileGauntletInput {
  brief: string;
  intensity?: GauntletIntensity;
  requirements?: SuccessRequirement[];
  ambiguities?: string[];
  budget?: Partial<GauntletPlan["budget"]>;
  stop?: Partial<GauntletPlan["stop"]>;
}

function digest(value: unknown): string {
  return createHash("sha256").update(typeof value === "string" ? value : canonicalJson(value)).digest("hex");
}

export function resolveExecutionMode(config: ExecutionConfig = {}, signals: { verifiable?: boolean; risk?: "low" | "medium" | "high" } = {}): {
  mode: "standard" | "gauntlet";
  reason: string;
} {
  const requested = config.mode ?? "standard";
  if (requested === "standard") return { mode: "standard", reason: "standard is the backward-compatible default" };
  if (requested === "gauntlet") return { mode: "gauntlet", reason: "gauntlet was explicitly requested" };
  if (!config.allowAutoGauntlet) return { mode: "standard", reason: "project policy does not allow automatic gauntlet selection" };
  if (signals.verifiable && (signals.risk === "medium" || signals.risk === "high")) {
    return { mode: "gauntlet", reason: `auto selected gauntlet for a verifiable ${signals.risk}-risk brief` };
  }
  return { mode: "standard", reason: "auto found insufficient risk or verifiability" };
}

export function compileGauntletPlan(input: CompileGauntletInput): GauntletPlan {
  const brief = input.brief.trim();
  if (!brief) throw new Error("gauntlet: brief is required");
  const intensity = input.intensity ?? "balanced";
  const profile = PROFILES[intensity];
  const requirements = input.requirements?.length ? input.requirements : [{
    id: "brief-conformance", description: "The candidate satisfies the explicit brief", capability: "quality.specification_conformance",
    blocking: true, minimumScore: profile.score,
  }];
  const ambiguities = input.ambiguities?.filter(Boolean) ?? [];
  const successContract = {
    schemaVersion: "nirvana.success-contract/v1alpha1" as const,
    briefDigest: digest(brief), requirements, humanRequired: ambiguities.length > 0, ambiguities,
  };
  const gauntlets = requirements.map((requirement, index) => ({
    id: requirement.id, capability: requirement.capability, blocking: requirement.blocking,
    dependsOn: index === 0 ? [] : [requirements[index - 1].id],
    holdout: { enabled: profile.holdout && requirement.blocking, visibility: "evaluator_only" as const },
  }));
  const material = { intensity, successContract, requirements, budget: input.budget, stop: input.stop };
  return {
    schemaVersion: "nirvana.gauntlet-plan/v1alpha1", planId: `gpl_${digest(material).slice(0, 24)}`,
    executionMode: "gauntlet", intensity, successContract,
    candidateStrategy: { count: profile.candidates, diversity: { approach: "required", model: profile.model, runtime: profile.runtime } },
    gauntlets, selection: { method: "evidence_weighted", independentJudge: "required" },
    budget: { maxCostUsd: input.budget?.maxCostUsd ?? profile.cost, maxDurationSeconds: input.budget?.maxDurationSeconds ?? profile.duration },
    stop: {
      maxRounds: input.stop?.maxRounds ?? profile.rounds, minimumScore: input.stop?.minimumScore ?? profile.score,
      minimumDelta: input.stop?.minimumDelta ?? profile.delta, noProgressPatience: input.stop?.noProgressPatience ?? profile.patience,
      requireRegressionPass: true,
    },
  };
}
