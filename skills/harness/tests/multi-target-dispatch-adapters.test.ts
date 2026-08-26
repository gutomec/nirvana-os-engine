import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { DependencyGraph } from "../../_shared/lib/dependency-graph.ts";
import { reserveAggregateGauntletBudget } from "../lib/gauntlet/aggregate-budget.ts";
import { coordinateMultiTargetPlan, type MultiTargetAdapterInput } from "../lib/gauntlet/multi-target-coordinator.ts";
import { costMatcher, createDispatchMultiTargetAdapters, MULTI_TARGET_RESULT_MARKER, type DispatchSpawn } from "../lib/gauntlet/multi-target-dispatch-adapters.ts";
import { createRunKernelMultiTargetPorts } from "../lib/gauntlet/run-kernel-multi-target-ports.ts";
import { compileMultiTargetGauntletPolicy, type CompiledMultiTargetPlan } from "../lib/plan-compiler.ts";
import { createRun, listEvents, openKernel, type KernelHandle } from "../lib/run-kernel/store.ts";
import { writeFakeDispatch } from "./helpers/fake-dispatch.ts";
import { removeDir } from "./helpers/temp-dirs.ts";
import { SCOPE_GUARD_EN } from "../../_shared/lib/scope-guard.ts";
import { spawnBudgetMs } from "./helpers/test-budgets.ts";

const roots: string[] = [];
const handles: KernelHandle[] = [];
afterEach(() => {
  while (handles.length) handles.pop()!.close();
  for (const root of roots.splice(0)) removeDir(root);
});

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

function compile() {
  const compiled = compileMultiTargetGauntletPolicy(graph, {
    scope: "each-target-and-final", intensity: "light", synthesisNodeId: "final-output", limits: { maxCostUsd: 10 },
    targets: { "business-a": { mode: "standard" }, "business-b": { limits: { maxCostUsd: 2 } }, "squad-c": { mode: "standard" } },
  });
  expect(compiled.issues).toEqual([]);
  return { plan: compiled.plan!, reservation: reserveAggregateGauntletBudget(compiled.plan!).reservation! };
}

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "nirvana-multi-target-adapters-")));
  roots.push(root);
  const projectRoot = join(root, "project");
  const projectId = "trace-multi";
  const workspaceRoot = join(projectRoot, ".nirvana", "outputs", projectId);
  mkdirSync(workspaceRoot, { recursive: true });
  writeFileSync(join(workspaceRoot, "brief-enriched.md"), "# Brief\n", "utf8");
  const dispatchScriptPath = writeFakeDispatch(root);
  return { root, projectRoot, projectId, workspaceRoot, dispatchScriptPath, spawnLog: join(root, "spawns.log") };
}

type Fixture = ReturnType<typeof fixture>;

function adapters(setup: Fixture, plan: CompiledMultiTargetPlan, env: Record<string, string> = {}, extra: { runtime?: string; budgetUsd?: Record<string, number> } = {}) {
  return createDispatchMultiTargetAdapters({
    projectRoot: setup.projectRoot, projectId: setup.projectId, plan,
    nodeBriefs: {
      "business-a": "Deliver part A.", "business-b": "Deliver part B.",
      "squad-c": "Assemble C from A and B.", "final-output": "Write the final report.",
    },
    dispatchScriptPath: setup.dispatchScriptPath,
    // One audit log per fixture. The adapter sums agent_executed.cost_usd by trace and target, the
    // trace id is the same in every fixture, and other test files set HARNESS_LOGS_DIR at module
    // scope without restoring it; under one shared log the sums of earlier tests leaked in (CI).
    env: { FAKE_DISPATCH_SPAWN_LOG: setup.spawnLog, HARNESS_LOGS_DIR: join(setup.root, "logs"), ...env },
    ...extra,
  });
}

