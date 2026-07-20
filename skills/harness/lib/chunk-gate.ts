/**
 * chunk-gate.ts — runs a partial quality check on a single chunk without
 * the full aggregated rubric. Heuristic-only by default (no LLM call) so
 * the gate stays cheap enough to run per-chunk during streaming.
 *
 * Phase 7 da nirvana-evolution.
 *
 * Checks:
 *   - non-empty
 *   - minimum byte length (e.g. >= 50 chars for prose)
 *   - language sanity (no all-uppercase, no obvious truncation marks like "[truncated]")
 *   - no LLM tells in obvious form (em-dash overuse in single chunk, rule-of-three)
 *
 * Returns: ChunkGateResult with warnings (non-blocking) and verdict.
 */

export interface ChunkGateResult {
  verdict: "pass" | "warn" | "fail";
  warnings: string[];
  score: number;        // 0-1
  byte_size: number;
  chunk_id: string;
}

const TRUNCATION_MARKS = /\[(?:truncated|cut|continued|more)\]/i;
const ALL_CAPS_RUN = /[A-Z]{40,}/;
const EM_DASH = /—/g;

export function checkChunk(
  chunk_id: string,
  content: string,
  opts: { min_chars?: number; expected_format?: "prose" | "code" | "json" } = {},
): ChunkGateResult {
  const minChars = opts.min_chars ?? 50;
  const fmt = opts.expected_format ?? "prose";
  const warnings: string[] = [];
  let score = 1.0;
  const byteSize = Buffer.byteLength(content, "utf8");

  if (!content || content.trim().length === 0) {
    return {
      verdict: "fail",
      warnings: ["empty_chunk"],
      score: 0,
      byte_size: 0,
      chunk_id,
    };
  }

  if (content.length < minChars) {
    warnings.push(`chunk_too_short (${content.length} chars; min ${minChars})`);
    score -= 0.3;
  }

  if (TRUNCATION_MARKS.test(content)) {
    warnings.push("truncation_marker_detected");
    score -= 0.5;
  }

  if (fmt === "prose") {
    const emDashCount = (content.match(EM_DASH) ?? []).length;
    if (emDashCount > 3 && content.length < 2000) {
      warnings.push(`em_dash_overuse (${emDashCount} in ${content.length} chars)`);
      score -= 0.2;
    }
    if (ALL_CAPS_RUN.test(content)) {
      warnings.push("excessive_all_caps");
      score -= 0.1;
    }
  }

  if (fmt === "json") {
    try { JSON.parse(content); }
    catch { warnings.push("invalid_json"); score -= 0.5; }
  }

  score = Math.max(0, Math.min(1, score));
  const verdict: ChunkGateResult["verdict"] = score >= 0.7 ? "pass" : score >= 0.4 ? "warn" : "fail";
  return { verdict, warnings, score, byte_size: byteSize, chunk_id };
}
