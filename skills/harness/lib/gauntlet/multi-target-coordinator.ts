import { createHash } from "node:crypto";
import { canonicalJson } from "../run-kernel/canonical-json.ts";
import type { CompiledGauntletDecision, CompiledMultiTargetPlan, ManifestPhase } from "../plan-compiler.ts";
import type { AggregateGauntletBudgetReservation } from "./aggregate-budget.ts";

export type MultiTargetNodeState = "pending" | "running" | "delivered" | "withheld" | "failed" | "skipped" | "stalled";

export interface MultiTargetNodeProjection {
  nodeId: string;
  waveIndex: number;
  mode: "standard" | "gauntlet";
  state: MultiTargetNodeState;
  outputPaths: string[];
  reportedCostUsd: number;
  grantedCostUsd: number;
  reason?: string;
  blockedBy: string[];
}

export interface MultiTargetCoordinatorSnapshot {
  schemaVersion: "nirvana.multi-target-coordinator/v1alpha1";
  planDigest: string;
  reservationDigest: string | null;
  state: "ready" | "running" | "delivered" | "withheld" | "failed";
  currentWave: number;
  nodes: MultiTargetNodeProjection[];
  reportedCostUsd: number;
  terminalReason?: string;
  version: number;
}

export interface MultiTargetAdapterInput {
  nodeId: string;
  target: { kind: "business" | "squad" | "agent-x" | "synthesis"; id: string };
  mode: "standard" | "gauntlet";
  intensity?: "light" | "balanced" | "exhaustive";
  grantedCostUsd: number;
  upstreamPaths: string[];
  outputPath: string;
  idempotencyKey: string;
  resume: boolean;
  /** Aborted by the port when the node lease is lost mid-run; adapters must stop their side effect. */
  signal?: AbortSignal;
}

export interface MultiTargetAdapterResult {
  state: "delivered" | "withheld" | "failed";
  reportedCostUsd: number;
  outputPaths?: string[];
  reason?: string;
}