function nodeInput(plan: CompiledMultiTargetPlan, nodeId: string, overrides: Partial<MultiTargetAdapterInput> = {}): MultiTargetAdapterInput {
  const decision = [...plan.decisions, ...(plan.synthesis ? [plan.synthesis] : [])].find((item) => item.nodeId === nodeId)!;
  const phase = plan.manifest.phases.find((item) => item.id === nodeId)!;
  return {
    nodeId, target: { kind: decision.targetKind as MultiTargetAdapterInput["target"]["kind"], id: nodeId },
    mode: decision.mode, intensity: decision.intensity, grantedCostUsd: 0, upstreamPaths: [],
    outputPath: phase.outputs_path, idempotencyKey: `multi-target:${plan.digest}:${nodeId}`, resume: false,
    ...overrides,
  };
}

interface Capture { argv: string[]; positional: string[]; env: Record<string, string>; cwd: string; brief: string }

function capture(setup: Fixture, outputPath: string): Capture {
  return JSON.parse(readFileSync(join(setup.workspaceRoot, outputPath, "dispatch-capture.json"), "utf8")) as Capture;
}

function flag(captured: Capture, name: string): string | undefined {
  const index = captured.argv.indexOf(name);
  return index < 0 ? undefined : captured.argv[index + 1];
}

function spawnCount(setup: Fixture): number {
  try { return readFileSync(setup.spawnLog, "utf8").split("\n").filter(Boolean).length; } catch { return 0; }
}

