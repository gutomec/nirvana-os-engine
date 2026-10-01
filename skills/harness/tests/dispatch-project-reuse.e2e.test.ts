// dispatch-project-reuse.e2e.test.ts — a dispatch into an explicit --project that
// already holds runs, and the session a squad or agent-x run leaves for `nrv revise`.
//
//   - a run of that project still working (live worker pid, or a pid-less row
//     inside its lease) refuses the new dispatch with exit 4 before anything exists;
//   - a run that ended without a decision (failed, stalled, worker gone with its
//     lease expired) is abandoned, "superseded by <new run id>", once the new run opens;
//   - a dispatch with --run-id belongs to a control plane and is left alone;
//   - a squad run and an agent-x run write session.json beside their scaffold, and
//     `nrv revise` continues that session as the same worker.
//
// Hermetic: a fake `claude` CLI on PATH, a squad fixture under a temporary HOME,
// a temporary ledger, the repository skills, no LLM and no network.
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as runLedger from "../lib/run-ledger.ts";
import { writeFakeCli } from "./helpers/fake-cli.ts";
import { makeTempRoot, removeDir } from "./helpers/temp-dirs.ts";
import { spawnBudgetMs } from "./helpers/test-budgets.ts";

const SKILLS = path.resolve(import.meta.dir, "..", "..");
const DISPATCH = path.join(SKILLS, "harness", "scripts", "dispatch.ts");
const REVISE = path.join(SKILLS, "harness", "scripts", "revise.ts");

// Passes the offline quality gate (the fixture dispatch-standard-kernel uses).
const PASSING_HTML = [
  "<!doctype html><html><head><title>Delivery</title></head><body><main>",
  "<h1>Final delivery</h1><p>This local fixture contains enough structured content for deterministic validation.</p>",
  "<p>The manifest, quality gate and publication stages all run without network access or an external runtime.</p>",
  "</main></body></html>",
].join("");

// Records each call (pid, role, argv) in FAKE_CAPTURE_DIR, writes report.html under
// FAKE_CLAUDE_OUTPUTS_ROOT and prints the claude-code JSON envelope.
const FAKE_CLAUDE = String.raw`
import * as fs from "node:fs";
import * as path from "node:path";
const capture = process.env.FAKE_CAPTURE_DIR;
await Bun.stdin.text();
fs.appendFileSync(path.join(capture, "calls"), JSON.stringify({ pid: process.pid, role: process.env.NIRVANA_DISPATCH_ROLE ?? "", argv: process.argv.slice(2) }) + "\n");
const outputsRoot = process.env.FAKE_CLAUDE_OUTPUTS_ROOT;
fs.mkdirSync(outputsRoot, { recursive: true });
fs.writeFileSync(path.join(outputsRoot, "report.html"), ${JSON.stringify(PASSING_HTML)}, "utf8");
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "delivered", session_id: "sess-fake", total_cost_usd: 0.01 }));
`;

const roots: string[] = [];
const handles: runLedger.LedgerHandle[] = [];
afterEach(() => {
  while (handles.length) handles.pop()!.close();
  while (roots.length) removeDir(roots.pop()!);
});

function writeSquad(dir: string): void {
  fs.mkdirSync(path.join(dir, "agents"), { recursive: true });
  fs.writeFileSync(path.join(dir, "agents", "fixture.md"), "# fixture agent\n", "utf8");
  fs.writeFileSync(path.join(dir, "squad.yaml"), [
    "name: fixture-squad", "version: 1.0.0", 'protocol: "5.0"', "description: A fixture squad for the project-reuse proof.",
    "experimental_domains: true", "components:", "  agents: [fixture.md]", "  tasks: []", "  workflows: []", "capabilities:",
    "  - id: general.fixture.run", "    description: Do the fixture thing.", "    domains: [fixture]", "    produces: [report]",
    '    examples: ["rode o fixture"]', "    invoke:", "      type: agent", "      ref: fixture", "",
  ].join("\n"), "utf8");
}

