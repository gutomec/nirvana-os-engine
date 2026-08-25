import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { DependencyGraph } from "../../_shared/lib/dependency-graph.ts";
import { canonicalJson } from "../lib/run-kernel/canonical-json.ts";
import { reserveAggregateGauntletBudget, type AggregateGauntletBudgetReservation } from "../lib/gauntlet/aggregate-budget.ts";
import {
  coordinateMultiTargetPlan,
  type MultiTargetAdapterInput,
  type MultiTargetCoordinatorPorts,
  type MultiTargetCoordinatorSnapshot,
} from "../lib/gauntlet/multi-target-coordinator.ts";
import { compileMultiTargetGauntletPolicy, type CompiledMultiTargetPlan, type MultiTargetGauntletPolicy } from "../lib/plan-compiler.ts";

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

const mixedPolicy: MultiTargetGauntletPolicy = {
  scope: "each-target-and-final",
  intensity: "light",
  synthesisNodeId: "final-output",
  limits: { maxCostUsd: 10 },
  targets: {
    "business-a": { mode: "standard" },
    "business-b": { limits: { maxCostUsd: 2 } },
    "squad-c": { mode: "standard" },
  },
};

function compile(policy?: MultiTargetGauntletPolicy): {
  plan: CompiledMultiTargetPlan;
  reservation: AggregateGauntletBudgetReservation | null;
} {
  const compiled = compileMultiTargetGauntletPolicy(graph, policy);
  expect(compiled.issues).toEqual([]);
  const reserved = reserveAggregateGauntletBudget(compiled.plan!);
  expect(reserved.issues).toEqual([]);
  return { plan: compiled.plan!, reservation: reserved.reservation };
}

function ports(run: (input: MultiTargetAdapterInput) => Promise<{ state: "delivered" | "withheld" | "failed"; reportedCostUsd: number; outputPaths?: string[]; reason?: string }>): MultiTargetCoordinatorPorts {
  return { standard: { run }, gauntlet: { run } };
}

function redigestReservation(reservation: AggregateGauntletBudgetReservation): AggregateGauntletBudgetReservation {
  const { digest: _digest, ...snapshot } = reservation;
  return { ...snapshot, digest: createHash("sha256").update(canonicalJson(snapshot)).digest("hex") };
}

