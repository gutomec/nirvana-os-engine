import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  AgentXGauntletInterruption, gauntletRoundBudget, runAgentXGauntlet, shouldRunAgentXGauntlet, shouldRunSquadGauntlet,
  type AgentXGauntletEvaluator,
} from "../lib/gauntlet/agent-x-cutover.ts";
import { compileGauntletPlan } from "../lib/gauntlet/compiler.ts";
import { createRun, getRun, listEvents, openKernel, type KernelHandle } from "../lib/run-kernel/index.ts";

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
    expect(gauntletRoundBudget(compileGauntletPlan({ brief: "Build", intensity: "light" }))).toEqual({ candidateBudgetUsd: 2.5, roundBudgetUsd: 2.5 });
    expect(gauntletRoundBudget(compileGauntletPlan({ brief: "Build", intensity: "balanced" }), 1)).toEqual({ candidateBudgetUsd: 1, roundBudgetUsd: 3 });
    const exhaustive = gauntletRoundBudget(compileGauntletPlan({ brief: "Build", intensity: "exhaustive" }), 500);
    expect(exhaustive.candidateBudgetUsd).toBeCloseTo(100 / 30);
    expect(exhaustive.roundBudgetUsd).toBeCloseTo(100 / 6);
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
  });

  test("persists a typed squad producer without changing the agent-x default", () => {
    const producerTarget = { kind: "squad" as const, slug: "document-factory", capabilityId: "document.generate" };
    const { handle, result } = run({ producerTarget });
    expect(result.run.target).toEqual(producerTarget);
    const candidate = listEvents(handle, "prj_canary").find(event => event.type === "gauntlet.candidate_created");
    expect((candidate?.payload as any).producer).toEqual(producerTarget);
  });

  test("freezes the runtime and model decision in the canonical journal", () => {
    const snapshot = { runtime: { id: "codex", source: "active-session" },
      provider: { id: "openai", resolved: true }, model: { id: "gpt-active", resolved: true } };
    const { handle, result } = run({ executionSnapshot: snapshot });
    const event = listEvents(handle, "prj_canary").find(item => item.type === "runtime.selection_snapshot");
    expect((event?.payload as any).snapshot).toEqual(snapshot);
    expect(result.run.policySnapshotRef).toBe((event?.payload as any).ref);
  });

  test("rejects a producer evaluating its own candidate and records a post-start failure", () => {
    const fixture = setup();
    expect(() => runAgentXGauntlet({ kernel: fixture.handle, projectId: "prj_canary", runId: "run_self", traceId: "trace_self",
      brief: "Build", projectRoot: fixture.root, outputsRoot: fixture.outputsRoot, expectedCostUsd: 1,
      executeCandidate(root) { fs.mkdirSync(root, { recursive: true }); fs.writeFileSync(path.join(root, "out.md"), "valid", "utf8"); return { ok: true, sessionId: null }; },
      evaluator: evaluator(true, true), finalGate() { throw new Error("must not run"); } })).toThrow(/cannot evaluate its own/);
    expect(getRun(fixture.handle, "prj_canary", "run_self")?.state).toBe("failed");
  });

  test.each([
    [{ exitCode: 0 as const, gateOutcome: "fail-accepted" }, "delivered_with_reservations"],
    [{ exitCode: 2 as const, gateOutcome: "fail" }, "withheld"],
    [{ exitCode: 1 as const, gateOutcome: "indeterminate" }, "failed"],
  ])("maps final gate %p to canonical terminal %s", (gate, terminal) => {
    expect(run({ finalGate: () => gate }).result.run.state).toBe(terminal);
  });

  test("withholds an evaluator rejection without invoking the final delivery gate", () => {
    const { result, finalGates } = run({ evaluator: evaluator(false) });
    expect(result).toMatchObject({ exitCode: 2, finalGateRan: false, run: { state: "withheld" }, gauntlet: { stopReason: "no_progress" } });
    expect(finalGates).toBe(0);
  });

  test("stops a failed producer with an honest execution failure", () => {
    const { result, finalGates } = run({ executeCandidate: () => ({ ok: false, sessionId: null, error: "runtime crashed" }) });
    expect(result).toMatchObject({ exitCode: 1, finalGateRan: false, run: { state: "failed" },
      gauntlet: { state: "stopped", stopReason: "execution_failure", reservations: ["runtime crashed"] } });
    expect(finalGates).toBe(0);
  });

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
  });

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
  });

  test("rolls back when the light budget blocks execution before the candidate", () => {
    const { result, executions, finalGates } = run({ expectedCostUsd: 6 });
    expect(result.run.state).toBe("rolled_back");
    expect(executions).toBe(0); expect(finalGates).toBe(0);
  });
});
