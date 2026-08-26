import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runBusinessPostGate, type BusinessPostGateDependencies } from "../lib/business-post-gate.ts";
import { runDelivery } from "../lib/delivery-pipeline.ts";
import {
  AgentXGauntletInterruption, revisionDefectsSection, runAgentXGauntlet, shouldRunAgentXGauntlet, shouldRunSquadGauntlet,
  type AgentXGauntletEvaluator, type AgentXGauntletInput, type AgentXRevisionRequest,
} from "../lib/gauntlet/agent-x-cutover.ts";
import { decideBusinessCanary } from "../lib/gauntlet/business-canary.ts";
import { compileGauntletPlan } from "../lib/gauntlet/compiler.ts";
import { createDispatchEvaluator, evaluationDirFor } from "../lib/gauntlet/evaluator-adapter.ts";
import { parseExecutionOptions } from "../lib/gauntlet/execution-options.ts";
import { getGauntlet, listCandidateRevisions, listScorecards } from "../lib/gauntlet/store.ts";
import type { GauntletIntensity } from "../lib/gauntlet/types.ts";
import { loadHarnessConfig } from "../lib/harness-config.ts";
import { getRun, listEvents, openKernel, type KernelHandle, type TargetRef } from "../lib/run-kernel/index.ts";
import { SCOPE_GUARD_PT_BR } from "../../_shared/lib/scope-guard.ts";
import { writeFakeDispatch } from "./helpers/fake-dispatch.ts";
import { KERNEL_BUDGET_MS, spawnBudgetMs } from "./helpers/test-budgets.ts";

