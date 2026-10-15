// credential-and-quota-phrasings.test.ts — what the classifier must recognise.
//
// `classify` decides what the cascade does next: a credential problem cools the
// runtime down and hands off to the next one, a quota does the same with its own
// window, and a generic `error` does NEITHER — it returns the failure as is,
// because "the cause is the brief or the machine, not the runtime".
//
// So a phrasing the classifier does not know is not cosmetic. Measured on a
// client's machine (2026-09-11): `OAuth session expired and could not be
// refreshed` read as a generic error, so the dead runtime was never cooled down,
// the run never handed off, and an entire business silently became `agent-x`.
// Five classifiers carried five different regexes; each missed what the others
// had, and NONE knew the expired-session family.
import { describe, expect, test } from "bun:test";
import { classify, findResetAtMs, normalizeQuotes, quotaStop } from "../lib/quota-detector.ts";
import type { Runtime } from "../../_shared/lib/host-agent-driver.ts";

const RUNTIMES: Runtime[] = ["claude-code", "codex", "antigravity-cli", "pi"];
const failed = (text: string) => ({ ok: false, exitCode: 1, stderr: text, error: "", result: "" });

describe("a credential the machine can no longer use", () => {
  const CREDENTIAL = [
    "OAuth session expired and could not be refreshed",
    "session expired",
    "token has expired",
    "refresh token is invalid",
    "failed to refresh",
    "Please run codex login",
    "please re-authenticate",
    "authentication failed",
    "unauthorized",
    "401 Unauthorized",
    "no API key found",
    "OPENAI_API_KEY not set",
  ];

  test.each(RUNTIMES)("%s recognises every phrasing as a credential failure", (runtime) => {
    for (const text of CREDENTIAL) {
      expect(classify(runtime, failed(text)).kind, `${runtime} ← ${text}`).toBe("auth_failed");
    }
  });
});

describe("a ceiling the plan hit", () => {
  test.each(RUNTIMES)("%s reads the usage limit in both spellings", (runtime) => {
    for (const text of ["You've hit your usage limit", "You have hit your usage limit", "You have reached your usage limit", "usage limit reached"]) {
      expect(classify(runtime, failed(text)).kind, `${runtime} ← ${text}`).toBe("quota_exhausted");
    }
  });

  test("a quota is never mistaken for a credential, and the ORDER is what guarantees it", () => {
    // Both families can contain the word "limit"; quota is tested first in every
    // classifier, so the specific reading wins over the general one.
    expect(classify("codex", failed("quota exceeded")).kind).toBe("quota_exhausted");
    expect(classify("codex", failed("rate limit reached")).kind).toBe("quota_exhausted");
    expect(classify("claude-code", failed("weekly limit reached")).kind).toBe("quota_exhausted");
  });
});

// The messages of the 2026-10-14 incident logs, verbatim: Codex prints a CURLY
// apostrophe (U+2019), and the classifier read every one of them as `error`.
const CODEX_AT_TIME = "You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at 1:21 AM.";
const CODEX_AT_DATE = "You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at Oct 14th, 2026 1:21 AM.";
const CODEX_PM = "You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at 12:39 PM.";

