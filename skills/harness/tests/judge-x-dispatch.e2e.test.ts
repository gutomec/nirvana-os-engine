// judge-x-dispatch.e2e.test.ts — the real scripts/dispatch.ts as the judge: `--judge-x`
// reads the evaluation request the adapter writes beside its outputs root, runs the
// judge-x persona on a fake `claude` with a lean prompt (no autonomous directive, no
// catalog), and ends its canonical Run `completed` only with a valid scorecard.json:
// `withheld` without one, with a spent cap named `budget_exhausted` on stderr; exit 4
// without a request; exit 3 without --exec. No cascade, no nested Gauntlet, no delivery
// gate over content. Hermetic: fake CLI, temporary HOME, no LLM, no network.
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { compileGauntletPlan } from "../lib/gauntlet/compiler.ts";
import { EVALUATION_BRIEF_FILE, EVALUATION_REQUEST_FILE, SCORECARD_FILE, renderEvaluationBrief, type EvaluationRequest } from "../lib/gauntlet/evaluation-contract.ts";
import { JUDGE_X_BUDGET_EXHAUSTED_MARK } from "../lib/gauntlet/judge-x.ts";
import { getRun, openKernel } from "../lib/run-kernel/index.ts";
import { canonicalRunIdFor } from "../scripts/dispatch.ts";
import { writeFakeCli } from "./helpers/fake-cli.ts";
import { makeTempRoot, removeDir } from "./helpers/temp-dirs.ts";
import { spawnBudgetMs } from "./helpers/test-budgets.ts";

const REPO = path.resolve(import.meta.dir, "..", "..", "..");
const SKILLS = path.join(REPO, "skills");
const DISPATCH = path.join(SKILLS, "harness", "scripts", "dispatch.ts");
const BRIEF = "Produza o relatório final em report.md";

// The fake judge runtime: reads the prompt from STDIN, records it, and writes what FAKE_JUDGE_WRITES says
// at the scorecard_path the prompt names: a valid scorecard, an invalid one, or nothing. FAKE_JUDGE_SUBTYPE
// makes it report claude-code's own error subtype (a spent cap is `error_max_budget_usd`).
const FAKE_JUDGE_CLAUDE = String.raw`
import * as fs from "node:fs";
import * as path from "node:path";
const prompt = await Bun.stdin.text();
const capture = process.env.FAKE_CAPTURE_DIR;
fs.writeFileSync(path.join(capture, "judge-prompt.md"), prompt, "utf8");
fs.writeFileSync(path.join(capture, "judge-args.json"), JSON.stringify(Bun.argv.slice(2)), "utf8");
const scorecardPath = /^- scorecard_path: (.+)$/m.exec(prompt)?.[1]?.trim() ?? "";
const writes = process.env.FAKE_JUDGE_WRITES ?? "scorecard";
if (writes === "scorecard" || writes === "invalid") {
  fs.mkdirSync(path.dirname(scorecardPath), { recursive: true });
  fs.writeFileSync(scorecardPath, writes === "invalid" ? "{ not json" : JSON.stringify({ schemaVersion: "nirvana.gauntlet-scorecard/v1alpha1", verdict: "revise",
    dimensions: [{ id: "brief-conformance", score: 0.4, confidence: 0.9, blocking: true, passed: false, evidenceRefs: ["report.md#L1: falta o resumo"] }],
    revisionRequests: [{ requirementId: "brief-conformance", evidenceRefs: ["report.md: sem resumo executivo"] }], regressions: [] }, null, 2), "utf8");
}
const subtype = process.env.FAKE_JUDGE_SUBTYPE ?? "success";
console.log(JSON.stringify({ type: "result", subtype, is_error: subtype !== "success", result: "judged", session_id: "sess-judge", total_cost_usd: 0.31 }));
`;

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) removeDir(root); });

