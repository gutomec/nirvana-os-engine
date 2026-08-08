// supervisor-sweep.test.ts — recovery semantics of the never-stall sweep:
// dead pid → resume seam; live-but-stalled → SIGTERM + redispatch seam;
// retries exhausted → stalled + notify; guards (self-pid, recursion, opt-out);
// nothing-pending maybeSweep <20ms; launchd plist content via --print.
// Hermetic: one temp SQLite per case, injectable seams, fake children.
import { describe, expect, test, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-supervisor-test-"));
process.env.HARNESS_LOGS_DIR = path.join(TMP, "harness-logs");
process.env.NIRVANA_STATE_DB = path.join(TMP, "state.db");
process.env.NIRVANA_SKILLS_DIR = path.resolve(import.meta.dir, "..", "..");
process.env.NIRVANA_RUN_LEDGER_DB = path.join(TMP, "maybe-sweep.sqlite");

import { sweep, maybeSweep, renderLaunchdPlist, type RecoveryResult } from "../scripts/supervisor.ts";
import { openLedger, openRun, getRun, markState, pidAlive, type LedgerHandle, type RunRow } from "../lib/run-ledger.ts";

let dbSeq = 0;
function freshLedger(): LedgerHandle {
  return openLedger(path.join(TMP, `case-${dbSeq++}.sqlite`));
}

function deadPid(): number {
  const r = spawnSync(process.execPath, ["-e", "0"], { stdio: "ignore" });
  return r.pid!;
}

const noNotify = () => {};
const okResume = (calls: RunRow[]) => (r: RunRow): RecoveryResult => { calls.push(r); return { ok: true, finalState: "delivered", detail: "stub" }; };

afterAll(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ } });

describe("supervisor sweep — recovery paths", () => {
  test("expired lease + dead pid → resume seam called, retries++, outcome recorded", () => {
    const h = freshLedger();
    const row = openRun(h, {
      targetSlug: "biz", targetKind: "business", runtime: "claude-code",
      childPid: deadPid(), sessionId: "sess-1", projectId: "proj-1", initialLeaseSec: -60,
    });
    markState(h, row.run_id, "running");
    const calls: RunRow[] = [];
    const s = sweep({ handle: h, resumeImpl: okResume(calls), notifyImpl: noNotify });
    expect(calls.length).toBe(1);
    expect(calls[0].run_id).toBe(row.run_id);
    const after = getRun(h, row.run_id)!;
    expect(after.state).toBe("delivered");
    expect(after.retries).toBe(1);
    expect(s.resumed).toBe(1);
    expect(s.recovered).toBe(1);
  });

  test("failed resume keeps the run recoverable for the next sweep", () => {
    const h = freshLedger();
    const row = openRun(h, { childPid: deadPid(), initialLeaseSec: -60 });
    const s = sweep({ handle: h, resumeImpl: () => ({ ok: false, finalState: "failed", detail: "stub fail" }), notifyImpl: noNotify });
    const after = getRun(h, row.run_id)!;
    expect(after.state).toBe("failed");
    expect(after.retries).toBe(1);
    expect(s.resumed).toBe(1);
    expect(s.recovered).toBe(0);
  });

  test("expired lease + live-but-stalled pid → SIGTERM (default kill) + redispatch seam", async () => {
    const h = freshLedger();
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
    expect(pidAlive(child.pid!)).toBe(true);
    const row = openRun(h, {
      childPid: child.pid, initialLeaseSec: -60,
      meta: { outputs_root: path.join(TMP, "does-not-exist") },
    });
    markState(h, row.run_id, "running");
    // Fake "now" 10 min ahead: lease long expired, heartbeat stale.
    const future = Date.now() + 10 * 60_000;
    const redis: RunRow[] = [];
    const s = sweep({
      handle: h, now: future, notifyImpl: noNotify,
      redispatchImpl: (r) => { redis.push(r); return { ok: false, finalState: "failed", detail: "stub" }; },
    });
    expect(redis.length).toBe(1);
    expect(s.redispatched).toBe(1);
    const after = getRun(h, row.run_id)!;
    expect(after.retries).toBe(1);
    expect(after.state).toBe("failed");
    // The ledgered pid actually received SIGTERM.
    for (let i = 0; i < 20 && pidAlive(child.pid!); i++) await Bun.sleep(100);
    expect(pidAlive(child.pid!)).toBe(false);
  }, 10_000);

  test("live pid with recent output-dir activity gets a grace lease, never a signal", () => {
    const h = freshLedger();
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
    const oroot = path.join(TMP, "active-outputs");
    fs.mkdirSync(oroot, { recursive: true });
    fs.writeFileSync(path.join(oroot, "draft.md"), "work in progress"); // fresh mtime
    const row = openRun(h, { childPid: child.pid, initialLeaseSec: -60, meta: { outputs_root: oroot } });
    markState(h, row.run_id, "running");
    const killed: number[] = [];
    // heartbeat_at is fresh (openRun) AND the output dir is fresh → graced.
    const s = sweep({ handle: h, killImpl: (p) => killed.push(p), notifyImpl: noNotify, redispatchImpl: () => ({ ok: true }) });
    expect(killed.length).toBe(0);
    expect(s.graced).toBe(1);
    const after = getRun(h, row.run_id)!;
    expect(after.state).toBe("running");
    expect(Date.parse(after.lease_expires_at!)).toBeGreaterThan(Date.now());
    child.kill("SIGKILL");
  });

  test("retries exhausted → stalled + notify seam; resume NOT attempted; later sweeps skip it", () => {
    const h = freshLedger();
    const row = openRun(h, { childPid: deadPid(), initialLeaseSec: -60, maxRetries: 0, projectId: "proj-x" });
    markState(h, row.run_id, "running");
    const resumes: RunRow[] = [];
    let notified = 0;
    const s = sweep({ handle: h, resumeImpl: okResume(resumes), notifyImpl: () => { notified++; } });
    expect(resumes.length).toBe(0);
    expect(notified).toBe(1);
    expect(s.escalated).toBe(1);
    const after = getRun(h, row.run_id)!;
    expect(after.state).toBe("stalled");
    // A second sweep must not re-notify (a human owns it now).
    const s2 = sweep({ handle: h, resumeImpl: okResume(resumes), notifyImpl: () => { notified++; } });
    expect(notified).toBe(1);
    expect(s2.skipped).toBe(1);
    expect(s2.escalated).toBe(0);
  });

  test("valid lease → untouched", () => {
    const h = freshLedger();
    const row = openRun(h, { initialLeaseSec: 900 });
    const s = sweep({ handle: h, resumeImpl: okResume([]), redispatchImpl: () => ({ ok: true }), notifyImpl: noNotify });
    expect(s.skipped).toBe(1);
    expect(getRun(h, row.run_id)!.state).toBe("dispatched");
  });

  test("self-guard: a run claiming the supervisor's own pid is never signaled nor recovered", () => {
    const h = freshLedger();
    const row = openRun(h, { childPid: process.pid, initialLeaseSec: -60 });
    markState(h, row.run_id, "running");
    const killed: number[] = [];
    const touched: RunRow[] = [];
    const s = sweep({
      handle: h, killImpl: (p) => killed.push(p), notifyImpl: noNotify,
      resumeImpl: okResume(touched), redispatchImpl: (r) => { touched.push(r); return { ok: true }; },
    });
    expect(killed.length).toBe(0);
    expect(touched.length).toBe(0);
    expect(s.skipped).toBe(1);
    expect(getRun(h, row.run_id)!.state).toBe("running");
  });

  test("kill seam only ever receives the LEDGERED pid", () => {
    const h = freshLedger();
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
    const row = openRun(h, { childPid: child.pid, initialLeaseSec: -60, meta: { outputs_root: path.join(TMP, "nope") } });
    markState(h, row.run_id, "running");
    const killed: number[] = [];
    sweep({
      handle: h, now: Date.now() + 10 * 60_000, notifyImpl: noNotify,
      killImpl: (p) => killed.push(p),
      redispatchImpl: () => ({ ok: false, finalState: "failed" }),
    });
    expect(killed).toEqual([child.pid!]);
    child.kill("SIGKILL");
  });

  test("sweep never throws — a poisoned row is counted as an error, the rest still sweep", () => {
    const h = freshLedger();
    const bad = openRun(h, { childPid: deadPid(), initialLeaseSec: -60 });
    const good = openRun(h, { childPid: deadPid(), initialLeaseSec: -60 });
    const s = sweep({
      handle: h, notifyImpl: noNotify,
      resumeImpl: (r) => {
        if (r.run_id === bad.run_id) throw new Error("seam exploded");
        return { ok: true, finalState: "delivered" };
      },
    });
    expect(s.errors).toBe(1);
    expect(getRun(h, good.run_id)!.state).toBe("delivered");
  });
});

