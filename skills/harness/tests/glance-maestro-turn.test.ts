// glance-maestro-turn.test.ts — a Message of an adopted project is one turn of the project's
// runtime session, not a Run: the server spawns the host runtime headless in the project root
// with the conversation's session, the tokens and the tool events reach the chat by SSE, the
// reply is written once as the assistant, and the conversation keeps the session for the next
// turn. The runtime is a fake `claude` that speaks stream-json (helpers/fake-claude-stream.ts),
// so nothing here calls an LLM or the network. Runs with: bun test skills/harness/tests
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MAESTRO_DIRECTIVE, ProjectService, claudeTurnCommand, continuityRecap, maestroDirective } from "../lib/control-plane/index.ts";
import { FAKE_CLAUDE_COST_USD, FAKE_CLAUDE_TOOL_COMMAND, installFakeClaudeStream } from "./helpers/fake-claude-stream.ts";
import { removeDir } from "./helpers/temp-dirs.ts";
import { spawnBudgetMs } from "./helpers/test-budgets.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-glance-maestro-"));
const fake = installFakeClaudeStream(path.join(root, "fake"));
const previousEnv = { NIRVANA_PROJECT_ROOT: process.env.NIRVANA_PROJECT_ROOT, NIRVANA_HOST_RUNTIME: process.env.NIRVANA_HOST_RUNTIME, HARNESS_LOGS_DIR: process.env.HARNESS_LOGS_DIR, NIRVANA_GLANCE_EXECUTION: process.env.NIRVANA_GLANCE_EXECUTION };
let instance: any;
let base = "";
let projectId = "";
const headers = (key = crypto.randomUUID()) => ({ "content-type": "application/json", "idempotency-key": key, origin: base });
const BUDGET = spawnBudgetMs(2);

beforeAll(async () => {
  // The project root is the turn's cwd; the host runtime is pinned so the test never depends on
  // the session that runs it (claude-code here, the fake on PATH).
  process.env.NIRVANA_PROJECT_ROOT = root;
  process.env.NIRVANA_HOST_RUNTIME = "claude-code";
  delete process.env.HARNESS_LOGS_DIR;
  delete process.env.NIRVANA_GLANCE_EXECUTION;
  fs.mkdirSync(path.join(root, ".nirvana"), { recursive: true });
  projectId = new ProjectService().create({ projectRoot: root }).project_id;
  const { startServer } = await import("../lib/glance/server.ts");
  instance = await startServer({ port: 0, open: false, idleMin: 60, allowActions: true, theme: "apple" });
  base = `http://127.0.0.1:${instance.port}`;
});
afterEach(() => { fake.reset(); delete process.env.NIRVANA_GLANCE_EXECUTION; });
afterAll(() => {
  try { instance?.close(); } catch {}
  fake.restore();
  for (const [key, value] of Object.entries(previousEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  removeDir(root);
});

async function newConversation(): Promise<string> {
  return ((await fetch(`${base}/api/v1/projects/${projectId}/conversations`, { method: "POST", headers: headers(), body: "{}" }).then(r => r.json())) as any).conversation_id;
}
async function send(conversationId: string, content: string, extra: Record<string, unknown> = {}, key = crypto.randomUUID()) {
  const response = await fetch(`${base}/api/v1/conversations/${conversationId}/messages`, { method: "POST", headers: headers(key), body: JSON.stringify({ project_id: projectId, role: "user", content, ...extra }) });
  return { status: response.status, receipt: await response.json() as any };
}
/** Reads the turn's SSE until `done`; returns every event in order. */
async function collect(eventsUrl: string, timeoutMs = BUDGET): Promise<any[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const events: any[] = [];
  try {
    const response = await fetch(`${base}${eventsUrl}`, { signal: controller.signal });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let separator: number;
      while ((separator = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, separator); buffer = buffer.slice(separator + 2);
        const data = frame.split("\n").find(line => line.startsWith("data: "));
        if (!data) continue;
        const event = JSON.parse(data.slice(6));
        events.push(event);
        if (event.t === "done") return events;
      }
    }
    return events;
  } finally { clearTimeout(timer); }
}
const conversation = async (id: string) => (await fetch(`${base}/api/v1/conversations/${id}`).then(r => r.json())) as any;
const turnView = async (conversationId: string, turnId: string) => (await fetch(`${base}/api/v1/conversations/${conversationId}/turns/${turnId}`).then(r => r.json())) as any;
async function waitForState(conversationId: string, turnId: string, states: string[], timeoutMs = BUDGET) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const turn = await turnView(conversationId, turnId);
    if (states.includes(turn.state)) return turn;
    if (Date.now() > deadline) throw new Error(`turn ${turnId} stayed ${turn.state}`);
    await Bun.sleep(25);
  }
}
const auditLines = () => {
  const file = path.join(root, ".nirvana", "logs", "harness", new Date().toISOString().slice(0, 10), "audit.jsonl");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
};

