// dispatch-standard-kernel.e2e.test.ts — the real scripts/dispatch.ts in standard mode
// leaves a canonical Run in the Run Kernel (run.prepared → runtime.selection_snapshot →
// running → verifying → terminal) while the legacy exit codes, artifacts and audit stay
// untouched; a scaffold-only run creates no Run; and the Glance runner's kill() reaches
// the runtime grandchild. Hermetic: a fake `claude` CLI on PATH, a squad fixture under a
// temporary HOME, the repository skills, no LLM and no network.
// Runs with: bun test skills/harness/tests
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createDispatchExecutionRunner, glanceRunDir } from "../lib/control-plane/index.ts";
import { createRun, getRun, listEvents, openKernel, type RunEvent, type TargetRef } from "../lib/run-kernel/index.ts";
import { openLedger } from "../lib/run-ledger.ts";
import { canonicalRunIdFor } from "../scripts/dispatch.ts";
import { writeFakeCli } from "./helpers/fake-cli.ts";
import { makeTempRoot } from "./helpers/temp-dirs.ts";
import { pidAlive, waitUntil } from "./helpers/fake-glance-child.ts";

const REPO = path.resolve(import.meta.dir, "..", "..", "..");
const SKILLS = path.join(REPO, "skills");
const DISPATCH = path.join(SKILLS, "harness", "scripts", "dispatch.ts");
const SQUAD: TargetRef = { kind: "squad", slug: "fixture-squad", capabilityId: "squad.execute" };
const STANDARD_TIMELINE = ["run.prepared", "runtime.selection_snapshot", "run.transitioned:running", "run.transitioned:verifying"];

// Passes the offline quality gate (the same fixture business-delivery-parity.e2e.test.ts uses).
const PASSING_HTML = [
  "<!doctype html><html><head><title>Delivery</title></head><body><main>",
  "<h1>Final delivery</h1><p>This local fixture contains enough structured content for deterministic validation.</p>",
  "<p>The manifest, quality gate and publication stages all run without network access or an external runtime.</p>",
  "</main></body></html>",
].join("");

// The fake runtime reads the prompt from STDIN as the driver delivers it, records its pid, then
// acts per FAKE_CLAUDE_MODE: `deliver` writes report.html under FAKE_CLAUDE_OUTPUTS_ROOT and prints
// the claude-code JSON envelope; `fail` exits 1 with nothing on disk; `sleep` blocks until a signal.
const FAKE_CLAUDE = String.raw`
import * as fs from "node:fs";
import * as path from "node:path";
const capture = process.env.FAKE_CAPTURE_DIR;
const prompt = await Bun.stdin.text();
fs.writeFileSync(path.join(capture, "pid"), String(process.pid));
const mode = process.env.FAKE_CLAUDE_MODE ?? "deliver";
if (mode === "sleep") {
  process.on("SIGTERM", () => { fs.writeFileSync(path.join(capture, "signal"), "SIGTERM"); process.exit(143); });
  fs.writeFileSync(path.join(capture, "started"), String(prompt.length));
  await Bun.sleep(60000);
  process.exit(0);
}
if (mode === "fail") { console.error("fake runtime: provider failure"); process.exit(1); }
const outputsRoot = process.env.FAKE_CLAUDE_OUTPUTS_ROOT;
fs.mkdirSync(outputsRoot, { recursive: true });
fs.writeFileSync(path.join(outputsRoot, "report.html"), ${JSON.stringify(PASSING_HTML)}, "utf8");
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "delivered", session_id: "sess-fake", total_cost_usd: 0.01 }));
`;

const roots: string[] = [];
afterEach(() => { while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true }); });

function writeSquad(dir: string): void {
  fs.mkdirSync(path.join(dir, "agents"), { recursive: true });
  fs.writeFileSync(path.join(dir, "agents", "fixture.md"), "# fixture agent\n", "utf8");
  fs.writeFileSync(path.join(dir, "squad.yaml"), [
    "name: fixture-squad", "version: 1.0.0", 'protocol: "5.0"', "description: A fixture squad for the standard-mode kernel proof.",
    "experimental_domains: true", "components:", "  agents: [fixture.md]", "  tasks: []", "  workflows: []", "capabilities:",
    "  - id: general.fixture.run", "    description: Do the fixture thing.", "    domains: [fixture]", "    produces: [report]",
    '    examples: ["rode o fixture"]', "    invoke:", "      type: agent", "      ref: fixture", "",
  ].join("\n"), "utf8");
}

