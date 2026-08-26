import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beginGauntlet, compileGauntletPlan, getGauntlet, listCandidateRevisions, saveCandidateRevision, saveScorecard } from "../lib/gauntlet/index.ts";
import { createRun, listEvents, openKernel, type KernelHandle } from "../lib/run-kernel/index.ts";

const roots: string[] = [];
const handles: KernelHandle[] = [];
afterEach(() => {
  while (handles.length) handles.pop()!.close();
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

function fresh() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-gauntlet-")); roots.push(root);
  const handle = openKernel(path.join(root, "kernel.sqlite")); handles.push(handle);
  createRun(handle, { projectId: "prj_1", runId: "run_1", traceId: "trace_1", planId: "plan_1",
    target: { kind: "business", slug: "builder" }, policySnapshotRef: "policy", actor: { kind: "kernel", id: "test" }, correlationId: "cor" });
  return { handle, context: { projectId: "prj_1", runId: "run_1", traceId: "trace_1", actor: { kind: "kernel", id: "test" }, correlationId: "cor" } };
}

describe("gauntlet durable stores", () => {
  test("persists an idempotent plan in the canonical journal", () => {
    const { handle, context } = fresh();
    const plan = compileGauntletPlan({ brief: "Build it", intensity: "light" });
    const first = beginGauntlet(handle, context, plan, "2026-08-25T12:00:00.000Z");
    expect(beginGauntlet(handle, context, plan)).toEqual(first);
    expect(getGauntlet(handle, "prj_1", "run_1")?.state).toBe("ready");
    expect(listEvents(handle, "prj_1").filter(event => event.type === "gauntlet.plan_compiled")).toHaveLength(1);
  });

  test("keeps candidate revisions immutable and causal", () => {
    const { handle, context } = fresh();
    beginGauntlet(handle, context, compileGauntletPlan({ brief: "Build it" }));
    const first = { candidateId: "can_1", revision: 1, revisionId: "crv_1", artifactRefs: ["arv_1"],
      producer: { kind: "business" as const, slug: "builder" }, causalEvaluationIds: [], createdAt: "2026-08-25T12:00:01.000Z" };
    saveCandidateRevision(handle, context, first);
    saveCandidateRevision(handle, context, first);
    expect(() => saveCandidateRevision(handle, context, { ...first, artifactRefs: ["arv_changed"] })).toThrow(/revision conflict/);
    expect(() => saveCandidateRevision(handle, context, { ...first, revision: 2, revisionId: "crv_2", parentRevisionId: "crv_1" })).toThrow(/requires parent/);
    saveCandidateRevision(handle, context, { ...first, revision: 2, revisionId: "crv_2", parentRevisionId: "crv_1",
      causalEvaluationIds: ["evl_1"], hypothesis: "Fix the failed requirement" });
    expect(listCandidateRevisions(handle, "prj_1", "run_1")).toHaveLength(2);
  });

  test("rejects divergent scorecard replay", () => {
    const { handle, context } = fresh();
    const scorecard = { evaluationId: "evl_1", candidateId: "can_1", revisionId: "crv_1", gauntletId: "brief-conformance",
      rubricVersion: "v1", verdict: "pass" as const, dimensions: [{ id: "brief", score: 1, confidence: 1, blocking: true, passed: true, evidenceRefs: ["test:1"] }],
      regressions: [], revisionRequests: [], evaluator: { kind: "agent-x" as const, slug: "agent-x" as const }, costUsd: 0.1,
      createdAt: "2026-08-25T12:00:02.000Z" };
    saveScorecard(handle, context, scorecard);
    saveScorecard(handle, context, scorecard);
    expect(() => saveScorecard(handle, context, { ...scorecard, costUsd: 0.2 })).toThrow(/evaluation conflict/);
  });
});