describe("multi-target dispatch adapters", () => {
  test("standard business selects the slug explicitly with --business, exec, project and an absolute outputs root", async () => {
    const setup = fixture();
    const { plan } = compile();
    const result = await adapters(setup, plan, { FAKE_DISPATCH_COST_USD: "0.4" }, { runtime: "codex" }).standard.run(nodeInput(plan, "business-a"));
    expect(result).toEqual({ state: "delivered", reportedCostUsd: 0.4, costObserved: true, outputPaths: ["businesses/business-a/outputs/"] });
    const captured = capture(setup, "businesses/business-a/outputs/");
    expect(captured.positional).toEqual([]);
    // The caller's HARNESS_LOGS_DIR reaches the child untouched.
    expect(captured.env.HARNESS_LOGS_DIR).toBe(join(setup.root, "logs"));
    expect(flag(captured, "--business")).toBe("business-a");
    expect(captured.argv).not.toContain("--auto");
    expect(captured.argv).toContain("--exec");
    expect(flag(captured, "--project")).toBe(setup.projectId);
    expect(isAbsolute(flag(captured, "--outputs-root")!)).toBeTrue();
    expect(flag(captured, "--outputs-root")).toBe(join(setup.workspaceRoot, "businesses", "business-a", "outputs"));
    expect(flag(captured, "--runtime")).toBe("codex");
    expect(captured.argv).not.toContain("--max-budget");
    expect(captured.argv.some((item) => item.startsWith("--execution-mode") || item.startsWith("--gauntlet-intensity"))).toBeFalse();
    expect(captured.env.NIRVANA_BUSINESS_GAUNTLET_ALLOWLIST ?? "").not.toContain("business-a");
    expect(captured.cwd).toBe(setup.projectRoot);
    expect(captured.brief).toStartWith("Deliver part A.");
    expect(existsSync(join(setup.workspaceRoot, "businesses", "business-a", MULTI_TARGET_RESULT_MARKER))).toBeTrue();
  }, spawnBudgetMs(1));

  test("gauntlet business adds the Gauntlet flags, allowlists the slug and passes every intensity through", async () => {
    const setup = fixture();
    const { plan } = compile();
    const ports = adapters(setup, plan, { NIRVANA_BUSINESS_GAUNTLET_ALLOWLIST: "other-business" });
    const result = await ports.gauntlet.run(nodeInput(plan, "business-b", { grantedCostUsd: 2 }));
    expect(result.state).toBe("delivered");
    const captured = capture(setup, "businesses/business-b/outputs/");
    expect(flag(captured, "--business")).toBe("business-b");
    expect(captured.argv).toContain("--execution-mode=gauntlet");
    expect(captured.argv).toContain("--gauntlet-intensity=light");
    expect(flag(captured, "--max-budget")).toBe("2");
    expect(captured.env.NIRVANA_BUSINESS_GAUNTLET_ALLOWLIST.split(",")).toEqual(["other-business", "business-b"]);
    expect(spawnCount(setup)).toBe(1);

    for (const intensity of ["balanced", "exhaustive"] as const) {
      const passed = await ports.gauntlet.run(nodeInput(plan, "business-b", { intensity, idempotencyKey: `key-${intensity}` }));
      expect(passed.state).toBe("delivered");
      expect(capture(setup, "businesses/business-b/outputs/").argv).toContain(`--gauntlet-intensity=${intensity}`);
      expect(readFileSync(join(setup.workspaceRoot, "businesses", "business-b", "DISPATCH-INSTRUCTION.md"), "utf8")).toContain(`gauntlet (intensity ${intensity})`);
    }
    expect(spawnCount(setup)).toBe(3);
  }, spawnBudgetMs(3));

  test("squad and synthesis select the target with --squad and --agent-x, never --auto, and pass the intensity through", async () => {
    const setup = fixture();
    const { plan } = compile();
    const ports = adapters(setup, plan, { FAKE_DISPATCH_COST_USD: "0.1" });
    const squad = await ports.standard.run(nodeInput(plan, "squad-c", {
      upstreamPaths: ["briefs/brief-main/outputs/", "businesses/business-a/outputs/", "businesses/business-b/outputs/"],
    }));
    expect(squad).toMatchObject({ state: "delivered", reportedCostUsd: 0.1 });
    const squadCapture = capture(setup, "squads/squad-c/outputs/");
    expect(squadCapture.positional).toEqual([]);
    expect(squadCapture.argv).not.toContain("--auto");
    expect(flag(squadCapture, "--squad")).toBe("squad-c");
    expect(squadCapture.brief).toStartWith("Assemble C from A and B.");

    const squadGauntlet = await ports.gauntlet.run(nodeInput(plan, "squad-c", { mode: "gauntlet", intensity: "balanced", grantedCostUsd: 1, idempotencyKey: "squad-c-balanced" }));
    expect(squadGauntlet).toMatchObject({ state: "delivered" });
    expect(capture(setup, "squads/squad-c/outputs/").argv).toContain("--gauntlet-intensity=balanced");

    const synthesis = await ports.gauntlet.run(nodeInput(plan, "final-output", { intensity: "exhaustive", grantedCostUsd: 1, upstreamPaths: ["squads/squad-c/outputs/"] }));
    expect(synthesis).toMatchObject({ state: "delivered", reportedCostUsd: 0.1 });
    const synthesisCapture = capture(setup, "deliverables/final-output/outputs/");
    expect(synthesisCapture.positional).toEqual([]);
    expect(synthesisCapture.argv).not.toContain("--auto");
    expect(synthesisCapture.argv).toContain("--agent-x");
    expect(synthesisCapture.argv).toContain("--execution-mode=gauntlet");
    expect(synthesisCapture.argv).toContain("--gauntlet-intensity=exhaustive");
    expect(synthesisCapture.brief).toStartWith("Write the final report.");
    expect(synthesisCapture.brief).toContain(join(setup.workspaceRoot, "squads", "squad-c", "outputs", "_SUMMARY.md"));
  }, spawnBudgetMs(3));

  test("exit codes 0, 2, 3 and 1 map onto delivered, withheld, withheld (indeterminate) and failed", async () => {
    const setup = fixture();
    const { plan } = compile();
    const outcomes: Array<[string, string]> = [];
    for (const [code, key] of [["0", "k0"], ["2", "k2"], ["3", "k3"], ["1", "k1"]]) {
      const result = await adapters(setup, plan, { FAKE_DISPATCH_EXIT_CODE: code }).standard.run(nodeInput(plan, "business-a", { idempotencyKey: key }));
      outcomes.push([result.state, result.reason ?? ""]);
    }
    expect(outcomes.map(([state]) => state)).toEqual(["delivered", "withheld", "withheld", "failed"]);
    expect(outcomes[0][1]).toBe("");
    expect(outcomes[1][1]).toContain("exit 2");
    expect(outcomes[2][1]).toStartWith("indeterminate");
    expect(outcomes[3][1]).toContain("dispatch exit 1");
    expect(outcomes[3][1]).toContain("fake dispatch stopped with exit 1");
    expect(spawnCount(setup)).toBe(4);
  }, spawnBudgetMs(4));

  test("DISPATCH-INSTRUCTION.md names the upstream _SUMMARY.md paths, the downstreams and the output path", async () => {
    const setup = fixture();
    const { plan } = compile();
    await adapters(setup, plan).standard.run(nodeInput(plan, "squad-c", {
      upstreamPaths: ["briefs/brief-main/outputs/", "businesses/business-a/outputs/", "businesses/business-b/outputs/"],
    }));
    const text = readFileSync(join(setup.workspaceRoot, "squads", "squad-c", "DISPATCH-INSTRUCTION.md"), "utf8");
    expect(text).toContain("target: squad/squad-c");
    expect(text).toContain("phase_id: squad-c");
    expect(text).toContain(`trace_id: ${setup.projectId}`);
    expect(text).toContain(join(setup.workspaceRoot, "brief-enriched.md"));
    expect(text).toContain(join(setup.workspaceRoot, "businesses", "business-a", "outputs", "_SUMMARY.md"));
    expect(text).toContain(join(setup.workspaceRoot, "businesses", "business-b", "outputs", "_SUMMARY.md"));
    expect(text).not.toContain("brief-main");
    expect(text).toContain("**final-output**");
    expect(text).toContain(join(setup.workspaceRoot, "squads", "squad-c", "outputs", "_SUMMARY.md"));
    expect(text.slice(text.indexOf("## 6. Scope isolation"))).toContain(SCOPE_GUARD_EN);
    expect(existsSync(join(setup.workspaceRoot, "squads", "squad-c", "outputs"))).toBeTrue();
  }, spawnBudgetMs(1));

  test("the result marker prevents a second spawn for the same key while a different key runs again", async () => {
    const setup = fixture();
    const { plan } = compile();
    const ports = adapters(setup, plan, { FAKE_DISPATCH_COST_USD: "0.3" });
    const first = await ports.standard.run(nodeInput(plan, "business-a"));
    expect(spawnCount(setup)).toBe(1);
    const marker = JSON.parse(readFileSync(join(setup.workspaceRoot, "businesses", "business-a", MULTI_TARGET_RESULT_MARKER), "utf8"));
    expect(marker).toMatchObject({ idempotencyKey: `multi-target:${plan.digest}:business-a`, state: "delivered", exitCode: 0, reportedCostUsd: 0.3, costObserved: true });
    expect(typeof marker.finishedAt).toBe("string");

    const resumed = await ports.standard.run(nodeInput(plan, "business-a", { resume: true }));
    expect(resumed).toEqual(first);
    expect(spawnCount(setup)).toBe(1);

    const other = await ports.standard.run(nodeInput(plan, "business-a", { idempotencyKey: "another-plan" }));
    expect(spawnCount(setup)).toBe(2);
    expect(other).toMatchObject({ state: "delivered", reportedCostUsd: 0.6 });
  }, spawnBudgetMs(2));

  test("the child audits where the adapter reads: HARNESS_LOGS_DIR is pinned to the project's harness log, and a node without a cost event is reported as unobserved", async () => {
    const setup = fixture();
    const { plan } = compile();
    // The fake mimics dispatch.ts: without HARNESS_LOGS_DIR it writes agent_executed under the scaffold it
    // creates (outputs/<pid>/.nirvana/logs/harness), which the first real smoke run showed the coordinator never
    // read (USD 2.15 delivered, USD 0 recorded). The variable is removed from this process so the adapter
    // resolves the directory from projectRoot, the way `nrv multi-target run` does.
    const previous = process.env.HARNESS_LOGS_DIR;
    delete process.env.HARNESS_LOGS_DIR;
    try {
      const build = (env: Record<string, string>, spawn?: DispatchSpawn) => createDispatchMultiTargetAdapters({
        projectRoot: setup.projectRoot, projectId: setup.projectId, plan, nodeBriefs: { "business-a": "Deliver part A.", "business-b": "Deliver part B." },
        dispatchScriptPath: setup.dispatchScriptPath, env: { FAKE_DISPATCH_SPAWN_LOG: setup.spawnLog, ...env }, ...(spawn ? { spawn } : {}),
      });
      const projectLogs = join(setup.projectRoot, ".nirvana", "logs", "harness");
      const scaffoldLogs = join(setup.projectRoot, "outputs", setup.projectId, ".nirvana", "logs", "harness");

      const observed = await build({ FAKE_DISPATCH_COST_USD: "2.15" }).standard.run(nodeInput(plan, "business-a"));
      expect(observed).toEqual({ state: "delivered", reportedCostUsd: 2.15, costObserved: true, outputPaths: ["businesses/business-a/outputs/"] });
      expect(capture(setup, "businesses/business-a/outputs/").env.HARNESS_LOGS_DIR).toBe(projectLogs);
      expect(readdirSync(projectLogs)).toHaveLength(1);
      expect(existsSync(scaffoldLogs)).toBeFalse();

      // What the adapter did before: the same child with the variable stripped writes its cost under the
      // scaffold, and the parent, reading the project's log, no longer reports a silent zero but an unobserved cost.
      const leaky: DispatchSpawn = async (request) => {
        const env = { ...request.env };
        delete env.HARNESS_LOGS_DIR;
        const child = Bun.spawn(request.command, { cwd: request.cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
        const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        return { exitCode, stdout, stderr };
      };
      const drifted = await build({ FAKE_DISPATCH_COST_USD: "2.15" }, leaky).standard.run(nodeInput(plan, "business-b", { idempotencyKey: "drifted" }));
      expect(drifted).toEqual({ state: "delivered", reportedCostUsd: 0, costObserved: false, outputPaths: ["businesses/business-b/outputs/"] });
      expect(existsSync(scaffoldLogs)).toBeTrue();
      expect(readFileSync(join(scaffoldLogs, readdirSync(scaffoldLogs)[0], "audit.jsonl"), "utf8")).toContain('"cost_usd":2.15');

      // A child that leaves no cost event at all: unobserved, and the marker remembers it.
      const silent = await build({ FAKE_DISPATCH_COST_USD: "0" }).standard.run(nodeInput(plan, "business-b"));
      expect(silent).toEqual({ state: "delivered", reportedCostUsd: 0, costObserved: false, outputPaths: ["businesses/business-b/outputs/"] });
      const marker = JSON.parse(readFileSync(join(setup.workspaceRoot, "businesses", "business-b", MULTI_TARGET_RESULT_MARKER), "utf8"));
      expect(marker).toMatchObject({ state: "delivered", reportedCostUsd: 0, costObserved: false });
      expect(await build({ FAKE_DISPATCH_COST_USD: "9" }).standard.run(nodeInput(plan, "business-b", { resume: true }))).toEqual(silent);
      expect(spawnCount(setup)).toBe(3);
    } finally {
      if (previous !== undefined) process.env.HARNESS_LOGS_DIR = previous;
    }
  }, spawnBudgetMs(3));

  test("an aborted signal kills the subprocess and returns failed without a marker", async () => {
    const setup = fixture();
    const { plan } = compile();
    const ports = adapters(setup, plan, { FAKE_DISPATCH_SLEEP_MS: "20000" });
    const controller = new AbortController();
    const pending = ports.standard.run(nodeInput(plan, "business-a", { signal: controller.signal }));
    const captureFile = join(setup.workspaceRoot, "businesses", "business-a", "outputs", "dispatch-capture.json");
    // The fake writes its capture, then its spawn-log line, then sleeps. Aborting the instant the capture
    // existed killed it between the two writes on the Windows runner (PR #96, run 32931392895: spawnCount
    // read 0), so the spawn record is the signal to wait for; once it is on disk the kill can land anywhere.
    const deadline = Date.now() + 10_000;
    while (spawnCount(setup) < 1 && Date.now() < deadline) await Bun.sleep(20);
    expect(spawnCount(setup)).toBe(1);
    expect(existsSync(captureFile)).toBeTrue();
    const abortedAt = Date.now();
    controller.abort("lease_lost");
    const result = await pending;
    expect(Date.now() - abortedAt).toBeLessThan(5_000);
    expect(result).toEqual({ state: "failed", reportedCostUsd: 0, reason: "aborted: lease_lost" });
    expect(existsSync(join(setup.workspaceRoot, "businesses", "business-a", MULTI_TARGET_RESULT_MARKER))).toBeFalse();
    expect(existsSync(join(setup.workspaceRoot, "businesses", "business-a", "outputs", "_SUMMARY.md"))).toBeFalse();

    const early = new AbortController();
    early.abort("early");
    expect(await ports.standard.run(nodeInput(plan, "business-b", { signal: early.signal }))).toEqual({ state: "failed", reportedCostUsd: 0, reason: "aborted: early" });
    expect(spawnCount(setup)).toBe(1);
  }, spawnBudgetMs(1));

  test("coordinator, kernel ports and adapters run the waves through the fake dispatch and resume without re-spawning", async () => {
    const setup = fixture();
    const { plan, reservation } = compile();
    const ws = setup.workspaceRoot;
    const kernel = openKernel(join(setup.root, "kernel.sqlite"));
    handles.push(kernel);
    createRun(kernel, {
      projectId: setup.projectId, runId: "run-multi", traceId: setup.projectId, planId: "plan-multi",
      target: { kind: "agent-x", slug: "agent-x" }, policySnapshotRef: "pending", actor: { kind: "test", id: "fixture" },
      correlationId: "cor-multi", idempotencyKey: "create-run-multi",
    });
    const execution = adapters(setup, plan, { FAKE_DISPATCH_COST_USD: "0.25", NIRVANA_BUSINESS_GAUNTLET_ALLOWLIST: "" });
    const ports = () => createRunKernelMultiTargetPorts({
      kernel, projectId: setup.projectId, runId: "run-multi", ownerId: "worker-a", actor: { kind: "kernel", id: "worker-a" },
      correlationId: "cor-multi", leaseDurationMs: 5_000, ...execution,
    });

    const base = ports();
    let crashed = false;
    const crashing = {
      ...base,
      journal: {
        persistSnapshots: base.journal.persistSnapshots,
        emit(event: Parameters<typeof base.journal.emit>[0]) {
          if (!crashed && event.type === "multi_target.node_delivered" && event.nodeId === "business-a") {
            crashed = true;
            throw new Error("simulated crash before business-a was journaled");
          }
          base.journal.emit(event);
        },
      },
    };
    await expect(coordinateMultiTargetPlan({ plan, reservation, ports: crashing })).rejects.toThrow("simulated crash");
    expect(spawnCount(setup)).toBe(2);

    const snapshot = await coordinateMultiTargetPlan({ plan, reservation, ports: ports() });
    expect(snapshot.state).toBe("delivered");
    expect(spawnCount(setup)).toBe(4);
    const spawns = readFileSync(setup.spawnLog, "utf8").trim().split("\n");
    expect(spawns.slice(0, 2).sort()).toEqual([join(ws, "businesses", "business-a", "outputs"), join(ws, "businesses", "business-b", "outputs")]);
    expect(spawns.slice(2)).toEqual([join(ws, "squads", "squad-c", "outputs"), join(ws, "deliverables", "final-output", "outputs")]);

    const squadInstruction = readFileSync(join(ws, "squads", "squad-c", "DISPATCH-INSTRUCTION.md"), "utf8");
    expect(squadInstruction).toContain(join(ws, "businesses", "business-a", "outputs", "_SUMMARY.md"));
    expect(squadInstruction).toContain(join(ws, "businesses", "business-b", "outputs", "_SUMMARY.md"));
    expect(capture(setup, "deliverables/final-output/outputs/").brief).toContain(join(ws, "squads", "squad-c", "outputs", "_SUMMARY.md"));
    expect(capture(setup, "businesses/business-b/outputs/").env.NIRVANA_BUSINESS_GAUNTLET_ALLOWLIST).toBe("business-b");
    expect(capture(setup, "businesses/business-a/outputs/").argv).not.toContain("--execution-mode=gauntlet");

    expect(snapshot.nodes.map((node) => [node.nodeId, node.state, node.reportedCostUsd])).toEqual([
      ["brief-main", "delivered", 0], ["business-a", "delivered", 0.25], ["business-b", "delivered", 0.25],
      ["squad-c", "delivered", 0.25], ["final-output", "delivered", 0.25],
    ]);
    expect(snapshot.reportedCostUsd).toBe(1);
    const events = listEvents(kernel, setup.projectId);
    expect(events.some((event) => event.type === "multi_target.lease_lost")).toBeFalse();
    expect(events.filter((event) => event.type === "multi_target.lease_released").map((event) => (event.payload as { nodeId: string }).nodeId).sort())
      .toEqual(["business-a", "business-b", "final-output", "squad-c"]);
    kernel.close();
  }, spawnBudgetMs(4));
});

describe("multi-target dispatch adapters with agent nodes", () => {
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

  function compileAgentPlan() {
    const compiled = compileMultiTargetGauntletPolicy(agentGraph, {
      scope: "each-target-and-final", intensity: "light", synthesisNodeId: "final-output", limits: { maxCostUsd: 10 },
      targets: { "squad-research": { mode: "standard" }, "role-copywriter": { limits: { maxCostUsd: 2 } }, "squad-design": { mode: "standard" } },
    });
    expect(compiled.issues).toEqual([]);
    return compiled.plan!;
  }

  function agentAdapters(setup: Fixture, plan: CompiledMultiTargetPlan, env: Record<string, string> = {}, briefs: Record<string, string> = {}) {
    return createDispatchMultiTargetAdapters({
      projectRoot: setup.projectRoot, projectId: setup.projectId, plan,
      nodeBriefs: { "squad-research": "Research the market.", "role-copywriter": "Write the launch copy from the research.", "squad-design": "Design around the copy.", "final-output": "Assemble the kit.", ...briefs },
      dispatchScriptPath: setup.dispatchScriptPath, env: { FAKE_DISPATCH_SPAWN_LOG: setup.spawnLog, HARNESS_LOGS_DIR: join(setup.root, "logs"), ...env },
      budgetUsd: { "role-copywriter": 1.5 },
    });
  }

  test("an agent node runs as --agent-x under agents/<id>/ with the role in its instruction, and its cost is told apart from the synthesis", async () => {
    const setup = fixture();
    const plan = compileAgentPlan();
    const ports = agentAdapters(setup, plan, { FAKE_DISPATCH_COST_USD: "0.4" });
    const role = await ports.gauntlet.run(nodeInput(plan, "role-copywriter", { grantedCostUsd: 2, upstreamPaths: ["squads/squad-research/outputs/"] }));
    expect(role).toEqual({ state: "delivered", reportedCostUsd: 0.4, costObserved: true, outputPaths: ["agents/role-copywriter/outputs/"] });
    const captured = capture(setup, "agents/role-copywriter/outputs/");
    expect(captured.positional).toEqual([]);
    expect(captured.argv).toContain("--agent-x");
    expect(captured.argv).not.toContain("--squad");
    expect(captured.argv).not.toContain("--business");
    expect(captured.argv).not.toContain("--auto");
    expect(captured.argv).toContain("--execution-mode=gauntlet");
    expect(captured.argv).toContain("--gauntlet-intensity=light");
    // The smaller of the reservation grant (2) and budgetUsd (1.5).
    expect(flag(captured, "--max-budget")).toBe("1.5");
    expect(flag(captured, "--outputs-root")).toBe(join(setup.workspaceRoot, "agents", "role-copywriter", "outputs"));
    expect(captured.env.NIRVANA_MULTI_TARGET_NODE_ID).toBe("role-copywriter");
    expect(captured.brief).toStartWith("Write the launch copy from the research.");
    expect(captured.brief).not.toContain("Upstream summaries to synthesize");
    const text = readFileSync(join(setup.workspaceRoot, "agents", "role-copywriter", "DISPATCH-INSTRUCTION.md"), "utf8");
    expect(text).toContain("target: agent/role-copywriter");
    expect(text).toContain("You are **agent-x**, the runtime's generalist, acting in the role **role-copywriter**");
    expect(text).toContain(join(setup.workspaceRoot, "squads", "squad-research", "outputs", "_SUMMARY.md"));
    expect(text).toContain("**squad-design** (`squad/squad-design`)");
    expect(text).toContain("gauntlet (intensity light)");
    expect(text.slice(text.indexOf("## 6. Scope isolation"))).toContain(SCOPE_GUARD_EN);
    const marker = JSON.parse(readFileSync(join(setup.workspaceRoot, "agents", "role-copywriter", MULTI_TARGET_RESULT_MARKER), "utf8"));
    expect(marker).toMatchObject({ idempotencyKey: `multi-target:${plan.digest}:role-copywriter`, state: "delivered", reportedCostUsd: 0.4, costObserved: true });

    // The synthesis is agent-x too, under the same trace: it reports its own 0.1, not 0.5.
    const synthesis = await ports.gauntlet.run(nodeInput(plan, "final-output", { grantedCostUsd: 1, upstreamPaths: ["squads/squad-design/outputs/"], idempotencyKey: "synthesis" }));
    expect(synthesis).toMatchObject({ state: "delivered", reportedCostUsd: 0.4, costObserved: true });
    const synthesisCapture = capture(setup, "deliverables/final-output/outputs/");
    expect(synthesisCapture.argv).toContain("--agent-x");
    expect(synthesisCapture.env.NIRVANA_MULTI_TARGET_NODE_ID).toBe("final-output");
    expect(synthesisCapture.brief).toContain("Upstream summaries to synthesize");
    expect(readFileSync(join(setup.workspaceRoot, "deliverables", "final-output", "DISPATCH-INSTRUCTION.md"), "utf8")).not.toContain("acting in the role");
    // Read again with the role's key: still its own 0.4, although two agent-x events now share the trace.
    expect(await ports.gauntlet.run(nodeInput(plan, "role-copywriter", { grantedCostUsd: 2, idempotencyKey: "role-again" }))).toMatchObject({ reportedCostUsd: 0.8, costObserved: true });
    expect(spawnCount(setup)).toBe(3);
  }, spawnBudgetMs(3));

  test("an agent node without a sub-brief fails before any spawn", async () => {
    const setup = fixture();
    const plan = compileAgentPlan();
    const ports = agentAdapters(setup, plan, {}, { "role-copywriter": "" });
    expect(await ports.standard.run(nodeInput(plan, "role-copywriter"))).toEqual({ state: "failed", reportedCostUsd: 0, reason: "no sub-brief for node role-copywriter" });
    expect(spawnCount(setup)).toBe(0);
    expect(existsSync(join(setup.workspaceRoot, "agents", "role-copywriter"))).toBeFalse();
  }, spawnBudgetMs(0));

  test("costMatcher with a node id only matches the agent-x events stamped with it; without one, every agent-x event", () => {
    const events = [
      { employee: "agent-x", node_id: "role-copywriter", cost_usd: 1 },
      { employee: "agent-x", node_id: "final-output", cost_usd: 2 },
      { employee: "agent-x", cost_usd: 4 },
      { squad_slug: "squad-design", employee: "squad:squad-design", cost_usd: 8 },
    ];
    const sum = (matches: (event: Record<string, unknown>) => boolean) => events.filter(matches).reduce((total, event) => total + event.cost_usd, 0);
    expect(sum(costMatcher({ kind: "agent-x", id: "role-copywriter", nodeId: "role-copywriter" }))).toBe(1);
    expect(sum(costMatcher({ kind: "synthesis", id: "final-output", nodeId: "final-output" }))).toBe(2);
    expect(sum(costMatcher({ kind: "agent-x", id: "agent-x" }))).toBe(7);
    expect(sum(costMatcher({ kind: "squad", id: "squad-design", nodeId: "squad-design" }))).toBe(8);
  });
});
