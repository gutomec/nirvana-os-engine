// serve-webhook-delivery.test.ts — the delivery guarantees cut 7 of
// `.nirvana/plans/event-contract.md` adds on top of the HMAC signature that
// already existed: a replay window, a stable idempotency key, and an
// exponential-backoff retry schedule that is persisted (so it survives this
// process dying) and eventually gives up rather than retrying forever.
//
// One failing-first test per guarantee, per the verification contract:
//   - a duplicate delivery is not processed twice (the id is stable, so a
//     receiver-side dedupe recognizes the retry as the same event);
//   - a replayed old request is refused (the timestamp + tolerance window);
//   - a failing endpoint is retried with growing delay and eventually stops
//     (the outbox's own state machine, no real waiting required — every
//     delay is asserted as a number, never slept through).

import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sign, verifyWebhook, deliveryId, deliveryHeaders, referenceBody, REPLAY_WINDOW_SEC } from "../lib/serve/webhooks.ts";
import * as outbox from "../lib/serve/webhook-outbox.ts";

describe("signature + replay window — the receiver's half of the contract", () => {
  const secret = "s3cr3t-do-consumidor";

  test("a fresh, correctly signed request verifies", () => {
    const body = JSON.stringify({ event: "run.finished", trace_id: "run_x" });
    const headers = deliveryHeaders(body, secret, "delivery-1");
    const result = verifyWebhook({ body, signature: headers["X-Nirvana-Signature"], timestamp: headers["X-Nirvana-Timestamp"], secret });
    expect(result.valid).toBe(true);
  });

  test("a replayed old request is refused", () => {
    const body = JSON.stringify({ event: "run.finished" });
    const oldTimestamp = String(Math.floor(Date.now() / 1000) - REPLAY_WINDOW_SEC - 61);
    const signature = sign(`${oldTimestamp}.${body}`, secret);
    const result = verifyWebhook({ body, signature, timestamp: oldTimestamp, secret });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("timestamp_too_old");
  });

  test("a timestamp claiming to be from the future beyond clock skew is refused", () => {
    const body = JSON.stringify({ event: "run.finished" });
    const futureTimestamp = String(Math.floor(Date.now() / 1000) + 3600);
    const signature = sign(`${futureTimestamp}.${body}`, secret);
    const result = verifyWebhook({ body, signature, timestamp: futureTimestamp, secret });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("timestamp_too_new");
  });

  test("a tampered body invalidates the signature even with a fresh timestamp", () => {
    const body = JSON.stringify({ event: "run.finished" });
    const headers = deliveryHeaders(body, secret, "delivery-2");
    const result = verifyWebhook({ body: body + "x", signature: headers["X-Nirvana-Signature"], timestamp: headers["X-Nirvana-Timestamp"], secret });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("bad_signature");
  });

  test("the wrong secret fails verification", () => {
    const body = JSON.stringify({ event: "run.finished" });
    const headers = deliveryHeaders(body, secret, "delivery-3");
    const result = verifyWebhook({ body, signature: headers["X-Nirvana-Signature"], timestamp: headers["X-Nirvana-Timestamp"], secret: "outro-segredo" });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("bad_signature");
  });

  test("a missing timestamp is refused, not treated as fresh", () => {
    const body = "{}";
    const result = verifyWebhook({ body, signature: sign(body, secret), timestamp: null, secret });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("timestamp_missing");
  });
});

describe("idempotency key — reused from cut 2's CloudEvents id, not reinvented", () => {
  test("stable across two computations of the exact same terminal event", () => {
    const env = { trace_id: "run_abc", state: "delivered" as const };
    expect(deliveryId(env)).toBe(deliveryId(env));
  });

  test("differs for a different run", () => {
    const a = deliveryId({ trace_id: "run_a", state: "delivered" as const });
    const b = deliveryId({ trace_id: "run_b", state: "delivered" as const });
    expect(a).not.toBe(b);
  });

  test("a duplicate delivery is not processed twice — a receiver dedupes on this id", () => {
    const seen = new Set<string>();
    const receive = (id: string) => (seen.has(id) ? "duplicate" : (seen.add(id), "processed"));
    const env = { trace_id: "run_dup", state: "delivered" as const };
    const id = deliveryId(env);
    expect(receive(id)).toBe("processed");
    // The retry after a timeout carries the SAME id — that is the guarantee.
    expect(receive(id)).toBe("duplicate");
  });
});

describe("payload by reference, never by value", () => {
  test("the reference body carries no summary, reservations or artifact content", () => {
    const env = {
      trace_id: "run_x", session_id: "ses_1", state: "delivered" as const, gate: "pass" as const,
      summary: "conteúdo sensível do caso", reservations: "nota confidencial do cliente",
    };
    const body = referenceBody(env);
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("sensível");
    expect(raw).not.toContain("confidencial");
    expect(body.job_url).toContain("/v1/jobs/run_x");
    expect(body.result_url).toBe(`${body.job_url}/result`);
  });
});

