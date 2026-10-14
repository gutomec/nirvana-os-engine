// antigravity-answer-only.test.ts — an answer-only agy call (the routers) runs
// in plan mode, says so to its hooks, keeps the fixed part of its prompt first,
// and fails loudly when agy denied the tools it asked for.
//
// Live facts these fakes reproduce (agy 1.3.3, 2026-10-13): `--mode plan`
// without --dangerously-skip-permissions answers a JSON-only prompt normally;
// a tool needing a permission is auto-denied with exit 0,
// `{"status":"SUCCESS","response":"","denied_actions":[...]}` on stdout and a
// "jetski: no output produced" line on stderr.
// Hermetic: a fake `agy` that records argv, env and the stdin message. No LLM,
// no network.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ANSWER_ONLY_ENV, runHeadless, type RunHeadlessOpts } from "../../_shared/lib/host-agent-driver.ts";
import { buildCardsRequest, buildCardsStatic } from "../lib/cards-router.ts";
import { AGY_FAKE_PRELUDE, writeFakeCli } from "./helpers/fake-cli.ts";
import { spawnBudgetMs } from "./helpers/test-budgets.ts";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "agy-answer-only-"));
const BIN = path.join(TMP, "bin");
const CALLS = path.join(TMP, "calls.jsonl");
const MODE = path.join(TMP, "mode");
const PATH_BEFORE = process.env.PATH;

beforeAll(() => {
  writeFakeCli(BIN, "agy", AGY_FAKE_PRELUDE + `
    import * as fs from "node:fs";
    const prompt = await agyPrompt();
    fs.appendFileSync(${JSON.stringify(CALLS)}, JSON.stringify({
      argv: Bun.argv.slice(2),
      prompt,
      stdin: agyStdinRaw,
      answerOnly: process.env.NIRVANA_ANSWER_ONLY ?? null,
      depth: process.env.NIRVANA_DISPATCH_DEPTH ?? null,
    }) + "\\n");
    const mode = fs.existsSync(${JSON.stringify(MODE)}) ? fs.readFileSync(${JSON.stringify(MODE)}, "utf8") : "ok";
    const usage = { input_tokens: 10, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 10 };
    if (mode === "denied-write" || mode === "denied-command") {
      const denied = mode === "denied-write"
        ? [{ action: "write_file", display_name: "WriteToFile" }]
        : [{ action: "command", display_name: "RunCommand" }];
      console.error('jetski: no output produced — a tool required the "' + denied[0].action + '" permission that headless mode cannot prompt for, so it was auto-denied');
      agyReply({ conversation_id: "conv-1", status: "SUCCESS", response: "", denied_actions: denied, usage });
    }
    if (mode === "denied-but-answered") {
      agyReply({ conversation_id: "conv-1", status: "SUCCESS", response: "{\\"target\\":\\"solo\\"}", denied_actions: [{ action: "write_file" }], usage });
    }
    agyReply({ conversation_id: "conv-1", status: "SUCCESS", response: "{\\"target\\":\\"solo\\"}", usage });
  `);
  process.env.PATH = `${BIN}${path.delimiter}${process.env.PATH}`;
});

afterAll(() => {
  process.env.PATH = PATH_BEFORE;
  fs.rmSync(TMP, { recursive: true, force: true });
});

type Call = { argv: string[]; prompt: string; stdin: string; answerOnly: string | null; depth: string | null };

function run(mode: string, extra: Partial<RunHeadlessOpts> = {}) {
  fs.writeFileSync(MODE, mode);
  fs.rmSync(CALLS, { force: true });
  const r = runHeadless({ runtime: "antigravity-cli", prompt: "answer", cwd: TMP, timeoutMs: 20_000, noTools: true, ...extra });
  const calls = fs.readFileSync(CALLS, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Call);
  return { r, calls };
}

describe("antigravity-cli: an answer-only call", () => {
  test("an empty answer with denied_actions is a failed run naming the actions, spawned once", () => {
    const { r, calls } = run("denied-write");
    expect(calls).toHaveLength(1);
    expect(r.exitCode).toBe(0);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("write_file (WriteToFile)");
    expect(r.error).toContain("auto-denied");
    expect(r.error).toContain("not re-run");

    const cmd = run("denied-command");
    expect(cmd.calls).toHaveLength(1);
    expect(cmd.r.ok).toBe(false);
    expect(cmd.r.error).toContain("command (RunCommand)");
  }, spawnBudgetMs(3));

  test("a denied tool beside a real answer is still the answer", () => {
    const { r } = run("denied-but-answered");
    expect(r.ok, r.error ?? r.stderr).toBe(true);
    expect(r.result).toBe('{"target":"solo"}');
  }, spawnBudgetMs(2));

  test("the child is marked answer-only (for the agy hook); a worker is not", () => {
    const routed = run("ok").calls[0];
    expect(routed.answerOnly).toBe("1");
    expect(ANSWER_ONLY_ENV).toBe("NIRVANA_ANSWER_ONLY");
    const worker = run("ok", { noTools: false }).calls[0];
    expect(worker.answerOnly).toBeNull();
    // Every child the driver starts carries the depth, the hook's other marker.
    expect(Number(worker.depth)).toBeGreaterThan(0);
  }, spawnBudgetMs(3));

  test("agy has no system-prompt flag: the cards router's fixed part goes first, the request after it", () => {
    const cards = "# Catalog\nbusiness:acme — reports";
    const fixed = buildCardsStatic(cards);
    const messageFor = (brief: string) => {
      const { r, calls } = run("ok", { appendSystemPrompt: fixed, prompt: buildCardsRequest(brief, []) });
      expect(r.ok, r.error ?? r.stderr).toBe(true);
      // The message content as sent on stdin, not as the fake reassembled it.
      return JSON.parse(calls[0].stdin.trim()).message.content as string;
    };
    const a = messageFor("Write a market report on coffee");
    const b = messageFor("Uma landing page para um curso");
    // Exactly the fixed part, then the separator, then the request: nothing
    // variable (cwd, a timestamp, the brief) sits in front of the fixed part.
    expect(a).toBe(`${fixed}\n\n---\n\n${buildCardsRequest("Write a market report on coffee", [])}`);
    expect(a.startsWith(fixed)).toBeTrue();
    expect(b.startsWith(fixed)).toBeTrue();
    expect(a.indexOf("coffee")).toBeGreaterThan(fixed.length);
  }, spawnBudgetMs(3));
});
