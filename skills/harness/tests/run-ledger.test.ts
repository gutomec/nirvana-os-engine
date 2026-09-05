// run-ledger.test.ts — state machine, lease expiry, terminal invariants,
// abandon semantics. Hermetic: temp-dir DBs + temp audit/state paths.
import { describe, expect, test, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { KERNEL_BUDGET_MS } from "./helpers/test-budgets.ts";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-run-ledger-test-"));
// Snapshot BEFORE mutating: these are process-wide, and bun runs test FILES in
// one process, so values left behind here would point every later file at this
// throwaway state db. Restored in afterAll.
const ENV_BEFORE = {
  HARNESS_LOGS_DIR: process.env.HARNESS_LOGS_DIR,
  NIRVANA_STATE_DB: process.env.NIRVANA_STATE_DB,
  NIRVANA_SKILLS_DIR: process.env.NIRVANA_SKILLS_DIR,
  NIRVANA_RUN_LEDGER_DB: process.env.NIRVANA_RUN_LEDGER_DB,
};
process.env.HARNESS_LOGS_DIR = path.join(TMP, "harness-logs");
process.env.NIRVANA_STATE_DB = path.join(TMP, "state.db");
process.env.NIRVANA_SKILLS_DIR = path.resolve(import.meta.dir, "..", "..");
process.env.NIRVANA_RUN_LEDGER_DB = path.join(TMP, "default-ledger.sqlite");

import {
  openLedger, openRun, getRun, markState, renewLease, abandon, incrementRetries,
  findExpired, findNonTerminal, countNonTerminal, resumeInfo, canTransition,
  isTerminal, resolveLedgerDbPath, patchMeta, scanDir, latestMtimeMs, TERMINAL_STATES,
  type LedgerHandle,
} from "../lib/run-ledger.ts";

let dbSeq = 0;
function freshLedger(): LedgerHandle {
  return openLedger(path.join(TMP, `case-${dbSeq++}.sqlite`));
}

afterAll(() => {
  for (const [k, v] of Object.entries(ENV_BEFORE)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe("run-ledger — schema and open", () => {
  test("resolveLedgerDbPath honors NIRVANA_RUN_LEDGER_DB", () => {
    expect(resolveLedgerDbPath()).toBe(path.join(TMP, "default-ledger.sqlite"));
  }, KERNEL_BUDGET_MS);

  test("openRun creates a dispatched row with defaults", () => {
    const h = freshLedger();
    const row = openRun(h, { traceId: "t1", projectId: "p1", targetSlug: "biz", targetKind: "business", runtime: "claude-code", meta: { a: 1 } });
    expect(row.state).toBe("dispatched");
    expect(row.retries).toBe(0);
    expect(row.max_retries).toBe(2);
    expect(row.meta).toEqual({ a: 1 });
    expect(Date.parse(row.lease_expires_at!)).toBeGreaterThan(Date.now());
    expect(row.heartbeat_at).toBeTruthy();
  }, KERNEL_BUDGET_MS);
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
  }, KERNEL_BUDGET_MS);

  test("withheld is terminal on the gate-fail path", () => {
    const h = freshLedger();
    const { run_id } = openRun(h, {});
    markState(h, run_id, "running");
    markState(h, run_id, "gated");
    const w = markState(h, run_id, "withheld", { error: "gate fail" });
    expect(w.state).toBe("withheld");
    expect(w.terminal_at).toBeTruthy();
    expect(w.last_error).toBe("gate fail");
  }, KERNEL_BUDGET_MS);

  test("illegal transitions throw", () => {
    const h = freshLedger();
    const { run_id } = openRun(h, {});
    expect(() => markState(h, run_id, "gated")).toThrow(/illegal transition/);
    expect(() => markState(h, run_id, "delivered")).toThrow(/illegal transition/);
    // same-state is illegal too
    expect(() => markState(h, run_id, "dispatched")).toThrow(/same-state/);
    // unknown state
    expect(() => markState(h, run_id, "flying" as any)).toThrow(/unknown state/);
  }, KERNEL_BUDGET_MS);

  test("terminal states are final: no transition out, no lease renewal, no retries", () => {
    const h = freshLedger();
    const { run_id } = openRun(h, {});
    markState(h, run_id, "running");
    markState(h, run_id, "delivered");
    expect(() => markState(h, run_id, "failed")).toThrow(/terminal/);
    expect(renewLease(h, run_id, 60)).toBe(false);
    expect(() => incrementRetries(h, run_id)).toThrow(/terminal/);
  }, KERNEL_BUDGET_MS);

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
  }, KERNEL_BUDGET_MS);

  test("failed → verifying: the runtime-error salvage edge (artifacts on disk get judged)", () => {
    const h = freshLedger();
    const { run_id } = openRun(h, {});
    markState(h, run_id, "running");
    markState(h, run_id, "failed", { error: "runtime returned an error verdict", metaPatch: { runtime_errored: true } });
    markState(h, run_id, "verifying");   // failed → verifying (salvage, no re-dispatch)
    markState(h, run_id, "gated");
    const row = markState(h, run_id, "withheld");
    expect(row.state).toBe("withheld");
    // The runtime's verdict survives the whole recovery, on the terminal row.
    expect(row.last_error).toBe("runtime returned an error verdict");
    expect(row.meta.runtime_errored).toBe(true);
    expect(canTransition("failed", "verifying")).toBe(true);
  }, KERNEL_BUDGET_MS);

  test("stalled → verifying: the supervisor salvage edge (an escalated run's artifacts get judged)", () => {
    const h = freshLedger();
    const { run_id } = openRun(h, {});
    markState(h, run_id, "running");
    markState(h, run_id, "stalled", { error: "supervisor: orphaned run; retries exhausted" });
    markState(h, run_id, "verifying");   // stalled → verifying (salvage, read-only)
    markState(h, run_id, "gated");
    const row = markState(h, run_id, "withheld");
    expect(row.state).toBe("withheld");
    expect(row.last_error).toBe("supervisor: orphaned run; retries exhausted");
    expect(canTransition("stalled", "verifying")).toBe(true);
  }, KERNEL_BUDGET_MS);

  test("patchMeta merges without a state transition", () => {
    const h = freshLedger();
    const { run_id } = openRun(h, { meta: { outputs_root: "/tmp/out" } });
    markState(h, run_id, "running");
    const row = patchMeta(h, run_id, { salvaged: true })!;
    expect(row.state).toBe("running");                 // untouched
    expect(row.meta.outputs_root).toBe("/tmp/out");    // merged, not replaced
    expect(row.meta.salvaged).toBe(true);
    expect(patchMeta(h, "no-such-run", { salvaged: true })).toBeNull();
  }, KERNEL_BUDGET_MS);

  test("abandoned is unreachable via markState", () => {
    const h = freshLedger();
    const { run_id } = openRun(h, {});
    expect(() => markState(h, run_id, "abandoned")).toThrow(/abandon\(/);
  }, KERNEL_BUDGET_MS);

  test("canTransition mirrors the table", () => {
    expect(canTransition("dispatched", "running")).toBe(true);
    expect(canTransition("running", "delivered")).toBe(true);
    expect(canTransition("delivered", "running")).toBe(false);
    expect(canTransition("dispatched", "gated")).toBe(false);
    for (const t of TERMINAL_STATES) expect(canTransition(t as any, "running")).toBe(false);
  }, KERNEL_BUDGET_MS);
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
  }, KERNEL_BUDGET_MS);

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
  }, KERNEL_BUDGET_MS);

  test("findExpired honors an injected clock", () => {
    const h = freshLedger();
    const row = openRun(h, { initialLeaseSec: 900 });
    expect(findExpired(h).map(r => r.run_id)).not.toContain(row.run_id);
    expect(findExpired(h, Date.now() + 3600_000).map(r => r.run_id)).toContain(row.run_id);
  }, KERNEL_BUDGET_MS);

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
  }, KERNEL_BUDGET_MS);
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
  }, KERNEL_BUDGET_MS);

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
  }, KERNEL_BUDGET_MS);
});

