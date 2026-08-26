// gauntlet-evaluator-dispatch.e2e.test.ts — the real scripts/dispatch.ts in gauntlet mode
// selects its evaluator through the ladder of lib/gauntlet/evaluator-selection.ts, audits
// the decision, runs a real evaluator as a subprocess with an explicit target and books its
// cost on the scorecard; a variable it cannot honour ends the dispatch before the producer.
// Hermetic: a fake `claude` CLI on PATH produces the candidate, the fake dispatch of
// helpers/fake-dispatch.ts is the evaluator (NIRVANA_DISPATCH_SCRIPT), a registry fixture
// under a temporary HOME names the installed squads. No LLM, no network.
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EVALUATION_RUBRIC_VERSION } from "../lib/gauntlet/evaluation-contract.ts";
import { evaluationDirFor } from "../lib/gauntlet/evaluator-adapter.ts";
import { listScorecards } from "../lib/gauntlet/store.ts";
import { getRun, openKernel } from "../lib/run-kernel/index.ts";
import { canonicalRunIdFor } from "../scripts/dispatch.ts";
import { writeFakeCli } from "./helpers/fake-cli.ts";
import { writeFakeDispatch } from "./helpers/fake-dispatch.ts";
import { removeDir } from "./helpers/temp-dirs.ts";
import { spawnBudgetMs } from "./helpers/test-budgets.ts";

const REPO = path.resolve(import.meta.dir, "..", "..", "..");
const SKILLS = path.join(REPO, "skills");
const DISPATCH = path.join(SKILLS, "harness", "scripts", "dispatch.ts");
const CONFORMANCE = "quality.specification_conformance";

// Passes the offline quality gate (the fixture of dispatch-standard-kernel.e2e.test.ts).
const PASSING_HTML = [
  "<!doctype html><html><head><title>Delivery</title></head><body><main>",
  "<h1>Final delivery</h1><p>This local fixture contains enough structured content for deterministic validation.</p>",
  "<p>The manifest, quality gate and publication stages all run without network access or an external runtime.</p>",
  "</main></body></html>",
].join("");

// The fake runtime reads the agent-x prompt from STDIN, records its pid and writes report.html
// into the candidate root the prompt names (`- output_path: <root>`), which differs per candidate.
const FAKE_CLAUDE = String.raw`
import * as fs from "node:fs";
import * as path from "node:path";
const capture = process.env.FAKE_CAPTURE_DIR;
const prompt = await Bun.stdin.text();
fs.appendFileSync(path.join(capture, "pids"), process.pid + "\n");
const outputsRoot = /^- output_path: (.+)$/m.exec(prompt)?.[1]?.trim() ?? process.env.FAKE_CLAUDE_OUTPUTS_ROOT;
fs.mkdirSync(outputsRoot, { recursive: true });
fs.writeFileSync(path.join(outputsRoot, "report.html"), ${JSON.stringify(PASSING_HTML)}, "utf8");
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "delivered", session_id: "sess-fake", total_cost_usd: 0.01 }));
`;

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) removeDir(root); });

