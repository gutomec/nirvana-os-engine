// dispatch-gauntlet-ledger.e2e.test.ts — every exit of a Gauntlet canary run by the real
// scripts/dispatch.ts leaves the legacy run-ledger in a state coherent with the canonical Run,
// and no row survives the process as `running`. A delivered Gauntlet, squad or agent-x producer,
// with or without --run-id: one row, the canonical Run's (`run_<project>`, or the id adopted from
// the project kernel), `delivered` with terminal_at. A rollback before the producer (no agentic
// evaluator, exit 4; a slice the evaluation floor consumes, exit 1): one row, `failed`, with the
// reason as last_error. The squad path spawns brief-squad to scaffold, and under the dispatch that
// prep step opens no agentic row of its own: smoke-judge-squad (2026-08-26) ended with the
// canonical row delivered and a second row, opened by brief-squad, still `running` under a
// 30-minute lease, which the supervisor would have escalated to a human as stalled.
// Hermetic: a fake `claude` CLI on PATH produces the candidate and, as judge-x, judges it; a squad
// fixture under a temporary HOME; the repository skills; no LLM and no network.
// Runs with: bun test skills/harness/tests
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRun, openKernel, type TargetRef } from "../lib/run-kernel/index.ts";
import { openLedger, type RunRow } from "../lib/run-ledger.ts";
import { canonicalRunIdFor } from "../scripts/dispatch.ts";
import { writeFakeCli } from "./helpers/fake-cli.ts";
import { removeDir } from "./helpers/temp-dirs.ts";
import { spawnBudgetMs } from "./helpers/test-budgets.ts";

const REPO = path.resolve(import.meta.dir, "..", "..", "..");
const SKILLS = path.join(REPO, "skills");
const DISPATCH = path.join(SKILLS, "harness", "scripts", "dispatch.ts");
const SQUAD: TargetRef = { kind: "squad", slug: "fixture-squad", capabilityId: "squad.execute" };
const AGENT_X: TargetRef = { kind: "agent-x", slug: "agent-x" };
const GAUNTLET = ["--execution-mode=gauntlet", "--gauntlet-intensity=light"];

// Passes the offline quality gate (the fixture of dispatch-standard-kernel.e2e.test.ts).
const PASSING_HTML = [
  "<!doctype html><html><head><title>Delivery</title></head><body><main>",
  "<h1>Final delivery</h1><p>This local fixture contains enough structured content for deterministic validation.</p>",
  "<p>The manifest, quality gate and publication stages all run without network access or an external runtime.</p>",
  "</main></body></html>",
].join("");

// The fake runtime reads the prompt from STDIN. As judge-x (a `# JUDGE-X DISPATCH` prompt) it
// writes a passing scorecard at the `- scorecard_path:` the prompt names. As the producer it
// writes report.html into the candidate root the prompt names: the `- output_path:` line of the
// agent-x prompt, the backticked directory of the squad prompt, else FAKE_CLAUDE_OUTPUTS_ROOT.
const FAKE_CLAUDE = String.raw`
import * as fs from "node:fs";
import * as path from "node:path";
const prompt = await Bun.stdin.text();
if (prompt.includes("# JUDGE-X DISPATCH")) {
  const scorecardPath = /^- scorecard_path: (.+)$/m.exec(prompt)?.[1]?.trim() ?? "";
  fs.mkdirSync(path.dirname(scorecardPath), { recursive: true });
  fs.writeFileSync(scorecardPath, JSON.stringify({ schemaVersion: "nirvana.gauntlet-scorecard/v1alpha1", verdict: "pass",
    dimensions: [{ id: "brief-conformance", score: 0.95, confidence: 0.9, blocking: true, passed: true, evidenceRefs: ["report.html#L1"] }],
    revisionRequests: [], regressions: [] }, null, 2), "utf8");
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "judged", session_id: "sess-judge", total_cost_usd: 0.02 }));
  process.exit(0);
}
const outputsRoot = /^- output_path: (.+)$/m.exec(prompt)?.[1]?.trim()
  ?? /Escreva arquivos sob \x60([^\x60]+)\x60/.exec(prompt)?.[1]?.trim()
  ?? process.env.FAKE_CLAUDE_OUTPUTS_ROOT;
fs.mkdirSync(outputsRoot, { recursive: true });
fs.writeFileSync(path.join(outputsRoot, "report.html"), ${JSON.stringify(PASSING_HTML)}, "utf8");
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "delivered", session_id: "sess-fake", total_cost_usd: 0.01 }));
`;

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) removeDir(root); });

