import { describe, expect, test } from "bun:test";
import { buildTrajectoryRows } from "../lib/glance/views/trajectory-card.js";

describe("Trajectory Card row builder", () => {
  test("groups judge_invoked..revision_* under one collapsible row, closed by the terminal gate event", () => {
    const events = [
      { event: "brief_received" },
      { event: "judge_invoked", rubric_name: "prose-structure", pass_threshold: 0.8 },
      { event: "critique_generated", verdict: "fail", total_score: 0.55, critique_count: 3, schema_valid: true },
      { event: "revision_dispatched", attempt_index: 1, previous_score: 0.55, priority_items: 3 },
      { event: "gate_passed", rubrics: ["prose-structure"] },
      { event: "delivered", files: 2, gate: "pass" },
    ];
    const { rows, hidden } = buildTrajectoryRows(events);
    expect(hidden).toBe(0);
    expect(rows.map((r: any) => r.kind)).toEqual(["event", "judgement", "event"]);
    const group = rows[1] as any;
    expect(group.items).toHaveLength(3);
    expect(group.items.map((i: any) => i.view.title)).toEqual([
      "Julgando: prose-structure", "Veredito: reprovado", "Revisão despachada · tentativa 1",
    ]);
    expect(group.terminal.view.title).toBe("Gate passou");
    // The group's own _seq is its first atom's (judge_invoked), not the group's array position.
    expect(group._seq).toBe(events.findIndex((e) => e.event === "judge_invoked"));
    // Delivered gets the ok nuance (a plain pass, not a reservations gate).
    const delivered = rows[2] as any;
    expect(delivered.nuance).toEqual({ variant: "ok", label: "Entregue", detail: { gate: "pass", files: 2 } });
  });

  test("a gate_passed with no preceding judgement atoms stays a plain row (heuristic-mode gate)", () => {
    const events = [{ event: "gate_passed", rubrics: ["a"] }];
    const { rows } = buildTrajectoryRows(events);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("event");
  });

  test("delivery nuance: withheld and reservations carry the WHY, distinct from a clean pass", () => {
    const withheld = buildTrajectoryRows([
      { event: "x_delivery_withheld", gate: "fail", ceiling: "completeness", ceiling_reason: "manifest not verified", gated_files: 3, revisions: 2 },
    ]).rows[0] as any;
    expect(withheld.nuance.variant).toBe("fail-reversible");
    expect(withheld.nuance.label).toBe("Retido");
    expect(withheld.nuance.detail).toMatchObject({ ceiling_reason: "manifest not verified", gated_files: 3 });

    const reservations = buildTrajectoryRows([
      { event: "x_delivered_with_reservations", gated_files: 1, revisions: 2, ceiling: 2 },
    ]).rows[0] as any;
    expect(reservations.nuance.variant).toBe("warn-detail");
    expect(reservations.nuance.label).toBe("Com ressalvas");

    // `delivered` right after fail-accepted reservations reads as reservations
    // too, not a second, contradicting "clean pass".
    const deliveredAfterReservations = buildTrajectoryRows([
      { event: "delivered", gate: "fail-accepted", files: 2 },
    ]).rows[0] as any;
    expect(deliveredAfterReservations.nuance).toEqual({ variant: "warn-detail", label: "Com ressalvas", detail: { gate: "fail-accepted", files: 2 } });
  });

  test("runtime-health events carry the hint inline, no extra click needed", () => {
    const { rows } = buildTrajectoryRows([
      { event: "runtime_auth_failed", runtime: "codex", hint: "token expired" },
    ]);
    expect((rows[0] as any).runtimeChip).toEqual({ runtime: "codex", hint: "token expired" });
  });

  test("stable identity survives the infra toggle: a row's _seq never comes from its position in the FILTERED list", () => {
    const events = [
      { type: "multi_target.lease_renewed", payload: {} },      // infra, hidden by default
      { event: "brief_received" },                               // _seq must be 1, not 0
      { type: "multi_target.lease_renewed", payload: {} },
      { event: "delivered", gate: "pass" },                      // _seq must be 3, not 1
    ];
    const hiddenByDefault = buildTrajectoryRows(events);
    expect(hiddenByDefault.hidden).toBe(2);
    expect(hiddenByDefault.rows.map((r: any) => r._seq)).toEqual([1, 3]);
    // Re-run with infra events shown: the two events that were already
    // visible keep the EXACT same _seq as before.
    const withInfra = buildTrajectoryRows(events, { showInfra: true });
    expect(withInfra.rows.map((r: any) => r._seq)).toEqual([0, 1, 2, 3]);
    expect(withInfra.rows[1]._seq).toBe(hiddenByDefault.rows[0]._seq);
    expect(withInfra.rows[3]._seq).toBe(hiddenByDefault.rows[1]._seq);
  });
});
