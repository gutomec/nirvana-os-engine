// gauntlet-evaluator-adapter.test.ts — the Gauntlet evaluator backed by a real dispatch
// target: the scorecard contract, the isolated evaluation directory, the explicit command
// line, cost from the audit log, independence refused up front, timeout and abort, and the
// cutover delivering or withholding on the verdict. Hermetic: the fake dispatch of
// helpers/fake-dispatch.ts writes scorecard.json; no LLM, no network.
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SCOPE_GUARD_SENTINEL_PT_BR } from "../../_shared/lib/scope-guard.ts";
import { GAUNTLET_EVALUATION_SHARE, gauntletRoundBudget, runAgentXGauntlet, type AgentXGauntletEvaluationInput } from "../lib/gauntlet/agent-x-cutover.ts";
import { compileGauntletPlan } from "../lib/gauntlet/compiler.ts";
import { requirementsFor } from "../lib/gauntlet/success-requirements.ts";
import {
  EVALUATION_BRIEF_FILE, EVALUATION_OUTPUTS_DIR, EVALUATION_REQUEST_FILE, EVALUATION_RUBRIC_VERSION, SCORECARD_FILE, SCORECARD_SCHEMA_VERSION,
  renderEvaluationBrief, validateScorecardFile, type EvaluationRequest,
} from "../lib/gauntlet/evaluation-contract.ts";
import {
  createDispatchEvaluator, evaluationDirFor, evaluationProjectId, evaluatorSpendCapUsd, type DispatchEvaluatorTarget, type EvaluatorSpawnRequest,
} from "../lib/gauntlet/evaluator-adapter.ts";
import { JUDGE_X_BUDGET_EXHAUSTED_MARK, JUDGE_X_TARGET } from "../lib/gauntlet/judge-x.ts";
import { listScorecards } from "../lib/gauntlet/store.ts";
import type { TargetRef } from "../lib/run-kernel/types.ts";
import { listEvents, openKernel, type KernelHandle } from "../lib/run-kernel/index.ts";
import { writeFakeDispatch } from "./helpers/fake-dispatch.ts";
import { removeDir } from "./helpers/temp-dirs.ts";
import { KERNEL_BUDGET_MS, spawnBudgetMs } from "./helpers/test-budgets.ts";

const roots: string[] = [];
const handles: KernelHandle[] = [];
afterEach(() => {
  while (handles.length) handles.pop()!.close();
  for (const root of roots.splice(0)) removeDir(root);
});

const SQUAD: DispatchEvaluatorTarget = { kind: "squad", slug: "fixture-evaluator", capabilityId: "quality.specification_conformance" };
const AGENT_X: DispatchEvaluatorTarget = { kind: "agent-x", slug: "agent-x" };
const BRIEF = "Produza report.md com o resumo executivo.";
const plan = compileGauntletPlan({ brief: BRIEF, intensity: "light" });
const requirements = plan.successContract.requirements;

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nrv-gauntlet-evaluator-"))); roots.push(root);
  const projectRoot = path.join(root, "project");
  const candidateRoot = path.join(projectRoot, ".nirvana", "gauntlet", "run_1", "candidates", "can_1", "rev_1");
  fs.mkdirSync(candidateRoot, { recursive: true });
  fs.writeFileSync(path.join(candidateRoot, "report.md"), "# Relatório\n\nCandidate can_1\n", "utf8");
  const logsDir = path.join(root, "logs");
  const audit: Array<{ event: string; payload: Record<string, unknown> }> = [];
  return {
    root, projectRoot, candidateRoot, logsDir, audit,
    dispatchScriptPath: writeFakeDispatch(root), spawnLog: path.join(root, "spawns.log"),
    evaluation: (revision = 1): AgentXGauntletEvaluationInput => ({
      projectId: "prj_1", runId: "run_1", candidateId: "can_1", revision, round: revision, revisionId: `crv_run_1_can_1_${revision}`,
      candidateRoot, artifactRefs: [], holdout: false,
    }),
    capture: (revisionId: string) => JSON.parse(fs.readFileSync(path.join(evaluationDirFor(projectRoot, "run_1", revisionId), EVALUATION_OUTPUTS_DIR, "dispatch-capture.json"), "utf8")) as
      { argv: string[]; env: Record<string, string>; cwd: string; brief: string },
  };
}

