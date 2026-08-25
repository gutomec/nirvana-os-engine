import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { DependencyGraph } from "../../_shared/lib/dependency-graph.ts";
import { reserveAggregateGauntletBudget } from "../lib/gauntlet/aggregate-budget.ts";
import { coordinateMultiTargetPlan, type MultiTargetAdapterInput } from "../lib/gauntlet/multi-target-coordinator.ts";
import { createDispatchMultiTargetAdapters, MULTI_TARGET_RESULT_MARKER } from "../lib/gauntlet/multi-target-dispatch-adapters.ts";
import { createRunKernelMultiTargetPorts } from "../lib/gauntlet/run-kernel-multi-target-ports.ts";
import { compileMultiTargetGauntletPolicy, type CompiledMultiTargetPlan } from "../lib/plan-compiler.ts";
import { createRun, listEvents, openKernel } from "../lib/run-kernel/store.ts";

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

function compile() {
  const compiled = compileMultiTargetGauntletPolicy(graph, {
    scope: "each-target-and-final", intensity: "light", synthesisNodeId: "final-output", limits: { maxCostUsd: 10 },
    targets: { "business-a": { mode: "standard" }, "business-b": { limits: { maxCostUsd: 2 } }, "squad-c": { mode: "standard" } },
  });
  expect(compiled.issues).toEqual([]);
  return { plan: compiled.plan!, reservation: reserveAggregateGauntletBudget(compiled.plan!).reservation! };
}

