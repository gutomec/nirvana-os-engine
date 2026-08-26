import type { CanonicalRunState, RunEvent, RunProjection } from "./types.ts";
import { createRun, publishOutbox, transitionRun, type CreateRunInput, type KernelHandle, type TransitionInput } from "./store.ts";
import { createRequire } from "node:module";
import {
  canTransition as canLegacyTransition,
  getRun as getLegacyRun,
  markState as markLegacyState,
  openRun as openLegacyRun,
  type LedgerHandle,
} from "../run-ledger.ts";

export type LegacyRunState = "dispatched" | "running" | "verifying" | "gated" | "delivered" | "withheld" | "failed" | "abandoned";

export interface LegacyCompatibilityAdapter {
  openRun?(run: RunProjection): void;
  /** `payload` is the canonical transition's payload; a legacy `failed` row takes its error from it. */
  transitionRun?(run: RunProjection, legacyState: LegacyRunState, payload?: Record<string, unknown>): void;
  emitAudit?(event: RunEvent): void;
}

export interface HarnessLegacyAdapterOptions {
  ledger: LedgerHandle;
  auditCwd?: string;
}

export function createHarnessLegacyAdapter(options: HarnessLegacyAdapterOptions): LegacyCompatibilityAdapter {
  const audit = createRequire(import.meta.url)("../audit.js") as {
    emit(event: string, payload: Record<string, unknown>, context?: Record<string, unknown>): unknown;
  };
  const emitProjection = (operation: string, run: RunProjection, legacyState: LegacyRunState): void => {
    audit.emit("x_run_kernel_projection", {
      operation, run_id: run.runId, state: run.state, legacy_state: legacyState,
      sequence: run.lastSequence, target_kind: run.target.kind, target_slug: run.target.slug,
    }, { trace_id: run.traceId, project_id: run.projectId, cwd: options.auditCwd });
  };
  return {
    emitAudit(event) {
      audit.emit("x_run_kernel_projection", {
        operation: "event", event_id: event.eventId, run_id: event.runId, sequence: event.sequence,
        canonical_event: event.type, payload: event.payload,
      }, { trace_id: event.traceId, project_id: event.projectId, cwd: options.auditCwd });
    },
    openRun(run) {
      const targetSlug = run.target.slug;
      const existing = getLegacyRun(options.ledger, run.runId);
      if (!existing) {
        openLegacyRun(options.ledger, {
          runId: run.runId, traceId: run.traceId, projectId: run.projectId,
          targetKind: run.target.kind, targetSlug,
          meta: { canonical_plan_id: run.planId, canonical_policy_snapshot_ref: run.policySnapshotRef },
        });
      }
      emitProjection("open", run, "dispatched");
    },
    transitionRun(run, legacyState, payload) {
      const legacy = getLegacyRun(options.ledger, run.runId);
      if (!legacy) throw new Error(`run-kernel compatibility: legacy run '${run.runId}' is missing`);
      if (legacy.state !== legacyState && canLegacyTransition(legacy.state, legacyState)) {
        markLegacyState(options.ledger, run.runId, legacyState, {
          metaPatch: { canonical_state: run.state, canonical_version: run.version },
          // `failed` is the legacy row of every canonical failure (failed, rolled_back, cancelled);
          // its last_error says which one and why, for a reader of the ledger alone.
          ...(legacyState === "failed" ? { error: legacyErrorFor(run.state, payload) } : {}),
        });
      }
      emitProjection("transition", run, legacyState);
    },
  };
}

/** `last_error` of a legacy `failed` row: the transition's `error`, else its `reason` with the
 * `errors` it lists, else the canonical state itself (`rolled_back`, `cancelled`, `failed`). */
export function legacyErrorFor(state: CanonicalRunState, payload?: Record<string, unknown>): string {
  if (typeof payload?.error === "string" && payload.error) return payload.error;
  const reason = typeof payload?.reason === "string" && payload.reason ? payload.reason : state;
  const errors = Array.isArray(payload?.errors) ? payload.errors.filter((item): item is string => typeof item === "string") : [];
  return errors.length ? `${reason}: ${errors.join(" ")}` : reason;
}

export function legacyStateFor(state: CanonicalRunState): LegacyRunState {
  switch (state) {
    case "prepared": return "dispatched";
    case "running": case "waiting": case "revising": case "cancelling": return "running";
    case "verifying": return "verifying";
    case "completed": case "delivered_with_reservations": return "delivered";
    case "withheld": return "withheld";
    case "abandoned": return "abandoned";
    case "rolled_back": case "cancelled": case "failed": return "failed";
  }
}

export class RunKernelCompatibilityFacade {
  constructor(private readonly kernel: KernelHandle, private readonly legacy: LegacyCompatibilityAdapter = {}) {}

  create(input: CreateRunInput): RunProjection {
    const run = createRun(this.kernel, input);
    this.legacy.openRun?.(run);
    return run;
  }

  transition(input: TransitionInput): RunProjection {
    const run = transitionRun(this.kernel, input);
    this.legacy.transitionRun?.(run, legacyStateFor(run.state), input.payload);
    return run;
  }

  publishPending(limit = 100): Promise<number> {
    return publishOutbox(this.kernel, event => this.legacy.emitAudit?.(event), limit);
  }
}
