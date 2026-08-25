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
import { createHash } from "node:crypto";
import { planDag } from "./dag-planner.ts";
import { canonicalJson } from "./run-kernel/canonical-json.ts";
import type { GauntletIntensity } from "./gauntlet/types.ts";

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

export type MultiTargetGauntletScope =
  | "final-only"
  | "each-target"
  | "critical-targets"
  | "each-target-and-final"
  | "adaptive";

export interface GauntletPolicyLimit {
  maxCostUsd?: number;
  maxDurationSeconds?: number;
  maxRounds?: number;
}

export interface MultiTargetGauntletPolicy {
  scope: MultiTargetGauntletScope;
  intensity?: GauntletIntensity;
  limits?: GauntletPolicyLimit;
  criticalTargetIds?: string[];
  synthesisNodeId?: string;
  targets?: Record<string, {
    mode?: "standard" | "gauntlet";
    intensity?: GauntletIntensity;
    limits?: GauntletPolicyLimit;
    critical?: boolean;
    risk?: "low" | "medium" | "high";
    estimatedCostUsd?: number;
  }>;
}

export interface CompiledGauntletDecision {
  nodeId: string;
  targetKind: "business" | "squad" | "agent-x" | "synthesis" | "support";
  mode: "standard" | "gauntlet";
  intensity?: GauntletIntensity;
  limits?: GauntletPolicyLimit;
  reason: string;
  source: "default" | "scope" | "target-override";
}

export interface CompiledMultiTargetPlan {
  schemaVersion: "nirvana.multi-target-gauntlet-policy/v1alpha1";
  manifest: CompiledManifest;
  decisions: CompiledGauntletDecision[];
  synthesis: CompiledGauntletDecision | null;
  policySnapshot: MultiTargetGauntletPolicy | null;
  digest: string;
}

export interface MultiTargetPolicyIssue {
  path: string;
  message: string;
}

const INTENSITY_RANK: Record<GauntletIntensity, number> = { light: 0, balanced: 1, exhaustive: 2 };
// Workspace directory per node type, per references/04-multi-target.md; other
// types keep the plain `<type>s` rule.
const OUTPUTS_DIR_BY_NODE_TYPE: Record<string, string> = { company: "businesses", squad: "squads", deliverable: "deliverables", brief: "briefs" };
const POLICY_SCOPES = new Set<MultiTargetGauntletScope>(["final-only", "each-target", "critical-targets", "each-target-and-final", "adaptive"]);
const POLICY_INTENSITIES = new Set<GauntletIntensity>(["light", "balanced", "exhaustive"]);

function targetKind(node: GraphNode): CompiledGauntletDecision["targetKind"] {
  if (node.type === "company") return "business";
  if (node.type === "squad") return "squad";
  if (node.type === "deliverable") return "synthesis";
  return "support";
}

function validLimit(value: number | undefined): boolean {
  return value === undefined || (Number.isFinite(value) && value >= 0);
}

function validateLimits(path: string, limits: GauntletPolicyLimit | undefined, issues: MultiTargetPolicyIssue[]): void {
  if (!limits) return;
  if (!validLimit(limits.maxCostUsd)) issues.push({ path: `${path}/maxCostUsd`, message: "must be a non-negative finite number" });
  if (!validLimit(limits.maxDurationSeconds)) issues.push({ path: `${path}/maxDurationSeconds`, message: "must be a non-negative finite number" });
  if (!validLimit(limits.maxRounds) || (limits.maxRounds !== undefined && !Number.isInteger(limits.maxRounds))) {
    issues.push({ path: `${path}/maxRounds`, message: "must be a non-negative integer" });
  }
}

function inheritedLimits(parent: GauntletPolicyLimit | undefined, child: GauntletPolicyLimit | undefined): GauntletPolicyLimit | undefined {
  if (!parent && !child) return undefined;
  const cap = (key: keyof GauntletPolicyLimit): number | undefined => {
    const values = [parent?.[key], child?.[key]].filter((value): value is number => value !== undefined);
    return values.length ? Math.min(...values) : undefined;
  };
  const limits = { maxCostUsd: cap("maxCostUsd"), maxDurationSeconds: cap("maxDurationSeconds"), maxRounds: cap("maxRounds") };
  return Object.fromEntries(Object.entries(limits).filter(([, value]) => value !== undefined)) as GauntletPolicyLimit;
}

