// gauntlet-evaluator-dispatch.e2e.test.ts — the real scripts/dispatch.ts in gauntlet mode
// selects its evaluator through the ladder of lib/gauntlet/evaluator-selection.ts, audits
// the decision, runs a real evaluator as a subprocess with an explicit target and books its
// cost on the scorecard; a variable it cannot honour ends the dispatch before the producer,
// and so does a ladder with no agentic evaluator (the Run rolled back as
// `evaluator_unavailable`); the heuristic runs only by explicit opt-in. Hermetic: a fake
// `claude` CLI on PATH produces the candidate and, when the engine's judge-x is selected,
// judges it; the fake dispatch of helpers/fake-dispatch.ts is the evaluator when the test
// says so (NIRVANA_DISPATCH_SCRIPT); a registry fixture under a temporary HOME names the
// installed squads. No LLM, no network.
import { parseAuditLine } from "../../_shared/lib/cloudevents.js";
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { compileGauntletPlan } from "../lib/gauntlet/compiler.ts";
import { EVALUATION_OUTPUTS_DIR, EVALUATION_RUBRIC_VERSION } from "../lib/gauntlet/evaluation-contract.ts";
import { createDispatchEvaluator, evaluationDirFor, evaluationProjectId } from "../lib/gauntlet/evaluator-adapter.ts";
import { JUDGE_X_TARGET } from "../lib/gauntlet/judge-x.ts";
import { listScorecards } from "../lib/gauntlet/store.ts";
import { getRun, listEvents, openKernel } from "../lib/run-kernel/index.ts";
import type { TargetRef } from "../lib/run-kernel/types.ts";
import { canonicalRunIdFor } from "../scripts/dispatch.ts";
import { writeFakeCli } from "./helpers/fake-cli.ts";
import { writeFakeDispatch } from "./helpers/fake-dispatch.ts";
import { makeTempRoot, removeDir } from "./helpers/temp-dirs.ts";
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

// The fake runtime reads the prompt from STDIN. As the agent-x producer it records its pid and
// writes report.html into the candidate root the prompt names (`- output_path: <root>`), which
// differs per candidate. As judge-x (a `# JUDGE-X DISPATCH` prompt) it records the prompt and
// writes a passing scorecard at the `- scorecard_path:` the prompt names, unless
// FAKE_JUDGE_WRITES=nothing.
const FAKE_CLAUDE = String.raw`
import * as fs from "node:fs";
import * as path from "node:path";
const capture = process.env.FAKE_CAPTURE_DIR;
const prompt = await Bun.stdin.text();
if (prompt.includes("# JUDGE-X DISPATCH")) {
  fs.appendFileSync(path.join(capture, "judge-prompts"), prompt.length + "\n");
  fs.writeFileSync(path.join(capture, "judge-prompt.md"), prompt, "utf8");
  const scorecardPath = /^- scorecard_path: (.+)$/m.exec(prompt)?.[1]?.trim() ?? "";
  if (process.env.FAKE_JUDGE_WRITES !== "nothing") {
    fs.mkdirSync(path.dirname(scorecardPath), { recursive: true });
    fs.writeFileSync(scorecardPath, JSON.stringify({ schemaVersion: "nirvana.gauntlet-scorecard/v1alpha1", verdict: "pass",
      dimensions: [{ id: "brief-conformance", score: 0.95, confidence: 0.9, blocking: true, passed: true, evidenceRefs: ["report.html#L1"] }],
      revisionRequests: [], regressions: [] }, null, 2), "utf8");
  }
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "judged", session_id: "sess-judge", total_cost_usd: 0.02 }));
  process.exit(0);
}
fs.appendFileSync(path.join(capture, "pids"), process.pid + "\n");
const outputsRoot = /^- output_path: (.+)$/m.exec(prompt)?.[1]?.trim() ?? process.env.FAKE_CLAUDE_OUTPUTS_ROOT;
fs.mkdirSync(outputsRoot, { recursive: true });
fs.writeFileSync(path.join(outputsRoot, "report.html"), ${JSON.stringify(PASSING_HTML)}, "utf8");
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "delivered", session_id: "sess-fake", total_cost_usd: 0.01 }));
`;

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) removeDir(root); });

