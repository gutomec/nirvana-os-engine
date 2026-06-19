/**
 * dag-planner.ts — converts a DAG of dispatch nodes into execution layers.
 *
 * Each `layer` is a list of nodes that can run in parallel because none of
 * them depends on another in the same layer. Layers are produced by
 * topological sort (Kahn's algorithm) so that any node in layer N has all
 * its dependencies satisfied in layers < N.
 *
 * Inputs are framework-neutral: a node id + array of dependency ids. This
 * is intentionally decoupled from business.yaml / workflow.yaml so that
 * the same planner can serve both.
 *
 * Phase 5 da nirvana-evolution.
 */

export interface DagNode {
  id: string;
  deps: string[];           // ids of nodes that must complete first
  parallel_safe?: boolean;  // opt-in; default false → forced into its own layer
  metadata?: Record<string, unknown>;
}

export interface PlanResult {
  layers: string[][];           // ids grouped by layer
  layer_index: Record<string, number>;
  has_cycle: boolean;
  cycle_nodes: string[];
  forced_serial: string[];      // nodes whose `parallel_safe !== true` ended up alone in their layer
  unknown_deps: { node: string; dep: string }[]; // deps pointing to ids not in input
}

export function planDag(nodes: DagNode[]): PlanResult {
  const byId = new Map<string, DagNode>();
  for (const n of nodes) byId.set(n.id, n);

  // Track unknown dependencies separately rather than throwing — caller
  // decides if that's a hard error or just a warning.
  const unknownDeps: { node: string; dep: string }[] = [];
  for (const n of nodes) {
    for (const d of n.deps) {
      if (!byId.has(d)) unknownDeps.push({ node: n.id, dep: d });
    }
  }

  // Compute remaining in-degree using only known deps. Unknown deps are
  // dropped from the dependency graph for planning purposes.
  const inDegree = new Map<string, number>();
  const reverseEdges = new Map<string, string[]>(); // dep id → dependents
  for (const n of nodes) {
    const known = n.deps.filter((d) => byId.has(d));
    inDegree.set(n.id, known.length);
    for (const d of known) {
      if (!reverseEdges.has(d)) reverseEdges.set(d, []);
      reverseEdges.get(d)!.push(n.id);
    }
  }

  const layers: string[][] = [];
  const layerIndex: Record<string, number> = {};
  let processed = 0;
  let frontier = [...inDegree.entries()].filter(([, d]) => d === 0).map(([id]) => id);

  while (frontier.length > 0) {
    // Sort frontier deterministically (id) so the output is stable.
    const layer = [...frontier].sort();
    layers.push(layer);
    for (const id of layer) layerIndex[id] = layers.length - 1;
    processed += layer.length;
    const next: string[] = [];
    for (const id of layer) {
      const dependents = reverseEdges.get(id) ?? [];
      for (const dep of dependents) {
        const d = (inDegree.get(dep) ?? 0) - 1;
        inDegree.set(dep, d);
        if (d === 0) next.push(dep);
      }
    }
    frontier = next;
  }

  const hasCycle = processed < nodes.length;
  const cycleNodes = hasCycle ? nodes.filter((n) => !(n.id in layerIndex)).map((n) => n.id) : [];

  // Forced serial: any node with parallel_safe !== true must occupy a
  // layer alone. We post-process by splitting layers that contain such
  // a node — but only the conservative split where the node moves to a
  // fresh layer placed just BEFORE the current one, preserving
  // dependency order.
  const safeLayers: string[][] = [];
  const forcedSerial: string[] = [];
  for (const layer of layers) {
    const safeNodes: string[] = [];
    const unsafeNodes: string[] = [];
    for (const id of layer) {
      const n = byId.get(id)!;
      if (n.parallel_safe === true) safeNodes.push(id);
      else {
        unsafeNodes.push(id);
        forcedSerial.push(id);
      }
    }
    // Each unsafe node gets its own layer (alphabetical for determinism).
    for (const id of unsafeNodes.sort()) safeLayers.push([id]);
    if (safeNodes.length > 0) safeLayers.push(safeNodes.sort());
  }

  // Recompute layer_index from final layout
  const finalLayerIndex: Record<string, number> = {};
  for (let i = 0; i < safeLayers.length; i++) {
    for (const id of safeLayers[i]) finalLayerIndex[id] = i;
  }

  return {
    layers: safeLayers,
    layer_index: finalLayerIndex,
    has_cycle: hasCycle,
    cycle_nodes: cycleNodes,
    forced_serial: forcedSerial,
    unknown_deps: unknownDeps,
  };
}

/**
 * Convenience: derive a DagNode[] from a business.yaml-style org-chart.
 *
 *   chart: [
 *     { employee: "ceo", reports: [], direct_reports: ["a","b"] },
 *     { employee: "a", reports: ["ceo"], direct_reports: [] },
 *     ...
 *   ]
 *
 * Returns DagNode[] where deps == reports[].
 */
export function fromOrgChart(chart: { employee: string; reports?: string[]; parallel_safe?: boolean }[]): DagNode[] {
  return chart.map((entry) => ({
    id: entry.employee,
    deps: entry.reports ?? [],
    parallel_safe: entry.parallel_safe === true,
  }));
}

/**
 * Convenience: derive a DagNode[] from a workflow.yaml-style steps[] array.
 *
 *   steps: [
 *     { id: "fetch", deps: [] },
 *     { id: "transform", deps: ["fetch"] },
 *     ...
 *   ]
 */
export function fromWorkflowSteps(steps: { id: string; deps?: string[]; parallel_safe?: boolean }[]): DagNode[] {
  return steps.map((s) => ({
    id: s.id,
    deps: s.deps ?? [],
    parallel_safe: s.parallel_safe === true,
  }));
}