describe("supervisor — lazy sweep guards and speed", () => {
  test("recursion guard and opt-out short-circuit", () => {
    process.env.NRV_IN_SWEEP = "1";
    expect(maybeSweep()).toBe(false);
    delete process.env.NRV_IN_SWEEP;
    process.env.NRV_SUPERVISOR = "0";
    expect(maybeSweep()).toBe(false);
    delete process.env.NRV_SUPERVISOR;
  });

  test("nothing pending: <20ms and no background sweep; recent-sweep guard skips the next call", () => {
    // Dedicated empty DB via the env override maybeSweep reads.
    process.env.NIRVANA_RUN_LEDGER_DB = path.join(TMP, "maybe-sweep.sqlite");
    openLedger(); // warm (file + DDL) so we measure the steady state
    const t0 = performance.now();
    const spawned = maybeSweep();
    const elapsed = performance.now() - t0;
    expect(spawned).toBe(false);
    expect(elapsed).toBeLessThan(20);
    // A pending run appears, but the last sweep was <5 min ago → still skipped
    // (the background cadence belongs to launchd/watch, not the hot path).
    const h = openLedger();
    openRun(h, { initialLeaseSec: -60 });
    expect(maybeSweep()).toBe(false);
  });
});

describe("supervisor — launchd plist", () => {
  test("install --print emits a sane plist without touching LaunchAgents", () => {
    const supervisorScript = path.resolve(import.meta.dir, "..", "scripts", "supervisor.ts");
    const r = spawnSync(process.execPath, [supervisorScript, "install", "--print"], {
      encoding: "utf8", env: { ...process.env },
    });
    expect(r.status).toBe(0);
    const plist = r.stdout;
    expect(plist).toContain("<key>Label</key><string>sh.nirvana.supervisor</string>");
    expect(plist).toContain("<key>StartInterval</key><integer>120</integer>");
    expect(plist).toContain("<key>RunAtLoad</key><true/>");
    expect(plist).toContain("<string>sweep</string>");
    expect(plist).toContain("<string>--quiet</string>");
    expect(plist).toContain(supervisorScript);
    // In-process render matches the CLI output.
    expect(renderLaunchdPlist()).toBe(plist);
  });
});