function fixture() {
  const root = makeTempRoot("nrv-standard-kernel-"); roots.push(root);
  const home = path.join(root, "home");
  const projectRoot = path.join(root, "project");
  const bin = path.join(root, "bin");
  const capture = path.join(root, "capture");
  fs.mkdirSync(path.join(projectRoot, ".nirvana"), { recursive: true });
  fs.mkdirSync(capture, { recursive: true });
  writeFakeCli(bin, "claude", FAKE_CLAUDE);
  writeSquad(path.join(home, "squads", "fixture-squad"));
  const briefFile = path.join(root, "brief.md");
  fs.writeFileSync(briefFile, "Produza o relatório final em report.html", "utf8");
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || /^(NIRVANA_|HARNESS_|FAKE_|NRV_|LLM_CASCADE|SQUADS_DIR|BUSINESSES_DIR)/.test(key)) continue;
    env[key] = value;
  }
  Object.assign(env, {
    HOME: home, NIRVANA_HOME: home, SQUADS_DIR: path.join(home, "squads"), NIRVANA_SKILLS_DIR: SKILLS, NIRVANA_PROJECT_ROOT: projectRoot,
    NIRVANA_HOST_RUNTIME: "claude-code", NIRVANA_RUN_LEDGER_DB: path.join(root, "ledger.sqlite"), NIRVANA_STATE_DB: path.join(root, "state.db"),
    HARNESS_LOGS_DIR: path.join(root, "logs"), NIRVANA_NO_UPDATE_CHECK: "1", NIRVANA_SCOPE_QUIET: "1", NRV_PREFLIGHT: "0",
    FAKE_CAPTURE_DIR: capture, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
  });
  const dispatch = (args: string[], extra: Record<string, string> = {}) =>
    spawnSync(process.execPath, [DISPATCH, ...args], { cwd: projectRoot, encoding: "utf8", env: { ...env, ...extra } });
  const projectKernel = path.join(projectRoot, ".nirvana", "run-kernel.sqlite");
  const dispatchKernel = (projectId: string) => path.join(projectRoot, "outputs", projectId, ".nirvana", "run-kernel.sqlite");
  const prepare = (runId: string, target: TargetRef) => {
    const handle = openKernel(projectKernel);
    createRun(handle, { projectId: "prj_glance", runId, traceId: runId, planId: `plan_${runId}`, target, policySnapshotRef: "gauntlet-light-canary",
      actor: { kind: "control-plane", id: "glance" }, correlationId: `cor_${runId}` });
    handle.close();
  };
  const audit = () => {
    const dir = path.join(root, "logs");
    if (!fs.existsSync(dir)) return [] as Array<Record<string, unknown>>;
    return fs.readdirSync(dir).sort().flatMap(day => {
      const file = path.join(dir, day, "audit.jsonl");
      return fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>) : [];
    });
  };
  return { root, projectRoot, briefFile, capture, env, dispatch, projectKernel, dispatchKernel, prepare, audit };
}

function readKernel(kernelPath: string, projectId: string, runId: string): { run: ReturnType<typeof getRun>; events: RunEvent[] } {
  const handle = openKernel(kernelPath);
  try { return { run: getRun(handle, projectId, runId), events: listEvents(handle, projectId).filter(event => event.runId === runId) }; }
  finally { handle.close(); }
}

const timeline = (events: RunEvent[]) => events.map(event => event.type === "run.transitioned" ? `run.transitioned:${(event.payload as { to: string }).to}` : event.type);

