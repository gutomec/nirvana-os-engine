// antigravity-no-respawn.test.ts — a failed agy turn is never run a second time by the runner.
//
// Since agy 1.2.10 a model or agent error mid-turn exits 3 with an `AGY_ERROR`
// line, after the turn was paid for. The runner used to re-spawn the whole turn
// when stderr said "unknown"/"invalid" (dropping --output-format) or
// "conversation" (swapping --conversation for --continue, which can attach to
// another conversation in the same directory). Both re-spawns are gone.
// Hermetic: a fake `agy` that counts its calls. No LLM, no network.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runHeadless } from "../../_shared/lib/host-agent-driver.ts";
import { writeFakeCli } from "./helpers/fake-cli.ts";
import { spawnBudgetMs } from "./helpers/test-budgets.ts";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "agy-no-respawn-"));
const BIN = path.join(TMP, "bin");
const CALLS = path.join(TMP, "calls.jsonl");
const MODE = path.join(TMP, "mode");
const PATH_BEFORE = process.env.PATH;

beforeAll(() => {
  writeFakeCli(BIN, "agy", `
    import * as fs from "node:fs";
    fs.appendFileSync(${JSON.stringify(CALLS)}, JSON.stringify(Bun.argv.slice(2)) + "\\n");
    const mode = fs.existsSync(${JSON.stringify(MODE)}) ? fs.readFileSync(${JSON.stringify(MODE)}, "utf8") : "ok";
    if (mode === "agy-error") {
      console.log(JSON.stringify({ conversation_id: "conv-1", response: "partial", is_error: true, error: "unknown model error" }));
      console.error("AGY_ERROR: unknown error while resuming conversation conv-1");
      process.exit(3);
    }
    if (mode === "flag-error") { console.error("error: unknown option '--output-format'"); process.exit(1); }
    // agy 1.3.3 on an unknown --conversation id: exit 0, a warning, a NEW conversation.
    if (mode === "unknown-conv") {
      console.error('warning: conversation "conv-gone" not found');
      console.log(JSON.stringify({ conversation_id: "conv-new", status: "SUCCESS", response: "OK\\n" }));
      process.exit(0);
    }
    if (mode === "other-conv") { console.log(JSON.stringify({ conversation_id: "conv-other", response: "done" })); process.exit(0); }
    console.log(JSON.stringify({ conversation_id: "conv-1", response: "done" }));
  `);
  process.env.PATH = `${BIN}${path.delimiter}${process.env.PATH}`;
});

afterAll(() => {
  process.env.PATH = PATH_BEFORE;
  fs.rmSync(TMP, { recursive: true, force: true });
});

function run(mode: string, sessionId?: string) {
  fs.writeFileSync(MODE, mode);
  fs.rmSync(CALLS, { force: true });
  const r = runHeadless({ runtime: "antigravity-cli", prompt: "do it", cwd: TMP, timeoutMs: 20_000, ...(sessionId ? { sessionId } : {}) });
  const calls = fs.readFileSync(CALLS, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l) as string[]);
  return { r, calls };
}

describe("antigravity-cli runner: one spawn per turn", () => {
  test("exit 3 + AGY_ERROR on a resume by id: one call, reported failed, never --continue", () => {
    const { r, calls } = run("agy-error", "conv-1");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("--conversation");
    expect(calls[0]).not.toContain("--continue");
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(3);
  }, spawnBudgetMs(2));

  test("a stderr naming an unknown option is not retried without --output-format", () => {
    const { r, calls } = run("flag-error");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("--output-format");
    expect(r.ok).toBe(false);
  }, spawnBudgetMs(2));

  test("a run the engine labelled itself (no agy id) still resumes with --continue, once", () => {
    const { r, calls } = run("ok", "nrv-agy-1234");
    expect(r.ok, r.error ?? r.stderr).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("--continue");
  }, spawnBudgetMs(2));
});

// agy 1.3.3, measured 2026-10-11: `--conversation <unknown-id>` exits 0, prints
// `warning: conversation "<id>" not found` on stderr and answers from a NEW
// conversation. The turn ran (and was paid) without the previous context.
describe("antigravity-cli runner: a resume that landed in a new conversation", () => {
  test("unknown id: one call, ok, marked resumeLost with a warning, the new id kept", () => {
    const { r, calls } = run("unknown-conv", "conv-gone");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("--conversation");
    expect(r.ok, r.error ?? r.stderr).toBe(true);
    expect(r.resumeLost).toBe(true);
    expect(r.sessionId).toBe("conv-new");
    expect(r.warnings?.join("\n")).toMatch(/resume failed.*conv-gone.*not found.*new conversation conv-new WITHOUT the previous context/);
  }, spawnBudgetMs(2));

  test("a different conversation id in the envelope is a lost resume too, even with nothing on stderr", () => {
    const { r, calls } = run("other-conv", "conv-1");
    expect(calls).toHaveLength(1);
    expect(r.ok).toBe(true);
    expect(r.resumeLost).toBe(true);
    expect(r.sessionId).toBe("conv-other");
  }, spawnBudgetMs(2));

  test("a resume that held carries no warning", () => {
    const { r } = run("ok", "conv-1");
    expect(r.ok).toBe(true);
    expect(r.resumeLost).toBeUndefined();
    expect(r.warnings).toBeUndefined();
    expect(r.sessionId).toBe("conv-1");
  }, spawnBudgetMs(2));

  test("a fresh run (no resume asked) is never marked", () => {
    const { r } = run("other-conv");
    expect(r.resumeLost).toBeUndefined();
    expect(r.sessionId).toBe("conv-other");
  }, spawnBudgetMs(2));
});
