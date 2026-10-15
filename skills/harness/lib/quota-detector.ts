// quota-detector.ts — classifies a runHeadless result into one of:
//   ok           : completed normally
//   transient    : recoverable error (5xx, brief 429 with short retry-after) — caller may retry same runtime
//   quota_exhausted : the runtime's plan/cap is spent. Caller should mark cooldown + hand off to next.
//   auth_failed  : credentials missing, invalid, or a tier the provider retired.
//                  Caller marks a SHORT cooldown + hands off, exactly like quota:
//                  a broken credential must not cost the user the whole run. The
//                  audit event keeps the problem visible so they can still fix it.
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
  | {
      kind: "quota_exhausted"; ttlSec: number; hint: string; window: "5h" | "weekly" | "monthly" | "unknown";
      /** ISO time the message itself names as the reset ("try again at 1:21 AM"),
       *  when it names one. Absent when ttlSec is a default for the window. */
      resetAt?: string;
    }
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

/**
 * Typographic quotes and apostrophes as their ASCII forms. Codex prints
 * "You’ve hit your usage limit" with U+2019, and every pattern below was
 * written with a straight apostrophe: the real message classified as `error`,
 * so no cooldown was written and nothing downstream knew it was a quota (the
 * 2026-10-14 Camila incident). Normalising once, before any pattern runs,
 * covers every table at the same time.
 */
export function normalizeQuotes(text: string): string {
  return text.replace(/[\u2018\u2019\u201A\u201B\u2032\u02BC\u00B4]/g, "'").replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"');
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** The UTC offset of an IANA zone at `at`, in ms (zone time minus UTC). Null for an unknown zone. */
function zoneOffsetMs(timeZone: string, at: number): number | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(new Date(at));
    const n = (t: string) => Number(parts.find(p => p.type === t)?.value);
    return Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second")) - Math.floor(at / 1000) * 1000;
  } catch { return null; }
}

/** Wall-clock fields in a zone ("local", "utc" or an IANA name) as epoch ms. */
function wallClockMs(zone: string, y: number, mo: number, d: number, h: number, mi: number): number {
  if (zone === "local") return new Date(y, mo, d, h, mi, 0, 0).getTime();
  const utc = Date.UTC(y, mo, d, h, mi, 0, 0);
  if (zone === "utc") return utc;
  const off = zoneOffsetMs(zone, utc);
  if (off === null) return new Date(y, mo, d, h, mi, 0, 0).getTime();
  // One correction pass covers a DST change between the guess and the answer.
  const guess = utc - off;
  const off2 = zoneOffsetMs(zone, guess) ?? off;
  return utc - off2;
}

/** Today's date fields in a zone. */
function todayIn(zone: string, now: number): { y: number; mo: number; d: number } {
  if (zone === "local") { const t = new Date(now); return { y: t.getFullYear(), mo: t.getMonth(), d: t.getDate() }; }
  const off = zone === "utc" ? 0 : (zoneOffsetMs(zone, now) ?? 0);
  const t = new Date(now + off);
  return { y: t.getUTCFullYear(), mo: t.getUTCMonth(), d: t.getUTCDate() };
}

/**
 * The reset time a quota message names, as epoch ms, or undefined.
 *
 * The forms the CLIs print:
 *   Codex:  "try again at 1:21 AM", "try again at Oct 14th, 2026 1:21 AM"
 *   Claude: "resets 3am", "resets 8pm (America/Sao_Paulo)", "resets May 26, 8pm",
 *           "will reset at 3:30pm", "usage limit reached|1760416860" (epoch seconds)
 *   any:    an ISO time after "reset"/"try again" ("resets at 2026-10-14T04:21:00Z")
 *
 * A time with no date is the NEXT occurrence: in the named zone when the
 * message names one, else in this machine's local time (the CLI printed it in
 * the user's), rolling to the next day when that time has already passed. A
 * date with no year is this year, or the next one when it has passed.
 */