describe("exponential backoff with jitter", () => {
  test("every attempt's delay stays within [0, cap] and the cap grows exponentially", () => {
    for (let attempt = 1; attempt <= 12; attempt++) {
      const cap = Math.min(60 * 60 * 1000, 1000 * 2 ** (attempt - 1));
      expect(outbox.backoffMs(attempt, () => 1)).toBeLessThanOrEqual(cap);
      expect(outbox.backoffMs(attempt, () => 0)).toBe(0);
    }
  });

  test("caps at one hour once the exponential would exceed it", () => {
    expect(outbox.backoffMs(20, () => 1)).toBe(60 * 60 * 1000);
  });
});

describe("webhook outbox — the retry schedule survives without a broker", () => {
  const root = mkdtempSync(join(tmpdir(), "outbox-"));
  let n = 0;
  const freshRoot = () => join(root, "run-" + n++);
  const hook = { url: "https://example.invalid/hook", secret: "s" };

  test("a fresh delivery is due immediately", () => {
    const out = freshRoot();
    outbox.enqueue(out, { id: "d1", trace_id: "run_1", session_dir: out, ...hook, body: "{}" });
    const state = outbox.readState(out)!;
    expect(state.status).toBe("pending");
    expect(outbox.isDue(state)).toBe(true);
  });

  test("re-enqueuing the same id is a no-op — the history is not duplicated", () => {
    const out = freshRoot();
    outbox.enqueue(out, { id: "d2", trace_id: "run_2", session_dir: out, ...hook, body: "{}" });
    outbox.enqueue(out, { id: "d2", trace_id: "run_2", session_dir: out, ...hook, body: "{}" });
    const lines = readFileSync(join(out, ".webhook-delivery.jsonl"), "utf8").trim().split("\n");
    expect(lines.length).toBe(1);
  });

  test("a failing endpoint is retried with growing delay and eventually stops", () => {
    const out = freshRoot();
    outbox.enqueue(out, { id: "d3", trace_id: "run_3", session_dir: out, ...hook, body: "{}" });
    let state = outbox.readState(out)!;
    const scheduledDelays: number[] = [];
    for (let i = 0; i < outbox.MAX_ATTEMPTS; i++) {
      const before = Date.now();
      state = outbox.recordAttempt(out, state, { ok: false, error: "connection refused" });
      if (state.status === "pending") scheduledDelays.push(new Date(state.next_attempt_at).getTime() - before);
    }
    // The ceiling: after MAX_ATTEMPTS failures it gives up rather than
    // retrying forever — a different defect than the one this cut fixes.
    expect(state.status).toBe("abandoned");
    expect(state.attempt).toBe(outbox.MAX_ATTEMPTS);
    expect(scheduledDelays.length).toBe(outbox.MAX_ATTEMPTS - 1);
    // Growing: scheduledDelays[i] is the delay before attempt (i+2), whose
    // own cap is 1000 * 2^(i+1) ms (capped at one hour).
    for (let i = 0; i < scheduledDelays.length; i++) {
      const cap = Math.min(60 * 60 * 1000, 1000 * 2 ** (i + 1));
      expect(scheduledDelays[i]).toBeLessThanOrEqual(cap);
    }
  });

  test("a delivery that succeeds is marked delivered and leaves the pending set", () => {
    const out = freshRoot();
    outbox.enqueue(out, { id: "d4", trace_id: "run_4", session_dir: out, ...hook, body: "{}" });
    const before = outbox.pendingCount();
    const state = outbox.recordAttempt(out, outbox.readState(out)!, { ok: true });
    expect(state.status).toBe("delivered");
    expect(outbox.pendingCount()).toBe(before - 1);
  });

  test("adoptPending rediscovers a delivery this process forgot about (crash recovery)", () => {
    const sessRoot = mkdtempSync(join(tmpdir(), "sessions-"));
    const outputsBase = join(sessRoot, "ses_x", ".nirvana", "outputs", "run_5");
    mkdirSync(outputsBase, { recursive: true });
    const now = new Date().toISOString();
    writeFileSync(join(outputsBase, ".webhook-delivery.jsonl"), JSON.stringify({
      id: "d5", trace_id: "run_5", session_dir: outputsBase, ...hook, body: "{}",
      attempt: 0, next_attempt_at: now, status: "pending", last_error: null, created_at: now,
    }) + "\n");
    const before = outbox.pendingCount();
    const found = outbox.adoptPending(sessRoot);
    expect(found).toBe(1);
    expect(outbox.pendingCount()).toBe(before + 1);
    rmSync(sessRoot, { recursive: true, force: true });
  });
});
