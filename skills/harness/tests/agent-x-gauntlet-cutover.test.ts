import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  AgentXGauntletInterruption, GAUNTLET_EVALUATION_FLOOR_USD, GAUNTLET_EVALUATION_SHARE, gauntletRoundBudget, runAgentXGauntlet, shouldRunAgentXGauntlet, shouldRunSquadGauntlet,
  type AgentXGauntletEvaluator,
} from "../lib/gauntlet/agent-x-cutover.ts";
import { compileGauntletPlan } from "../lib/gauntlet/compiler.ts";
import { createRun, getRun, listEvents, openKernel, type KernelHandle } from "../lib/run-kernel/index.ts";
import { KERNEL_BUDGET_MS } from "./helpers/test-budgets.ts";

const roots: string[] = [];
const handles: KernelHandle[] = [];

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-agent-x-gauntlet-")); roots.push(root);
  const handle = openKernel(path.join(root, ".nirvana", "run-kernel.sqlite")); handles.push(handle);
  return { root, handle, outputsRoot: path.join(root, "deliverables") };
}

afterEach(() => {
  while (handles.length) handles.pop()!.close();
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

function evaluator(pass = true, self = false): AgentXGauntletEvaluator {
  const target = self
    ? { kind: "agent-x" as const, slug: "agent-x" as const }
    : { kind: "squad" as const, slug: "quality-gate", capabilityId: "quality.specification_conformance" };
  return {
    target,
    evaluate({ candidateId, revisionId, artifactRefs }) {
      return [{ evaluationId: `evl_${revisionId}`, candidateId, revisionId,
        gauntletId: "brief-conformance", rubricVersion: "test/v1", verdict: pass ? "pass" : "reject",
        dimensions: [{ id: "brief", score: pass ? 1 : 0, confidence: 1, blocking: true, passed: pass,
          evidenceRefs: artifactRefs.map(ref => ref.revisionId) }], regressions: [],
        revisionRequests: pass ? [] : [{ requirementId: "brief", evidenceRefs: ["test:failure"] }],
        evaluator: target, costUsd: 0, createdAt: "2026-08-25T12:00:02.000Z" }];
    },
  };
}

function run(overrides: Partial<Parameters<typeof runAgentXGauntlet>[0]> = {}) {
  const fixture = setup();
  let executions = 0;
  let finalGates = 0;
  const result = runAgentXGauntlet({
    kernel: fixture.handle, projectId: "prj_canary", runId: "run_canary", traceId: "trace_canary",
    brief: "Create report.md", projectRoot: fixture.root, outputsRoot: fixture.outputsRoot, expectedCostUsd: 1,
    executeCandidate(candidateRoot) {
      executions += 1; fs.mkdirSync(candidateRoot, { recursive: true });
      fs.writeFileSync(path.join(candidateRoot, "report.md"), "Conteúdo aprovado.", "utf8");
      return { ok: true, sessionId: "session_1", costUsd: 1 };
    },
    evaluator: evaluator(),
    finalGate() { finalGates += 1; return { exitCode: 0, gateOutcome: "pass" }; },
    ...overrides,
  });
  return { ...fixture, result, executions, finalGates };
}

describe("agent-x Gauntlet cutover", () => {
  test("keeps standard, scaffold-only, business and squad execution outside the agent-x canary at every intensity", () => {
    const base = { targetKind: "agent-x" as const, wantExec: true, resolvedMode: "gauntlet" as const };
    expect(shouldRunAgentXGauntlet(base)).toBeTrue();
    expect(shouldRunAgentXGauntlet({ ...base, resolvedMode: "standard" })).toBeFalse();
    expect(shouldRunAgentXGauntlet({ ...base, wantExec: false })).toBeFalse();
    expect(shouldRunAgentXGauntlet({ ...base, targetKind: "business" })).toBeFalse();
    expect(shouldRunAgentXGauntlet({ ...base, targetKind: "squad" })).toBeFalse();
  });

  test("enables only one squad in the typed canary, regardless of intensity", () => {
    const base = { squadCount: 1, wantExec: true, resolvedMode: "gauntlet" as const };
    expect(shouldRunSquadGauntlet(base)).toBeTrue();
    expect(shouldRunSquadGauntlet({ ...base, squadCount: 2 })).toBeFalse();
    expect(shouldRunSquadGauntlet({ ...base, wantExec: false })).toBeFalse();
    expect(shouldRunSquadGauntlet({ ...base, resolvedMode: "standard" })).toBeFalse();
  });

  test("splits the plan budget across rounds and candidates without exceeding the plan ceiling", () => {
    expect(gauntletRoundBudget(compileGauntletPlan({ brief: "Build", intensity: "light" }))).toEqual({ candidateBudgetUsd: 4, evaluationBudgetUsd: 0, roundBudgetUsd: 4, insufficient: false });
    expect(gauntletRoundBudget(compileGauntletPlan({ brief: "Build", intensity: "balanced" }), 1)).toEqual({ candidateBudgetUsd: 1, evaluationBudgetUsd: 0, roundBudgetUsd: 3, insufficient: false });
    const exhaustive = gauntletRoundBudget(compileGauntletPlan({ brief: "Build", intensity: "exhaustive" }), 500);
    expect(exhaustive.candidateBudgetUsd).toBeCloseTo(100 / 30);
    expect(exhaustive.roundBudgetUsd).toBeCloseTo(100 / 6);
  });

  test("reserves the evaluation share, never below the floor, inside the same round budget when a real evaluator judges", () => {
    expect(GAUNTLET_EVALUATION_SHARE).toBe(0.25);
    expect(GAUNTLET_EVALUATION_FLOOR_USD).toBe(1.5);
    // light: USD 8 / (1 candidate × 2 rounds) = USD 4 per candidate; 25% is USD 1, below the floor, so the judge gets USD 1.50 and the producer USD 2.50.
    expect(gauntletRoundBudget(compileGauntletPlan({ brief: "Build", intensity: "light" }), undefined, GAUNTLET_EVALUATION_SHARE))
      .toEqual({ candidateBudgetUsd: 2.5, evaluationBudgetUsd: 1.5, roundBudgetUsd: 4, insufficient: false });
    // exhaustive with a generous cap: 25% of USD 100 / 30 is USD 0.83, so the floor applies too.
    const exhaustive = gauntletRoundBudget(compileGauntletPlan({ brief: "Build", intensity: "exhaustive" }), undefined, GAUNTLET_EVALUATION_SHARE);
    expect(exhaustive.evaluationBudgetUsd).toBe(1.5);
    expect(exhaustive.candidateBudgetUsd).toBeCloseTo(100 / 30 - 1.5);
    // A slice above USD 6 pays the share, not the floor.
    const wide = gauntletRoundBudget(compileGauntletPlan({ brief: "Build", intensity: "light", budget: { maxCostUsd: 16 } }), undefined, GAUNTLET_EVALUATION_SHARE);
    expect(wide).toEqual({ candidateBudgetUsd: 6, evaluationBudgetUsd: 2, roundBudgetUsd: 8, insufficient: false });
    // --max-budget only lowers the slice: the judge keeps the floor and the producer takes the rest.
    const capped = gauntletRoundBudget(compileGauntletPlan({ brief: "Build", intensity: "balanced" }), 2, GAUNTLET_EVALUATION_SHARE);
    expect(capped).toEqual({ candidateBudgetUsd: 0.5, evaluationBudgetUsd: 1.5, roundBudgetUsd: 6, insufficient: false });
    // A slice the floor consumes leaves the producer nothing: the caller must not start the Gauntlet.
    expect(gauntletRoundBudget(compileGauntletPlan({ brief: "Build", intensity: "balanced" }), 1, GAUNTLET_EVALUATION_SHARE))
      .toEqual({ candidateBudgetUsd: 0, evaluationBudgetUsd: 1.5, roundBudgetUsd: 3, insufficient: true });
    expect(gauntletRoundBudget(compileGauntletPlan({ brief: "Build", intensity: "light" }), 1.5, GAUNTLET_EVALUATION_SHARE).insufficient).toBeTrue();
    expect(gauntletRoundBudget(compileGauntletPlan({ brief: "Build", intensity: "light" }), 1)).toMatchObject({ evaluationBudgetUsd: 0, insufficient: false });
    expect(() => gauntletRoundBudget(compileGauntletPlan({ brief: "Build" }), undefined, 1)).toThrow("evaluation share must be in [0, 1)");
  });

  test("persists plan and candidate before an independent evaluation, then runs the final gate", () => {
    const { handle, outputsRoot, result, executions, finalGates } = run();
    expect(result.run.state).toBe("completed");
    expect(result.gauntlet).toMatchObject({ state: "stopped", stopReason: "success", selectedRevisionId: "crv_run_canary_can_1_1" });
    expect(executions).toBe(1); expect(finalGates).toBe(1);
    expect(fs.readFileSync(path.join(outputsRoot, "report.md"), "utf8")).toBe("Conteúdo aprovado.");
    const types = listEvents(handle, "prj_canary").map(event => event.type);
    expect(types.indexOf("gauntlet.plan_compiled")).toBeLessThan(types.indexOf("gauntlet.candidate_created"));
    expect(types.indexOf("gauntlet.candidate_created")).toBeLessThan(types.indexOf("gauntlet.evaluation_recorded"));
    expect(types.at(-1)).toBe("run.transitioned");
  }, KERNEL_BUDGET_MS);

  test("persists a typed squad producer without changing the agent-x default", () => {
    const producerTarget = { kind: "squad" as const, slug: "document-factory", capabilityId: "document.generate" };
    const { handle, result } = run({ producerTarget });
    expect(result.run.target).toEqual(producerTarget);
    const candidate = listEvents(handle, "prj_canary").find(event => event.type === "gauntlet.candidate_created");
    expect((candidate?.payload as any).producer).toEqual(producerTarget);
  }, KERNEL_BUDGET_MS);

  test("freezes the runtime and model decision in the canonical journal", () => {
    const snapshot = { runtime: { id: "codex", source: "active-session" },
      provider: { id: "openai", resolved: true }, model: { id: "gpt-active", resolved: true } };
    const { handle, result } = run({ executionSnapshot: snapshot });
    const event = listEvents(handle, "prj_canary").find(item => item.type === "runtime.selection_snapshot");
    expect((event?.payload as any).snapshot).toEqual(snapshot);
    expect(result.run.policySnapshotRef).toBe((event?.payload as any).ref);
  }, KERNEL_BUDGET_MS);

  test("rejects a producer evaluating its own candidate and records a post-start failure", () => {
    const fixture = setup();
    expect(() => runAgentXGauntlet({ kernel: fixture.handle, projectId: "prj_canary", runId: "run_self", traceId: "trace_self",
      brief: "Build", projectRoot: fixture.root, outputsRoot: fixture.outputsRoot, expectedCostUsd: 1,
      executeCandidate(root) { fs.mkdirSync(root, { recursive: true }); fs.writeFileSync(path.join(root, "out.md"), "valid", "utf8"); return { ok: true, sessionId: null }; },
      evaluator: evaluator(true, true), finalGate() { throw new Error("must not run"); } })).toThrow(/cannot evaluate its own/);
    expect(getRun(fixture.handle, "prj_canary", "run_self")?.state).toBe("failed");
  }, KERNEL_BUDGET_MS);

  test.each([
    [{ exitCode: 0 as const, gateOutcome: "fail-accepted" }, "delivered_with_reservations"],
    [{ exitCode: 2 as const, gateOutcome: "fail" }, "withheld"],
    [{ exitCode: 1 as const, gateOutcome: "indeterminate" }, "failed"],
  ])("maps final gate %p to canonical terminal %s", (gate, terminal) => {
    expect(run({ finalGate: () => gate }).result.run.state).toBe(terminal);
  }, KERNEL_BUDGET_MS);

  test("withholds an evaluator rejection without invoking the final delivery gate", () => {
    const { result, finalGates } = run({ evaluator: evaluator(false) });
    expect(result).toMatchObject({ exitCode: 2, finalGateRan: false, run: { state: "withheld" }, gauntlet: { stopReason: "no_progress" } });
    expect(finalGates).toBe(0);
  }, KERNEL_BUDGET_MS);

  test("stops a failed producer with an honest execution failure", () => {
    const { result, finalGates } = run({ executeCandidate: () => ({ ok: false, sessionId: null, error: "runtime crashed" }) });
    expect(result).toMatchObject({ exitCode: 1, finalGateRan: false, run: { state: "failed" },
      gauntlet: { state: "stopped", stopReason: "execution_failure", reservations: ["runtime crashed"] } });
    expect(finalGates).toBe(0);
  }, KERNEL_BUDGET_MS);

  test("resumes after interruption without dispatching the persisted candidate twice", () => {
    const fixture = setup();
    let executions = 0;
    const common = {
      kernel: fixture.handle, projectId: "prj_canary", runId: "run_resume", traceId: "trace_resume", brief: "Build",
      projectRoot: fixture.root, outputsRoot: fixture.outputsRoot, expectedCostUsd: 1, evaluator: evaluator(),
      executeCandidate(root: string) { executions += 1; fs.mkdirSync(root, { recursive: true }); fs.writeFileSync(path.join(root, "out.md"), "valid", "utf8"); return { ok: true, sessionId: null }; },
      finalGate() { return { exitCode: 0 as const, gateOutcome: "pass" }; },
    };
    expect(() => runAgentXGauntlet({ ...common, afterCandidatePersisted() { throw new AgentXGauntletInterruption("crash"); } })).toThrow("crash");
    expect(getRun(fixture.handle, "prj_canary", "run_resume")?.state).toBe("running");
    expect(runAgentXGauntlet(common).run.state).toBe("completed");
    expect(executions).toBe(1);
  }, KERNEL_BUDGET_MS);

  test("adopts a Run a control plane already prepared under the same runId instead of creating a second one", () => {
    const fixture = setup();
    createRun(fixture.handle, { projectId: "prj_canary", runId: "run_adopted", traceId: "trace_glance", conversationId: "cnv_glance",
      planId: "plan_run_adopted", target: { kind: "agent-x", slug: "agent-x" }, policySnapshotRef: "gauntlet-light-canary",
      actor: { kind: "control-plane", id: "glance" }, correlationId: "cor_run_adopted", idempotencyKey: "glance-canary:adopt" });
    let executions = 0;
    const result = runAgentXGauntlet({
      kernel: fixture.handle, projectId: "prj_canary", runId: "run_adopted", traceId: "trace_dispatch", brief: "Build",
      projectRoot: fixture.root, outputsRoot: fixture.outputsRoot, expectedCostUsd: 1, evaluator: evaluator(),
      executeCandidate(root) { executions += 1; fs.mkdirSync(root, { recursive: true }); fs.writeFileSync(path.join(root, "out.md"), "valid", "utf8"); return { ok: true, sessionId: null }; },
      finalGate() { return { exitCode: 0, gateOutcome: "pass" }; },
    });
    expect(result.run).toMatchObject({ state: "completed", traceId: "trace_glance", conversationId: "cnv_glance", policySnapshotRef: "gauntlet-light-canary" });
    expect(executions).toBe(1);
    const events = listEvents(fixture.handle, "prj_canary").filter(event => event.runId === "run_adopted");
    expect(events.filter(event => event.type === "run.prepared")).toHaveLength(1);
    expect(new Set(events.map(event => event.traceId))).toEqual(new Set(["trace_glance"]));
  }, KERNEL_BUDGET_MS);

  test("rolls back when the light budget blocks execution before the candidate", () => {
    const { result, executions, finalGates } = run({ expectedCostUsd: 9 });
    expect(result.run.state).toBe("rolled_back");
    expect(executions).toBe(0); expect(finalGates).toBe(0);
  }, KERNEL_BUDGET_MS);

  test("an indeterminate evaluation withholds the Run as evaluation_indeterminate: no revision, no final gate, at any intensity", () => {
    const indeterminate: AgentXGauntletEvaluator = {
      target: { kind: "squad", slug: "quality-gate", capabilityId: "quality.specification_conformance" },
      evaluate({ candidateId, revisionId }) {
        return [{ evaluationId: `evl_${revisionId}`, candidateId, revisionId, gauntletId: "brief-conformance", rubricVersion: "test/v1",
          verdict: "indeterminate", dimensions: [{ id: "brief", score: 0, confidence: 1, blocking: true, passed: false, evidenceRefs: ["indeterminate: scorecard.json not found"] }],
          regressions: [], revisionRequests: [], evaluator: this.target, costUsd: 0, createdAt: "2026-08-25T12:00:02.000Z" }];
      },
    };
    for (const intensity of ["light", "balanced"] as const) {
      let revisions = 0;
      const { handle, result, executions, finalGates } = run({ intensity, evaluator: indeterminate, expectedCostUsd: 0.1,
        reviseCandidate() { revisions += 1; return { ok: true, sessionId: null }; } });
      expect(result).toMatchObject({ exitCode: 2, finalGateRan: false, run: { state: "withheld" }, gauntlet: { state: "stopped", decision: "withheld", round: 1 } });
      expect(result.gauntlet.stopReason).toBe(intensity === "light" ? "no_progress" : "execution_failure");
      if (intensity === "balanced") expect(result.gauntlet.reservations).toEqual(["evaluation_indeterminate"]);
      expect((listEvents(handle, "prj_canary").at(-1)?.payload as { to: string; reason: string })).toMatchObject({ to: "withheld", reason: "evaluation_indeterminate" });
      expect(executions).toBe(intensity === "light" ? 1 : 3);
      expect(revisions).toBe(0); expect(finalGates).toBe(0);
    }
  }, KERNEL_BUDGET_MS);
});
