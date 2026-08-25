import type { CanonicalRunState, RunEvent, RunProjection } from "./types.ts";
import { createRun, transitionRun, type CreateRunInput, type KernelHandle, type TransitionInput } from "./store.ts";
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
  transitionRun?(run: RunProjection, legacyState: LegacyRunState): void;
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
    transitionRun(run, legacyState) {
      const legacy = getLegacyRun(options.ledger, run.runId);
      if (!legacy) throw new Error(`run-kernel compatibility: legacy run '${run.runId}' is missing`);
      if (legacy.state !== legacyState && canLegacyTransition(legacy.state, legacyState)) {
        markLegacyState(options.ledger, run.runId, legacyState, { metaPatch: { canonical_state: run.state, canonical_version: run.version } });
      }
      emitProjection("transition", run, legacyState);
    },
  };
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
    this.legacy.transitionRun?.(run, legacyStateFor(run.state));
    return run;
  }
}