export function findResetAtMs(rawText: string, now: number = Date.now()): number | undefined {
  const text = normalizeQuotes(rawText);
  const epoch = text.match(/limit\s+reached\s*\|\s*(\d{10})\b/i);
  if (epoch) return Number(epoch[1]) * 1000;
  const iso = text.match(/(?:reset|try\s+again|available)[^\n]{0,24}?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2}))/i);
  if (iso) { const t = Date.parse(iso[1]); if (Number.isFinite(t)) return t; }
  const m = text.match(new RegExp(
    String.raw`(?:try\s+again|resets?|available\s+again)\s+(?:at\s+|on\s+)?` +
    String.raw`(?:(${MONTHS.join("|")})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(?:(\d{4}),?\s*)?(?:at\s+)?)?` +
    String.raw`(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?(?![\d:])` +
    String.raw`(?:\s*\(?\s*(UTC|GMT|[A-Za-z]+\/[A-Za-z_]+(?:\/[A-Za-z_]+)?)\)?)?`,
    "i",
  ));
  if (!m) return undefined;
  const [, monthName, dayStr, yearStr, hourStr, minStr, ampm, zoneRaw] = m;
  // A bare number with neither minutes nor am/pm is not a time ("resets 5 times").
  if (!minStr && !ampm) return undefined;
  let hour = Number(hourStr);
  const minute = minStr ? Number(minStr) : 0;
  if (minute > 59) return undefined;
  if (ampm) {
    if (hour < 1 || hour > 12) return undefined;
    const pm = ampm.toLowerCase().startsWith("p");
    hour = (hour % 12) + (pm ? 12 : 0);
  } else if (hour > 23) return undefined;
  const zone = !zoneRaw ? "local" : /^(utc|gmt)$/i.test(zoneRaw) ? "utc" : zoneRaw;
  if (monthName) {
    const mo = MONTHS.indexOf(monthName.slice(0, 3).toLowerCase());
    const day = Number(dayStr);
    const explicitYear = yearStr ? Number(yearStr) : null;
    let at = wallClockMs(zone, explicitYear ?? todayIn(zone, now).y, mo, day, hour, minute);
    if (explicitYear === null && at < now - 24 * 3600 * 1000) at = wallClockMs(zone, todayIn(zone, now).y + 1, mo, day, hour, minute);
    return at;
  }
  const today = todayIn(zone, now);
  let at = wallClockMs(zone, today.y, today.mo, today.d, hour, minute);
  if (at <= now) at = wallClockMs(zone, today.y, today.mo, today.d + 1, hour, minute);
  return at;
}

function findRetryAfterSec(text: string, now: number = Date.now()): number | undefined {
  // RFC-ish: "retry-after: 42" or "try again in 12s" or "wait 5 minutes"
  const m1 = text.match(/retry[-_ ]after[:\s]+(\d+)/i);
  if (m1) return parseInt(m1[1], 10);
  const m2 = text.match(/(?:try again|resets?)\s+in\s+(\d+)\s*(s|sec|second|m|min|minute|h|hour)/i);
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
  const at = findResetAtMs(text, now);
  if (at !== undefined) return Math.max(60, Math.ceil((at - now) / 1000));
  return undefined;
}

/**
 * A 5xx from any provider means "the server could not, try again", never "your
 * request was wrong". The header of this file has promised since day one that
 * 5xx classifies as transient — and no rule ever implemented it, so every 5xx
 * fell through to `error`, which the cascade treats as fatal: it emits
 * runtime_error and gives up instead of retrying.
 *
 * Found by a real incident: an Anthropic 529 Overloaded killed a dispatch that
 * would have succeeded seconds later. The orchestrator recovered by reasoning
 * about it in prose; the scripted path had nothing to reason with.
 *
 * Conservative on purpose. A bare "529" in output could be a line number or a
 * token count, so a status code only counts next to status-shaped context, and
 * the word "overloaded" is accepted on its own because no provider uses it for
 * anything else.
 */