type Fixture = ReturnType<typeof fixture>;

function evaluator(setup: Fixture, overrides: Partial<Parameters<typeof createDispatchEvaluator>[0]> = {}, env: Record<string, string> = {}) {
  return createDispatchEvaluator({
    target: SQUAD, producer: AGENT_X, plan, brief: BRIEF, projectRoot: setup.projectRoot, projectId: "prj_1",
    dispatchScriptPath: setup.dispatchScriptPath,
    env: { HARNESS_LOGS_DIR: setup.logsDir, FAKE_DISPATCH_SPAWN_LOG: setup.spawnLog, FAKE_DISPATCH_SCORECARD: "pass", ...env },
    audit: (event, payload) => setup.audit.push({ event, payload }), now: () => "2026-08-26T10:00:00.000Z",
    ...overrides,
  });
}

const flag = (argv: string[], name: string) => { const index = argv.indexOf(name); return index < 0 ? undefined : argv[index + 1]; };

/** A spawn that never starts a process: it writes what the evaluator "produced" and returns the given outcome. */
function fakeSpawn(write: (request: EvaluatorSpawnRequest) => void, outcome: Partial<ReturnType<NonNullable<Parameters<typeof createDispatchEvaluator>[0]["spawn"]>>> = {}) {
  const calls: EvaluatorSpawnRequest[] = [];
  const spawn = (request: EvaluatorSpawnRequest) => { calls.push(request); write(request); return { exitCode: 0, stdout: "", stderr: "", timedOut: false, ...outcome }; };
  return { calls, spawn };
}

const validFile = () => ({
  schemaVersion: SCORECARD_SCHEMA_VERSION, verdict: "pass",
  dimensions: [{ id: "brief-conformance", score: 0.95, confidence: 0.9, blocking: true, passed: true, evidenceRefs: ["report.md#L1"] }],
  revisionRequests: [], regressions: [],
});

// A real acceptance contract: three requirements, so the judge is scored on the
// contract it was given instead of the single line every Gauntlet used to share.
describe("a three-requirement contract", () => {
  const threeRequirements = requirementsFor({ intensity: "light", capability: { acceptance: [
    { id: "sources_cited", description: "Cada afirmação cita a fonte" },
    { id: "one_page", description: "O resumo cabe em uma página", blocking: false },
  ] } }).requirements;
  const threePlan = compileGauntletPlan({ brief: BRIEF, intensity: "light", requirements: threeRequirements });
  const dimension = (requirement: { id: string; blocking: boolean }) =>
    ({ id: requirement.id, score: 0.97, confidence: 0.9, blocking: requirement.blocking, passed: true, evidenceRefs: ["report.md#L1"] });
  const scorecardWith = (count: number) => ({
    schemaVersion: SCORECARD_SCHEMA_VERSION, verdict: "pass",
    dimensions: threeRequirements.slice(0, count).map(dimension), revisionRequests: [], regressions: [],
  });

  test("three requirements compile three gauntlets and the contract the judge is validated against", () => {
    expect(threePlan.gauntlets.map(item => item.id)).toEqual(["brief-conformance", "acceptance.sources_cited", "acceptance.one_page"]);
    expect(threePlan.successContract.requirements).toEqual(threeRequirements);
  });

  test("a scorecard with three dimensions is accepted; two or four are refused by name", () => {
    expect(validateScorecardFile(scorecardWith(3), threeRequirements).ok).toBeTrue();
    const short = validateScorecardFile(scorecardWith(2), threeRequirements);
    expect(short.ok).toBeFalse();
    expect((short as { reason: string }).reason).toContain("requirement 'acceptance.one_page' was not scored");
    const four = scorecardWith(3);
    four.dimensions.push({ id: "acceptance.invented", score: 1, confidence: 1, blocking: true, passed: true, evidenceRefs: [] });
    const extra = validateScorecardFile(four, threeRequirements);
    expect(extra.ok).toBeFalse();
    expect((extra as { reason: string }).reason).toContain("dimension 'acceptance.invented' is not in the success contract");
  });

  test("an evaluator writing N dimensions passes and one writing N−1 comes back indeterminate, every requirement failed", () => {
    const setup = fixture();
    let count = 3;
    const spawned = fakeSpawn((request) =>
      fs.writeFileSync(path.join(flag(request.command, "--outputs-root")!, SCORECARD_FILE), JSON.stringify(scorecardWith(count))));
    const judge = evaluator(setup, { plan: threePlan, spawn: spawned.spawn });

    const [good] = judge.evaluate(setup.evaluation(1));
    expect(good.verdict).toBe("pass");
    expect(good.dimensions.map(item => item.id)).toEqual(threeRequirements.map(item => item.id));

    count = 2;
    const [short] = judge.evaluate(setup.evaluation(2));
    expect(short.verdict).toBe("indeterminate");
    expect(short.dimensions.map(item => item.id)).toEqual(threeRequirements.map(item => item.id));
    expect(short.dimensions.every(item => !item.passed)).toBeTrue();
    expect(short.dimensions[0].evidenceRefs[0]).toContain("acceptance.one_page' was not scored");
  });
});

