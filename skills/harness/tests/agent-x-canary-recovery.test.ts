import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AgentXCanaryQueue, ConversationService, type GlanceAgentXCanaryAdapter } from "../lib/control-plane/index.ts";
import { createRun, getRun, listEvents, openKernel, transitionRun } from "../lib/run-kernel/index.ts";

const roots: string[] = [];
const queues: AgentXCanaryQueue[] = [];
afterEach(() => {
  while (queues.length) queues.pop()!.shutdown();
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-canary-recovery-")); roots.push(root);
  fs.mkdirSync(path.join(root, ".nirvana"), { recursive: true });
  return { root, kernelPath: path.join(root, ".nirvana", "run-kernel.sqlite"), conversationPath: path.join(root, ".nirvana", "control-plane.sqlite") };
}

function adapter(counter: { executions: number }): GlanceAgentXCanaryAdapter {
  return {
    available: () => true,
    execute({ candidateRoot }) { counter.executions++; fs.mkdirSync(candidateRoot, { recursive: true }); fs.writeFileSync(path.join(candidateRoot, "result.md"), "ok", "utf8"); return { ok: true, sessionId: "recovered" }; },
    evaluator: { target: { kind: "squad", slug: "recovery-evaluator", capabilityId: "quality.specification_conformance" },
      evaluate({ candidateId, revisionId, artifactRefs }) { return [{ evaluationId: `evl_${revisionId}`, candidateId, revisionId, gauntletId: "brief",
        rubricVersion: "test/v1", verdict: "pass", dimensions: [{ id: "brief", score: 1, confidence: 1, blocking: true, passed: true, evidenceRefs: artifactRefs.map(ref => ref.revisionId) }], regressions: [], revisionRequests: [], evaluator: this.target, costUsd: 0, createdAt: new Date().toISOString() }]; } },
    finalGate: () => ({ exitCode: 0, gateOutcome: "pass" }),
  };
}

async function waitForState(kernelPath: string, projectId: string, runId: string, state: string) {
  for (let i = 0; i < 100; i++) {
    const handle = openKernel(kernelPath); const current = getRun(handle, projectId, runId); handle.close();
    if (current?.state === state) return;
    await Bun.sleep(10);
  }
  throw new Error(`run did not reach ${state}`);
}

describe("durable agent-x canary recovery", () => {
  test("recovers a crash before dequeue across two restarts with one side effect", async () => {
    const { root, kernelPath, conversationPath } = fixture();
    const counter = { executions: 0 };
    let kernel = openKernel(kernelPath); let conversations = new ConversationService(conversationPath);
    const conversation = conversations.create("prj_recovery", "Recovery", "cnv_recovery");
    const message = conversations.append({ conversationId: conversation.conversation_id, projectId: "prj_recovery", role: "user", content: "Recover me", messageId: "msg_recovery" });
    const first = new AgentXCanaryQueue(kernel, conversations, adapter(counter)); queues.push(first);
    const receipt = first.submit({ projectId: "prj_recovery", conversationId: conversation.conversation_id, messageId: message.message_id, brief: message.content, projectRoot: root, idempotencyKey: "recovery" });
    first.shutdown(); kernel.close(); conversations.close();

    kernel = openKernel(kernelPath); conversations = new ConversationService(conversationPath);
    const second = new AgentXCanaryQueue(kernel, conversations, adapter(counter)); queues.push(second);
    expect(second.recover("prj_recovery", root).enqueued).toEqual([receipt.run.runId]);
    second.shutdown(); kernel.close(); conversations.close();

    kernel = openKernel(kernelPath); conversations = new ConversationService(conversationPath);
    const third = new AgentXCanaryQueue(kernel, conversations, adapter(counter)); queues.push(third);
    expect(third.recover("prj_recovery", root).enqueued).toEqual([receipt.run.runId]);
    await waitForState(kernelPath, "prj_recovery", receipt.run.runId, "completed");
    expect(counter.executions).toBe(1);
    const events = listEvents(kernel, "prj_recovery").filter(event => event.type === "canary.recovery_enqueued");
    expect(events).toHaveLength(1);
    kernel.close(); conversations.close();
  });

  test("ignores terminal and running runs without a recoverable lease", () => {
    const { root, kernelPath, conversationPath } = fixture();
    const kernel = openKernel(kernelPath); const conversations = new ConversationService(conversationPath);
    conversations.create("prj_states", "States", "cnv_states");
    for (const [runId, terminal] of [["run_terminal", true], ["run_running", false]] as const) {
      conversations.append({ conversationId: "cnv_states", projectId: "prj_states", role: "user", content: runId, messageId: `msg_${runId}`, runId });
      createRun(kernel, { projectId: "prj_states", runId, traceId: runId, conversationId: "cnv_states", planId: `plan_${runId}`, target: { kind: "agent-x", slug: "agent-x" }, policySnapshotRef: "gauntlet-light-canary", actor: { kind: "test", id: "recovery" }, correlationId: `cor_${runId}` });
      transitionRun(kernel, { projectId: "prj_states", runId, to: terminal ? "rolled_back" : "running", actor: { kind: "test", id: "recovery" }, correlationId: `cor_${runId}` });
    }
    const queue = new AgentXCanaryQueue(kernel, conversations, adapter({ executions: 0 })); queues.push(queue);
    const result = queue.recover("prj_states", root);
    expect(result.enqueued).toEqual([]);
    expect(result.skipped).toEqual(expect.arrayContaining([{ runId: "run_terminal", reason: "state_rolled_back" }, { runId: "run_running", reason: "state_running" }]));
    expect(listEvents(kernel, "prj_states").filter(event => event.type === "canary.recovery_skipped")).toHaveLength(2);
    kernel.close(); conversations.close();
  });
});
