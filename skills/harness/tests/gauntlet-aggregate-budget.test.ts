import { describe, expect, test } from "bun:test";
import type { DependencyGraph } from "../../_shared/lib/dependency-graph.ts";
import { reserveAggregateGauntletBudget } from "../lib/gauntlet/aggregate-budget.ts";
import { compileMultiTargetGauntletPolicy, type MultiTargetGauntletPolicy } from "../lib/plan-compiler.ts";

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
    { id: "squad-a", source: "squad-c", target: "business-a", type: "depends_on" },
    { id: "squad-b", source: "squad-c", target: "business-b", type: "depends_on" },
    { id: "final", source: "squad-c", target: "final-output", type: "yields" },
  ],
};

function compile(policy?: MultiTargetGauntletPolicy) {
  const result = compileMultiTargetGauntletPolicy(graph, policy);
  expect(result.issues).toEqual([]);
  return result.plan!;
}

describe("aggregate Gauntlet budget reservation", () => {
  test("reserves every request when their sum fits the global cap", () => {
    const plan = compile({
      scope: "each-target", intensity: "light", limits: { maxCostUsd: 10 },
      targets: {
        "business-a": { limits: { maxCostUsd: 2 } },
        "business-b": { limits: { maxCostUsd: 3 } },
        "squad-c": { limits: { maxCostUsd: 4 } },
      },
    });
    const reservation = reserveAggregateGauntletBudget(plan).reservation!;
    expect(reservation).toMatchObject({ status: "reserved", aggregateCapUsd: 10, requestedUsd: 9, grantedUsd: 9, balanceUsd: 1 });
    expect(reservation.allocations.filter((item) => item.targetKind !== "support").every((item) => item.reason === "requested_in_full")).toBeTrue();
    expect(reservation.waves.map(({ waveIndex, grantedUsd }) => [waveIndex, grantedUsd])).toEqual([[0, 0], [1, 5], [2, 4], [3, 0]]);
  });

  test("reduces deterministically and protects synthesis after safe minima", () => {
    const plan = compile({
      scope: "each-target-and-final", intensity: "balanced", synthesisNodeId: "final-output",
      limits: { maxCostUsd: 10 },
      targets: {
        "business-a": { limits: { maxCostUsd: 4 } },
        "business-b": { limits: { maxCostUsd: 4 } },
        "squad-c": { limits: { maxCostUsd: 4 } },
      },
    });
    const reservation = reserveAggregateGauntletBudget(plan).reservation!;
    const granted = Object.fromEntries(reservation.allocations.map((item) => [item.nodeId, item.grantedUsd]));
    expect(reservation).toMatchObject({ status: "reserved", requestedUsd: 22, grantedUsd: 10, balanceUsd: 0 });
    expect(granted).toEqual({ "brief-main": 0, "business-a": 2, "business-b": 2, "final-output": 4, "squad-c": 2 });
    expect(reservation.allocations.find((item) => item.nodeId === "final-output")!.reason).toBe("reduced_to_aggregate_cap");
    expect(reservation.policyDigest).toBe(plan.digest);
    expect(reservation.digest).toMatch(/^[a-f0-9]{64}$/);
  });

  test("rejects when the aggregate cap cannot fund every safe minimum", () => {
    const plan = compile({ scope: "each-target", intensity: "balanced", limits: { maxCostUsd: 5 } });
    const reservation = reserveAggregateGauntletBudget(plan).reservation!;
    expect(reservation.status).toBe("rejected");
    expect(reservation.grantedUsd).toBe(0);
    expect(reservation.reason).toContain("safe minimum");
    expect(reservation.allocations.filter((item) => item.targetKind !== "support").every((item) => item.reason === "aggregate_cap_rejected")).toBeTrue();
  });

  test("standard nodes consume no Gauntlet reservation", () => {
    const plan = compile({
      scope: "critical-targets", intensity: "light", limits: { maxCostUsd: 5 }, criticalTargetIds: ["business-a"],
    });
    const reservation = reserveAggregateGauntletBudget(plan).reservation!;
    expect(reservation.requestedUsd).toBe(5);
    expect(reservation.allocations.find((item) => item.nodeId === "business-b")).toMatchObject({
      requestedUsd: 0, grantedUsd: 0, reason: "standard_no_reservation",
    });
    expect(reservation.allocations.find((item) => item.nodeId === "squad-c")).toMatchObject({
      requestedUsd: 0, grantedUsd: 0, reason: "standard_no_reservation",
    });
  });

  test("is invariant to node, edge and override ordering", () => {
    const policy: MultiTargetGauntletPolicy = {
      scope: "each-target", intensity: "light", limits: { maxCostUsd: 7 },
      targets: { "squad-c": { limits: { maxCostUsd: 3 } }, "business-a": { limits: { maxCostUsd: 3 } } },
    };
    const reversed: DependencyGraph = { nodes: [...graph.nodes].reverse(), edges: [...graph.edges].reverse() };
    const left = reserveAggregateGauntletBudget(compile(policy)).reservation!;
    const rightPlan = compileMultiTargetGauntletPolicy(reversed, {
      ...policy, targets: { "business-a": { limits: { maxCostUsd: 3 } }, "squad-c": { limits: { maxCostUsd: 3 } } },
    }).plan!;
    expect(reserveAggregateGauntletBudget(rightPlan).reservation).toEqual(left);
  });

  test("distinguishes an absent aggregate cap from an explicit zero", () => {
    expect(reserveAggregateGauntletBudget(compile()).reservation).toBeNull();
    expect(reserveAggregateGauntletBudget(compile({ scope: "each-target", intensity: "light" })).reservation).toBeNull();

    const zero = reserveAggregateGauntletBudget(compile({
      scope: "each-target", intensity: "light", limits: { maxCostUsd: 0 },
    })).reservation!;
    expect(zero).toMatchObject({ aggregateCapUsd: 0, status: "rejected", grantedUsd: 0, balanceUsd: 0 });
  });

  test("never grants more than a smaller child request", () => {
    const plan = compile({
      scope: "each-target", intensity: "balanced", limits: { maxCostUsd: 12 },
      targets: { "business-a": { limits: { maxCostUsd: 3 } } },
    });
    const allocation = reserveAggregateGauntletBudget(plan).reservation!.allocations.find((item) => item.nodeId === "business-a")!;
    expect(allocation.requestedUsd).toBe(3);
    expect(allocation.grantedUsd).toBeLessThanOrEqual(3);
  });
});

