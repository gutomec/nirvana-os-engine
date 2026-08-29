// webhook-outbox.ts — the retry schedule for a webhook delivery, persisted
// so it survives THIS PROCESS dying mid-backoff, not just the receiver being
// unreachable for a moment.
//
// One JSON object per line, appended (never rewritten), in a file beside the
// run's own state — the same place `runs.ts` already keeps `.run.json`
// next to the artifacts it describes, because a run's identity belongs on
// disk, not only in this process's memory. The last line is the current
// state; earlier lines are the attempt history. No broker, no queue
// infrastructure, no new dependency — the constraint this cut was given.
//
// Durability note (event-contract plan, cut 7): PR #159
// (`feat/durable-work-continuity-core-pr-v9`, "Durable Work Continuity", 2,446
// lines + 4,399 of tests) was OPEN, not merged, when this was written —
// `durable-work.ts` exists only on that branch. Building on it was not
// possible without depending on unmerged, "provisional, aguardando revisão
// independente" code. This module is deliberately a narrow, three-function
// surface (`enqueue` / `sweepOnce` / `readState`) so that landing DWC later
// can become the storage underneath these same three functions — a
// `durable_work` unit of kind `generic` per delivery, `startUnit` in place of
// `enqueue`, `progressUnit`/`failUnit` in place of `recordAttempt` — without
// moving the wire contract: the headers and body a consumer receives do not
// change shape either way.
//
// The two questions the plan left open for @AndreAlmeidaDC, answered
// provisionally because this cut cannot block on them:
//   1. Job state readable over HTTP does not read DWC today — this module
//      does not touch `durable-work.ts` at all, so no sibling-authority
//      boundary is crossed yet. If DWC lands and this module is rebuilt on
//      it, the HTTP layer would only ever READ a projection (`status()` /
//      `getUnit()`), never write run lifecycle — reading is not owning.
//      If Andre decides a read still crosses the boundary, the fix is to
//      route the read through a projection function DWC exports itself
//      instead of the API querying its tables directly.
//   2. The idempotency key a consumer sees (`X-Nirvana-Delivery-Id`) lives in
//      the ENGINE's identity space today — it is the CloudEvents `id` of the
//      terminal envelope, not a DWC `operation_id`. If DWC becomes the
//      storage, the plan is to carry this SAME id in as the unit's
//      `operation_id` so the external contract is unchanged; if Andre
//      decides DWC must mint its own ids, the fix is a translation table at
//      the boundary, not a change to what the consumer receives.

import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { attemptDelivery } from "./webhooks.ts";

const require = createRequire(import.meta.url);

export type DeliveryStatus = "pending" | "delivered" | "abandoned";

export interface DeliveryRecord {
  id: string;              // idempotency key, stable across every attempt
  trace_id: string;
  session_dir: string;     // where this run's audit log lives, for the sweep's own audit trail
  url: string;
  secret: string;
  body: string;            // frozen at enqueue time — every attempt sends the exact same bytes
  attempt: number;         // attempts made so far
  next_attempt_at: string; // ISO; due when <= now
  status: DeliveryStatus;
  last_error: string | null;
  created_at: string;
}

const FILE_NAME = ".webhook-delivery.jsonl";

/**
 * Ten attempts, exponential backoff from 1s capped at 1h: the delays climb
 * 1s, 2s, 4s, 8s, 16s, 32s, 64s, 128s, 256s, 512s — a little over two hours
 * of cumulative worst case before giving up. After that the record becomes
 * `abandoned` and stays there: this is the different defect the constraint
 * warns against (a retry that never gives up), not silence — the run's
 * artifacts are already on disk and `GET /v1/jobs/{id}` never expires, so an
 * abandoned webhook is a degraded notification, not a lost result.
 */
export const MAX_ATTEMPTS = 10;
const BASE_MS = 1000;
const CAP_MS = 60 * 60 * 1000;

function fileFor(outputsRoot: string): string {
  return path.join(outputsRoot, FILE_NAME);
}

function append(outputsRoot: string, rec: DeliveryRecord): void {
  fs.mkdirSync(outputsRoot, { recursive: true });
  fs.appendFileSync(fileFor(outputsRoot), JSON.stringify(rec) + "\n");
}

/** The last line is the current state; no file yet means no delivery yet. */
export function readState(outputsRoot: string): DeliveryRecord | null {
  let raw: string;
  try { raw = fs.readFileSync(fileFor(outputsRoot), "utf8"); } catch { return null; }
  const lines = raw.split("\n").filter((l) => l.trim());
  if (!lines.length) return null;
  try { return JSON.parse(lines[lines.length - 1]) as DeliveryRecord; } catch { return null; }
}

/** Which outputs roots this process believes still have a pending delivery. */
const pendingRoots = new Set<string>();