const roots: string[] = [];
const handles: KernelHandle[] = [];
afterEach(() => {
  while (handles.length) handles.pop()!.close();
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

const EVALUATOR = { kind: "squad" as const, slug: "independent-evaluator", capabilityId: "quality.specification_conformance" };
const FAIL = { brief: { score: 0.5, passed: false } };
const PASS = { brief: { score: 1, passed: true } };
const PASSING_HTML = "<!doctype html><html><head><title>Proof</title></head><body><main><h1>Business proof</h1><p>Deterministic local candidate with enough structured content for the offline quality gate.</p><p>The evaluator, delivery and publication stages preserve causal evidence in the canonical journal.</p><p>{{marker}}</p></main></body></html>";

type Grade = Record<string, { score: number; passed: boolean }>;

interface Scenario {
  intensity?: GauntletIntensity;
  producerTarget?: TargetRef;
  brief?: string;
  grade(candidateId: string, revision: number): Grade;
  write?(candidateRoot: string, marker: string): void;
  reviseCandidate?: false;
  hooks?: Pick<AgentXGauntletInput, "afterCandidatePersisted" | "afterRevisionRequested">;
}

function writeReport(candidateRoot: string, marker: string): void {
  fs.mkdirSync(candidateRoot, { recursive: true });
  fs.writeFileSync(path.join(candidateRoot, "report.md"), `# Relatório\n\n${marker}\n`, "utf8");
}

/** Hermetic loop: deterministic producers write markers, the evaluator grades by (candidate, revision). */
function scenario(options: Scenario) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-gauntlet-revision-")); roots.push(root);
  const handle = openKernel(path.join(root, ".nirvana", "run-kernel.sqlite")); handles.push(handle);
  const outputsRoot = path.join(root, "deliverables");
  const calls = { executions: 0, revisions: [] as AgentXRevisionRequest[], finalGates: 0, holdouts: [] as boolean[] };
  const write = options.write ?? writeReport;
  const evaluator: AgentXGauntletEvaluator = {
    target: EVALUATOR,
    evaluate({ candidateId, revision, revisionId, artifactRefs, holdout }) {
      calls.holdouts.push(holdout);
      const entries = Object.entries(options.grade(candidateId, revision));
      return [{ evaluationId: `evl_${revisionId}`, candidateId, revisionId, gauntletId: "brief-conformance", rubricVersion: "loop/v1",
        verdict: entries.every(([, dimension]) => dimension.passed) ? "pass" : "revise",
        dimensions: entries.map(([id, dimension]) => ({ id, score: dimension.score, confidence: 1, blocking: id === "brief",
          passed: dimension.passed, evidenceRefs: artifactRefs.map(ref => ref.revisionId) })),
        regressions: [], revisionRequests: entries.filter(([, dimension]) => !dimension.passed)
          .map(([id]) => ({ requirementId: id, evidenceRefs: [`loop:${revisionId}:${id}`] })),
        evaluator: EVALUATOR, costUsd: 0, createdAt: "2026-08-25T12:00:02.000Z" }];
    },
  };
  const input: AgentXGauntletInput = {
    kernel: handle, projectId: "prj_loop", runId: "run_loop", traceId: "trace_loop", brief: options.brief ?? "Produza report.md",
    projectRoot: root, outputsRoot, expectedCostUsd: 1, intensity: options.intensity, producerTarget: options.producerTarget,
    executeCandidate(candidateRoot, context) {
      calls.executions += 1; write(candidateRoot, `Candidate ${context.candidateId}`);
      return { ok: true, sessionId: `session_${context.candidateId}` };
    },
    ...(options.reviseCandidate === false ? {} : {
      reviseCandidate(request: AgentXRevisionRequest) {
        calls.revisions.push(request); write(request.candidateRoot, `Revision ${request.revision} of ${request.candidateId}`);
        return { ok: true, sessionId: `session_${request.candidateId}_${request.revision}` };
      },
    }),
    evaluator,
    finalGate() { calls.finalGates += 1; return { exitCode: 0, gateOutcome: "pass" }; },
    ...options.hooks,
  };
  return { root, handle, outputsRoot, input, calls, run: () => runAgentXGauntlet(input),
    events: () => listEvents(handle, "prj_loop"), revisions: () => listCandidateRevisions(handle, "prj_loop", "run_loop"),
    scorecards: () => listScorecards(handle, "prj_loop", "run_loop"), gauntlet: () => getGauntlet(handle, "prj_loop", "run_loop") };
}

function publicationDependencies(root: string, outputsRoot: string): Partial<BusinessPostGateDependencies> {
  return {
    homeDir: () => path.join(root, "home"), resolve: () => path.join(root, "proof.zip"),
    exists: pathname => pathname.endsWith("build-report-pdf.ts") || fs.existsSync(pathname),
    runPublisher: () => ({ ok: true, sessionId: null, durationMs: 0, costUsd: 0 }),
    spawn: (_command, args) => {
      if (args.some(argument => argument.endsWith("build-report-pdf.ts"))) fs.writeFileSync(path.join(outputsRoot, "relatorio-final.pdf"), "pdf", "utf8");
      else if (args.some(argument => argument.endsWith("build-report-html.ts"))) fs.writeFileSync(path.join(outputsRoot, "relatorio-final.html"), "html", "utf8");
      else if (args.some(argument => argument.endsWith("export.ts"))) fs.writeFileSync(path.join(root, "proof.zip"), "zip", "utf8");
      return { status: 0, stdout: "", stderr: "" };
    },
  };
}

describe("Gauntlet causal revision loop", () => {
  test("revises the candidate from its evaluated defects and reaches the final gate", () => {
    const loop = scenario({ grade: (_, revision) => revision === 1 ? FAIL : PASS });
    const result = loop.run();
    expect(result).toMatchObject({ exitCode: 0, finalGateRan: true, sessionId: "session_can_1_2",
      run: { state: "completed" }, gauntlet: { stopReason: "success", decision: "delivered", selectedRevisionId: "crv_run_loop_can_1_2", round: 2 } });
    expect(loop.calls).toMatchObject({ executions: 1, finalGates: 1, holdouts: [false, false] });
    expect(loop.calls.revisions).toHaveLength(1);
    const request = loop.calls.revisions[0];
    expect(request).toMatchObject({ candidateId: "can_1", revision: 2, round: 2, previousRevisionId: "crv_run_loop_can_1_1",
      defects: { failedDimensions: ["brief"], evaluationIds: ["evl_crv_run_loop_can_1_1"],
        revisionRequests: [{ requirementId: "brief", evidenceRefs: ["loop:crv_run_loop_can_1_1:brief"] }] } });
    expect(fs.readFileSync(path.join(request.previousRoot, "report.md"), "utf8")).toContain("Candidate can_1");
    const section = revisionDefectsSection(request);
    expect(section).toContain("## Defeitos a corrigir");
    expect(section).toContain(SCOPE_GUARD_PT_BR);
    expect(section).toContain(request.previousRoot); expect(section).toContain(request.candidateRoot);
    expect(section).toContain("evl_crv_run_loop_can_1_1"); expect(section).toContain("- brief: loop:crv_run_loop_can_1_1:brief");
    const revisions = loop.revisions();
    expect(revisions).toHaveLength(2);
    expect(revisions[1]).toMatchObject({ candidateId: "can_1", revision: 2, parentRevisionId: revisions[0].revisionId,
      causalEvaluationIds: ["evl_crv_run_loop_can_1_1"] });
    expect(revisions[1].hypothesis).toContain("brief");
    expect(fs.readFileSync(path.join(loop.outputsRoot, "report.md"), "utf8")).toContain("Revision 2 of can_1");
    const types = loop.events().map(event => event.type).filter(type => type.startsWith("gauntlet."));
    expect(types.slice(types.indexOf("gauntlet.candidate_created"))).toEqual([
      "gauntlet.candidate_created", "gauntlet.evaluation_recorded", "gauntlet.round_evaluated", "gauntlet.revision_requested",
      "gauntlet.regression_started", "gauntlet.round_started", "gauntlet.candidate_revised", "gauntlet.evaluation_recorded",
      "gauntlet.round_evaluated", "gauntlet.stopped",
    ]);
    expect((loop.events().find(event => event.type === "gauntlet.stopped")?.payload as any).reason).toBe("success");
  });

  test("withholds a revision that regresses a passed blocking dimension without running the final gate", () => {
    const loop = scenario({ grade: (_, revision) => revision === 1
      ? { brief: { score: 1, passed: true }, style: { score: 0, passed: false } }
      : { brief: { score: 0.4, passed: false }, style: { score: 1, passed: true } } });
    const result = loop.run();
    expect(result).toMatchObject({ exitCode: 2, finalGateRan: false, run: { state: "withheld" },
      gauntlet: { stopReason: "critical_regression", decision: "withheld", reservations: ["brief"] } });
    expect(loop.calls.revisions[0].defects.failedDimensions).toEqual(["style"]);
    expect(loop.calls.finalGates).toBe(0);
    expect((loop.events().at(-1)?.payload as any)).toMatchObject({ to: "withheld", reason: "critical_regression" });
  });

  test("stops finitely at max_rounds and no_progress; invoked again on the ended Run it is refused and repeats nothing", () => {
    const maxRounds = scenario({ grade: (_, revision) => ({ brief: { score: revision === 1 ? 0.5 : 0.6, passed: false } }) });
    expect(maxRounds.run()).toMatchObject({ exitCode: 2, finalGateRan: false, run: { state: "withheld" }, gauntlet: { stopReason: "max_rounds", round: 2 } });
    expect(maxRounds.calls).toMatchObject({ executions: 1, finalGates: 0 });
    expect(maxRounds.calls.revisions).toHaveLength(1);
    // The Run ended: a second invocation under its id is refused before any producer, and nothing is replayed.
    const journaled = maxRounds.events().length;
    expect(() => maxRounds.run()).toThrow("run 'run_loop' is already terminal (withheld); pass a fresh --run-id");
    expect(getRun(maxRounds.handle, "prj_loop", "run_loop")?.state).toBe("withheld");
    expect(maxRounds.events()).toHaveLength(journaled);
    expect(maxRounds.calls.executions).toBe(1); expect(maxRounds.calls.revisions).toHaveLength(1);
    expect(maxRounds.scorecards()).toHaveLength(2);

    const noProgress = scenario({ grade: () => FAIL });
    expect(noProgress.run()).toMatchObject({ exitCode: 2, run: { state: "withheld" }, gauntlet: { stopReason: "no_progress", round: 2 } });
    expect(noProgress.calls.revisions).toHaveLength(1);
    expect(noProgress.calls.finalGates).toBe(0);
  });

  test("balanced produces three isolated candidates, evaluates all and publishes only the selected one", () => {
    const loop = scenario({ intensity: "balanced", grade: candidateId => ({ brief: { score: candidateId === "can_2" ? 1 : 0.95, passed: true } }) });
    const result = loop.run();
    expect(result).toMatchObject({ exitCode: 0, sessionId: "session_can_2", run: { state: "completed" },
      gauntlet: { stopReason: "success", selectedRevisionId: "crv_run_loop_can_2_1", round: 1 } });
    expect(loop.calls).toMatchObject({ executions: 3, finalGates: 1, holdouts: [true, true, true] });
    expect(loop.calls.revisions).toHaveLength(0);
    expect(loop.revisions().map(revision => revision.candidateId)).toEqual(["can_1", "can_2", "can_3"]);
    expect(loop.scorecards()).toHaveLength(3);
    expect(loop.events().filter(event => event.type === "gauntlet.candidate_created")).toHaveLength(3);
    for (const candidateId of ["can_1", "can_2", "can_3"]) {
      expect(fs.readFileSync(path.join(loop.root, ".nirvana", "gauntlet", "run_loop", "candidates", candidateId, "rev_1", "report.md"), "utf8")).toContain(`Candidate ${candidateId}`);
    }
    expect(fs.readdirSync(loop.outputsRoot)).toEqual(["report.md"]);
    expect(fs.readFileSync(path.join(loop.outputsRoot, "report.md"), "utf8")).toContain("Candidate can_2");
  });

  test("exhaustive produces five isolated candidates and selects through the controller", () => {
    const loop = scenario({ intensity: "exhaustive", grade: () => PASS });
    const result = loop.run();
    expect(result).toMatchObject({ run: { state: "completed" }, gauntlet: { stopReason: "success", selectedRevisionId: "crv_run_loop_can_1_1" } });
    expect(loop.calls.executions).toBe(5);
    expect(loop.scorecards()).toHaveLength(5);
    expect(loop.revisions().map(revision => revision.candidateId)).toEqual(["can_1", "can_2", "can_3", "can_4", "can_5"]);
    expect(fs.readFileSync(path.join(loop.outputsRoot, "report.md"), "utf8")).toContain("Candidate can_1");
  });

  test("carries a defect-free sibling forward while the failing sibling is revised", () => {
    const loop = scenario({ intensity: "balanced", grade: (candidateId, revision) => ({ brief: { score: candidateId === "can_1" || revision > 1 ? 0.95 : 0.5, passed: candidateId === "can_1" || revision > 1 },
      style: { score: candidateId === "can_1" && revision === 1 ? 0.7 : 1, passed: true } }) });
    const result = loop.run();
    expect(result).toMatchObject({ run: { state: "completed" }, gauntlet: { stopReason: "success", round: 2 } });
    expect(loop.calls.revisions.map(request => request.candidateId)).toEqual(["can_2", "can_3"]);
    const carried = loop.revisions().find(revision => revision.candidateId === "can_1" && revision.revision === 2);
    expect(carried).toMatchObject({ parentRevisionId: "crv_run_loop_can_1_1", causalEvaluationIds: ["evl_crv_run_loop_can_1_1"] });
    expect(carried?.hypothesis).toContain("Carry can_1 forward");
    expect(fs.readFileSync(path.join(loop.root, ".nirvana", "gauntlet", "run_loop", "candidates", "can_1", "rev_2", "report.md"), "utf8")).toContain("Candidate can_1");
  });

  test("resumes after a crash before the revision by calling reviseCandidate exactly once", () => {
    const loop = scenario({ grade: (_, revision) => revision === 1 ? FAIL : PASS,
      hooks: { afterRevisionRequested() { throw new AgentXGauntletInterruption("crash"); } } });
    expect(() => loop.run()).toThrow("crash");
    expect(getRun(loop.handle, "prj_loop", "run_loop")?.state).toBe("running");
    expect(loop.gauntlet()).toMatchObject({ state: "revising", round: 1 });
    expect(loop.calls.revisions).toHaveLength(0);
    loop.input.afterRevisionRequested = undefined;
    expect(loop.run().run.state).toBe("completed");
    expect(loop.calls).toMatchObject({ executions: 1, finalGates: 1 });
    expect(loop.calls.revisions).toHaveLength(1);
    expect(loop.events().filter(event => event.type === "gauntlet.candidate_revised")).toHaveLength(1);
  });

  test("resumes after a crash before the re-evaluation without producing the revision again", () => {
    const loop = scenario({ grade: (_, revision) => revision === 1 ? FAIL : PASS,
      hooks: { afterCandidatePersisted(candidate) { if (candidate.revision === 2) throw new AgentXGauntletInterruption("crash"); } } });
    expect(() => loop.run()).toThrow("crash");
    expect(loop.gauntlet()).toMatchObject({ state: "producing", round: 2 });
    expect(loop.calls.revisions).toHaveLength(1);
    expect(loop.scorecards()).toHaveLength(1);
    loop.input.afterCandidatePersisted = undefined;
    expect(loop.run().run.state).toBe("completed");
    expect(loop.calls).toMatchObject({ executions: 1, finalGates: 1 });
    expect(loop.calls.revisions).toHaveLength(1);
    expect(loop.scorecards()).toHaveLength(2);
  });

  test("withholds a revising Gauntlet as revision_unavailable when no reviseCandidate is provided", () => {
    const loop = scenario({ grade: () => FAIL, reviseCandidate: false });
    const result = loop.run();
    expect(result).toMatchObject({ exitCode: 2, finalGateRan: false, run: { state: "withheld" },
      gauntlet: { state: "stopped", stopReason: "execution_failure", reservations: ["revision_unavailable"] } });
    expect((loop.events().at(-1)?.payload as any)).toMatchObject({ to: "withheld", reason: "revision_unavailable" });
    expect(loop.calls).toMatchObject({ executions: 1, finalGates: 0 });
  });

  test.each([
    ["agent-x", undefined],
    ["squad", { kind: "squad" as const, slug: "document-factory", capabilityId: "document.generate" }],
  ])("a typed %s producer crosses the revision loop to completed", (_, producerTarget) => {
    const loop = scenario({ producerTarget, grade: (_, revision) => revision === 1 ? FAIL : PASS });
    const result = loop.run();
    expect(result.run).toMatchObject({ state: "completed", target: producerTarget ?? { kind: "agent-x", slug: "agent-x" } });
    expect(loop.calls.revisions).toHaveLength(1);
    const revised = loop.events().find(event => event.type === "gauntlet.candidate_revised");
    expect((revised?.payload as any).producer).toEqual(producerTarget ?? { kind: "agent-x", slug: "agent-x" });
  });

  test("a typed Business crosses the revision loop, the real offline gate and the post-gate", () => {
    const business = { kind: "business" as const, slug: "proof-business" };
    let postGateCalls = 0;
    const loop = scenario({ producerTarget: business, brief: "Produza report.html", grade: (_, revision) => revision === 1 ? FAIL : PASS,
      write(candidateRoot, marker) {
        fs.mkdirSync(candidateRoot, { recursive: true });
        fs.writeFileSync(path.join(candidateRoot, "report.html"), PASSING_HTML.replace("{{marker}}", marker), "utf8");
      } });
    loop.input.finalGate = () => {
      const sessionFile = path.join(loop.root, "session.json");
      const sessionData: Record<string, unknown> = { project_id: "prj_loop", runtime: "codex", zip_path: null };
      fs.writeFileSync(sessionFile, JSON.stringify(sessionData, null, 2), "utf8");
      const delivery = runDelivery({ brief: "Produza report.html", outputsRoot: loop.outputsRoot, pid: "prj_loop", slug: business.slug,
        targetKind: "business", runtime: "codex", projectDir: loop.root, projectRoot: loop.root, maxRevisions: 0,
        config: loadHarnessConfig(path.join(loop.root, "missing-config.yaml")), audit: () => {}, log: () => {}, warn: () => {},
        afterGate: () => { postGateCalls += 1; return runBusinessPostGate({ projectId: "prj_loop", businessSlug: business.slug,
          runtime: "codex", projectDir: loop.root, projectRoot: loop.root, outputsRoot: loop.outputsRoot, skillsRoot: "/skills",
          employeePromptScript: "/skills/employee-prompt.ts", sessionFile, sessionData, rulesDirective: "", yolo: true,
          wantPdf: true, skipHtml: false, offlineSnapshot: false, routingMode: "agentic", wantZip: true,
          emit: () => {}, log: () => {}, warn: () => {}, dependencies: publicationDependencies(loop.root, loop.outputsRoot) }); },
      });
      return { exitCode: delivery.exitCode, gateOutcome: delivery.gateOutcome };
    };
    const result = loop.run();
    expect(result.run).toMatchObject({ state: "completed", target: business });
    expect(result.gauntlet).toMatchObject({ stopReason: "success", selectedRevisionId: "crv_run_loop_can_1_2" });
    expect(postGateCalls).toBe(1);
    expect(loop.calls.revisions).toHaveLength(1);
    expect(fs.readFileSync(path.join(loop.outputsRoot, "report.html"), "utf8")).toContain("Revision 2 of can_1");
    expect(fs.existsSync(path.join(loop.outputsRoot, "relatorio-final.pdf"))).toBeTrue();
  });

  test("the dispatch evaluator drives the causal revision from the scorecard's revisionRequests and reaches the final gate", () => {
    const loop = scenario({ grade: () => PASS });
    loop.input.evaluator = createDispatchEvaluator({
      target: EVALUATOR, producer: { kind: "agent-x", slug: "agent-x" }, plan: compileGauntletPlan({ brief: "Produza report.md", intensity: "light" }),
      brief: "Produza report.md", projectRoot: loop.root, projectId: "prj_loop", dispatchScriptPath: writeFakeDispatch(path.join(loop.root, "fake")),
      env: { HARNESS_LOGS_DIR: path.join(loop.root, "logs"), FAKE_DISPATCH_SCORECARD_FOR: "1=revise,2=pass", FAKE_DISPATCH_COST_USD: "0.1" },
    });
    const result = loop.run();
    expect(result).toMatchObject({ exitCode: 0, finalGateRan: true, run: { state: "completed" },
      gauntlet: { stopReason: "success", decision: "delivered", selectedRevisionId: "crv_run_loop_can_1_2", round: 2 } });
    expect(loop.calls.revisions).toHaveLength(1);
    const request = loop.calls.revisions[0];
    expect(request.defects).toEqual({ failedDimensions: ["brief-conformance"], evaluationIds: ["evl_crv_run_loop_can_1_1"],
      revisionRequests: [{ requirementId: "brief-conformance", evidenceRefs: ["fake:crv_run_loop_can_1_1:brief-conformance"] }] });
    expect(revisionDefectsSection(request)).toContain("- brief-conformance: fake:crv_run_loop_can_1_1:brief-conformance");
    const scorecards = loop.scorecards();
    expect(scorecards.map(scorecard => [scorecard.verdict, scorecard.costUsd, scorecard.evaluator.slug])).toEqual([["revise", 0.1, "independent-evaluator"], ["pass", 0.1, "independent-evaluator"]]);
    expect(loop.revisions()[1]).toMatchObject({ parentRevisionId: "crv_run_loop_can_1_1", causalEvaluationIds: ["evl_crv_run_loop_can_1_1"] });
    for (const revisionId of ["crv_run_loop_can_1_1", "crv_run_loop_can_1_2"]) {
      const evaluationDir = evaluationDirFor(loop.root, "run_loop", revisionId);
      expect(fs.readFileSync(path.join(evaluationDir, "evaluation-brief.md"), "utf8")).toContain("Produza report.md");
      expect(fs.existsSync(path.join(evaluationDir, "outputs", "scorecard.json"))).toBeTrue();
    }
    expect(fs.readFileSync(path.join(loop.outputsRoot, "report.md"), "utf8")).toContain("Revision 2 of can_1");
  }, KERNEL_BUDGET_MS + spawnBudgetMs(2));

  test.each(["balanced", "exhaustive"] as const)("%s enters every canary only with an explicit gauntlet request and --exec", intensity => {
    const explicit = parseExecutionOptions(["--execution-mode=gauntlet", `--gauntlet-intensity=${intensity}`], {});
    const standard = parseExecutionOptions([`--gauntlet-intensity=${intensity}`], {});
    const policy = { businessSlug: "allowed", wantExec: true, teamMode: false, requestedMode: explicit.requestedMode, resolvedMode: explicit.resolvedMode, allowlist: "allowed" };
    expect(explicit.intensity).toBe(intensity);
    expect(shouldRunAgentXGauntlet({ targetKind: "agent-x", wantExec: true, resolvedMode: explicit.resolvedMode })).toBeTrue();
    expect(shouldRunSquadGauntlet({ squadCount: 1, wantExec: true, resolvedMode: explicit.resolvedMode })).toBeTrue();
    expect(decideBusinessCanary(policy)).toEqual({ enabled: true, reason: "selected" });
    expect(shouldRunAgentXGauntlet({ targetKind: "agent-x", wantExec: true, resolvedMode: standard.resolvedMode })).toBeFalse();
    expect(shouldRunSquadGauntlet({ squadCount: 1, wantExec: true, resolvedMode: standard.resolvedMode })).toBeFalse();
    expect(decideBusinessCanary({ ...policy, requestedMode: standard.requestedMode, resolvedMode: standard.resolvedMode }).reason).toBe("not_explicit");
    expect(shouldRunAgentXGauntlet({ targetKind: "agent-x", wantExec: false, resolvedMode: explicit.resolvedMode })).toBeFalse();
    expect(shouldRunSquadGauntlet({ squadCount: 1, wantExec: false, resolvedMode: explicit.resolvedMode })).toBeFalse();
    expect(decideBusinessCanary({ ...policy, wantExec: false }).reason).toBe("scaffold_only");
  });
});
