// multi-target-cli.test.ts — `nrv multi-target plan|run|status` end to end,
// hermetic: a temporary project, the fake dispatch injected through
// NIRVANA_DISPATCH_SCRIPT, a real SQLite Run Kernel, no LLM and no network.
// Runs with: bun test skills/harness/tests
import { parseAuditLine } from "../../_shared/lib/cloudevents.js";
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { projectMultiTargetRun } from "../lib/gauntlet/multi-target-projection.ts";
import { getRun, listEvents, openKernel } from "../lib/run-kernel/store.ts";
import type { MultiTargetCoordinatorSnapshot as MultiTargetSnapshotLike } from "../lib/gauntlet/multi-target-coordinator.ts";
import { multiTargetRunId, validatePlanFile } from "../scripts/multi-target.ts";
import { writeFakeDispatch } from "./helpers/fake-dispatch.ts";
import { removeDir } from "./helpers/temp-dirs.ts";
import { spawnBudgetMs } from "./helpers/test-budgets.ts";

const REPO = path.resolve(import.meta.dir, "..", "..", "..");
const SCRIPT = path.join(REPO, "skills", "harness", "scripts", "multi-target.ts");

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) removeDir(root); });

const PLAN = {
  schemaVersion: "nirvana.multi-target-plan/v1alpha1",
  brief: "# Brief\n\nBuild the thing.\n",
  briefs: {
    "business-a": "Deliver part A.", "business-b": "Deliver part B.",
    "squad-c": "Assemble C from A and B.", "final-output": "Write the final report.",
  },
  graph: {
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
  },
  policy: {
    scope: "each-target-and-final", intensity: "light", synthesisNodeId: "final-output", limits: { maxCostUsd: 10 },
    targets: { "business-a": { mode: "standard" }, "business-b": { limits: { maxCostUsd: 2 } }, "squad-c": { mode: "standard" } },
  },
};

// A role no squad covers between two squads: squad → agent → squad → deliverable.
const AGENT_PLAN = {
  schemaVersion: "nirvana.multi-target-plan/v1alpha1",
  brief: "# Brief\n\nLaunch the thing; the copy has no squad.\n",
  briefs: {
    "squad-research": "Research the market.",
    "role-copywriter": "Write the launch copy from the research.",
    "squad-design": "Design the landing page around the copy.",
    "final-output": "Assemble the launch kit.",
  },
  graph: {
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
  },
  policy: {
    scope: "each-target-and-final", intensity: "light", synthesisNodeId: "final-output", limits: { maxCostUsd: 10 },
    targets: { "squad-research": { mode: "standard" }, "role-copywriter": { limits: { maxCostUsd: 2 } }, "squad-design": { mode: "standard" } },
  },
  budgetUsd: { "role-copywriter": 1.5 },
};

function fixture(projectId = "proj-multi") {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nrv-multi-target-cli-")));
  roots.push(root);
  const projectRoot = path.join(root, "project");
  fs.mkdirSync(path.join(projectRoot, ".nirvana", "plans"), { recursive: true });
  const planFile = path.join(projectRoot, ".nirvana", "plans", `${projectId}.json`);
  fs.writeFileSync(planFile, JSON.stringify(PLAN, null, 2));
  return {
    root, projectRoot, projectId, planFile,
    fake: writeFakeDispatch(root),
    spawnLog: path.join(root, "spawns.log"),
    kernel: path.join(projectRoot, ".nirvana", "run-kernel.sqlite"),
    workspace: path.join(projectRoot, ".nirvana", "outputs", projectId),
  };
}
type Fixture = ReturnType<typeof fixture>;

// The subprocess environment: nothing from a sibling test file leaks in (several
// set HARNESS_LOGS_DIR at module scope), the state db and the dispatch are ours.
function env(setup: Fixture, extra: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (/^(HARNESS_LOGS_DIR|NIRVANA_MULTI_TARGET_|NIRVANA_PROJECT_ROOT|NIRVANA_STATE_DB|NIRVANA_DISPATCH_SCRIPT|NIRVANA_BUSINESS_GAUNTLET|FAKE_DISPATCH_|NIRVANA_PROVIDER_CATALOG_DIR|NIRVANA_ALLOW_STALE_CATALOG)/.test(key)) continue;
    out[key] = value;
  }
  return {
    ...out,
    NIRVANA_SKILLS_DIR: path.join(REPO, "skills"), NIRVANA_NO_UPDATE_CHECK: "1", NIRVANA_SCOPE_QUIET: "1",
    NIRVANA_STATE_DB: path.join(setup.root, "state.db"),
    NIRVANA_DISPATCH_SCRIPT: setup.fake, FAKE_DISPATCH_SPAWN_LOG: setup.spawnLog,
    ...extra,
  };
}

function nrv(setup: Fixture, args: string[], extra: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: setup.projectRoot, encoding: "utf8", env: env(setup, extra) });
  return { status: r.status, signal: r.signal, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** Node ids in spawn order, from the outputs roots the fake logged. */
function spawns(setup: Fixture): string[] {
  try {
    return fs.readFileSync(setup.spawnLog, "utf8").split("\n").filter(Boolean).map((line) => path.basename(path.dirname(line)));
  } catch { return []; }
}

function auditEvents(setup: Fixture): Array<Record<string, any>> {
  const dir = path.join(setup.projectRoot, ".nirvana", "logs", "harness");
  const out: Array<Record<string, any>> = [];
  if (!fs.existsSync(dir)) return out;
  for (const day of fs.readdirSync(dir).sort()) {
    const file = path.join(dir, day, "audit.jsonl");
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, "utf8").split("\n")) if (line.trim()) out.push(parseAuditLine(line));
  }
  return out;
}

function withKernel<T>(setup: Fixture, fn: (kernel: ReturnType<typeof openKernel>) => T): T {
  const kernel = openKernel(setup.kernel);
  try { return fn(kernel); } finally { kernel.close(); }
}

