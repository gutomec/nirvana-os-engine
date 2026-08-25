import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DependencyGraph } from "../../_shared/lib/dependency-graph.ts";
import { reserveAggregateGauntletBudget } from "../lib/gauntlet/aggregate-budget.ts";
import { coordinateMultiTargetPlan, type MultiTargetAdapterInput } from "../lib/gauntlet/multi-target-coordinator.ts";
import { createRunKernelMultiTargetPorts } from "../lib/gauntlet/run-kernel-multi-target-ports.ts";
import { compileMultiTargetGauntletPolicy } from "../lib/plan-compiler.ts";
import { createRun, listEvents, openKernel, type KernelHandle } from "../lib/run-kernel/store.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

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

function plan() {
  const compiled = compileMultiTargetGauntletPolicy(graph, {
    scope: "each-target-and-final", intensity: "light", synthesisNodeId: "final-output", limits: { maxCostUsd: 10 },
    targets: { "business-a": { mode: "standard" }, "business-b": { limits: { maxCostUsd: 2 } }, "squad-c": { mode: "standard" } },
  }).plan!;
  return { plan: compiled, reservation: reserveAggregateGauntletBudget(compiled).reservation! };
}

function fixture(projectId = "project-a", runId = "run-a") {
  const root = mkdtempSync(join(tmpdir(), "nirvana-multi-target-kernel-"));
  roots.push(root);
  const kernel = openKernel(join(root, "kernel.sqlite"));
  createRun(kernel, {
    projectId, runId, traceId: `trace-${runId}`, planId: "plan-multi", target: { kind: "agent-x", slug: "agent-x" },
    policySnapshotRef: "pending", actor: { kind: "test", id: "fixture" }, correlationId: `cor-${runId}`,
    idempotencyKey: `create-${runId}`,
  });
  return { kernel, projectId, runId };
}

const adapter = async (input: MultiTargetAdapterInput) => ({
  state: "delivered" as const,
  reportedCostUsd: 0,
  outputPaths: [`${input.outputPath}artifact.md`],
});

function concrete(args: {
  kernel: KernelHandle;
  projectId: string;
  runId: string;
  ownerId?: string;
  now?: () => number;
  calls?: MultiTargetAdapterInput[];
}) {
  const run = async (input: MultiTargetAdapterInput) => {
    args.calls?.push(input);
    return adapter(input);
  };
  return createRunKernelMultiTargetPorts({
    ...args,
    ownerId: args.ownerId ?? "worker-a",
    actor: { kind: "kernel", id: args.ownerId ?? "worker-a" },
    correlationId: `cor-${args.runId}`,
    leaseDurationMs: 1_000,
    standard: { run },
    gauntlet: { run },
  });
}

