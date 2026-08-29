// webhooks.ts — one delivery attempt: signed, timestamped, idempotent.
//
// This file no longer owns the retry schedule — a promise-chain retry inside
// an async function dies with the process, and the case this must survive
// (dispatch p99 5.7h, longest run 25.5h) guarantees the process outlives at
// least one delivery attempt. `webhook-outbox.ts` owns persistence and
// backoff; this file owns exactly one HTTP attempt and the crypto around it.
//
// Payload by reference, never by value: the body carries identifiers and a
// path back into this API, never the run's summary or reservations text — a
// legal case is sensitive, and the consumer already holds the credential
// needed to fetch the real content.

import { createHmac, timingSafeEqual } from "node:crypto";
import { eventId } from "../../../_shared/lib/cloudevents.js";
import type { RunEnvelope } from "./runs.ts";

export function sign(body: string, secret: string): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

/**
 * Stable across every retry of the SAME terminal event — computed from the
 * envelope's own content, not from the attempt count, using the CloudEvents
 * `id` algorithm cut 2 already gave every audit event
 * (`_shared/lib/cloudevents.js`). Reused rather than reinvented: a second
 * idempotency scheme at the one boundary that needs it most would be the
 * defect this cut exists to close.
 */
export function deliveryId(env: Pick<RunEnvelope, "trace_id" | "state">): string {
  return eventId({
    type: "sh.squads.nirvana.delivery.run_finished",
    source: "/engine/serve",
    subject: env.trace_id,
    dataText: JSON.stringify({ state: env.state }),
  });
}

/** 5-minute replay window, 60s clock skew — the numbers the plan measured. */
export const REPLAY_WINDOW_SEC = 300;
const CLOCK_SKEW_SEC = 60;

/**
 * The reference receiver's payload: an id and an authenticated path back
 * into this API, never the deliverable's content. `baseUrl` is only known
 * when the operator set `NIRVANA_SERVE_PUBLIC_URL` (the bind address behind
 * a reverse proxy is not the public one); absent it, the paths are relative
 * — the consumer already knows the host, because it is the one that called
 * this API in the first place.
 */
export function referenceBody(env: Pick<RunEnvelope, "trace_id" | "session_id" | "state" | "gate">, baseUrl = process.env.NIRVANA_SERVE_PUBLIC_URL ?? ""): {
  event: "run.finished"; trace_id: string; session_id: string; state: RunEnvelope["state"]; gate: RunEnvelope["gate"]; job_url: string; result_url: string;
} {
  const base = baseUrl.replace(/\/+$/, "");
  return {
    event: "run.finished",
    trace_id: env.trace_id,
    session_id: env.session_id,
    state: env.state,
    gate: env.gate,
    job_url: `${base}/v1/jobs/${env.trace_id}`,
    result_url: `${base}/v1/jobs/${env.trace_id}/result`,
  };
}

export function deliveryHeaders(body: string, secret: string, id: string, event = "run.finished"): Record<string, string> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  return {
    "Content-Type": "application/json",
    // Signed over `${timestamp}.${body}`, not the bare body — binding the
    // timestamp into the signature is what stops a captured request from
    // being replayed with a forged fresh timestamp header.
    "X-Nirvana-Signature": sign(`${timestamp}.${body}`, secret),
    "X-Nirvana-Event": event,
    "X-Nirvana-Timestamp": timestamp,
    "X-Nirvana-Delivery-Id": id,
  };
}

export interface VerifyResult {
  valid: boolean;
  reason?: "bad_signature" | "timestamp_missing" | "timestamp_invalid" | "timestamp_too_old" | "timestamp_too_new";
}

/**
 * The receiver's half of the contract, exported so a real consumer (or this
 * repo's own tests standing in for one) has a reference instead of
 * reinventing timestamp math against a 5-minute window. Rejects a replayed
 * old request and a signature that does not cover the claimed timestamp.
 */
export function verifyWebhook(opts: { body: string; signature: string | null; timestamp: string | null; secret: string; toleranceSec?: number }): VerifyResult {
  const { body, signature, timestamp, secret } = opts;
  if (!timestamp) return { valid: false, reason: "timestamp_missing" };
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return { valid: false, reason: "timestamp_invalid" };
  const tolerance = opts.toleranceSec ?? REPLAY_WINDOW_SEC;
  const now = Math.floor(Date.now() / 1000);
  if (ts < now - tolerance - CLOCK_SKEW_SEC) return { valid: false, reason: "timestamp_too_old" };
  if (ts > now + CLOCK_SKEW_SEC) return { valid: false, reason: "timestamp_too_new" };
  if (!signature) return { valid: false, reason: "bad_signature" };
  const expected = Buffer.from(sign(`${timestamp}.${body}`, secret));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { valid: false, reason: "bad_signature" };
  return { valid: true };
}

/**
 * One HTTP attempt. No retry here — `webhook-outbox.ts` owns the schedule
 * and calls this once per due attempt, persisting the result before
 * deciding whether there will be another one.
 */
export async function attemptDelivery(hook: { url: string; secret: string }, body: string, id: string): Promise<{ ok: boolean; status?: number; error?: string }> {
  try {
    const res = await fetch(hook.url, {
      method: "POST",
      headers: deliveryHeaders(body, hook.secret, id),
      body,
      signal: AbortSignal.timeout(10_000),
    });
    return { ok: res.ok, status: res.status };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