describe("standard dispatch publishes a canonical Run", () => {
  test("agent-x --exec leaves run_<project> completed in the dispatch kernel; exit code, artifacts and legacy audit unchanged", () => {
    const fx = fixture();
    const outputs = path.join(fx.root, "deliverables-agent-x");
    const result = fx.dispatch(["--agent-x", "--brief-file", fx.briefFile, "--exec", "--project", "proj-ax", "--outputs-root", outputs, "--max-revisions", "0"],
      { FAKE_CLAUDE_OUTPUTS_ROOT: outputs });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(fs.existsSync(path.join(outputs, "report.html"))).toBe(true);
    const runId = canonicalRunIdFor("proj-ax");
    const { run, events } = readKernel(fx.dispatchKernel("proj-ax"), "proj-ax", runId);
    expect(run).toMatchObject({ state: "completed", target: { kind: "agent-x", slug: "agent-x" }, traceId: "proj-ax", planId: `plan_${runId}` });
    expect(run!.policySnapshotRef).toStartWith("snapshot_");
    expect(timeline(events)).toEqual([...STANDARD_TIMELINE, "run.transitioned:completed"]);
    expect(events.map(event => event.idempotencyKey)).toEqual(["create", "execution-snapshot", "running", "verifying", "terminal"].map(step => `standard:${runId}:${step}`));
    expect(events[1].payload).toMatchObject({ ref: run!.policySnapshotRef, snapshot: { runtime: { id: "claude-code" } } });
    expect(events.at(-1)!.payload).toEqual({ from: "verifying", to: "completed", exitCode: 0, gateOutcome: "pass", outputsRoot: outputs });
    const audit = fx.audit();
    for (const event of ["dispatch_agent_x", "agent_executed", "verify_passed", "gate_passed", "delivered"]) {
      expect(audit.some(entry => entry.event === event), event).toBe(true);
    }
    expect(audit.some(entry => entry.event === "x_run_kernel_unavailable")).toBe(false);
    expect(fs.existsSync(fx.projectKernel)).toBe(false);
  }, 90000);

  test("--squad --run-id adopts the Run Glance prepared in the project kernel: one run.prepared, the prepared trace, a real terminal state", () => {
    const fx = fixture();
    fx.prepare("run_adopted", SQUAD);
    const outputs = path.join(glanceRunDir(fx.projectRoot, "run_adopted"), "outputs");
    const result = fx.dispatch(["--squad", "fixture-squad", "--brief-file", fx.briefFile, "--exec", "--project", "prj_glance", "--run-id", "run_adopted",
      "--outputs-root", outputs, "--max-revisions", "0"], { FAKE_CLAUDE_OUTPUTS_ROOT: outputs });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(fs.existsSync(path.join(outputs, "report.html"))).toBe(true);
    const { run, events } = readKernel(fx.projectKernel, "prj_glance", "run_adopted");
    expect(run).toMatchObject({ state: "completed", policySnapshotRef: "gauntlet-light-canary", traceId: "run_adopted", target: SQUAD });
    expect(events.filter(event => event.type === "run.prepared")).toHaveLength(1);
    expect(events.every(event => event.traceId === "run_adopted")).toBe(true);
    expect(timeline(events)).toEqual([...STANDARD_TIMELINE, "run.transitioned:completed"]);
    expect(events.find(event => event.type === "runtime.selection_snapshot")!.idempotencyKey).toBe("standard:run_adopted:execution-snapshot");
    expect(events.at(-1)!.payload).toMatchObject({ from: "verifying", to: "completed", exitCode: 0, gateOutcome: "pass", outputsRoot: outputs });
    expect(fx.audit().some(entry => entry.event === "dispatch_squad")).toBe(true);
    // The prep step the squad path spawned (brief-squad) opened no agentic row under the dispatch:
    // the dispatch's own row is the ledger's only one, and it is closed.
    const ledger = openLedger(path.join(fx.root, "ledger.sqlite"));
    try {
      const rows = ledger.db.query("SELECT state, meta FROM runs").all() as Array<{ state: string; meta: string }>;
      expect(rows.map(row => [row.state, JSON.parse(row.meta).opened_by ?? null])).toEqual([["delivered", null]]);
    } finally { ledger.close(); }
  }, 90000);

  test("a runtime failure with nothing on disk ends the Run failed with the error and the legacy exit 1", () => {
    const fx = fixture();
    const outputs = path.join(fx.root, "deliverables-failed");
    const result = fx.dispatch(["--agent-x", "--brief-file", fx.briefFile, "--exec", "--project", "proj-fail", "--outputs-root", outputs],
      { FAKE_CLAUDE_MODE: "fail", FAKE_CLAUDE_OUTPUTS_ROOT: outputs });
    expect(result.status, result.stdout + result.stderr).toBe(1);
    const { run, events } = readKernel(fx.dispatchKernel("proj-fail"), "proj-fail", canonicalRunIdFor("proj-fail"));
    expect(run?.state).toBe("failed");
    expect(timeline(events)).toEqual([...STANDARD_TIMELINE, "run.transitioned:failed"]);
    const terminal = events.at(-1)!.payload as { exitCode: number; gateOutcome: string; error?: string };
    expect(terminal).toMatchObject({ exitCode: 1, gateOutcome: "indeterminate", outputsRoot: outputs });
    expect(typeof terminal.error).toBe("string");
    expect(terminal.error!.length).toBeGreaterThan(0);
    expect(fx.audit().some(entry => entry.event === "agent_exec_failed")).toBe(true);
  }, 90000);

  test("a scaffold-only run (no --exec) creates no Run and keeps exit 3", () => {
    const fx = fixture();
    const result = fx.dispatch(["--agent-x", "--brief-file", fx.briefFile, "--project", "proj-scaffold"]);
    expect(result.status, result.stdout + result.stderr).toBe(3);
    expect(fs.existsSync(path.join(fx.projectRoot, "outputs", "proj-scaffold", "brief-enriched.md"))).toBe(true);
    expect(fs.existsSync(fx.dispatchKernel("proj-scaffold"))).toBe(false);
    expect(fs.existsSync(fx.projectKernel)).toBe(false);
  }, 60000);
});

