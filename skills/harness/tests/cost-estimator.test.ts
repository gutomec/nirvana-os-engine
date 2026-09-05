// cost-estimator.test.ts — the CLI's own usage object prices cached input at the
// cached rate; without it the text scrape still works; env overrides carry a
// third number.
import { afterEach, describe, expect, test } from "bun:test";
import { estimateCostUsd } from "../lib/cost-estimator.ts";
import type { RunHeadlessResult } from "../../_shared/lib/host-agent-driver.ts";

const base: RunHeadlessResult = { ok: true, runtime: "codex", sessionId: "t", result: "", costUsd: null, costUnavailable: true, exitCode: 0, stderr: "", durationMs: 1 };

afterEach(() => { delete process.env.NIRVANA_PRICE_GPT_5_5; });

describe("estimateCostUsd", () => {
  test("usage object: fresh input at the input rate, cached subset at the cached rate", () => {
    // gpt-6-astra: 10 / 50 / 1 per million. 1M input of which 400k cached, 100k output.
    const r = { ...base, usage: { inputTokens: 1_000_000, cachedInputTokens: 400_000, cacheWriteInputTokens: 0, outputTokens: 100_000, reasoningOutputTokens: 0 } };
    expect(estimateCostUsd("codex", "gpt-6-astra", r)).toBeCloseTo(600_000 * 10 / 1e6 + 400_000 * 1 / 1e6 + 100_000 * 50 / 1e6, 6);
  });

  test("a model without a cached rate bills cached input at the input rate", () => {
    const r = { ...base, usage: { inputTokens: 1_000_000, cachedInputTokens: 1_000_000, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 } };
    expect(estimateCostUsd("codex", "gpt-5.3", r)).toBeCloseTo(3.0, 6);
  });

  test("without a usage object the event stream is scraped as before", () => {
    const r = { ...base, result: 'x\n{"type":"turn.completed","usage":{"input_tokens":1000000,"output_tokens":100000}}' };
    expect(estimateCostUsd("codex", "gpt-5.3-codex", r)).toBeCloseTo(1.75 + 1.4, 6);
  });

  test("env override accepts input/output/cached", () => {
    process.env.NIRVANA_PRICE_GPT_5_5 = "2/4/1";
    const r = { ...base, usage: { inputTokens: 1_000_000, cachedInputTokens: 500_000, cacheWriteInputTokens: 0, outputTokens: 1_000_000, reasoningOutputTokens: 0 } };
    expect(estimateCostUsd("codex", "gpt-5.5", r)).toBeCloseTo(500_000 * 2 / 1e6 + 500_000 * 1 / 1e6 + 4, 6);
  });

  test("an unknown model stays null (fail-open for budgets)", () => {
    expect(estimateCostUsd("codex", "gpt-99", { ...base, usage: { inputTokens: 1, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0 } })).toBeNull();
  });
});