function fixture(installed: Record<string, string[]>) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nrv-gauntlet-evaluator-e2e-"))); roots.push(root);
  const home = path.join(root, "home");
  const projectRoot = path.join(root, "project");
  const bin = path.join(root, "bin");
  const capture = path.join(root, "capture");
  fs.mkdirSync(path.join(projectRoot, ".nirvana"), { recursive: true });
  fs.mkdirSync(capture, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  writeFakeCli(bin, "claude", FAKE_CLAUDE);
  const registry = path.join(home, ".squads-registry.json");
  fs.writeFileSync(registry, JSON.stringify({ schema_version: 1, squads: Object.fromEntries(Object.entries(installed).map(([slug, capabilities]) => [slug, { capabilities }])) }), "utf8");
  const briefFile = path.join(root, "brief.md");
  fs.writeFileSync(briefFile, "Produza o relatório final em report.html", "utf8");
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || /^(NIRVANA_|HARNESS_|FAKE_|NRV_|LLM_CASCADE|SQUADS_DIR|SQUADS_REGISTRY_PATH|BUSINESSES_DIR)/.test(key)) continue;
    env[key] = value;
  }
  Object.assign(env, {
    HOME: home, NIRVANA_HOME: home, SQUADS_DIR: path.join(home, "squads"), SQUADS_REGISTRY_PATH: registry, NIRVANA_SKILLS_DIR: SKILLS,
    NIRVANA_PROJECT_ROOT: projectRoot, NIRVANA_HOST_RUNTIME: "claude-code", NIRVANA_RUN_LEDGER_DB: path.join(root, "ledger.sqlite"),
    NIRVANA_STATE_DB: path.join(root, "state.db"), HARNESS_LOGS_DIR: path.join(root, "logs"), NIRVANA_NO_UPDATE_CHECK: "1",
    NIRVANA_SCOPE_QUIET: "1", NRV_PREFLIGHT: "0", NIRVANA_DISPATCH_SCRIPT: writeFakeDispatch(path.join(root, "fake")),
    FAKE_CAPTURE_DIR: capture, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
  });
  const outputs = path.join(root, "deliverables");
  const dispatch = (projectId: string, extra: Record<string, string> = {}) =>
    spawnSync(process.execPath, [DISPATCH, "--agent-x", "--brief-file", briefFile, "--exec", "--project", projectId, "--outputs-root", outputs,
      "--execution-mode=gauntlet", "--gauntlet-intensity=light"], { cwd: projectRoot, encoding: "utf8", env: { ...env, ...extra } });
  const audit = () => {
    const dir = path.join(root, "logs");
    if (!fs.existsSync(dir)) return [] as Array<Record<string, unknown>>;
    return fs.readdirSync(dir).sort().flatMap(day => {
      const file = path.join(dir, day, "audit.jsonl");
      return fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>) : [];
    });
  };
  const producerRuns = () => { try { return fs.readFileSync(path.join(capture, "pids"), "utf8").split("\n").filter(Boolean).length; } catch { return 0; } };
  const kernel = (projectId: string) => path.join(projectRoot, "outputs", projectId, ".nirvana", "run-kernel.sqlite");
  return { root, projectRoot, outputs, dispatch, audit, producerRuns, kernel };
}

function scorecards(kernelPath: string, projectId: string) {
  const handle = openKernel(kernelPath);
  try { return { run: getRun(handle, projectId, canonicalRunIdFor(projectId)), scorecards: listScorecards(handle, projectId, canonicalRunIdFor(projectId)) }; }
  finally { handle.close(); }
}

