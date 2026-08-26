// standard-publication.test.ts — the standard-mode publication of one dispatch as a
// canonical Run (lib/run-kernel/standard-publication.ts): delivery result → terminal
// state, adoption of a Run prepared with --run-id, the refusal of a Run that already ended,
// idempotent keys, and the fail-open contract when the kernel is unavailable or refuses a transition.
// Runs with: bun test skills/harness/tests
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TERMINAL_RUN_STATES, createRun, getRun, listEvents, openKernel, transitionRun, type CanonicalRunState, type RunEvent } from "../lib/run-kernel/index.ts";
import {
  STANDARD_PUBLICATION_ACTOR, inertStandardPublication, openStandardPublication, policySnapshotRefFor, standardIdempotencyKey,
  terminalForDelivery, type DeliveryVerdict, type StandardPublicationInput,
} from "../lib/run-kernel/standard-publication.ts";
import { transitionsTo } from "./helpers/run-states.ts";
import { removeDir } from "./helpers/temp-dirs.ts";

const roots: string[] = [];
afterEach(() => { while (roots.length) removeDir(roots.pop()!); });

const SNAPSHOT = { runtime: { id: "claude-code", source: "default" }, provider: { selection: "runtime-provider", resolved: false },
  model: { selection: "runtime-default", resolved: false }, reason: "no provider descriptor for runtime" };
const TARGET = { kind: "squad" as const, slug: "brandcraft", capabilityId: "squad.execute" };
type AuditEntry = { event: string; payload: Record<string, any> };
const typeOf = (event: RunEvent) => event.type === "run.transitioned" ? `run.transitioned:${(event.payload as { to: string }).to}` : event.type;

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-standard-publication-")); roots.push(root);
  const kernelPath = path.join(root, ".nirvana", "run-kernel.sqlite");
  const audit: AuditEntry[] = [];
  const warnings: string[] = [];
  const open = (overrides: Partial<StandardPublicationInput> = {}) => openStandardPublication({
    kernelPath, projectId: "prj_std", runId: "run_std", traceId: "trace_std", target: TARGET, snapshot: SNAPSHOT,
    audit: (event, payload) => audit.push({ event, payload }), warn: line => warnings.push(line), ...overrides,
  });
  const read = (runId = "run_std") => {
    const handle = openKernel(kernelPath);
    try { return { run: getRun(handle, "prj_std", runId), events: listEvents(handle, "prj_std").filter(event => event.runId === runId) }; }
    finally { handle.close(); }
  };
  const glance = { kind: "control-plane", id: "glance" };
  const prepare = (runId: string, state: CanonicalRunState = "prepared") => {
    const handle = openKernel(kernelPath);
    createRun(handle, { projectId: "prj_std", runId, traceId: runId, planId: `plan_${runId}`, target: { kind: "agent-x", slug: "agent-x" },
      policySnapshotRef: "gauntlet-light-canary", actor: glance, correlationId: `cor_${runId}` });
    for (const to of transitionsTo(state)) transitionRun(handle, { projectId: "prj_std", runId, to, actor: glance, correlationId: `cor_${runId}` });
    handle.close();
  };
  return { root, kernelPath, audit, warnings, open, read, prepare };
}

describe("terminalForDelivery", () => {
  test("maps the delivery pipeline's four results to the canonical terminal states", () => {
    const cases: Array<[DeliveryVerdict, string]> = [
      [{ exitCode: 0, gateOutcome: "pass" }, "completed"],
      [{ exitCode: 0, gateOutcome: "fail-forced" }, "delivered_with_reservations"],
      [{ exitCode: 0, gateOutcome: "fail-accepted" }, "delivered_with_reservations"],
      [{ exitCode: 2, gateOutcome: "fail" }, "withheld"],
      [{ exitCode: 3, gateOutcome: "indeterminate" }, "withheld"],
      [{ exitCode: 1, gateOutcome: "indeterminate", error: "runtime returned an error verdict" }, "failed"],
    ];
    for (const [verdict, state] of cases) expect(terminalForDelivery(verdict), JSON.stringify(verdict)).toBe(state);
  });

  test("keys and snapshot references are deterministic", () => {
    expect(standardIdempotencyKey("run_x", "running")).toBe("standard:run_x:running");
    expect(policySnapshotRefFor(SNAPSHOT)).toStartWith("snapshot_");
    expect(policySnapshotRefFor(SNAPSHOT)).toBe(policySnapshotRefFor({ ...SNAPSHOT }));
    expect(policySnapshotRefFor(SNAPSHOT)).not.toBe(policySnapshotRefFor({ ...SNAPSHOT, reason: "other" }));
    const inert = inertStandardPublication("run_x", true);
    expect(inert).toMatchObject({ runId: "run_x", active: false, incompatible: true });
    expect(() => { inert.start(); inert.verify(); inert.finish({ exitCode: 0, gateOutcome: "pass" }, "/out"); }).not.toThrow();
  });
});

