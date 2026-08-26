import { listEvents, type KernelHandle } from "../run-kernel/store.ts";
import type { RunEvent } from "../run-kernel/types.ts";
import type { MultiTargetCoordinatorSnapshot, MultiTargetNodeProjection } from "./multi-target-coordinator.ts";

function applyEvent(projected: MultiTargetCoordinatorSnapshot, event: RunEvent): void {
  const node = (event.payload as { node?: MultiTargetNodeProjection }).node;
  if (node) {
    const index = projected.nodes.findIndex((item) => item.nodeId === node.nodeId);
    if (index >= 0) projected.nodes[index] = structuredClone(node);
    projected.currentWave = Math.max(projected.currentWave, node.waveIndex);
    projected.state = "running";
  }
  if (event.type === "multi_target.plan_terminal") {
    const payload = event.payload as { state?: MultiTargetCoordinatorSnapshot["state"]; reason?: string };
    if (payload.state) projected.state = payload.state;
    if (payload.reason) projected.terminalReason = payload.reason;
  }
}

/**
 * Read-only projection of one multi-target Run from the kernel journal: the
 * last `multi_target.snapshot_saved` plus every later `multi_target.*` event
 * carrying a node projection or the plan terminal state. This is the same
 * replay the Run Kernel ports perform on reload, so Glance reads the truth
 * the coordinator would resume from. Returns null when the Run never saved
 * a coordinator snapshot.
 */
export function projectMultiTargetRun(kernel: KernelHandle, projectId: string, runId: string): MultiTargetCoordinatorSnapshot | null {
  const events = listEvents(kernel, projectId).filter((event) => event.runId === runId && event.type.startsWith("multi_target."));
  const latest = events.filter((event) => event.type === "multi_target.snapshot_saved").at(-1);
  if (!latest) return null;
  const projected = structuredClone((latest.payload as { snapshot: MultiTargetCoordinatorSnapshot }).snapshot);
  for (const event of events) if (event.sequence > latest.sequence) applyEvent(projected, event);
  projected.reportedCostUsd = projected.nodes.reduce((sum, node) => sum + node.reportedCostUsd, 0);
  return projected;
}
