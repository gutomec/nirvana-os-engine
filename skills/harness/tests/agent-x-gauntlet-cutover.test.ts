import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  AgentXGauntletInterruption, runAgentXGauntlet, shouldRunAgentXGauntlet, type AgentXGauntletEvaluator,
} from "../lib/gauntlet/agent-x-cutover.ts";
import { getRun, listEvents, openKernel, type KernelHandle } from "../lib/run-kernel/index.ts";

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
    evaluate({ runId, artifactRefs }) {
      return [{ evaluationId: `evl_${runId}_1`, candidateId: "can_1", revisionId: `crv_${runId}_1`,
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

describe("agent-x light Gauntlet cutover", () => {
  test("keeps standard, scaffold-only, business, squad, and non-light execution outside the canary", () => {
    const base = { targetKind: "agent-x" as const, wantExec: true, resolvedMode: "gauntlet" as const, intensity: "light" as const };
    expect(shouldRunAgentXGauntlet(base)).toBeTrue();
    expect(shouldRunAgentXGauntlet({ ...base, resolvedMode: "standard" })).toBeFalse();
    expect(shouldRunAgentXGauntlet({ ...base, wantExec: false })).toBeFalse();
    expect(shouldRunAgentXGauntlet({ ...base, targetKind: "business" })).toBeFalse();
    expect(shouldRunAgentXGauntlet({ ...base, targetKind: "squad" })).toBeFalse();
    expect(shouldRunAgentXGauntlet({ ...base, intensity: "balanced" })).toBeFalse();
  });

  test("persists plan and candidate before an independent evaluation, then runs the final gate", () => {
    const { handle, outputsRoot, result, executions, finalGates } = run();
    expect(result.run.state).toBe("completed");
    expect(executions).toBe(1); expect(finalGates).toBe(1);
    expect(fs.readFileSync(path.join(outputsRoot, "report.md"), "utf8")).toBe("Conteúdo aprovado.");
    const types = listEvents(handle, "prj_canary").map(event => event.type);
    expect(types.indexOf("gauntlet.plan_compiled")).toBeLessThan(types.indexOf("gauntlet.candidate_created"));
    expect(types.indexOf("gauntlet.candidate_created")).toBeLessThan(types.indexOf("gauntlet.evaluation_recorded"));
    expect(types.at(-1)).toBe("run.transitioned");
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
    expect(result).toMatchObject({ exitCode: 2, finalGateRan: false, run: { state: "withheld" } });
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

  test("rolls back when the light budget blocks execution before the candidate", () => {
    const { result, executions, finalGates } = run({ expectedCostUsd: 6 });
    expect(result.run.state).toBe("rolled_back");
    expect(executions).toBe(0); expect(finalGates).toBe(0);
  });
});
