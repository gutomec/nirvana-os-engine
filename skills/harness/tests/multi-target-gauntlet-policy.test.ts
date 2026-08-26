import { describe, expect, test } from "bun:test";
import type { DependencyGraph } from "../../_shared/lib/dependency-graph.ts";
import {
  compileManifest,
  compileMultiTargetGauntletPolicy,
  type MultiTargetGauntletPolicy,
} from "../lib/plan-compiler.ts";

const graph: DependencyGraph = {
  nodes: [
    { id: "brief-main", type: "brief" },
    { id: "business-a", type: "company" },
    { id: "business-b", type: "company" },
    { id: "squad-c", type: "squad" },
    { id: "final-output", type: "deliverable" },
  ],
  edges: [
    { id: "brief-a", source: "brief-main", target: "business-a", type: "briefs" },
    { id: "brief-b", source: "brief-main", target: "business-b", type: "briefs" },
    { id: "squad-after-a", source: "squad-c", target: "business-a", type: "depends_on" },
    { id: "squad-after-b", source: "squad-c", target: "business-b", type: "depends_on" },
    { id: "synthesis", source: "squad-c", target: "final-output", type: "yields" },
  ],
};

const policy = (scope: MultiTargetGauntletPolicy["scope"]): MultiTargetGauntletPolicy => ({
  scope,
  intensity: "balanced",
  synthesisNodeId: "final-output",
  criticalTargetIds: ["business-b"],
});

const modes = (scope: MultiTargetGauntletPolicy["scope"]): Record<string, string> => {
  const result = compileMultiTargetGauntletPolicy(graph, policy(scope));
  expect(result.issues).toEqual([]);
  return Object.fromEntries([
    ...result.plan!.decisions.filter((decision) => decision.targetKind !== "support").map((decision) => [decision.nodeId, decision.mode]),
    [result.plan!.synthesis!.nodeId, result.plan!.synthesis!.mode],
  ]);
};