describe("aggregate Gauntlet budget reservation with agent nodes", () => {
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

  test("an agent node takes the same safe minimum and proportional share as a squad", () => {
    const compiled = compileMultiTargetGauntletPolicy(agentGraph, {
      scope: "each-target", intensity: "balanced", limits: { maxCostUsd: 9 },
      targets: { "squad-research": { limits: { maxCostUsd: 4 } }, "role-copywriter": { limits: { maxCostUsd: 4 } }, "squad-design": { limits: { maxCostUsd: 4 } } },
    });
    expect(compiled.issues).toEqual([]);
    const reservation = reserveAggregateGauntletBudget(compiled.plan!).reservation!;
    expect(reservation).toMatchObject({ status: "reserved", requestedUsd: 12, grantedUsd: 9, balanceUsd: 0 });
    expect(reservation.allocations.find((item) => item.nodeId === "role-copywriter")).toEqual({
      nodeId: "role-copywriter", targetKind: "agent-x", waveIndex: 2, requestedUsd: 4, grantedUsd: 3, balanceUsd: 1, reason: "reduced_to_aggregate_cap",
    });
    expect(reservation.allocations.filter((item) => item.targetKind !== "support").map((item) => item.grantedUsd)).toEqual([3, 3, 3]);
    expect(reservation.waves.map(({ waveIndex, grantedUsd }) => [waveIndex, grantedUsd])).toEqual([[0, 0], [1, 3], [2, 3], [3, 3], [4, 0]]);

    // Below the balanced floor for three Gauntlet nodes the whole reservation is rejected, agent included.
    const rejected = reserveAggregateGauntletBudget(compileMultiTargetGauntletPolicy(agentGraph, { scope: "each-target", intensity: "balanced", limits: { maxCostUsd: 5 } }).plan!).reservation!;
    expect(rejected.status).toBe("rejected");
    expect(rejected.allocations.find((item) => item.nodeId === "role-copywriter")).toMatchObject({ targetKind: "agent-x", grantedUsd: 0, reason: "aggregate_cap_rejected" });
  });
});

