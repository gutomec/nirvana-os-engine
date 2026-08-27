import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createDispatchExecutionRunner, type GlanceAgentXCanaryAdapter, type GlanceExecutionRunner } from "../lib/control-plane/index.ts";
import { childState, shimRuntimeOnPath, writeFakeGlanceChild } from "./helpers/fake-glance-child.ts";
import { removeDir } from "./helpers/temp-dirs.ts";
import { KERNEL_BUDGET_MS } from "./helpers/test-budgets.ts";

const roots: string[] = [];
const servers: any[] = [];
const restores: Array<() => void> = [];
afterEach(() => {
  while (servers.length) { try { servers.pop().close(); } catch {} }
  while (restores.length) restores.pop()!();
  // The env goes back before the roots go: a removal that throws must not leak the project root
  // into the files that run next.
  delete process.env.NIRVANA_PROJECT_ROOT;
  while (roots.length) removeDir(roots.pop()!);
});

function adapter(available = true): GlanceAgentXCanaryAdapter {
  return {
    available: () => available,
    execute({ candidateRoot, signal }) {
      if (signal.aborted) return { ok: false, sessionId: null, error: "cancelled" };
      fs.mkdirSync(candidateRoot, { recursive: true });
      fs.writeFileSync(path.join(candidateRoot, "result.md"), "# Resultado canário\n", "utf8");
      return { ok: true, sessionId: "session_test" };
    },
    evaluator: {
      target: { kind: "squad", slug: "test-evaluator", capabilityId: "quality.specification_conformance" },
      evaluate({ candidateId, revisionId, artifactRefs }) { return [{ evaluationId: `evl_${revisionId}`, candidateId, revisionId, gauntletId: "brief-conformance",
        rubricVersion: "test/v1", verdict: "pass", dimensions: [{ id: "brief", score: 1, confidence: 1, blocking: true, passed: true, evidenceRefs: artifactRefs.map(ref => ref.revisionId) }],
        regressions: [], revisionRequests: [], evaluator: this.target, costUsd: 0, createdAt: new Date().toISOString() }]; },
    },
    finalGate: () => ({ exitCode: 0, gateOutcome: "pass" }),
  };
}

async function start(canary?: GlanceAgentXCanaryAdapter, runner?: GlanceExecutionRunner) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-glance-canary-")); roots.push(root);
  process.env.NIRVANA_PROJECT_ROOT = root;
  fs.mkdirSync(path.join(root, ".nirvana"), { recursive: true });
  const { ProjectService } = await import("../lib/control-plane/project-service.ts");
  const project = new ProjectService().create({ projectRoot: root });
  const { startServer } = await import("../lib/glance/server.ts");
  const server = await startServer({ port: 0, open: false, idleMin: 60, allowActions: true, theme: "apple", agentXCanaryAdapter: canary, executionRunner: runner });
  servers.push(server);
  return { root, project, base: `http://127.0.0.1:${server.port}` };
}

/** A server whose Messages run in the fake child; `knobs` are the child's env switches. */
async function startWithChild(knobs: Record<string, string> = {}) {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-glance-child-state-")); roots.push(stateRoot);
  restores.push(shimRuntimeOnPath(stateRoot, "claude"));
  const runner = createDispatchExecutionRunner({ dispatchScriptPath: writeFakeGlanceChild(path.join(stateRoot, "helpers")),
    env: { NIRVANA_HOST_RUNTIME: "claude-code", FAKE_CHILD_STATE_DIR: stateRoot, ...knobs } });
  const started = await start(undefined, runner);
  return { ...started, stateRoot, state: (runId: string) => childState(stateRoot, runId) };
}