describe("multi-target Gauntlet policy compiler", () => {
  test("preserves the mixed Business and Squad DAG, parallel waves and explicit synthesis", () => {
    const base = compileManifest(graph).manifest!;
    const result = compileMultiTargetGauntletPolicy(graph, policy("each-target-and-final"));
    expect(result.plan!.manifest).toEqual(base);
    expect(result.plan!.manifest.parallel_waves).toEqual([
      ["brief-main"], ["business-a", "business-b"], ["squad-c"], ["final-output"],
    ]);
    expect(result.plan!.decisions.map(({ nodeId, targetKind }) => [nodeId, targetKind])).toEqual([
      ["brief-main", "support"],
      ["business-a", "business"], ["business-b", "business"], ["squad-c", "squad"],
    ]);
    expect(result.plan!.synthesis).toMatchObject({ nodeId: "final-output", targetKind: "synthesis", mode: "gauntlet" });
  });

  test("compiles all five scopes independently for targets and synthesis", () => {
    expect(modes("final-only")).toEqual({ "business-a": "standard", "business-b": "standard", "squad-c": "standard", "final-output": "gauntlet" });
    expect(modes("each-target")).toEqual({ "business-a": "gauntlet", "business-b": "gauntlet", "squad-c": "gauntlet", "final-output": "standard" });
    expect(modes("critical-targets")).toEqual({ "business-a": "standard", "business-b": "gauntlet", "squad-c": "standard", "final-output": "standard" });
    expect(modes("each-target-and-final")).toEqual({ "business-a": "gauntlet", "business-b": "gauntlet", "squad-c": "gauntlet", "final-output": "gauntlet" });
    expect(modes("adaptive")).toEqual({ "business-a": "gauntlet", "business-b": "gauntlet", "squad-c": "gauntlet", "final-output": "gauntlet" });
  });

  test("adaptive uses only deterministic plan signals", () => {
    const adaptive: MultiTargetGauntletPolicy = {
      scope: "adaptive", intensity: "exhaustive", synthesisNodeId: "final-output", limits: { maxCostUsd: 20 },
      targets: {
        "business-a": { risk: "high" },
        "business-b": { estimatedCostUsd: 11 },
        "squad-c": { risk: "low" },
      },
    };
    const first = compileMultiTargetGauntletPolicy(graph, adaptive).plan!;
    const second = compileMultiTargetGauntletPolicy(graph, adaptive).plan!;
    expect(second).toEqual(first);
    expect(first.decisions.find((decision) => decision.nodeId === "business-a")!.reason).toContain("high-risk");
    expect(first.decisions.find((decision) => decision.nodeId === "business-b")!.reason).toContain("estimated-cost");
    expect(first.decisions.find((decision) => decision.nodeId === "squad-c")!.reason).toContain("fan-in");
  });

  test("child budget and intensity cannot exceed parent limits", () => {
    const result = compileMultiTargetGauntletPolicy(graph, {
      scope: "each-target", intensity: "balanced",
      limits: { maxCostUsd: 10, maxDurationSeconds: 300, maxRounds: 3 },
      targets: {
        "business-a": { intensity: "exhaustive", limits: { maxCostUsd: 50, maxDurationSeconds: 900, maxRounds: 8 } },
        "business-b": { intensity: "light", limits: { maxCostUsd: 4, maxRounds: 1 } },
      },
    });
    expect(result.plan!.decisions.find((decision) => decision.nodeId === "business-a")).toMatchObject({
      intensity: "balanced", limits: { maxCostUsd: 10, maxDurationSeconds: 300, maxRounds: 3 },
    });
    expect(result.plan!.decisions.find((decision) => decision.nodeId === "business-b")).toMatchObject({
      intensity: "light", limits: { maxCostUsd: 4, maxDurationSeconds: 300, maxRounds: 1 },
    });
  });

  test("no policy leaves every executable target standard", () => {
    const result = compileMultiTargetGauntletPolicy(graph);
    expect(result.plan!.decisions.every((decision) => decision.mode === "standard")).toBeTrue();
    expect(result.plan!.synthesis).toBeNull();
    expect(result.plan!.policySnapshot).toBeNull();
  });

  test("input ordering does not change snapshot or digest", () => {
    const reordered: DependencyGraph = { nodes: [...graph.nodes].reverse(), edges: [...graph.edges].reverse() };
    const left = compileMultiTargetGauntletPolicy(graph, {
      ...policy("critical-targets"), criticalTargetIds: ["squad-c", "business-b"],
      targets: { "squad-c": { risk: "high" }, "business-a": { mode: "standard" } },
    }).plan!;
    const right = compileMultiTargetGauntletPolicy(reordered, {
      ...policy("critical-targets"), criticalTargetIds: ["business-b", "squad-c"],
      targets: { "business-a": { mode: "standard" }, "squad-c": { risk: "high" } },
    }).plan!;
    expect(right).toEqual(left);
    expect(left.digest).toMatch(/^[a-f0-9]{64}$/);
  });

  test("rejects missing references, cycles and invalid configuration", () => {
    const missing = compileMultiTargetGauntletPolicy(graph, {
      scope: "final-only", synthesisNodeId: "missing-final", criticalTargetIds: ["missing-target"],
      targets: { "also-missing": { limits: { maxRounds: -1 } } },
    });
    expect(missing.plan).toBeNull();
    expect(missing.issues.map((issue) => issue.path)).toContain("/policy/synthesisNodeId");
    expect(missing.issues.map((issue) => issue.path)).toContain("/policy/criticalTargetIds");

    const invalid = compileMultiTargetGauntletPolicy(graph, {
      scope: "unknown" as MultiTargetGauntletPolicy["scope"], intensity: "maximum" as MultiTargetGauntletPolicy["intensity"],
    });
    expect(invalid.plan).toBeNull();
    expect(invalid.issues).toHaveLength(2);

    const cyclic: DependencyGraph = {
      nodes: [{ id: "business-a", type: "company" }, { id: "squad-b", type: "squad" }],
      edges: [
        { id: "cycle-a", source: "business-a", target: "squad-b", type: "depends_on" },
        { id: "cycle-b", source: "squad-b", target: "business-a", type: "depends_on" },
      ],
    };
    expect(compileMultiTargetGauntletPolicy(cyclic, { scope: "each-target" }).issues[0].message).toContain("cycle");
  });
});

// A role no squad covers sits between two squads: the policy must treat it exactly like them.
const agentGraph: DependencyGraph = {
  nodes: [
    { id: "brief-main", type: "brief" },
    { id: "squad-research", type: "squad" },
    { id: "role-copywriter", type: "agent" },
    { id: "squad-design", type: "squad" },
    { id: "final-output", type: "deliverable" },
  ],
  edges: [
    { id: "brief-research", source: "brief-main", target: "squad-research", type: "briefs" },
    { id: "copy-after-research", source: "role-copywriter", target: "squad-research", type: "depends_on" },
    { id: "design-after-copy", source: "squad-design", target: "role-copywriter", type: "depends_on" },
    { id: "final", source: "squad-design", target: "final-output", type: "yields" },
  ],
};