describe("the maestro directive", () => {
  test("is a short PT-BR system-prompt suffix, never the harness SKILL.md", () => {
    expect(MAESTRO_DIRECTIVE.length).toBeLessThan(3000);
    expect(MAESTRO_DIRECTIVE).toContain("maestro do Nirvana-OS DESTE projeto");
    expect(MAESTRO_DIRECTIVE).toContain("Nunca pule o gate");
    expect(MAESTRO_DIRECTIVE).toContain("use business <slug>:");
    expect(MAESTRO_DIRECTIVE).not.toContain("## Dispatch cascade");
    expect(maestroDirective(root)).toStartWith(MAESTRO_DIRECTIVE);
  });

  test("the claude command line follows the driver's autonomy rule and names the session up front", () => {
    const fresh = claudeTurnCommand({ sessionId: null, directive: "d", skipPermissions: true, maxBudgetUsd: 5 });
    expect(fresh.args.slice(0, 5)).toEqual(["-p", "--output-format", "stream-json", "--include-partial-messages", "--verbose"]);
    expect(fresh.args[fresh.args.indexOf("--session-id") + 1]).toBe(fresh.sessionId);
    expect(fresh.args).toContain("--dangerously-skip-permissions");
    expect(fresh.args[fresh.args.indexOf("--max-budget-usd") + 1]).toBe("5");
    const resumed = claudeTurnCommand({ sessionId: "sid-1", directive: "d", skipPermissions: false, maxBudgetUsd: 0 });
    expect(resumed.args[resumed.args.indexOf("--resume") + 1]).toBe("sid-1");
    expect(resumed.args).not.toContain("--session-id");
    expect(resumed.args).not.toContain("--dangerously-skip-permissions");
    expect(resumed.args[resumed.args.indexOf("--permission-mode") + 1]).toBe("acceptEdits");
    expect(resumed.args).not.toContain("--max-budget-usd");
  });

  test("the continuity recap carries the last visible messages, labelled, without the current one", () => {
    const recap = continuityRecap([
      { message_id: "m1", role: "user", content: "Quais empresas eu tenho?" }, { message_id: "m2", role: "assistant", content: "Três: a, b e c." },
      { message_id: "m3", role: "system", content: "infra" }, { message_id: "m4", role: "user", content: "E para jurídico?" },
    ], "m4");
    expect(recap).toStartWith("Recapitulação da conversa");
    expect(recap).toContain("- usuário: Quais empresas eu tenho?");
    expect(recap).toContain("- assistente: Três: a, b e c.");
    expect(recap).not.toContain("jurídico");
    expect(recap).not.toContain("infra");
  });
});

