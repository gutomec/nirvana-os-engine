// fake-claude-stream.ts — a fake `claude` CLI that speaks the stream-json the maestro turn parses.
//
// `claude -p --output-format stream-json --include-partial-messages` prints one JSON object per
// line: `system/init` with the session, `stream_event` deltas (the tokens), `assistant` messages
// (the tool_use blocks) and one `result` with the final text, the session and the cost. This fake
// emits that shape for whatever prompt arrives on stdin, honours `--resume <sid>` and
// `--session-id <sid>` (it echoes the session it was given) and records every call, so a test can
// assert the argv, the cwd and the env a turn ran with. Zero LLM, zero network.
//
// Knobs live in the state directory (FAKE_CLAUDE_STATE_DIR), so a test can flip them between two
// turns of one server without touching the server's environment:
//   <state>/calls.jsonl   one line per invocation: { argv, cwd, prompt, directive, env (NIRVANA_*, HARNESS_LOGS_DIR) };
//                         `directive` is the --append-system-prompt value, or the content of
//                         --append-system-prompt-file read at call time (the turn removes it on close)
//   <state>/hold          while present, the fake stops after the tool event, writes <state>/pid and
//                         <state>/holding and waits for <state>/go; SIGTERM meanwhile writes
//                         <state>/killed and exits 143 (never on Windows: taskkill /F ends it before
//                         any handler runs, so a test there checks the pid instead)
import * as fs from "node:fs";
import * as path from "node:path";
import { writeFakeCli } from "./fake-cli.ts";

export const FAKE_CLAUDE_COST_USD = 0.0123;
export const FAKE_CLAUDE_TOOL_COMMAND = "nrv find marketing";

const BODY = String.raw`
import * as fs from "node:fs";
import * as path from "node:path";
const argv = Bun.argv.slice(2);
const value = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
const state = process.env.FAKE_CLAUDE_STATE_DIR;
if (state) fs.mkdirSync(state, { recursive: true });
const mark = (name) => { if (state) fs.writeFileSync(path.join(state, name), new Date().toISOString()); };
const prompt = await Bun.stdin.text();
const resumed = value("--resume") ?? null;
const sessionId = resumed ?? value("--session-id") ?? "fake-" + crypto.randomUUID();
if (state) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("NIRVANA_") || key === "HARNESS_LOGS_DIR"));
  const directiveFile = value("--append-system-prompt-file");
  const directive = value("--append-system-prompt") ?? (directiveFile ? fs.readFileSync(directiveFile, "utf8") : null);
  fs.appendFileSync(path.join(state, "calls.jsonl"), JSON.stringify({ argv, cwd: process.cwd(), prompt, directive, env }) + "\n");
}
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\n");
emit({ type: "system", subtype: "init", session_id: sessionId, cwd: process.cwd() });
const reply = (resumed ? "Continuando a sessão " + resumed + ". " : "") + "Resposta para: " + prompt.trim();
for (const word of reply.split(" ")) {
  emit({ type: "stream_event", session_id: sessionId, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: word + " " } } });
}
emit({ type: "assistant", session_id: sessionId, message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_fake", name: "Bash", input: { command: ${JSON.stringify(FAKE_CLAUDE_TOOL_COMMAND)}, description: "Busca no catálogo" } }] } });
if (state && fs.existsSync(path.join(state, "hold"))) {
  process.on("SIGTERM", () => { mark("killed"); process.exit(143); });
  fs.writeFileSync(path.join(state, "pid"), String(process.pid));
  mark("holding");
  const deadline = Date.now() + Number(process.env.FAKE_CLAUDE_WAIT_MAX_MS ?? 30000);
  while (!fs.existsSync(path.join(state, "go"))) {
    if (Date.now() > deadline) { mark("wait-timeout"); process.exit(1); }
    await Bun.sleep(20);
  }
}
emit({ type: "result", subtype: "success", is_error: false, duration_ms: 42, num_turns: 1, result: reply.trim(), session_id: sessionId, total_cost_usd: ${FAKE_CLAUDE_COST_USD} });
`;

export interface FakeClaudeCall { argv: string[]; cwd: string; prompt: string; directive: string | null; env: Record<string, string> }

/** Puts the fake `claude` at the head of PATH and points it at `<dir>/state`; `restore` undoes both. */
export function installFakeClaudeStream(dir: string) {
  const binDir = path.join(dir, "bin");
  const stateDir = path.join(dir, "state");
  writeFakeCli(binDir, "claude", BODY);
  fs.mkdirSync(stateDir, { recursive: true });
  const previous = { PATH: process.env.PATH, FAKE_CLAUDE_STATE_DIR: process.env.FAKE_CLAUDE_STATE_DIR };
  process.env.PATH = `${binDir}${path.delimiter}${previous.PATH ?? ""}`;
  process.env.FAKE_CLAUDE_STATE_DIR = stateDir;
  const marker = (name: string) => path.join(stateDir, name);
  return {
    binDir, stateDir,
    calls(): FakeClaudeCall[] {
      try { return fs.readFileSync(marker("calls.jsonl"), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as FakeClaudeCall); }
      catch { return []; }
    },
    has: (name: string) => fs.existsSync(marker(name)),
    hold() { fs.writeFileSync(marker("hold"), "hold"); },
    release() { try { fs.unlinkSync(marker("hold")); } catch { /* not holding */ } fs.writeFileSync(marker("go"), "go"); },
    /** Clears the hold knobs and markers between tests; the call log is kept. */
    reset() { for (const name of ["hold", "go", "holding", "pid", "killed", "wait-timeout"]) { try { fs.unlinkSync(marker(name)); } catch { /* absent */ } } },
    /** The pid of the fake that is holding (written next to `holding`). */
    heldPid: () => Number(fs.readFileSync(marker("pid"), "utf8")),
    async waitFor(name: string, timeoutMs = 15000) {
      const deadline = Date.now() + timeoutMs;
      while (!fs.existsSync(marker(name))) {
        if (Date.now() > deadline) throw new Error(`fake claude never wrote ${name}`);
        await Bun.sleep(10);
      }
    },
    restore() {
      process.env.PATH = previous.PATH;
      if (previous.FAKE_CLAUDE_STATE_DIR === undefined) delete process.env.FAKE_CLAUDE_STATE_DIR; else process.env.FAKE_CLAUDE_STATE_DIR = previous.FAKE_CLAUDE_STATE_DIR;
    },
  };
}