describe("multi-target Gauntlet policy compiler with agent nodes", () => {
  const decisionOf = (policy: MultiTargetGauntletPolicy | undefined) => {
    const result = compileMultiTargetGauntletPolicy(agentGraph, policy);
    expect(result.issues).toEqual([]);
    return result.plan!.decisions.find((decision) => decision.nodeId === "role-copywriter")!;
  };

  test("compiles the agent node as an agent-x target with its own phase and outputs path", () => {
    const result = compileMultiTargetGauntletPolicy(agentGraph);
    expect(result.plan!.manifest.parallel_waves).toEqual([["brief-main"], ["squad-research"], ["role-copywriter"], ["squad-design"], ["final-output"]]);
    expect(result.plan!.manifest.phases.find((phase) => phase.id === "role-copywriter")).toMatchObject({
      target: "agent/role-copywriter", outputs_path: "agents/role-copywriter/outputs/", depends_on: ["squad-research"], consumed_by: ["squad-design"],
    });
    expect(result.plan!.decisions.map(({ nodeId, targetKind }) => [nodeId, targetKind])).toEqual([
      ["brief-main", "support"], ["role-copywriter", "agent-x"], ["squad-design", "squad"], ["squad-research", "squad"],
    ]);
    expect(decisionOf(undefined)).toMatchObject({ targetKind: "agent-x", mode: "standard", source: "default" });
  });

  test("every scope and override selects the agent node the way it selects a squad", () => {
    expect(decisionOf({ scope: "each-target", intensity: "balanced" })).toMatchObject({ mode: "gauntlet", intensity: "balanced", source: "scope" });
    expect(decisionOf({ scope: "each-target-and-final", synthesisNodeId: "final-output" })).toMatchObject({ mode: "gauntlet", intensity: "balanced" });
    expect(decisionOf({ scope: "final-only", synthesisNodeId: "final-output" })).toMatchObject({ mode: "standard", reason: "final-only reserves gauntlet for synthesis" });
    expect(decisionOf({ scope: "critical-targets" })).toMatchObject({ mode: "standard", reason: "target is not marked critical" });
    expect(decisionOf({ scope: "critical-targets", criticalTargetIds: ["role-copywriter"] })).toMatchObject({ mode: "gauntlet", reason: "target is explicitly critical" });
    expect(decisionOf({ scope: "critical-targets", targets: { "role-copywriter": { critical: true } } })).toMatchObject({ mode: "gauntlet" });
    // Adaptive reads the same deterministic signals: two transitive dependents (squad-design, final-output) is fan-out.
    expect(decisionOf({ scope: "adaptive" })).toMatchObject({ mode: "gauntlet", reason: "adaptive deterministic signals: fan-out" });
    expect(decisionOf({ scope: "adaptive", targets: { "role-copywriter": { risk: "high" } } })).toMatchObject({ mode: "gauntlet", reason: "adaptive deterministic signals: high-risk, fan-out" });
    expect(decisionOf({ scope: "each-target", intensity: "exhaustive", limits: { maxCostUsd: 10, maxRounds: 4 },
      targets: { "role-copywriter": { intensity: "light", limits: { maxCostUsd: 3, maxRounds: 9 } } } }))
      .toMatchObject({ mode: "gauntlet", intensity: "light", limits: { maxCostUsd: 3, maxRounds: 4 }, source: "scope" });
    expect(decisionOf({ scope: "each-target", targets: { "role-copywriter": { mode: "standard" } } })).toMatchObject({ mode: "standard", source: "target-override" });
    expect(decisionOf({ scope: "final-only", synthesisNodeId: "final-output", targets: { "role-copywriter": { mode: "gauntlet" } } })).toMatchObject({ mode: "gauntlet", source: "target-override" });
  });
});

