import { createHash } from "node:crypto";
import { canonicalJson } from "../run-kernel/canonical-json.ts";
import type { CompiledGauntletDecision, CompiledMultiTargetPlan } from "../plan-compiler.ts";
import type { GauntletIntensity } from "./types.ts";

const USD_SCALE = 1_000_000;
const SAFE_MINIMUM_USD: Record<GauntletIntensity, number> = {
  light: 1,
  balanced: 2,
  exhaustive: 5,
};

export interface GauntletBudgetAllocation {
  nodeId: string;
  targetKind: CompiledGauntletDecision["targetKind"];
  waveIndex: number;
  requestedUsd: number;
  grantedUsd: number;
  balanceUsd: number;
  reason: "standard_no_reservation" | "requested_in_full" | "reduced_to_aggregate_cap" | "aggregate_cap_rejected";
}

export interface GauntletWaveReservation {
  waveIndex: number;
  nodeIds: string[];
  requestedUsd: number;
  grantedUsd: number;
}

export interface AggregateGauntletBudgetReservation {
  schemaVersion: "nirvana.gauntlet-aggregate-budget/v1alpha1";
  policyDigest: string;
  status: "reserved" | "rejected";
  aggregateCapUsd: number;
  requestedUsd: number;
  grantedUsd: number;
  balanceUsd: number;
  allocations: GauntletBudgetAllocation[];
  waves: GauntletWaveReservation[];
  reason: string;
  digest: string;
}

const toMicros = (usd: number): number => Math.floor(usd * USD_SCALE);
const toUsd = (micros: number): number => micros / USD_SCALE;

function waveIndex(plan: CompiledMultiTargetPlan, nodeId: string): number {
  return plan.manifest.parallel_waves.findIndex((wave) => wave.includes(nodeId));
}

function activeDecisions(plan: CompiledMultiTargetPlan): CompiledGauntletDecision[] {
  return [...plan.decisions, ...(plan.synthesis ? [plan.synthesis] : [])]
    .sort((left, right) => left.nodeId.localeCompare(right.nodeId));
}

function minimumMicros(decision: CompiledGauntletDecision): number {
  if (decision.mode !== "gauntlet" || !decision.intensity) return 0;
  return toMicros(SAFE_MINIMUM_USD[decision.intensity]);
}

function distributeProportionally(
  decisions: CompiledGauntletDecision[],
  requested: Map<string, number>,
  granted: Map<string, number>,
  available: number
): number {
  const eligible = decisions
    .map((decision) => ({ decision, unmet: requested.get(decision.nodeId)! - granted.get(decision.nodeId)! }))
    .filter(({ unmet }) => unmet > 0);
  const totalUnmet = eligible.reduce((sum, item) => sum + item.unmet, 0);
  if (!totalUnmet || !available) return available;

  const shares = eligible.map((item) => {
    const exact = available * item.unmet / totalUnmet;
    const base = Math.floor(exact);
    granted.set(item.decision.nodeId, granted.get(item.decision.nodeId)! + base);
    return { ...item, remainder: exact - base };
  });
  let remainder = available - shares.reduce((sum, item) => sum + Math.floor(available * item.unmet / totalUnmet), 0);
  shares.sort((left, right) => right.remainder - left.remainder || left.decision.nodeId.localeCompare(right.decision.nodeId));
  for (const item of shares) {
    if (!remainder) break;
    granted.set(item.decision.nodeId, granted.get(item.decision.nodeId)! + 1);
    remainder--;
  }
  return remainder;
}

/**
 * Reserves aggregate cost only. Duration is concurrent across waves and rounds
 * are local stop limits, so summing either would invent a false global limit.
 * A null result preserves plans without an explicit policy and aggregate cap.
 */