describe("openStandardPublication", () => {
  test("a fresh Run walks prepared → snapshot → running → verifying → terminal with standard keys", () => {
    const fx = fixture();
    const publication = fx.open();
    expect(publication).toMatchObject({ runId: "run_std", active: true, incompatible: false });
    publication.start();
    publication.verify();
    publication.finish({ exitCode: 0, gateOutcome: "pass" }, "/out/deliverables");
    const { run, events } = fx.read();
    expect(run).toMatchObject({ state: "completed", target: TARGET, traceId: "trace_std", planId: "plan_run_std", policySnapshotRef: policySnapshotRefFor(SNAPSHOT) });
    expect(events.map(typeOf)).toEqual(["run.prepared", "runtime.selection_snapshot", "run.transitioned:running", "run.transitioned:verifying", "run.transitioned:completed"]);
    expect(events.map(event => event.idempotencyKey)).toEqual(["standard:run_std:create", "standard:run_std:execution-snapshot",
      "standard:run_std:running", "standard:run_std:verifying", "standard:run_std:terminal"]);
    expect(events.every(event => event.correlationId === "cor_run_std" && event.actor.kind === STANDARD_PUBLICATION_ACTOR.kind && event.actor.id === STANDARD_PUBLICATION_ACTOR.id)).toBe(true);
    expect(events[1].payload).toEqual({ ref: policySnapshotRefFor(SNAPSHOT), snapshot: SNAPSHOT });
    expect(events.at(-1)!.payload).toEqual({ from: "verifying", to: "completed", exitCode: 0, gateOutcome: "pass", outputsRoot: "/out/deliverables" });
    expect(fx.audit).toEqual([]);
    expect(fx.warnings).toEqual([]);
  });

  test("every delivery result lands as its own terminal state, with the error on a failed Run", () => {
    const fx = fixture();
    const cases: Array<[string, DeliveryVerdict, string]> = [
      ["run_reserved", { exitCode: 0, gateOutcome: "fail-accepted" }, "delivered_with_reservations"],
      ["run_withheld", { exitCode: 2, gateOutcome: "fail" }, "withheld"],
      ["run_indeterminate", { exitCode: 3, gateOutcome: "indeterminate" }, "withheld"],
      ["run_failed", { exitCode: 1, gateOutcome: "indeterminate", error: "squad brandcraft: exit 1" }, "failed"],
    ];
    for (const [runId, verdict, state] of cases) {
      const publication = fx.open({ runId });
      publication.start(); publication.verify(); publication.finish(verdict, "/out");
      const { run, events } = fx.read(runId);
      expect(run?.state, runId).toBe(state);
      expect(events.at(-1)!.payload, runId).toMatchObject({ to: state, exitCode: verdict.exitCode, gateOutcome: verdict.gateOutcome,
        ...(verdict.error ? { error: verdict.error } : {}) });
    }
    expect((fx.read("run_withheld").events.at(-1)!.payload as { error?: string }).error).toBeUndefined();
  });

  test("adopts a Run prepared with --run-id: no second run.prepared, the prepared trace and reference are kept", () => {
    const fx = fixture();
    fx.prepare("run_glance");
    const publication = fx.open({ runId: "run_glance", traceId: "trace_dispatch" });
    expect(publication.active).toBe(true);
    publication.start(); publication.verify(); publication.finish({ exitCode: 0, gateOutcome: "pass" }, "/out");
    const { run, events } = fx.read("run_glance");
    expect(run).toMatchObject({ state: "completed", traceId: "run_glance", policySnapshotRef: "gauntlet-light-canary", target: { kind: "agent-x", slug: "agent-x" } });
    expect(events.filter(event => event.type === "run.prepared")).toHaveLength(1);
    expect(events.every(event => event.traceId === "run_glance")).toBe(true);
    expect(events.map(typeOf)).toEqual(["run.prepared", "runtime.selection_snapshot", "run.transitioned:running", "run.transitioned:verifying", "run.transitioned:completed"]);
    expect(events[1].payload).toEqual({ ref: policySnapshotRefFor(SNAPSHOT), snapshot: SNAPSHOT });
    expect(fx.audit).toEqual([]);
  });

  test("re-opening the same Run adds no duplicate events", () => {
    const fx = fixture();
    const first = fx.open();
    const second = fx.open();
    expect(fx.read().events.map(typeOf)).toEqual(["run.prepared", "runtime.selection_snapshot"]);
    // Both publications walk the lifecycle: every step carries the same idempotency key, so the
    // second adds nothing, and finish() releases the kernel handle each open() took.
    for (const publication of [first, second]) {
      publication.start(); publication.verify(); publication.finish({ exitCode: 0, gateOutcome: "pass" }, "/out");
    }
    expect(fx.read().events.map(typeOf)).toEqual(["run.prepared", "runtime.selection_snapshot",
      "run.transitioned:running", "run.transitioned:verifying", "run.transitioned:completed"]);
    expect(fx.audit).toEqual([]);
  });

  test("an unavailable kernel is fail-open: x_run_kernel_unavailable, no exception, every later call a no-op", () => {
    const fx = fixture();
    const blocker = path.join(fx.root, "blocker");
    fs.writeFileSync(blocker, "not a directory", "utf8");
    let publication!: ReturnType<typeof fx.open>;
    expect(() => { publication = fx.open({ kernelPath: path.join(blocker, "run-kernel.sqlite") }); }).not.toThrow();
    expect(publication).toMatchObject({ runId: "run_std", active: false, incompatible: false });
    expect(fx.audit).toHaveLength(1);
    expect(fx.audit[0].event).toBe("x_run_kernel_unavailable");
    expect(fx.audit[0].payload).toMatchObject({ trace_id: "trace_std", project_id: "prj_std", run_id: "run_std",
      kernel_path: path.join(blocker, "run-kernel.sqlite"), target_kind: "squad", stage: "open" });
    expect(typeof fx.audit[0].payload.error).toBe("string");
    expect(fx.warnings).toHaveLength(1);
    expect(fx.warnings[0]).toContain("the dispatch continues without the kernel");
    expect(() => { publication.start(); publication.verify(); publication.finish({ exitCode: 0, gateOutcome: "pass" }, "/out"); }).not.toThrow();
    expect(fx.audit).toHaveLength(1);
    expect(fs.existsSync(fx.kernelPath)).toBe(false);
  });

  test("a transition the kernel refuses turns the publication inert without touching the legacy flow", () => {
    const fx = fixture();
    fx.prepare("run_live", "running");
    const publication = fx.open({ runId: "run_live" });
    expect(publication).toMatchObject({ active: true, collided: false });
    expect(() => { publication.start(); publication.verify(); publication.finish({ exitCode: 0, gateOutcome: "pass" }, "/out"); }).not.toThrow();
    expect(fx.audit.map(entry => entry.event)).toEqual(["x_run_kernel_unavailable"]);
    expect(fx.audit[0].payload).toMatchObject({ run_id: "run_live", stage: "running" });
    expect(fx.audit[0].payload.error).toContain("illegal transition running -> running");
    expect(fx.read("run_live").run?.state).toBe("running");
  });

  test("a Run that already ended under the same id is refused before any producer: x_run_id_collision, collided, nothing appended", () => {
    const fx = fixture();
    const states = [...TERMINAL_RUN_STATES];
    expect(states.sort()).toEqual(["abandoned", "cancelled", "completed", "delivered_with_reservations", "failed", "rolled_back", "withheld"]);
    for (const state of states) {
      const runId = `run_${state}`;
      fx.prepare(runId, state);
      const before = fx.read(runId).events.length;
      const publication = fx.open({ runId });
      expect(publication, state).toMatchObject({ runId, active: false, incompatible: false, collided: true });
      expect(() => { publication.start(); publication.verify(); publication.finish({ exitCode: 0, gateOutcome: "pass" }, "/out"); }).not.toThrow();
      expect(fx.read(runId).run?.state, state).toBe(state);
      expect(fx.read(runId).events, state).toHaveLength(before);
      expect(fx.warnings.at(-1), state).toBe(`[run-kernel] run '${runId}' is already terminal (${state}); pass a fresh --run-id`);
    }
    expect(fx.audit.map(entry => entry.event)).toEqual(states.map(() => "x_run_id_collision"));
    expect(fx.audit[0].payload).toEqual({ trace_id: "trace_std", project_id: "prj_std", run_id: "run_abandoned", state: "abandoned",
      kernel_path: fx.kernelPath, target_kind: "squad", run_target: { kind: "agent-x", slug: "agent-x" }, mode: "standard" });
    expect(fx.audit.some(entry => entry.event === "x_run_kernel_unavailable")).toBe(false);
  });

  test("broker errors in the frozen snapshot end the Run rolled_back before any producer (RT-002)", () => {
    const fx = fixture();
    const errors = ["REQUIRED feature 'sandbox' requires native, but 'claude-code' provides unavailable."];
    const publication = fx.open({ snapshot: { ...SNAPSHOT, errors } });
    expect(publication).toMatchObject({ active: false, incompatible: true });
    const { run, events } = fx.read();
    expect(run?.state).toBe("rolled_back");
    expect(events.map(typeOf)).toEqual(["run.prepared", "runtime.selection_snapshot", "run.transitioned:rolled_back"]);
    expect(events.at(-1)!.idempotencyKey).toBe("standard:run_std:rolled-back-runtime-incompatible");
    expect(events.at(-1)!.payload).toEqual({ from: "prepared", to: "rolled_back", reason: "runtime_incompatible", errors });
    expect((events[1].payload as { snapshot: { errors: string[] } }).snapshot.errors).toEqual(errors);
    publication.start();
    expect(fx.read().events).toHaveLength(3);
    expect(fx.audit).toEqual([]);
  });
});