// The synthesis takes its own intensity and limits; its mode stays the scope's.
describe("multi-target Gauntlet policy compiler with synthesis limits", () => {
  const base: MultiTargetGauntletPolicy = {
    scope: "each-target-and-final", intensity: "balanced", synthesisNodeId: "final-output",
    limits: { maxCostUsd: 32, maxDurationSeconds: 600, maxRounds: 4 },
  };
  const compiled = (policy: MultiTargetGauntletPolicy) => {
    const result = compileMultiTargetGauntletPolicy(graph, policy);
    expect(result.issues).toEqual([]);
    return result.plan!;
  };
  const issuesOf = (policy: MultiTargetGauntletPolicy) => {
    const result = compileMultiTargetGauntletPolicy(graph, policy);
    expect(result.plan).toBeNull();
    return result.issues;
  };

  test("policy.synthesis sets the synthesis intensity and limits, inheriting only downwards", () => {
    const plan = compiled({ ...base, synthesis: { intensity: "light", limits: { maxCostUsd: 10, maxDurationSeconds: 900, maxRounds: 2 } } });
    expect(plan.synthesis).toEqual({
      nodeId: "final-output", targetKind: "synthesis", mode: "gauntlet", intensity: "light",
      limits: { maxCostUsd: 10, maxDurationSeconds: 600, maxRounds: 2 },
      reason: "selected by each-target-and-final scope with its own intensity and limits", source: "target-override",
    });
    // The targets do not see the synthesis override.
    expect(plan.decisions.find((decision) => decision.nodeId === "squad-c")).toMatchObject({
      mode: "gauntlet", intensity: "balanced", limits: { maxCostUsd: 32, maxDurationSeconds: 600, maxRounds: 4 }, source: "scope",
    });
  });

  test("without an override the synthesis keeps the scope intensity and the global limits", () => {
    expect(compiled(base).synthesis).toMatchObject({
      intensity: "balanced", limits: { maxCostUsd: 32, maxDurationSeconds: 600, maxRounds: 4 },
      reason: "selected by each-target-and-final scope", source: "scope",
    });
  });

  test("targets[synthesisNodeId] is an alias of policy.synthesis with the same snapshot and digest", () => {
    const direct = compiled({ ...base, synthesis: { limits: { maxCostUsd: 10 } } });
    const alias = compiled({ ...base, targets: { "final-output": { limits: { maxCostUsd: 10 } } } });
    expect(alias).toEqual(direct);
    expect(alias.policySnapshot).toMatchObject({ synthesis: { limits: { maxCostUsd: 10 } }, targets: {} });
  });

  test("the digest changes with the synthesis limit", () => {
    const ten = compiled({ ...base, synthesis: { limits: { maxCostUsd: 10 } } });
    const twelve = compiled({ ...base, synthesis: { limits: { maxCostUsd: 12 } } });
    expect(twelve.digest).not.toBe(ten.digest);
    expect(ten.digest).not.toBe(compiled(base).digest);
  });

  test("a scope that does not select the synthesis leaves it standard even with limits", () => {
    expect(compiled({ ...base, scope: "each-target", synthesis: { limits: { maxCostUsd: 10 } } }).synthesis).toEqual({
      nodeId: "final-output", targetKind: "synthesis", mode: "standard", reason: "scope does not select synthesis", source: "scope",
    });
  });

  test("rejects invalid limits, an intensity above the policy, a mode on the synthesis and a synthesis without node", () => {
    expect(issuesOf({ ...base, synthesis: { limits: { maxCostUsd: -1, maxRounds: 1.5 } } }).map((issue) => issue.path))
      .toEqual(["/policy/synthesis/limits/maxCostUsd", "/policy/synthesis/limits/maxRounds"]);
    expect(issuesOf({ ...base, synthesis: { intensity: "exhaustive" } }))
      .toEqual([{ path: "/policy/synthesis/intensity", message: "must not exceed the policy intensity balanced" }]);
    expect(issuesOf({ ...base, targets: { "final-output": { mode: "gauntlet", limits: { maxCostUsd: 10 } } } }))
      .toEqual([{ path: "/policy/targets/final-output/mode", message: "synthesis mode comes from the scope; declare only intensity and limits" }]);
    expect(issuesOf({ ...base, targets: { "final-output": { risk: "high" } } }))
      .toEqual([{ path: "/policy/targets/final-output/risk", message: "synthesis accepts only intensity and limits" }]);
    expect(issuesOf({ scope: "each-target", synthesis: { limits: { maxCostUsd: 10 } } }))
      .toEqual([{ path: "/policy/synthesis", message: "requires policy.synthesisNodeId" }]);
    expect(issuesOf({ ...base, synthesis: { limits: { maxCostUsd: 10 } }, targets: { "final-output": { limits: { maxCostUsd: 10 } } } }))
      .toEqual([{ path: "/policy/targets/final-output", message: "synthesis is already configured by policy.synthesis" }]);
    // A deliverable that is not the declared synthesis is still not a target.
    expect(issuesOf({ scope: "each-target", targets: { "final-output": { limits: { maxCostUsd: 10 } } } }))
      .toEqual([{ path: "/policy/targets/final-output", message: "deliverable final-output is not the declared synthesis; set policy.synthesisNodeId" }]);
  });
});