function serverSideFailure(text: string): QuotaClass | undefined {
  const overloaded = /\boverloaded\b/i.test(text);
  const status5xx = /\b(?:status|http|code|error)\b[^0-9]{0,12}\b5(?:00|02|03|04|29)\b/i.test(text)
    || /\b5(?:00|02|03|04|29)\b\s*(?:overloaded|internal server error|bad gateway|service unavailable|gateway timeout)/i.test(text);
  if (!overloaded && !status5xx) return undefined;
  return {
    kind: "transient",
    // Honour an explicit retry-after; otherwise let the caller pick its default.
    // An overloaded server rarely says how long, and guessing long here would
    // stall a run that a few seconds would have fixed.
    retryAfterSec: findRetryAfterSec(text),
    hint: overloaded ? "provider overloaded (5xx) — transient" : "provider server error (5xx) — transient",
  };
}

/**
 * Credential trouble, in the phrasings the CLIs actually print.
 *
 * This was five different regexes, one per runtime, and each missed what the
 * others had: Codex did not recognise `authentication failed`, Claude did not
 * recognise a bare `401`, and NOT ONE of them recognised an EXPIRED SESSION —
 * the family a fully paid, signed-in user hits when the local OAuth token can
 * no longer be refreshed. Measured on a client's machine, 2026-09-11: `OAuth
 * session expired and could not be refreshed` classified as a generic `error`,
 * so the cascade neither cooled the dead runtime down nor handed off, and an
 * entire business silently became `agent-x`.
 *
 * The quota checks in each classifier still run FIRST, so "you have hit your
 * usage limit" stays a quota, not a credential. What is scoped tightly on
 * purpose: only a session, token or credential "expired" counts — a plan or a
 * subscription that expired is the provider's billing, not this machine's login.
 */
/**
 * "The plan's allowance is spent", in the phrasings the CLIs print.
 *
 * Four classifiers carried their own spelling of this and the Gemini CLI one
 * (since removed) carried none at all, so one sentence was a quota on four runtimes and a
 * generic error on the fifth — and a generic error neither cools the runtime
 * down nor hands off. The older `you'?ve?` also failed to match the written-out
 * "you have", which is how a real ceiling read as an unknown failure.
 */