function fixture() {
  const root = makeTempRoot("nrv-judge-x-e2e-"); roots.push(root);
  const home = path.join(root, "home");
  const projectRoot = path.join(root, "project");
  const bin = path.join(root, "bin");
  const capture = path.join(root, "capture");
  fs.mkdirSync(path.join(projectRoot, ".nirvana"), { recursive: true });
  fs.mkdirSync(capture, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  writeFakeCli(bin, "claude", FAKE_JUDGE_CLAUDE);
  // What the evaluator adapter leaves for its child: the request and the brief beside an empty outputs root.
  const candidateRoot = path.join(projectRoot, ".nirvana", "gauntlet", "run_parent", "candidates", "can_1", "rev_1");
  fs.mkdirSync(candidateRoot, { recursive: true });
  fs.writeFileSync(path.join(candidateRoot, "report.md"), "# Relatório\n", "utf8");
  const evaluationDir = path.join(projectRoot, ".nirvana", "gauntlet", "run_parent", "evaluations", "crv_run_parent_can_1_1");
  const outputsRoot = path.join(evaluationDir, "outputs");
  fs.mkdirSync(outputsRoot, { recursive: true });
  const plan = compileGauntletPlan({ brief: BRIEF, intensity: "light" });
  const request: EvaluationRequest = {
    schemaVersion: "nirvana.gauntlet-evaluation-request/v1alpha1", projectId: "parent", runId: "run_parent", candidateId: "can_1", revisionId: "crv_run_parent_can_1_1",
    revision: 1, round: 1, holdout: false, candidateRoot, scorecardPath: path.join(outputsRoot, SCORECARD_FILE), briefDigest: plan.successContract.briefDigest,
    requirements: plan.successContract.requirements, gauntletIds: ["brief-conformance"],
  };
  fs.writeFileSync(path.join(evaluationDir, EVALUATION_REQUEST_FILE), JSON.stringify(request, null, 2), "utf8");
  const briefFile = path.join(evaluationDir, EVALUATION_BRIEF_FILE);
  fs.writeFileSync(briefFile, renderEvaluationBrief(request, BRIEF), "utf8");
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || /^(NIRVANA_|HARNESS_|FAKE_|NRV_|LLM_CASCADE|SQUADS_DIR|SQUADS_REGISTRY_PATH|BUSINESSES_DIR)/.test(key)) continue;
    env[key] = value;
  }
  Object.assign(env, {
    HOME: home, NIRVANA_HOME: home, SQUADS_DIR: path.join(home, "squads"), SQUADS_REGISTRY_PATH: path.join(home, ".squads-registry.json"), NIRVANA_SKILLS_DIR: SKILLS,
    NIRVANA_PROJECT_ROOT: projectRoot, NIRVANA_HOST_RUNTIME: "claude-code", NIRVANA_RUN_LEDGER_DB: path.join(root, "ledger.sqlite"),
    NIRVANA_STATE_DB: path.join(root, "state.db"), HARNESS_LOGS_DIR: path.join(root, "logs"), NIRVANA_NO_UPDATE_CHECK: "1",
    NIRVANA_SCOPE_QUIET: "1", NRV_PREFLIGHT: "0", FAKE_CAPTURE_DIR: capture, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
  });
  const projectId = "parent-evl-crv_run_parent_can_1_1";
  const dispatch = (extra: Record<string, string> = {}, argv = ["--exec", "--max-budget", "1.5"]) =>
    spawnSync(process.execPath, [DISPATCH, "--judge-x", "--brief-file", briefFile, "--project", projectId, "--outputs-root", outputsRoot,
      "--execution-mode=standard", "--max-revisions", "0", ...argv], { cwd: projectRoot, encoding: "utf8", env: { ...env, ...extra } });
  const audit = () => {
    const dir = path.join(root, "logs");
    if (!fs.existsSync(dir)) return [] as Array<Record<string, unknown>>;
    return fs.readdirSync(dir).sort().flatMap(day => {
      const file = path.join(dir, day, "audit.jsonl");
      return fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>) : [];
    });
  };
  const run = () => {
    const kernel = openKernel(path.join(projectRoot, "outputs", projectId, ".nirvana", "run-kernel.sqlite"));
    try { return getRun(kernel, projectId, canonicalRunIdFor(projectId)); } finally { kernel.close(); }
  };
  const judgePrompt = () => fs.readFileSync(path.join(capture, "judge-prompt.md"), "utf8");
  const judgeArgs = () => JSON.parse(fs.readFileSync(path.join(capture, "judge-args.json"), "utf8")) as string[];
  return { root, projectRoot, evaluationDir, outputsRoot, candidateRoot, request, briefFile, projectId, dispatch, audit, run, judgePrompt, judgeArgs, capture };
}

