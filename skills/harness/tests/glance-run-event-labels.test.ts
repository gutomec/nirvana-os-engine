import { describe, expect, test } from "bun:test";
import {
  CANONICAL_EVENT_TYPES, INFRA_EVENT_TYPES, chatEventLabel, runEventView, runTimeline, summarizeRunEvents,
} from "../lib/glance/views/run-event-labels.js";

// Every canonical type the engine emits today, plus `multi_target.lease_lost`
// (added by a parallel cut). The label module must cover exactly this set.
const CANONICAL_TYPES = [
  "run.prepared", "run.transitioned", "runtime.selection_snapshot",
  "gauntlet.plan_compiled", "gauntlet.candidate_created", "gauntlet.candidate_revised", "gauntlet.evaluation_recorded",
  "gauntlet.round_started", "gauntlet.round_evaluated", "gauntlet.revision_requested", "gauntlet.regression_started", "gauntlet.stopped",
  "canary.recovery_enqueued", "canary.recovery_skipped", "canary.recovery_reattached", "canary.recovery_redispatched",
  "glance.child_started", "glance.child_exited", "glance.child_killed",
  "multi_target.snapshots_bound", "multi_target.snapshot_saved",
  "multi_target.node_started", "multi_target.node_delivered", "multi_target.node_withheld", "multi_target.node_failed",
  "multi_target.node_skipped", "multi_target.node_stalled", "multi_target.support_completed", "multi_target.budget_exceeded",
  "multi_target.lease_claimed", "multi_target.lease_renewed", "multi_target.lease_released", "multi_target.lease_lost",
  "multi_target.plan_terminal",
];
const node = { nodeId: "business-a", waveIndex: 1, mode: "gauntlet", state: "delivered", outputPaths: [], reportedCostUsd: 0.25, grantedCostUsd: 2, reason: "done", blockedBy: ["brief"] };
const richPayload = {
  node, snapshot: { version: 3, state: "running", currentWave: 1, runtime: { id: "codex" }, provider: { id: "openai" }, model: { id: "m" } },
  target: { kind: "squad", slug: "s", capabilityId: "c" }, from: "running", to: "completed", round: 2, score: 0.9,
  candidateId: "can_1", revision: 2, producer: { kind: "business", slug: "b" }, artifactRefs: ["a"], verdict: "pass",
  reason: "success", decision: "delivered", reservations: ["r"], finalQualityGateRequired: true, nodeId: "n", ownerId: "w", version: 4,
  state: "delivered", planDigest: "abcdef0123456789", reservationDigest: null, plan: { intensity: "light" },
};