describe("Run Kernel multi-target ports", () => {
  test("persists and reloads the coordinator snapshot with causal ordered events", async () => {
    const setup = fixture();
    const compiled = plan();
    const ports = concrete(setup);
    const completed = await coordinateMultiTargetPlan({ ...compiled, ports });
    const reloaded = concrete(setup).state.load();
    expect(reloaded).toEqual(completed);

    const events = listEvents(setup.kernel, setup.projectId).filter((event) => event.runId === setup.runId && event.type.startsWith("multi_target."));
    expect(events.length).toBeGreaterThan(10);
    for (let index = 1; index < events.length; index++) expect(events[index].causationId).toBe(events[index - 1].eventId);
    expect(events.map((event) => event.sequence)).toEqual([...events.map((event) => event.sequence)].sort((a, b) => a - b));
    setup.kernel.close();
  });

  test("restarts after the first execution wave without repeating completed nodes", async () => {
    const setup = fixture();
    const compiled = plan();
    const firstCalls: MultiTargetAdapterInput[] = [];
    const base = concrete({ ...setup, calls: firstCalls });
    let interrupted = false;
    const crashing = {
      ...base,
      state: {
        load: base.state.load,
        save(snapshot: Parameters<typeof base.state.save>[0]) {
          const businessesDone = snapshot.nodes.filter((node) => node.nodeId.startsWith("business-")).every((node) => node.state === "delivered");
          if (!interrupted && snapshot.currentWave === 1 && businessesDone) {
            interrupted = true;
            throw new Error("simulated crash between terminal events and snapshot");
          }
          base.state.save(snapshot);
        },
      },
    };
    await expect(coordinateMultiTargetPlan({ ...compiled, ports: crashing })).rejects.toThrow("terminal events and snapshot");
    expect(firstCalls.map((call) => call.nodeId).sort()).toEqual(["business-a", "business-b"]);

    const resumedCalls: MultiTargetAdapterInput[] = [];
    const resumed = await coordinateMultiTargetPlan({ ...compiled, ports: concrete({ ...setup, calls: resumedCalls }) });
    expect(resumed.state).toBe("delivered");
    expect(resumedCalls.map((call) => call.nodeId)).toEqual(["squad-c", "final-output"]);
    setup.kernel.close();
  });

  test("a valid same-owner lease resumes a running node after crash", async () => {
    const setup = fixture();
    const compiled = plan();
    let crashed = false;
    const base = concrete(setup);
    const crashing = {
      ...base,
      state: {
        load: base.state.load,
        save(snapshot: Parameters<typeof base.state.save>[0]) {
          base.state.save(snapshot);
          const runningBusiness = snapshot.nodes.some((node) => node.nodeId.startsWith("business-") && node.state === "running");
          if (!crashed && runningBusiness) { crashed = true; throw new Error("simulated crash with live leases"); }
        },
      },
    };
    await expect(coordinateMultiTargetPlan({ ...compiled, ports: crashing })).rejects.toThrow("live leases");

    const resumedCalls: MultiTargetAdapterInput[] = [];
    const result = await coordinateMultiTargetPlan({ ...compiled, ports: concrete({ ...setup, calls: resumedCalls }) });
    expect(result.state).toBe("delivered");
    expect(resumedCalls.filter((call) => call.nodeId.startsWith("business-")).every((call) => call.resume)).toBeTrue();
    setup.kernel.close();
  });

  test("expired or foreign-owner leases cannot resume automatically", async () => {
    let clock = 1_000;
    const setup = fixture();
    const compiled = plan();
    const owner = concrete({ ...setup, now: () => clock });
    let crashed = false;
    const crashing = {
      ...owner,
      state: {
        load: owner.state.load,
        save(snapshot: Parameters<typeof owner.state.save>[0]) {
          owner.state.save(snapshot);
          if (!crashed && snapshot.nodes.some((node) => node.nodeId.startsWith("business-") && node.state === "running")) {
            crashed = true;
            throw new Error("simulated crash before adapters");
          }
        },
      },
    };
    await expect(coordinateMultiTargetPlan({ ...compiled, ports: crashing })).rejects.toThrow("before adapters");

    const foreign = concrete({ ...setup, ownerId: "worker-b", now: () => clock });
    expect(foreign.lease.canResume("business-a")).toBeFalse();
    clock += 2_000;
    expect(owner.lease.canResume("business-a")).toBeFalse();
    const stalled = await coordinateMultiTargetPlan({ ...compiled, ports: owner });
    expect(stalled.nodes.find((node) => node.nodeId === "business-a")!.state).toBe("stalled");
    setup.kernel.close();
  });

  test("claim is atomic, owner-bound, renewable and idempotent", () => {
    let clock = 5_000;
    const setup = fixture();
    const first = concrete({ ...setup, ownerId: "worker-a", now: () => clock });
    const second = concrete({ ...setup, ownerId: "worker-b", now: () => clock });
    expect(first.lease.claim("business-a")).toBeTrue();
    expect(first.lease.claim("business-a")).toBeTrue();
    expect(second.lease.claim("business-a")).toBeFalse();
    expect(first.lease.renew("business-a")).toBeTrue();
    expect(second.lease.renew("business-a")).toBeFalse();
    clock += 2_000;
    expect(second.lease.claim("business-a")).toBeTrue();
    expect(first.lease.release("business-a")).toBeFalse();
    expect(second.lease.release("business-a")).toBeTrue();
    const claims = listEvents(setup.kernel, setup.projectId).filter((event) => event.type === "multi_target.lease_claimed");
    expect(claims).toHaveLength(2);
    setup.kernel.close();
  });

  test("replay does not duplicate events and projects remain isolated", () => {
    const first = fixture("project-a", "shared-run");
    const second = fixture("project-b", "shared-run");
    const firstPorts = concrete(first);
    const secondPorts = concrete(second);
    const snapshot = {
      schemaVersion: "nirvana.multi-target-coordinator/v1alpha1" as const,
      planDigest: "plan", reservationDigest: "reservation", state: "ready" as const,
      currentWave: -1, nodes: [], reportedCostUsd: 0, version: 1,
    };
    firstPorts.journal.persistSnapshots({ planDigest: "plan", reservationDigest: "reservation" });
    firstPorts.journal.persistSnapshots({ planDigest: "plan", reservationDigest: "reservation" });
    firstPorts.state.save(snapshot);
    firstPorts.state.save(snapshot);
    secondPorts.state.save({ ...snapshot, planDigest: "other-plan" });
    expect(listEvents(first.kernel, first.projectId).filter((event) => event.type.startsWith("multi_target."))).toHaveLength(2);
    expect(firstPorts.state.load()!.planDigest).toBe("plan");
    expect(secondPorts.state.load()!.planDigest).toBe("other-plan");
    first.kernel.close();
    second.kernel.close();
  });

  test("persisted plan or reservation divergence fails closed", async () => {
    const setup = fixture();
    const compiled = plan();
    const ports = concrete(setup);
    ports.state.save({
      schemaVersion: "nirvana.multi-target-coordinator/v1alpha1",
      planDigest: "wrong-plan", reservationDigest: "wrong-reservation", state: "ready",
      currentWave: -1, nodes: [], reportedCostUsd: 0, version: 1,
    });
    await expect(coordinateMultiTargetPlan({ ...compiled, ports })).rejects.toThrow("persisted snapshot does not match");
    setup.kernel.close();
  });
});