describe("nrv multi-target plan", () => {
  test("an invalid plan file exits 4 and lists every problem as path: message", () => {
    const setup = fixture();
    const broken = { ...PLAN, schemaVersion: "nope", graph: { ...PLAN.graph, nodes: [...PLAN.graph.nodes, { id: "emp-1", type: "employee" }] } };
    fs.writeFileSync(setup.planFile, JSON.stringify(broken));
    const r = nrv(setup, ["plan", setup.planFile]);
    expect(r.status).toBe(4);
    expect(r.stderr).toContain("Plano inválido (2 problemas)");
    expect(r.stderr).toContain("/schemaVersion:");
    expect(r.stderr).toContain("/graph/nodes/5/type:");
    expect(fs.existsSync(setup.workspace)).toBeFalse();

    const missing = validatePlanFile({ ...PLAN, briefs: { "business-a": "A", ghost: "x" } });
    expect(missing.plan).toBeNull();
    expect(missing.issues.map((issue) => issue.path).sort()).toEqual(["/briefs/business-b", "/briefs/ghost", "/briefs/squad-c"]);

    const cycle = { ...PLAN, graph: { ...PLAN.graph, edges: [...PLAN.graph.edges, { id: "loop", source: "business-a", target: "squad-c", type: "depends_on" }] } };
    fs.writeFileSync(setup.planFile, JSON.stringify(cycle));
    expect(nrv(setup, ["plan", setup.planFile])).toMatchObject({ status: 4, stderr: expect.stringContaining("/edges: graph contains a dependency cycle") });

    const rejected = { ...PLAN, policy: { ...PLAN.policy, limits: { maxCostUsd: 1 } } };
    fs.writeFileSync(setup.planFile, JSON.stringify(rejected));
    const r2 = nrv(setup, ["plan", setup.planFile]);
    expect(r2.status).toBe(4);
    expect(r2.stderr).toContain("/policy/limits/maxCostUsd: reservation rejected");
  }, spawnBudgetMs(3));

  test("compiles the manifest, policy and reservation, writes the workspace and executes nothing", () => {
    const setup = fixture();
    const r = nrv(setup, ["plan", setup.planFile]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`Plano multi-target: ${setup.projectId}`);
    expect(r.stdout).toContain("1: business-a, business-b");
    expect(r.stdout).toContain("2: squad-c");
    expect(r.stdout).toContain("3: final-output");
    expect(r.stdout).toContain("gauntlet light");
    expect(r.stdout).toContain("reduced_to_aggregate_cap");
    expect(r.stdout).toContain("Nada foi executado");

    const manifest = JSON.parse(fs.readFileSync(path.join(setup.workspace, "manifest.json"), "utf8"));
    expect(manifest.parallel_waves.map((wave: string[]) => [...wave].sort())).toEqual([["brief-main"], ["business-a", "business-b"], ["squad-c"], ["final-output"]]);
    expect(manifest.phases.find((phase: { id: string }) => phase.id === "squad-c").depends_on).toEqual(["business-a", "business-b"]);
    expect(fs.readFileSync(path.join(setup.workspace, "brief-enriched.md"), "utf8")).toBe(PLAN.brief);
    expect(fs.existsSync(setup.kernel)).toBeFalse();
    expect(spawns(setup)).toEqual([]);

    const compiled = auditEvents(setup).filter((event) => event.event === "x_multi_target_plan_compiled");
    expect(compiled).toHaveLength(1);
    expect(compiled[0]).toMatchObject({ trace_id: setup.projectId, project_id: setup.projectId, node_count: 5 });
    expect(compiled[0].waves).toEqual([["brief-main"], ["business-a", "business-b"], ["squad-c"], ["final-output"]]);
  }, spawnBudgetMs(1));

  test("--project overrides the plan's id; without it the file name is the trace id", () => {
    const setup = fixture();
    expect(nrv(setup, ["plan", setup.planFile, "--project", "proj-other"]).stdout).toContain("Plano multi-target: proj-other");
    expect(fs.existsSync(path.join(setup.projectRoot, ".nirvana", "outputs", "proj-other", "manifest.json"))).toBeTrue();
    fs.writeFileSync(setup.planFile, JSON.stringify({ ...PLAN, projectId: "proj-declared" }));
    expect(nrv(setup, ["plan", setup.planFile]).stdout).toContain("Plano multi-target: proj-declared");
  }, spawnBudgetMs(2));
});