describe("a Message is a turn of the project's runtime session", () => {
  test("(a) the first turn creates the session, runs in the project root and persists session_id and session_runtime", async () => {
    const id = await newConversation();
    const { status, receipt } = await send(id, "Quais empresas eu tenho para marketing?");
    expect(status).toBe(202);
    expect(receipt.run).toBeUndefined();
    expect(receipt.turn.state).toMatch(/^(queued|running)$/);
    expect(receipt.turn.runtime).toBe("claude-code");
    expect(receipt.turn.session_id).toBeTruthy();
    expect(receipt.session).toEqual({ session_id: null, session_runtime: null, resume_command: null });
    const events = await collect(receipt.events_url);
    const done = events.at(-1);
    expect(done.state).toBe("completed");
    expect(done.session_id).toBe(receipt.turn.session_id);
    expect(done.cost_usd).toBe(FAKE_CLAUDE_COST_USD);
    const [call] = fake.calls().slice(-1);
    expect(call.argv[call.argv.indexOf("--session-id") + 1]).toBe(receipt.turn.session_id);
    expect(call.argv).not.toContain("--resume");
    expect(call.argv).toContain("--dangerously-skip-permissions");
    expect(call.argv[call.argv.indexOf("--append-system-prompt") + 1]).toStartWith(MAESTRO_DIRECTIVE);
    expect(call.prompt).toBe("Quais empresas eu tenho para marketing?");
    expect(fs.realpathSync(call.cwd)).toBe(fs.realpathSync(root));
    expect(call.env.NIRVANA_PROJECT_ROOT).toBe(root);
    expect(call.env.HARNESS_LOGS_DIR).toBe(path.join(root, ".nirvana", "logs", "harness"));
    const opened = await conversation(id);
    expect(opened.session_id).toBe(receipt.turn.session_id);
    expect(opened.session_runtime).toBe("claude-code");
    expect(opened.session_started_at).toBeTruthy();
    expect(opened.last_turn_at).toBeTruthy();
    expect(opened.session.resume_command).toBe(`claude --resume ${receipt.turn.session_id}`);
    expect(opened.active_turn).toBeNull();
    const cost = auditLines().find(event => event.event === "cost_emission" && event.turn_id === receipt.turn.turn_id);
    expect(cost.total_cost_usd).toBe(FAKE_CLAUDE_COST_USD);
    expect(cost.project_id).toBe(projectId);
    expect(cost.session_id).toBe(receipt.turn.session_id);
    expect(cost.trace_id).toBe(receipt.turn.session_id);
  }, BUDGET);

  test("(b) the second turn resumes the session with --resume <sid> and the reply shows continuity", async () => {
    const id = await newConversation();
    const first = await send(id, "Primeira");
    await collect(first.receipt.events_url);
    const second = await send(id, "E para jurídico?");
    expect(second.receipt.session.session_id).toBe(first.receipt.turn.session_id);
    expect(second.receipt.turn.session_id).toBe(first.receipt.turn.session_id);
    const events = await collect(second.receipt.events_url);
    const [call] = fake.calls().slice(-1);
    expect(call.argv[call.argv.indexOf("--resume") + 1]).toBe(first.receipt.turn.session_id);
    expect(call.argv).not.toContain("--session-id");
    expect(events.at(-1).result).toStartWith(`Continuando a sessão ${first.receipt.turn.session_id}.`);
    expect((await conversation(id)).session_id).toBe(first.receipt.turn.session_id);
  }, BUDGET);

  test("(c) tokens arrive by SSE and the assistant message is written once", async () => {
    const id = await newConversation();
    const { receipt } = await send(id, "Oi");
    const events = await collect(receipt.events_url);
    const tokens = events.filter(event => event.t === "tok").map(event => event.v).join("");
    expect(tokens.trim()).toBe("Resposta para: Oi");
    const done = events.at(-1);
    expect(done.result).toBe("Resposta para: Oi");
    // A late subscriber replays the same events and ends at the same `done`.
    const replay = await collect(receipt.events_url);
    expect(replay.map(event => event.t)).toEqual(events.map(event => event.t));
    const messages = (await conversation(id)).messages;
    expect(messages.map((message: any) => [message.role, message.content])).toEqual([["user", "Oi"], ["assistant", "Resposta para: Oi"]]);
    expect((await turnView(id, receipt.turn.turn_id)).result_message_id).toBe(messages[1].message_id);
  }, BUDGET);

  test("(d) tool events are relayed with the command the maestro ran", async () => {
    const id = await newConversation();
    const { receipt } = await send(id, "Procure");
    const events = await collect(receipt.events_url);
    expect(events.filter(event => event.t === "tool")).toEqual([{ t: "tool", name: "Bash", cmd: FAKE_CLAUDE_TOOL_COMMAND }]);
  }, BUDGET);

  test("(e) cancelling signals the process group and marks the turn cancelled", async () => {
    fake.hold();
    const id = await newConversation();
    const { receipt } = await send(id, "Demorado");
    await fake.waitFor("holding");
    expect((await conversation(id)).active_turn.turn_id).toBe(receipt.turn.turn_id);
    const cancelled = await fetch(`${base}/api/v1/conversations/${id}/turns/${receipt.turn.turn_id}:cancel`, { method: "POST", headers: headers(), body: JSON.stringify({ project_id: projectId }) });
    expect(cancelled.status).toBe(202);
    expect(((await cancelled.json()) as any).state).toBe("cancelling");
    await fake.waitFor("killed");
    const turn = await waitForState(id, receipt.turn.turn_id, ["cancelled"]);
    expect(turn.reason).toBe("cancelled_by_user");
    const events = await collect(receipt.events_url);
    expect(events.at(-1)).toMatchObject({ t: "done", state: "cancelled", ok: false });
    expect((await conversation(id)).messages.map((message: any) => message.role)).toEqual(["user"]);
    expect((await fetch(`${base}/api/v1/conversations/${id}/turns/${receipt.turn.turn_id}:cancel`, { method: "POST", headers: headers(), body: JSON.stringify({ project_id: projectId }) })).status).toBe(409);
  }, BUDGET);

  test("(f) mode: \"run\" keeps the Run path of the canary queue", async () => {
    const id = await newConversation();
    const { status, receipt } = await send(id, "Produza o artifact", { mode: "run" });
    // No execution runner on this server: the Run is prepared and rolled back, as before.
    expect(status).toBe(200);
    expect(receipt.turn).toBeUndefined();
    expect(receipt.run.runId).toStartWith("run_");
    expect(receipt.run.state).toBe("rolled_back");
    expect(receipt.queued).toBe(false);
    expect(receipt.message.run_id).toBe(receipt.run.runId);
    expect(fake.calls().some(call => call.prompt === "Produza o artifact")).toBe(false);
  }, BUDGET);

  test("(g) glance.execution=false answers capability_unavailable without spawning", async () => {
    process.env.NIRVANA_GLANCE_EXECUTION = "0";
    const id = await newConversation();
    const before = fake.calls().length;
    const { status, receipt } = await send(id, "Oi");
    expect(status).toBe(200);
    expect(receipt.queued).toBe(false);
    expect(receipt.turn.state).toBe("unavailable");
    expect(receipt.turn.reason).toBe("capability_unavailable");
    expect(receipt.turn.detail).toBe("glance.execution=false");
    expect(receipt.message.content).toBe("Oi");
    expect(fake.calls().length).toBe(before);
    expect((await fetch(`${base}/api/v1/conversations/${id}/turns/${receipt.turn.turn_id}`)).status).toBe(404);
  }, BUDGET);

  test("(h) two Messages in one conversation serialize: the second waits, then resumes the same session", async () => {
    fake.hold();
    const id = await newConversation();
    const first = await send(id, "Primeira");
    await fake.waitFor("holding");
    const second = await send(id, "Segunda");
    expect(second.status).toBe(202);
    expect(second.receipt.turn.state).toBe("queued");
    expect(second.receipt.turn.position).toBe(1);
    const spawnedWhileHolding = fake.calls().length;
    fake.release();
    const firstEvents = await collect(first.receipt.events_url);
    const secondEvents = await collect(second.receipt.events_url);
    expect(firstEvents.at(-1).state).toBe("completed");
    expect(secondEvents.at(-1).state).toBe("completed");
    const calls = fake.calls();
    expect(calls.length).toBe(spawnedWhileHolding + 1);
    const [last] = calls.slice(-1);
    expect(last.prompt).toBe("Segunda");
    expect(last.argv[last.argv.indexOf("--resume") + 1]).toBe(first.receipt.turn.session_id);
    expect((await conversation(id)).messages.map((message: any) => message.content)).toEqual(["Primeira", "Segunda", "Resposta para: Primeira", `Continuando a sessão ${first.receipt.turn.session_id}. Resposta para: Segunda`]);
  }, BUDGET);

  test("a Run the maestro opens during the turn reaches the bubble as a run event", async () => {
    fake.hold();
    const id = await newConversation();
    const { receipt } = await send(id, "Produza");
    await fake.waitFor("holding");
    const dir = path.join(root, ".nirvana", "logs", "harness", new Date().toISOString().slice(0, 10));
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "audit.jsonl"), JSON.stringify({ ts: new Date().toISOString(), event: "x_ledger_run_opened", trace_id: "trace_maestro", run_id: "run-maestro-1", target_slug: "web-studio", target_kind: "business", runtime: "claude-code" }) + "\n");
    fake.release();
    const events = await collect(receipt.events_url);
    expect(events.find(event => event.t === "run")).toEqual({ t: "run", run_id: "run-maestro-1", trace_id: "trace_maestro", target_slug: "web-studio", target_kind: "business", runtime: "claude-code" });
    expect((await turnView(id, receipt.turn.turn_id)).runs).toHaveLength(1);
  }, BUDGET);
});
