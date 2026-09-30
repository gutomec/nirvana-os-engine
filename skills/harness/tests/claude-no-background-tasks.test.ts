// claude-no-background-tasks.test.ts — a headless claude child runs with background tasks off.
//
// A `-p` child ends with its final turn, and whatever it left running in the
// background (a `run_in_background` Bash call or subagent, auto-backgrounded
// work) dies with it. The prompt says not to; CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1
// makes the runtime hold it. A value the user set is kept.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writeFakeCli } from "./helpers/fake-cli.ts";
import { callHostAgent, runHeadless } from "../../_shared/lib/host-agent-driver.ts";
import { turnEnvironment } from "../lib/control-plane/maestro-turn.ts";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-no-bg-"));
const BIN = path.join(TMP, "bin");
const SEEN = path.join(TMP, "seen.txt");
const SAVED = { PATH: process.env.PATH, flag: process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS };

beforeAll(() => {
  writeFakeCli(BIN, "claude", `
import * as fs from "node:fs";
fs.writeFileSync(${JSON.stringify(SEEN)}, String(process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS ?? "<unset>"));
try { await Bun.stdin.text(); } catch {}
console.log(JSON.stringify({ type: "result", result: "ok", total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 } }));
`);
  process.env.PATH = `${BIN}${path.delimiter}${SAVED.PATH ?? ""}`;
  delete process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS;
});
afterAll(() => {
  process.env.PATH = SAVED.PATH;
  if (SAVED.flag === undefined) delete process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS; else process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = SAVED.flag;
  fs.rmSync(TMP, { recursive: true, force: true });
});

const seen = () => fs.readFileSync(SEEN, "utf8");

describe("headless claude children run without background tasks", () => {
  test("runHeadless", () => {
    const r = runHeadless({ runtime: "claude-code", prompt: "do it", cwd: TMP, timeoutMs: 20_000 });
    expect(r.ok, r.error ?? r.stderr).toBe(true);
    expect(seen()).toBe("1");
  });

  test("the light layer (callHostAgent)", () => {
    const r = callHostAgent("", "decide", { preferredHost: "claude-code", timeoutMs: 20_000 });
    expect("error" in r ? r.error : "").toBe("");
    expect(seen()).toBe("1");
  });

  test("a Glance maestro turn", () => {
    expect(turnEnvironment(TMP, {}).CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).toBe("1");
  });

  test("a value the user set is kept", () => {
    process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = "0";
    try {
      const r = runHeadless({ runtime: "claude-code", prompt: "do it", cwd: TMP, timeoutMs: 20_000 });
      expect(r.ok, r.error ?? r.stderr).toBe(true);
      expect(seen()).toBe("0");
      expect(turnEnvironment(TMP, { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "0" }).CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).toBe("0");
    } finally {
      delete process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS;
    }
  });
});