describe("nrv multi-target run", () => {
  test("is on by default: the kill switch and NIRVANA_MULTI_TARGET_ENGINE=0 refuse with exit 4, name the variable, audit it and touch nothing", () => {
    // The kill switch wins over the legacy opt-in flag; the flag only counts when it says off.
    const off: Array<Record<string, string>> = [
      { NIRVANA_MULTI_TARGET_KILL_SWITCH: "1" },
      { NIRVANA_MULTI_TARGET_KILL_SWITCH: "on", NIRVANA_MULTI_TARGET_ENGINE: "1" },
      { NIRVANA_MULTI_TARGET_ENGINE: "0" },
      { NIRVANA_MULTI_TARGET_ENGINE: "false" },
    ];
    for (const variables of off) {
      const setup = fixture();
      const [variable, value] = Object.entries(variables)[0];
      const r = nrv(setup, ["run", setup.planFile], variables);
      expect(r.status).toBe(4);
      expect(r.stderr).toContain(`${variable}=${value}`);
      expect(auditEvents(setup).filter((event) => event.event === "x_multi_target_disabled"))
        .toMatchObject([{ trace_id: setup.projectId, variable, value, exit: 4 }]);
      expect(spawns(setup)).toEqual([]);
      expect(fs.existsSync(setup.kernel)).toBeFalse();
      expect(fs.existsSync(setup.workspace)).toBeFalse();
    }
  }, spawnBudgetMs(4));

  test("NIRVANA_MULTI_TARGET_ENGINE=1, the opt-in of the first releases, is accepted and changes nothing", () => {
    const setup = fixture();
    const r = nrv(setup, ["run", setup.planFile], { NIRVANA_MULTI_TARGET_ENGINE: "1", NIRVANA_MULTI_TARGET_KILL_SWITCH: "0" });
    expect(r.status).toBe(0);
    expect(spawns(setup)).toHaveLength(4);
    expect(auditEvents(setup).some((event) => event.event === "x_multi_target_disabled")).toBeFalse();
  }, spawnBudgetMs(5));

  test("executes the waves without any variable, through the dispatch adapters, completes the Run, audits every node and is idempotent", () => {
    const setup = fixture();
    const runId = multiTargetRunId(setup.projectId);
    const r = nrv(setup, ["run", setup.planFile, "--owner", "worker-test", "--runtime", "codex"], { FAKE_DISPATCH_COST_USD: "0.25" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`▶ Run ${runId} criado (owner worker-test)`);
    expect(r.stdout).toContain("✓ Plano multi-target entregue.");

    const spawned = spawns(setup);
    expect(spawned.slice(0, 2).sort()).toEqual(["business-a", "business-b"]);
    expect(spawned.slice(2)).toEqual(["squad-c", "final-output"]);
    for (const [kind, id] of [["businesses", "business-a"], ["businesses", "business-b"], ["squads", "squad-c"], ["deliverables", "final-output"]]) {
      expect(fs.existsSync(path.join(setup.workspace, kind, id, "outputs", "_SUMMARY.md"))).toBeTrue();
      expect(fs.existsSync(path.join(setup.workspace, kind, id, "DISPATCH-INSTRUCTION.md"))).toBeTrue();
    }
    const captureA = JSON.parse(fs.readFileSync(path.join(setup.workspace, "businesses", "business-a", "outputs", "dispatch-capture.json"), "utf8"));
    expect(captureA.argv.slice(0, 2)).toEqual(["--business", "business-a"]);
    expect(captureA.argv).not.toContain("--auto");
    expect(captureA.argv).toContain("--exec");
    expect(captureA.argv).toContain("codex");
    expect(captureA.cwd).toBe(setup.projectRoot);
    const captureFinal = JSON.parse(fs.readFileSync(path.join(setup.workspace, "deliverables", "final-output", "outputs", "dispatch-capture.json"), "utf8"));
    expect(captureFinal.argv).toContain("--agent-x");
    expect(captureFinal.argv).toContain("--execution-mode=gauntlet");

    const projection = withKernel(setup, (kernel) => {
      const run = getRun(kernel, setup.projectId, runId)!;
      expect(run.state).toBe("completed");
      expect(run.target).toEqual({ kind: "agent-x", slug: "agent-x" });
      expect(run.traceId).toBe(setup.projectId);
      expect(run.policySnapshotRef).toStartWith("snapshot_");
      const transitions = listEvents(kernel, setup.projectId).filter((event) => event.type === "run.transitioned").map((event) => (event.payload as { to: string }).to);
      expect(transitions).toEqual(["running", "verifying", "completed"]);
      // The coordinator freezes the runtime it hands every node, like the canaries do.
      const snapshot = listEvents(kernel, setup.projectId).find((event) => event.type === "runtime.selection_snapshot")!;
      expect(snapshot.runId).toBe(runId);
      expect((snapshot.payload as { ref: string }).ref).toStartWith("snapshot_");
      expect((snapshot.payload as { snapshot: { runtime: unknown } }).snapshot.runtime).toMatchObject({ id: "codex", source: "flag" });
      return projectMultiTargetRun(kernel, setup.projectId, runId)!;
    });
    expect(projection.state).toBe("delivered");
    expect(projection.nodes.map((node) => [node.nodeId, node.state, node.reportedCostUsd])).toEqual([
      ["brief-main", "delivered", 0], ["business-a", "delivered", 0.25], ["business-b", "delivered", 0.25],
      ["squad-c", "delivered", 0.25], ["final-output", "delivered", 0.25],
    ]);

    const events = auditEvents(setup);
    expect(events.filter((event) => event.event === "x_multi_target_plan_compiled")).toHaveLength(1);
    const started = events.filter((event) => event.event === "x_multi_target_run_started");
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ trace_id: setup.projectId, run_id: runId, owner: "worker-test", runtime: "codex", resumed: false });
    expect(events.filter((event) => event.event === "x_multi_target_node_terminal").map((event) => [event.node_id, event.state]).sort())
      .toEqual([["brief-main", "delivered"], ["business-a", "delivered"], ["business-b", "delivered"], ["final-output", "delivered"], ["squad-c", "delivered"]]);
    const terminal = events.filter((event) => event.event === "x_multi_target_terminal");
    expect(terminal).toHaveLength(1);
    expect(terminal[0]).toMatchObject({ trace_id: setup.projectId, run_id: runId, state: "delivered", kernel_state: "completed", cost_usd: 1, exit: 0 });
    // Each node's subprocess keeps writing its own legacy chain into the same log.
    expect(events.filter((event) => event.event === "agent_executed" && event.trace_id === setup.projectId)).toHaveLength(4);

    // Repeating the command: the Run is terminal, nothing spawns, --json is parseable.
    const again = nrv(setup, ["run", setup.planFile, "--json"]);
    expect(again.status).toBe(0);
    const parsed = JSON.parse(again.stdout);
    expect(parsed).toMatchObject({ projectId: setup.projectId, runId, exitCode: 0 });
    expect(parsed.run.state).toBe("completed");
    expect(parsed.projection).toEqual(projection);
    expect(spawns(setup)).toHaveLength(4);
    expect(auditEvents(setup).filter((event) => event.event === "x_multi_target_run_started")).toHaveLength(1);

    // status reflects the same projection, by plan file or by run id.
    const status = nrv(setup, ["status", setup.planFile, "--json"]);
    expect(status.status).toBe(0);
    const statusJson = JSON.parse(status.stdout);
    expect(statusJson.runId).toBe(runId);
    expect(statusJson.run.state).toBe("completed");
    expect(statusJson.projection).toEqual(projection);
    const human = nrv(setup, ["status", runId, "--project", setup.projectId]);
    expect(human.status).toBe(0);
    expect(human.stdout).toContain(`Run ${runId} (projeto ${setup.projectId}): completed`);
    expect(human.stdout).toContain("plano delivered");
    expect(human.stdout).toContain("squad-c");
    expect(spawns(setup)).toHaveLength(4);
  }, spawnBudgetMs(8));

  test("a node that exits 2 withholds the Run, blocks its consumers and the command exits 2", () => {
    const setup = fixture();
    const runId = multiTargetRunId(setup.projectId);
    const r = nrv(setup, ["run", setup.planFile], { FAKE_DISPATCH_EXIT_CODE_FOR: "business-a=2" });
    expect(r.status).toBe(2);
    expect(r.stdout).toContain("⚠ Plano multi-target RETIDO");
    expect(spawns(setup).sort()).toEqual(["business-a", "business-b"]);
    withKernel(setup, (kernel) => {
      expect(getRun(kernel, setup.projectId, runId)!.state).toBe("withheld");
      const projection = projectMultiTargetRun(kernel, setup.projectId, runId)!;
      expect(projection.state).toBe("withheld");
      expect(projection.nodes.map((node) => [node.nodeId, node.state])).toEqual([
        ["brief-main", "delivered"], ["business-a", "withheld"], ["business-b", "delivered"], ["squad-c", "skipped"], ["final-output", "skipped"],
      ]);
      expect(projection.nodes.find((node) => node.nodeId === "squad-c")!.blockedBy).toEqual(["business-a"]);
    });
    const terminal = auditEvents(setup).find((event) => event.event === "x_multi_target_terminal");
    expect(terminal).toMatchObject({ state: "withheld", kernel_state: "withheld", exit: 2 });
    expect(nrv(setup, ["run", setup.planFile]).status).toBe(2);
    expect(spawns(setup)).toHaveLength(2);
  }, spawnBudgetMs(4));

  test("a crash after the first execution wave resumes without re-spawning the completed nodes", () => {
    const setup = fixture();
    const runId = multiTargetRunId(setup.projectId);
    // The fake SIGKILLs the engine the moment squad-c (wave 2) starts: wave 1 is
    // already journaled as delivered and squad-c sits running under a live lease.
    const crashed = nrv(setup, ["run", setup.planFile, "--owner", "worker-crash"], { FAKE_DISPATCH_KILL_PARENT_FOR: "squad-c" });
    expect(crashed.status).not.toBe(0);
    expect(spawns(setup).sort()).toEqual(["business-a", "business-b", "squad-c"]);
    withKernel(setup, (kernel) => {
      expect(getRun(kernel, setup.projectId, runId)!.state).toBe("running");
      const projection = projectMultiTargetRun(kernel, setup.projectId, runId)!;
      expect(projection.state).toBe("running");
      expect(projection.nodes.map((node) => [node.nodeId, node.state])).toEqual([
        ["brief-main", "delivered"], ["business-a", "delivered"], ["business-b", "delivered"], ["squad-c", "running"], ["final-output", "pending"],
      ]);
    });

    // Same owner, inside the lease window: the running node resumes, the rest continues.
    const resumed = nrv(setup, ["run", setup.planFile, "--owner", "worker-crash"]);
    expect(resumed.status).toBe(0);
    expect(resumed.stdout).toContain(`▶ Retomando o Run ${runId} (estado running, owner worker-crash)`);
    const all = spawns(setup);
    expect(all.filter((node) => node === "business-a")).toHaveLength(1);
    expect(all.filter((node) => node === "business-b")).toHaveLength(1);
    expect(all.filter((node) => node === "squad-c")).toHaveLength(2);
    expect(all.filter((node) => node === "final-output")).toHaveLength(1);
    withKernel(setup, (kernel) => {
      expect(getRun(kernel, setup.projectId, runId)!.state).toBe("completed");
      expect(projectMultiTargetRun(kernel, setup.projectId, runId)!.nodes.every((node) => node.state === "delivered")).toBeTrue();
    });
    const started = auditEvents(setup).filter((event) => event.event === "x_multi_target_run_started");
    expect(started.map((event) => event.resumed)).toEqual([false, true]);
  }, spawnBudgetMs(7));

  test("a Run that exists for a different plan is refused with exit 4", () => {
    const setup = fixture();
    expect(nrv(setup, ["run", setup.planFile]).status).toBe(0);
    fs.writeFileSync(setup.planFile, JSON.stringify({ ...PLAN, policy: undefined }));
    const r = nrv(setup, ["run", setup.planFile]);
    expect(r.status).toBe(4);
    expect(r.stderr).toContain("já existe com outro plano");
    expect(spawns(setup)).toHaveLength(4);
  }, spawnBudgetMs(6));
});