function inheritedIntensity(parent: GauntletIntensity, child?: GauntletIntensity): GauntletIntensity {
  return child && INTENSITY_RANK[child] < INTENSITY_RANK[parent] ? child : parent;
}

function dependentCounts(manifest: CompiledManifest): Map<string, number> {
  const direct = new Map(manifest.phases.map((phase) => [phase.id, phase.consumed_by]));
  return new Map(manifest.phases.map((phase) => {
    const seen = new Set<string>();
    const queue = [...(direct.get(phase.id) ?? [])];
    while (queue.length) {
      const id = queue.shift()!;
      if (seen.has(id)) continue;
      seen.add(id);
      queue.push(...(direct.get(id) ?? []));
    }
    return [phase.id, seen.size];
  }));
}

/**
 * Compiles policy as a projection over the existing manifest. It is pure and
 * deliberately has no dispatch integration.
 */
export function compileMultiTargetGauntletPolicy(
  graph: DependencyGraph,
  policy?: MultiTargetGauntletPolicy
): { plan: CompiledMultiTargetPlan | null; issues: MultiTargetPolicyIssue[] } {
  const compiled = compileManifest(graph);
  if (!compiled.manifest) return { plan: null, issues: compiled.issues };
  const manifest = compiled.manifest;
  const issues: MultiTargetPolicyIssue[] = [];
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const targetIds = new Set(graph.nodes.filter((node) => node.type === "company" || node.type === "squad").map((node) => node.id));

  if (policy) {
    if (!POLICY_SCOPES.has(policy.scope)) issues.push({ path: "/policy/scope", message: `invalid scope: ${policy.scope}` });
    if (policy.intensity !== undefined && !POLICY_INTENSITIES.has(policy.intensity)) {
      issues.push({ path: "/policy/intensity", message: `invalid intensity: ${policy.intensity}` });
    }
    validateLimits("/policy/limits", policy.limits, issues);
    for (const id of policy.criticalTargetIds ?? []) {
      if (!targetIds.has(id)) issues.push({ path: "/policy/criticalTargetIds", message: `target node not found: ${id}` });
    }
    for (const [id, override] of Object.entries(policy.targets ?? {})) {
      if (!targetIds.has(id)) issues.push({ path: `/policy/targets/${id}`, message: `target node not found: ${id}` });
      if (override.mode !== undefined && override.mode !== "standard" && override.mode !== "gauntlet") {
        issues.push({ path: `/policy/targets/${id}/mode`, message: `invalid mode: ${override.mode}` });
      }
      if (override.intensity !== undefined && !POLICY_INTENSITIES.has(override.intensity)) {
        issues.push({ path: `/policy/targets/${id}/intensity`, message: `invalid intensity: ${override.intensity}` });
      }
      if (override.risk !== undefined && !["low", "medium", "high"].includes(override.risk)) {
        issues.push({ path: `/policy/targets/${id}/risk`, message: `invalid risk: ${override.risk}` });
      }
      validateLimits(`/policy/targets/${id}/limits`, override.limits, issues);
      if (override.estimatedCostUsd !== undefined && !validLimit(override.estimatedCostUsd)) {
        issues.push({ path: `/policy/targets/${id}/estimatedCostUsd`, message: "must be a non-negative finite number" });
      }
    }
    if (policy.synthesisNodeId && nodes.get(policy.synthesisNodeId)?.type !== "deliverable") {
      issues.push({ path: "/policy/synthesisNodeId", message: `synthesis deliverable node not found: ${policy.synthesisNodeId}` });
    }
    if ((policy.scope === "final-only" || policy.scope === "each-target-and-final") && !policy.synthesisNodeId) {
      issues.push({ path: "/policy/synthesisNodeId", message: `scope ${policy.scope} requires an explicit synthesis node` });
    }
  }
  if (issues.length) return { plan: null, issues };

  const intensity = policy?.intensity ?? "balanced";
  const criticalIds = new Set(policy?.criticalTargetIds ?? []);
  const dependents = dependentCounts(manifest);
  const decideTarget = (node: GraphNode): CompiledGauntletDecision => {
    if (!targetIds.has(node.id)) {
      return {
        nodeId: node.id,
        targetKind: targetKind(node),
        mode: "standard",
        reason: "support phase is outside target gauntlet policy",
        source: "default",
      };
    }
    const override = policy?.targets?.[node.id];
    let enabled = false;
    let reason = "standard is the backward-compatible default";
    let source: CompiledGauntletDecision["source"] = "default";
    if (policy) {
      source = "scope";
      if (policy.scope === "each-target" || policy.scope === "each-target-and-final") {
        enabled = true; reason = `selected by ${policy.scope} scope`;
      } else if (policy.scope === "critical-targets") {
        enabled = criticalIds.has(node.id) || override?.critical === true;
        reason = enabled ? "target is explicitly critical" : "target is not marked critical";
      } else if (policy.scope === "adaptive") {
        const highRisk = override?.risk === "high";
        const highFanOut = (dependents.get(node.id) ?? 0) >= 2;
        const highFanIn = (manifest.phases.find((phase) => phase.id === node.id)?.depends_on.length ?? 0) >= 2;
        const costly = policy.limits?.maxCostUsd !== undefined && (override?.estimatedCostUsd ?? 0) >= policy.limits.maxCostUsd * 0.5;
        enabled = override?.critical === true || criticalIds.has(node.id) || highRisk || highFanOut || highFanIn || costly;
        const signals = [override?.critical || criticalIds.has(node.id) ? "critical" : "", highRisk ? "high-risk" : "", highFanOut ? "fan-out" : "", highFanIn ? "fan-in" : "", costly ? "estimated-cost" : ""].filter(Boolean);
        reason = enabled ? `adaptive deterministic signals: ${signals.join(", ")}` : "adaptive found no deterministic escalation signal";
      } else {
        reason = "final-only reserves gauntlet for synthesis";
      }
      if (override?.mode) {
        enabled = override.mode === "gauntlet";
        reason = `explicit target override selected ${override.mode}`;
        source = "target-override";
      }
    }
    return {
      nodeId: node.id, targetKind: targetKind(node), mode: enabled ? "gauntlet" : "standard", reason, source,
      ...(enabled ? { intensity: inheritedIntensity(intensity, override?.intensity), limits: inheritedLimits(policy?.limits, override?.limits) } : {}),
    };
  };

  const decisions = graph.nodes
    .filter((node) => node.type !== "deliverable")
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(decideTarget);
  const synthesisNode = policy?.synthesisNodeId ? nodes.get(policy.synthesisNodeId)! : undefined;
  const synthesisEnabled = !!policy && !!synthesisNode && ["final-only", "each-target-and-final", "adaptive"].includes(policy.scope);
  const synthesis: CompiledGauntletDecision | null = synthesisNode ? {
    nodeId: synthesisNode.id, targetKind: "synthesis", mode: synthesisEnabled ? "gauntlet" : "standard",
    ...(synthesisEnabled ? { intensity, limits: inheritedLimits(policy?.limits, undefined) } : {}),
    reason: synthesisEnabled ? `selected by ${policy!.scope} scope` : "scope does not select synthesis",
    source: "scope",
  } : null;

  const normalizedPolicy = policy ? {
    ...policy,
    criticalTargetIds: [...(policy.criticalTargetIds ?? [])].sort(),
    targets: Object.fromEntries(Object.entries(policy.targets ?? {}).sort(([left], [right]) => left.localeCompare(right))),
  } : null;
  const snapshot = { schemaVersion: "nirvana.multi-target-gauntlet-policy/v1alpha1" as const, manifest, decisions, synthesis, policySnapshot: normalizedPolicy };
  const digest = createHash("sha256").update(canonicalJson(snapshot)).digest("hex");
  return { plan: { ...snapshot, digest }, issues: [] };
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
    outputs_path: `${OUTPUTS_DIR_BY_NODE_TYPE[n.type] ?? `${n.type}s`}/${n.id.replace(/[^a-zA-Z0-9_-]+/g, "-")}/outputs/`,
  }));

  const plan = planDag(toDagNodes(graph, { parallelSafe: opts.parallelSafe ?? (() => true) }));
  return {
    manifest: { phases, parallel_waves: plan.layers },
    issues: [],
  };
}
