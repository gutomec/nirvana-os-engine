// claude-session-cost.ts — what ONE claude run cost when it resumed a session.
//
// Since claude 2.1.277 a resumed session's `total_cost_usd` includes the spend
// of the runs it restored: "Read the latest result for the session total;
// summing results double-counts the restored spend"
// (code.claude.com/docs/en/agent-sdk/cost-tracking, audited 2026-10-11). Every
// engine path that resumes and records cost (nrv revise, the delivery
// pipeline's revision rounds, solo review corrections, maestro chat turns)
// would otherwise add the whole session again on each round.
//
// So the last total reported for each session id is kept, and a resumed run
// records the difference. The store is the run ledger (one SQLite file per
// machine, so `nrv revise` in a new process still finds the total the dispatch
// left), with an in-memory copy for the runs of one process. When the previous
// total is unknown (a session from before this store, or a ledger that cannot
// open) the reported value is kept as it is, which is the old behaviour.
import { openLedger, recordSessionCostTotal, sessionCostTotal } from "../../harness/lib/run-ledger.ts";

export interface SessionCostStore {
  get(sessionId: string): number | null;
  set(sessionId: string, totalUsd: number): void;
}

const memory = new Map<string, number>();

/** The default store: memory first, then the run ledger. Ledger trouble never fails a run. */
export const ledgerSessionCostStore: SessionCostStore = {
  get(sessionId) {
    const known = memory.get(sessionId);
    if (known !== undefined) return known;
    try { return sessionCostTotal(openLedger(), sessionId); } catch { return null; }
  },
  set(sessionId, totalUsd) {
    memory.set(sessionId, totalUsd);
    try { recordSessionCostTotal(openLedger(), sessionId, totalUsd); } catch { /* memory keeps it for this process */ }
  },
};

/**
 * The cost to record for one claude run. `resumedFrom` is the session id the
 * run resumed (null on a fresh run), `sessionId` the id the result carried,
 * `reportedUsd` the result's `total_cost_usd`. The reported value is stored as
 * the session's new total either way.
 *
 * A reported value below the stored total cannot be cumulative (a CLI older
 * than 2.1.277 reports the run's own spend), so it is kept as it is.
 */
export function claudeRunCost(
  input: { resumedFrom: string | null | undefined; sessionId: string | null | undefined; reportedUsd: number | null },
  store: SessionCostStore = ledgerSessionCostStore,
): number | null {
  const reported = input.reportedUsd;
  if (typeof reported !== "number" || !Number.isFinite(reported)) return reported;
  let cost = reported;
  if (input.resumedFrom) {
    const previous = store.get(input.resumedFrom);
    if (previous !== null && reported >= previous) cost = Math.round((reported - previous) * 1e9) / 1e9;
  }
  const id = input.sessionId || input.resumedFrom;
  if (id) store.set(id, reported);
  return cost;
}
