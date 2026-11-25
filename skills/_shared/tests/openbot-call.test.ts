// openbot-call.test.ts — handing work to an OpenBot agent, against a local
// stand-in for the app's automation API and a database in its shape.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  askOpenBot, collectOpenBotFiles, openBotSpecialists, openBotSpecialistsDirective, parseDuration, resumeOpenBot,
  OPENBOT_TASK_NOTE,
} from "../lib/openbot-call.ts";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nrv-openbot-call-")));
const automation = path.join(root, "automation");
const dbFile = path.join(root, "openbot.db");
const workspace = path.join(root, "OpenBot", "Agents", "agent-image");
const saved: Record<string, string | undefined> = {};
const ENV = {
  NIRVANA_OPENBOT_AUTOMATION_DIR: automation, NIRVANA_OPENBOT_DB: dbFile,
  NIRVANA_OPENBOT_DIR: path.join(root, "OpenBot"), NIRVANA_HOME: path.join(root, "nirvana"),
};

/** What the stand-in answers next, set by each test. */
let script: { status: string; answer?: string; error?: string; pending?: any; onMessage?: () => void } = { status: "completed" };
let received: any = null;
let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  for (const [k, v] of Object.entries(ENV)) { saved[k] = process.env[k]; process.env[k] = v; }
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(automation, { recursive: true });
  const db = new Database(dbFile);
  db.run("CREATE TABLE projection_agents (agent_id TEXT PRIMARY KEY, agent_json TEXT NOT NULL)");
  const put = (id: string, doc: object) => db.run("INSERT INTO projection_agents VALUES (?, ?)", [id, JSON.stringify(doc)]);
  put("agent-image", { name: "Image Studio", description: "Makes images for web projects.", provider: "codex", workspacePath: workspace, allowAutomation: true });
  put("agent-closed", { name: "Closed", description: "Not open to scripts.", provider: "claude", allowAutomation: false });
  put("agent-plain", { name: "Plain", provider: "claude" });
  db.close();
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.headers.get("authorization") !== "Bearer secret") return Response.json({ error: "bad token" }, { status: 401 });
      if (url.pathname === "/v1/agents") return Response.json([{ id: "agent-image", name: "Image Studio" }]);
      if (url.pathname.endsWith("/messages")) {
        received = await req.json();
        script.onMessage?.();
        return Response.json({ messageId: "m1", deliveries: [{ id: "d1", recipientAgentId: "agent-image", status: "queued" }] });
      }
      if (url.pathname.endsWith("/deliveries/d1")) return Response.json({ id: "d1", status: script.status, answer: script.answer ?? null, error: script.error ?? null });
      if (url.pathname.endsWith("/pending")) return Response.json(script.pending ?? { prompts: [], approvals: [], browserTakeovers: [] });
      return Response.json({ error: "no route" }, { status: 404 });
    },
  });
  fs.writeFileSync(path.join(automation, "url"), `http://127.0.0.1:${server.port}\n`);
  fs.writeFileSync(path.join(automation, "token"), "secret\n");
});

afterEach(() => { script = { status: "completed" }; received = null; });

afterAll(() => {
  server.stop(true);
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(root, { recursive: true, force: true });
});

describe("who can be called", () => {
  test("only the agents the person opened to local scripts", () => {
    const list = openBotSpecialists();
    expect(list.map((a) => a.name)).toEqual(["Image Studio"]);
    expect(list[0]).toMatchObject({ id: "agent-image", provider: "codex", workspace });
  });

  test("the agent that runs the command is left out", () => {
    expect(openBotSpecialists(undefined, workspace)).toEqual([]);
  });

  test("the worker's block names each one and the command; empty when the app is closed", () => {
    const block = openBotSpecialistsDirective();
    expect(block).toContain('"Image Studio" (codex): Makes images for web projects.');
    expect(block).toContain("nrv bot ask");
    const url = path.join(automation, "url");
    const kept = fs.readFileSync(url, "utf8");
    fs.rmSync(url);
    try { expect(openBotSpecialistsDirective()).toBe(""); } finally { fs.writeFileSync(url, kept); }
  });
});

