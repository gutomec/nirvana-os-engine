// settings-spawners.test.ts — the spawners pin the effective settings into the
// child's environment as the variables the child reads: the Glance execution
// runner, the multi-target dispatch adapters, the Gauntlet evaluator adapter,
// and dispatch.ts's prep scripts. The fake dispatch records its environment; a
// project config and a global config (a temp NIRVANA_HOME) must reach it, and a
// variable already in the environment must win. No LLM, no network.
// Runs with: bun test skills/harness/tests
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { DependencyGraph } from "../../_shared/lib/dependency-graph.ts";
import { createDispatchExecutionRunner, glanceRunDir } from "../lib/control-plane/execution-runner.ts";
import { compileGauntletPlan } from "../lib/gauntlet/compiler.ts";
import { createDispatchEvaluator, evaluationDirFor } from "../lib/gauntlet/evaluator-adapter.ts";
import { createDispatchMultiTargetAdapters } from "../lib/gauntlet/multi-target-dispatch-adapters.ts";
import type { MultiTargetAdapterInput } from "../lib/gauntlet/multi-target-coordinator.ts";
import { compileMultiTargetGauntletPolicy, type CompiledMultiTargetPlan } from "../lib/plan-compiler.ts";
import { writeFakeDispatch } from "./helpers/fake-dispatch.ts";
import { removeDir } from "./helpers/temp-dirs.ts";
import { spawnBudgetMs } from "./helpers/test-budgets.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) removeDir(root); });

interface Capture { argv: string[]; env: Record<string, string>; cwd: string }

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nrv-settings-spawners-")));
  roots.push(root);
  const home = path.join(root, "home");
  const projectRoot = path.join(root, "project");
  fs.mkdirSync(path.join(home, ".nirvana"), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, ".nirvana"), { recursive: true });
  fs.writeFileSync(path.join(home, ".nirvana", "config.yaml"), "supervisor:\n  progress_ping_sec: 7\nexecution:\n  model: opus\n", "utf8");
  fs.writeFileSync(path.join(projectRoot, ".nirvana", "config.yaml"),
    "execution:\n  dna_injection: fragments\nrouting:\n  mode: fast\ngauntlet:\n  business_allowlist: other-business\n", "utf8");
  const briefFile = path.join(root, "brief.md");
  fs.writeFileSync(briefFile, "Produza o relatório", "utf8");
  const env = { NIRVANA_HOME: home, HARNESS_LOGS_DIR: path.join(root, "logs"), FAKE_DISPATCH_SPAWN_LOG: path.join(root, "spawns.log") };
  return { root, home, projectRoot, briefFile, env, fake: writeFakeDispatch(path.join(root, "helpers")) };
}

const read = (file: string): Capture => JSON.parse(fs.readFileSync(file, "utf8")) as Capture;

/** What every spawner must pin: the project's and the user's config, as the child's variables. */
function expectPinned(env: Record<string, string>): void {
  expect(env).toMatchObject({
    NIRVANA_DNA_INJECTION: "fragments", NIRVANA_ROUTING_MODE: "fast", NIRVANA_PROGRESS_PING_SEC: "7", NIRVANA_MODEL: "opus",
    NIRVANA_EXECUTION_MODE: "standard", NIRVANA_GAUNTLET_INTENSITY: "balanced", NIRVANA_HEADLESS_SKIP_PERMISSIONS: "1",
  });
}

