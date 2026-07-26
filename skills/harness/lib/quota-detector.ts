// quota-detector.ts — classifies a runHeadless result into one of:
//   ok           : completed normally
//   transient    : recoverable error (5xx, brief 429 with short retry-after) — caller may retry same runtime
//   quota_exhausted : the runtime's plan/cap is spent. Caller should mark cooldown + hand off to next.
//   auth_failed  : credentials missing/invalid. Do NOT rotate — the user must fix it.
//   error        : anything else (genuine bug, malformed prompt). Do NOT rotate.
//
// Why pattern-matching strings: no runtime exposes a stable machine-readable
// code for "your plan ran out." OpenAI sends 429 indistinguishable from rate-
// limit; Anthropic Claude Code prints freeform "Rate limit reached" with
// occasional reset hints; Gemini surfaces "Resource has been exhausted" or
// "RESOURCE_EXHAUSTED". Each runtime gets its own pattern table — keep them
// honest, update when CLIs change their error copy.

import type { Runtime } from "./host-agent-driver.ts";

export type QuotaClass =
  | { kind: "ok" }
  | { kind: "transient"; retryAfterSec?: number; hint: string }
  | { kind: "quota_exhausted"; ttlSec: number; hint: string; window: "5h" | "weekly" | "monthly" | "unknown" }
  | { kind: "auth_failed"; hint: string }
  | { kind: "error"; hint: string };

interface RunResultLike {
  ok: boolean;
  exitCode: number | null;
  stderr?: string;
  result?: string;
  error?: string;
}

// Default cool-downs when the error names a window but no exact reset time.
const DEFAULT_TTL = { "5h": 5 * 3600, "weekly": 7 * 24 * 3600, "monthly": 30 * 24 * 3600, "unknown": 30 * 60 };

function findRetryAfterSec(text: string): number | undefined {
  // RFC-ish: "retry-after: 42" or "try again in 12s" or "wait 5 minutes"
  const m1 = text.match(/retry[-_ ]after[:\s]+(\d+)/i);
  if (m1) return parseInt(m1[1], 10);
  const m2 = text.match(/try again in\s+(\d+)\s*(s|sec|second|m|min|minute|h|hour)/i);
  if (m2) {
    const n = parseInt(m2[1], 10);
    const u = m2[2].toLowerCase();
    if (u.startsWith("h")) return n * 3600;
    if (u.startsWith("m")) return n * 60;
    return n;
  }
  const m3 = text.match(/wait\s+(\d+)\s*(s|sec|second|m|min|minute|h|hour)/i);
  if (m3) {
    const n = parseInt(m3[1], 10);
    const u = m3[2].toLowerCase();
    if (u.startsWith("h")) return n * 3600;
    if (u.startsWith("m")) return n * 60;
    return n;
  }
  return undefined;
}

function classifyClaudeCode(text: string): QuotaClass {
  const t = text.toLowerCase();
  // Subscription windows surface as text — not status codes. The live message
  // is "You've hit your weekly limit · resets May 26, 8pm" — note the
  // contraction "you've" and the "· resets" suffix (not "reached"/"exceeded").
  if (/weekly\s+(usage\s+)?(limit|cap)/i.test(text)
   || /you'?ve?\s+(reached|hit)\s+(your\s+)?weekly/i.test(text)
   || /you\s+have\s+(reached|hit)\s+your\s+weekly/i.test(text)) {
    return { kind: "quota_exhausted", ttlSec: DEFAULT_TTL.weekly, hint: "Claude Code weekly cap reached", window: "weekly" };
  }
  if (/5[- ]?hour\s+(limit|cap)\s+(reached|exceeded)/i.test(text)
   || /usage\s+limit.*reset(s)?\s+(at|in)/i.test(text)) {
    const retry = findRetryAfterSec(text);
    return { kind: "quota_exhausted", ttlSec: retry ?? DEFAULT_TTL["5h"], hint: "Claude Code 5-hour window reached", window: "5h" };
  }
  if (/you'?ve?\s+(hit|reached)\s+(your|the)\s+(usage\s+)?limit|usage\s+limit\s+(reached|exceeded)/i.test(text)) {
    return { kind: "quota_exhausted", ttlSec: DEFAULT_TTL["5h"], hint: "Claude (plan) usage limit reached", window: "5h" };
  }
  if (/(api\s+error[:\s]+)?rate\s+limit\s+(reached|exceeded)/i.test(text)
   || /\b429\b/.test(text)) {
    const retry = findRetryAfterSec(text);
    // Short retry → transient. Long or absent → treat as quota_exhausted with short TTL.
    if (retry !== undefined && retry < 120) return { kind: "transient", retryAfterSec: retry, hint: "Claude rate limit (transient)" };
    return { kind: "quota_exhausted", ttlSec: retry ?? DEFAULT_TTL["5h"], hint: "Claude rate limit (treating as quota)", window: "5h" };
  }
  if (/spend\s+limit|monthly\s+cap|billing\s+(threshold|cap)/i.test(text)) {
    return { kind: "quota_exhausted", ttlSec: DEFAULT_TTL.monthly, hint: "Claude spend/billing cap reached", window: "monthly" };
  }
  if (/authenticat|api[ _-]?key|unauthor|forbidden|sign(\s+)?in|login\s+required/i.test(text)) {
    return { kind: "auth_failed", hint: "Claude Code auth missing/invalid" };
  }
  return { kind: "error", hint: text.slice(0, 200) };
}