describe("scorecard contract", () => {
  test("accepts a scorecard that scores every requirement inside the contract", () => {
    const result = validateScorecardFile(validFile(), requirements);
    expect(result.ok).toBeTrue();
    expect(validateScorecardFile({ ...validFile(), schemaVersion: undefined }, requirements).ok).toBeTrue();
  });

  test.each([
    ["an unknown top-level key", { ...validFile(), notes: "extra" }, /does not match the schema/],
    ["a score outside [0, 1]", { ...validFile(), dimensions: [{ ...validFile().dimensions[0], score: 1.2 }] }, /does not match the schema/],
    ["no dimensions", { ...validFile(), dimensions: [] }, /does not match the schema/],
    ["a dimension outside the contract", { ...validFile(), dimensions: [{ ...validFile().dimensions[0], id: "style" }] }, /'style' is not in the success contract/],
    ["a requirement scored twice", { ...validFile(), dimensions: [validFile().dimensions[0], validFile().dimensions[0]] }, /scored twice/],
    ["blocking that contradicts the contract", { ...validFile(), dimensions: [{ ...validFile().dimensions[0], blocking: false }] }, /declares blocking=false/],
    ["a pass below the minimum score", { ...validFile(), dimensions: [{ ...validFile().dimensions[0], score: 0.2 }] }, /below the minimum 0.85/],
    ["verdict pass with a failed dimension", { ...validFile(), dimensions: [{ ...validFile().dimensions[0], passed: false }] }, /verdict 'pass' with a failed dimension/],
    ["verdict revise with every dimension passed", { ...validFile(), verdict: "revise" }, /verdict 'revise' with every dimension passed/],
    ["a revision request for an unknown requirement", { ...validFile(), verdict: "revise", dimensions: [{ ...validFile().dimensions[0], passed: false }],
      revisionRequests: [{ requirementId: "style", evidenceRefs: [] }] }, /unknown requirement 'style'/],
    ["a regression on an unknown requirement", { ...validFile(), regressions: ["style"] }, /regression on unknown requirement 'style'/],
  ])("rejects %s", (_: string, file: unknown, reason: RegExp) => {
    const result = validateScorecardFile(file, requirements);
    expect(result.ok).toBeFalse();
    if (!result.ok) expect(result.reason).toMatch(reason);
  });

  test("a requirement left unscored is not an implicit pass", () => {
    const two = [...requirements, { id: "style", description: "Tom adequado", capability: "quality.style", blocking: false, minimumScore: 0.5 }];
    const result = validateScorecardFile(validFile(), two);
    expect(result).toEqual({ ok: false, reason: "requirement 'style' was not scored" });
  });

  test("the evaluation brief carries the original brief, the contract, the read-only rule, the scorecard path and the scope guard", () => {
    const request: EvaluationRequest = { schemaVersion: "nirvana.gauntlet-evaluation-request/v1alpha1", projectId: "prj_1", runId: "run_1",
      candidateId: "can_1", revisionId: "crv_run_1_can_1_1", revision: 1, round: 1, holdout: true, candidateRoot: "/tmp/cand",
      scorecardPath: "/tmp/eval/scorecard.json", briefDigest: "d", requirements, gauntletIds: ["brief-conformance"] };
    const text = renderEvaluationBrief(request, BRIEF);
    expect(text).toContain(BRIEF);
    expect(text).toContain("| `brief-conformance` | `quality.specification_conformance` | sim | 0.85 |");
    expect(text).toContain("Você não produz nem edita o entregável.");
    expect(text).toContain("somente leitura: `/tmp/cand`");
    expect(text).toContain("`/tmp/eval/scorecard.json`");
    expect(text).toContain(SCOPE_GUARD_SENTINEL_PT_BR);
    expect(text).toContain("holdout `evaluator_only`");
    expect(text).toContain("Nunca há aprovação implícita.");
    expect(renderEvaluationBrief({ ...request, holdout: false }, BRIEF)).not.toContain("holdout");
    expect(renderEvaluationBrief(request, BRIEF)).toBe(text);
  });
});