describe("multi-target wave coordinator", () => {
  test("runs parallel Businesses, then Squad and explicit synthesis with typed modes and upstream paths", async () => {
    const { plan, reservation } = compile(mixedPolicy);
    const calls: MultiTargetAdapterInput[] = [];
    const events: string[] = [];
    const persisted: Array<{ planDigest: string; reservationDigest: string | null }> = [];
    let active = 0;
    let maximumActive = 0;
    let businessStarts = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const run = async (input: MultiTargetAdapterInput) => {
      calls.push(input);
      if (input.nodeId.startsWith("business-")) {
        active++;
        maximumActive = Math.max(maximumActive, active);
        businessStarts++;
        if (businessStarts === 2) release();
        await barrier;
        active--;
      }
      return { state: "delivered" as const, reportedCostUsd: input.mode === "gauntlet" ? 0.5 : 3, outputPaths: [`${input.outputPath}artifact.md`] };
    };
    const snapshot = await coordinateMultiTargetPlan({
      plan,
      reservation,
      ports: {
        ...ports(run),
        journal: {
          persistSnapshots(value) { persisted.push(value); },
          emit(event) { events.push(`${event.type}:${event.nodeId ?? "plan"}`); },
        },
      },
    });

    expect(snapshot.state).toBe("delivered");
    expect(maximumActive).toBe(2);
    expect(calls.map(({ nodeId, mode, target }) => [nodeId, mode, target.kind])).toEqual([
      ["business-a", "standard", "business"],
      ["business-b", "gauntlet", "business"],
      ["squad-c", "standard", "squad"],
      ["final-output", "gauntlet", "synthesis"],
    ]);
    expect(calls.find((call) => call.nodeId === "squad-c")!.upstreamPaths).toEqual([
      "companys/business-a/outputs/artifact.md", "companys/business-b/outputs/artifact.md",
    ]);
    expect(calls.find((call) => call.nodeId === "final-output")!.upstreamPaths).toEqual(["squads/squad-c/outputs/artifact.md"]);
    expect(calls.find((call) => call.nodeId === "business-b")!.grantedCostUsd).toBeGreaterThan(0);
    expect(persisted).toEqual([{ planDigest: plan.digest, reservationDigest: reservation!.digest }]);
    expect(events.indexOf("multi_target.node_delivered:business-a")).toBeLessThan(events.indexOf("multi_target.node_started:squad-c"));
  });

  test("rejects divergent digests and rejected reservations before adapters run", async () => {
    const calls: MultiTargetAdapterInput[] = [];
    const good = compile(mixedPolicy);
    const altered = structuredClone(good.plan);
    altered.manifest.phases[0].outputs_path = "tampered/";
    await expect(coordinateMultiTargetPlan({ plan: altered, reservation: good.reservation, ports: ports(async (value) => {
      calls.push(value); return { state: "delivered", reportedCostUsd: 0 };
    }) })).rejects.toThrow("plan digest mismatch");

    const rejected = compile({ ...mixedPolicy, limits: { maxCostUsd: 1 } });
    expect(rejected.reservation!.status).toBe("rejected");
    await expect(coordinateMultiTargetPlan({ plan: rejected.plan, reservation: rejected.reservation, ports: ports(async (value) => {
      calls.push(value); return { state: "delivered", reportedCostUsd: 0 };
    }) })).rejects.toThrow("reservation rejected");

    const wrongPolicy = redigestReservation({ ...good.reservation!, policyDigest: "wrong-policy" });
    await expect(coordinateMultiTargetPlan({ plan: good.plan, reservation: wrongPolicy, ports: ports(async (value) => {
      calls.push(value); return { state: "delivered", reportedCostUsd: 0 };
    }) })).rejects.toThrow("reservation policy digest mismatch");
    expect(calls).toEqual([]);
  });

  test("withholding blocks downstream without cancelling an independent sibling", async () => {
    const { plan, reservation } = compile(mixedPolicy);
    const called: string[] = [];
    const snapshot = await coordinateMultiTargetPlan({
      plan,
      reservation,
      ports: ports(async (input) => {
        called.push(input.nodeId);
        return input.nodeId === "business-a"
          ? { state: "withheld", reportedCostUsd: 0, reason: "blocking review" }
          : { state: "delivered", reportedCostUsd: 0 };
      }),
    });
    expect(called).toEqual(["business-a", "business-b"]);
    expect(snapshot.nodes.find((node) => node.nodeId === "business-b")!.state).toBe("delivered");
    expect(snapshot.nodes.find((node) => node.nodeId === "squad-c")).toMatchObject({ state: "skipped", blockedBy: ["business-a"] });
    expect(snapshot.nodes.find((node) => node.nodeId === "final-output")).toMatchObject({ state: "skipped", blockedBy: ["squad-c"] });
    expect(snapshot.state).toBe("withheld");
  });

  test("fails closed when a Gauntlet adapter reports cost above its grant", async () => {
    const { plan, reservation } = compile(mixedPolicy);
    const events: string[] = [];
    const snapshot = await coordinateMultiTargetPlan({
      plan,
      reservation,
      ports: {
        ...ports(async (input) => ({
          state: "delivered", reportedCostUsd: input.nodeId === "business-b" ? input.grantedCostUsd + 0.01 : 0,
        })),
        journal: { persistSnapshots() {}, emit(event) { events.push(event.type); } },
      },
    });
    expect(snapshot.nodes.find((node) => node.nodeId === "business-b")!.state).toBe("failed");
    expect(snapshot.nodes.find((node) => node.nodeId === "squad-c")!.state).toBe("skipped");
    expect(snapshot.state).toBe("failed");
    expect(events).toContain("multi_target.budget_exceeded");
  });

  test("resume skips completed nodes and does not assume an unsafe running node", async () => {
    const setup = compile(mixedPolicy);
    const completed = await coordinateMultiTargetPlan({
      ...setup,
      ports: ports(async () => ({ state: "delivered", reportedCostUsd: 0 })),
    });

    const resumedState = structuredClone(completed);
    resumedState.state = "running";
    const completedCalls: string[] = [];
    const resumed = await coordinateMultiTargetPlan({
      ...setup,
      ports: {
        ...ports(async (input) => { completedCalls.push(input.nodeId); return { state: "delivered", reportedCostUsd: 0 }; }),
        state: { load: () => resumedState, save() {} },
      },
    });
    expect(completedCalls).toEqual([]);
    expect(resumed.state).toBe("delivered");

    const unsafe = structuredClone(completed) as MultiTargetCoordinatorSnapshot;
    unsafe.state = "running";
    unsafe.nodes.find((node) => node.nodeId === "business-a")!.state = "running";
    unsafe.nodes.find((node) => node.nodeId === "squad-c")!.state = "pending";
    unsafe.nodes.find((node) => node.nodeId === "final-output")!.state = "pending";
    const unsafeCalls: string[] = [];
    const stalled = await coordinateMultiTargetPlan({
      ...setup,
      ports: {
        ...ports(async (input) => { unsafeCalls.push(input.nodeId); return { state: "delivered", reportedCostUsd: 0 }; }),
        state: { load: () => unsafe, save() {} },
      },
    });
    expect(unsafeCalls).toEqual([]);
    expect(stalled.nodes.find((node) => node.nodeId === "business-a")!.state).toBe("stalled");
    expect(stalled.nodes.find((node) => node.nodeId === "squad-c")!.state).toBe("skipped");
    expect(stalled.state).toBe("failed");
  });

  test("an entirely standard plan uses only the injected legacy adapter", async () => {
    const setup = compile();
    const legacyCalls: MultiTargetAdapterInput[] = [];
    let gauntletCalls = 0;
    const snapshot = await coordinateMultiTargetPlan({
      ...setup,
      ports: {
        standard: { run: async (input) => { legacyCalls.push(input); return { state: "delivered", reportedCostUsd: 2 }; } },
        gauntlet: { run: async () => { gauntletCalls++; return { state: "failed", reportedCostUsd: 0 }; } },
      },
    });
    expect(snapshot.state).toBe("delivered");
    expect(legacyCalls.map((call) => call.nodeId)).toEqual(["business-a", "business-b", "squad-c"]);
    expect(legacyCalls.every((call) => call.mode === "standard" && call.grantedCostUsd === 0)).toBeTrue();
    expect(gauntletCalls).toBe(0);
  });
});