function writeSquad(dir: string): void {
  fs.mkdirSync(path.join(dir, "agents"), { recursive: true });
  fs.writeFileSync(path.join(dir, "agents", "fixture.md"), "# fixture agent\n", "utf8");
  fs.writeFileSync(path.join(dir, "squad.yaml"), [
    "name: fixture-squad", "version: 1.0.0", 'protocol: "5.0"', "description: A fixture squad for the Gauntlet ledger proof.",
    "experimental_domains: true", "components:", "  agents: [fixture.md]", "  tasks: []", "  workflows: []", "capabilities:",
    "  - id: general.fixture.run", "    description: Do the fixture thing.", "    domains: [fixture]", "    produces: [report]",
    '    examples: ["rode o fixture"]', "    invoke:", "      type: agent", "      ref: fixture", "",
  ].join("\n"), "utf8");
}

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nrv-gauntlet-ledger-"))); roots.push(root);
  const home = path.join(root, "home");
  const projectRoot = path.join(root, "project");
  const bin = path.join(root, "bin");
  fs.mkdirSync(path.join(projectRoot, ".nirvana"), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  writeFakeCli(bin, "claude", FAKE_CLAUDE);
  writeSquad(path.join(home, "squads", "fixture-squad"));
  const briefFile = path.join(root, "brief.md");
  fs.writeFileSync(briefFile, "Produza o relatório final em report.html", "utf8");
  const ledger = path.join(root, "ledger.sqlite");
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || /^(NIRVANA_|HARNESS_|FAKE_|NRV_|LLM_CASCADE|SQUADS_DIR|SQUADS_REGISTRY_PATH|BUSINESSES_DIR)/.test(key)) continue;
    env[key] = value;
  }
  Object.assign(env, {
    HOME: home, NIRVANA_HOME: home, SQUADS_DIR: path.join(home, "squads"), NIRVANA_SKILLS_DIR: SKILLS, NIRVANA_PROJECT_ROOT: projectRoot,
    NIRVANA_HOST_RUNTIME: "claude-code", NIRVANA_RUN_LEDGER_DB: ledger, NIRVANA_STATE_DB: path.join(root, "state.db"),
    HARNESS_LOGS_DIR: path.join(root, "logs"), NIRVANA_NO_UPDATE_CHECK: "1", NIRVANA_SCOPE_QUIET: "1", NRV_PREFLIGHT: "0",
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
  });
  const outputs = path.join(root, "deliverables");
  const dispatch = (target: string[], projectId: string, argv: string[] = []) =>
    spawnSync(process.execPath, [DISPATCH, ...target, "--brief-file", briefFile, "--exec", "--project", projectId, "--outputs-root", outputs, ...GAUNTLET, ...argv],
      { cwd: projectRoot, encoding: "utf8", env });
  // What Glance does before it spawns the dispatch: a `prepared` Run in the project kernel.
  const prepare = (runId: string, target: TargetRef) => {
    const handle = openKernel(path.join(projectRoot, ".nirvana", "run-kernel.sqlite"));
    createRun(handle, { projectId: "prj_glance", runId, traceId: runId, planId: `plan_${runId}`, target, policySnapshotRef: "gauntlet-light-canary",
      actor: { kind: "control-plane", id: "glance" }, correlationId: `cor_${runId}` });
    handle.close();
  };
  return { bin, outputs, ledger, dispatch, prepare };
}

/** Every row of the test's ledger, oldest first, meta parsed. */
function ledgerRows(ledgerPath: string): RunRow[] {
  const handle = openLedger(ledgerPath);
  try {
    return (handle.db.query("SELECT * FROM runs ORDER BY created_at, run_id").all() as Array<Record<string, unknown>>)
      .map(row => ({ ...row, meta: JSON.parse(String(row.meta ?? "{}")) }) as RunRow);
  } finally { handle.close(); }
}