const headers = (base: string, key: string) => ({ "content-type": "application/json", origin: base, "idempotency-key": key });
async function waitFor(base: string, projectId: string, runId: string, state: string, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const run = await fetch(`${base}/api/v1/runs/${runId}?project_id=${projectId}`).then(r => r.json()) as any;
    if (run.state === state) return run;
    if (Date.now() > deadline) throw new Error(`run did not reach ${state} within ${timeoutMs} ms`);
    await Bun.sleep(10);
  }
}
async function conversation(base: string, projectId: string, key: string) {
  return (await fetch(`${base}/api/v1/projects/${projectId}/conversations`, { method: "POST", headers: headers(base, key), body: "{}" }).then(r => r.json()) as any).conversation_id as string;
}
async function send(base: string, projectId: string, conversationId: string, key: string, content: string) {
  const response = await fetch(`${base}/api/v1/conversations/${conversationId}/messages`, { method: "POST", headers: headers(base, key), body: JSON.stringify({ project_id: projectId, role: "user", content, mode: "run" }) });
  return { status: response.status, receipt: await response.json() as any };
}
const events = async (base: string, projectId: string) => ((await fetch(`${base}/api/v1/projects/${projectId}/events?limit=500`).then(r => r.json())) as any).events as any[];
const typeOf = (event: any) => event.type === "run.transitioned" ? `run.transitioned:${event.payload.to}` : event.type;
/** Polls the journal until the Run has recorded `type`: the child writes its terminal state and exits, and the
 * queue records glance.child_exited only when the process exit event arrives. */
