// run-ledger.test.ts — state machine, lease expiry, terminal invariants,
// abandon semantics. Hermetic: temp-dir DBs + temp audit/state paths.
import { describe, expect, test, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-run-ledger-test-"));
process.env.HARNESS_LOGS_DIR = path.join(TMP, "harness-logs");
process.env.NIRVANA_STATE_DB = path.join(TMP, "state.db");
process.env.NIRVANA_SKILLS_DIR = path.resolve(import.meta.dir, "..", "..");
process.env.NIRVANA_RUN_LEDGER_DB = path.join(TMP, "default-ledger.sqlite");

import {
  openLedger, openRun, getRun, markState, renewLease, abandon, incrementRetries,
  findExpired, findNonTerminal, countNonTerminal, resumeInfo, canTransition,
  isTerminal, resolveLedgerDbPath, TERMINAL_STATES,
  type LedgerHandle,
} from "../lib/run-ledger.ts";

let dbSeq = 0;
function freshLedger(): LedgerHandle {
  return openLedger(path.join(TMP, `case-${dbSeq++}.sqlite`));
}

afterAll(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ } });

describe("run-ledger — schema and open", () => {
  test("resolveLedgerDbPath honors NIRVANA_RUN_LEDGER_DB", () => {
    expect(resolveLedgerDbPath()).toBe(path.join(TMP, "default-ledger.sqlite"));
  });

  test("openRun creates a dispatched row with defaults", () => {
    const h = freshLedger();
    const row = openRun(h, { traceId: "t1", projectId: "p1", targetSlug: "biz", targetKind: "business", runtime: "claude-code", meta: { a: 1 } });
    expect(row.state).toBe("dispatched");
    expect(row.retries).toBe(0);
    expect(row.max_retries).toBe(2);
    expect(row.meta).toEqual({ a: 1 });
    expect(Date.parse(row.lease_expires_at!)).toBeGreaterThan(Date.now());
    expect(row.heartbeat_at).toBeTruthy();
  });
});

