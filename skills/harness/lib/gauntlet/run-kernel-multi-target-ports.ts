import { canonicalJson } from "../run-kernel/canonical-json.ts";
import { appendEvent, getRun, type KernelHandle } from "../run-kernel/store.ts";
import type { RunEvent } from "../run-kernel/types.ts";
import type {
  MultiTargetAdapterResult,
  MultiTargetCoordinatorPorts,
  MultiTargetCoordinatorSnapshot,
} from "./multi-target-coordinator.ts";
import { projectMultiTargetRun } from "./multi-target-projection.ts";

interface LeaseRow {
  owner_id: string;
  expires_at: number;
  version: number;
}

export interface RunKernelMultiTargetPorts extends MultiTargetCoordinatorPorts {
  state: NonNullable<MultiTargetCoordinatorPorts["state"]>;
  journal: NonNullable<MultiTargetCoordinatorPorts["journal"]>;
  lease: NonNullable<MultiTargetCoordinatorPorts["lease"]> & {
    claim(nodeId: string): boolean;
    renew(nodeId: string): boolean;
    release(nodeId: string): boolean;
  };
}

function initializeLeaseStore(handle: KernelHandle): void {
  handle.db.exec(`CREATE TABLE IF NOT EXISTS kernel_multi_target_leases (
    project_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    version INTEGER NOT NULL,
    PRIMARY KEY(project_id, run_id, node_id)
  );
  CREATE INDEX IF NOT EXISTS idx_kernel_multi_target_leases_expiry
    ON kernel_multi_target_leases(project_id, expires_at);`);
}

function eventByKey(handle: KernelHandle, projectId: string, key: string): RunEvent | null {
  const row = handle.db.query("SELECT event_json FROM run_events WHERE project_id = ? AND idempotency_key = ?")
    .get(projectId, key) as { event_json: string } | null;
  return row ? JSON.parse(row.event_json) as RunEvent : null;
}

function latestRunEvent(handle: KernelHandle, projectId: string, runId: string): RunEvent | null {
  const row = handle.db.query("SELECT event_json FROM run_events WHERE project_id = ? AND run_id = ? ORDER BY sequence DESC LIMIT 1")
    .get(projectId, runId) as { event_json: string } | null;
  return row ? JSON.parse(row.event_json) as RunEvent : null;
}

