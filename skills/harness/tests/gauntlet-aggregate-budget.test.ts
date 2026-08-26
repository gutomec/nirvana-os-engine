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
