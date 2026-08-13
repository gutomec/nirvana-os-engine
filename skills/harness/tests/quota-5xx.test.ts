// quota-5xx.test.ts — a 5xx is transient, which the header always claimed and
// no rule ever implemented.
//
// Found by a real incident (galinha-dos-ovos-de-ouro, 2026-08-13 23:04): an
// Anthropic 529 Overloaded killed a dispatch that would have succeeded seconds
// later. Every 5xx fell through to `error`, and the cascade treats `error` as
// fatal — it emits runtime_error and gives up, where `transient` sleeps and
// retries the same runtime. The agentic orchestrator recovered by reasoning
// about the error in prose; the scripted path had nothing to reason with.
import { describe, expect, test } from "bun:test";
import { classify } from "../lib/quota-detector.ts";

const fail = (stderr: string) => ({ ok: false, exitCode: 1, stderr });

describe("5xx classifies as transient", () => {
  test("the exact 529 payload from the incident", () => {
    const v = classify("claude-code", fail(
      'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
    ));
    expect(v.kind).toBe("transient");
  });

  test("the gateway family, on every runtime", () => {
    for (const rt of ["claude-code", "codex", "gemini-cli", "antigravity-cli", "pi"] as const) {
      for (const body of ["HTTP 503 Service Unavailable", "status 500 internal server error", "error 502 bad gateway"]) {
        expect(classify(rt, fail(body)).kind).toBe("transient");
      }
    }
  });

  test('the bare word "overloaded" is enough', () => {
    // No provider uses it for anything else, and a 529 does not always print
    // its status code.
    expect(classify("claude-code", fail("Server overloaded, please retry")).kind).toBe("transient");
  });

  test("an explicit retry-after is carried through", () => {
    const v = classify("claude-code", fail("503 service unavailable, retry-after: 30"));
    expect(v.kind).toBe("transient");
    if (v.kind === "transient") expect(v.retryAfterSec).toBe(30);
  });
});

describe("what must NOT become transient", () => {
  test("a loose number that happens to be 5xx-shaped", () => {
    // "529" can be a line number or a token count. Without status-shaped
    // context around it, a retry would be guessing.
    expect(classify("claude-code", fail("parsed 529 tokens from the file")).kind).toBe("error");
    expect(classify("codex", fail("line 500: unexpected token")).kind).toBe("error");
  });

  test("quota keeps its verdict — it needs a cooldown, not a retry", () => {
    // Retrying the same runtime against a spent plan buys the same wall at full
    // price. The runtime tables get first say for exactly this reason.
    const v = classify("claude-code", fail("Rate limit reached. Your limit will reset at 3pm."));
    expect(v.kind).toBe("quota_exhausted");
  });

  test("auth failure keeps its verdict", () => {
    const v = classify("pi", fail("401 unauthorized: invalid api key"));
    expect(v.kind).toBe("auth_failed");
  });

  test("a genuine bug stays an error", () => {
    expect(classify("claude-code", fail("TypeError: cannot read property 'x' of undefined")).kind).toBe("error");
  });

  test("success is still ok", () => {
    expect(classify("claude-code", { ok: true, exitCode: 0 }).kind).toBe("ok");
  });
});