export interface MultiTargetCoordinatorPorts {
  standard: { run(input: MultiTargetAdapterInput): Promise<MultiTargetAdapterResult> };
  gauntlet: { run(input: MultiTargetAdapterInput): Promise<MultiTargetAdapterResult> };
  state?: {
    load(): Promise<MultiTargetCoordinatorSnapshot | null> | MultiTargetCoordinatorSnapshot | null;
    save(snapshot: MultiTargetCoordinatorSnapshot): Promise<void> | void;
  };
  journal?: {
    persistSnapshots(input: { planDigest: string; reservationDigest: string | null }): Promise<void> | void;
    emit(event: { type: string; nodeId?: string; waveIndex?: number; payload?: Record<string, unknown> }): Promise<void> | void;
  };
  lease?: {
    claim?(nodeId: string): Promise<boolean> | boolean;
    canResume(nodeId: string): Promise<boolean> | boolean;
    release?(nodeId: string): Promise<boolean> | boolean;
  };
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function validateDigests(plan: CompiledMultiTargetPlan, reservation: AggregateGauntletBudgetReservation | null): void {
  const { digest: planDigest, ...planSnapshot } = plan;
  if (digest(planSnapshot) !== planDigest) throw new Error("multi-target coordinator: plan digest mismatch");
  if (!reservation) return;
  const { digest: reservationDigest, ...reservationSnapshot } = reservation;
  if (digest(reservationSnapshot) !== reservationDigest) throw new Error("multi-target coordinator: reservation digest mismatch");
  if (reservation.policyDigest !== plan.digest) throw new Error("multi-target coordinator: reservation policy digest mismatch");
  if (reservation.status === "rejected") throw new Error(`multi-target coordinator: reservation rejected: ${reservation.reason}`);
}

function decisionMap(plan: CompiledMultiTargetPlan): Map<string, CompiledGauntletDecision> {
  return new Map([...plan.decisions, ...(plan.synthesis ? [plan.synthesis] : [])].map((decision) => [decision.nodeId, decision]));
}

function phaseMap(plan: CompiledMultiTargetPlan): Map<string, ManifestPhase> {
  return new Map(plan.manifest.phases.map((phase) => [phase.id, phase]));
}

function initialSnapshot(
  plan: CompiledMultiTargetPlan,
  reservation: AggregateGauntletBudgetReservation | null
): MultiTargetCoordinatorSnapshot {
  const decisions = decisionMap(plan);
  const allocations = new Map(reservation?.allocations.map((allocation) => [allocation.nodeId, allocation]) ?? []);
  const nodes = plan.manifest.parallel_waves.flatMap((wave, waveIndex) => wave.map((nodeId) => {
    const decision = decisions.get(nodeId);
    return {
      nodeId,
      waveIndex,
      mode: decision?.mode ?? "standard",
      state: "pending",
      outputPaths: [],
      reportedCostUsd: 0,
      grantedCostUsd: allocations.get(nodeId)?.grantedUsd ?? 0,
      blockedBy: [],
    } satisfies MultiTargetNodeProjection;
  })).sort((left, right) => left.waveIndex - right.waveIndex || left.nodeId.localeCompare(right.nodeId));
  return {
    schemaVersion: "nirvana.multi-target-coordinator/v1alpha1",
    planDigest: plan.digest,
    reservationDigest: reservation?.digest ?? null,
    state: "ready",
    currentWave: -1,
    nodes,
    reportedCostUsd: 0,
    version: 1,
  };
}

function assertResumeSnapshot(
  snapshot: MultiTargetCoordinatorSnapshot,
  plan: CompiledMultiTargetPlan,
  reservation: AggregateGauntletBudgetReservation | null
): void {
  if (snapshot.planDigest !== plan.digest || snapshot.reservationDigest !== (reservation?.digest ?? null)) {
    throw new Error("multi-target coordinator: persisted snapshot does not match plan and reservation");
  }
}

function adapterTarget(decision: CompiledGauntletDecision): MultiTargetAdapterInput["target"] {
  if (decision.targetKind === "support") throw new Error(`multi-target coordinator: support node ${decision.nodeId} has no adapter`);
  return { kind: decision.targetKind, id: decision.nodeId };
}

function terminalState(snapshot: MultiTargetCoordinatorSnapshot): Pick<MultiTargetCoordinatorSnapshot, "state" | "terminalReason"> {
  const failed = snapshot.nodes.find((node) => node.state === "failed" || node.state === "stalled");
  if (failed) return { state: "failed", terminalReason: failed.reason ?? `node ${failed.nodeId} failed` };
  const withheld = snapshot.nodes.find((node) => node.state === "withheld" || node.state === "skipped");
  if (withheld) return { state: "withheld", terminalReason: withheld.reason ?? `node ${withheld.nodeId} was withheld` };
  return { state: "delivered" };
}

function cloneSnapshot<T>(snapshot: T): T {
  return structuredClone(snapshot);
}

export async function coordinateMultiTargetPlan(input: {
  plan: CompiledMultiTargetPlan;
  reservation: AggregateGauntletBudgetReservation | null;
  ports: MultiTargetCoordinatorPorts;
}): Promise<MultiTargetCoordinatorSnapshot> {
  validateDigests(input.plan, input.reservation);
  const hasGauntlet = [...input.plan.decisions, ...(input.plan.synthesis ? [input.plan.synthesis] : [])]
    .some((decision) => decision.mode === "gauntlet");
  if (hasGauntlet && !input.reservation) throw new Error("multi-target coordinator: gauntlet decisions require an aggregate reservation");

  const persisted = await input.ports.state?.load() ?? null;
  let snapshot = persisted ? cloneSnapshot(persisted) : initialSnapshot(input.plan, input.reservation);
  assertResumeSnapshot(snapshot, input.plan, input.reservation);
  if (snapshot.state === "delivered" || snapshot.state === "withheld" || snapshot.state === "failed") return snapshot;

  await input.ports.journal?.persistSnapshots({ planDigest: input.plan.digest, reservationDigest: input.reservation?.digest ?? null });
  if (!persisted) await input.ports.state?.save(cloneSnapshot(snapshot));
  const decisions = decisionMap(input.plan);
  const phases = phaseMap(input.plan);

  for (let waveIndex = 0; waveIndex < input.plan.manifest.parallel_waves.length; waveIndex++) {
    const waveNodeIds = [...input.plan.manifest.parallel_waves[waveIndex]].sort();
    const runnable: Array<{ node: MultiTargetNodeProjection; decision: CompiledGauntletDecision; phase: ManifestPhase; resume: boolean }> = [];

    for (const nodeId of waveNodeIds) {
      const node = snapshot.nodes.find((item) => item.nodeId === nodeId)!;
      if (["delivered", "withheld", "failed", "skipped", "stalled"].includes(node.state)) continue;
      if (node.state === "running" && !(await input.ports.lease?.canResume(nodeId))) {
        node.state = "stalled";
        node.reason = "running node has no recoverable lease";
        await input.ports.journal?.emit({ type: "multi_target.node_stalled", nodeId, waveIndex, payload: { node: cloneSnapshot(node) } });
        continue;
      }

      const phase = phases.get(nodeId)!;
      const blockedBy = phase.depends_on.filter((dependencyId) => snapshot.nodes.find((item) => item.nodeId === dependencyId)?.state !== "delivered");
      if (blockedBy.length) {
        node.state = "skipped";
        node.blockedBy = blockedBy.sort();
        node.reason = `blocked by incomplete dependencies: ${node.blockedBy.join(", ")}`;
        await input.ports.journal?.emit({ type: "multi_target.node_skipped", nodeId, waveIndex, payload: { node: cloneSnapshot(node) } });
        continue;
      }

      const decision = decisions.get(nodeId);
      if (!decision || decision.targetKind === "support") {
        node.state = "delivered";
        node.outputPaths = [phase.outputs_path];
        await input.ports.journal?.emit({ type: "multi_target.support_completed", nodeId, waveIndex, payload: { node: cloneSnapshot(node) } });
        continue;
      }
      const resume = node.state === "running";
      if (!resume && input.ports.lease?.claim && !(await input.ports.lease.claim(nodeId))) {
        node.state = "stalled";
        node.reason = "node lease claim was not acquired";
        await input.ports.journal?.emit({ type: "multi_target.node_stalled", nodeId, waveIndex, payload: { node: cloneSnapshot(node) } });
        continue;
      }
      node.state = "running";
      runnable.push({ node, decision, phase, resume });
      await input.ports.journal?.emit({ type: "multi_target.node_started", nodeId, waveIndex, payload: { node: cloneSnapshot(node) } });
    }

    snapshot.state = "running";
    snapshot.currentWave = waveIndex;
    snapshot.version++;
    await input.ports.state?.save(cloneSnapshot(snapshot));

    const results = await Promise.all(runnable.map(async ({ node, decision, phase, resume }) => {
      const upstreamPaths = phase.depends_on.flatMap((dependencyId) =>
        snapshot.nodes.find((item) => item.nodeId === dependencyId)?.outputPaths ?? []
      );
      const adapter = decision.mode === "gauntlet" ? input.ports.gauntlet : input.ports.standard;
      try {
        const result = await adapter.run({
          nodeId: node.nodeId,
          target: adapterTarget(decision),
          mode: decision.mode,
          intensity: decision.intensity,
          grantedCostUsd: node.grantedCostUsd,
          upstreamPaths: [...upstreamPaths].sort(),
          outputPath: phase.outputs_path,
          idempotencyKey: `multi-target:${input.plan.digest}:${node.nodeId}`,
          resume,
        });
        return { nodeId: node.nodeId, result };
      } catch (error) {
        return { nodeId: node.nodeId, result: { state: "failed" as const, reportedCostUsd: 0, reason: String((error as Error).message) } };
      }
    }));

    for (const { nodeId, result } of results.sort((left, right) => left.nodeId.localeCompare(right.nodeId))) {
      const node = snapshot.nodes.find((item) => item.nodeId === nodeId)!;
      const phase = phases.get(nodeId)!;
      const invalidCost = !Number.isFinite(result.reportedCostUsd) || result.reportedCostUsd < 0;
      const overBudget = node.mode === "gauntlet" && result.reportedCostUsd > node.grantedCostUsd;
      node.reportedCostUsd = invalidCost ? 0 : result.reportedCostUsd;
      node.outputPaths = result.outputPaths?.length ? [...result.outputPaths].sort() : [phase.outputs_path];
      if (invalidCost || overBudget) {
        node.state = "failed";
        node.reason = invalidCost ? "adapter reported an invalid cost" : `reported cost ${result.reportedCostUsd} exceeds grant ${node.grantedCostUsd}`;
        await input.ports.journal?.emit({ type: "multi_target.budget_exceeded", nodeId, waveIndex, payload: { node: cloneSnapshot(node) } });
      } else {
        node.state = result.state;
        node.reason = result.reason;
        await input.ports.journal?.emit({ type: `multi_target.node_${result.state}`, nodeId, waveIndex, payload: { node: cloneSnapshot(node) } });
      }
      await input.ports.lease?.release?.(nodeId);
    }
    snapshot.reportedCostUsd = snapshot.nodes.reduce((sum, node) => sum + node.reportedCostUsd, 0);
    snapshot.version++;
    await input.ports.state?.save(cloneSnapshot(snapshot));
  }

  Object.assign(snapshot, terminalState(snapshot));
  snapshot.version++;
  await input.ports.state?.save(cloneSnapshot(snapshot));
  await input.ports.journal?.emit({ type: "multi_target.plan_terminal", payload: { state: snapshot.state, reason: snapshot.terminalReason } });
  return snapshot;
}