describe("aggregate Gauntlet budget reservation with synthesis limits", () => {
  // The landing-clinica shape: a standard agent brief, one Gauntlet squad, the synthesis.
  const landingGraph: DependencyGraph = {
    nodes: [
      { id: "brief-main", type: "brief" },
      { id: "visual-brief", type: "agent" },
      { id: "landing-page-nirvana", type: "squad" },
      { id: "final-output", type: "deliverable" },
    ],
    edges: [
      { id: "b1", source: "brief-main", target: "visual-brief", type: "briefs" },
      { id: "d1", source: "landing-page-nirvana", target: "visual-brief", type: "depends_on" },
      { id: "y1", source: "landing-page-nirvana", target: "final-output", type: "yields" },
    ],
  };
  const landingPolicy: MultiTargetGauntletPolicy = {
    scope: "each-target-and-final", intensity: "light", synthesisNodeId: "final-output", limits: { maxCostUsd: 32 },
    targets: { "visual-brief": { mode: "standard" }, "landing-page-nirvana": { limits: { maxCostUsd: 20 } } },
  };
  const reserve = (policy: MultiTargetGauntletPolicy, target: DependencyGraph = landingGraph) => {
    const compiled = compileMultiTargetGauntletPolicy(target, policy);
    expect(compiled.issues).toEqual([]);
    return reserveAggregateGauntletBudget(compiled.plan!).reservation!;
  };
  const grantedOf = (reservation: ReturnType<typeof reserve>) =>
    Object.fromEntries(reservation.allocations.map((item) => [item.nodeId, item.grantedUsd]));

  test("a capped synthesis requests min(cap, its limit) and the squad keeps its own request", () => {
    const reservation = reserve({ ...landingPolicy, synthesis: { limits: { maxCostUsd: 10 } } });
    expect(reservation).toMatchObject({ status: "reserved", aggregateCapUsd: 32, requestedUsd: 30, grantedUsd: 30, balanceUsd: 2 });
    expect(grantedOf(reservation)).toEqual({ "brief-main": 0, "visual-brief": 0, "landing-page-nirvana": 20, "final-output": 10 });
    expect(reservation.allocations.find((item) => item.nodeId === "final-output")).toMatchObject({ requestedUsd: 10, grantedUsd: 10, reason: "requested_in_full" });
    expect(reservation.allocations.find((item) => item.nodeId === "landing-page-nirvana")).toMatchObject({ requestedUsd: 20, grantedUsd: 20, reason: "requested_in_full" });
    expect(reservation.reason).toBe("all gauntlet requests fit within the aggregate cap");
  });

  test("without its own limit the synthesis still requests the whole cap and the squad keeps the floor", () => {
    const reservation = reserve(landingPolicy);
    expect(reservation).toMatchObject({ status: "reserved", requestedUsd: 52, grantedUsd: 32, balanceUsd: 0 });
    expect(grantedOf(reservation)).toEqual({ "brief-main": 0, "visual-brief": 0, "landing-page-nirvana": 1, "final-output": 31 });
  });

  test("a synthesis limit above the cap clamps to the cap", () => {
    const reservation = reserve({ ...landingPolicy, synthesis: { limits: { maxCostUsd: 50 } } });
    expect(reservation.allocations.find((item) => item.nodeId === "final-output")).toMatchObject({ requestedUsd: 32, grantedUsd: 31 });
  });

  test("the balance a capped synthesis leaves is shared by the targets in proportion", () => {
    const policy: MultiTargetGauntletPolicy = {
      scope: "each-target-and-final", intensity: "balanced", synthesisNodeId: "final-output", limits: { maxCostUsd: 32 },
      targets: { "business-a": { limits: { maxCostUsd: 12 } }, "business-b": { limits: { maxCostUsd: 12 } }, "squad-c": { mode: "standard" } },
    };
    // Floors 2 + 2 + 2; the synthesis completes to 10; the 18 left split 9 and 9.
    expect(grantedOf(reserve({ ...policy, synthesis: { limits: { maxCostUsd: 10 } } }, graph)))
      .toEqual({ "brief-main": 0, "business-a": 11, "business-b": 11, "squad-c": 0, "final-output": 10 });
    // Same policy without the synthesis limit: the synthesis takes 28 and the targets stay on the floor.
    expect(grantedOf(reserve(policy, graph)))
      .toEqual({ "brief-main": 0, "business-a": 2, "business-b": 2, "squad-c": 0, "final-output": 28 });
  });

  test("a synthesis limit below its safe minimum rejects the reservation", () => {
    const reservation = reserve({ ...landingPolicy, synthesis: { limits: { maxCostUsd: 0.5 } } });
    expect(reservation).toMatchObject({ status: "rejected", grantedUsd: 0, reason: "decision final-output requests less than its safe minimum" });
  });
});