describe("run-ledger — scanDir (what the heartbeat reports)", () => {
  let dirSeq = 0;
  /** A tree whose files are written with EXPLICIT mtimes, so the assertions
   *  never depend on how fast the filesystem's clock ticks. */
  function tree(files: Record<string, number>): string {
    const dir = path.join(TMP, `scan-${dirSeq++}`);
    for (const [rel, mtimeMs] of Object.entries(files)) {
      const full = path.join(dir, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, rel, "utf8");
      const when = new Date(mtimeMs);
      fs.utimesSync(full, when, when);
    }
    return dir;
  }
  const rel = (dir: string, scan: ReturnType<typeof scanDir>) => scan.changed.map(f => path.relative(dir, f.path).split(path.sep).join("/"));

  test("reports only what moved after the mark, oldest first, with size", () => {
    const dir = tree({ "old.md": 1_000_000, "a/first.md": 2_000_000, "b/second.md": 3_000_000 });
    const scan = scanDir(dir, 1_500_000, { limit: 10 });
    expect(rel(dir, scan)).toEqual(["a/first.md", "b/second.md"]);
    expect(scan.omitted).toBe(0);
    expect(scan.changed[0].sizeBytes).toBe("a/first.md".length);
    expect(scan.latestMs).toBeGreaterThanOrEqual(3_000_000);
  }, KERNEL_BUDGET_MS);

  test("noise is never progress: .git, node_modules, .nirvana, dist and editor tempfiles are excluded", () => {
    const dir = tree({
      "report.md": 3_000_000,
      ".git/index": 3_000_000,
      "node_modules/pkg/index.js": 3_000_000,
      ".nirvana/state/run.json": 3_000_000,
      "dist/bundle.js": 3_000_000,
      "notes.md.swp": 3_000_000,
      ".DS_Store": 3_000_000,
    });
    expect(rel(dir, scanDir(dir, 1_000_000, { limit: 50 }))).toEqual(["report.md"]);
  }, KERNEL_BUDGET_MS);

  test("noise still counts as liveness: latestMtimeMs sees what the report hides", () => {
    const dir = tree({ "node_modules/pkg/index.js": 4_000_000 });
    // Nothing to report, but the supervisor must still read the tree as alive —
    // pruning the traversal would have silently changed that signal.
    expect(scanDir(dir, 1_000_000, { limit: 50 }).changed).toEqual([]);
    expect(latestMtimeMs(dir)).toBeGreaterThanOrEqual(4_000_000);
  }, KERNEL_BUDGET_MS);

  test("the limit keeps the FIRST touches and names how many it dropped", () => {
    const dir = tree({ "s1.md": 2_000_000, "s2.md": 3_000_000, "s3.md": 4_000_000, "s4.md": 5_000_000 });
    const scan = scanDir(dir, 1_000_000, { limit: 2 });
    expect(rel(dir, scan)).toEqual(["s1.md", "s2.md"]);
    expect(scan.omitted).toBe(2);
  }, KERNEL_BUDGET_MS);

  test("limit 0 reports nothing and still answers the liveness question", () => {
    const dir = tree({ "x.md": 2_000_000 });
    const scan = scanDir(dir, 1_000_000, { limit: 0 });
    expect(scan.changed).toEqual([]);
    expect(scan.omitted).toBe(0);
    expect(scan.latestMs).toBeGreaterThanOrEqual(2_000_000);
  }, KERNEL_BUDGET_MS);

  test("a missing directory is empty, never a throw", () => {
    const scan = scanDir(path.join(TMP, "nope-not-here"), 0, { limit: 10 });
    expect(scan).toEqual({ latestMs: 0, changed: [], omitted: 0 });
    expect(latestMtimeMs(path.join(TMP, "nope-not-here"))).toBe(0);
  }, KERNEL_BUDGET_MS);
});