export function pendingCount(): number {
  return pendingRoots.size;
}

/**
 * Registers a delivery for immediate attempt. Idempotent re-registration: a
 * run finishes exactly once, but a server that crashed between writing
 * `.run.json` and enqueueing must not start a second, parallel history for
 * the same terminal event when it comes back up and re-adopts the run.
 */
export function enqueue(outputsRoot: string, rec: Pick<DeliveryRecord, "id" | "trace_id" | "session_dir" | "url" | "secret" | "body">): void {
  const existing = readState(outputsRoot);
  if (existing && existing.id === rec.id) { if (existing.status === "pending") pendingRoots.add(outputsRoot); return; }
  const now = new Date().toISOString();
  append(outputsRoot, { ...rec, attempt: 0, next_attempt_at: now, status: "pending", last_error: null, created_at: now });
  pendingRoots.add(outputsRoot);
}

export function isDue(rec: DeliveryRecord, now = Date.now()): boolean {
  return rec.status === "pending" && new Date(rec.next_attempt_at).getTime() <= now;
}

/**
 * Full jitter (AWS architecture blog): a delay uniformly random between 0
 * and the exponential cap, so a burst of runs finishing at once do not
 * retry in lockstep against the same receiver. `attempt` is 1-based — the
 * delay BEFORE that attempt number. Exposed as a pure function so a test can
 * assert the growth and the cap without waiting for either in real time.
 */
export function backoffMs(attempt: number, rng: () => number = Math.random): number {
  const exp = Math.min(CAP_MS, BASE_MS * 2 ** (attempt - 1));
  return Math.floor(rng() * exp);
}

/** Applies the outcome of one attempt and appends the new state. */
export function recordAttempt(outputsRoot: string, prev: DeliveryRecord, outcome: { ok: boolean; error?: string }): DeliveryRecord {
  const attempt = prev.attempt + 1;
  const giveUp = !outcome.ok && attempt >= MAX_ATTEMPTS;
  const next: DeliveryRecord = {
    ...prev,
    attempt,
    status: outcome.ok ? "delivered" : giveUp ? "abandoned" : "pending",
    last_error: outcome.ok ? null : (outcome.error ?? "delivery_failed").slice(0, 200),
    next_attempt_at: outcome.ok ? prev.next_attempt_at : new Date(Date.now() + backoffMs(attempt + 1)).toISOString(),
  };
  append(outputsRoot, next);
  if (next.status !== "pending") pendingRoots.delete(outputsRoot);
  return next;
}

/**
 * Crash recovery: on startup, re-discover every delivery this server left
 * `pending` when it last exited. Mirrors `runs.ts`'s own `adoptOrphans` —
 * disk is the truth, the in-memory set is cache.
 */
export function adoptPending(sessionsRoot: string): number {
  let sessions: string[];
  try { sessions = fs.readdirSync(sessionsRoot); } catch { return 0; }
  let n = 0;
  for (const sid of sessions) {
    const outputsBase = path.join(sessionsRoot, sid, ".nirvana", "outputs");
    let traces: string[];
    try { traces = fs.readdirSync(outputsBase); } catch { continue; }
    for (const t of traces) {
      const root = path.join(outputsBase, t);
      const state = readState(root);
      if (state && state.status === "pending") { pendingRoots.add(root); n++; }
    }
  }
  return n;
}

/** Never logs the url, the secret or the signature — only shape, never credentials. */
function auditDelivery(rec: DeliveryRecord, next: DeliveryRecord): void {
  try {
    const audit = require("../audit.js") as { emit: (event: string, payload: unknown, ctx: unknown) => void };
    audit.emit("x_webhook_delivery_attempted", {
      delivery_id: next.id,
      attempt: next.attempt,
      ok: next.status === "delivered",
      gave_up: next.status === "abandoned",
      status: next.status,
    }, { trace_id: rec.trace_id, cwd: rec.session_dir });
  } catch { /* audit is best-effort; a delivery must not fail because logging did */ }
}

/**
 * One sweep over every root this process believes is pending. Attempts
 * exactly the ones that are due; leaves the rest for the next sweep. Returns
 * how many attempts were made, for the health endpoint and for tests that
 * want to know a sweep did something without inspecting files.
 */
export async function sweepOnce(now = Date.now()): Promise<number> {
  let attempted = 0;
  for (const root of [...pendingRoots]) {
    const rec = readState(root);
    if (!rec || !isDue(rec, now)) continue;
    attempted++;
    const outcome = await attemptDelivery({ url: rec.url, secret: rec.secret }, rec.body, rec.id);
    const next = recordAttempt(root, rec, outcome);
    auditDelivery(rec, next);
  }
  return attempted;
}