describe("run-ledger — state machine", () => {
  test("happy path: dispatched → running → verifying → gated → delivered (terminal)", () => {
    const h = freshLedger();
    const { run_id } = openRun(h, {});
    markState(h, run_id, "running", { childPid: 4242 });
    markState(h, run_id, "verifying");
    markState(h, run_id, "gated");
    const done = markState(h, run_id, "delivered");
    expect(done.state).toBe("delivered");
    expect(done.terminal_at).toBeTruthy();
    expect(done.child_pid).toBe(4242);
    expect(isTerminal(done.state)).toBe(true);
  });

  test("withheld is terminal on the gate-fail path", () => {
    const h = freshLedger();
    const { run_id } = openRun(h, {});
    markState(h, run_id, "running");
    markState(h, run_id, "gated");
    const w = markState(h, run_id, "withheld", { error: "gate fail" });
    expect(w.state).toBe("withheld");
    expect(w.terminal_at).toBeTruthy();
    expect(w.last_error).toBe("gate fail");
  });

  test("illegal transitions throw", () => {
    const h = freshLedger();
    const { run_id } = openRun(h, {});
    expect(() => markState(h, run_id, "gated")).toThrow(/illegal transition/);
    expect(() => markState(h, run_id, "delivered")).toThrow(/illegal transition/);
    // same-state is illegal too
    expect(() => markState(h, run_id, "dispatched")).toThrow(/same-state/);
    // unknown state
    expect(() => markState(h, run_id, "flying" as any)).toThrow(/unknown state/);
  });

  test("terminal states are final: no transition out, no lease renewal, no retries", () => {
    const h = freshLedger();
    const { run_id } = openRun(h, {});
    markState(h, run_id, "running");
    markState(h, run_id, "delivered");
    expect(() => markState(h, run_id, "failed")).toThrow(/terminal/);
    expect(renewLease(h, run_id, 60)).toBe(false);
    expect(() => incrementRetries(h, run_id)).toThrow(/terminal/);
  });

  test("stalled and failed are recoverable", () => {
    const h = freshLedger();
    const { run_id } = openRun(h, {});
    markState(h, run_id, "running");
    markState(h, run_id, "failed", { error: "boom" });
    markState(h, run_id, "running");     // failed → running (resume)
    markState(h, run_id, "stalled");     // running → stalled (escalation)
    markState(h, run_id, "running");     // stalled → running (human intervened)
    const row = markState(h, run_id, "delivered");
    expect(row.state).toBe("delivered");
    expect(row.last_error).toBe("boom"); // COALESCE keeps the last real error
  });

  test("abandoned is unreachable via markState", () => {
    const h = freshLedger();
    const { run_id } = openRun(h, {});
    expect(() => markState(h, run_id, "abandoned")).toThrow(/abandon\(/);
  });

  test("canTransition mirrors the table", () => {
    expect(canTransition("dispatched", "running")).toBe(true);
    expect(canTransition("running", "delivered")).toBe(true);
    expect(canTransition("delivered", "running")).toBe(false);
    expect(canTransition("dispatched", "gated")).toBe(false);
    for (const t of TERMINAL_STATES) expect(canTransition(t as any, "running")).toBe(false);
  });
});

describe("run-ledger — leases and expiry queries", () => {
  test("renewLease advances lease_expires_at and heartbeat_at", () => {
    const h = freshLedger();
    const row = openRun(h, { initialLeaseSec: 1 });
    const before = row.lease_expires_at!;
    expect(renewLease(h, row.run_id, 3600)).toBe(true);
    const after = getRun(h, row.run_id)!;
    expect(Date.parse(after.lease_expires_at!)).toBeGreaterThan(Date.parse(before));
    expect(Date.parse(after.lease_expires_at!)).toBeGreaterThan(Date.now() + 3000_000);
    expect(Date.parse(after.heartbeat_at!)).toBeGreaterThanOrEqual(Date.parse(row.heartbeat_at!));
  });

  test("findExpired returns only non-terminal runs with expired leases", () => {
    const h = freshLedger();
    const expired = openRun(h, { initialLeaseSec: -60 });
    const fresh = openRun(h, { initialLeaseSec: 900 });
    const doneButExpired = openRun(h, { initialLeaseSec: -60 });
    markState(h, doneButExpired.run_id, "running");
    markState(h, doneButExpired.run_id, "delivered");
    const ids = findExpired(h).map(r => r.run_id);
    expect(ids).toContain(expired.run_id);
    expect(ids).not.toContain(fresh.run_id);
    expect(ids).not.toContain(doneButExpired.run_id);
  });

  test("findExpired honors an injected clock", () => {
    const h = freshLedger();
    const row = openRun(h, { initialLeaseSec: 900 });
    expect(findExpired(h).map(r => r.run_id)).not.toContain(row.run_id);
    expect(findExpired(h, Date.now() + 3600_000).map(r => r.run_id)).toContain(row.run_id);
  });

  test("findNonTerminal / countNonTerminal exclude terminal rows", () => {
    const h = freshLedger();
    const a = openRun(h, {});
    const b = openRun(h, {});
    markState(h, b.run_id, "running");
    markState(h, b.run_id, "delivered");
    const ids = findNonTerminal(h).map(r => r.run_id);
    expect(ids).toContain(a.run_id);
    expect(ids).not.toContain(b.run_id);
    expect(countNonTerminal(h)).toBe(1);
  });
});

describe("run-ledger — abandon and resume info", () => {
  test("abandon requires a non-empty reason", () => {
    const h = freshLedger();
    const { run_id } = openRun(h, {});
    expect(() => abandon(h, run_id, "")).toThrow(/reason/);
    expect(() => abandon(h, run_id, "   ")).toThrow(/reason/);
    const row = abandon(h, run_id, "owner cancelled the brief");
    expect(row.state).toBe("abandoned");
    expect(row.last_error).toBe("owner cancelled the brief");
    expect(row.terminal_at).toBeTruthy();
    expect(() => abandon(h, run_id, "again")).toThrow(/terminal/);
  });

  test("resumeInfo exposes session, runtime, retries and meta", () => {
    const h = freshLedger();
    const { run_id } = openRun(h, {
      projectId: "proj-9", runtime: "codex", sessionId: "sess-9",
      maxRetries: 5, meta: { outputs_root: "/tmp/x" },
    });
    incrementRetries(h, run_id);
    const info = resumeInfo(h, run_id)!;
    expect(info.projectId).toBe("proj-9");
    expect(info.runtime).toBe("codex");
    expect(info.sessionId).toBe("sess-9");
    expect(info.retries).toBe(1);
    expect(info.maxRetries).toBe(5);
    expect(info.meta.outputs_root).toBe("/tmp/x");
    expect(resumeInfo(h, "nope")).toBeNull();
  });
});