describe("nrv multi-target run --retry-failed", () => {
  test("reopens a failed plan in a chained Run: wave 1 is not respawned, waves 2 and 3 execute, the Run completes", () => {
    const setup = fixture();
    const first = multiTargetRunId(setup.projectId);
    const second = multiTargetRunId(setup.projectId, 2);
    expect(second).toBe(`${first}_r2`);
    const failed = nrv(setup, ["run", setup.planFile], { FAKE_DISPATCH_COST_USD: "0.25", FAKE_DISPATCH_EXIT_CODE_FOR: "squad-c=1" });
    expect(failed.status).toBe(1);
    expect(failed.stdout).toContain(`nrv multi-target run ${setup.planFile} --retry-failed`);
    expect(spawns(setup).sort()).toEqual(["business-a", "business-b", "squad-c"]);
    const before = withKernel(setup, (kernel) => {
      expect(getRun(kernel, setup.projectId, first)!.state).toBe("failed");
      return projectMultiTargetRun(kernel, setup.projectId, first)!;
    });
    expect(before.nodes.map((node) => [node.nodeId, node.state])).toEqual([
      ["brief-main", "delivered"], ["business-a", "delivered"], ["business-b", "delivered"], ["squad-c", "failed"], ["final-output", "skipped"],
    ]);

    // Repeating the command: the terminal Run answers as before, executing nothing, and points at --retry-failed.
    const repeat = nrv(setup, ["run", setup.planFile]);
    expect(repeat.status).toBe(1);
    expect(repeat.stdout).toContain(`Run ${first} já é terminal (failed)`);
    expect(repeat.stdout).toContain("--retry-failed");
    expect(spawns(setup)).toHaveLength(3);

    // Cause fixed (the fake no longer fails squad-c): only the reset nodes run, wave 1 keeps its outputs and markers.
    const retried = nrv(setup, ["run", setup.planFile, "--retry-failed", "--owner", "worker-retry"], { FAKE_DISPATCH_COST_USD: "0.25" });
    expect(retried.status).toBe(0);
    expect(retried.stdout).toContain(`▶ Run ${second} criado a partir de ${first} (owner worker-retry); voltam a pending: final-output, squad-c`);
    expect(retried.stdout).toContain("✓ Plano multi-target entregue.");
    expect(retried.stdout).toContain(`Run:        ${second} (completed) · reaberto de ${first}`);
    const all = spawns(setup);
    expect(all).toHaveLength(5);
    expect(all.filter((node) => node === "business-a")).toHaveLength(1);
    expect(all.filter((node) => node === "business-b")).toHaveLength(1);
    expect(all.slice(3)).toEqual(["squad-c", "final-output"]);
    const marker = (kind: string, id: string) => JSON.parse(fs.readFileSync(path.join(setup.workspace, kind, id, ".multi-target-result.json"), "utf8"));
    expect(marker("businesses", "business-a")).toMatchObject({ idempotencyKey: `multi-target:${before.planDigest}:business-a`, state: "delivered", reportedCostUsd: 0.25 });
    expect(marker("squads", "squad-c")).toMatchObject({ idempotencyKey: `multi-target:${before.planDigest}:squad-c:attempt-2`, state: "delivered", exitCode: 0 });
    expect(fs.existsSync(path.join(setup.workspace, "businesses", "business-a", "outputs", "_SUMMARY.md"))).toBeTrue();

    withKernel(setup, (kernel) => {
      expect(getRun(kernel, setup.projectId, first)!.state).toBe("failed");
      expect(getRun(kernel, setup.projectId, second)).toMatchObject({ state: "completed", parentRunId: first, traceId: setup.projectId });
      const events = listEvents(kernel, setup.projectId).filter((event) => event.runId === second);
      expect(events.find((event) => event.type === "multi_target.plan_retried")!.payload).toEqual({ previousRunId: first, resetNodes: ["final-output", "squad-c"] });
      const seed = events.find((event) => event.type === "multi_target.snapshot_saved")!;
      expect((seed.payload as { snapshot: MultiTargetSnapshotLike }).snapshot).toMatchObject({ version: before.version + 1, attempt: 2, state: "ready" });
      expect(events.some((event) => event.type === "runtime.selection_snapshot")).toBeTrue();
      const started = events.filter((event) => event.type === "multi_target.node_started").map((event) => (event.payload as { node: { nodeId: string } }).node.nodeId);
      expect(started).toEqual(["squad-c", "final-output"]);
      expect(events.filter((event) => event.type === "run.transitioned").map((event) => (event.payload as { to: string }).to)).toEqual(["running", "verifying", "completed"]);
      // The cost of a retried node is what the audit holds for it across attempts: the failed squad-c
      // had already spent 0.25 (the fake writes its event before exiting 1), so the node reports 0.5.
      const projection = projectMultiTargetRun(kernel, setup.projectId, second)!;
      expect(projection).toMatchObject({ state: "delivered", attempt: 2, reportedCostUsd: 1.25 });
      expect(projection.nodes.map((node) => [node.nodeId, node.state, node.reportedCostUsd])).toEqual([
        ["brief-main", "delivered", 0], ["business-a", "delivered", 0.25], ["business-b", "delivered", 0.25],
        ["squad-c", "delivered", 0.5], ["final-output", "delivered", 0.25],
      ]);
    });
    const audit = auditEvents(setup);
    expect(audit.find((event) => event.event === "x_multi_target_plan_retried")).toMatchObject({
      trace_id: setup.projectId, run_id: second, previous_run_id: first, reset_nodes: ["final-output", "squad-c"], attempt: 2, snapshot_version: before.version + 1,
    });
    expect(audit.filter((event) => event.event === "x_multi_target_run_started").map((event) => [event.run_id, event.resumed, event.retried_from]))
      .toEqual([[first, false, null], [second, false, first]]);

    // status by plan file follows the chain; the chain is terminal, so a plain run executes nothing and a retry is refused.
    const status = nrv(setup, ["status", setup.planFile]);
    expect(status.status).toBe(0);
    expect(status.stdout).toContain(`Run ${second} (projeto ${setup.projectId}): completed · reaberto de ${first}`);
    expect(status.stdout).toContain("tentativa 2");
    expect(nrv(setup, ["run", setup.planFile]).status).toBe(0);
    const done = nrv(setup, ["run", setup.planFile, "--retry-failed"]);
    expect(done.status).toBe(4);
    expect(done.stderr).toContain(`O Run ${second} está completed: só um Run failed ou withheld pode ser reaberto`);
    expect(spawns(setup)).toHaveLength(5);
  }, spawnBudgetMs(12));

  test("refuses with exit 4 when nothing ran, when the Run is not terminal and when the plan changed; a stalled node is reopened like a failed one", () => {
    const setup = fixture();
    const first = multiTargetRunId(setup.projectId);
    const never = nrv(setup, ["run", setup.planFile, "--retry-failed"]);
    expect(never.status).toBe(4);
    expect(never.stderr).toContain("nunca executou");
    expect(fs.existsSync(setup.kernel)).toBeTrue();

    // A crash in wave 2 leaves the Run running: not terminal, refused, nothing spawned; the plain run still resumes it.
    const crashed = nrv(setup, ["run", setup.planFile, "--owner", "worker-crash"], { FAKE_DISPATCH_KILL_PARENT_FOR: "squad-c" });
    expect(crashed.status).not.toBe(0);
    const running = nrv(setup, ["run", setup.planFile, "--retry-failed", "--owner", "worker-crash"]);
    expect(running.status).toBe(4);
    expect(running.stderr).toContain(`O Run ${first} não é terminal (running)`);
    expect(spawns(setup)).toHaveLength(3);

    // Another owner inside the lease window: squad-c stalls, the plan fails.
    const stalled = nrv(setup, ["run", setup.planFile, "--owner", "worker-other"]);
    expect(stalled.status).toBe(1);
    withKernel(setup, (kernel) => {
      expect(getRun(kernel, setup.projectId, first)!.state).toBe("failed");
      expect(projectMultiTargetRun(kernel, setup.projectId, first)!.nodes.map((node) => [node.nodeId, node.state])).toEqual([
        ["brief-main", "delivered"], ["business-a", "delivered"], ["business-b", "delivered"], ["squad-c", "stalled"], ["final-output", "skipped"],
      ]);
    });

    // The plan file changed: the digest moved, the retry is refused before anything is created.
    fs.writeFileSync(setup.planFile, JSON.stringify({ ...PLAN, policy: undefined }));
    const moved = nrv(setup, ["run", setup.planFile, "--retry-failed"]);
    expect(moved.status).toBe(4);
    expect(moved.stderr).toContain("já existe com outro plano");
    withKernel(setup, (kernel) => expect(getRun(kernel, setup.projectId, multiTargetRunId(setup.projectId, 2))).toBeNull());

    // The original plan restored: the stalled node and its consumer run again, nothing else.
    fs.writeFileSync(setup.planFile, JSON.stringify(PLAN, null, 2));
    const retried = nrv(setup, ["run", setup.planFile, "--retry-failed"]);
    expect(retried.status).toBe(0);
    expect(retried.stdout).toContain("voltam a pending: final-output, squad-c");
    expect(spawns(setup).slice(3)).toEqual(["squad-c", "final-output"]);
    withKernel(setup, (kernel) => {
      expect(getRun(kernel, setup.projectId, multiTargetRunId(setup.projectId, 2))).toMatchObject({ state: "completed", parentRunId: first });
    });
  }, spawnBudgetMs(11));

  test("a node whose subprocess leaves no cost event is reported as cost-unobserved in the audit, the summary and status", () => {
    const setup = fixture();
    const runId = multiTargetRunId(setup.projectId);
    const r = nrv(setup, ["run", setup.planFile], { FAKE_DISPATCH_COST_USD: "0" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("· onda 1 business-a: delivered · USD 0 (custo não observado)");
    expect(r.stdout).toContain("· onda 0 brief-main: delivered · USD 0\n");
    expect(r.stdout).toContain("custo não observado em 4 nó(s): business-a, business-b, squad-c, final-output");
    const audit = auditEvents(setup);
    expect(audit.filter((event) => event.event === "x_multi_target_cost_unobserved").map((event) => [event.node_id, event.wave, event.mode, event.state]).sort())
      .toEqual([["business-a", 1, "standard", "delivered"], ["business-b", 1, "gauntlet", "delivered"], ["final-output", 3, "gauntlet", "delivered"], ["squad-c", 2, "standard", "delivered"]]);
    expect(audit.find((event) => event.event === "x_multi_target_cost_unobserved")).toMatchObject({ trace_id: setup.projectId, run_id: runId, logs_dir: path.join(setup.projectRoot, ".nirvana", "logs", "harness") });
    const terminalOf = (id: string) => audit.find((event) => event.event === "x_multi_target_node_terminal" && event.node_id === id)!;
    expect(terminalOf("brief-main").cost_observed).toBeNull();
    expect(terminalOf("squad-c").cost_observed).toBe(false);
    expect(audit.find((event) => event.event === "x_multi_target_terminal")!.cost_unobserved_nodes).toEqual(["business-a", "business-b", "squad-c", "final-output"]);
    expect(audit.filter((event) => event.event === "agent_executed")).toHaveLength(0);
    withKernel(setup, (kernel) => {
      const projection = projectMultiTargetRun(kernel, setup.projectId, runId)!;
      expect(projection.nodes.map((node) => [node.nodeId, node.costObserved])).toEqual([
        ["brief-main", undefined], ["business-a", false], ["business-b", false], ["squad-c", false], ["final-output", false],
      ]);
      const journaled = listEvents(kernel, setup.projectId).filter((event) => event.type === "multi_target.cost_unobserved");
      expect(journaled.map((event) => (event.payload as { nodeId: string }).nodeId)).toEqual(["business-a", "business-b", "squad-c", "final-output"]);
    });
    const status = nrv(setup, ["status", setup.planFile]);
    expect(status.stdout).toContain("custo não observado");
    expect(status.stdout.split("\n").filter((line) => line.includes("custo não observado"))).toHaveLength(4);
  }, spawnBudgetMs(6));
});

describe("nrv multi-target status and usage", () => {
  test("status is read-only and names what is missing", () => {
    const setup = fixture();
    const none = nrv(setup, ["status", setup.planFile]);
    expect(none.status).toBe(1);
    expect(none.stderr).toContain("Nenhum Run Kernel");
    expect(fs.existsSync(setup.kernel)).toBeFalse();
    expect(nrv(setup, ["run", setup.planFile]).status).toBe(0);
    const unknown = nrv(setup, ["status", "run_mt_ghost", "--project", setup.projectId]);
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain("não encontrado");
    const noProject = nrv(setup, ["status", "run_mt_ghost"]);
    expect(noProject.status).toBe(4);
    expect(noProject.stderr).toContain("--project");
    expect(spawns(setup)).toHaveLength(4);
  }, spawnBudgetMs(8));

  test("usage: no subcommand or an unknown one exits 4; help exits 0", () => {
    const setup = fixture();
    expect(nrv(setup, [])).toMatchObject({ status: 4, stderr: expect.stringContaining("nrv multi-target plan") });
    expect(nrv(setup, ["bogus", setup.planFile]).status).toBe(4);
    expect(nrv(setup, ["plan"]).status).toBe(4);
    expect(nrv(setup, ["help"]).status).toBe(0);
  }, spawnBudgetMs(4));
});

describe("nrv multi-target with an agent node", () => {
  test("plan compiles squad → agent → squad → deliverable with the agent as an agent-x target, and refuses the agent without a brief", () => {
    const setup = fixture("proj-agent");
    fs.writeFileSync(setup.planFile, JSON.stringify(AGENT_PLAN, null, 2));
    const r = nrv(setup, ["plan", setup.planFile]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("1: squad-research");
    expect(r.stdout).toContain("2: role-copywriter");
    expect(r.stdout).toContain("3: squad-design");
    expect(r.stdout).toContain("4: final-output");
    expect(r.stdout).toMatch(/role-copywriter\s+agent-x\s+gauntlet light/);
    expect(r.stdout).toContain("Nada foi executado");
    const manifest = JSON.parse(fs.readFileSync(path.join(setup.workspace, "manifest.json"), "utf8"));
    expect(manifest.phases.find((phase: { id: string }) => phase.id === "role-copywriter")).toMatchObject({
      target: "agent/role-copywriter", outputs_path: "agents/role-copywriter/outputs/", depends_on: ["squad-research"], consumed_by: ["squad-design"],
    });
    expect(spawns(setup)).toEqual([]);

    const { "role-copywriter": _omitted, ...briefs } = AGENT_PLAN.briefs;
    const missing = validatePlanFile({ ...AGENT_PLAN, briefs });
    expect(missing.plan).toBeNull();
    expect(missing.issues).toEqual([{ path: "/briefs/role-copywriter", message: "executable node role-copywriter has no brief" }]);
    fs.writeFileSync(setup.planFile, JSON.stringify({ ...AGENT_PLAN, briefs }));
    const refused = nrv(setup, ["plan", setup.planFile]);
    expect(refused.status).toBe(4);
    expect(refused.stderr).toContain("/briefs/role-copywriter: executable node role-copywriter has no brief");

    const badEdge = { ...AGENT_PLAN, graph: { ...AGENT_PLAN.graph, edges: [...AGENT_PLAN.graph.edges, { id: "bad", source: "squad-design", target: "role-copywriter", type: "covers" }] } };
    fs.writeFileSync(setup.planFile, JSON.stringify(badEdge));
    expect(nrv(setup, ["plan", setup.planFile])).toMatchObject({ status: 4, stderr: expect.stringContaining('edge type "covers" is not allowed from squad to agent') });
  }, spawnBudgetMs(3));

  test("run executes the agent node as --agent-x under agents/<id>/, distinguishes its cost from the synthesis and shows the target kind", () => {
    const setup = fixture("proj-agent");
    fs.writeFileSync(setup.planFile, JSON.stringify(AGENT_PLAN, null, 2));
    const runId = multiTargetRunId(setup.projectId);
    const r = nrv(setup, ["run", setup.planFile, "--owner", "worker-agent"], { FAKE_DISPATCH_COST_USD: "0.25" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("✓ Plano multi-target entregue.");
    expect(spawns(setup)).toEqual(["squad-research", "role-copywriter", "squad-design", "final-output"]);
    for (const [kind, id] of [["squads", "squad-research"], ["agents", "role-copywriter"], ["squads", "squad-design"], ["deliverables", "final-output"]]) {
      expect(fs.existsSync(path.join(setup.workspace, kind, id, "outputs", "_SUMMARY.md"))).toBeTrue();
      expect(fs.existsSync(path.join(setup.workspace, kind, id, "DISPATCH-INSTRUCTION.md"))).toBeTrue();
    }
    const captureRole = JSON.parse(fs.readFileSync(path.join(setup.workspace, "agents", "role-copywriter", "outputs", "dispatch-capture.json"), "utf8"));
    expect(captureRole.argv).toContain("--agent-x");
    expect(captureRole.argv).not.toContain("--squad");
    expect(captureRole.argv).not.toContain("--auto");
    expect(captureRole.argv).toContain("--execution-mode=gauntlet");
    expect(captureRole.argv).toContain("--gauntlet-intensity=light");
    // The reservation completes the synthesis first, so the role keeps its light floor (1) under budgetUsd 1.5.
    expect(captureRole.argv[captureRole.argv.indexOf("--max-budget") + 1]).toBe("1");
    expect(captureRole.env.NIRVANA_MULTI_TARGET_NODE_ID).toBe("role-copywriter");
    expect(captureRole.brief).toStartWith("Write the launch copy from the research.");
    const instruction = fs.readFileSync(path.join(setup.workspace, "agents", "role-copywriter", "DISPATCH-INSTRUCTION.md"), "utf8");
    expect(instruction).toContain("target: agent/role-copywriter");
    expect(instruction).toContain("acting in the role **role-copywriter**");
    expect(instruction).toContain(path.join(setup.workspace, "squads", "squad-research", "outputs", "_SUMMARY.md"));
    expect(instruction).toContain("**squad-design** (`squad/squad-design`)");
    expect(fs.readFileSync(path.join(setup.workspace, "squads", "squad-design", "DISPATCH-INSTRUCTION.md"), "utf8"))
      .toContain(path.join(setup.workspace, "agents", "role-copywriter", "outputs", "_SUMMARY.md"));

    const projection = withKernel(setup, (kernel) => {
      expect(getRun(kernel, setup.projectId, runId)!.state).toBe("completed");
      return projectMultiTargetRun(kernel, setup.projectId, runId)!;
    });
    expect(projection.state).toBe("delivered");
    // Two agent-x children under one trace: the synthesis reports its own 0.25, not the role's as well.
    expect(projection.nodes.map((node) => [node.nodeId, node.targetKind, node.state, node.reportedCostUsd])).toEqual([
      ["brief-main", "support", "delivered", 0], ["squad-research", "squad", "delivered", 0.25], ["role-copywriter", "agent-x", "delivered", 0.25],
      ["squad-design", "squad", "delivered", 0.25], ["final-output", "synthesis", "delivered", 0.25],
    ]);
    expect(projection.reportedCostUsd).toBe(1);
    const audit = auditEvents(setup);
    expect(audit.filter((event) => event.event === "agent_executed" && event.employee === "agent-x").map((event) => event.node_id).sort()).toEqual(["final-output", "role-copywriter"]);
    expect(audit.find((event) => event.event === "x_multi_target_node_terminal" && event.node_id === "role-copywriter"))
      .toMatchObject({ run_id: runId, wave: 2, target_kind: "agent-x", mode: "gauntlet", state: "delivered", cost_usd: 0.25 });
    expect(audit.find((event) => event.event === "x_multi_target_terminal")).toMatchObject({ state: "delivered", cost_usd: 1, exit: 0 });

    const status = nrv(setup, ["status", setup.planFile]);
    expect(status.status).toBe(0);
    expect(status.stdout).toMatch(/onda 2\s+role-copywriter\s+agent-x\s+gauntlet\s+delivered\s+USD 0\.25\/1/);
    expect(spawns(setup)).toHaveLength(4);
  }, spawnBudgetMs(6));
});

// The shape of the first real smoke plan: one standard squad, then the synthesis under a light
// Gauntlet, in one project. Before the per-node Run ids both nodes derived `run_<project>`.
const SMOKE_PLAN = {
  schemaVersion: "nirvana.multi-target-plan/v1alpha1",
  brief: "# Brief\n\nLaunch material for a fictional product.\n",
  briefs: { "squad-copy": "Write the copy.", "final-output": "Assemble the launch note from the copy." },
  graph: {
    nodes: [{ id: "brief-main", type: "brief" }, { id: "squad-copy", type: "squad" }, { id: "final-output", type: "deliverable" }],
    edges: [
      { id: "b1", source: "brief-main", target: "squad-copy", type: "briefs" },
      { id: "y1", source: "squad-copy", target: "final-output", type: "yields" },
    ],
  },
  policy: { scope: "final-only", intensity: "light", synthesisNodeId: "final-output", limits: { maxCostUsd: 6 } },
};

describe("nrv multi-target run with a standard node and a Gauntlet synthesis in one project", () => {
  test("every node attempt gets its own Run id; the third attempt reruns only the synthesis under _a3 while the delivered squad keeps _a1", () => {
    const setup = fixture("smoke-cafe");
    fs.writeFileSync(setup.planFile, JSON.stringify(SMOKE_PLAN, null, 2));
    const captureOf = (kind: string, id: string) => JSON.parse(fs.readFileSync(path.join(setup.workspace, kind, id, "outputs", "dispatch-capture.json"), "utf8"));
    const runIdOf = (kind: string, id: string) => { const c = captureOf(kind, id); return c.argv[c.argv.indexOf("--run-id") + 1] as string; };
    const [r1, r2, r3] = [1, 2, 3].map((attempt) => multiTargetRunId(setup.projectId, attempt));

    const first = nrv(setup, ["run", setup.planFile], { FAKE_DISPATCH_EXIT_CODE_FOR: "final-output=1" });
    expect(first.status).toBe(1);
    expect(spawns(setup)).toEqual(["squad-copy", "final-output"]);
    expect(runIdOf("squads", "squad-copy")).toBe("run_smoke-cafe_squad-copy_a1");
    expect(runIdOf("deliverables", "final-output")).toBe("run_smoke-cafe_final-output_a1");

    // The cause still there: _r2 keeps the squad and fails on the synthesis again, under _a2.
    const second = nrv(setup, ["run", setup.planFile, "--retry-failed"], { FAKE_DISPATCH_EXIT_CODE_FOR: "final-output=1" });
    expect(second.status).toBe(1);
    expect(second.stdout).toContain(`▶ Run ${r2} criado a partir de ${r1}`);
    expect(spawns(setup)).toEqual(["squad-copy", "final-output", "final-output"]);
    expect(runIdOf("deliverables", "final-output")).toBe("run_smoke-cafe_final-output_a2");

    // The cause fixed: _r3 keeps waves 1 and 2, runs only the synthesis, under its own id.
    const third = nrv(setup, ["run", setup.planFile, "--retry-failed"]);
    expect(third.status).toBe(0);
    expect(third.stdout).toContain(`▶ Run ${r3} criado a partir de ${r2} (owner`);
    expect(third.stdout).toContain("voltam a pending: final-output\n");
    expect(third.stdout).toContain("✓ Plano multi-target entregue.");
    expect(spawns(setup)).toEqual(["squad-copy", "final-output", "final-output", "final-output"]);
    expect(runIdOf("squads", "squad-copy")).toBe("run_smoke-cafe_squad-copy_a1");
    expect(runIdOf("deliverables", "final-output")).toBe("run_smoke-cafe_final-output_a3");
    const synthesis = captureOf("deliverables", "final-output");
    expect(synthesis.argv).toContain("--agent-x");
    expect(synthesis.argv).toContain("--execution-mode=gauntlet");
    expect(synthesis.argv[synthesis.argv.indexOf("--project") + 1]).toBe(setup.projectId);
    expect(synthesis.env.NIRVANA_PROJECT_ROOT).toBe(setup.projectRoot);
    withKernel(setup, (kernel) => {
      expect(getRun(kernel, setup.projectId, r1)!.state).toBe("failed");
      expect(getRun(kernel, setup.projectId, r2)).toMatchObject({ state: "failed", parentRunId: r1 });
      expect(getRun(kernel, setup.projectId, r3)).toMatchObject({ state: "completed", parentRunId: r2 });
      const projection = projectMultiTargetRun(kernel, setup.projectId, r3)!;
      expect(projection).toMatchObject({ state: "delivered", attempt: 3 });
      expect(projection.nodes.map((node) => [node.nodeId, node.mode, node.state])).toEqual([
        ["brief-main", "standard", "delivered"], ["squad-copy", "standard", "delivered"], ["final-output", "gauntlet", "delivered"],
      ]);
    });
    const retried = auditEvents(setup).filter((event) => event.event === "x_multi_target_plan_retried");
    expect(retried.map((event) => [event.run_id, event.previous_run_id, event.reset_nodes, event.attempt])).toEqual([[r2, r1, ["final-output"], 2], [r3, r2, ["final-output"], 3]]);
  }, spawnBudgetMs(7));
});

describe("nrv multi-target plan with synthesis limits", () => {
  test("prints the allocation of a capped synthesis next to the squad's and refuses a mode on the synthesis", () => {
    const setup = fixture("landing-clinica");
    const plan = {
      ...PLAN,
      briefs: { "visual-brief": "Write the style guide.", "landing-page-nirvana": "Build the page.", "final-output": "Assemble the package." },
      graph: {
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
      },
      policy: {
        scope: "each-target-and-final", intensity: "light", synthesisNodeId: "final-output", limits: { maxCostUsd: 32 },
        synthesis: { limits: { maxCostUsd: 10 } },
        targets: { "visual-brief": { mode: "standard" }, "landing-page-nirvana": { limits: { maxCostUsd: 20 } } },
      },
      budgetUsd: { "visual-brief": 4, "landing-page-nirvana": 20, "final-output": 6 },
    };
    expect(validatePlanFile(plan).plan).not.toBeNull();
    fs.writeFileSync(setup.planFile, JSON.stringify(plan));
    const r = nrv(setup, ["plan", setup.planFile]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("alocações (teto USD 32 · concedido USD 30 · saldo USD 2)");
    expect(r.stdout).toMatch(/landing-page-nirvana\s+onda 2\s+solicitado 20\s+concedido 20\s+requested_in_full/);
    expect(r.stdout).toMatch(/final-output\s+onda 3\s+solicitado 10\s+concedido 10\s+requested_in_full/);

    const withMode = { ...plan, policy: { ...plan.policy, synthesis: undefined, targets: { ...plan.policy.targets, "final-output": { mode: "gauntlet" } } } };
    fs.writeFileSync(setup.planFile, JSON.stringify(withMode));
    const refused = nrv(setup, ["plan", setup.planFile]);
    expect(refused.status).toBe(4);
    expect(refused.stderr).toContain("/policy/targets/final-output/mode: synthesis mode comes from the scope");
  }, spawnBudgetMs(2));
});
