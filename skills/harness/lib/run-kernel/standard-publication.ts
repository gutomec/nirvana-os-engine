// standard-publication.ts — publishes one standard-mode dispatch as a canonical Run.
//
// The three standard branches of scripts/dispatch.ts (business, squad-only and
// agent-x) keep running the legacy executor and the delivery pipeline exactly as
// before; this module mirrors the milestones of that run into the project's Run
// Kernel: `run.prepared` (or the adoption of a Run a control plane prepared with
// --run-id), `runtime.selection_snapshot`, `prepared → running` before the
// executor, `running → verifying` before the delivery pipeline and the terminal
// state derived from the delivery result (the same mapping the Gauntlet cutover
// uses). It writes to the kernel directly: dispatch already opens the run ledger,
// so RunKernelCompatibilityFacade with the legacy adapter would create a second
// ledger row without a heartbeat.
//
// Fail-open by design. A kernel that cannot be opened or written (disk,
// permissions, an adopted Run whose state refuses the transition) never changes
// the legacy behaviour: the failure is recorded as `x_run_kernel_unavailable` in
// the audit, the publication becomes inert and the dispatch continues with its
// usual exit codes, artifacts, audit and session files.
import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical-json.ts";
import { appendEvent, createRun, getRun, openKernel, transitionRun, type KernelHandle } from "./store.ts";
import type { CanonicalRunState, TargetRef } from "./types.ts";
import { terminalForGate } from "../gauntlet/agent-x-cutover.ts";

export const STANDARD_PUBLICATION_ACTOR = { kind: "kernel", id: "standard-dispatch" } as const;

export interface DeliveryVerdict {
  exitCode: 0 | 1 | 2 | 3;
  gateOutcome: string;
  /** Runtime or pipeline error, recorded in the terminal payload when present. */
  error?: string | null;
}

export interface StandardPublicationInput {
  kernelPath: string;
  projectId: string;
  runId: string;
  traceId: string;
  target: TargetRef;
  /** Frozen execution snapshot (lib/runtime-snapshot.ts); its digest is the Run's policySnapshotRef. */
  snapshot: Record<string, unknown>;
  audit: (event: string, payload: Record<string, any>) => void;
  warn?: (line: string) => void;
}

export interface StandardPublication {
  readonly runId: string;
  /** False when the kernel is unavailable or the Run already ended: every method is then a no-op. */
  readonly active: boolean;
  /** True when the frozen snapshot carries broker errors: the Run ended `rolled_back` before any producer. */
  readonly incompatible: boolean;
  /** `prepared → running`, before the executor. */
  start(): void;
  /** `running → verifying`, before the delivery pipeline. */
  verify(): void;
  /** Terminal transition from the delivery result; closes the kernel. */
  finish(verdict: DeliveryVerdict, outputsRoot: string): void;
}

/** Digest of the frozen snapshot, the same reference the Gauntlet cutover records. */
export function policySnapshotRefFor(snapshot: Record<string, unknown>): string {
  return `snapshot_${createHash("sha256").update(canonicalJson(snapshot)).digest("hex").slice(0, 24)}`;
}

/** Idempotency key of one standard-mode step: `standard:<runId>:<step>`. */
export function standardIdempotencyKey(runId: string, step: string): string {
  return `standard:${runId}:${step}`;
}

/** Terminal state of a standard Run: exit 0 with a passing gate is `completed`, exit 0 delivered
 * with `fail-forced` or `fail-accepted` is `delivered_with_reservations`, exit 2 or 3 is
 * `withheld` and exit 1 (or an error before anything was judged) is `failed`. */
export function terminalForDelivery(verdict: DeliveryVerdict): CanonicalRunState {
  return terminalForGate({ exitCode: verdict.exitCode, gateOutcome: verdict.gateOutcome });
}

/** A publication that records nothing; used when the kernel is unavailable or the caller opted out. */
export function inertStandardPublication(runId: string, incompatible = false): StandardPublication {
  return { runId, active: false, incompatible, start() {}, verify() {}, finish() {} };
}

export function openStandardPublication(input: StandardPublicationInput): StandardPublication {
  const warn = input.warn ?? ((line: string) => console.error(line));
  // Local alias named `emit` so check-audit-parity's literal scan sees the event.
  const emit = input.audit;
  const { projectId, runId, target } = input;
  const correlationId = `cor_${runId}`;
  const key = (step: string) => standardIdempotencyKey(runId, step);
  let kernel: KernelHandle | null = null;
  const closeKernel = () => { try { kernel?.close(); } catch { /* already closed */ } kernel = null; };
  const unavailable = (stage: string, error: unknown): void => {
    const message = String((error as Error)?.message ?? error);
    warn(`[run-kernel] standard publication unavailable at ${stage}: ${message} (the dispatch continues without the kernel)`);
    emit("x_run_kernel_unavailable", { trace_id: input.traceId, project_id: projectId, run_id: runId,
      kernel_path: input.kernelPath, target_kind: target.kind, stage, error: message });
    closeKernel();
  };

  let traceId = input.traceId;
  try {
    kernel = openKernel(input.kernelPath);
    const policySnapshotRef = policySnapshotRefFor(input.snapshot);
    // An adopted Run (prepared by Glance with --run-id) keeps the trace it was prepared with, so
    // every event of one Run shares one trace; a fresh Run uses the dispatch's.
    const run = getRun(kernel, projectId, runId) ?? createRun(kernel, { projectId, runId, traceId, planId: `plan_${runId}`, target,
      policySnapshotRef, actor: STANDARD_PUBLICATION_ACTOR, correlationId, idempotencyKey: key("create") });
    traceId = run.traceId;
    appendEvent(kernel, { projectId, runId, traceId, type: "runtime.selection_snapshot", actor: STANDARD_PUBLICATION_ACTOR, correlationId,
      idempotencyKey: key("execution-snapshot"), payload: { ref: policySnapshotRef, snapshot: input.snapshot } });
    // RT-002: broker errors end the Run here, before any producer, exactly as the canaries do.
    const errors = Array.isArray(input.snapshot.errors) ? input.snapshot.errors as string[] : [];
    if (errors.length) {
      transitionRun(kernel, { projectId, runId, to: "rolled_back", actor: STANDARD_PUBLICATION_ACTOR, correlationId,
        idempotencyKey: key("rolled-back-runtime-incompatible"), payload: { reason: "runtime_incompatible", errors } });
      closeKernel();
      return inertStandardPublication(runId, true);
    }
  } catch (error) {
    unavailable("open", error);
    return inertStandardPublication(runId);
  }

  const transition = (to: CanonicalRunState, step: string, payload?: Record<string, unknown>): void => {
    if (!kernel) return;
    try {
      transitionRun(kernel, { projectId, runId, to, actor: STANDARD_PUBLICATION_ACTOR, correlationId, idempotencyKey: key(step),
        ...(payload ? { payload } : {}) });
    } catch (error) { unavailable(step, error); }
  };
  return {
    runId, active: true, incompatible: false,
    start() { transition("running", "running"); },
    verify() { transition("verifying", "verifying"); },
    finish(verdict, outputsRoot) {
      transition(terminalForDelivery(verdict), "terminal", { exitCode: verdict.exitCode, gateOutcome: verdict.gateOutcome, outputsRoot,
        ...(verdict.error ? { error: verdict.error } : {}) });
      closeKernel();
    },
  };
}
