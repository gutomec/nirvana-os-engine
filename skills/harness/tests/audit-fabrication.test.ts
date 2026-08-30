// audit-fabrication.test.ts — the fabrication detector must not flag the
// harness protocol's own dispatch chain.
//
// The owner opened Glance on 2026-08-30 and saw 6 of 8 runs marked
// "suspicious", including runs he had just watched dispatch and gate
// correctly. Traced to two miscalibrations in detectFabrication():
//
//   1. Heuristic 1 (unknown event names) didn't know about the "x_" open
//      namespace SKILL.md itself sanctions (Rule 2: "Event names outside the
//      closed enum belong to the open x_ namespace") — so run-ledger.ts's own
//      x_ledger_run_opened / x_ledger_state_changed scored +3 as fabrication
//      evidence on every single dispatch that uses the ledger.
//   2. Heuristics 3 and 5 assume every legitimate event carries a `host` from
//      a coding-session hook. brief_received, dispatch_business,
//      dispatch_squad, gate_passed and delivered are emitted directly by CLI
//      scripts (nrv audit emit / brief-business.ts) — never through a hook —
//      so a run built entirely of those, however complete and honest, scored
//      +2 (null host streak) +2 (no hook host) before heuristic 1 even ran.
//
// Net effect: a fully-audited business dispatch (brief_received →
// dispatch_business → x_ledger_* → gate_passed → delivered) scored >= 4,
// clearing the suspicious threshold (3) on legitimacy alone. What this file
// pins: that exact shape must score 0, while genuine fabrication (unknown
// event names outside x_, or hook-shaped activity claiming a host it never
// had) still gets caught.
import { describe, expect, test } from "bun:test";
import { detectFabrication } from "../../_shared/lib/audit-fabrication.ts";

const TRACE = "fixture-trace";
const at = (n: number) => `2026-08-30T10:${String(n).padStart(2, "0")}:00.000Z`;

describe("a complete, legitimate business dispatch is never flagged", () => {
  const events = [
    { ts: at(0), event: "brief_received", trace_id: TRACE, project_id: TRACE, business_slug: "systems-atelier" },
    { ts: at(1), event: "dispatch_business", trace_id: TRACE, business_slug: "systems-atelier" },
    { ts: at(2), event: "x_ledger_run_opened", trace_id: TRACE },
    { ts: at(3), event: "x_ledger_state_changed", trace_id: TRACE, state: "running" },
    { ts: at(4), event: "gate_passed", trace_id: TRACE, rubric: "code", score: 0.9 },
    { ts: at(5), event: "delivered", trace_id: TRACE, artifact_path: "/tmp/out.md" },
  ];

  test("scores 0 — none of the harness's own non-hook events count against it", () => {
    const verdict = detectFabrication(events);
    expect(verdict.evidence).toEqual([]);
    expect(verdict.score).toBe(0);
  });

  test("is not suspicious", () => {
    expect(detectFabrication(events).suspicious).toBe(false);
  });
});

describe("a complete, legitimate agent-x dispatch is never flagged", () => {
  const events = [
    { ts: at(0), event: "brief_received", trace_id: TRACE, project_id: TRACE, target: "agent-x" },
    { ts: at(1), event: "x_no_match", trace_id: TRACE },
    { ts: at(2), event: "target_plan_committed", trace_id: TRACE },
    { ts: at(3), event: "dispatch_agent_x", trace_id: TRACE },
    { ts: at(4), event: "x_ledger_run_opened", trace_id: TRACE },
    { ts: at(5), event: "gate_passed", trace_id: TRACE, rubric: "code", score: 0.9 },
  ];

  test("scores 0 — dispatch_agent_x is a canonical event, not an unknown one", () => {
    expect(detectFabrication(events).evidence).toEqual([]);
  });
});

describe("a genuine hook-driven coding session is never flagged", () => {
  const events = Array.from({ length: 10 }, (_, i) => ({
    ts: at(i), event: i % 2 === 0 ? "tool_invoked" : "bash_completed", trace_id: TRACE, host: "claude-code-hook",
  }));

  test("real hook attribution keeps the score at 0", () => {
    expect(detectFabrication(events).suspicious).toBe(false);
  });
});

describe("genuine fabrication is still caught", () => {
  test("an event name outside both ALLOWED_EVENTS and the x_ namespace scores +3", () => {
    const verdict = detectFabrication([
      { ts: at(0), event: "real_mining_completed", trace_id: TRACE },
      { ts: at(1), event: "brief_received", trace_id: TRACE },
    ]);
    expect(verdict.score).toBeGreaterThanOrEqual(3);
    expect(verdict.suspicious).toBe(true);
  });

  test("hook-shaped activity (tool_invoked/bash_completed) with no host, 4+, still trips heuristic 5", () => {
    const events = Array.from({ length: 5 }, (_, i) => ({
      ts: at(i), event: "tool_invoked", trace_id: TRACE, host: null,
    }));
    const verdict = detectFabrication(events);
    expect(verdict.score).toBeGreaterThanOrEqual(2);
    expect(verdict.evidence.some(e => e.includes("verified hook source"))).toBe(true);
  });

  test("delivered with zero tool evidence still scores", () => {
    const verdict = detectFabrication([
      { ts: at(0), event: "brief_received", trace_id: TRACE },
      { ts: at(1), event: "delivered", trace_id: TRACE },
    ]);
    expect(verdict.evidence.some(e => e.includes("no proof of work"))).toBe(true);
  });
});
