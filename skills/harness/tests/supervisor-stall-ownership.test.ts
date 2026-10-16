// supervisor-stall-ownership.test.ts — one owner per phase.
//
// While a run's dispatcher is alive, its own stall guard decides whether the
// run is stuck (stall-guard.ts) and ends it with exit 76. The supervisor's
// lease rule would have killed healthy runs silent for 47 to 72 minutes, and
// two deciders on one row relaunch it twice. So the sweep leaves a row with a
// live dispatcher alone until the run has been silent past the stall threshold
// plus the grace, and a row the dispatcher marked stalled is the agent's: it
// is neither relaunched nor salvaged behind its back.
import { afterAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-supervisor-owner-"));
process.env.HARNESS_LOGS_DIR = path.join(TMP, "harness-logs");
process.env.NIRVANA_STATE_DB = path.join(TMP, "state.db");
process.env.NIRVANA_SKILLS_DIR = path.resolve(import.meta.dir, "..", "..");
process.env.NIRVANA_RUN_LEDGER_DB = path.join(TMP, "ledger.sqlite");

import { resumeOutcome, sweep, type RecoveryResult } from "../scripts/supervisor.ts";
import { getRun, markState, openLedger, openRun, type LedgerHandle, type RunRow } from "../lib/run-ledger.ts";

const children: ChildProcess[] = [];
afterAll(() => {
  for (const c of children) { try { c.kill("SIGKILL"); } catch { /* gone */ } }
  // Windows cannot delete a SQLite file that is still open.
  for (const h of handles) h.close();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ }
});

let seq = 0;
const handles: LedgerHandle[] = [];
function ledger() { const h = openLedger(path.join(TMP, `case-${seq++}.sqlite`)); handles.push(h); return h; }
function live(): number {
  const c = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  children.push(c);
  return c.pid!;
}

const GUARD = { stall_guard: { silence_ms: 90 * 60_000, no_start_ms: 45 * 60_000 } };

function seams() {
  const seen = { killed: [] as number[], redispatched: [] as RunRow[], resumed: [] as RunRow[], notified: [] as RunRow[], salvaged: [] as RunRow[] };
  const stub = (list: RunRow[]) => (r: RunRow): RecoveryResult => { list.push(r); return { ok: true, finalState: "delivered", detail: "stub" }; };
  return {
    seen,
    deps: {
      killImpl: (pid: number) => { seen.killed.push(pid); },
      redispatchImpl: stub(seen.redispatched),
      resumeImpl: stub(seen.resumed),
      notifyImpl: (r: RunRow) => { seen.notified.push(r); },
      salvageImpl: (r: RunRow) => { seen.salvaged.push(r); return { judged: false } as any; },
      pidExitWaitMs: 0,
      pingImpl: () => {},
      quiet: true,
    },
  };
}

describe("a live dispatcher owns its run's stall decision", () => {
  test("an expired lease with a quiet live worker is left to the dispatcher, not killed and relaunched", () => {
    const h = ledger();
    const row = openRun(h, { runtime: "claude-code", childPid: live(), initialLeaseSec: -60, meta: { dispatcher_pid: live(), ...GUARD, outputs_root: path.join(TMP, "none") } });
    markState(h, row.run_id, "running");
    const { seen, deps } = seams();
    // 60 minutes after the last heartbeat: past the lease, inside 90 + 15.
    const s = sweep({ handle: h, now: Date.now() + 60 * 60_000, ...deps });
    expect(seen.killed).toEqual([]);
    expect(seen.redispatched).toEqual([]);
    expect(s.skipped).toBe(1);
    expect(getRun(h, row.run_id)!.state).toBe("running");
  }, 20_000);

  test("past the stall threshold plus the grace, the supervisor takes over a wedged dispatcher's run", () => {
    const h = ledger();
    const worker = live();
    const row = openRun(h, { runtime: "claude-code", childPid: worker, initialLeaseSec: -60, meta: { dispatcher_pid: live(), ...GUARD, outputs_root: path.join(TMP, "none") } });
    markState(h, row.run_id, "running");
    const { seen, deps } = seams();
    sweep({ handle: h, now: Date.now() + 106 * 60_000, ...deps });
    expect(seen.killed).toEqual([worker]);
    expect(seen.redispatched.length).toBe(1);
  }, 20_000);

  test("a run the dispatcher marked stalled is the agent's: no relaunch, no salvage, no second notice", () => {
    const h = ledger();
    const row = openRun(h, { runtime: "antigravity-cli", childPid: null, initialLeaseSec: -60, meta: { ...GUARD } });
    markState(h, row.run_id, "running");
    markState(h, row.run_id, "stalled", { error: "stalled: the worker never started", metaPatch: { stall: { rule: "never_started", confirmed_at: new Date().toISOString() }, salvaged: true } });
    const { seen, deps } = seams();
    sweep({ handle: h, now: Date.now() + 10 * 60 * 60_000, ...deps });
    expect(seen.resumed).toEqual([]);
    expect(seen.redispatched).toEqual([]);
    expect(seen.salvaged).toEqual([]);
    expect(seen.notified).toEqual([]);
    expect(getRun(h, row.run_id)!.state).toBe("stalled");
  }, 20_000);

  test("a resume whose revision stalls again (revise exit 76) stays stalled", () => {
    expect(resumeOutcome(76).finalState).toBe("stalled");
    const h = ledger();
    const dead = spawnSync(process.execPath, ["-e", "0"]).pid!;
    const row = openRun(h, { runtime: "codex", childPid: dead, sessionId: "s", projectId: "p", initialLeaseSec: -60 });
    markState(h, row.run_id, "running");
    const { deps } = seams();
    sweep({ handle: h, ...deps, resumeImpl: (r: RunRow) => {
      markState(h, r.run_id, "stalled", { error: "stalled", metaPatch: { stall: { rule: "silence", confirmed_at: new Date().toISOString() }, salvaged: true } });
      return resumeOutcome(76);
    } });
    expect(getRun(h, row.run_id)!.state).toBe("stalled");
  }, 20_000);
});
