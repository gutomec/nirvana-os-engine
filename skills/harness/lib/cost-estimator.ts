// cost-estimator.ts — produces a per-dispatch USD figure for any runtime.
//
// Why we need this: only claude-code returns cost_usd in its JSON output.
// codex, gemini-cli and antigravity-cli return token counts in events/stderr
// but never a dollar figure (subscription users especially have no notion of
// cost). antigravity-cli shares the Google backend with gemini-cli, so it
// uses the same Gemini model IDs in PRICE_TABLE and the same token-extraction
// shape (the `stats.models.*.tokens` JSON block).
// To enforce the $N suffix on LLM_CASCADE entries we estimate locally.
//
// The estimate has two ingredients: TOKEN COUNTS (parsed from CLI output)
// and a PRICE TABLE (per-model USD per million tokens). The price table is
// embedded here as of May 2026 and can be overridden per-model via env
// (NIRVANA_PRICE_<MODEL>=in_usd_per_M/out_usd_per_M). If we can't infer
// tokens or model, we return null and the caller treats spend as unknown
// (no enforcement on this dispatch — fail-open, never fail-closed on cost).

import type { Runtime, RunHeadlessResult } from "./host-agent-driver.ts";

/** USD per million tokens. [input, output] or [input, output, cachedInput].
 * Anthropic/Google rows: May 2026. OpenAI rows: 2026-09-05, standard tier, from
 * developers.openai.com/api/docs/pricing — cached input is the third number. */
type Price = [number, number] | [number, number, number];
const PRICE_TABLE: Record<string, Price> = {
  // Anthropic
  "claude-opus-4-7":       [15.00, 75.00],
  "claude-sonnet-4-6":     [ 3.00, 15.00],
  "claude-haiku-4-5":      [ 0.80,  4.00],
  "opus":                  [15.00, 75.00],
  "sonnet":                [ 3.00, 15.00],
  "haiku":                 [ 0.80,  4.00],
  // OpenAI
  "gpt-6-astra":           [10.00, 50.00, 1.00],
  "gpt-5.6-sol":           [ 4.00, 20.00, 0.40],
  "gpt-5.6-terra":         [ 2.00, 12.00, 0.20],
  "gpt-5.6-luna":          [ 0.20,  1.20, 0.02],
  "gpt-5.5":               [ 5.00, 30.00, 0.50],
  "gpt-5.4":               [ 2.50, 15.00, 0.25],
  "gpt-5.4-mini":          [ 0.75,  4.50, 0.075],
  "gpt-5.3-codex":         [ 1.75, 14.00, 0.175],
  "gpt-5.3":               [ 3.00, 15.00],
  "gpt-5.2":               [ 1.75, 14.00, 0.175],
  "gpt-5.1":               [ 1.25, 10.00, 0.125],
  // Google (shared by gemini-cli + antigravity-cli)
  "gemini-3.5-flash":      [ 1.50,  9.00],
  "gemini-3.1-pro-preview":[ 2.00, 12.00],
  "gemini-3-pro":          [ 1.25, 10.00],
  "gemini-3-flash":        [ 0.075, 0.30],
  "gemini-3-pro-preview":  [ 1.25, 10.00],
  "gemini-3.1-flash-lite": [ 0.05,  0.20],
  "gemini-2.5-flash":      [ 0.075, 0.30],
  "gemini-2.5-pro":        [ 1.25, 10.00],
  "gemini-2.0-flash":      [ 0.075, 0.30],
  // OpenRouter typicals — these vary per provider; defaults are conservative.
  "qwen3-coder":           [ 1.00,  3.00],
  "llama-3.3-405b":        [ 3.00,  9.00],
  "deepseek-v3.2":         [ 0.30,  1.20],
};

/** Allow per-model price override via env: NIRVANA_PRICE_GPT_5_5="5/30" or "5/30/0.5" (cached input third). */
function envPrice(model: string): Price | null {
  const key = "NIRVANA_PRICE_" + model.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  const v = process.env[key];
  if (!v) return null;
  const m = v.match(/^([\d.]+)\s*\/\s*([\d.]+)(?:\s*\/\s*([\d.]+))?$/);
  if (!m) return null;
  return m[3] ? [parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3])] : [parseFloat(m[1]), parseFloat(m[2])];
}

