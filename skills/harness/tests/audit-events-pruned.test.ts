// audit-events-pruned.test.ts — plan cut 5: the 38 (re-measured: 21) enum
// entries with no producer split three ways — code-emitted through a wrapper
// the parity gate's regex missed, maestro/adapter-prescribed and real, or
// genuinely dead. This test pins the dead ones gone and the domain map still
// exhaustive over what remains.
//
// Fix when red: the reasoning for each of the five lives in
// nirvana-audits/71752663-.../cut-4-5-event-contract.md.

import { describe, expect, test } from "bun:test";

const audit = require("../lib/audit.js");
const ce = require("../../_shared/lib/cloudevents.js");

const DEAD = ["chunk_gate_failed", "chunk_gate_passed", "memory_write", "ticket_opened", "ticket_resolved"];

// A sample of the reserved/real ones this cut keeps, so a future edit that
// removes one of these without arguing it the way this cut did fails loudly.
const RESERVED_KEPT = [
  "budget_violation", "dispatch_audit_revision", "dispatch_blocked",
  "escalation_trigger_fired", "handoff", "human_notification_required",
  "human_response_received", "humanization_applied", "humanization_skipped",
  "invocation_start", "invocation_end", "isolation_violation", "target_plan_committed",
  "clarification_received",
];

describe("cut 5 — the dead enum entries are pruned", () => {
  test("the five with no producer, no doc, no reader are gone", () => {
    for (const e of DEAD) expect(audit.ALLOWED_EVENTS.has(e)).toBe(false);
  });

  test("the reserved ones this cut argued for stay", () => {
    for (const e of RESERVED_KEPT) expect(audit.ALLOWED_EVENTS.has(e)).toBe(true);
  });

  test("the domain map has no entry for a name no longer in the enum", () => {
    for (const e of DEAD) expect(Object.prototype.hasOwnProperty.call(ce.EVENT_DOMAINS, e)).toBe(false);
  });

  test("the domain map stays exhaustive over the pruned enum", () => {
    const missing = [...audit.ALLOWED_EVENTS].filter((e: string) => !ce.EVENT_DOMAINS[e]);
    const extra = Object.keys(ce.EVENT_DOMAINS).filter((k) => !audit.ALLOWED_EVENTS.has(k));
    expect(missing).toEqual([]);
    expect(extra).toEqual([]);
  });
});