describe("dispatch.ts --judge-x", () => {
  test("with a valid scorecard the canonical Run is completed and the judge ran on a lean prompt with the candidate root granted", () => {
    const fx = fixture();
    const result = fx.dispatch();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(fs.existsSync(path.join(fx.outputsRoot, SCORECARD_FILE))).toBeTrue();
    expect(fx.run()).toMatchObject({ state: "completed", target: { kind: "agent-x", slug: "judge-x" } });
    const prompt = fx.judgePrompt();
    expect(prompt).toContain("# Judge-X — Claude Code independent judge");
    expect(prompt).toContain("# JUDGE-X DISPATCH");
    expect(prompt).toContain(BRIEF);
    expect(prompt).toContain(`- scorecard_path: ${fx.request.scorecardPath}`);
    for (const absent of ["AUTONOMOUS MODE", "FUNDAMENTAL PREMISE", "AVAILABLE SQUADS", "# Agent-X"]) expect(prompt).not.toContain(absent);
    const args = fx.judgeArgs();
    expect(args).not.toContain("--append-system-prompt");
    expect(args[args.indexOf("--max-budget-usd") + 1]).toBe("1.5");
    // The judge's cwd is the PROJECT; its scaffold, its outputs root and the candidate it
    // reads are the three granted directories.
    const addDirs = args.filter((_, index) => args[index - 1] === "--add-dir");
    expect(addDirs).toEqual([path.join(fx.projectRoot, "outputs", fx.projectId, "judge-x"), fx.outputsRoot, fx.candidateRoot]);
    // The candidate was only read; the outputs root holds the scorecard alone.
    expect(fs.readdirSync(fx.candidateRoot)).toEqual(["report.md"]);
    expect(fs.readdirSync(fx.outputsRoot)).toEqual([SCORECARD_FILE]);
    const audit = fx.audit();
    expect(audit.find(entry => entry.event === "x_dispatch_judge_x")).toMatchObject({ trace_id: fx.projectId, runtime: "claude-code", max_budget_usd: 1.5 });
    expect(audit.find(entry => entry.event === "agent_executed")).toMatchObject({ employee: "judge-x", mode: "judge-x", cost_usd: 0.31 });
    expect(audit.find(entry => entry.event === "verify_passed")).toMatchObject({ files: 1, verdict: "revise" });
    for (const event of ["dispatch_agent_x", "gate_passed", "delivered", "x_gauntlet_evaluator_selected"]) expect(audit.some(entry => entry.event === event), event).toBe(false);
  }, spawnBudgetMs(2) + 30_000);

  test.each([
    ["nothing", { FAKE_JUDGE_WRITES: "nothing" }, /scorecard\.json not found/],
    ["an invalid scorecard", { FAKE_JUDGE_WRITES: "invalid" }, /is not valid JSON/],
  ])("a judge that writes %s leaves the Run withheld: exit 2, verify_failed, no delivery", (_: string, env: Record<string, string>, reason: RegExp) => {
    const fx = fixture();
    const result = fx.dispatch(env);
    expect(result.status, result.stdout + result.stderr).toBe(2);
    expect(result.stderr).toMatch(reason);
    expect(result.stderr).not.toContain(JUDGE_X_BUDGET_EXHAUSTED_MARK);
    expect(fx.run()?.state).toBe("withheld");
    const audit = fx.audit();
    expect(audit.find(entry => entry.event === "verify_failed")?.reason).toMatch(reason);
    expect(audit.some(entry => entry.event === "delivered")).toBeFalse();
  }, spawnBudgetMs(2) + 30_000);

  test("a spent cap is named budget_exhausted on stderr and in the audit, and the Run is withheld", () => {
    const fx = fixture();
    const result = fx.dispatch({ FAKE_JUDGE_WRITES: "nothing", FAKE_JUDGE_SUBTYPE: "error_max_budget_usd" });
    expect(result.status, result.stdout + result.stderr).toBe(2);
    expect(result.stderr).toContain(`${JUDGE_X_BUDGET_EXHAUSTED_MARK}: the spend cap of USD 1.5 ended the run before ${SCORECARD_FILE} was written`);
    expect(fx.run()?.state).toBe("withheld");
    const audit = fx.audit();
    expect(audit.find(entry => entry.event === "agent_executed")).toMatchObject({ employee: "judge-x", budget_exhausted: true });
    expect(audit.find(entry => entry.event === "agent_exec_failed")).toMatchObject({ employee: "judge-x", budget_exhausted: true, max_budget_usd: 1.5 });
  }, spawnBudgetMs(2) + 30_000);

  test("without the evaluation request beside the outputs root the judge refuses with exit 4: it takes no free-form brief", () => {
    const fx = fixture();
    fs.rmSync(path.join(fx.evaluationDir, EVALUATION_REQUEST_FILE));
    const result = fx.dispatch();
    expect(result.status).toBe(4);
    expect(result.stderr).toContain(`judge-x needs ${EVALUATION_REQUEST_FILE} beside its outputs root`);
    expect(fs.existsSync(path.join(fx.capture, "judge-prompt.md"))).toBeFalse();
  }, spawnBudgetMs(1) + 30_000);

  test("without --exec nothing is judged: exit 3", () => {
    const fx = fixture();
    const result = fx.dispatch({}, []);
    expect(result.status).toBe(3);
    expect(result.stdout).toContain("judge-x runs only with --exec");
    expect(fs.existsSync(path.join(fx.capture, "judge-prompt.md"))).toBeFalse();
  }, spawnBudgetMs(1) + 30_000);
});
