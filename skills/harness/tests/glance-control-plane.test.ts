import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-glance-control-"));
let instance: any;
let base = "";
let projectId = "";
const headers = (key = crypto.randomUUID()) => ({ "content-type": "application/json", "idempotency-key": key, origin: base });

beforeAll(async () => {
  process.env.NIRVANA_PROJECT_ROOT = root;
  fs.mkdirSync(path.join(root, ".nirvana"), { recursive: true });
  const { startServer } = await import("../lib/glance/server.ts");
  instance = await startServer({ port: 0, open: false, idleMin: 60, allowActions: true, theme: "apple" });
  base = `http://127.0.0.1:${instance.port}`;
});
afterAll(() => {
  try { instance?.server.stop(true); } catch {}
  delete process.env.NIRVANA_PROJECT_ROOT;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("Glance project control plane", () => {
  test("legacy discovery is read-only and adoption is explicit", async () => {
    const before = await fetch(`${base}/api/v1/projects`).then(r => r.json()) as any;
    expect(before.projects).toHaveLength(0);
    expect(before.legacy).toHaveLength(1);
    expect(fs.existsSync(path.join(root, ".nirvana", "project.yaml"))).toBe(false);
    const response = await fetch(`${base}/api/v1/projects:adopt`, { method: "POST", headers: headers(), body: JSON.stringify({ plan_hash: before.legacy[0].plan_hash, scope: "merge" }) });
    expect(response.status).toBe(201);
    projectId = ((await response.json()) as any).project_id;
    expect(projectId).toStartWith("prj_");
  });

  test("requires idempotency and rejects foreign origins and traversal", async () => {
    expect((await fetch(`${base}/api/v1/projects`, { method: "POST", headers: { "content-type": "application/json", origin: base }, body: "{}" })).status).toBe(400);
    expect((await fetch(`${base}/api/v1/projects`, { method: "POST", headers: { ...headers(), origin: "https://evil.example" }, body: "{}" })).status).toBe(403);
    expect((await fetch(`${base}/api/v1/projects/plan`, { method: "POST", headers: headers(), body: JSON.stringify({ relative_root: "../escape" }) })).status).toBe(400);
  });

  test("persists conversation messages and keeps entities separate", async () => {
    const conversation = await fetch(`${base}/api/v1/projects/${projectId}/conversations`, { method: "POST", headers: headers(), body: JSON.stringify({ title: "Workspace" }) }).then(r => r.json()) as any;
    expect(conversation.conversation_id).toStartWith("cnv_");
    const message = await fetch(`${base}/api/v1/conversations/${conversation.conversation_id}/messages`, { method: "POST", headers: headers(), body: JSON.stringify({ project_id: projectId, role: "user", content: "Brief persistente" }) }).then(r => r.json()) as any;
    expect(message.sequence).toBe(1);
    const opened = await fetch(`${base}/api/v1/conversations/${conversation.conversation_id}`).then(r => r.json()) as any;
    expect(opened.messages.map((item: any) => item.content)).toEqual(["Brief persistente"]);
  });

  test("returns journal events in sequence and resumes SSE after cursor", async () => {
    const target = { kind: "squad", slug: "systems-atelier", capabilityId: "software.project-control-plane.implement" };
    const first = await fetch(`${base}/api/v1/runs`, { method: "POST", headers: headers("run-one"), body: JSON.stringify({ project_id: projectId, target }) }).then(r => r.json()) as any;
    await fetch(`${base}/api/v1/runs`, { method: "POST", headers: headers("run-two"), body: JSON.stringify({ project_id: projectId, target }) });
    const page = await fetch(`${base}/api/v1/projects/${projectId}/events?after=0`).then(r => r.json()) as any;
    expect(page.events.map((event: any) => event.sequence)).toEqual([1, 2]);
    expect(page.events[0].payload.target.slug).toBe("systems-atelier");
    const controller = new AbortController();
    const response = await fetch(`${base}/api/v1/projects/${projectId}/stream`, { headers: { "last-event-id": "1" }, signal: controller.signal });
    const reader = response.body!.getReader();
    const chunk = new TextDecoder().decode((await reader.read()).value);
    controller.abort();
    expect(chunk).toContain("id: 2");
    expect(chunk).not.toContain(`id: 1\n`);
    expect((await fetch(`${base}/api/v1/runs/${first.runId}?project_id=${projectId}`).then(r => r.json()) as any).target.kind).toBe("squad");
  });
});
