import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { DependencyGraph } from "../../_shared/lib/dependency-graph.ts";
import { reserveAggregateGauntletBudget } from "../lib/gauntlet/aggregate-budget.ts";
import { projectMultiTargetRun } from "../lib/gauntlet/index.ts";
import { coordinateMultiTargetPlan, type MultiTargetAdapterInput, type MultiTargetCoordinatorSnapshot } from "../lib/gauntlet/multi-target-coordinator.ts";
import { createRunKernelMultiTargetPorts } from "../lib/gauntlet/run-kernel-multi-target-ports.ts";
import { compileMultiTargetGauntletPolicy } from "../lib/plan-compiler.ts";
import { createRun, listEvents, openKernel, type KernelHandle } from "../lib/run-kernel/store.ts";
import { removeDir } from "./helpers/temp-dirs.ts";

const roots: string[] = [];
const projectId = "prj_multi-target";
const multiRunId = "run_multi-target";
const plainRunId = "run_plain";
let instance: any;
let base = "";
let completed: MultiTargetCoordinatorSnapshot;

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

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-glance-multi-target-"));
  roots.push(root);
  return root;
}

function seedRun(kernel: KernelHandle, runId: string): void {
  createRun(kernel, { projectId, runId, traceId: `trace_${runId}`, planId: "plan_multi", target: { kind: "agent-x", slug: "agent-x" },
    policySnapshotRef: "pending", actor: { kind: "test", id: "glance" }, correlationId: `cor_${runId}`, idempotencyKey: `create-${runId}` });
}

// Deterministic adapter: every node delivers and reports a small cost inside its grant.
async function adapter(input: MultiTargetAdapterInput) {
  return { state: "delivered" as const, reportedCostUsd: input.mode === "gauntlet" ? Math.min(0.25, input.grantedCostUsd) : 0.25, outputPaths: [`${input.outputPath}artifact.md`] };
}

function ports(kernel: KernelHandle, runId: string) {
  return createRunKernelMultiTargetPorts({ kernel, projectId, runId, ownerId: "worker-a", actor: { kind: "kernel", id: "worker-a" },
    correlationId: `cor_${runId}`, leaseDurationMs: 1_000, standard: { run: adapter }, gauntlet: { run: adapter } });
}

beforeAll(async () => {
  const root = tempRoot();
  process.env.NIRVANA_PROJECT_ROOT = root;
  fs.mkdirSync(path.join(root, ".nirvana"), { recursive: true });
  const kernel = openKernel(path.join(root, ".nirvana", "run-kernel.sqlite"));
  seedRun(kernel, multiRunId);
  seedRun(kernel, plainRunId);
  completed = await coordinateMultiTargetPlan({ ...plan(), ports: ports(kernel, multiRunId) });
  kernel.close();
  const { startServer } = await import("../lib/glance/server.ts");
  instance = await startServer({ port: 0, open: false, idleMin: 60, allowActions: false, theme: "apple" });
  base = `http://127.0.0.1:${instance.port}`;
});
afterAll(() => {
  try { instance?.close(); } catch {}
  delete process.env.NIRVANA_PROJECT_ROOT;
  while (roots.length) removeDir(roots.pop()!);
});

describe("Glance multi-target projection", () => {
  test("GET /api/v1/runs/:run/multi-target mirrors the coordinator's final snapshot", async () => {
    const response = await fetch(`${base}/api/v1/runs/${multiRunId}/multi-target?project_id=${projectId}`);
    expect(response.status).toBe(200);
    const body = await response.json() as { projection: MultiTargetCoordinatorSnapshot };
    expect(body.projection).toEqual(completed);
    expect(body.projection.state).toBe("delivered");
    expect(body.projection.nodes.map(node => node.state)).toEqual(["delivered", "delivered", "delivered", "delivered", "delivered"]);
    expect(body.projection.reportedCostUsd).toBeCloseTo(completed.nodes.reduce((sum, node) => sum + node.reportedCostUsd, 0));
  });

  test("a Run without multi-target events answers projection null", async () => {
    const response = await fetch(`${base}/api/v1/runs/${plainRunId}/multi-target?project_id=${projectId}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ projection: null });
  });

  test("an unknown Run is 404 and an invalid project is 400", async () => {
    expect((await fetch(`${base}/api/v1/runs/run_missing/multi-target?project_id=${projectId}`)).status).toBe(404);
    expect((await fetch(`${base}/api/v1/runs/${multiRunId}/multi-target?project_id=nope`)).status).toBe(400);
    expect((await fetch(`${base}/api/v1/runs/${multiRunId}/multi-target`)).status).toBe(400);
  });

  test("/events exposes the multi_target.* journal in sequence order", async () => {
    const page = await fetch(`${base}/api/v1/projects/${projectId}/events?after=0&limit=500`).then(r => r.json()) as { events: Array<{ runId: string; type: string; sequence: number }> };
    const events = page.events.filter(event => event.runId === multiRunId && event.type.startsWith("multi_target."));
    expect(events.length).toBeGreaterThan(10);
    expect(events.map(event => event.sequence)).toEqual([...events.map(event => event.sequence)].sort((a, b) => a - b));
    expect(events.map(event => event.type)).toContain("multi_target.snapshot_saved");
    expect(events.at(-1)?.type).toBe("multi_target.plan_terminal");
  });

  test("projectMultiTargetRun replays node events recorded after the last snapshot", async () => {
    const kernel = openKernel(path.join(tempRoot(), "kernel.sqlite"));
    const runId = "run_crash";
    seedRun(kernel, runId);
    const kernelPorts = ports(kernel, runId);
    let interrupted = false;
    const crashing = {
      ...kernelPorts,
      state: {
        load: kernelPorts.state.load,
        save(snapshot: MultiTargetCoordinatorSnapshot) {
          const businessesDone = snapshot.nodes.filter(node => node.nodeId.startsWith("business-")).every(node => node.state === "delivered");
          if (!interrupted && snapshot.currentWave === 1 && businessesDone) {
            interrupted = true;
            throw new Error("simulated crash between terminal events and snapshot");
          }
          kernelPorts.state.save(snapshot);
        },
      },
    };
    await expect(coordinateMultiTargetPlan({ ...plan(), ports: crashing })).rejects.toThrow("terminal events and snapshot");

    const events = listEvents(kernel, projectId).filter(event => event.runId === runId);
    const lastSnapshot = (events.filter(event => event.type === "multi_target.snapshot_saved").at(-1)!.payload as { snapshot: MultiTargetCoordinatorSnapshot }).snapshot;
    expect(lastSnapshot.nodes.filter(node => node.nodeId.startsWith("business-")).map(node => node.state)).toEqual(["running", "running"]);
    expect(events.filter(event => event.type === "multi_target.node_delivered").length).toBe(2);

    const projected = projectMultiTargetRun(kernel, projectId, runId)!;
    expect(projected.nodes.filter(node => node.nodeId.startsWith("business-")).map(node => node.state)).toEqual(["delivered", "delivered"]);
    expect(projected.state).toBe("running");
    expect(projected.currentWave).toBe(1);
    expect(projected.reportedCostUsd).toBeGreaterThan(0);
    expect(projected.reportedCostUsd).toBeCloseTo(projected.nodes.reduce((sum, node) => sum + node.reportedCostUsd, 0));
    expect(projected).toEqual(kernelPorts.state.load()!);
    expect(projectMultiTargetRun(kernel, projectId, "run_absent")).toBeNull();
    kernel.close();
  });
});