function fixture(installed: Record<string, string[]>) {
  const root = makeTempRoot("nrv-gauntlet-evaluator-e2e-"); roots.push(root);
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
  const dispatch = (projectId: string, extra: Record<string, string> = {}, argv: string[] = []) =>
    spawnSync(process.execPath, [DISPATCH, "--agent-x", "--brief-file", briefFile, "--exec", "--project", projectId, "--outputs-root", outputs,
      "--execution-mode=gauntlet", "--gauntlet-intensity=light", ...argv], { cwd: projectRoot, encoding: "utf8", env: { ...env, ...extra } });
  const audit = () => {
    const dir = path.join(root, "logs");
    if (!fs.existsSync(dir)) return [] as Array<Record<string, unknown>>;
    return fs.readdirSync(dir).sort().flatMap(day => {
      const file = path.join(dir, day, "audit.jsonl");
      return fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(line => parseAuditLine(line) as Record<string, unknown>) : [];
    });
  };
  const producerRuns = () => { try { return fs.readFileSync(path.join(capture, "pids"), "utf8").split("\n").filter(Boolean).length; } catch { return 0; } };
  const judgeRuns = () => { try { return fs.readFileSync(path.join(capture, "judge-prompts"), "utf8").split("\n").filter(Boolean).length; } catch { return 0; } };
  // One kernel per project: every dispatch under this root publishes into this one file.
  const kernel = path.join(projectRoot, ".nirvana", "run-kernel.sqlite");
  return { root, projectRoot, outputs, env, bin, capture, dispatch, audit, producerRuns, judgeRuns, kernel };
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
    const { run, scorecards: cards } = scorecards(fx.kernel, "proj-env");
    expect(run?.state).toBe("completed");
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ verdict: "pass", costUsd: 0.2, gauntletId: "brief-conformance", rubricVersion: EVALUATION_RUBRIC_VERSION,
      evaluator: { kind: "squad", slug: "fixture-evaluator", capabilityId: CONFORMANCE } });
    // Evaluations stay beside the candidates they judge, in the Run's WORKSPACE…
    const workspaceRoot = path.join(fx.projectRoot, "outputs", "proj-env");
    const evaluationDir = evaluationDirFor(workspaceRoot, canonicalRunIdFor("proj-env"), "crv_run_proj-env_can_1_1");
    expect(fs.existsSync(path.join(evaluationDir, EVALUATION_OUTPUTS_DIR, "scorecard.json"))).toBeTrue();
    expect(fs.readFileSync(path.join(evaluationDir, "evaluation-brief.md"), "utf8")).toContain("Produza o relatório final em report.html");
    const captured = JSON.parse(fs.readFileSync(path.join(evaluationDir, EVALUATION_OUTPUTS_DIR, "dispatch-capture.json"), "utf8")) as { argv: string[]; cwd: string };
    expect(captured.argv.slice(0, 2)).toEqual(["--squad", "fixture-evaluator"]);
    expect(captured.argv).toContain("--execution-mode=standard");
    expect(captured.argv[captured.argv.indexOf("--project") + 1]).toBe("proj-env-evl-crv_run_proj-env_can_1_1");
    // …while the evaluator dispatch itself runs in the PROJECT, like every other dispatch.
    expect(captured.cwd).toBe(fx.projectRoot);
    const audit = fx.audit();
    expect(audit.filter(entry => entry.event === "x_gauntlet_evaluator_fallback")).toEqual([]);
    expect(audit.find(entry => entry.event === "x_gauntlet_evaluator_selected")).toMatchObject({ trace_id: "proj-env", source: "env",
      evaluator: `squad:fixture-evaluator:${CONFORMANCE}`, target: { kind: "squad", slug: "fixture-evaluator", capabilityId: CONFORMANCE }, producer: "agent-x:agent-x", evaluation_share: 0.25 });
    expect(audit.find(entry => entry.event === "x_gauntlet_evaluation_completed")).toMatchObject({ trace_id: "proj-env", verdict: "pass", cost_usd: 0.2, exit_code: 0 });
    for (const event of ["dispatch_agent_x", "agent_executed", "gate_passed", "delivered"]) expect(audit.some(entry => entry.event === event), event).toBe(true);
  }, spawnBudgetMs(3) + 60_000);

  test("without the variable the registry squad declaring the capability is selected; without one, the engine's judge-x judges the agent-x producer as a real dispatch child", () => {
    const registry = fixture({ "spec-judge": [CONFORMANCE] });
    const viaRegistry = registry.dispatch("proj-registry", { FAKE_DISPATCH_SCORECARD: "pass" });
    expect(viaRegistry.status, viaRegistry.stdout + viaRegistry.stderr).toBe(0);
    expect(scorecards(registry.kernel, "proj-registry").scorecards[0]).toMatchObject({ evaluator: { kind: "squad", slug: "spec-judge", capabilityId: CONFORMANCE }, rubricVersion: EVALUATION_RUBRIC_VERSION });
    expect(registry.audit().filter(entry => entry.event === "x_gauntlet_evaluator_fallback").map(entry => entry.reason)).toEqual(["unset"]);
    expect(registry.audit().find(entry => entry.event === "x_gauntlet_evaluator_selected")).toMatchObject({ source: "registry", evaluator: `squad:spec-judge:${CONFORMANCE}` });
    expect(registry.judgeRuns()).toBe(0);

    // No NIRVANA_DISPATCH_SCRIPT: the evaluator child is the real dispatch.ts --judge-x on the fake claude.
    const bare = fixture({ "code-review": ["software_engineering.code_review.execute"] });
    delete bare.env.NIRVANA_DISPATCH_SCRIPT;
    const judged = bare.dispatch("proj-judge");
    expect(judged.status, judged.stdout + judged.stderr).toBe(0);
    expect(bare.producerRuns()).toBe(1);
    expect(bare.judgeRuns()).toBe(1);
    const { run, scorecards: cards } = scorecards(bare.kernel, "proj-judge");
    expect(run?.state).toBe("completed");
    expect(cards[0]).toMatchObject({ verdict: "pass", costUsd: 0.02, rubricVersion: EVALUATION_RUBRIC_VERSION, evaluator: JUDGE_X_TARGET });
    expect(bare.audit().filter(entry => entry.event === "x_gauntlet_evaluator_fallback").map(entry => [entry.from, entry.reason]))
      .toEqual([["env", "unset"], ["registry", "registry_no_match"]]);
    expect(bare.audit().find(entry => entry.event === "x_gauntlet_evaluator_selected")).toMatchObject({ source: "default", evaluator: "agent-x:judge-x", target: JUDGE_X_TARGET, evaluation_share: 0.25, evaluation_floor_usd: 1.5 });
    expect(bare.audit().find(entry => entry.event === "x_gauntlet_evaluation_completed")).toMatchObject({ trace_id: "proj-judge", evaluator: "agent-x:judge-x", verdict: "pass", cost_usd: 0.02, exit_code: 0 });
    const childProject = evaluationProjectId("proj-judge", "crv_run_proj-judge_can_1_1");
    expect(bare.audit().find(entry => entry.event === "x_dispatch_judge_x")).toMatchObject({ project_id: childProject, runtime: "claude-code", max_budget_usd: 1.5 });
    expect(bare.audit().filter(entry => entry.event === "agent_executed").map(entry => entry.employee)).toEqual(["agent-x", "judge-x"]);
    expect(bare.audit().some(entry => entry.event === "x_gauntlet_evaluator_heuristic_opt_in")).toBeFalse();
    const judgePrompt = fs.readFileSync(path.join(bare.capture, "judge-prompt.md"), "utf8");
    expect(judgePrompt).toContain("# Judge-X — Claude Code independent judge");
    expect(judgePrompt).toContain("Produza o relatório final em report.html");
    expect(judgePrompt).not.toContain("AUTONOMOUS MODE");
    const evaluationDir = evaluationDirFor(path.join(bare.projectRoot, "outputs", "proj-judge"), canonicalRunIdFor("proj-judge"), "crv_run_proj-judge_can_1_1");
    expect(fs.readdirSync(path.join(evaluationDir, EVALUATION_OUTPUTS_DIR))).toEqual(["scorecard.json"]);
  }, spawnBudgetMs(6) + 90_000);

  test("the offline heuristic runs only by explicit opt-in, audited as such", () => {
    const fx = fixture({});
    const result = fx.dispatch("proj-heuristic", { NIRVANA_GAUNTLET_EVALUATOR: "heuristic" });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const card = scorecards(fx.kernel, "proj-heuristic").scorecards[0];
    expect(card).toMatchObject({ verdict: "pass", costUsd: 0, rubricVersion: "harness-quality-gate/v1", evaluator: { kind: "squad", slug: "harness-quality-gate" } });
    expect(fx.audit().filter(entry => entry.event === "x_gauntlet_evaluator_fallback")).toEqual([]);
    expect(fx.audit().find(entry => entry.event === "x_gauntlet_evaluator_selected")).toMatchObject({ source: "env", evaluator: "heuristic", target: null, evaluation_share: 0 });
    expect(fx.audit().find(entry => entry.event === "x_gauntlet_evaluator_heuristic_opt_in")).toMatchObject({ trace_id: "proj-heuristic", producer: "agent-x:agent-x", env_value: "heuristic" });
    expect(fx.audit().some(entry => entry.event === "x_gauntlet_evaluation_completed")).toBeFalse();
    expect(fx.judgeRuns()).toBe(0);
    expect(fs.existsSync(path.join(fx.projectRoot, "outputs", "proj-heuristic", ".nirvana", "gauntlet", canonicalRunIdFor("proj-heuristic"), "evaluations"))).toBeFalse();
  }, spawnBudgetMs(3) + 60_000);

  test("with no agentic evaluator available the Gauntlet does not start: exit 4, the Run rolled back as evaluator_unavailable, no producer", () => {
    // qwen-code has no judge-x persona; a fake `qwen` on PATH makes the runtime itself available.
    const fx = fixture({});
    writeFakeCli(fx.bin, "qwen", FAKE_CLAUDE);
    const result = fx.dispatch("proj-nojudge", {}, ["--runtime", "qwen-code"]);
    expect(result.status, result.stdout + result.stderr).toBe(4);
    expect(result.stderr).toContain("no agentic evaluator is available (no judge-x persona for runtime 'qwen-code' (judge-x.qwen-code.md)); the Gauntlet does not start");
    expect(result.stderr).toContain("NIRVANA_GAUNTLET_EVALUATOR=heuristic");
    expect(fx.producerRuns()).toBe(0);
    expect(fx.judgeRuns()).toBe(0);
    const { run } = scorecards(fx.kernel, "proj-nojudge");
    expect(run?.state).toBe("rolled_back");
    const handle = openKernel(fx.kernel);
    try {
      const rolledBack = listEvents(handle, "proj-nojudge").find(event => event.type === "run.transitioned" && (event.payload as { to?: string }).to === "rolled_back");
      expect(rolledBack?.payload).toMatchObject({ reason: "evaluator_unavailable", errors: ["no judge-x persona for runtime 'qwen-code' (judge-x.qwen-code.md)"] });
    } finally { handle.close(); }
    expect(fx.audit().filter(entry => entry.event === "x_gauntlet_evaluator_fallback").map(entry => [entry.from, entry.reason]))
      .toEqual([["env", "unset"], ["registry", "registry_no_match"], ["judge-x", "judge_unavailable"]]);
    expect(fx.audit().find(entry => entry.event === "x_gauntlet_evaluator_unavailable")).toMatchObject({ trace_id: "proj-nojudge", runtime: "qwen-code", producer: "agent-x:agent-x" });
    expect(fx.audit().some(entry => entry.event === "x_gauntlet_evaluator_selected")).toBeFalse();
  }, spawnBudgetMs(2) + 30_000);

  test("a slice the evaluation floor consumes rolls the Run back as max_cost before the producer", () => {
    const fx = fixture({});
    const result = fx.dispatch("proj-nobudget", {}, ["--max-budget", "1.5"]);
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stderr).toContain("leaves the producer nothing");
    expect(result.stderr).toContain("max_cost before the producer");
    expect(fx.producerRuns()).toBe(0);
    expect(scorecards(fx.kernel, "proj-nobudget").run?.state).toBe("rolled_back");
    expect(fx.audit().find(entry => entry.event === "x_gauntlet_budget_insufficient")).toMatchObject({ trace_id: "proj-nobudget", evaluator: "agent-x:judge-x",
      plan_max_cost_usd: 8, max_budget_usd: 1.5, candidate_budget_usd: 0, evaluation_budget_usd: 1.5, evaluation_floor_usd: 1.5 });
  }, spawnBudgetMs(2) + 30_000);

  test("a variable that cannot be honoured ends the dispatch with exit 4 before any producer runs", () => {
    const fx = fixture({});
    const self = fx.dispatch("proj-self", { NIRVANA_GAUNTLET_EVALUATOR: "agent-x" });
    expect(self.status).toBe(4);
    expect(self.stderr).toContain("cannot evaluate candidates produced by agent-x:agent-x");
    const ghost = fx.dispatch("proj-ghost", { NIRVANA_GAUNTLET_EVALUATOR: "squad:ghost" });
    expect(ghost.status).toBe(4);
    expect(ghost.stderr).toContain("squad 'ghost', which is not in the installed registry");
    writeFakeCli(fx.bin, "qwen", FAKE_CLAUDE);
    const noJudge = fx.dispatch("proj-nojudge-env", { NIRVANA_GAUNTLET_EVALUATOR: "judge-x" }, ["--runtime", "qwen-code"]);
    expect(noJudge.status).toBe(4);
    expect(noJudge.stderr).toContain("names judge-x, which is not available: no judge-x persona for runtime 'qwen-code'");
    expect(fx.producerRuns()).toBe(0);
    expect(fs.existsSync(fx.kernel)).toBeFalse();
    expect(fx.audit().some(entry => entry.event === "x_gauntlet_evaluator_selected")).toBeFalse();
  }, spawnBudgetMs(3) + 30_000);
});