export function reserveAggregateGauntletBudget(
  plan: CompiledMultiTargetPlan
): { reservation: AggregateGauntletBudgetReservation | null; issues: Array<{ path: string; message: string }> } {
  const cap = plan.policySnapshot?.limits?.maxCostUsd;
  if (!plan.policySnapshot || cap === undefined) return { reservation: null, issues: [] };
  if (!Number.isFinite(cap) || cap < 0) {
    return { reservation: null, issues: [{ path: "/policySnapshot/limits/maxCostUsd", message: "must be a non-negative finite number" }] };
  }

  const decisions = activeDecisions(plan);
  const requested = new Map(decisions.map((decision) => [
    decision.nodeId,
    decision.mode === "gauntlet" ? toMicros(decision.limits?.maxCostUsd ?? 0) : 0,
  ]));
  const granted = new Map(decisions.map((decision) => [decision.nodeId, 0]));
  const capMicros = toMicros(cap);
  const requestedTotal = [...requested.values()].reduce((sum, value) => sum + value, 0);
  const minimumTotal = decisions.reduce((sum, decision) => sum + minimumMicros(decision), 0);
  const unsafeDecision = decisions.find((decision) => requested.get(decision.nodeId)! < minimumMicros(decision));
  const rejected = minimumTotal > capMicros || !!unsafeDecision;

  if (!rejected) {
    for (const decision of decisions) granted.set(decision.nodeId, minimumMicros(decision));
    let available = Math.min(capMicros - minimumTotal, requestedTotal - minimumTotal);
    const synthesis = decisions.find((decision) => decision.targetKind === "synthesis" && decision.mode === "gauntlet");
    if (synthesis) {
      const extra = Math.min(available, requested.get(synthesis.nodeId)! - granted.get(synthesis.nodeId)!);
      granted.set(synthesis.nodeId, granted.get(synthesis.nodeId)! + extra);
      available -= extra;
    }
    distributeProportionally(
      decisions.filter((decision) => decision.targetKind !== "synthesis" && decision.mode === "gauntlet"),
      requested,
      granted,
      available
    );
  }

  const grantedTotal = [...granted.values()].reduce((sum, value) => sum + value, 0);
  const allocations: GauntletBudgetAllocation[] = decisions.map((decision) => {
    const requestedMicros = requested.get(decision.nodeId)!;
    const grantedMicros = granted.get(decision.nodeId)!;
    const reason = decision.mode === "standard"
      ? "standard_no_reservation"
      : rejected
        ? "aggregate_cap_rejected"
        : grantedMicros === requestedMicros
          ? "requested_in_full"
          : "reduced_to_aggregate_cap";
    return {
      nodeId: decision.nodeId,
      targetKind: decision.targetKind,
      waveIndex: waveIndex(plan, decision.nodeId),
      requestedUsd: toUsd(requestedMicros),
      grantedUsd: toUsd(grantedMicros),
      balanceUsd: toUsd(requestedMicros - grantedMicros),
      reason,
    };
  });
  const waves = plan.manifest.parallel_waves.map((nodeIds, index) => {
    const members = allocations.filter((allocation) => allocation.waveIndex === index);
    return {
      waveIndex: index,
      nodeIds: [...nodeIds].sort(),
      requestedUsd: toUsd(members.reduce((sum, item) => sum + requested.get(item.nodeId)!, 0)),
      grantedUsd: toUsd(members.reduce((sum, item) => sum + granted.get(item.nodeId)!, 0)),
    };
  });
  const snapshot = {
    schemaVersion: "nirvana.gauntlet-aggregate-budget/v1alpha1" as const,
    policyDigest: plan.digest,
    status: rejected ? "rejected" as const : "reserved" as const,
    aggregateCapUsd: cap,
    requestedUsd: toUsd(requestedTotal),
    grantedUsd: toUsd(grantedTotal),
    balanceUsd: toUsd(capMicros - grantedTotal),
    allocations,
    waves,
    reason: unsafeDecision
      ? `decision ${unsafeDecision.nodeId} requests less than its safe minimum`
      : rejected
        ? `aggregate cap cannot fund the safe minimum of $${toUsd(minimumTotal).toFixed(6)}`
      : requestedTotal <= capMicros
        ? "all gauntlet requests fit within the aggregate cap"
        : "requests were reduced deterministically within the aggregate cap",
  };
  const digest = createHash("sha256").update(canonicalJson(snapshot)).digest("hex");
  return { reservation: { ...snapshot, digest }, issues: [] };
}
