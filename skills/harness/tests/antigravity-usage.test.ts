// antigravity-usage.test.ts — the agy runner keeps the token counts its CLI reports.
//
// `agy -p --output-format json` answers with a `usage` block (input, output,
// thinking and cache-read tokens) and no USD. The runner kept only `response`,
// so every Antigravity run reached the ledger with no cost and the estimator had
// nothing to price.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runHeadless } from "../../_shared/lib/host-agent-driver.ts";
import { estimateCostUsd } from "../lib/cost-estimator.ts";
import { writeFakeCli } from "./helpers/fake-cli.ts";
import { spawnBudgetMs } from "./helpers/test-budgets.ts";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "agy-usage-"));
const BIN = path.join(TMP, "bin");
const PATH_BEFORE = process.env.PATH;

beforeAll(() => {
  // The shape agy 1.2.13 prints, values chosen to make the arithmetic visible.
  writeFakeCli(BIN, "agy", `
    console.log(JSON.stringify({
      conversation_id: "conv-1", status: "success", response: "done", duration_seconds: 1.5, num_turns: 1,
      usage: { input_tokens: 1000000, output_tokens: 200000, thinking_tokens: 100000, cache_read_tokens: 400000, total_tokens: 1300000 },
    }));
  `);
  process.env.PATH = `${BIN}${path.delimiter}${process.env.PATH}`;
});

afterAll(() => {
  process.env.PATH = PATH_BEFORE;
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe("antigravity-cli runner", () => {
  test("returns the response and the usage block; USD stays unknown", () => {
    const r = runHeadless({ runtime: "antigravity-cli", prompt: "do it", cwd: TMP, timeoutMs: 20_000 });
    expect(r.ok, r.error ?? r.stderr).toBe(true);
    expect(r.result).toBe("done");
    expect(r.costUsd).toBeNull();
    expect(r.costUnavailable).toBe(true);
    // Thinking tokens bill as output; cache reads are the cached subset of input.
    expect(r.usage).toEqual({ inputTokens: 1_000_000, cachedInputTokens: 400_000, cacheWriteInputTokens: 0, outputTokens: 300_000, reasoningOutputTokens: 100_000 });
  }, spawnBudgetMs(1));

  test("the estimator prices it once the model is known", () => {
    const r = runHeadless({ runtime: "antigravity-cli", prompt: "do it", cwd: TMP, timeoutMs: 20_000 });
    // gemini-3-pro: $1.25 in / $10 out per million, no cached rate in the table.
    expect(estimateCostUsd("antigravity-cli", "gemini-3-pro", r)).toBeCloseTo(1.25 + 3.0, 6);
  }, spawnBudgetMs(1));
});