describe("dispatch.ts selects and runs the Gauntlet evaluator", () => {
  test("NIRVANA_GAUNTLET_EVALUATOR=squad:<slug> runs the installed squad as a subprocess evaluator and books its cost on the scorecard", () => {
    const fx = fixture({ "fixture-evaluator": [CONFORMANCE], "other-squad": ["general.write.execute"] });
    const result = fx.dispatch("proj-env", { NIRVANA_GAUNTLET_EVALUATOR: "squad:fixture-evaluator", FAKE_DISPATCH_SCORECARD: "pass", FAKE_DISPATCH_COST_USD: "0.2" });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(fs.existsSync(path.join(fx.outputs, "report.html"))).toBeTrue();
    expect(fx.producerRuns()).toBe(1);
    const { run, scorecards: cards } = scorecards(fx.kernel("proj-env"), "proj-env");
    expect(run?.state).toBe("completed");
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ verdict: "pass", costUsd: 0.2, gauntletId: "brief-conformance", rubricVersion: EVALUATION_RUBRIC_VERSION,
      evaluator: { kind: "squad", slug: "fixture-evaluator", capabilityId: CONFORMANCE } });
    const projectRoot = path.join(fx.projectRoot, "outputs", "proj-env");
    const evaluationDir = evaluationDirFor(projectRoot, canonicalRunIdFor("proj-env"), "crv_run_proj-env_can_1_1");
    expect(fs.existsSync(path.join(evaluationDir, "scorecard.json"))).toBeTrue();
    expect(fs.readFileSync(path.join(evaluationDir, "evaluation-brief.md"), "utf8")).toContain("Produza o relatório final em report.html");
    const captured = JSON.parse(fs.readFileSync(path.join(evaluationDir, "dispatch-capture.json"), "utf8")) as { argv: string[]; cwd: string };
    expect(captured.argv.slice(0, 2)).toEqual(["--squad", "fixture-evaluator"]);
    expect(captured.argv).toContain("--execution-mode=standard");
    expect(captured.argv[captured.argv.indexOf("--project") + 1]).toBe("proj-env-evl-crv_run_proj-env_can_1_1");
    expect(captured.cwd).toBe(projectRoot);
    const audit = fx.audit();
    expect(audit.filter(entry => entry.event === "x_gauntlet_evaluator_fallback")).toEqual([]);
    expect(audit.find(entry => entry.event === "x_gauntlet_evaluator_selected")).toMatchObject({ trace_id: "proj-env", source: "env",
      evaluator: `squad:fixture-evaluator:${CONFORMANCE}`, target: { kind: "squad", slug: "fixture-evaluator", capabilityId: CONFORMANCE }, producer: "agent-x:agent-x", evaluation_share: 0.25 });
    expect(audit.find(entry => entry.event === "x_gauntlet_evaluation_completed")).toMatchObject({ trace_id: "proj-env", verdict: "pass", cost_usd: 0.2, exit_code: 0 });
    for (const event of ["dispatch_agent_x", "agent_executed", "gate_passed", "delivered"]) expect(audit.some(entry => entry.event === event), event).toBe(true);
  }, spawnBudgetMs(3) + 60_000);

  test("without the variable the registry squad declaring the capability is selected; without one, an agent-x producer falls to the heuristic with every rung audited", () => {
    const registry = fixture({ "spec-judge": [CONFORMANCE] });
    const viaRegistry = registry.dispatch("proj-registry", { FAKE_DISPATCH_SCORECARD: "pass" });
    expect(viaRegistry.status, viaRegistry.stdout + viaRegistry.stderr).toBe(0);
    expect(scorecards(registry.kernel("proj-registry"), "proj-registry").scorecards[0]).toMatchObject({ evaluator: { kind: "squad", slug: "spec-judge", capabilityId: CONFORMANCE }, rubricVersion: EVALUATION_RUBRIC_VERSION });
    expect(registry.audit().filter(entry => entry.event === "x_gauntlet_evaluator_fallback").map(entry => entry.reason)).toEqual(["unset"]);
    expect(registry.audit().find(entry => entry.event === "x_gauntlet_evaluator_selected")).toMatchObject({ source: "registry", evaluator: `squad:spec-judge:${CONFORMANCE}` });

    const bare = fixture({ "code-review": ["software_engineering.code_review.execute"] });
    const heuristic = bare.dispatch("proj-heuristic");
    expect(heuristic.status, heuristic.stdout + heuristic.stderr).toBe(0);
    const card = scorecards(bare.kernel("proj-heuristic"), "proj-heuristic").scorecards[0];
    expect(card).toMatchObject({ verdict: "pass", costUsd: 0, rubricVersion: "harness-quality-gate/v1", evaluator: { kind: "squad", slug: "harness-quality-gate" } });
    expect(bare.audit().filter(entry => entry.event === "x_gauntlet_evaluator_fallback").map(entry => [entry.from, entry.reason]))
      .toEqual([["env", "unset"], ["registry", "registry_no_match"], ["agent-x", "producer_is_agent_x"]]);
    expect(bare.audit().find(entry => entry.event === "x_gauntlet_evaluator_selected")).toMatchObject({ source: "default", evaluator: "heuristic", target: null, evaluation_share: 0 });
    expect(bare.audit().some(entry => entry.event === "x_gauntlet_evaluation_completed")).toBeFalse();
    expect(fs.existsSync(path.join(bare.projectRoot, "outputs", "proj-heuristic", ".nirvana", "gauntlet", canonicalRunIdFor("proj-heuristic"), "evaluations"))).toBeFalse();
  }, spawnBudgetMs(5) + 60_000);

  test("a variable that cannot be honoured ends the dispatch with exit 4 before any producer runs", () => {
    const fx = fixture({});
    const self = fx.dispatch("proj-self", { NIRVANA_GAUNTLET_EVALUATOR: "agent-x" });
    expect(self.status).toBe(4);
    expect(self.stderr).toContain("cannot evaluate candidates produced by agent-x:agent-x");
    const ghost = fx.dispatch("proj-ghost", { NIRVANA_GAUNTLET_EVALUATOR: "squad:ghost" });
    expect(ghost.status).toBe(4);
    expect(ghost.stderr).toContain("squad 'ghost', which is not in the installed registry");
    expect(fx.producerRuns()).toBe(0);
    expect(fs.existsSync(fx.kernel("proj-self"))).toBeFalse();
    expect(fx.audit().some(entry => entry.event === "x_gauntlet_evaluator_selected")).toBeFalse();
  }, spawnBudgetMs(2) + 30_000);
});
