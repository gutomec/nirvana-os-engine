import type { KernelHandle } from "../run-kernel/store.ts";
import { targetsAreIndependent } from "./evaluator-registry.ts";
import {
  beginGauntlet, getGauntlet, listCandidateRevisions, listScorecards, saveCandidateRevision,
  saveScorecard, updateGauntlet, type GauntletContext,
} from "./store.ts";
import type { CandidateRevision, EvaluationScorecard, GauntletPlan, GauntletProjection, GauntletStopReason } from "./types.ts";

function weightedScore(scorecards: EvaluationScorecard[]): number {
  const dimensions = scorecards.flatMap(scorecard => scorecard.dimensions);
  const weight = dimensions.reduce((sum, dimension) => sum + dimension.confidence, 0);
  return weight === 0 ? 0 : dimensions.reduce((sum, dimension) => sum + dimension.score * dimension.confidence, 0) / weight;
}

/** Judges disagree only about the same candidate revision on the same gauntlet; sibling candidates may legitimately differ. */
function hasJudgeDisagreement(scorecards: EvaluationScorecard[]): boolean {
  const verdicts = new Map<string, Set<string>>();
  for (const scorecard of scorecards) {
    const key = `${scorecard.revisionId}:${scorecard.gauntletId}`;
    const set = verdicts.get(key) ?? new Set<string>();
    set.add(scorecard.verdict); verdicts.set(key, set);
  }
  return [...verdicts.values()].some(set => set.has("pass") && (set.has("reject") || set.has("indeterminate")));
}

/** A regression is measured within one candidate lineage: a dimension the same candidate passed before and fails now. */
function criticalRegression(previous: EvaluationScorecard[], current: EvaluationScorecard[]): string[] {
  const passed = new Map<string, boolean>();
  for (const scorecard of previous) for (const dimension of scorecard.dimensions) {
    if (dimension.passed) passed.set(`${scorecard.candidateId}:${dimension.id}`, dimension.blocking);
  }
  return current.flatMap(scorecard => scorecard.dimensions
    .filter(dimension => {
      const key = `${scorecard.candidateId}:${dimension.id}`;
      return passed.has(key) && !dimension.passed && (dimension.blocking || passed.get(key));
    })
    .map(dimension => dimension.id));
}

interface RankedRevision { revisionId: string; score: number; blockingFailure: boolean; nonBlockingFailures: string[] }

/** Evidence-weighted ranking per candidate revision: no blocking failure first, then the highest score, then the stable id. */
function rankRevisions(scorecards: EvaluationScorecard[]): RankedRevision[] {
  const groups = new Map<string, EvaluationScorecard[]>();
  for (const scorecard of scorecards) groups.set(scorecard.revisionId, [...(groups.get(scorecard.revisionId) ?? []), scorecard]);
  return [...groups.entries()].map(([revisionId, cards]) => ({
    revisionId, score: weightedScore(cards),
    blockingFailure: cards.some(card => card.dimensions.some(dimension => dimension.blocking && !dimension.passed)),
    nonBlockingFailures: cards.flatMap(card => card.dimensions.filter(dimension => !dimension.blocking && !dimension.passed).map(dimension => dimension.id)),
  })).sort((a, b) => Number(a.blockingFailure) - Number(b.blockingFailure) || b.score - a.score || a.revisionId.localeCompare(b.revisionId));
}

export class GauntletController {
  constructor(private readonly handle: KernelHandle, private readonly context: GauntletContext) {}

  begin(plan: GauntletPlan, startedAt?: string): GauntletProjection {
    return beginGauntlet(this.handle, this.context, plan, startedAt);
  }

  resume(): GauntletProjection {
    const projection = getGauntlet(this.handle, this.context.projectId, this.context.runId);
    if (!projection) throw new Error("gauntlet: run has not been initialized");
    return projection;
  }

  beginRound(expectedCostUsd: number, now = new Date().toISOString()): GauntletProjection {
    const current = this.resume();
    if (current.state === "stopped") return current;
    if (current.state === "producing") return current;
    const elapsed = (Date.parse(now) - Date.parse(current.startedAt)) / 1000;
    if (elapsed >= current.plan.budget.maxDurationSeconds) return this.stop(current, "max_duration", "withheld", now);
    if (current.round >= current.plan.stop.maxRounds) return this.stop(current, "max_rounds", "withheld", now);
    if (expectedCostUsd < 0) throw new Error("gauntlet: expected cost cannot be negative");
    if (current.spentUsd + expectedCostUsd > current.plan.budget.maxCostUsd) return this.stop(current, "max_cost", "withheld", now);
    return updateGauntlet(this.handle, this.context, {
      ...current, state: "producing", round: current.round + 1, spentUsd: current.spentUsd + expectedCostUsd, version: current.version + 1,
    }, { type: "gauntlet.round_started", idempotencyKey: `gauntlet:${current.runId}:round:${current.round + 1}`,
      occurredAt: now, payload: { round: current.round + 1, costReservedUsd: expectedCostUsd } });
  }

