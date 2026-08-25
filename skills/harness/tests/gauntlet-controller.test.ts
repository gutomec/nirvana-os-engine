import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { GauntletController, compileGauntletPlan } from "../lib/gauntlet/index.ts";
import { createRun, listEvents, openKernel, type KernelHandle } from "../lib/run-kernel/index.ts";

const roots: string[] = [];
const handles: KernelHandle[] = [];
afterEach(() => { while (handles.length) handles.pop()!.close(); while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true }); });

function setup(overrides: Parameters<typeof compileGauntletPlan>[0] = { brief: "Build it" }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-gauntlet-controller-")); roots.push(root);
  const handle = openKernel(path.join(root, "kernel.sqlite")); handles.push(handle);
  const context = { projectId: "prj_1", runId: "run_1", traceId: "trace_1", actor: { kind: "kernel", id: "controller" }, correlationId: "cor_1" };
  createRun(handle, { ...context, planId: "plan_1", target: { kind: "business", slug: "builder" }, policySnapshotRef: "policy" });
  const controller = new GauntletController(handle, context);
  controller.begin(compileGauntletPlan(overrides), "2026-08-25T12:00:00.000Z");
  return { handle, controller };
}

function candidate(revision = 1) {
  return { candidateId: "can_1", revision, revisionId: `crv_${revision}`, artifactRefs: [`arv_${revision}`],
    producer: { kind: "business" as const, slug: "builder" }, causalEvaluationIds: revision === 1 ? [] : [`evl_${revision - 1}`],
    ...(revision > 1 ? { parentRevisionId: `crv_${revision - 1}`, hypothesis: "Fix observed defects" } : {}),
    createdAt: `2026-08-25T12:00:0${revision}.000Z` };
}

function score(revision: number, value: number, options: { blockingPassed?: boolean; evaluatorSelf?: boolean; regressions?: string[] } = {}) {
  const passed = options.blockingPassed ?? value >= 0.9;
  return { evaluationId: `evl_${revision}`, candidateId: "can_1", revisionId: `crv_${revision}`, gauntletId: "brief-conformance",
    rubricVersion: "v1", verdict: passed ? "pass" as const : "revise" as const,
    dimensions: [{ id: "brief", score: value, confidence: 1, blocking: true, passed, evidenceRefs: [`test:${revision}`] }],
    regressions: options.regressions ?? [], revisionRequests: passed ? [] : [{ requirementId: "brief", evidenceRefs: [`test:${revision}`] }],
    evaluator: options.evaluatorSelf ? { kind: "business" as const, slug: "builder" } : { kind: "agent-x" as const, slug: "agent-x" as const },
    costUsd: 0.1, createdAt: `2026-08-25T12:01:0${revision}.000Z` };
}

describe("bounded gauntlet controller", () => {
  test("delivers only after an independent hard gate passes", () => {
    const { controller } = setup({ brief: "Build it", intensity: "light" });
    controller.beginRound(1, "2026-08-25T12:00:01.000Z"); controller.addCandidate(candidate());
    expect(() => controller.evaluateRound([score(1, 1, { evaluatorSelf: true })])).toThrow(/cannot evaluate its own/);
    const result = controller.evaluateRound([score(1, 1)]);
    expect(result).toMatchObject({ decision: "delivered", stopReason: "success", selectedRevisionId: "crv_1" });
  });

  test("does not dispatch a round without budget", () => {
    const { controller } = setup({ brief: "Build it", budget: { maxCostUsd: 1 } });
    expect(controller.beginRound(2, "2026-08-25T12:00:01.000Z").stopReason).toBe("max_cost");
    expect(controller.resume().round).toBe(0);
  });

  test("stops after stable metrics show no progress", () => {
    const { controller } = setup({ brief: "Build it", intensity: "balanced", stop: { noProgressPatience: 1, minimumDelta: 0.6 } });
    controller.beginRound(1, "2026-08-25T12:00:01.000Z"); controller.addCandidate(candidate());
    expect(controller.evaluateRound([score(1, 0.5)]).stopReason).toBe("no_progress");
  });

  test("blocks selection when a revision regresses a previously passed hard gate", () => {
    const { controller } = setup({ brief: "Build it", stop: { minimumScore: 1, noProgressPatience: 3 } });
    controller.beginRound(1, "2026-08-25T12:00:01.000Z"); controller.addCandidate(candidate());
    expect(controller.evaluateRound([score(1, 0.95)]).state).toBe("revising");
    controller.addCandidate(candidate(2)); controller.markRegressionTesting();
    const result = controller.evaluateRound([score(2, 0.8, { blockingPassed: false })]);
    expect(result.stopReason).toBe("critical_regression");
    expect(result.decision).toBe("withheld");
  });

  test("resumes after crash and replays round commands idempotently", () => {
    const { handle, controller } = setup({ brief: "Build it" });
    const first = controller.beginRound(1, "2026-08-25T12:00:01.000Z");
    const resumed = new GauntletController(handle, { projectId: "prj_1", runId: "run_1", traceId: "trace_1", actor: { kind: "kernel", id: "controller" }, correlationId: "cor_1" });
    expect(resumed.resume()).toEqual(first);
    expect(resumed.beginRound(1)).toEqual(first);
    expect(listEvents(handle, "prj_1").filter(event => event.type === "gauntlet.round_started")).toHaveLength(1);
  });

  test("stops at max rounds before another fan-out", () => {
    const { controller } = setup({ brief: "Build it", stop: { maxRounds: 1, noProgressPatience: 3 } });
    controller.beginRound(1, "2026-08-25T12:00:01.000Z"); controller.addCandidate(candidate());
    expect(controller.evaluateRound([score(1, 0.6)]).stopReason).toBe("max_rounds");
    expect(controller.resume().round).toBe(1);
  });

  test("delivers with explicit reservations for non-blocking failures", () => {
    const { controller } = setup({ brief: "Build it", stop: { minimumScore: 0.9 } });
    controller.beginRound(1, "2026-08-25T12:00:01.000Z"); controller.addCandidate(candidate());
    const result = controller.evaluateRound([{ ...score(1, 1), dimensions: [
      { id: "brief", score: 1, confidence: 1, blocking: true, passed: true, evidenceRefs: ["test:brief"] },
      { id: "style", score: 0.8, confidence: 0.2, blocking: false, passed: false, evidenceRefs: ["review:style"] },
    ] }]);
    expect(result.decision).toBe("reservations");
    expect(result.reservations).toEqual(["style"]);
  });
});
