import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AgentXCanaryQueue, ConversationService, createDispatchExecutionRunner, type GlanceAgentXCanaryAdapter } from "../lib/control-plane/index.ts";
import { createRun, getRun, listEvents, openKernel, transitionRun } from "../lib/run-kernel/index.ts";
import { childState, pidAlive, shimRuntimeOnPath, waitUntil, writeFakeGlanceChild } from "./helpers/fake-glance-child.ts";
import { removeDir } from "./helpers/temp-dirs.ts";

const roots: string[] = [];
const queues: AgentXCanaryQueue[] = [];
const restores: Array<() => void> = [];
const closers: Array<() => void> = [];
afterEach(() => {
  while (queues.length) queues.pop()!.shutdown();
  // A handle a failed assertion left open keeps the kernel file busy on Windows.
  while (closers.length) closers.pop()!();
  while (restores.length) restores.pop()!();
  while (roots.length) removeDir(roots.pop()!);
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

async function waitForState(kernelPath: string, projectId: string, runId: string, state: string, attempts = 100) {
  for (let i = 0; i < attempts; i++) {
    const handle = openKernel(kernelPath); const current = getRun(handle, projectId, runId); handle.close();
    if (current?.state === state) return;
    await Bun.sleep(10);
  }
  throw new Error(`run did not reach ${state}`);
}

/** A project with one Message, a runtime shim on PATH and fake-child runners keyed by knobs. */
function childFixture() {
  const { root, kernelPath, conversationPath } = fixture();
  restores.push(shimRuntimeOnPath(root, "claude"));
  const script = writeFakeGlanceChild(path.join(root, "helpers"));
  const stateRoot = path.join(root, "fake-state");
  const runner = (knobs: Record<string, string> = {}) => createDispatchExecutionRunner({ dispatchScriptPath: script,
    env: { NIRVANA_HOST_RUNTIME: "claude-code", FAKE_CHILD_STATE_DIR: stateRoot, ...knobs } });
  const conversations = new ConversationService(conversationPath);
  const conversation = conversations.create("prj_child", "Child", "cnv_child");
  const message = conversations.append({ conversationId: conversation.conversation_id, projectId: "prj_child", role: "user", content: "Produza e sobreviva ao restart", messageId: "msg_child" });
  conversations.close();
  const open = () => ({ kernel: openKernel(kernelPath), conversations: new ConversationService(conversationPath) });
  const queue = (knobs?: Record<string, string>) => {
    const handles = open();
    const instance = new AgentXCanaryQueue(handles.kernel, handles.conversations, undefined, runner(knobs)); queues.push(instance);
    const close = () => { handles.kernel.close(); handles.conversations.close(); };
    closers.push(close);
    return { ...handles, queue: instance, close };
  };
  const runEvents = (runId: string) => { const handle = openKernel(kernelPath); const events = listEvents(handle, "prj_child").filter(event => event.runId === runId); handle.close(); return events; };
  const childPid = (runId: string, attempt: number) => Number(runEvents(runId).find(event => event.type === "glance.child_started" && (event.payload as any).attempt === attempt)!.payload.pid);
  return { root, kernelPath, message, state: (runId: string) => childState(stateRoot, runId), queue, runEvents, childPid };
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

  test("one run skipped for a different reason on each restart records both reasons and never conflicts", () => {
    const { root, kernelPath, conversationPath } = fixture();
    const kernel = openKernel(kernelPath); const conversations = new ConversationService(conversationPath);
    conversations.create("prj_skip", "Skip", "cnv_skip");
    conversations.append({ conversationId: "cnv_skip", projectId: "prj_skip", role: "user", content: "skip me", messageId: "msg_skip", runId: "run_skip" });
    const actor = { kind: "test", id: "recovery" };
    createRun(kernel, { projectId: "prj_skip", runId: "run_skip", traceId: "run_skip", conversationId: "cnv_skip", planId: "plan_run_skip",
      target: { kind: "agent-x", slug: "agent-x" }, policySnapshotRef: "gauntlet-light-canary", actor, correlationId: "cor_run_skip" });
    // First boot: no runtime, the prepared Run is skipped as capability_unavailable.
    const unavailable = new AgentXCanaryQueue(kernel, conversations, { ...adapter({ executions: 0 }), available: () => false }); queues.push(unavailable);
    expect(unavailable.recover("prj_skip", root).skipped).toEqual([{ runId: "run_skip", reason: "capability_unavailable" }]);
    unavailable.shutdown();
    // Something else ends the Run; the next boot skips it again, for another reason.
    transitionRun(kernel, { projectId: "prj_skip", runId: "run_skip", to: "rolled_back", actor, correlationId: "cor_run_skip" });
    const restarted = new AgentXCanaryQueue(kernel, conversations, adapter({ executions: 0 })); queues.push(restarted);
    expect(() => restarted.recover("prj_skip", root)).not.toThrow();
    expect(restarted.recover("prj_skip", root).skipped).toEqual([{ runId: "run_skip", reason: "state_rolled_back" }]);
    const skipped = listEvents(kernel, "prj_skip").filter(event => event.type === "canary.recovery_skipped");
    expect(skipped.map(event => (event.payload as { reason: string }).reason)).toEqual(["capability_unavailable", "state_rolled_back"]);
    expect(skipped.map(event => event.idempotencyKey)).toEqual(["canary.recovery_skipped:run_skip:capability_unavailable", "canary.recovery_skipped:run_skip:state_rolled_back"]);
    kernel.close(); conversations.close();
  });

  test("a running run whose child is dead is redispatched once across two restarts and resumes without repeating the producer", async () => {
    const fx = childFixture();
    const first = fx.queue({ FAKE_CHILD_HOLD: "1", FAKE_CHILD_AFTER_WAIT: "crash" });
    const receipt = first.queue.submit({ projectId: "prj_child", conversationId: "cnv_child", messageId: fx.message.message_id, brief: fx.message.content, projectRoot: fx.root, idempotencyKey: "child" });
    const runId = receipt.run.runId;
    const child = fx.state(runId);
    await child.waitFor("holding");
    // The server dies while the child is mid-flight; then the child crashes with the candidate persisted.
    first.queue.shutdown(); first.close();
    const pid = fx.childPid(runId, 1);
    child.release();
    await waitUntil(() => !pidAlive(pid), "the first child to die");
    expect(child.has("crashed")).toBe(true);
    expect(child.count("producer")).toBe(1);
    const reopened = openKernel(fx.kernelPath);
    expect(getRun(reopened, "prj_child", runId)?.state).toBe("running");
    reopened.close();

    const second = fx.queue();
    expect(second.queue.recover("prj_child", fx.root)).toMatchObject({ enqueued: [], reattached: [], redispatched: [runId] });
    // A second restart before the redispatched child even starts records nothing new.
    second.queue.shutdown(); second.close();
    const third = fx.queue();
    expect(third.queue.recover("prj_child", fx.root)).toMatchObject({ redispatched: [runId] });
    await waitForState(fx.kernelPath, "prj_child", runId, "completed", 500);
    // The child writes `completed` and exits; the queue records glance.child_exited only after the
    // process exit event, so the terminal state alone does not mean the journal is final.
    await waitUntil(() => fx.runEvents(runId).some(event => event.type === "glance.child_exited"), "the redispatched exit event");
    expect(child.count("spawns")).toBe(2);
    expect(child.count("producer")).toBe(1);
    expect(child.count("final-gate")).toBe(1);
    const events = fx.runEvents(runId);
    expect(events.filter(event => event.type === "canary.recovery_redispatched")).toHaveLength(1);
    expect(events.find(event => event.type === "canary.recovery_redispatched")!.payload).toMatchObject({ pid, attempt: 1, reason: "child_pid_dead" });
    expect(events.filter(event => event.type === "glance.child_started").map(event => (event.payload as any).attempt)).toEqual([1, 2]);
    expect(events.filter(event => event.type === "glance.child_exited").map(event => (event.payload as any).attempt)).toEqual([2]);
    expect(events.filter(event => event.type === "gauntlet.candidate_created")).toHaveLength(1);
    third.close();
  }, 30000);

  test("a running run whose child is alive is reattached, never respawned, and settles when the child finishes", async () => {
    const fx = childFixture();
    const first = fx.queue({ FAKE_CHILD_HOLD: "1" });
    const receipt = first.queue.submit({ projectId: "prj_child", conversationId: "cnv_child", messageId: fx.message.message_id, brief: fx.message.content, projectRoot: fx.root, idempotencyKey: "child-alive" });
    const runId = receipt.run.runId;
    const child = fx.state(runId);
    await child.waitFor("holding");
    first.queue.shutdown(); first.close();
    const pid = fx.childPid(runId, 1);
    expect(pidAlive(pid)).toBe(true);

    const second = fx.queue();
    expect(second.queue.recover("prj_child", fx.root)).toMatchObject({ enqueued: [], reattached: [runId], redispatched: [] });
    await Bun.sleep(300);
    expect(child.count("spawns")).toBe(1);
    expect(getRun(second.kernel, "prj_child", runId)?.state).toBe("running");
    child.release();
    await waitForState(fx.kernelPath, "prj_child", runId, "completed", 500);
    await waitUntil(() => fx.runEvents(runId).some(event => event.type === "glance.child_exited"), "the reattached exit event");
    expect(child.count("spawns")).toBe(1);
    expect(child.count("producer")).toBe(1);
    const events = fx.runEvents(runId);
    expect(events.filter(event => event.type === "canary.recovery_reattached")).toHaveLength(1);
    expect(events.find(event => event.type === "canary.recovery_reattached")!.payload).toMatchObject({ pid, attempt: 1 });
    expect(events.filter(event => event.type === "glance.child_started")).toHaveLength(1);
    expect(events.at(-1)!.type).toBe("glance.child_exited");
    expect(events.at(-1)!.payload).toMatchObject({ pid, attempt: 1, exitCode: null, reattached: true });
    // A restart after completion skips the run like any terminal one.
    const third = fx.queue();
    expect(third.queue.recover("prj_child", fx.root).skipped).toEqual([{ runId, reason: "state_completed" }]);
    second.close(); third.close();
  }, 30000);
});