describe("a delivered Gauntlet closes the canonical Run's ledger row and leaves no other", () => {
  test.each([
    ["--squad fixture-squad", ["--squad", "fixture-squad"], SQUAD],
    ["--agent-x", ["--agent-x"], AGENT_X],
  ])("%s: run_<project> is delivered with terminal_at, the only row in the ledger", (_label, target, producer) => {
    const fx = fixture();
    const projectId = `proj-${producer.kind}`;
    const result = fx.dispatch(target, projectId);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(fs.existsSync(path.join(fx.outputs, "report.html"))).toBe(true);
    const rows = ledgerRows(fx.ledger);
    expect(rows.map(row => [row.run_id, row.state])).toEqual([[canonicalRunIdFor(projectId), "delivered"]]);
    expect(rows[0]).toMatchObject({ trace_id: projectId, project_id: projectId, target_kind: producer.kind, target_slug: producer.slug, session_id: "sess-fake" });
    expect(rows[0].terminal_at).toBeTruthy();
    expect(rows[0].meta).toMatchObject({ canonical_state: "completed" });
  }, spawnBudgetMs(8) + 90_000);

  test.each([
    ["--squad fixture-squad", ["--squad", "fixture-squad"], SQUAD],
    ["--agent-x", ["--agent-x"], AGENT_X],
  ])("%s --run-id: the Run Glance prepared is adopted, and its row is delivered under the prepared trace", (_label, target, producer) => {
    const fx = fixture();
    const runId = `run_adopted_${producer.kind}`;
    fx.prepare(runId, producer);
    const result = fx.dispatch(target, "prj_glance", ["--run-id", runId]);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(fs.existsSync(path.join(fx.outputs, "report.html"))).toBe(true);
    const rows = ledgerRows(fx.ledger);
    expect(rows.map(row => [row.run_id, row.state])).toEqual([[runId, "delivered"]]);
    expect(rows[0]).toMatchObject({ trace_id: runId, project_id: "prj_glance", target_kind: producer.kind, target_slug: producer.slug, session_id: "sess-fake" });
    expect(rows[0].terminal_at).toBeTruthy();
    expect(rows[0].meta).toMatchObject({ canonical_state: "completed" });
  }, spawnBudgetMs(8) + 90_000);
});

describe("a rollback before the producer leaves the Run's ledger row failed, with the reason", () => {
  test("no agentic evaluator (exit 4) and a slice the evaluation floor consumes (exit 1): one row each, failed, last_error naming the reason", () => {
    const fx = fixture();
    // qwen-code has no judge-x persona; a fake `qwen` on PATH makes the runtime itself available.
    writeFakeCli(fx.bin, "qwen", FAKE_CLAUDE);
    const unavailable = fx.dispatch(["--squad", "fixture-squad"], "proj-nojudge", ["--runtime", "qwen-code"]);
    expect(unavailable.status, unavailable.stdout + unavailable.stderr).toBe(4);
    const insufficient = fx.dispatch(["--agent-x"], "proj-nobudget", ["--max-budget", "1.5"]);
    expect(insufficient.status, insufficient.stdout + insufficient.stderr).toBe(1);
    expect(fs.existsSync(path.join(fx.outputs, "report.html"))).toBe(false);
    const rows = ledgerRows(fx.ledger);
    expect(rows.map(row => [row.run_id, row.state, row.target_kind])).toEqual([
      [canonicalRunIdFor("proj-nojudge"), "failed", "squad"],
      [canonicalRunIdFor("proj-nobudget"), "failed", "agent-x"],
    ]);
    expect(rows[0].last_error).toMatch(/^evaluator_unavailable: no judge-x persona for runtime 'qwen-code'/);
    expect(rows[1].last_error).toMatch(/^max_cost: plan ceiling USD 8/);
    for (const row of rows) expect(row.meta).toMatchObject({ canonical_state: "rolled_back" });
  }, spawnBudgetMs(3) + 30_000);
});