// The fake dispatch stands in for scripts/dispatch.ts: it records argv, the
// Nirvana env keys, cwd and the brief it received into the outputs root,
// appends one agent_executed cost event exactly where the legacy paths write
// it, produces _SUMMARY.md and exits with the configured code.
const FAKE_DISPATCH = `
import * as fs from "node:fs";
import * as path from "node:path";
const argv = Bun.argv.slice(2);
const VALUE_FLAGS = new Set(["--brief-file", "--project", "--outputs-root", "--runtime", "--max-budget"]);
const value = (name) => {
  const index = argv.findIndex((item) => item === name || item.startsWith(name + "="));
  if (index < 0) return undefined;
  return argv[index].includes("=") ? argv[index].slice(name.length + 1) : argv[index + 1];
};
const positional = argv.filter((item, index) => !item.startsWith("--") && !(index > 0 && VALUE_FLAGS.has(argv[index - 1])));
const outputsRoot = value("--outputs-root");
const brief = fs.readFileSync(value("--brief-file"), "utf8");
fs.mkdirSync(outputsRoot, { recursive: true });
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(NIRVANA_|HARNESS_|FAKE_)/.test(key)));
fs.writeFileSync(path.join(outputsRoot, "dispatch-capture.json"), JSON.stringify({ argv, positional, env, cwd: process.cwd(), brief }));
if (process.env.FAKE_DISPATCH_SPAWN_LOG) fs.appendFileSync(process.env.FAKE_DISPATCH_SPAWN_LOG, outputsRoot + "\\n");
const sleepMs = Number(process.env.FAKE_DISPATCH_SLEEP_MS ?? 0);
if (sleepMs > 0) await Bun.sleep(sleepMs);
const cost = Number(process.env.FAKE_DISPATCH_COST_USD ?? 0);
if (cost > 0) {
  const squad = brief.match(/^use squad ([a-z0-9-]+):/);
  const target = positional[0] ? { business_slug: positional[0], employee: "intake" }
    : squad ? { squad_slug: squad[1], employee: "squad:" + squad[1] } : { employee: "agent-x" };
  const logsDir = process.env.HARNESS_LOGS_DIR ?? path.join(process.cwd(), ".nirvana", "logs", "harness");
  const day = path.join(logsDir, new Date().toISOString().slice(0, 10));
  fs.mkdirSync(day, { recursive: true });
  const project = value("--project");
  fs.appendFileSync(path.join(day, "audit.jsonl"), JSON.stringify({ ts: new Date().toISOString(), event: "agent_executed",
    trace_id: project, project_id: project, ...target, cost_usd: cost }) + "\\n");
}
fs.writeFileSync(path.join(outputsRoot, "_SUMMARY.md"), "# Summary\\n\\n" + positional.join(" ") + "\\n");
const code = Number(process.env.FAKE_DISPATCH_EXIT_CODE ?? 0);
if (code !== 0) console.error("fake dispatch stopped with exit " + code);
process.exit(code);
`;

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "nirvana-multi-target-adapters-")));
  roots.push(root);
  const projectRoot = join(root, "project");
  const projectId = "trace-multi";
  const workspaceRoot = join(projectRoot, ".nirvana", "outputs", projectId);
  mkdirSync(workspaceRoot, { recursive: true });
  writeFileSync(join(workspaceRoot, "brief-enriched.md"), "# Brief\n", "utf8");
  const dispatchScriptPath = join(root, "fake-dispatch.ts");
  writeFileSync(dispatchScriptPath, FAKE_DISPATCH, "utf8");
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
    env: { FAKE_DISPATCH_SPAWN_LOG: setup.spawnLog, ...env },
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
  test("standard business selects the slug explicitly with exec, project and an absolute outputs root", async () => {
    const setup = fixture();
    const { plan } = compile();
    const result = await adapters(setup, plan, { FAKE_DISPATCH_COST_USD: "0.4" }, { runtime: "codex" }).standard.run(nodeInput(plan, "business-a"));
    expect(result).toEqual({ state: "delivered", reportedCostUsd: 0.4, outputPaths: ["businesses/business-a/outputs/"] });
    const captured = capture(setup, "businesses/business-a/outputs/");
    expect(captured.positional).toEqual(["business-a"]);
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
  });

  test("gauntlet business light adds the Gauntlet flags and allowlists the slug; balanced is refused without a spawn", async () => {
    const setup = fixture();
    const { plan } = compile();
    const ports = adapters(setup, plan, { NIRVANA_BUSINESS_GAUNTLET_ALLOWLIST: "other-business" });
    const result = await ports.gauntlet.run(nodeInput(plan, "business-b", { grantedCostUsd: 2 }));
    expect(result.state).toBe("delivered");
    const captured = capture(setup, "businesses/business-b/outputs/");
    expect(captured.positional).toEqual(["business-b"]);
    expect(captured.argv).toContain("--execution-mode=gauntlet");
    expect(captured.argv).toContain("--gauntlet-intensity=light");
    expect(flag(captured, "--max-budget")).toBe("2");
    expect(captured.env.NIRVANA_BUSINESS_GAUNTLET_ALLOWLIST.split(",")).toEqual(["other-business", "business-b"]);
    expect(spawnCount(setup)).toBe(1);

    const refused = await ports.gauntlet.run(nodeInput(plan, "business-b", { intensity: "balanced", idempotencyKey: "other-key" }));
    expect(refused.state).toBe("failed");
    expect(refused.reason).toContain("balanced");
    expect(spawnCount(setup)).toBe(1);
  });

  test("squad and synthesis go through --auto with explicit 'use squad' and 'use agent-x' selectors", async () => {
    const setup = fixture();
    const { plan } = compile();
    const ports = adapters(setup, plan, { FAKE_DISPATCH_COST_USD: "0.1" });
    const squad = await ports.standard.run(nodeInput(plan, "squad-c", {
      upstreamPaths: ["briefs/brief-main/outputs/", "businesses/business-a/outputs/", "businesses/business-b/outputs/"],
    }));
    expect(squad).toMatchObject({ state: "delivered", reportedCostUsd: 0.1 });
    const squadCapture = capture(setup, "squads/squad-c/outputs/");
    expect(squadCapture.positional).toEqual([]);
    expect(squadCapture.argv).toContain("--auto");
    expect(squadCapture.brief).toStartWith("use squad squad-c: Assemble C from A and B.");

    const synthesis = await ports.gauntlet.run(nodeInput(plan, "final-output", { grantedCostUsd: 1, upstreamPaths: ["squads/squad-c/outputs/"] }));
    expect(synthesis).toMatchObject({ state: "delivered", reportedCostUsd: 0.1 });
    const synthesisCapture = capture(setup, "deliverables/final-output/outputs/");
    expect(synthesisCapture.positional).toEqual([]);
    expect(synthesisCapture.argv).toContain("--auto");
    expect(synthesisCapture.argv).toContain("--execution-mode=gauntlet");
    expect(synthesisCapture.brief).toStartWith("use agent-x");
    expect(synthesisCapture.brief).toContain(join(setup.workspaceRoot, "squads", "squad-c", "outputs", "_SUMMARY.md"));
  });

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
  });

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
    expect(existsSync(join(setup.workspaceRoot, "squads", "squad-c", "outputs"))).toBeTrue();
  });

  test("the result marker prevents a second spawn for the same key while a different key runs again", async () => {
    const setup = fixture();
    const { plan } = compile();
    const ports = adapters(setup, plan, { FAKE_DISPATCH_COST_USD: "0.3" });
    const first = await ports.standard.run(nodeInput(plan, "business-a"));
    expect(spawnCount(setup)).toBe(1);
    const marker = JSON.parse(readFileSync(join(setup.workspaceRoot, "businesses", "business-a", MULTI_TARGET_RESULT_MARKER), "utf8"));
    expect(marker).toMatchObject({ idempotencyKey: `multi-target:${plan.digest}:business-a`, state: "delivered", exitCode: 0, reportedCostUsd: 0.3 });
    expect(typeof marker.finishedAt).toBe("string");

    const resumed = await ports.standard.run(nodeInput(plan, "business-a", { resume: true }));
    expect(resumed).toEqual(first);
    expect(spawnCount(setup)).toBe(1);

    const other = await ports.standard.run(nodeInput(plan, "business-a", { idempotencyKey: "another-plan" }));
    expect(spawnCount(setup)).toBe(2);
    expect(other).toMatchObject({ state: "delivered", reportedCostUsd: 0.6 });
  });

  test("an aborted signal kills the subprocess and returns failed without a marker", async () => {
    const setup = fixture();
    const { plan } = compile();
    const ports = adapters(setup, plan, { FAKE_DISPATCH_SLEEP_MS: "20000" });
    const controller = new AbortController();
    const pending = ports.standard.run(nodeInput(plan, "business-a", { signal: controller.signal }));
    const captureFile = join(setup.workspaceRoot, "businesses", "business-a", "outputs", "dispatch-capture.json");
    const deadline = Date.now() + 10_000;
    while (!existsSync(captureFile) && Date.now() < deadline) await Bun.sleep(20);
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
  });

  test("coordinator, kernel ports and adapters run the waves through the fake dispatch and resume without re-spawning", async () => {
    const setup = fixture();
    const { plan, reservation } = compile();
    const ws = setup.workspaceRoot;
    const kernel = openKernel(join(setup.root, "kernel.sqlite"));
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
  });
});