describe("Glance run event labels", () => {
  test("every canonical type resolves to a label with or without payload", () => {
    for (const type of CANONICAL_TYPES) {
      expect(CANONICAL_EVENT_TYPES).toContain(type);
      for (const payload of [undefined, {}, richPayload]) {
        const view = runEventView({ type, payload });
        expect(typeof view.title).toBe("string");
        expect(view.title.length).toBeGreaterThan(0);
        expect(view.title).not.toContain("undefined");
        expect(view.sub).not.toContain("undefined");
        expect(view.icon).toBeTruthy();
        expect(["", "ok", "fail", "active"]).toContain(view.tone);
      }
    }
    expect(CANONICAL_EVENT_TYPES.filter((type: string) => !CANONICAL_TYPES.includes(type))).toEqual([]);
  });

  test("canonical payloads drive titles, subtitles and tones", () => {
    expect(runEventView({ type: "run.transitioned", payload: { from: "running", to: "completed" } }))
      .toEqual({ icon: "party-popper", title: "Run concluído", sub: "running → completed", tone: "ok" });
    expect(runEventView({ type: "run.transitioned", payload: { from: "running", to: "failed" } })).toMatchObject({ title: "Run falhou", tone: "fail" });
    expect(runEventView({ type: "run.prepared", payload: { target: { kind: "business", slug: "proof" } } })).toMatchObject({ title: "Run preparado → proof", sub: "business" });
    expect(runEventView({ type: "runtime.selection_snapshot", payload: { snapshot: { runtime: { id: "codex" }, provider: { id: "openai" }, model: { id: "runtime-default" } } } }))
      .toMatchObject({ title: "Runtime: codex", sub: "openai · runtime-default" });
    expect(runEventView({ type: "gauntlet.round_started", payload: { round: 1, costReservedUsd: 1.5 } })).toMatchObject({ title: "Rodada 1 iniciada", sub: "reservado $1.50", tone: "active" });
    expect(runEventView({ type: "gauntlet.stopped", payload: { reason: "success", decision: "delivered", reservations: [], finalQualityGateRequired: true } }))
      .toMatchObject({ title: "Gauntlet parou: entregar", sub: "sucesso · gate final pendente", tone: "ok" });
    expect(runEventView({ type: "gauntlet.stopped", payload: { reason: "critical_regression", decision: "withheld" } })).toMatchObject({ title: "Gauntlet parou: reter", tone: "fail" });
    expect(runEventView({ type: "multi_target.node_delivered", payload: { node } })).toMatchObject({ title: "Nó business-a entregue", sub: "onda 2 · reportado $0.25", tone: "ok" });
    expect(runEventView({ type: "multi_target.node_skipped", payload: { node: { ...node, state: "skipped" } } }).sub).toBe("onda 2 · bloqueado por brief");
    expect(runEventView({ type: "multi_target.lease_lost", payload: { nodeId: "squad-c", ownerId: "w", version: 2 } })).toMatchObject({ title: "Lease de squad-c perdida", sub: "w · v2", tone: "fail" });
    expect(runEventView({ type: "multi_target.plan_terminal", payload: { state: "withheld", reason: "node x was withheld" } })).toMatchObject({ title: "Plano multi-target retido", sub: "node x was withheld", tone: "fail" });
  });

  test("child-process and recovery events show pid, attempt and exit", () => {
    expect(runEventView({ type: "glance.child_started", payload: { pid: 42, attempt: 1, argv: ["--agent-x"] } })).toEqual({ icon: "terminal-square", title: "Processo filho iniciado", sub: "pid 42 · tentativa 1", tone: "active" });
    expect(runEventView({ type: "glance.child_exited", payload: { pid: 42, attempt: 1, exitCode: 0 } })).toEqual({ icon: "check-circle-2", title: "Processo filho encerrou", sub: "pid 42 · tentativa 1 · saída 0", tone: "ok" });
    expect(runEventView({ type: "glance.child_exited", payload: { pid: 42, attempt: 2, exitCode: 1 } })).toMatchObject({ icon: "x-circle", sub: "pid 42 · tentativa 2 · saída 1", tone: "fail" });
    expect(runEventView({ type: "glance.child_exited", payload: { pid: 42, attempt: 1, exitCode: null } })).toMatchObject({ sub: "pid 42 · tentativa 1 · sem código de saída", tone: "" });
    expect(runEventView({ type: "glance.child_killed", payload: { pid: 42, attempt: 1, signal: "SIGTERM" } })).toEqual({ icon: "ban", title: "Processo filho interrompido", sub: "pid 42 · tentativa 1 · SIGTERM", tone: "fail" });
    expect(runEventView({ type: "canary.recovery_reattached", payload: { pid: 42, attempt: 1 } })).toEqual({ icon: "link", title: "Recuperação reanexada ao processo", sub: "pid 42 · tentativa 1", tone: "active" });
    expect(runEventView({ type: "canary.recovery_redispatched", payload: { pid: 42, attempt: 1, reason: "child_pid_dead" } })).toEqual({ icon: "refresh-cw", title: "Recuperação redespachada", sub: "pid 42 · tentativa 1 · child_pid_dead", tone: "active" });
  });

  test("legacy audit events keep resolving through the old map", () => {
    expect(runEventView({ event: "gate_passed", rubrics: ["a", "b"] })).toEqual({ icon: "shield-check", title: "Gate passou", sub: "a, b", tone: "ok" });
    expect(runEventView({ event: "agent_executed", employee: "writer", cost_usd: 1.5 })).toMatchObject({ icon: "bot", title: "writer", sub: "$1.50", tone: "ok" });
    expect(runEventView({ event: "dispatch_business", business_slug: "acme" }).title).toBe("acme assumiu");
    expect(chatEventLabel({ event: "dispatch_business" })).toBe("Despachou empresa");
    expect(chatEventLabel({ event: "custom_thing" })).toBe("custom_thing");
    // Facade-wrapped legacy events carry the legacy fields inside payload.
    expect(runEventView({ type: "delivery.gate_passed", payload: { legacyEvent: "gate_passed", rubrics: ["wiki-lint"] } })).toMatchObject({ title: "Gate passou", sub: "wiki-lint" });
    expect(runEventView({ type: "delivery.report_pdf_generated", payload: {} }).title).toBe("PDF gerado");
  });

  test("unknown or empty events never yield an undefined title", () => {
    expect(runEventView({ type: "future.thing", payload: {} })).toEqual({ icon: "circle", title: "future.thing", sub: "", tone: "" });
    expect(runEventView({ event: "x_custom" })).toEqual({ icon: "circle", title: "x_custom", sub: "", tone: "" });
    expect(runEventView({}).title).toBe("evento");
    expect(runEventView(null).title).toBe("evento");
    expect(chatEventLabel({})).toBe("evento");
  });

  test("infrastructure events are hidden by default and counted", () => {
    const events = [
      { type: "multi_target.node_started", payload: { node } }, { type: "multi_target.snapshot_saved", payload: {} },
      { type: "multi_target.lease_renewed", payload: {} }, { type: "multi_target.lease_renewed", payload: {} }, { event: "gate_passed" },
    ];
    expect([...INFRA_EVENT_TYPES]).toEqual(["multi_target.snapshot_saved", "multi_target.lease_renewed"]);
    expect(runTimeline(events)).toEqual({ visible: [events[0], events[4]], hidden: 3 });
    expect(runTimeline(events, true)).toEqual({ visible: events, hidden: 0 });
    expect(runTimeline(undefined)).toEqual({ visible: [], hidden: 0 });
  });

  test("summary reads canonical state, target, cost and decision", () => {
    const canonical = [
      { type: "run.prepared", payload: { target: { kind: "business", slug: "proof" } } },
      { type: "runtime.selection_snapshot", payload: { snapshot: { runtime: { id: "codex" }, model: { id: "runtime-default" } } } },
      { type: "gauntlet.round_started", payload: { round: 1, costReservedUsd: 1.25 } },
      { type: "gauntlet.candidate_created", payload: { candidateId: "can_1", artifactRefs: ["a", "b"] } },
      { type: "gauntlet.stopped", payload: { reason: "success", decision: "delivered", reservations: [] } },
      { type: "run.transitioned", payload: { from: "prepared", to: "running" } },
      { type: "run.transitioned", payload: { from: "running", to: "completed" } },
    ];
    expect(summarizeRunEvents(canonical)).toMatchObject({
      business: "proof", squad: null, runtime: "codex", model: "runtime-default", cost: 1.25, artifacts: 2,
      decision: "delivered", stopReason: "success", state: "completed", target: { kind: "business", slug: "proof" }, count: 7,
    });
    expect(summarizeRunEvents([{ type: "run.prepared", payload: { target: { kind: "agent-x", slug: "agent-x" } } }])).toMatchObject({ lastAgent: "agent-x", state: null });
    // Reported cost per node wins over reserved cost; each node counts its latest value once.
    const multi = [
      { type: "gauntlet.round_started", payload: { round: 1, expectedCostUsd: 9 } },
      { type: "multi_target.node_started", payload: { node: { ...node, reportedCostUsd: 0 } } },
      { type: "multi_target.node_delivered", payload: { node } },
      { type: "multi_target.node_delivered", payload: { node: { ...node, nodeId: "squad-c", reportedCostUsd: 0.5 } } },
    ];
    expect(summarizeRunEvents(multi).cost).toBeCloseTo(0.75);
    expect(summarizeRunEvents(multi.slice(0, 1)).cost).toBe(9);
  });

  test("summary keeps the legacy audit behaviour", () => {
    const legacy = [
      { event: "dispatch_business", business_slug: "acme" }, { event: "mind_clone_injected", clone: "seth" },
      { event: "agent_executed", employee: "writer", cost_usd: 0.4, runtime: "codex" }, { event: "gate_failed" }, { event: "gate_passed" },
      { event: "artifact_published" },
    ];
    expect(summarizeRunEvents(legacy)).toEqual({
      business: "acme", squad: null, mindClone: "seth", runtime: "codex", model: null, gate: "passed", artifacts: 1,
      lastAgent: "writer", agents: 1, cost: 0.4, count: 6, state: null, decision: null, stopReason: null, target: null,
    });
    expect(summarizeRunEvents(undefined)).toMatchObject({ cost: 0, count: 0 });
  });
});