async function waitForEvent(base: string, projectId: string, runId: string, type: string, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await events(base, projectId)).some(event => event.runId === runId && event.type === type)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${type} on ${runId}`);
    await Bun.sleep(10);
  }
}

/** Consumes the SSE stream from `after` until `until` holds (heartbeats keep reads short). */
async function readStream(base: string, projectId: string, after: number, until: (seen: any[]) => boolean, timeoutMs = 30000) {
  const controller = new AbortController();
  const response = await fetch(`${base}/api/v1/projects/${projectId}/stream`, { headers: { "last-event-id": String(after) }, signal: controller.signal });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const seen: any[] = [];
  const ids: number[] = [];
  let buffer = "";
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index: number;
      while ((index = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, index); buffer = buffer.slice(index + 2);
        const lines = frame.split("\n");
        const data = lines.find(line => line.startsWith("data: "));
        const id = lines.find(line => line.startsWith("id: "));
        if (data) { seen.push(JSON.parse(data.slice(6))); ids.push(Number(id!.slice(4))); }
      }
      if (until(seen)) break;
    }
  } finally { controller.abort(); }
  return { seen, ids };
}

describe("Glance agent-x light canary", () => {
  test("message prepares one linked run, executes through adapter and survives restart", async () => {
    const { root, project, base } = await start(adapter());
    const conversation = await fetch(`${base}/api/v1/projects/${project.project_id}/conversations`, { method: "POST", headers: headers(base, "conversation"), body: "{}" }).then(r => r.json()) as any;
    const response = await fetch(`${base}/api/v1/conversations/${conversation.conversation_id}/messages`, { method: "POST", headers: headers(base, "message-one"), body: JSON.stringify({ project_id: project.project_id, role: "user", content: "Produza o artifact", mode: "run" }) });
    expect(response.status).toBe(202);
    const receipt = await response.json() as any;
    expect(receipt.run.target).toEqual({ kind: "agent-x", slug: "agent-x" });
    expect(receipt.run.policySnapshotRef).toBe("gauntlet-light-canary");
    expect(receipt.message.run_id).toBe(receipt.run.runId);
    const retry = await fetch(`${base}/api/v1/conversations/${conversation.conversation_id}/messages`, { method: "POST", headers: headers(base, "message-one"), body: JSON.stringify({ project_id: project.project_id, role: "user", content: "Produza o artifact", mode: "run" }) }).then(r => r.json()) as any;
    expect(retry.run.runId).toBe(receipt.run.runId);
    const transcript = await fetch(`${base}/api/v1/conversations/${conversation.conversation_id}`).then(r => r.json()) as any;
    expect(transcript.messages).toHaveLength(1);
    await waitFor(base, project.project_id, receipt.run.runId, "completed");
    const events = await fetch(`${base}/api/v1/projects/${project.project_id}/events`).then(r => r.json()) as any;
    expect(events.events.map((event: any) => event.sequence)).toEqual([...events.events.map((event: any) => event.sequence)].sort((a: number, b: number) => a - b));
    const streamController = new AbortController();
    const stream = await fetch(`${base}/api/v1/projects/${project.project_id}/stream`, { headers: { "last-event-id": "1" }, signal: streamController.signal });
    const chunk = new TextDecoder().decode((await stream.body!.getReader().read()).value); streamController.abort();
    expect(chunk).toContain("id: 2");
    servers.pop().close();
    process.env.NIRVANA_PROJECT_ROOT = root;
    const { startServer } = await import("../lib/glance/server.ts");
    const restarted = await startServer({ port: 0, open: false, idleMin: 60, allowActions: true, theme: "apple", agentXCanaryAdapter: adapter() }); servers.push(restarted);
    const reopened = await fetch(`http://127.0.0.1:${restarted.port}/api/v1/conversations/${conversation.conversation_id}`).then(r => r.json()) as any;
    expect(reopened.messages[0].run_id).toBe(receipt.run.runId);
  }, KERNEL_BUDGET_MS);

  test("missing capability records an honest terminal run", async () => {
    const { project, base } = await start();
    const conversation = await fetch(`${base}/api/v1/projects/${project.project_id}/conversations`, { method: "POST", headers: headers(base, "c2"), body: "{}" }).then(r => r.json()) as any;
    const receipt = await fetch(`${base}/api/v1/conversations/${conversation.conversation_id}/messages`, { method: "POST", headers: headers(base, "missing"), body: JSON.stringify({ project_id: project.project_id, content: "Brief", mode: "run" }) }).then(r => r.json()) as any;
    expect(receipt.queued).toBe(false);
    expect(receipt.run.state).toBe("rolled_back");
    const events = await fetch(`${base}/api/v1/projects/${project.project_id}/events`).then(r => r.json()) as any;
    expect(events.events.at(-1).payload.reason).toBe("capability_unavailable");
  }, KERNEL_BUDGET_MS);

  test("queued run can be cancelled without invoking the adapter", async () => {
    const { project, base } = await start(adapter());
    const conversation = await fetch(`${base}/api/v1/projects/${project.project_id}/conversations`, { method: "POST", headers: headers(base, "c3"), body: "{}" }).then(r => r.json()) as any;
    const receipt = await fetch(`${base}/api/v1/conversations/${conversation.conversation_id}/messages`, { method: "POST", headers: headers(base, "cancel-me"), body: JSON.stringify({ project_id: project.project_id, content: "Brief cancelável", mode: "run" }) }).then(r => r.json()) as any;
    const cancelled = await fetch(`${base}/api/v1/runs/${receipt.run.runId}:cancel`, { method: "POST", headers: headers(base, "cancel-command"), body: JSON.stringify({ project_id: project.project_id }) });
    expect(cancelled.status).toBe(202);
    expect(((await cancelled.json()) as any).state).toBe("rolled_back");
  }, KERNEL_BUDGET_MS);
});