describe("dispatch evaluator adapter", () => {
  test("runs the explicit target once per revision in an isolated evaluation directory and returns the validated scorecard with its observed cost", () => {
    const setup = fixture();
    const [scorecard] = evaluator(setup, { runtime: "codex", budgetUsd: 0.5 }, { FAKE_DISPATCH_COST_USD: "0.3" }).evaluate(setup.evaluation());
    const evaluationDir = evaluationDirFor(setup.projectRoot, "run_1", "crv_run_1_can_1_1");
    const outputsRoot = path.join(evaluationDir, EVALUATION_OUTPUTS_DIR);
    expect(scorecard).toEqual({
      evaluationId: "evl_crv_run_1_can_1_1", candidateId: "can_1", revisionId: "crv_run_1_can_1_1", gauntletId: "brief-conformance",
      rubricVersion: EVALUATION_RUBRIC_VERSION, verdict: "pass", evaluator: SQUAD, costUsd: 0.3, createdAt: "2026-08-26T10:00:00.000Z",
      dimensions: [{ id: "brief-conformance", score: 1, confidence: 1, blocking: true, passed: true, evidenceRefs: ["fake:crv_run_1_can_1_1:brief-conformance"] }],
      revisionRequests: [], regressions: [],
    });
    const captured = setup.capture("crv_run_1_can_1_1");
    expect(flag(captured.argv, "--squad")).toBe("fixture-evaluator");
    expect(captured.argv).toContain("--exec");
    expect(captured.argv).toContain("--execution-mode=standard");
    expect(captured.argv).not.toContain("--agent-x");
    expect(captured.argv).not.toContain("--auto");
    expect(flag(captured.argv, "--project")).toBe(evaluationProjectId("prj_1", "crv_run_1_can_1_1"));
    expect(flag(captured.argv, "--outputs-root")).toBe(outputsRoot);
    expect(flag(captured.argv, "--brief-file")).toBe(path.join(evaluationDir, EVALUATION_BRIEF_FILE));
    expect(flag(captured.argv, "--max-revisions")).toBe("0");
    expect(flag(captured.argv, "--max-budget")).toBe("0.5");
    expect(flag(captured.argv, "--runtime")).toBe("codex");
    expect(captured.cwd).toBe(setup.projectRoot);
    expect(captured.env.HARNESS_LOGS_DIR).toBe(setup.logsDir);
    expect(captured.brief).toContain(BRIEF);
    expect(captured.brief).toContain(`somente leitura: \`${setup.candidateRoot}\``);
    expect(captured.brief).toContain(SCOPE_GUARD_SENTINEL_PT_BR);
    const request = JSON.parse(fs.readFileSync(path.join(evaluationDir, EVALUATION_REQUEST_FILE), "utf8")) as EvaluationRequest;
    expect(request).toMatchObject({ projectId: "prj_1", runId: "run_1", candidateId: "can_1", revisionId: "crv_run_1_can_1_1", revision: 1, round: 1,
      holdout: false, candidateRoot: setup.candidateRoot, scorecardPath: path.join(outputsRoot, SCORECARD_FILE), briefDigest: plan.successContract.briefDigest,
      requirements, gauntletIds: ["brief-conformance"] });
    // The adapter's files sit beside the outputs root, never inside it: only what the executor wrote is under --outputs-root.
    expect(fs.readdirSync(evaluationDir).sort()).toEqual([EVALUATION_BRIEF_FILE, EVALUATION_REQUEST_FILE, EVALUATION_OUTPUTS_DIR].sort());
    expect(fs.readdirSync(outputsRoot).sort()).toEqual(["_SUMMARY.md", "dispatch-capture.json", SCORECARD_FILE]);
    expect(captured.brief).toContain(`\`${SCORECARD_FILE}\`, no seu output_path (caminho absoluto: \`${path.join(outputsRoot, SCORECARD_FILE)}\`)`);
    expect(captured.brief).toContain("A tarefa não exige shell nem execução de comandos");
    expect(fs.readdirSync(setup.candidateRoot)).toEqual(["report.md"]);
    expect(setup.audit).toEqual([{ event: "x_gauntlet_evaluation_completed", payload: expect.objectContaining({
      trace_id: "prj_1", run_id: "run_1", candidate_id: "can_1", revision_id: "crv_run_1_can_1_1", evaluator: "squad:fixture-evaluator:quality.specification_conformance",
      evaluation_project_id: "prj_1-evl-crv_run_1_can_1_1", verdict: "pass", cost_usd: 0.3, exit_code: 0 }) }]);
  }, spawnBudgetMs(1));

  test("a missing scorecard is indeterminate: every blocking dimension fails with the reason, never a pass", () => {
    const setup = fixture();
    const [scorecard] = evaluator(setup, {}, { FAKE_DISPATCH_SCORECARD: "missing", FAKE_DISPATCH_EXIT_CODE: "3" }).evaluate(setup.evaluation());
    expect(scorecard).toMatchObject({ verdict: "indeterminate", evaluator: SQUAD, costUsd: 0, revisionRequests: [], regressions: [],
      dimensions: [{ id: "brief-conformance", score: 0, confidence: 1, blocking: true, passed: false }] });
    expect(scorecard.dimensions[0].evidenceRefs[0]).toMatch(/^indeterminate: scorecard\.json not found at .*dispatch exit 3/);
    expect(setup.audit[0].payload).toMatchObject({ verdict: "indeterminate", exit_code: 3, reason: expect.stringContaining("not found") });
  }, spawnBudgetMs(1));

  test.each([
    ["invalid JSON", (file: string) => fs.writeFileSync(file, "{ not json", "utf8"), /is not valid JSON/],
    ["a dimension outside the contract", (file: string) => fs.writeFileSync(file, JSON.stringify({ ...validFile(), verdict: "revise",
      dimensions: [{ ...validFile().dimensions[0], id: "not-in-contract", passed: false }] }), "utf8"), /'not-in-contract' is not in the success contract/],
    ["a pass below the minimum score", (file: string) => fs.writeFileSync(file, JSON.stringify({ ...validFile(),
      dimensions: [{ ...validFile().dimensions[0], score: 0.2 }] }), "utf8"), /below the minimum/],
  ])("a scorecard with %s is indeterminate", (_: string, write: (file: string) => void, reason: RegExp) => {
    const setup = setupWithInjectedSpawn(write);
    const [scorecard] = setup.evaluate();
    expect(scorecard.verdict).toBe("indeterminate");
    expect(scorecard.dimensions.map(dimension => dimension.passed)).toEqual([false]);
    expect(scorecard.dimensions[0].evidenceRefs[0]).toMatch(reason);
    expect(setup.calls).toHaveLength(1);
  });

  test("refuses, before anything runs, an evaluator that is not independent of the producer", () => {
    const setup = fixture();
    expect(() => evaluator(setup, { target: { kind: "agent-x", slug: "agent-x" }, producer: AGENT_X })).toThrow(/agent-x:agent-x cannot evaluate candidates produced by agent-x:agent-x/);
    expect(() => evaluator(setup, { target: SQUAD, producer: SQUAD })).toThrow(/squad:fixture-evaluator:quality.specification_conformance cannot evaluate/);
    expect(() => evaluator(setup, { target: JUDGE_X_TARGET as DispatchEvaluatorTarget, producer: JUDGE_X_TARGET })).toThrow(/agent-x:judge-x cannot evaluate candidates produced by agent-x:judge-x/);
    expect(fs.existsSync(setup.spawnLog)).toBeFalse();
    expect(fs.existsSync(evaluationDirFor(setup.projectRoot, "run_1", "crv_run_1_can_1_1"))).toBeFalse();
  });

  test.each([
    ["agent-x", AGENT_X],
    ["a squad", SQUAD as TargetRef],
    ["a business", { kind: "business", slug: "acme" } as TargetRef],
  ])("judge-x is independent of %s: it runs as `dispatch.ts --judge-x` and its cost is read from the judge-x executor events", (_: string, producer: TargetRef) => {
    const setup = fixture();
    const [scorecard] = evaluator(setup, { target: JUDGE_X_TARGET as DispatchEvaluatorTarget, producer, budgetUsd: 1.5 }, { FAKE_DISPATCH_COST_USD: "0.4" }).evaluate(setup.evaluation());
    expect(scorecard).toMatchObject({ verdict: "pass", evaluator: JUDGE_X_TARGET, costUsd: 0.4 });
    const captured = setup.capture("crv_run_1_can_1_1");
    expect(captured.argv).toContain("--judge-x");
    expect(captured.argv).not.toContain("--agent-x");
    expect(captured.argv).not.toContain("--squad");
    expect(captured.argv).toContain("--execution-mode=standard");
    expect(flag(captured.argv, "--max-budget")).toBe("1.5");
    expect(setup.audit[0].payload).toMatchObject({ evaluator: "agent-x:judge-x", verdict: "pass", cost_usd: 0.4 });
  }, spawnBudgetMs(1));

  test("a judge-x child that ran out of budget before the scorecard is indeterminate as budget_exhausted, never an anonymous error", () => {
    const setup = fixture();
    const spawned = fakeSpawn(() => {}, { exitCode: 2, stderr: `⚠ judge-x withheld: ${JUDGE_X_BUDGET_EXHAUSTED_MARK}: the spend cap of USD 1.5 ended the run before scorecard.json was written` });
    const [scorecard] = evaluator(setup, { target: JUDGE_X_TARGET as DispatchEvaluatorTarget, producer: AGENT_X, spawn: spawned.spawn, budgetUsd: 1.5 }).evaluate(setup.evaluation());
    expect(scorecard.verdict).toBe("indeterminate");
    expect(scorecard.dimensions[0].evidenceRefs[0]).toMatch(/^indeterminate: budget_exhausted: the evaluator's spend cap of USD 1.5 ended the run before scorecard\.json was written/);
    expect(setup.audit[0].payload).toMatchObject({ verdict: "indeterminate", reason_code: "budget_exhausted", budget_usd: 1.5 });
    // The same stderr from a squad evaluator is not a judge-x budget signal.
    const squad = fakeSpawn(() => {}, { exitCode: 2, stderr: JUDGE_X_BUDGET_EXHAUSTED_MARK });
    const [other] = evaluator(setup, { spawn: squad.spawn }).evaluate(setup.evaluation(2));
    expect(other.dimensions[0].evidenceRefs[0]).toMatch(/^indeterminate: scorecard\.json not found/);
  });

  test("an evaluator that exceeds its timeout is killed and the evaluation is indeterminate", () => {
    const setup = fixture();
    const started = Date.now();
    const [scorecard] = evaluator(setup, { timeoutMs: 1500 }, { FAKE_DISPATCH_SLEEP_MS: "30000" }).evaluate(setup.evaluation());
    expect(Date.now() - started).toBeLessThan(25_000);
    expect(scorecard.verdict).toBe("indeterminate");
    expect(scorecard.dimensions[0].evidenceRefs[0]).toBe("indeterminate: evaluator timed out after 1500 ms");
  }, spawnBudgetMs(1) + 30_000);

  test("an aborted signal is honoured before the spawn and after it", () => {
    const setup = fixture();
    const before = new AbortController(); before.abort("cancelled");
    const spawned = fakeSpawn(() => {});
    const [early] = evaluator(setup, { signal: before.signal, spawn: spawned.spawn }).evaluate(setup.evaluation());
    expect(early.verdict).toBe("indeterminate");
    expect(early.dimensions[0].evidenceRefs[0]).toBe("indeterminate: aborted before the evaluator ran: cancelled");
    expect(spawned.calls).toHaveLength(0);
    const during = new AbortController();
    const late = fakeSpawn((request) => { fs.writeFileSync(path.join(flag(request.command, "--outputs-root")!, SCORECARD_FILE), JSON.stringify(validFile())); during.abort("stop"); });
    const [scorecard] = evaluator(setup, { signal: during.signal, spawn: late.spawn }).evaluate(setup.evaluation(2));
    expect(scorecard.verdict).toBe("indeterminate");
    expect(scorecard.dimensions[0].evidenceRefs[0]).toBe("indeterminate: aborted while the evaluator ran: stop");
  });

  test("the spend cap is the lower of the plan's slice and the capability's declared max_cost_usd", () => {
    expect(evaluatorSpendCapUsd(1.5, 0.4)).toBe(0.4);
    expect(evaluatorSpendCapUsd(0.4, 1.5)).toBe(0.4);
    expect(evaluatorSpendCapUsd(1.5, null)).toBe(1.5);
    expect(evaluatorSpendCapUsd(0, 0.9)).toBe(0.9);
    expect(evaluatorSpendCapUsd(0, null)).toBeNull();
    expect(evaluatorSpendCapUsd(undefined, 0)).toBeNull();
    const setup = fixture();
    const spawned = fakeSpawn((request) => fs.writeFileSync(path.join(flag(request.command, "--outputs-root")!, SCORECARD_FILE), JSON.stringify(validFile())));
    evaluator(setup, { spawn: spawned.spawn, budgetUsd: 1.5, maxCostUsd: 0.4 }).evaluate(setup.evaluation());
    expect(flag(spawned.calls[0].command, "--max-budget")).toBe("0.4");
  });

  test("the plan's duration is the default timeout and the budget flag is omitted when absent", () => {
    const setup = fixture();
    const spawned = fakeSpawn((request) => fs.writeFileSync(path.join(flag(request.command, "--outputs-root")!, SCORECARD_FILE), JSON.stringify(validFile())));
    const [scorecard] = evaluator(setup, { spawn: spawned.spawn, budgetUsd: 0 }).evaluate(setup.evaluation());
    expect(scorecard.verdict).toBe("pass");
    expect(spawned.calls[0].timeoutMs).toBe(plan.budget.maxDurationSeconds * 1000);
    expect(spawned.calls[0].command).not.toContain("--max-budget");
    expect(spawned.calls[0].command).not.toContain("--runtime");
    expect(spawned.calls[0].command.slice(0, 2)).toEqual(["bun", setup.dispatchScriptPath]);
    expect(fs.existsSync(path.join(evaluationDirFor(setup.projectRoot, "run_1", "crv_run_1_can_1_1"), EVALUATION_OUTPUTS_DIR, SCORECARD_FILE))).toBeTrue();
  });

  test("the outputs root handed to the child is emptied before the spawn, so a stale scorecard is never read as this evaluation's", () => {
    const setup = fixture();
    const outputsRoot = path.join(evaluationDirFor(setup.projectRoot, "run_1", "crv_run_1_can_1_1"), EVALUATION_OUTPUTS_DIR);
    fs.mkdirSync(outputsRoot, { recursive: true });
    fs.writeFileSync(path.join(outputsRoot, SCORECARD_FILE), JSON.stringify(validFile()), "utf8");
    fs.writeFileSync(path.join(outputsRoot, "_SUMMARY.md"), "# stale\n", "utf8");
    const seenAtSpawn: string[][] = [];
    const spawned = fakeSpawn((request) => { seenAtSpawn.push(fs.readdirSync(flag(request.command, "--outputs-root")!)); });
    const [scorecard] = evaluator(setup, { spawn: spawned.spawn }).evaluate(setup.evaluation());
    expect(seenAtSpawn).toEqual([[]]);
    expect(scorecard.verdict).toBe("indeterminate");
    expect(scorecard.dimensions[0].evidenceRefs[0]).toMatch(/^indeterminate: scorecard\.json not found at /);
  });

  function setupWithInjectedSpawn(write: (scorecardFile: string) => void) {
    const setup = fixture();
    const spawned = fakeSpawn((request) => write(path.join(flag(request.command, "--outputs-root")!, SCORECARD_FILE)));
    return { ...setup, calls: spawned.calls, evaluate: () => evaluator(setup, { spawn: spawned.spawn }).evaluate(setup.evaluation()) };
  }
});

describe("cutover with the dispatch evaluator", () => {
  function gauntlet(setup: Fixture, env: Record<string, string>, producer: TargetRef = AGENT_X) {
    const handle = openKernel(path.join(setup.root, "run-kernel.sqlite")); handles.push(handle);
    const outputsRoot = path.join(setup.root, "deliverables");
    const budget = gauntletRoundBudget(plan, undefined, GAUNTLET_EVALUATION_SHARE);
    let revisions = 0; let finalGates = 0;
    const result = runAgentXGauntlet({
      kernel: handle, projectId: "prj_1", runId: "run_1", traceId: "trace_1", brief: BRIEF, projectRoot: setup.projectRoot, outputsRoot,
      expectedCostUsd: budget.roundBudgetUsd, intensity: "light", producerTarget: producer,
      executeCandidate(candidateRoot) { fs.mkdirSync(candidateRoot, { recursive: true }); fs.writeFileSync(path.join(candidateRoot, "report.md"), "# Relatório\n", "utf8"); return { ok: true, sessionId: "s1" }; },
      reviseCandidate() { revisions += 1; return { ok: true, sessionId: "s2" }; },
      evaluator: evaluator(setup, { producer, budgetUsd: budget.evaluationBudgetUsd }, env),
      finalGate() { finalGates += 1; return { exitCode: 0, gateOutcome: "pass" }; },
    });
    return { result, handle, outputsRoot, budget, revisions: () => revisions, finalGates: () => finalGates,
      scorecards: () => listScorecards(handle, "prj_1", "run_1"), events: () => listEvents(handle, "prj_1") };
  }

  test("a passing scorecard from the real evaluator delivers through the final gate with the evaluation cost booked in the round", () => {
    const setup = fixture();
    const loop = gauntlet(setup, { FAKE_DISPATCH_SCORECARD: "pass", FAKE_DISPATCH_COST_USD: "0.25" });
    expect(loop.result).toMatchObject({ exitCode: 0, finalGateRan: true, run: { state: "completed" }, gauntlet: { stopReason: "success", decision: "delivered" } });
    expect(loop.scorecards()).toHaveLength(1);
    expect(loop.scorecards()[0]).toMatchObject({ evaluator: SQUAD, verdict: "pass", costUsd: 0.25, rubricVersion: EVALUATION_RUBRIC_VERSION });
    expect(loop.budget).toEqual({ candidateBudgetUsd: 2.5, evaluationBudgetUsd: 1.5, roundBudgetUsd: 4, insufficient: false });
    expect(loop.result.gauntlet.spentUsd).toBe(4);
    expect((loop.events().find(event => event.type === "gauntlet.round_started")?.payload as { costReservedUsd: number }).costReservedUsd).toBe(4);
    expect(setup.capture("crv_run_1_can_1_1").argv).toContain("--max-budget");
    expect(fs.existsSync(path.join(loop.outputsRoot, "report.md"))).toBeTrue();
  }, KERNEL_BUDGET_MS + spawnBudgetMs(1));

  test("a missing scorecard withholds the Run as evaluation_indeterminate: no revision, no final gate", () => {
    const setup = fixture();
    const loop = gauntlet(setup, { FAKE_DISPATCH_SCORECARD: "missing" });
    expect(loop.result).toMatchObject({ exitCode: 2, finalGateRan: false, run: { state: "withheld" }, gauntlet: { decision: "withheld" } });
    expect((loop.events().at(-1)?.payload as { to: string; reason: string })).toMatchObject({ to: "withheld", reason: "evaluation_indeterminate" });
    expect(loop.scorecards()[0]).toMatchObject({ verdict: "indeterminate", evaluator: SQUAD });
    expect(loop.revisions()).toBe(0);
    expect(loop.finalGates()).toBe(0);
    expect(fs.existsSync(loop.outputsRoot)).toBeFalse();
  }, KERNEL_BUDGET_MS + spawnBudgetMs(1));

  test("a rejecting scorecard withholds without the final gate and keeps the evaluator's evidence", () => {
    const setup = fixture();
    const loop = gauntlet(setup, { FAKE_DISPATCH_SCORECARD: "revise" });
    expect(loop.result).toMatchObject({ exitCode: 2, finalGateRan: false, run: { state: "withheld" } });
    expect(loop.scorecards()[0]).toMatchObject({ verdict: "revise", revisionRequests: [{ requirementId: "brief-conformance", evidenceRefs: ["fake:crv_run_1_can_1_1:brief-conformance"] }] });
    expect(loop.finalGates()).toBe(0);
  }, KERNEL_BUDGET_MS + spawnBudgetMs(2));
});
