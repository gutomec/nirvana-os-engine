// plan-compiler.ts — compile a typed entity plan-graph into the multi-target
// manifest the orchestration loop already executes.
//
// The projection constraint, in code: a plan graph NEVER executes itself. It
// compiles to the exact `manifest.json` shape documented in
// references/04-multi-target.md (phases[].depends_on / consumed_by /
// outputs_path, parallel_waves[]), and the existing dispatch loop owns
// execution, gating, audit and resume. One executor, one audit chain — a
// second runner inside a canvas is the failure mode the 2026 canvas builders
// all hit (the export gap).
//
// Pure module: no fs, no env. Issues are returned, never thrown — a cyclic
// plan is a validation result the caller reports, not a crash.

import {
  buildOrder,
  dependencyPair,
  toDagNodes,
  validateGraph,
  type DependencyGraph,
  type GraphIssue,
  type GraphNode,
} from "../../_shared/lib/dependency-graph.ts";
import { planDag } from "./dag-planner.ts";

export interface ManifestPhase {
  id: string;
  target: string;
  status: "pending";
  depends_on: string[];
  consumed_by: string[];
  outputs_path: string;
}

export interface CompiledManifest {
  phases: ManifestPhase[];
  parallel_waves: string[][];
}

/**
 * One phase per graph node, dependencies from the effective dependency
 * direction (dependencyPair — `employee embodies mind_clone` compiles to the
 * clone phase running first). `target` is `<type>/<id>`; the dispatcher maps
 * it onto the cascade. Returns issues instead of a manifest when the graph
 * does not validate (including cycles).
 */
export function compileManifest(
  graph: DependencyGraph,
  opts: { parallelSafe?: (n: GraphNode) => boolean } = {}
): { manifest: CompiledManifest | null; issues: GraphIssue[] } {
  const issues = validateGraph(graph);
  if (issues.length) return { manifest: null, issues };

  const order = buildOrder(graph);
  if (order.has_cycle) {
    return {
      manifest: null,
      issues: [{ path: "/edges", message: `dependency cycle: ${order.cycle_nodes.join(", ")}` }],
    };
  }

  const deps = new Map<string, Set<string>>(graph.nodes.map((n) => [n.id, new Set<string>()]));
  const consumers = new Map<string, Set<string>>(graph.nodes.map((n) => [n.id, new Set<string>()]));
  for (const e of graph.edges) {
    const [before, after] = dependencyPair(e);
    if (!deps.has(after) || !deps.has(before)) continue;
    deps.get(after)!.add(before);
    consumers.get(before)!.add(after);
  }

  const phases: ManifestPhase[] = order.order.map((n) => ({
    id: n.id,
    target: `${n.type}/${n.id}`,
    status: "pending",
    depends_on: [...deps.get(n.id)!].sort(),
    consumed_by: [...consumers.get(n.id)!].sort(),
    outputs_path: `${n.type}s/${n.id.replace(/[^a-zA-Z0-9_-]+/g, "-")}/outputs/`,
  }));

  const plan = planDag(toDagNodes(graph, { parallelSafe: opts.parallelSafe ?? (() => true) }));
  return {
    manifest: { phases, parallel_waves: plan.layers },
    issues: [],
  };
}