function priceFor(model: string | null): Price | null {
  if (!model) return null;
  return envPrice(model) ?? PRICE_TABLE[model] ?? null;
}

/** Best-effort token extraction from codex/gemini output. Format reverse-
 * engineered May 2026 from live captures.
 *
 * Codex CLI (--json output, on turn.completed):
 *   {"type":"turn.completed","usage":{"input_tokens":N,"output_tokens":N,
 *     "cached_input_tokens":N,"reasoning_output_tokens":N,"total_tokens":N}}
 *   Also appears in payload.type=="token_count" rollouts with same field names.
 *
 * Gemini CLI (-o json output):
 *   {"stats":{"models":{"<model>":{"tokens":{"input":N,"prompt":N,
 *     "candidates":N,"total":N,"cached":N,"thoughts":N,"tool":N}}}}}
 *   Gemini calls output "candidates"; input==prompt.
 *
 * Strategy: try both shapes (specific keys, last match wins since totals are
 * cumulative or final). Sum across multiple models if present (multi-model
 * sessions like utility_router + main). */
function extractTokens(text: string): { input: number; output: number } | null {
  // Codex shape: input_tokens + output_tokens (key names are stable across
  // turn.completed events and token_count payloads).
  const codexMatches = [...text.matchAll(/"input_tokens"\s*:\s*(\d+)[\s\S]{0,400}?"output_tokens"\s*:\s*(\d+)/g)];
  if (codexMatches.length) {
    const last = codexMatches[codexMatches.length - 1];
    return { input: parseInt(last[1], 10), output: parseInt(last[2], 10) };
  }

  // Gemini shape: "tokens": { "input": ..., "candidates": ... }
  // Multiple models can appear in the same stats block; sum them so a
  // utility_router + main pipeline gets full accounting.
  const gemBlocks = [...text.matchAll(/"tokens"\s*:\s*\{[^}]*"input"\s*:\s*(\d+)[^}]*"candidates"\s*:\s*(\d+)[^}]*\}/g)];
  if (gemBlocks.length) {
    let inSum = 0, outSum = 0;
    for (const m of gemBlocks) { inSum += parseInt(m[1], 10); outSum += parseInt(m[2], 10); }
    return { input: inSum, output: outSum };
  }

  // Fallback: generic OpenAI-compatible shape used by various proxies (e.g.,
  // LiteLLM exposing prompt_tokens + completion_tokens).
  const gen = text.match(/"prompt_tokens"\s*:\s*(\d+)[\s\S]{0,400}?"completion_tokens"\s*:\s*(\d+)/);
  if (gen) return { input: parseInt(gen[1], 10), output: parseInt(gen[2], 10) };

  return null;
}

/** Returns USD spent on this dispatch, or null if we can't tell.
 *  Null is treated as "don't enforce budget for this run" — fail-open. */
export function estimateCostUsd(runtime: Runtime, model: string | null, r: RunHeadlessResult): number | null {
  // claude-code is authoritative — use its own number when available.
  if (runtime === "claude-code" && typeof r.costUsd === "number" && Number.isFinite(r.costUsd)) {
    return r.costUsd;
  }
  // For codex/gemini (and claude-code when costUsd is null), estimate via tokens.
  const price = priceFor(model);
  if (!price) return null;
  const [inUsd, outUsd, cachedUsd] = price;
  // The CLI's own usage object wins over scraping the text: it carries the
  // cached subset of the input, which is billed at a tenth of the rate.
  if (r.usage) {
    const cached = Math.min(r.usage.cachedInputTokens, r.usage.inputTokens);
    const fresh = r.usage.inputTokens - cached;
    return (fresh * inUsd + cached * (cachedUsd ?? inUsd) + r.usage.outputTokens * outUsd) / 1_000_000;
  }
  const haystack = [r.result, r.stderr].filter(Boolean).join("\n");
  const tk = extractTokens(haystack);
  if (!tk) return null;
  return (tk.input * inUsd + tk.output * outUsd) / 1_000_000;
}
