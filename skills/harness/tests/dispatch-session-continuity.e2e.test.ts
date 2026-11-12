// dispatch-session-continuity.e2e.test.ts — the session a squad or agent-x run
// leaves for `nrv revise`, and `nrv dispatch --continue-from <project>`.
//
//   - a squad run and an agent-x run write session.json beside their scaffold,
//     and `nrv revise` continues that session as the same worker;
//   - `--continue-from <project>` hands the earlier project's session to the
//     same worker of a new dispatch, refuses another worker, and starts fresh
//     (said and audited) when the earlier run recorded no id.
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

describe("an agent-x run leaves its session", () => {
  test("session.json beside agent-x's scaffold, with the session the runtime reported", () => {
    const fx = fixture();
    const r = fx.dispatch(["--agent-x"], "proj-ax");
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const session = JSON.parse(fs.readFileSync(path.join(fx.projectRoot, "outputs", "proj-ax", "agent-x", "session.json"), "utf8"));
    expect(session).toMatchObject({
      project_id: "proj-ax", target_kind: "agent-x", target_slug: "agent-x", runtime: "claude-code", session_id: "sess-fake",
      project_dir: path.join(fx.projectRoot, "outputs", "proj-ax", "agent-x"), outputs_root: fx.outputsFor("proj-ax"), manifest: null,
    });
    expect(fx.calls().map(call => call.role)).toEqual(["agent-x"]);
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

describe("--continue-from: a new brief continues an earlier project's session", () => {
  /** Every audit line of the fixture's logs, raw. */
  const auditText = (root: string): string => {
    const dir = path.join(root, "logs");
    if (!fs.existsSync(dir)) return "";
    return fs.readdirSync(dir).map(day => path.join(dir, day, "audit.jsonl")).filter(f => fs.existsSync(f)).map(f => fs.readFileSync(f, "utf8")).join("\n");
  };

  test("the same squad resumes the earlier session, from the earlier run's folder, and records it there for revise", () => {
    const fx = fixture();
    expect(fx.dispatch(["--squad", "fixture-squad"], "proj-first").status).toBe(0);
    // The first run was started under an id the engine chose, and the session it
    // reported reached the session store `nrv revise` and later dispatches read.
    const firstArgv = fx.calls()[0].argv;
    expect(firstArgv[firstArgv.indexOf("--session-id") + 1]).toMatch(/^[0-9a-f-]{36}$/);
    const r = fx.dispatch(["--squad", "fixture-squad"], "proj-second", ["--continue-from", "proj-first"]);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const second = fx.calls()[1];
    expect(second.role).toBe("squad");
    expect(second.argv[second.argv.indexOf("--resume") + 1]).toBe("sess-fake");
    expect(r.stdout).toContain("continue-from proj-first: session sess-fake (claude-code)");
    expect(auditText(fx.root)).toContain("x_session_continued");
    const first = JSON.parse(fs.readFileSync(path.join(fx.projectRoot, "outputs", "proj-first", "squads", "fixture-squad", "session.json"), "utf8"));
    const next = JSON.parse(fs.readFileSync(path.join(fx.projectRoot, "outputs", "proj-second", "squads", "fixture-squad", "session.json"), "utf8"));
    // The session lives in the first run's folder: the second run resumes it, and revise does too, from there.
    expect(next.session_id).toBe("sess-fake");
    expect(next.workspace).toBe(first.workspace);
    expect(next.outputs_root).toBe(fx.outputsFor("proj-second"));
  }, spawnBudgetMs(2));

  test("another worker than the earlier project's is refused (exit 4) before anything runs", () => {
    const fx = fixture();
    expect(fx.dispatch(["--squad", "fixture-squad"], "proj-sq").status).toBe(0);
    const r = fx.dispatch(["--agent-x"], "proj-ax", ["--continue-from", "proj-sq"]);
    expect(r.status).toBe(4);
    expect(r.stderr).toContain("A session continues only with its own worker");
    expect(fx.calls()).toHaveLength(1);
    const missing = fx.dispatch(["--agent-x"], "proj-ax", ["--continue-from", "proj-none"]);
    expect(missing.status).toBe(4);
    expect(missing.stderr).toContain("no session.json for project 'proj-none'");
  }, spawnBudgetMs(3));

  test("an earlier run with no session id: the worker starts fresh with that delivery as input, said and audited", () => {
    const fx = fixture();
    expect(fx.dispatch(["--agent-x"], "proj-old").status).toBe(0);
    const file = path.join(fx.projectRoot, "outputs", "proj-old", "agent-x", "session.json");
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), session_id: null }));
    const r = fx.dispatch(["--agent-x"], "proj-new", ["--continue-from", "proj-old"]);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stderr).toContain("starts a FRESH session");
    expect(fx.calls()[1].argv).not.toContain("--resume");
    expect(auditText(fx.root)).toContain("x_continue_fresh_session");
  }, spawnBudgetMs(2));
});