function classifyCodex(text: string): QuotaClass {
  if (/quota\s+(exceeded|reached)|insufficient_quota|over[\s_-]?cap/i.test(text)) {
    return { kind: "quota_exhausted", ttlSec: DEFAULT_TTL.monthly, hint: "Codex quota exhausted", window: "monthly" };
  }
  if (/weekly\s+(limit|cap)|usage\s+cap\s+for\s+the\s+week/i.test(text)) {
    return { kind: "quota_exhausted", ttlSec: DEFAULT_TTL.weekly, hint: "Codex weekly cap reached", window: "weekly" };
  }
  // ChatGPT Plus / Pro OAuth users hit this phrasing when their plan's usage
  // cap runs out (e.g. "You've hit your usage limit", "You have reached your
  // usage limit"). Treat as quota_exhausted with the 5h window (Plus resets
  // hourly-ish; Pro tier rolls weekly — we route conservatively to 5h and
  // let the cooldown re-test sooner).
  if (/you'?ve?\s+(hit|reached)\s+(your|the)\s+(usage\s+)?limit|usage\s+limit\s+(reached|exceeded)|hit\s+the\s+(usage|message)\s+limit/i.test(text)) {
    return { kind: "quota_exhausted", ttlSec: DEFAULT_TTL["5h"], hint: "Codex (ChatGPT plan) usage limit reached", window: "5h" };
  }
  if (/rate[ _-]?limit|too\s+many\s+requests|\b429\b/i.test(text)) {
    const retry = findRetryAfterSec(text);
    if (retry !== undefined && retry < 120) return { kind: "transient", retryAfterSec: retry, hint: "Codex rate limit (transient)" };
    return { kind: "quota_exhausted", ttlSec: retry ?? DEFAULT_TTL["5h"], hint: "Codex rate limit (treating as quota)", window: "5h" };
  }
  if (/api[ _-]?key|OPENAI_API_KEY|unauthorized|invalid\s+token|sign[ _-]?in/i.test(text)) {
    return { kind: "auth_failed", hint: "Codex auth missing/invalid" };
  }
  return { kind: "error", hint: text.slice(0, 200) };
}