export function createRunKernelMultiTargetPorts(input: {
  kernel: KernelHandle;
  projectId: string;
  runId: string;
  ownerId: string;
  actor: { kind: string; id: string };
  correlationId: string;
  leaseDurationMs?: number;
  /** Lease renewal period while an adapter is pending; defaults to a third of the lease. */
  heartbeatMs?: number;
  /** Timer seam (default setInterval/clearInterval) so tests can drive heartbeats without real time. */
  schedule?: (fn: () => void, ms: number) => () => void;
  now?: () => number;
  standard: MultiTargetCoordinatorPorts["standard"];
  gauntlet: MultiTargetCoordinatorPorts["gauntlet"];
}): RunKernelMultiTargetPorts {
  const run = getRun(input.kernel, input.projectId, input.runId);
  if (!run) throw new Error(`multi-target kernel ports: run '${input.runId}' not found in project '${input.projectId}'`);
  if (!input.ownerId.trim()) throw new Error("multi-target kernel ports: ownerId is required");
  const leaseDurationMs = input.leaseDurationMs ?? 30_000;
  if (!Number.isFinite(leaseDurationMs) || leaseDurationMs <= 0) throw new Error("multi-target kernel ports: leaseDurationMs must be positive");
  const heartbeatMs = input.heartbeatMs ?? Math.floor(leaseDurationMs / 3);
  if (!Number.isFinite(heartbeatMs) || heartbeatMs <= 0 || heartbeatMs >= leaseDurationMs) {
    throw new Error("multi-target kernel ports: heartbeatMs must be positive and below leaseDurationMs");
  }
  const schedule = input.schedule ?? ((fn, ms) => { const timer = setInterval(fn, ms); return () => clearInterval(timer); });
  const now = input.now ?? Date.now;
  initializeLeaseStore(input.kernel);

  let last = latestRunEvent(input.kernel, input.projectId, input.runId);
  const appendCausal = (type: string, key: string, payload: Record<string, unknown>): RunEvent => {
    const existing = eventByKey(input.kernel, input.projectId, key);
    if (existing) {
      if (existing.runId !== input.runId || existing.type !== type || canonicalJson(existing.payload) !== canonicalJson(payload)) {
        throw new Error(`multi-target kernel ports: event identity conflict for '${key}'`);
      }
      if (!last || existing.sequence > last.sequence) last = existing;
      return existing;
    }
    const event = appendEvent(input.kernel, {
      projectId: input.projectId,
      runId: input.runId,
      traceId: run.traceId,
      type,
      actor: input.actor,
      correlationId: input.correlationId,
      ...(last ? { causationId: last.eventId } : {}),
      idempotencyKey: key,
      payload,
    });
    last = event;
    return event;
  };

  const leaseKey = (operation: string, nodeId: string, version: number) =>
    `multi-target:${input.runId}:lease:${operation}:${nodeId}:${input.ownerId}:${version}`;
  const readLease = (nodeId: string): LeaseRow | null => input.kernel.db.query(
    "SELECT owner_id, expires_at, version FROM kernel_multi_target_leases WHERE project_id = ? AND run_id = ? AND node_id = ?"
  ).get(input.projectId, input.runId, nodeId) as LeaseRow | null;

  const claim = (nodeId: string): boolean => {
    const result = input.kernel.db.transaction(() => {
      const current = readLease(nodeId);
      const at = now();
      if (current && current.expires_at > at) return { acquired: current.owner_id === input.ownerId, changed: false, row: current };
      const version = (current?.version ?? 0) + 1;
      const expiresAt = at + leaseDurationMs;
      input.kernel.db.run(`INSERT INTO kernel_multi_target_leases(project_id, run_id, node_id, owner_id, expires_at, version)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id, run_id, node_id) DO UPDATE SET owner_id = excluded.owner_id, expires_at = excluded.expires_at, version = excluded.version`,
      [input.projectId, input.runId, nodeId, input.ownerId, expiresAt, version]);
      return { acquired: true, changed: true, row: { owner_id: input.ownerId, expires_at: expiresAt, version } };
    })();
    if (result.acquired && result.changed) appendCausal("multi_target.lease_claimed", leaseKey("claim", nodeId, result.row.version), {
      nodeId, ownerId: input.ownerId, expiresAt: result.row.expires_at, version: result.row.version,
    });
    return result.acquired;
  };

  const renew = (nodeId: string): boolean => {
    const result = input.kernel.db.transaction(() => {
      const current = readLease(nodeId);
      const at = now();
      if (!current || current.owner_id !== input.ownerId || current.expires_at <= at) return null;
      const version = current.version + 1;
      const expiresAt = at + leaseDurationMs;
      const update = input.kernel.db.run(`UPDATE kernel_multi_target_leases SET expires_at = ?, version = ?
        WHERE project_id = ? AND run_id = ? AND node_id = ? AND owner_id = ? AND version = ?`,
      [expiresAt, version, input.projectId, input.runId, nodeId, input.ownerId, current.version]);
      return update.changes === 1 ? { expiresAt, version } : null;
    })();
    if (!result) return false;
    appendCausal("multi_target.lease_renewed", leaseKey("renew", nodeId, result.version), {
      nodeId, ownerId: input.ownerId, expiresAt: result.expiresAt, version: result.version,
    });
    return true;
  };

  const release = (nodeId: string): boolean => {
    const current = readLease(nodeId);
    if (!current || current.owner_id !== input.ownerId) return false;
    const result = input.kernel.db.run(`DELETE FROM kernel_multi_target_leases
      WHERE project_id = ? AND run_id = ? AND node_id = ? AND owner_id = ? AND version = ?`,
    [input.projectId, input.runId, nodeId, input.ownerId, current.version]);
    if (result.changes !== 1) return false;
    appendCausal("multi_target.lease_released", leaseKey("release", nodeId, current.version), {
      nodeId, ownerId: input.ownerId, version: current.version,
    });
    return true;
  };

  const leaseValid = (nodeId: string): boolean => {
    const current = readLease(nodeId);
    return !!current && current.owner_id === input.ownerId && current.expires_at > now();
  };

  const recordLeaseLost = (nodeId: string, reason: string): void => {
    const observed = readLease(nodeId);
    appendCausal("multi_target.lease_lost", leaseKey("lost", nodeId, observed?.version ?? 0), {
      nodeId, ownerId: input.ownerId, reason, observedOwnerId: observed?.owner_id ?? null, observedVersion: observed?.version ?? null,
    });
  };

  // While an adapter is pending the lease is renewed every heartbeat. A failed
  // renewal (expired, owner changed, released elsewhere) aborts the adapter and
  // fails closed: its result is never surfaced as delivered without a live lease.
  const guarded = (adapter: MultiTargetCoordinatorPorts["standard"]): MultiTargetCoordinatorPorts["standard"] => ({
    async run(adapterInput) {
      const controller = new AbortController();
      let lost: string | null = null;
      let stopped = false;
      const markLost = (reason: string) => {
        if (lost) return;
        lost = reason;
        recordLeaseLost(adapterInput.nodeId, reason);
        controller.abort("lease_lost");
      };
      const stop = schedule(() => {
        if (stopped || lost) return;
        if (!renew(adapterInput.nodeId)) markLost("lease renewal failed while the adapter was running");
      }, heartbeatMs);
      let result: MultiTargetAdapterResult | null = null;
      try {
        result = await adapter.run({ ...adapterInput, signal: controller.signal });
      } catch (error) {
        if (!lost) throw error;
      } finally {
        stopped = true;
        stop();
      }
      if (!lost && !leaseValid(adapterInput.nodeId)) markLost("lease was not valid when the adapter finished");
      if (!lost) return result!;
      const spent = result && Number.isFinite(result.reportedCostUsd) && result.reportedCostUsd > 0 ? result.reportedCostUsd : 0;
      return { state: "failed", reportedCostUsd: spent, reason: `lease_lost: ${lost}` };
    },
  });

  return {
    standard: guarded(input.standard),
    gauntlet: guarded(input.gauntlet),
    state: {
      // The same replay Glance reads: last snapshot plus every later
      // multi_target.* event, from the one source in multi-target-projection.ts.
      load(): MultiTargetCoordinatorSnapshot | null {
        return projectMultiTargetRun(input.kernel, input.projectId, input.runId);
      },
      save(snapshot): void {
        appendCausal("multi_target.snapshot_saved", `multi-target:${input.runId}:snapshot:${snapshot.version}`, { snapshot });
      },
    },
    journal: {
      persistSnapshots(snapshot): void {
        appendCausal("multi_target.snapshots_bound", `multi-target:${input.runId}:snapshots`, snapshot);
      },
      emit(event): void {
        const identity = `${event.type}:${event.nodeId ?? "plan"}:${event.waveIndex ?? "terminal"}`;
        appendCausal(event.type, `multi-target:${input.runId}:event:${identity}`, event.payload ?? {});
      },
    },
    lease: {
      claim,
      renew,
      release,
      canResume(nodeId): boolean {
        const current = readLease(nodeId);
        return !!current && current.owner_id === input.ownerId && current.expires_at > now();
      },
    },
  };
}
