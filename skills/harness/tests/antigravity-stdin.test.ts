// antigravity-stdin.test.ts — every agy call sends its prompt on stdin, as one
// stream-json `user` event, and reads the final stream-json `result` event.
//
// Why (agy 1.3.3, live 2026-10-13): above the argv budget (6,000 bytes on
// Windows, so almost every call there) the driver used to send a "read this
// file" message. In `--mode plan` the model reached for a shell command to read
// it, agy auto-denied it, and the router got `response: ""`. The temp path also
// made every message different, so no prefix cache could hit.
// Hermetic: a fake `agy` (helpers/fake-cli.ts AGY_FAKE_PRELUDE). No LLM, no network.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { agyStdinMessage, callHostAgent, MAX_ARGV_PROMPT_BYTES, runHeadless, type RunHeadlessOpts } from "../../_shared/lib/host-agent-driver.ts";
import { AGY_FAKE_PRELUDE, IS_WINDOWS, writeFakeCli } from "./helpers/fake-cli.ts";
import { spawnBudgetMs } from "./helpers/test-budgets.ts";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "agy-stdin-"));
const BIN = path.join(TMP, "bin");
const CALLS = path.join(TMP, "calls.jsonl");
const MODE = path.join(TMP, "mode");
// The driver's own temp directory for these runs: anything it writes lands here.
const CHILD_TMP = path.join(TMP, "tmp");
const TMP_VARS = ["TMPDIR", "TEMP", "TMP"] as const;
const SAVED: Record<string, string | undefined> = { PATH: process.env.PATH };
for (const k of TMP_VARS) SAVED[k] = process.env[k];

beforeAll(() => {
  fs.mkdirSync(CHILD_TMP, { recursive: true });
  writeFakeCli(BIN, "agy", AGY_FAKE_PRELUDE + `
    import * as fs from "node:fs";
    const prompt = await agyPrompt();
    fs.appendFileSync(${JSON.stringify(CALLS)}, JSON.stringify({ argv: agyArgv, prompt, stdin: agyStdinRaw }) + "\\n");
    const mode = fs.existsSync(${JSON.stringify(MODE)}) ? fs.readFileSync(${JSON.stringify(MODE)}, "utf8") : "ok";
    const usage = { input_tokens: 100, output_tokens: 20, thinking_tokens: 5, cache_read_tokens: 60, total_tokens: 125 };
    if (mode === "denied") {
      console.error('jetski: no output produced — a tool required the "command" permission that headless mode cannot prompt for, so it was auto-denied');
      agyReply({ conversation_id: "conv-1", status: "SUCCESS", response: "", denied_actions: [{ action: "command", display_name: "RunCommand" }], usage });
    }
    if (mode === "no-result") {
      console.log(JSON.stringify({ event: "init", conversation_id: "conv-1" }));
      console.error("AGY_ERROR: backend closed the stream");
      process.exit(0);
    }
    agyReply({ conversation_id: "conv-1", status: "SUCCESS", response: "len:" + prompt.length, error: null, duration_seconds: 1, num_turns: 1, usage, denied_actions: [] });
  `);
  process.env.PATH = `${BIN}${path.delimiter}${process.env.PATH}`;
});

afterAll(() => {
  for (const [k, v] of Object.entries(SAVED)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  fs.rmSync(TMP, { recursive: true, force: true });
});

afterEach(() => { for (const k of TMP_VARS) { if (SAVED[k] === undefined) delete process.env[k]; else process.env[k] = SAVED[k]; } });

type Call = { argv: string[]; prompt: string; stdin: string };

function run(mode: string, extra: Partial<RunHeadlessOpts> = {}) {
  fs.writeFileSync(MODE, mode);
  fs.rmSync(CALLS, { force: true });
  // os.tmpdir() follows these, so a temp prompt file would land in CHILD_TMP.
  for (const k of TMP_VARS) process.env[k] = CHILD_TMP;
  const r = runHeadless({ runtime: "antigravity-cli", prompt: "do it", cwd: TMP, timeoutMs: 20_000, ...extra });
  const calls = fs.readFileSync(CALLS, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Call);
  return { r, calls };
}

function expectStdinTransport(call: Call): void {
  const at = call.argv.indexOf("--input-format");
  expect(call.argv[at + 1]).toBe("stream-json");
  expect(call.argv[call.argv.indexOf("--output-format") + 1]).toBe("stream-json");
  // `-p=`, last: a bare `-p` would take the next flag as the prompt.
  expect(call.argv.at(-1)).toBe("-p=");
  expect(call.argv).not.toContain("-p");
  // Exactly one NDJSON line, closed after it.
  const lines = call.stdin.split("\n").filter(Boolean);
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0]).event).toBe("user");
}