// The fake claude a child dispatch.ts runs as the agent-x or judge-x evaluator: it reads the prompt
// from STDIN, records the output_path the prompt names and writes there what FAKE_EVALUATOR_WRITES
// says: nothing, or a passing scorecard for the light plan's single requirement. FAKE_EVALUATOR_SUBTYPE
// makes it report claude-code's own error subtype (a spent cap is `error_max_budget_usd`).
const FAKE_EVALUATOR_CLAUDE = String.raw`
import * as fs from "node:fs";
import * as path from "node:path";
const prompt = await Bun.stdin.text();
const outputsRoot = /^- output_path: (.+)$/m.exec(prompt)?.[1]?.trim() ?? "";
fs.appendFileSync(path.join(process.env.FAKE_CAPTURE_DIR, "evaluator-output-paths"), outputsRoot + "\n");
fs.writeFileSync(path.join(process.env.FAKE_CAPTURE_DIR, "evaluator-prompt.md"), prompt, "utf8");
if (process.env.FAKE_EVALUATOR_WRITES === "scorecard") {
  fs.mkdirSync(outputsRoot, { recursive: true });
  fs.writeFileSync(path.join(outputsRoot, "scorecard.json"), JSON.stringify({ schemaVersion: "nirvana.gauntlet-scorecard/v1alpha1", verdict: "pass",
    dimensions: [{ id: "brief-conformance", score: 0.95, confidence: 0.9, blocking: true, passed: true, evidenceRefs: ["report.html#L1"] }],
    revisionRequests: [], regressions: [] }, null, 2), "utf8");
}
const subtype = process.env.FAKE_EVALUATOR_SUBTYPE ?? "success";
console.log(JSON.stringify({ type: "result", subtype, is_error: subtype !== "success", result: "evaluated", session_id: "sess-evaluator", total_cost_usd: 0.02 }));
`;