// Antigravity CLI shares the Google backend (Gemini models) — error surfaces
// reuse the same vocabulary plus the Antigravity-specific "compute budget"
// language for the 5h-window of consumer tiers. Replaces gemini-cli for
// consumer accounts after 2026-06-18.
function classifyAntigravity(text: string): QuotaClass {
  // Antigravity-specific window phrasings (Pro/Ultra/Free 5h rolling cap).
  if (/compute[\s_-]?budget|compute[\s_-]?used|5[\s_-]?hour\s+(limit|cap|window)/i.test(text)) {
    return { kind: "quota_exhausted", ttlSec: DEFAULT_TTL["5h"], hint: "Antigravity 5h compute window reached", window: "5h" };
  }
  if (/weekly\s+(limit|cap)|usage\s+cap\s+for\s+the\s+week/i.test(text)) {
    return { kind: "quota_exhausted", ttlSec: DEFAULT_TTL.weekly, hint: "Antigravity weekly cap reached", window: "weekly" };
  }
  // Shared Google-backend quota phrasings.
  if (/resource\s+has\s+been\s+exhausted|RESOURCE_EXHAUSTED/i.test(text)) {
    return { kind: "quota_exhausted", ttlSec: DEFAULT_TTL["5h"], hint: "Antigravity quota exhausted (Google backend)", window: "5h" };
  }
  if (/quota\s+(exceeded|reached)|daily\s+(limit|quota)/i.test(text)) {
    return { kind: "quota_exhausted", ttlSec: DEFAULT_TTL["5h"], hint: "Antigravity quota reached", window: "5h" };
  }
  if (/you'?ve?\s+(hit|reached)\s+(your|the)\s+(usage\s+)?limit|usage\s+limit\s+(reached|exceeded)/i.test(text)) {
    return { kind: "quota_exhausted", ttlSec: DEFAULT_TTL["5h"], hint: "Antigravity (plan) usage limit reached", window: "5h" };
  }
  if (/rate[ _-]?limit|too\s+many\s+requests|\b429\b/i.test(text)) {
    const retry = findRetryAfterSec(text);
    if (retry !== undefined && retry < 120) return { kind: "transient", retryAfterSec: retry, hint: "Antigravity rate limit (transient)" };
    return { kind: "quota_exhausted", ttlSec: retry ?? DEFAULT_TTL["5h"], hint: "Antigravity rate limit (treating as quota)", window: "5h" };
  }
  if (/ModelNotFoundError|model[\s_-]+not[\s_-]+found|\bnot\s+found\b.*model/i.test(text)
   || (/code["\s:]*404/i.test(text) && /model/i.test(text))) {
    return { kind: "quota_exhausted", ttlSec: 60 * 60, hint: "Antigravity model not found (check --model name)", window: "5h" };
  }
  if (/no\s+(api[ _-]?key|credentials)|missing\s+(api[ _-]?key|credentials)|invalid\s+(api[ _-]?key|credentials|token)|unauthorized|please\s+(sign|log)\s*in|authentication\s+(failed|required)|401\b/i.test(text)) {
    return { kind: "auth_failed", hint: "Antigravity auth missing/invalid (try `agy` to re-auth)" };
  }
  return { kind: "error", hint: text.slice(0, 200) };
}

function classifyGemini(text: string): QuotaClass {
  if (/resource\s+has\s+been\s+exhausted|RESOURCE_EXHAUSTED/i.test(text)) {
    return { kind: "quota_exhausted", ttlSec: DEFAULT_TTL["5h"], hint: "Gemini quota exhausted (free or paid tier)", window: "5h" };
  }
  if (/quota\s+(exceeded|reached)|daily\s+(limit|quota)/i.test(text)) {
    return { kind: "quota_exhausted", ttlSec: DEFAULT_TTL["5h"], hint: "Gemini daily quota reached", window: "5h" };
  }
  if (/rate[ _-]?limit|too\s+many\s+requests|\b429\b/i.test(text)) {
    const retry = findRetryAfterSec(text);
    if (retry !== undefined && retry < 120) return { kind: "transient", retryAfterSec: retry, hint: "Gemini rate limit (transient)" };
    return { kind: "quota_exhausted", ttlSec: retry ?? DEFAULT_TTL["5h"], hint: "Gemini rate limit (treating as quota)", window: "5h" };
  }
  // ModelNotFoundError / 404 = wrong model name in cascade entry. Don't
  // classify as auth_failed — it's a config error. Treat as quota_exhausted
  // with short TTL so cascade tries the next entry; user must fix the model.
  if (/ModelNotFoundError|model[\s_-]+not[\s_-]+found|\bnot\s+found\b.*model/i.test(text)
   || (/code["\s:]*404/i.test(text) && /model/i.test(text))) {
    return { kind: "quota_exhausted", ttlSec: 60 * 60, hint: "Gemini model not found (check --model name in LLM_CASCADE)", window: "5h" };
  }
  // Real auth failure (not the informative "Both *_API_KEY are set" warning).
  // Require explicit failure context, not just the var names.
  if (/no\s+(api[ _-]?key|credentials)|missing\s+(api[ _-]?key|credentials)|invalid\s+(api[ _-]?key|credentials|token)|unauthorized|please\s+(sign|log)\s*in|authentication\s+(failed|required)|401\b/i.test(text)) {
    return { kind: "auth_failed", hint: "Gemini auth missing/invalid" };
  }
  return { kind: "error", hint: text.slice(0, 200) };
}

export function classify(runtime: Runtime, r: RunResultLike): QuotaClass {
  if (r.ok && r.exitCode === 0) return { kind: "ok" };
  const text = [r.stderr, r.error, r.result].filter(Boolean).join("\n");
  if (!text) return { kind: "error", hint: `runtime ${runtime} exit ${r.exitCode} with no output` };
  if (runtime === "claude-code") return classifyClaudeCode(text);
  if (runtime === "codex") return classifyCodex(text);
  if (runtime === "gemini-cli") return classifyGemini(text);
  if (runtime === "antigravity-cli") return classifyAntigravity(text);
  return { kind: "error", hint: `unknown runtime ${runtime}` };
}
