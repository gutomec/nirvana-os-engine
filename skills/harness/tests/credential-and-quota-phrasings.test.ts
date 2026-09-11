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
import { classify } from "../lib/quota-detector.ts";
import type { Runtime } from "../../_shared/lib/host-agent-driver.ts";

const RUNTIMES: Runtime[] = ["claude-code", "codex", "gemini-cli", "antigravity-cli", "pi"];
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
