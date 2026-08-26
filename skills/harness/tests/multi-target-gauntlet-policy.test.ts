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
