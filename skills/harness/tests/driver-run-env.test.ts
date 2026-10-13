// driver-run-env.test.ts — variables for one run reach that run's child only.
//
// A squad's packages live in its environment (~/.nirvana/envs/<slug>), never in
// the squad folder, so the worker reaches them through NODE_PATH, NODE_OPTIONS
// and PATH set on its own run (squad-env.ts squadRunEnv). RunHeadlessOpts.env is
// that door: laid over the child's environment, and gone for the next run.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writeFakeCli } from "./helpers/fake-cli.ts";
import { runHeadless } from "../../_shared/lib/host-agent-driver.ts";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-run-env-"));
const BIN = path.join(TMP, "bin");
const SEEN = path.join(TMP, "seen.json");
const SAVED = { PATH: process.env.PATH, NODE_PATH: process.env.NODE_PATH };

beforeAll(() => {
  writeFakeCli(BIN, "claude", `
import * as fs from "node:fs";
fs.writeFileSync(${JSON.stringify(SEEN)}, JSON.stringify({ NODE_PATH: process.env.NODE_PATH ?? null, MARK: process.env.NRV_TEST_MARK ?? null }));
try { await Bun.stdin.text(); } catch {}
console.log(JSON.stringify({ type: "result", result: "ok", total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 } }));
`);
  process.env.PATH = `${BIN}${path.delimiter}${SAVED.PATH ?? ""}`;
  process.env.NODE_PATH = "/from-the-parent";
});
afterAll(() => {
  process.env.PATH = SAVED.PATH;
  if (SAVED.NODE_PATH === undefined) delete process.env.NODE_PATH; else process.env.NODE_PATH = SAVED.NODE_PATH;
  fs.rmSync(TMP, { recursive: true, force: true });
});

const seen = () => JSON.parse(fs.readFileSync(SEEN, "utf8"));

describe("RunHeadlessOpts.env", () => {
  test("is laid over the child's environment", () => {
    const r = runHeadless({ runtime: "claude-code", prompt: "x", cwd: TMP, timeoutMs: 20_000, env: { NODE_PATH: "/squad/env/node_modules", NRV_TEST_MARK: "1" } });
    expect(r.ok, r.error ?? r.stderr).toBe(true);
    expect(seen()).toEqual({ NODE_PATH: "/squad/env/node_modules", MARK: "1" });
  });

  test("and does not outlive its run", () => {
    const r = runHeadless({ runtime: "claude-code", prompt: "x", cwd: TMP, timeoutMs: 20_000 });
    expect(r.ok, r.error ?? r.stderr).toBe(true);
    expect(seen()).toEqual({ NODE_PATH: "/from-the-parent", MARK: null });
  });
});