describe("a real dispatch.ts as the evaluator child", () => {
  const BRIEF = "Produza o relatório final em report.html";
  const PROJECT = "proj-child";
  const RUN = "run_proj-child";
  const REVISION = "crv_run_proj-child_can_1_1";

  function runChild(writes: "nothing" | "scorecard", target: TargetRef = { kind: "agent-x", slug: "agent-x" }, extraEnv: Record<string, string> = {}) {
    const fx = fixture({});
    // The evaluator fake replaces the producer fake in the fixture's own bin: the producer never runs
    // here, and the child then sees exactly the environment the producer tests prove on every OS
    // (a second directory prepended to PATH is not, once Windows merges `Path` and `PATH`).
    writeFakeCli(path.join(fx.root, "bin"), "claude", FAKE_EVALUATOR_CLAUDE);
    // The parent's project root: where a parent dispatch keeps `.nirvana/gauntlet/<run>/`.
    const projectRoot = path.join(fx.projectRoot, "outputs", PROJECT);
    const candidateRoot = path.join(projectRoot, ".nirvana", "gauntlet", RUN, "candidates", "can_1", "rev_1");
    fs.mkdirSync(candidateRoot, { recursive: true });
    fs.writeFileSync(path.join(candidateRoot, "report.html"), PASSING_HTML, "utf8");
    const audit: Array<Record<string, unknown>> = [];
    const evaluator = createDispatchEvaluator({
      target: target as Extract<TargetRef, { kind: "agent-x" }>, producer: { kind: "squad", slug: "producer", capabilityId: "general.write.execute" },
      plan: compileGauntletPlan({ brief: BRIEF, intensity: "light" }), brief: BRIEF, projectRoot, projectId: PROJECT, runtime: "claude-code",
      dispatchScriptPath: DISPATCH, env: { ...fx.env, FAKE_EVALUATOR_WRITES: writes, ...extraEnv }, budgetUsd: 1.5,
      audit: (event, payload) => audit.push({ event, ...payload }),
    });
    const [scorecard] = evaluator.evaluate({ projectId: PROJECT, runId: RUN, candidateId: "can_1", revision: 1, round: 1, revisionId: REVISION,
      candidateRoot, artifactRefs: [], holdout: false });
    const evaluationDir = evaluationDirFor(projectRoot, RUN, REVISION);
    const childProject = evaluationProjectId(PROJECT, REVISION);
    const kernel = openKernel(path.join(projectRoot, ".nirvana", "run-kernel.sqlite"));
    let childRun: ReturnType<typeof getRun>;
    try { childRun = getRun(kernel, childProject, canonicalRunIdFor(childProject)); } finally { kernel.close(); }
    const seenFile = path.join(fx.root, "capture", "evaluator-output-paths");
    const childAudit = fx.audit().filter(entry => entry.project_id === childProject);
    // What the child said, for the failure message when the fake never ran: the adapter's reason carries
    // the child's stderr tail, and agent_exec_failed carries the runtime's own error.
    const diagnostics = JSON.stringify({ reason: scorecard.dimensions[0]?.evidenceRefs[0], failures: childAudit.filter(entry => entry.event === "agent_exec_failed") });
    return {
      scorecard, evaluationDir, candidateRoot, childRun, audit, childAudit, diagnostics,
      outputPathsSeen: fs.existsSync(seenFile) ? fs.readFileSync(seenFile, "utf8").trim().split("\n") : [],
      prompt: () => fs.readFileSync(path.join(fx.root, "capture", "evaluator-prompt.md"), "utf8"),
    };
  }

  test("an evaluator that writes nothing leaves the outputs root empty: the child Run fails at verify, never completed, and the evaluation is indeterminate", () => {
    const child = runChild("nothing");
    const outputsRoot = path.join(child.evaluationDir, EVALUATION_OUTPUTS_DIR);
    expect(child.outputPathsSeen, child.diagnostics).toEqual([outputsRoot]);
    expect(fs.readdirSync(outputsRoot)).toEqual([]);
    expect(fs.readdirSync(child.evaluationDir).sort()).toEqual(["evaluation-brief.md", "evaluation-request.json", EVALUATION_OUTPUTS_DIR]);
    expect(child.scorecard.verdict).toBe("indeterminate");
    expect(child.scorecard.dimensions[0].evidenceRefs[0]).toMatch(/^indeterminate: scorecard\.json not found at .*outputs[\\/]scorecard\.json/);
    expect(child.childRun?.state).toBe("failed");
    expect(child.childAudit.some(entry => entry.event === "verify_failed")).toBeTrue();
    expect(child.childAudit.filter(entry => ["verify_passed", "gate_passed", "delivered", "x_runtime_errored_with_artifacts"].includes(entry.event as string))).toEqual([]);
    expect(child.audit).toEqual([expect.objectContaining({ event: "x_gauntlet_evaluation_completed", verdict: "indeterminate", outputs_root: outputsRoot })]);
    expect(fs.readdirSync(child.candidateRoot)).toEqual(["report.html"]);
  }, spawnBudgetMs(1) + 30_000);

  test("an evaluator that writes scorecard.json into its output_path is read from <evaluationDir>/outputs/ and passes", () => {
    const child = runChild("scorecard");
    expect(child.scorecard, child.diagnostics).toMatchObject({ verdict: "pass", evaluator: { kind: "agent-x", slug: "agent-x" }, costUsd: 0.02,
      dimensions: [{ id: "brief-conformance", score: 0.95, passed: true }] });
    expect(fs.existsSync(path.join(child.evaluationDir, EVALUATION_OUTPUTS_DIR, "scorecard.json"))).toBeTrue();
    expect(fs.existsSync(path.join(child.evaluationDir, "scorecard.json"))).toBeFalse();
    expect(child.childRun?.state).toBe("completed");
    expect(child.childAudit.find(entry => entry.event === "verify_passed")).toMatchObject({ files: 1 });
  }, spawnBudgetMs(1) + 30_000);

  test("judge-x as the child: a valid scorecard completes its Run under its own identity, on the lean prompt, with its cost read from the judge-x executor event", () => {
    const child = runChild("scorecard", JUDGE_X_TARGET);
    expect(child.scorecard, child.diagnostics).toMatchObject({ verdict: "pass", evaluator: JUDGE_X_TARGET, costUsd: 0.02 });
    expect(child.childRun).toMatchObject({ state: "completed", target: JUDGE_X_TARGET });
    expect(child.childAudit.find(entry => entry.event === "x_dispatch_judge_x")).toMatchObject({ runtime: "claude-code", max_budget_usd: 1.5 });
    expect(child.childAudit.find(entry => entry.event === "agent_executed")).toMatchObject({ employee: "judge-x", cost_usd: 0.02 });
    expect(child.childAudit.filter(entry => ["dispatch_agent_x", "gate_passed", "delivered"].includes(entry.event as string))).toEqual([]);
    expect(child.prompt()).toContain("# JUDGE-X DISPATCH");
    expect(child.prompt()).not.toContain("AUTONOMOUS MODE");
    expect(child.audit).toEqual([expect.objectContaining({ event: "x_gauntlet_evaluation_completed", evaluator: "agent-x:judge-x", verdict: "pass", cost_usd: 0.02, exit_code: 0 })]);
  }, spawnBudgetMs(1) + 30_000);

  test("judge-x as the child: nothing written is a withheld child Run and an indeterminate evaluation", () => {
    const child = runChild("nothing", JUDGE_X_TARGET);
    expect(child.scorecard.verdict, child.diagnostics).toBe("indeterminate");
    expect(child.scorecard.dimensions[0].evidenceRefs[0]).toMatch(/^indeterminate: scorecard\.json not found at /);
    expect(child.childRun?.state).toBe("withheld");
    expect(child.childAudit.some(entry => entry.event === "verify_failed")).toBeTrue();
    expect(child.audit[0]).not.toHaveProperty("reason_code");
  }, spawnBudgetMs(1) + 30_000);

  test("judge-x as the child: a spent cap is an indeterminate evaluation named budget_exhausted, never an anonymous error verdict", () => {
    const child = runChild("nothing", JUDGE_X_TARGET, { FAKE_EVALUATOR_SUBTYPE: "error_max_budget_usd" });
    expect(child.scorecard.verdict, child.diagnostics).toBe("indeterminate");
    expect(child.scorecard.dimensions[0].evidenceRefs[0]).toMatch(/^indeterminate: budget_exhausted: the evaluator's spend cap of USD 1\.5 ended the run before scorecard\.json was written/);
    expect(child.audit[0]).toMatchObject({ reason_code: "budget_exhausted", budget_usd: 1.5, verdict: "indeterminate" });
    expect(child.childRun?.state).toBe("withheld");
    expect(child.childAudit.find(entry => entry.event === "agent_exec_failed")).toMatchObject({ employee: "judge-x", budget_exhausted: true });
  }, spawnBudgetMs(1) + 30_000);
});