describe("cancelling a Glance child reaches the runtime grandchild", () => {
  test("kill() signals the dispatch's process group: the fake runtime records SIGTERM and dies with the dispatch", async () => {
    if (process.platform === "win32") return;
    const fx = fixture();
    fx.prepare("run_killed", SQUAD);
    const runner = createDispatchExecutionRunner({ dispatchScriptPath: DISPATCH, env: { ...fx.env, FAKE_CLAUDE_MODE: "sleep" } });
    const child = runner.start({ projectRoot: fx.projectRoot, projectId: "prj_glance", runId: "run_killed", briefFile: fx.briefFile, target: SQUAD, intensity: "light" });
    await waitUntil(() => fs.existsSync(path.join(fx.capture, "started")), "the fake runtime to start", 60000);
    const runtimePid = Number(fs.readFileSync(path.join(fx.capture, "pid"), "utf8"));
    expect(runtimePid).toBeGreaterThan(0);
    expect(pidAlive(runtimePid)).toBe(true);
    expect(readKernel(fx.projectKernel, "prj_glance", "run_killed").run?.state).toBe("running");
    child.kill();
    expect((await child.done).exitCode).toBeNull();
    await waitUntil(() => fs.existsSync(path.join(fx.capture, "signal")), "the fake runtime to record the signal");
    expect(fs.readFileSync(path.join(fx.capture, "signal"), "utf8")).toBe("SIGTERM");
    await waitUntil(() => !pidAlive(runtimePid), "the runtime grandchild to exit");
    // The dispatch died mid-flight, so the Run stays `running`: the queue settles it (agent-x-canary-queue.ts).
    expect(readKernel(fx.projectKernel, "prj_glance", "run_killed").run?.state).toBe("running");
  }, 90000);
});

describe("a Run that already ended under --run-id is refused before the runtime runs", () => {
  test("--run-id creates the Run in the project kernel when none was prepared; a standard and a Gauntlet dispatch under the same id then exit 1 with x_run_id_collision", () => {
    const fx = fixture();
    const runId = "run_prj-glance_fixture-squad_a1";
    const outputs = path.join(fx.root, "deliverables-node");
    const args = (target: string[]) => [...target, "--brief-file", fx.briefFile, "--exec", "--project", "prj_glance", "--run-id", runId,
      "--outputs-root", outputs, "--max-revisions", "0"];
    const first = fx.dispatch(args(["--squad", "fixture-squad"]), { FAKE_CLAUDE_OUTPUTS_ROOT: outputs });
    expect(first.status, first.stdout + first.stderr).toBe(0);
    const { run, events } = readKernel(fx.projectKernel, "prj_glance", runId);
    expect(run).toMatchObject({ state: "completed", traceId: "prj_glance", target: SQUAD, planId: `plan_${runId}` });
    expect(timeline(events)).toEqual([...STANDARD_TIMELINE, "run.transitioned:completed"]);
    expect(fs.existsSync(fx.dispatchKernel("prj_glance"))).toBe(false);
    fs.rmSync(path.join(fx.capture, "pid"));

    const second = fx.dispatch(args(["--squad", "fixture-squad"]), { FAKE_CLAUDE_OUTPUTS_ROOT: outputs });
    expect(second.status, second.stdout + second.stderr).toBe(1);
    expect(second.stderr).toContain(`run '${runId}' is already terminal (completed); pass a fresh --run-id`);
    expect(fs.existsSync(path.join(fx.capture, "pid"))).toBe(false);

    const third = fx.dispatch([...args(["--agent-x"]), "--execution-mode=gauntlet", "--gauntlet-intensity=light"], { FAKE_CLAUDE_OUTPUTS_ROOT: outputs });
    expect(third.status, third.stdout + third.stderr).toBe(1);
    expect(third.stderr).toContain(`✗ agent-x Gauntlet failed: run '${runId}' is already terminal (completed); pass a fresh --run-id`);
    expect(fs.existsSync(path.join(fx.capture, "pid"))).toBe(false);

    expect(readKernel(fx.projectKernel, "prj_glance", runId).events).toHaveLength(events.length);
    const collisions = fx.audit().filter(entry => entry.event === "x_run_id_collision");
    expect(collisions.map(entry => [entry.run_id, entry.state, entry.target_kind, entry.mode]))
      .toEqual([[runId, "completed", "squad", "standard"], [runId, "completed", "agent-x", "gauntlet"]]);
    expect(collisions[0]).toMatchObject({ trace_id: "prj_glance", project_id: "prj_glance", kernel_path: fx.projectKernel, run_target: SQUAD });
    expect(collisions[1]).toMatchObject({ trace_id: "prj_glance", project_id: "prj_glance", run_target: SQUAD });
  }, 120000);
});