describe("a call", () => {
  test("done: the task carries the note, and the files the agent made are copied", async () => {
    script = {
      status: "completed", answer: "Saved hero.png.",
      onMessage: () => {
        fs.mkdirSync(path.join(workspace, "deliveries"), { recursive: true });
        fs.writeFileSync(path.join(workspace, "deliveries", "hero.png"), "png");
        fs.writeFileSync(path.join(workspace, "AGENTS.md"), "its own instructions");
      },
    };
    const out = path.join(root, "out-done");
    const r = await askOpenBot("image studio", "A hero image.", { outDir: out, timeoutMs: 10_000 });
    expect(r.state).toBe("done");
    expect(r.answer).toBe("Saved hero.png.");
    expect(received.text).toBe(`A hero image.\n\n${OPENBOT_TASK_NOTE}`);
    expect(r.files).toEqual([path.join(out, "deliveries", "hero.png")]);
    expect(fs.existsSync(path.join(out, "AGENTS.md"))).toBe(false);
  });

  test("the agent waits for its person: the question comes back, and status finishes the call", async () => {
    script = {
      status: "running",
      pending: { prompts: [{ questions: [{ question: "Attach the PNG?", options: [{ label: "Attach" }, { label: "Keep" }] }] }], approvals: [], browserTakeovers: [] },
    };
    const out = path.join(root, "out-wait");
    const r = await askOpenBot("agent-image", "An icon.", { outDir: out, timeoutMs: 10_000 });
    expect(r.state).toBe("needs-person");
    expect(r.waitingFor).toEqual(["Attach the PNG? [Attach | Keep]"]);
    expect(r.files).toEqual([]);

    fs.writeFileSync(path.join(workspace, "icon.png"), "png");
    script = { status: "completed", answer: "Attached." };
    const done = await resumeOpenBot("d1", { timeoutMs: 10_000 });
    expect(done.state).toBe("done");
    expect(done.files).toContain(path.join(out, "icon.png"));
    expect((await resumeOpenBot("d1", { timeoutMs: 1000 })).state).toBe("unreachable");
  });

  test("a failed turn, an unknown agent and a wait that runs out", async () => {
    script = { status: "failed", error: "provider limit" };
    const failed = await askOpenBot("Image Studio", "x", { outDir: path.join(root, "o1"), timeoutMs: 5000 });
    expect(failed).toMatchObject({ state: "failed", reason: "provider limit" });

    const unknown = await askOpenBot("Nobody", "x", { outDir: path.join(root, "o2"), timeoutMs: 5000 });
    expect(unknown.state).toBe("unreachable");
    expect(unknown.reason).toContain("nrv bot list");

    script = { status: "running" };
    const slow = await askOpenBot("Image Studio", "x", { outDir: path.join(root, "o3"), timeoutMs: 1 });
    expect(slow.state).toBe("timed-out");
    expect(slow.deliveryId).toBe("d1");
  });

  test("OpenBot closed: the answer says how the person opens an agent", async () => {
    const url = path.join(automation, "url");
    const kept = fs.readFileSync(url, "utf8");
    fs.rmSync(url);
    try {
      const r = await askOpenBot("Image Studio", "x", { outDir: path.join(root, "o4"), timeoutMs: 1000 });
      expect(r.state).toBe("unreachable");
      expect(r.reason).toContain("Local scripts");
    } finally { fs.writeFileSync(url, kept); }
  });
});

test("only files made since the call started are copied; hidden folders are skipped", () => {
  const ws = path.join(root, "ws");
  fs.mkdirSync(path.join(ws, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(ws, "old.png"), "old");
  fs.utimesSync(path.join(ws, "old.png"), new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
  fs.writeFileSync(path.join(ws, "new.png"), "new");
  fs.writeFileSync(path.join(ws, ".claude", "x.json"), "{}");
  const out = path.join(root, "out-since");
  expect(collectOpenBotFiles(ws, Date.now() - 5000, out)).toEqual([path.join(out, "new.png")]);
});

test("durations", () => {
  expect(parseDuration("90")).toBe(90_000);
  expect(parseDuration("10m")).toBe(600_000);
  expect(parseDuration("2h")).toBe(7_200_000);
  expect(parseDuration("soon")).toBeNull();
});