describe("antigravity-cli: the prompt travels on stdin", () => {
  test("a long prompt goes through stdin whole, no argv element carries it, no temp file is created", () => {
    const big = "x".repeat(300_000);
    const { r, calls } = run("ok", { prompt: big });
    expect(r.ok, r.error ?? r.stderr).toBe(true);
    expect(calls).toHaveLength(1);
    expectStdinTransport(calls[0]);
    expect(calls[0].prompt).toBe(big);
    for (const a of calls[0].argv) expect(a.length).toBeLessThan(1_000);
    expect(fs.readdirSync(CHILD_TMP)).toEqual([]);
  }, spawnBudgetMs(1));

  test("Windows-length prompts (over the 6,000-byte argv budget there) take the same stdin path, on every OS", () => {
    for (const size of [6_001, MAX_ARGV_PROMPT_BYTES + 1]) {
      const prompt = "y".repeat(size);
      const { r, calls } = run("ok", { prompt });
      expect(r.ok, r.error ?? r.stderr).toBe(true);
      expectStdinTransport(calls[0]);
      expect(calls[0].prompt).toBe(prompt);
      expect(calls[0].argv.some((a) => a.includes("yyyy"))).toBe(false);
    }
    expect(fs.readdirSync(CHILD_TMP)).toEqual([]);
  }, spawnBudgetMs(2));

  test("a short prompt takes stdin too: one transport for every size", () => {
    const { calls } = run("ok", { prompt: "short" });
    expectStdinTransport(calls[0]);
    expect(calls[0].prompt).toBe("short");
  }, spawnBudgetMs(1));

  test("the fixed part is the first bytes of the message content, the request after it", () => {
    const fixed = "# Fixed router instructions\nAnswer with JSON only.";
    const { r, calls } = run("ok", { appendSystemPrompt: fixed, prompt: "Uma landing page — ação" });
    expect(r.ok, r.error ?? r.stderr).toBe(true);
    const content = JSON.parse(calls[0].stdin.trim()).message.content as string;
    expect(content.startsWith(fixed)).toBe(true);
    expect(content).toBe(`${fixed}\n\n---\n\nUma landing page — ação`);
    // The stdin line is exactly the helper's encoding: nothing precedes the fixed part.
    expect(calls[0].stdin).toBe(agyStdinMessage(content));
    expect(calls[0].stdin.startsWith(`{"event":"user","message":{"content":${JSON.stringify(fixed).slice(0, -1)}`)).toBe(true);
  }, spawnBudgetMs(1));

  test("the result event is parsed: answer, conversation id, usage", () => {
    const { r } = run("ok", { prompt: "abc" });
    expect(r.ok, r.error ?? r.stderr).toBe(true);
    expect(r.result).toBe("len:3");
    expect(r.sessionId).toBe("conv-1");
    expect(r.usage).toEqual({ inputTokens: 100, cachedInputTokens: 60, cacheWriteInputTokens: 0, outputTokens: 25, reasoningOutputTokens: 5 });
    expect(r.costUnavailable).toBe(true);
  }, spawnBudgetMs(1));

  test("denied_actions with no answer still fail, in plan mode, on the stdin path", () => {
    const { r, calls } = run("denied", { noTools: true, prompt: "z".repeat(10_000) });
    expect(calls).toHaveLength(1);
    expectStdinTransport(calls[0]);
    expect(calls[0].argv[calls[0].argv.indexOf("--mode") + 1]).toBe("plan");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("command (RunCommand)");
  }, spawnBudgetMs(1));

  test("a resume still passes --conversation <id>, before -p=", () => {
    const { r, calls } = run("ok", { sessionId: "conv-1", prompt: "w".repeat(10_000) });
    expect(r.ok, r.error ?? r.stderr).toBe(true);
    const argv = calls[0].argv;
    expect(argv[argv.indexOf("--conversation") + 1]).toBe("conv-1");
    expectStdinTransport(calls[0]);
    expect(r.resumeLost).toBeUndefined();
  }, spawnBudgetMs(1));

  test("no result event is a failed run carrying the stderr text", () => {
    const { r } = run("no-result");
    expect(r.exitCode).toBe(0);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("AGY_ERROR: backend closed the stream");
  }, spawnBudgetMs(1));

  test("the light layer (callHostAgent) sends on stdin too and returns the response", () => {
    fs.writeFileSync(MODE, "ok");
    fs.rmSync(CALLS, { force: true });
    const res = callHostAgent("persona", "q".repeat(20_000), { preferredHost: "antigravity-cli", timeoutMs: 20_000 });
    expect("error" in res ? res.error : "").toBe("");
    expect((res as { text: string }).text).toBe(`len:${"persona\n\n---\n\n".length + 20_000}`);
    const call = JSON.parse(fs.readFileSync(CALLS, "utf8").trim()) as Call;
    expectStdinTransport(call);
  }, spawnBudgetMs(1));
});

describe("the fake agy holds agy's stdin contract", () => {
  const agy = (input: string) => spawnSync(IS_WINDOWS ? "agy.cmd" : "agy", ["--input-format", "stream-json", "--output-format", "stream-json", "-p="], {
    input, encoding: "utf8", env: process.env, cwd: TMP, ...(IS_WINDOWS ? { shell: true } : {}),
  });

  test("a line with no event is an error", () => {
    fs.writeFileSync(MODE, "ok");
    const r = agy(JSON.stringify({ message: { content: "hi" } }) + "\n");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("no event");
  }, spawnBudgetMs(1));

  test("an unknown event only warns; the block form of a user message is accepted", () => {
    fs.writeFileSync(MODE, "ok");
    const input = JSON.stringify({ event: "user_message", message: { content: "ignored" } }) + "\n"
      + JSON.stringify({ event: "user", message: { role: "user", content: [{ type: "text", text: "hi" }] } }) + "\n";
    const r = agy(input);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('ignoring unsupported stream input message event "user_message"');
    expect(r.stdout).toContain('"response":"len:2"');
  }, spawnBudgetMs(1));
});