const USAGE_LIMIT_PATTERN =
  /you(?:'ve|\s+have|ve)?\s+(hit|reached)\s+(your|the)\s+(usage\s+)?limit|usage\s+limit\s+(reached|exceeded)|hit\s+the\s+(usage|message)\s+limit/i;
const AUTH_PATTERN =
  /no\s+(api[ _-]?key|credentials)|missing\s+(api[ _-]?key|credentials)|invalid\s+(api[ _-]?key|credentials|token|grant|refresh[ _-]?token)|api[ _-]?key|OPENAI_API_KEY|unauthor|forbidden|\b401\b|authenticat|please\s+(sign|log)\s*in|sign[ _-]?in|login\s+required|(session|token|credential)s?\s+(ha[sv]e?\s+)?expired|expired\s+(session|token|credential)|could\s+not\s+be\s+refreshed|failed\s+to\s+refresh|refresh\s+token\s+(is\s+)?(invalid|expired|not\s+set)|re-?authenticate|run\s+`?[\w-]+\s+login`?/i;

function classifyClaudeCode(text: string): QuotaClass {
  const t = text.toLowerCase();
  // Subscription windows surface as text — not status codes. The live message
  // is "You've hit your weekly limit · resets May 26, 8pm" — note the
  // contraction "you've" and the "· resets" suffix (not "reached"/"exceeded").
  if (/weekly\s+(usage\s+)?(limit|cap)/i.test(text)
   || /you(?:'ve|\s+have|ve)?\s+(reached|hit)\s+(your\s+)?weekly/i.test(text)
   || /you\s+have\s+(reached|hit)\s+your\s+weekly/i.test(text)) {
    return { kind: "quota_exhausted", ttlSec: DEFAULT_TTL.weekly, hint: "Claude Code weekly cap reached", window: "weekly" };
  }
  if (/5[- ]?hour\s+(limit|cap)\s+(reached|exceeded)/i.test(text)
   || /usage\s+limit.*reset(s)?\s+(at|in)/i.test(text)) {
    const retry = findRetryAfterSec(text);
    return { kind: "quota_exhausted", ttlSec: retry ?? DEFAULT_TTL["5h"], hint: "Claude Code 5-hour window reached", window: "5h" };
  }
  if (USAGE_LIMIT_PATTERN.test(text)) {
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
  if (AUTH_PATTERN.test(text)) {
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
  if (USAGE_LIMIT_PATTERN.test(text)) {
    return { kind: "quota_exhausted", ttlSec: DEFAULT_TTL["5h"], hint: "Codex (ChatGPT plan) usage limit reached", window: "5h" };
  }
  if (/rate[ _-]?limit|too\s+many\s+requests|\b429\b/i.test(text)) {
    const retry = findRetryAfterSec(text);
    if (retry !== undefined && retry < 120) return { kind: "transient", retryAfterSec: retry, hint: "Codex rate limit (transient)" };
    return { kind: "quota_exhausted", ttlSec: retry ?? DEFAULT_TTL["5h"], hint: "Codex rate limit (treating as quota)", window: "5h" };
  }
  if (AUTH_PATTERN.test(text)) {
    return { kind: "auth_failed", hint: "Codex auth missing/invalid" };
  }
  return { kind: "error", hint: text.slice(0, 200) };
}

// Antigravity CLI runs on the Google backend (Gemini models): the Google
// quota vocabulary plus the Antigravity-specific "compute budget" language for
// the 5h-window of consumer tiers.
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
  if (USAGE_LIMIT_PATTERN.test(text)) {
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
  if (AUTH_PATTERN.test(text)) {
    return { kind: "auth_failed", hint: "Antigravity auth missing/invalid (try `agy` to re-auth)" };
  }
  return { kind: "error", hint: text.slice(0, 200) };
}

// Pi Coding Agent — multi-provider (the error comes from the provider ACTIVE
// in the session), so the patterns are the common denominator of the surfaces:
// OpenAI-style insufficient_quota, Google RESOURCE_EXHAUSTED, subscription
// phrasing (Claude Pro/Max, ChatGPT via pi's OAuth), generic 429.
function classifyPi(text: string): QuotaClass {
  // Real phrasing confirmed (xai via pi 0.82.1): 403 "has either used all
  // available credits or reached its monthly spending limit".
  if (/insufficient_quota|quota\s+(exceeded|reached)|out\s+of\s+credits|credit\s+balance\s+is\s+too\s+low|used\s+all\s+available\s+credits|purchase\s+more\s+credits|monthly\s+spending\s+limit|spending\s+limit\s+(reached|exceeded)/i.test(text)) {
    return { kind: "quota_exhausted", ttlSec: DEFAULT_TTL.monthly, hint: "Pi provider quota/credits exhausted", window: "monthly" };
  }
  if (/resource\s+has\s+been\s+exhausted|RESOURCE_EXHAUSTED|daily\s+(limit|quota)/i.test(text)) {
    return { kind: "quota_exhausted", ttlSec: DEFAULT_TTL["5h"], hint: "Pi provider quota exhausted", window: "5h" };
  }
  if (/weekly\s+(limit|cap)|usage\s+cap\s+for\s+the\s+week/i.test(text)) {
    return { kind: "quota_exhausted", ttlSec: DEFAULT_TTL.weekly, hint: "Pi (subscription) weekly cap reached", window: "weekly" };
  }
  if (USAGE_LIMIT_PATTERN.test(text)) {
    return { kind: "quota_exhausted", ttlSec: DEFAULT_TTL["5h"], hint: "Pi (subscription) usage limit reached", window: "5h" };
  }
  if (/rate[ _-]?limit|too\s+many\s+requests|\b429\b/i.test(text)) {
    const retry = findRetryAfterSec(text);
    if (retry !== undefined && retry < 120) return { kind: "transient", retryAfterSec: retry, hint: "Pi rate limit (transient)" };
    return { kind: "quota_exhausted", ttlSec: retry ?? DEFAULT_TTL["5h"], hint: "Pi rate limit (treating as quota)", window: "5h" };
  }
  if (/ModelNotFoundError|model[\s_-]+not[\s_-]+found|unknown\s+model|\bnot\s+found\b.*model/i.test(text)) {
    return { kind: "quota_exhausted", ttlSec: 60 * 60, hint: "Pi model not found (check pi:<model>@<provider> in LLM_CASCADE / models.json)", window: "5h" };
  }
  if (AUTH_PATTERN.test(text)) {
    return { kind: "auth_failed", hint: "Pi provider auth missing/invalid (API key no env/auth.json, ou `pi` → /login)" };
  }
  return { kind: "error", hint: text.slice(0, 200) };
}

export function classify(runtime: Runtime, r: RunResultLike, now: number = Date.now()): QuotaClass {
  if (r.ok && r.exitCode === 0) return { kind: "ok" };
  const text = normalizeQuotes([r.stderr, r.error, r.result].filter(Boolean).join("\n"));
  if (!text) return { kind: "error", hint: `runtime ${runtime} exit ${r.exitCode} with no output` };
  let v: QuotaClass;
  if (runtime === "claude-code") v = refineServerFailure(classifyClaudeCode(text), text);
  else if (runtime === "codex") v = refineServerFailure(classifyCodex(text), text);
  else if (runtime === "antigravity-cli") v = refineServerFailure(classifyAntigravity(text), text);
  else if (runtime === "pi") v = refineServerFailure(classifyPi(text), text);
  else return { kind: "error", hint: `unknown runtime ${runtime}` };
  return withNamedReset(v, text, now);
}

/** A quota whose message names its reset gets that reset, whatever window the
 *  table guessed: the window default is only for a message that names none. */
function withNamedReset(v: QuotaClass, text: string, now: number): QuotaClass {
  if (v.kind !== "quota_exhausted") return v;
  const at = findResetAtMs(text, now);
  if (at !== undefined && at > now) {
    return { ...v, ttlSec: Math.max(60, Math.ceil((at - now) / 1000)), resetAt: new Date(at).toISOString() };
  }
  const rel = findRetryAfterSec(text, now);
  if (rel !== undefined && rel > 0) return { ...v, ttlSec: rel, resetAt: new Date(now + rel * 1000).toISOString() };
  return v;
}

/**
 * The runtime never reached the model: the connection broke, the name did not
 * resolve, the stream dropped. Not a verdict on the work and not a quota. A
 * caller that counts attempts (the gate's correction rounds) must not count
 * one that failed this way.
 */
export function isTransportFailure(text: string | null | undefined): boolean {
  return /\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|ENETUNREACH)\b|socket\s+hang\s+up|fetch\s+failed|network\s+(?:error|is\s+unreachable)|stream\s+(?:disconnected|error|closed\s+before)|connection\s+(?:reset|refused|closed|error)|error\s+sending\s+request/i.test(text ?? "");
}

/**
 * Is this text a spent quota, whichever runtime printed it? For a caller that
 * holds an error string but not the runtime that produced it (the judge's
 * failed call, a ledger row's last_error). Null when it is not a quota.
 * `resetAt` is always set: the time the message names, else now + the
 * window's default cooldown.
 */
export function quotaStop(text: string | null | undefined, runtime?: Runtime | null, now: number = Date.now()): { resetAt: string; hint: string; named: boolean } | null {
  if (!text) return null;
  // The named runtime's own table first; then the two generic ones, so a row
  // that recorded no runtime (or one with no table) is still read.
  const runtimes = [...new Set<Runtime>([...(runtime ? [runtime] : []), "codex", "claude-code"])];
  for (const rt of runtimes) {
    const v = classify(rt, { ok: false, exitCode: 1, error: text }, now);
    if (v.kind === "quota_exhausted") {
      return { resetAt: v.resetAt ?? new Date(now + v.ttlSec * 1000).toISOString(), hint: v.hint, named: !!v.resetAt };
    }
  }
  return null;
}

/**
 * The runtime tables get first say: a 503 that a provider uses to mean "your
 * plan is spent" must stay quota_exhausted, because that needs a cooldown and a
 * handoff, not a retry against the same wall. Only a verdict of `error` — the
 * bucket that means "we do not recognise this" — is re-examined for a 5xx.
 */
function refineServerFailure(v: QuotaClass, text: string): QuotaClass {
  if (v.kind !== "error") return v;
  return serverSideFailure(text) ?? v;
}