function fixture() {
  const root = makeTempRoot("nrv-project-reuse-");
  roots.push(root);
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
  const db = path.join(root, "ledger.sqlite");
  const ledger = runLedger.openLedger(db);
  handles.push(ledger);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || /^(NIRVANA_|HARNESS_|FAKE_|NRV_|LLM_CASCADE|SQUADS_DIR|BUSINESSES_DIR)/.test(key)) continue;
    env[key] = value;
  }
  Object.assign(env, {
    HOME: home, USERPROFILE: home, NIRVANA_HOME: home, SQUADS_DIR: path.join(home, "squads"), NIRVANA_SKILLS_DIR: SKILLS, NIRVANA_PROJECT_ROOT: projectRoot,
    NIRVANA_HOST_RUNTIME: "claude-code", NIRVANA_RUN_LEDGER_DB: db, NIRVANA_STATE_DB: path.join(root, "state.db"),
    HARNESS_LOGS_DIR: path.join(root, "logs"), NIRVANA_NO_UPDATE_CHECK: "1", NIRVANA_SCOPE_QUIET: "1", NRV_PREFLIGHT: "0",
    NIRVANA_JUDGE_ENABLED: "false", NIRVANA_HTML_LAYOUT: "0", NRV_HOST_ANCESTRY: "0",
    FAKE_CAPTURE_DIR: capture, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
  });
  const outputsFor = (projectId: string) => path.join(root, `deliverables-${projectId}`);
  const dispatch = (target: string[], projectId: string, extra: string[] = []) => spawnSync(process.execPath,
    [DISPATCH, ...target, "--brief-file", briefFile, "--exec", "--project", projectId, "--outputs-root", outputsFor(projectId), "--max-revisions", "0", ...extra],
    { cwd: projectRoot, encoding: "utf8", env: { ...env, FAKE_CLAUDE_OUTPUTS_ROOT: outputsFor(projectId) } });
  const revise = (projectId: string) => spawnSync(process.execPath, [REVISE, projectId, "encurte o relatório", "--no-color"],
    { cwd: projectRoot, encoding: "utf8", env: { ...env, FAKE_CLAUDE_OUTPUTS_ROOT: outputsFor(projectId) } });
  /** A row of `projectId` in this project, walked to `state` legally. */
  const row = (projectId: string, state: runLedger.RunState, opts: Partial<runLedger.OpenRunOpts> = {}): string => {
    const opened = runLedger.openRun(ledger, { traceId: projectId, projectId, projectRoot, targetKind: "agent-x", targetSlug: "agent-x", ...opts });
    if (state !== "dispatched") runLedger.markState(ledger, opened.run_id, "running");
    if (state === "failed" || state === "stalled") runLedger.markState(ledger, opened.run_id, state, state === "failed" ? { error: "quota" } : {});
    return opened.run_id;
  };
  const calls = (): Array<{ pid: number; role: string; argv: string[] }> => {
    const file = path.join(capture, "calls");
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
  };
  const get = (runId: string) => runLedger.getRun(ledger, runId)!;
  return { root, projectRoot, ledger, dispatch, revise, row, calls, get, outputsFor };
}