describe("the Glance execution runner", () => {
  test("pins the effective settings into the child; a variable in the runner's environment wins", async () => {
    const setup = fixture();
    const runner = createDispatchExecutionRunner({ dispatchScriptPath: setup.fake, env: setup.env });
    const child = runner.start({ projectRoot: setup.projectRoot, projectId: "prj", runId: "run_pinned", briefFile: setup.briefFile, target: { kind: "agent-x", slug: "agent-x" }, intensity: "light" });
    expect(await child.done).toEqual({ exitCode: 0 });
    const seen = read(path.join(glanceRunDir(setup.projectRoot, "run_pinned"), "outputs", "dispatch-capture.json"));
    expectPinned(seen.env);
    expect(seen.env.NIRVANA_BUSINESS_GAUNTLET_ALLOWLIST).toBe("other-business");

    const shell = createDispatchExecutionRunner({ dispatchScriptPath: setup.fake, env: { ...setup.env, NIRVANA_ROUTING_MODE: "agentic" } });
    const second = shell.start({ projectRoot: setup.projectRoot, projectId: "prj", runId: "run_shell", briefFile: setup.briefFile, target: { kind: "squad", slug: "s", capabilityId: "squad.execute" }, intensity: "light" });
    expect(await second.done).toEqual({ exitCode: 0 });
    expect(read(path.join(glanceRunDir(setup.projectRoot, "run_shell"), "outputs", "dispatch-capture.json")).env.NIRVANA_ROUTING_MODE).toBe("agentic");
  }, spawnBudgetMs(2));
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

function nodeInput(plan: CompiledMultiTargetPlan, nodeId: string): MultiTargetAdapterInput {
  const decision = [...plan.decisions, ...(plan.synthesis ? [plan.synthesis] : [])].find((item) => item.nodeId === nodeId)!;
  const phase = plan.manifest.phases.find((item) => item.id === nodeId)!;
  return {
    nodeId, target: { kind: decision.targetKind as MultiTargetAdapterInput["target"]["kind"], id: nodeId },
    mode: decision.mode, intensity: decision.intensity, grantedCostUsd: 0, upstreamPaths: [],
    outputPath: phase.outputs_path, attempt: 1, idempotencyKey: `multi-target:${plan.digest}:${nodeId}`, resume: false,
  };
}

describe("the multi-target dispatch adapters", () => {
  test("pin the effective settings; a gauntlet node merges its business into the effective allowlist, not only into the shell's", async () => {
    const setup = fixture();
    const compiled = compileMultiTargetGauntletPolicy(graph, {
      scope: "each-target-and-final", intensity: "light", synthesisNodeId: "final-output", limits: { maxCostUsd: 10 },
      targets: { "business-a": { mode: "standard" }, "business-b": { limits: { maxCostUsd: 2 } }, "squad-c": { mode: "standard" } },
    });
    expect(compiled.issues).toEqual([]);
    const plan = compiled.plan!;
    const workspaceRoot = path.join(setup.projectRoot, ".nirvana", "outputs", "trace-pin");
    fs.mkdirSync(workspaceRoot, { recursive: true });
    const adapters = createDispatchMultiTargetAdapters({
      projectRoot: setup.projectRoot, projectId: "trace-pin", plan, dispatchScriptPath: setup.fake, env: setup.env,
      nodeBriefs: { "business-a": "Deliver part A.", "business-b": "Deliver part B.", "squad-c": "Assemble C.", "final-output": "Write the report." },
    });
    expect((await adapters.standard.run(nodeInput(plan, "business-a"))).state).toBe("delivered");
    const standard = read(path.join(workspaceRoot, "businesses", "business-a", "outputs", "dispatch-capture.json"));
    expectPinned(standard.env);
    expect(standard.env.NIRVANA_BUSINESS_GAUNTLET_ALLOWLIST).toBe("other-business");

    expect((await adapters.gauntlet.run(nodeInput(plan, "business-b"))).state).toBe("delivered");
    const gauntlet = read(path.join(workspaceRoot, "businesses", "business-b", "outputs", "dispatch-capture.json"));
    expectPinned(gauntlet.env);
    expect(gauntlet.env.NIRVANA_BUSINESS_GAUNTLET_ALLOWLIST.split(",")).toEqual(["other-business", "business-b"]);
    expect(gauntlet.argv).toContain("--execution-mode=gauntlet");
  }, spawnBudgetMs(2));
});

describe("the Gauntlet evaluator adapter", () => {
  test("pins the effective settings into the evaluator's dispatch", () => {
    const setup = fixture();
    const candidateRoot = path.join(setup.projectRoot, ".nirvana", "gauntlet", "run_1", "candidates", "can_1", "rev_1");
    fs.mkdirSync(candidateRoot, { recursive: true });
    fs.writeFileSync(path.join(candidateRoot, "report.md"), "# Relatório\n", "utf8");
    const brief = "Produza report.md com o resumo executivo.";
    const evaluator = createDispatchEvaluator({
      target: { kind: "squad", slug: "fixture-evaluator", capabilityId: "quality.specification_conformance" },
      producer: { kind: "agent-x", slug: "agent-x" }, plan: compileGauntletPlan({ brief, intensity: "light" }), brief,
      projectRoot: setup.projectRoot, projectId: "prj_1", dispatchScriptPath: setup.fake,
      env: { ...setup.env, FAKE_DISPATCH_SCORECARD: "pass" }, now: () => "2026-08-26T10:00:00.000Z",
    });
    const [scorecard] = evaluator.evaluate({
      projectId: "prj_1", runId: "run_1", candidateId: "can_1", revision: 1, round: 1, revisionId: "crv_run_1_can_1_1",
      candidateRoot, artifactRefs: [], holdout: false,
    });
    expect(scorecard.verdict).toBe("pass");
    const seen = read(path.join(evaluationDirFor(setup.projectRoot, "run_1", "crv_run_1_can_1_1"), "outputs", "dispatch-capture.json"));
    expectPinned(seen.env);
  }, spawnBudgetMs(1));
});

describe("dispatch.ts prep scripts", () => {
  test("the prep-script environment carries the pinned settings and every employee-prompt spawn uses it", () => {
    const src = fs.readFileSync(path.join(import.meta.dir, "..", "scripts", "dispatch.ts"), "utf8");
    expect(src).toMatch(/const prepScriptEnv = \{ \.\.\.process\.env, \.\.\.settingsEnvForChild\(\), NIRVANA_DISPATCH_TRACKS_RUN: "1" \};/);
    const employeePromptSpawns = src.match(/spawnSync\("bun", (?:buildArgs|\[employeePrompt)[^\n]*/g) ?? [];
    expect(employeePromptSpawns.length).toBe(2);
    for (const spawn of employeePromptSpawns) expect(spawn).toContain("env: prepScriptEnv");
    const prepScriptSpawns = src.match(/spawnSync\("bun", (?:args|\[briefSquadScript)[^\n]*/g) ?? [];
    expect(prepScriptSpawns.length).toBe(2);
    for (const spawn of prepScriptSpawns) expect(spawn).toContain("env: prepScriptEnv");
  });
});