describe("Glance child-process execution", () => {
  test("a Message runs in a child dispatch and the full canonical timeline streams over SSE, resumable by Last-Event-ID", async () => {
    const { project, base, state } = await startWithChild();
    const projectId = project.project_id;
    const cnv = await conversation(base, projectId, "c-stream");
    const streaming = readStream(base, projectId, 0, seen => seen.some(event => event.type === "glance.child_exited"));
    const { status, receipt } = await send(base, projectId, cnv, "m-stream", "Produza o relatório final");
    expect(status).toBe(202);
    expect(receipt.capability).toBe("agent-x.gauntlet.light");
    const { seen, ids } = await streaming;
    expect(ids).toEqual(seen.map((_, index) => index + 1));
    expect(seen.every(event => event.runId === receipt.run.runId)).toBe(true);
    // No prefix and no router on this server: the queue still resolves the route (agent-x by
    // fallback) as the first step of the item, before the child.
    expect(seen.map(typeOf)).toEqual([
      "run.prepared", "x_run_route_resolved", "glance.child_started", "runtime.selection_snapshot", "gauntlet.plan_compiled", "gauntlet.round_started",
      "run.transitioned:running", "gauntlet.candidate_created", "gauntlet.evaluation_recorded", "gauntlet.round_evaluated", "gauntlet.stopped",
      "run.transitioned:verifying", "run.transitioned:completed", "glance.child_exited",
    ]);
    const started = seen.find(event => event.type === "glance.child_started");
    expect(started.payload).toMatchObject({ attempt: 1, argv: expect.arrayContaining(["--agent-x", "--run-id", receipt.run.runId, "--execution-mode=gauntlet", "--gauntlet-intensity=light"]) });
    expect(typeof started.payload.pid).toBe("number");
    expect(seen.at(-1).payload).toMatchObject({ pid: started.payload.pid, attempt: 1, exitCode: 0 });
    const resumed = await readStream(base, projectId, 5, resumedSeen => resumedSeen.length >= seen.length - 5);
    expect(resumed.ids[0]).toBe(6);
    expect(resumed.ids).toEqual(ids.slice(5));
    expect(state(receipt.run.runId).count("producer")).toBe(1);
    expect(state(receipt.run.runId).argv().projectRoot).toBe(path.resolve(process.env.NIRVANA_PROJECT_ROOT!));
    expect(fs.existsSync(path.join(process.env.NIRVANA_PROJECT_ROOT!, ".nirvana", "glance", "runs", receipt.run.runId, "outputs", "result.md"))).toBe(true);
  }, 30000);

  test("the server answers while the child is running", async () => {
    const { project, base, state } = await startWithChild({ FAKE_CHILD_HOLD: "1" });
    const cnv = await conversation(base, project.project_id, "c-responsive");
    const { receipt } = await send(base, project.project_id, cnv, "m-responsive", "Produza devagar");
    const child = state(receipt.run.runId);
    await child.waitFor("holding");
    expect((await waitFor(base, project.project_id, receipt.run.runId, "running")).state).toBe("running");
    for (let i = 0; i < 3; i++) {
      const startedAt = performance.now();
      const response = await fetch(`${base}/api/v1/projects`);
      expect(response.status).toBe(200);
      expect(performance.now() - startedAt).toBeLessThan(500);
    }
    child.release();
    await waitFor(base, project.project_id, receipt.run.runId, "completed");
    // The child transitions the Run and only then writes its marker: wait for the marker instead of
    // reading it the instant the kernel shows completed.
    await child.waitFor("completed");
  }, 30000);

  test("cancel during execution kills the child and settles cancelled", async () => {
    const { project, base, state } = await startWithChild({ FAKE_CHILD_HOLD: "1" });
    const cnv = await conversation(base, project.project_id, "c-cancel");
    const { receipt } = await send(base, project.project_id, cnv, "m-cancel", "Produza e cancele");
    const child = state(receipt.run.runId);
    await child.waitFor("holding");
    const cancelled = await fetch(`${base}/api/v1/runs/${receipt.run.runId}:cancel`, { method: "POST", headers: headers(base, "cancel-running"), body: JSON.stringify({ project_id: project.project_id }) });
    expect(cancelled.status).toBe(202);
    expect(((await cancelled.json()) as any).state).toBe("cancelling");
    await waitFor(base, project.project_id, receipt.run.runId, "cancelled");
    // Windows has no catchable SIGTERM: taskkill /F ends the child before any handler runs, so the
    // fake never writes `killed` there and the exit code is the forced one, never 143.
    if (process.platform !== "win32") await child.waitFor("killed");
    expect(child.has("completed")).toBe(false);
    const seen = (await events(base, project.project_id)).filter(event => event.runId === receipt.run.runId);
    const types = seen.map(typeOf);
    expect(types.indexOf("glance.child_killed")).toBeGreaterThan(types.indexOf("glance.child_started"));
    expect(types.indexOf("run.transitioned:cancelling")).toBeGreaterThan(types.indexOf("glance.child_killed"));
    expect(types.indexOf("glance.child_exited")).toBeGreaterThan(types.indexOf("run.transitioned:cancelling"));
    expect(types.at(-1)).toBe("run.transitioned:cancelled");
    expect(seen.at(-1).payload.reason).toBe("cancelled_by_user");
    const exitCode = seen.find(event => event.type === "glance.child_exited").payload.exitCode;
    if (process.platform === "win32") expect(exitCode).not.toBe(0); else expect(exitCode).toBe(143);
  }, 30000);

  test("a child that exits without a terminal transition fails the run honestly", async () => {
    const { project, base, state } = await startWithChild({ FAKE_CHILD_HOLD: "1", FAKE_CHILD_AFTER_WAIT: "exit" });
    const cnv = await conversation(base, project.project_id, "c-early");
    const { receipt } = await send(base, project.project_id, cnv, "m-early", "Saia cedo");
    const child = state(receipt.run.runId);
    await child.waitFor("holding");
    child.release();
    const run = await waitFor(base, project.project_id, receipt.run.runId, "failed");
    expect(run.state).toBe("failed");
    const seen = (await events(base, project.project_id)).filter(event => event.runId === receipt.run.runId);
    expect(seen.at(-2).type).toBe("glance.child_exited");
    expect(seen.at(-1).payload).toMatchObject({ from: "running", to: "failed", reason: "child_exited_without_terminal_state", exitCode: 0 });
  }, 30000);

  test("`use squad <slug>:` and `use business <slug>:` prepare typed Runs; the standard child adopts them and reaches a real terminal state over SSE", async () => {
    const { project, base, state } = await startWithChild();
    const projectId = project.project_id;
    const cnv = await conversation(base, projectId, "c-target");
    const streaming = readStream(base, projectId, 0, seen => seen.some(event => event.type === "glance.child_exited"));
    const squad = await send(base, projectId, cnv, "m-squad", "use squad brandcraft: produza o manifesto");
    expect(squad.status).toBe(202);
    expect(squad.receipt.run.target).toEqual({ kind: "squad", slug: "brandcraft", capabilityId: "squad.execute" });
    expect(squad.receipt.run.policySnapshotRef).toBe("gauntlet-light-canary");
    expect(squad.receipt.capability).toBe("squad.dispatch");
    // Without --execution-mode=gauntlet the child runs the standard path, which publishes through
    // lib/run-kernel/standard-publication.ts: no Gauntlet events, one run.prepared, a real terminal state.
    const standardTimeline = ["run.prepared", "glance.child_started", "runtime.selection_snapshot", "run.transitioned:running",
      "run.transitioned:verifying", "run.transitioned:completed", "glance.child_exited"];
    const { seen, ids } = await streaming;
    expect(ids).toEqual(seen.map((_, index) => index + 1));
    expect(seen.every(event => event.runId === squad.receipt.run.runId)).toBe(true);
    expect(seen.map(typeOf)).toEqual(standardTimeline);
    expect(seen.find(event => event.type === "run.transitioned" && event.payload.to === "completed").payload).toMatchObject({ from: "verifying", exitCode: 0, gateOutcome: "pass" });
    expect(seen.at(-1).payload).toMatchObject({ attempt: 1, exitCode: 0 });
    const squadRun = await waitFor(base, projectId, squad.receipt.run.runId, "completed");
    expect(squadRun.policySnapshotRef).toBe("gauntlet-light-canary");
    const squadArgv = state(squad.receipt.run.runId).argv().argv;
    expect(squadArgv.slice(0, 2)).toEqual(["--squad", "brandcraft"]);
    expect(squadArgv.some(part => part.startsWith("--execution-mode"))).toBe(false);
    expect(state(squad.receipt.run.runId).count("producer")).toBe(1);
    expect(fs.existsSync(path.join(process.env.NIRVANA_PROJECT_ROOT!, ".nirvana", "glance", "runs", squad.receipt.run.runId, "outputs", "result.md"))).toBe(true);
    const business = await send(base, projectId, cnv, "m-business", "Use business web-studio: landing page");
    expect(business.receipt.run.target).toEqual({ kind: "business", slug: "web-studio" });
    expect(business.receipt.capability).toBe("business.dispatch");
    await waitFor(base, projectId, business.receipt.run.runId, "completed");
    // The child writes `completed` and exits; the queue records glance.child_exited only after the
    // process exit event, so the terminal state alone does not mean the timeline is final.
    await waitForEvent(base, projectId, business.receipt.run.runId, "glance.child_exited");
    expect(state(business.receipt.run.runId).argv().argv.slice(0, 2)).toEqual(["--business", "web-studio"]);
    const all = await events(base, projectId);
    expect(all.filter(event => event.runId === business.receipt.run.runId).map(typeOf)).toEqual(standardTimeline);
    expect(all.find(event => event.type === "runtime.selection_snapshot" && event.runId === squad.receipt.run.runId).idempotencyKey).toBe(`standard:${squad.receipt.run.runId}:execution-snapshot`);
    expect(all.find(event => event.type === "glance.child_started" && event.runId === squad.receipt.run.runId).payload.argv).toEqual(expect.arrayContaining(["--squad", "brandcraft"]));
    expect(all.find(event => event.type === "glance.child_started" && event.runId === business.receipt.run.runId).payload.argv).toEqual(expect.arrayContaining(["--business", "web-studio"]));
    expect(all.filter(event => event.type === "run.prepared").map(event => event.payload.target.kind)).toEqual(["squad", "business"]);
  }, 30000);

  test("an unavailable runner without an in-process adapter rolls the run back as capability_unavailable", async () => {
    const runner: GlanceExecutionRunner = { available: () => false, start() { throw new Error("must not start"); } };
    const { project, base } = await start(undefined, runner);
    const cnv = await conversation(base, project.project_id, "c-unavailable");
    const { status, receipt } = await send(base, project.project_id, cnv, "m-unavailable", "Produza sem runtime");
    expect(status).toBe(200);
    expect(receipt.queued).toBe(false);
    expect(receipt.run.state).toBe("rolled_back");
    const seen = await events(base, project.project_id);
    expect(seen.at(-1).payload).toMatchObject({ reason: "capability_unavailable", capability: "agent-x.gauntlet.light" });
  }, KERNEL_BUDGET_MS);
});

describe("Glance shutdown", () => {
  test("shutdown() detaches the queue before stopping the server, removes the pid file and exits 0", async () => {
    const { shutdown } = await import("../lib/glance/server.ts");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-glance-shutdown-")); roots.push(root);
    const pidFile = path.join(root, ".glance.pid");
    fs.writeFileSync(pidFile, "{}", "utf8");
    const order: string[] = [];
    const watchdog = setInterval(() => order.push("tick"), 60_000);
    shutdown({ stop: () => { order.push("server.stop"); } }, watchdog, () => { order.push("queue.shutdown"); }, code => { order.push(`exit ${code}`); }, pidFile);
    expect(order).toEqual(["queue.shutdown", "server.stop", "exit 0"]);
    expect(fs.existsSync(pidFile)).toBe(false);
  });
});