  addCandidate(candidate: CandidateRevision): CandidateRevision {
    const current = this.resume();
    if (current.state !== "producing" && current.state !== "revising") throw new Error(`gauntlet: cannot add candidate while ${current.state}`);
    return saveCandidateRevision(this.handle, this.context, candidate);
  }

  evaluateRound(scorecards: EvaluationScorecard[], now = new Date().toISOString()): GauntletProjection {
    const current = this.resume();
    if (current.state !== "producing" && current.state !== "regression_testing") throw new Error(`gauntlet: cannot evaluate while ${current.state}`);
    if (!scorecards.length) return this.stop(current, "execution_failure", "withheld", now);
    const revisions = listCandidateRevisions(this.handle, this.context.projectId, this.context.runId);
    for (const scorecard of scorecards) {
      const candidate = revisions.find(revision => revision.revisionId === scorecard.revisionId && revision.candidateId === scorecard.candidateId);
      if (!candidate) throw new Error(`gauntlet: candidate revision '${scorecard.revisionId}' not found`);
      if (!targetsAreIndependent(candidate.producer, scorecard.evaluator)) throw new Error("gauntlet: producer cannot evaluate its own candidate");
    }
    // Scorecards, the round evaluation and the follow-up decision commit together, so a crash
    // leaves the round in `producing` and the caller replays the same evaluation.
    return this.handle.db.transaction(() => {
      const previous = listScorecards(this.handle, this.context.projectId, this.context.runId);
      for (const scorecard of scorecards) saveScorecard(this.handle, this.context, scorecard);
      const best = rankRevisions(scorecards)[0];
      const evaluationKey = scorecards.map(scorecard => scorecard.evaluationId).sort().join(",");
      const regressions = criticalRegression(previous, scorecards);
      const improved = best.score - current.bestScore >= current.plan.stop.minimumDelta;
      const flatRounds = improved ? 0 : current.flatRounds + 1;
      const base = { ...current, state: "evaluating" as const, bestScore: Math.max(current.bestScore, best.score), flatRounds, version: current.version + 1 };
      updateGauntlet(this.handle, this.context, base, { type: "gauntlet.round_evaluated",
        idempotencyKey: `gauntlet:${current.runId}:round:${current.round}:evaluated:${evaluationKey}`, occurredAt: now,
        payload: { round: current.round, score: best.score, improved, regressions, blockingFailure: best.blockingFailure, bestRevisionId: best.revisionId } });
      if (regressions.length) return this.stop(base, "critical_regression", "withheld", now, regressions);
      if (hasJudgeDisagreement(scorecards)) return this.stop(base, "judge_disagreement", "withheld", now);
      if (!best.blockingFailure && best.score >= current.plan.stop.minimumScore) {
        return this.stop(base, "success", best.nonBlockingFailures.length ? "reservations" : "delivered", now, best.nonBlockingFailures, best.revisionId);
      }
      if (flatRounds >= current.plan.stop.noProgressPatience) return this.stop(base, "no_progress", "withheld", now);
      if (current.round >= current.plan.stop.maxRounds) return this.stop(base, "max_rounds", "withheld", now);
      return updateGauntlet(this.handle, this.context, { ...base, state: "revising", version: base.version + 1 }, {
        type: "gauntlet.revision_requested", idempotencyKey: `gauntlet:${current.runId}:round:${current.round}:revision`, occurredAt: now,
        payload: { evaluationIds: scorecards.map(scorecard => scorecard.evaluationId), revisionRequests: scorecards.flatMap(scorecard => scorecard.revisionRequests) },
      });
    }).immediate();
  }

  markRegressionTesting(now = new Date().toISOString()): GauntletProjection {
    const current = this.resume();
    if (current.state !== "revising") throw new Error(`gauntlet: cannot start regression testing while ${current.state}`);
    return updateGauntlet(this.handle, this.context, { ...current, state: "regression_testing", version: current.version + 1 }, {
      type: "gauntlet.regression_started", idempotencyKey: `gauntlet:${current.runId}:round:${current.round}:regression`, occurredAt: now,
    });
  }

  fail(reason = "execution failure", now = new Date().toISOString()): GauntletProjection {
    return this.stop(this.resume(), "execution_failure", "withheld", now, [reason]);
  }

  private stop(current: GauntletProjection, reason: GauntletStopReason, decision: "delivered" | "withheld" | "reservations", now: string,
    reservations: string[] = [], selectedRevisionId?: string): GauntletProjection {
    if (current.state === "stopped") return current;
    return updateGauntlet(this.handle, this.context, { ...current, state: "stopped", stopReason: reason, decision,
      reservations, ...(selectedRevisionId ? { selectedRevisionId } : {}), version: current.version + 1 }, {
      type: "gauntlet.stopped", idempotencyKey: `gauntlet:${current.runId}:stopped`, occurredAt: now,
      payload: { reason, decision, reservations, selectedRevisionId: selectedRevisionId ?? null, finalQualityGateRequired: true },
    });
  }
}
