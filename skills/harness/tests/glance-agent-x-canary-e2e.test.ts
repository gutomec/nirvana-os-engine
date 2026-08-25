import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { GlanceAgentXCanaryAdapter } from "../lib/control-plane/index.ts";

const roots: string[] = [];
const servers: any[] = [];
afterEach(() => {
  while (servers.length) try { servers.pop().server.stop(true); } catch {}
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
  delete process.env.NIRVANA_PROJECT_ROOT;
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
      evaluate({ runId, artifactRefs }) { return [{ evaluationId: `evl_${runId}`, candidateId: "can_1", revisionId: `crv_${runId}_1`, gauntletId: "brief-conformance",
        rubricVersion: "test/v1", verdict: "pass", dimensions: [{ id: "brief", score: 1, confidence: 1, blocking: true, passed: true, evidenceRefs: artifactRefs.map(ref => ref.revisionId) }],
        regressions: [], revisionRequests: [], evaluator: this.target, costUsd: 0, createdAt: new Date().toISOString() }]; },
    },
    finalGate: () => ({ exitCode: 0, gateOutcome: "pass" }),
  };
}

async function start(canary?: GlanceAgentXCanaryAdapter) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-glance-canary-")); roots.push(root);
  process.env.NIRVANA_PROJECT_ROOT = root;
  fs.mkdirSync(path.join(root, ".nirvana"), { recursive: true });
  const { ProjectService } = await import("../lib/control-plane/project-service.ts");
  const project = new ProjectService().create({ projectRoot: root });
  const { startServer } = await import("../lib/glance/server.ts");
  const server = await startServer({ port: 0, open: false, idleMin: 60, allowActions: true, theme: "apple", agentXCanaryAdapter: canary });
  servers.push(server);
  return { root, project, base: `http://127.0.0.1:${server.port}` };
}

const headers = (base: string, key: string) => ({ "content-type": "application/json", origin: base, "idempotency-key": key });
async function waitFor(base: string, projectId: string, runId: string, state: string) {
  for (let i = 0; i < 100; i++) {
    const run = await fetch(`${base}/api/v1/runs/${runId}?project_id=${projectId}`).then(r => r.json()) as any;
    if (run.state === state) return run;
    await Bun.sleep(10);
  }
  throw new Error(`run did not reach ${state}`);
}

describe("Glance agent-x light canary", () => {
  test("message prepares one linked run, executes through adapter and survives restart", async () => {
    const { root, project, base } = await start(adapter());
    const conversation = await fetch(`${base}/api/v1/projects/${project.project_id}/conversations`, { method: "POST", headers: headers(base, "conversation"), body: "{}" }).then(r => r.json()) as any;
    const response = await fetch(`${base}/api/v1/conversations/${conversation.conversation_id}/messages`, { method: "POST", headers: headers(base, "message-one"), body: JSON.stringify({ project_id: project.project_id, role: "user", content: "Produza o artifact" }) });
    expect(response.status).toBe(202);
    const receipt = await response.json() as any;
    expect(receipt.run.target).toEqual({ kind: "agent-x", slug: "agent-x" });
    expect(receipt.run.policySnapshotRef).toBe("gauntlet-light-canary");
    expect(receipt.message.run_id).toBe(receipt.run.runId);
    const retry = await fetch(`${base}/api/v1/conversations/${conversation.conversation_id}/messages`, { method: "POST", headers: headers(base, "message-one"), body: JSON.stringify({ project_id: project.project_id, role: "user", content: "Produza o artifact" }) }).then(r => r.json()) as any;
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
    servers.pop().server.stop(true);
    process.env.NIRVANA_PROJECT_ROOT = root;
    const { startServer } = await import("../lib/glance/server.ts");
    const restarted = await startServer({ port: 0, open: false, idleMin: 60, allowActions: true, theme: "apple", agentXCanaryAdapter: adapter() }); servers.push(restarted);
    const reopened = await fetch(`http://127.0.0.1:${restarted.port}/api/v1/conversations/${conversation.conversation_id}`).then(r => r.json()) as any;
    expect(reopened.messages[0].run_id).toBe(receipt.run.runId);
  });

  test("missing capability records an honest terminal run", async () => {
    const { project, base } = await start();
    const conversation = await fetch(`${base}/api/v1/projects/${project.project_id}/conversations`, { method: "POST", headers: headers(base, "c2"), body: "{}" }).then(r => r.json()) as any;
    const receipt = await fetch(`${base}/api/v1/conversations/${conversation.conversation_id}/messages`, { method: "POST", headers: headers(base, "missing"), body: JSON.stringify({ project_id: project.project_id, content: "Brief" }) }).then(r => r.json()) as any;
    expect(receipt.queued).toBe(false);
    expect(receipt.run.state).toBe("rolled_back");
    const events = await fetch(`${base}/api/v1/projects/${project.project_id}/events`).then(r => r.json()) as any;
    expect(events.events.at(-1).payload.reason).toBe("capability_unavailable");
  });

  test("queued run can be cancelled without invoking the adapter", async () => {
    const { project, base } = await start(adapter());
    const conversation = await fetch(`${base}/api/v1/projects/${project.project_id}/conversations`, { method: "POST", headers: headers(base, "c3"), body: "{}" }).then(r => r.json()) as any;
    const receipt = await fetch(`${base}/api/v1/conversations/${conversation.conversation_id}/messages`, { method: "POST", headers: headers(base, "cancel-me"), body: JSON.stringify({ project_id: project.project_id, content: "Brief cancelável" }) }).then(r => r.json()) as any;
    const cancelled = await fetch(`${base}/api/v1/runs/${receipt.run.runId}:cancel`, { method: "POST", headers: headers(base, "cancel-command"), body: JSON.stringify({ project_id: project.project_id }) });
    expect(cancelled.status).toBe(202);
    expect(((await cancelled.json()) as any).state).toBe("rolled_back");
  });
});