describe("the incident's Codex usage limit, curly apostrophe and absolute reset", () => {
  // 13 Oct 2026, 20:55 local: the reset "1:21 AM" is the next day.
  const now = new Date(2026, 9, 13, 20, 55).getTime();

  test.each(RUNTIMES)("%s reads the curly apostrophe as a quota", (runtime) => {
    expect(classify(runtime, failed(CODEX_AT_TIME), now).kind).toBe("quota_exhausted");
    expect(classify(runtime, failed("You’ve reached your usage limit"), now).kind).toBe("quota_exhausted");
  });

  test("a time with no date is its next occurrence in local time, rolling to the next day", () => {
    const v = classify("codex", { ok: false, exitCode: 1, error: CODEX_AT_TIME }, now);
    expect(v.kind).toBe("quota_exhausted");
    if (v.kind !== "quota_exhausted") return;
    const at = new Date(v.resetAt!);
    expect([at.getFullYear(), at.getMonth(), at.getDate(), at.getHours(), at.getMinutes()]).toEqual([2026, 9, 14, 1, 21]);
    expect(v.ttlSec).toBe((at.getTime() - now) / 1000);
    // Earlier the same day: the same time is still ahead, today.
    const morning = new Date(2026, 9, 14, 0, 30).getTime();
    expect(new Date(findResetAtMs(CODEX_AT_TIME, morning)!).getDate()).toBe(14);
  });

  test("a date with a year is that moment", () => {
    const at = new Date(findResetAtMs(CODEX_AT_DATE, now)!);
    expect([at.getFullYear(), at.getMonth(), at.getDate(), at.getHours(), at.getMinutes()]).toEqual([2026, 9, 14, 1, 21]);
    expect(new Date(findResetAtMs(CODEX_PM, now)!).getHours()).toBe(12);
  });

  test("Claude's forms: a zone, a date without a year, an epoch, an ISO time", () => {
    expect(new Date(findResetAtMs("You've hit your limit · resets 3am (UTC)", now)!).toISOString()).toBe("2026-10-14T03:00:00.000Z");
    expect(new Date(findResetAtMs("5-hour limit reached ∙ resets 3am (America/Sao_Paulo)", now)!).toISOString()).toBe("2026-10-14T06:00:00.000Z");
    const may = new Date(findResetAtMs("You've hit your weekly limit · resets May 26, 8pm", now)!);
    expect([may.getFullYear(), may.getMonth(), may.getDate(), may.getHours()]).toEqual([2027, 4, 26, 20]);
    expect(findResetAtMs("Claude AI usage limit reached|1791000000", now)).toBe(1791000000 * 1000);
    expect(findResetAtMs("usage limit reached, resets at 2026-10-14T04:21:00Z", now)).toBe(Date.parse("2026-10-14T04:21:00Z"));
    const weekly = classify("claude-code", failed("You've hit your weekly limit · resets May 26, 8pm"), now);
    expect(weekly.kind === "quota_exhausted" && weekly.resetAt).toBeTruthy();
  });

  test("a number that is not a time is not a reset", () => {
    expect(findResetAtMs("the request resets 5 times", now)).toBeUndefined();
    expect(findResetAtMs("try again at 25:00", now)).toBeUndefined();
    const v = classify("codex", failed("You have hit your usage limit"), now);
    expect(v.kind === "quota_exhausted" && v.resetAt).toBeFalsy();
  });

  test("quotaStop reads the text whatever runtime printed it, and always gives a reset", () => {
    expect(quotaStop(CODEX_AT_TIME, null, now)).toMatchObject({ named: true });
    expect(quotaStop(`revision run: ${CODEX_AT_TIME}`, "claude-code", now)?.named).toBe(true);
    const unnamed = quotaStop("usage limit reached", null, now)!;
    expect(unnamed.named).toBe(false);
    expect(Date.parse(unnamed.resetAt)).toBeGreaterThan(now);
    expect(quotaStop("TypeError: x is not a function", null, now)).toBeNull();
  });

  test("every quote and apostrophe the CLIs print is normalised before any pattern runs", () => {
    expect(normalizeQuotes("You’ve ‘x’ “y” Youʼve")).toBe(`You've 'x' "y" You've`);
  });
});

describe("what must NOT become a credential failure", () => {
  test("a plan that expired is the provider's billing, not this machine's login", () => {
    // Scoped on purpose: only a session, token or credential that expired counts.
    expect(classify("codex", failed("your plan expired")).kind).not.toBe("auth_failed");
  });

  test("an ordinary failure stays an ordinary failure, so the cascade does not rotate on it", () => {
    for (const text of ["ENOENT no such file or directory", "TypeError: x is not a function", "command not found"]) {
      expect(classify("codex", failed(text)).kind, text).toBe("error");
    }
  });

  test("a successful run is never classified at all", () => {
    expect(classify("codex", { ok: true, exitCode: 0, stderr: "", error: "", result: "done" }).kind).toBe("ok");
  });
});