describe("a dispatch into an explicit --project that already holds runs", () => {
  test("a run still working there refuses the dispatch (exit 4) before anything is created or run", () => {
    const fx = fixture();
    // The test process stands in for a live worker; the second row is pid-less inside its lease.
    const live = fx.row("proj-busy", "running", { childPid: process.pid });
    const leased = fx.row("proj-leased", "dispatched", { initialLeaseSec: 600 });
    for (const [projectId, runId] of [["proj-busy", live], ["proj-leased", leased]]) {
      const r = fx.dispatch(["--agent-x"], projectId);
      expect(r.status, r.stdout + r.stderr).toBe(4);
      expect(r.stderr).toContain(`run ${runId} is still working in this project; wait for it or pick another --project`);
      expect(fs.existsSync(path.join(fx.projectRoot, "outputs", projectId))).toBe(false);
    }
    expect(fx.calls()).toHaveLength(0);
    expect(fx.get(live).state).toBe("running");
    expect(fx.get(leased).state).toBe("dispatched");
    expect(fs.existsSync(path.join(fx.projectRoot, ".nirvana", "run-kernel.sqlite"))).toBe(false);
  }, spawnBudgetMs(2));

  test("runs that ended without a decision are superseded once the new run opens; the agent-x run leaves its session", () => {
    const fx = fixture();
    const failed = fx.row("proj-retry", "failed");
    const stalled = fx.row("proj-retry", "stalled");
    const deadWorker = spawnSync(process.execPath, ["-e", ""], { windowsHide: true }).pid!;
    const orphan = fx.row("proj-retry", "running", { childPid: deadWorker, initialLeaseSec: -60 });
    const r = fx.dispatch(["--agent-x"], "proj-retry");
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const fresh = runLedger.findByTraceId(fx.ledger, "proj-retry")!;
    expect(fresh.state).toBe("delivered");
    expect(fresh.session_id).toBe("sess-fake");
    for (const id of [failed, stalled, orphan]) {
      expect(fx.get(id).state, id).toBe("abandoned");
      expect(fx.get(id).last_error).toBe(`superseded by ${fresh.run_id}`);
    }
    expect(r.stderr.split("\n").filter(line => line.includes("superseded by"))).toHaveLength(1);

    const session = JSON.parse(fs.readFileSync(path.join(fx.projectRoot, "outputs", "proj-retry", "agent-x", "session.json"), "utf8"));
    expect(session).toMatchObject({
      project_id: "proj-retry", target_kind: "agent-x", target_slug: "agent-x", runtime: "claude-code", session_id: "sess-fake",
      project_dir: path.join(fx.projectRoot, "outputs", "proj-retry", "agent-x"), outputs_root: fx.outputsFor("proj-retry"), manifest: null,
    });
    expect(path.basename(session.workspace)).toBe("proj-retry");
  }, spawnBudgetMs(1));

  test("a dispatch with --run-id belongs to its control plane: a live run of the same project id neither blocks it nor is touched", () => {
    const fx = fixture();
    const live = fx.row("prj_cp", "running", { childPid: process.pid });
    const r = fx.dispatch(["--agent-x"], "prj_cp", ["--run-id", "run_prj_cp_node_a1"]);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(fx.get(live).state).toBe("running");
  }, spawnBudgetMs(1));
});

describe("a squad run leaves its session, and nrv revise continues it", () => {
  test("session.json beside the squad's scaffold; the revision resumes it as `squad` and redelivers", () => {
    const fx = fixture();
    const r = fx.dispatch(["--squad", "fixture-squad"], "proj-squad");
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const sessionFile = path.join(fx.projectRoot, "outputs", "proj-squad", "squads", "fixture-squad", "session.json");
    expect(JSON.parse(fs.readFileSync(sessionFile, "utf8"))).toMatchObject({
      project_id: "proj-squad", target_kind: "squad", target_slug: "fixture-squad", runtime: "claude-code", session_id: "sess-fake",
      outputs_root: fx.outputsFor("proj-squad"), project_root: fx.projectRoot,
    });
    expect(fx.calls().map(call => call.role)).toEqual(["squad"]);

    const revised = fx.revise("proj-squad");
    expect(revised.status, revised.stdout + revised.stderr).toBe(0);
    const resumed = fx.calls()[1];
    expect(resumed.role).toBe("squad");
    expect(resumed.argv).toContain("sess-fake");
    // The revision is a new attempt of the trace, a squad's.
    const attempt = runLedger.findByTraceId(fx.ledger, "proj-squad")!;
    expect(attempt).toMatchObject({ target_kind: "squad", state: "delivered" });
    expect(attempt.meta.revision_of).toBeTruthy();
  }, spawnBudgetMs(2));
});
