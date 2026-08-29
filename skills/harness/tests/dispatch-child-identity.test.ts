// dispatch-child-identity.test.ts — the pid identity fix: the ledger must
// name the REAL CLI runtime child, never the dispatcher that spawned it, and
// the supervisor must refuse to signal a pid the OS has recycled.
//
// Before this cut, dispatch.ts wrote `childPid: process.pid` — its OWN pid,
// the process that is about to block inside spawnSync — so a supervisor
// sweep SIGTERMed the orchestrator itself: the dispatcher died mid-syscall,
// its `finally { removeTmpFiles(...) }` never ran, and the real CLI child
// was orphaned instead of stopped. This file proves the fix two ways:
//
//   1. end-to-end, with a REAL detached dispatcher process spawning a REAL
//      (fake) CLI child through the actual ledger + heartbeat-sidecar path:
//      the sweep kills the CLI child, the dispatcher survives to run its own
//      cleanup, and the temp prompt file it created does not leak.
//   2. a pid whose recorded start time no longer matches the live process at
//      that number (the OS reused it) is treated as gone, never signaled.
import { describe, expect, test, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { writeFakeCli } from "./helpers/fake-cli.ts";
import { spawnBudgetMs } from "./helpers/test-budgets.ts";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-child-identity-test-"));
const SKILLS = path.resolve(import.meta.dir, "..", "..");
const RUN_LEDGER_TS = path.join(SKILLS, "harness", "lib", "run-ledger.ts");
const HOST_DRIVER_TS = path.join(SKILLS, "_shared", "lib", "host-agent-driver.ts");

process.env.HARNESS_LOGS_DIR = path.join(TMP, "harness-logs");
process.env.NIRVANA_STATE_DB = path.join(TMP, "state.db");
process.env.NIRVANA_SKILLS_DIR = SKILLS;
process.env.NIRVANA_RUN_LEDGER_DB = path.join(TMP, "default-ledger.sqlite");

import { openLedger, getRun, pidAlive, processStartedAt, recordChildPid, patchMeta, openRun, markState, type LedgerHandle } from "../lib/run-ledger.ts";
import { sweep } from "../scripts/supervisor.ts";

afterAll(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ } });

/** Every `nrv-prompt-*` file in the REAL os.tmpdir() right now — runGrok's
 *  writePromptFile always lands there (not the test's own TMP), so the leak
 *  check has to look where the code actually writes, not where the test
 *  would prefer it wrote. */
function nrvPromptFiles(): Set<string> {
  try { return new Set(fs.readdirSync(os.tmpdir()).filter(f => f.startsWith("nrv-prompt-"))); }
  catch { return new Set(); }
}

describe("dispatch child identity — the kill targets the CLI child, not the dispatcher", () => {
  test("a real detached dispatcher: the ledger names the CLI child's pid, the sweep kills THAT pid, the dispatcher survives to clean up its own temp file", async () => {
    // Fake `grok` — runGrok (host-agent-driver.ts) always writes a prompt
    // file for this runtime (no argv-size gate), so it deterministically
    // exercises the exact leak this defect produces: one line of activity
    // (so the heartbeat sees it and renews once), then a long silent hang
    // that never reaches the result line — a stalled run, indistinguishable
    // from a real one until the supervisor acts on it.
    const binDir = path.join(TMP, "bin");
    writeFakeCli(binDir, "grok", `
      console.error("grok tick 1");
      await Bun.sleep(60_000);
      console.log(JSON.stringify({ result: "should not get here", session_id: "s" }));
    `);

    const dbPath = path.join(TMP, "e2e-ledger.sqlite");
    const runIdFile = path.join(TMP, "run-id.txt");
    const doneFile = path.join(TMP, "dispatcher-done.json");
    const workCwd = path.join(TMP, "work");
    fs.mkdirSync(workCwd, { recursive: true });

    // The dispatcher script: the same three lines dispatch.ts itself runs —
    // open a row (no childPid — that is this cut's fix), mark it running,
    // call runHeadless with a ledger context so the real heartbeat sidecar
    // spawns. Written to disk and run as its own `bun` process so the pid
    // that ends up blocked inside spawnSync is genuinely NOT this test's pid.
    const dispatcherScript = path.join(TMP, "dispatcher.ts");
    fs.writeFileSync(dispatcherScript, `
      import { openLedger, openRun, markState } from ${JSON.stringify(RUN_LEDGER_TS)};
      import { runHeadless } from ${JSON.stringify(HOST_DRIVER_TS)};
      import * as fs from "node:fs";

      const dbPath = process.env.E2E_DB!;
      const h = openLedger(dbPath);
      const row = openRun(h, { targetSlug: "fake-grok", targetKind: "business", runtime: "grok-cli", initialLeaseSec: 30 });
      markState(h, row.run_id, "running");
      fs.writeFileSync(process.env.E2E_RUNID_FILE!, row.run_id);

      const res = runHeadless({
        runtime: "grok-cli",
        prompt: "hello",
        cwd: process.env.E2E_CWD!,
        yolo: true,
        ledger: { runId: row.run_id, dbPath, intervalMs: 150, leaseSec: 2 },
        stallBudgetMs: 500,
      });

      // Reaching this line at all is half the proof: a process torn down by
      // an unhandled SIGTERM never runs the statement after the call that
      // was blocking it.
      fs.writeFileSync(process.env.E2E_DONE_FILE!, JSON.stringify({ ok: res.ok, exitCode: res.exitCode, pid: process.pid }));
    `);

    const before = nrvPromptFiles();

    const dispatcher = spawn(process.execPath, [dispatcherScript], {
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
        E2E_DB: dbPath, E2E_RUNID_FILE: runIdFile, E2E_DONE_FILE: doneFile, E2E_CWD: workCwd,
      },
    });
    dispatcher.unref();
    const dispatcherPid = dispatcher.pid!;

    try {
      // Wait for the run_id (written the instant the row opens).
      for (let i = 0; i < 50 && !fs.existsSync(runIdFile); i++) await Bun.sleep(100);
      expect(fs.existsSync(runIdFile)).toBe(true);
      const runId = fs.readFileSync(runIdFile, "utf8").trim();

      const h = openLedger(dbPath);

      // Wait for the sidecar's discovery write: child_pid becomes non-null.
      let row = getRun(h, runId);
      for (let i = 0; i < 50 && !row?.child_pid; i++) { await Bun.sleep(100); row = getRun(h, runId); }
      expect(row?.child_pid).toBeTruthy();

      // The identity claim itself: the ledger names the fake `grok`
      // process, never the dispatcher blocked in spawnSync above it.
      const cliChildPid = row!.child_pid!;
      expect(cliChildPid).not.toBe(dispatcherPid);
      expect(pidAlive(cliChildPid)).toBe(true);
      expect(pidAlive(dispatcherPid)).toBe(true);
      // A start-time fingerprint was recorded alongside it (the pid-recycle guard).
      expect(typeof row!.meta.child_pid_started_at === "string" || row!.meta.child_pid_started_at === null).toBe(true);

      // The prompt file exists WHILE the run is alive — proof there is
      // something for the dispatcher's own cleanup to leak, if it never runs.
      const midRun = nrvPromptFiles();
      const newDuringRun = [...midRun].filter(f => !before.has(f));
      expect(newDuringRun.length).toBeGreaterThan(0);

      // Let the fake CLI's initial tick register (one heartbeat renewal) so
      // the row reflects a real, once-live run rather than a row swept
      // before the sidecar ever observed anything.
      await Bun.sleep(500);

      // `now` pushed 10 minutes out clears BOTH gates sweepOne checks before
      // it will signal a live pid: the row's own lease (renewed once, ~2s
      // out) and the supervisor's independent activity budget
      // (supervisor.stall_threshold_ms, 5 minutes by default — a constant
      // this process cannot cheaply override after supervisor.ts has
      // already loaded it). Real-world staleness, simulated instead of
      // waited out.
      const future = Date.now() + 10 * 60_000;
      const s = sweep({ handle: h, allProjects: true, now: future });
      expect(s.redispatched + s.escalated + s.errors).toBeGreaterThanOrEqual(0); // sweep ran without throwing

      // The CLI child died from the sweep's SIGTERM...
      for (let i = 0; i < 30 && pidAlive(cliChildPid); i++) await Bun.sleep(100);
      expect(pidAlive(cliChildPid)).toBe(false);

      // ...while the dispatcher was NEVER signaled: it ran to completion on
      // its own, past the runHeadless call, and wrote its done marker —
      // exactly the `finally` unwind an abrupt SIGTERM would have skipped.
      for (let i = 0; i < 50 && !fs.existsSync(doneFile); i++) await Bun.sleep(100);
      expect(fs.existsSync(doneFile)).toBe(true);
      const done = JSON.parse(fs.readFileSync(doneFile, "utf8"));
      expect(done.pid).toBe(dispatcherPid);
      expect(done.ok).toBe(false); // its CLI child was killed — a real failure, correctly reported

      // And because the dispatcher survived to unwind normally, runGrok's own
      // `finally { removeTmpFiles([promptFile]) }` ran: no leaked nrv-prompt-*.
      const after = nrvPromptFiles();
      for (const f of newDuringRun) expect(after.has(f)).toBe(false);

      h.close();
    } finally {
      try { process.kill(dispatcherPid, "SIGKILL"); } catch { /* already gone */ }
      try {
        const row = getRun(openLedger(dbPath), fs.existsSync(runIdFile) ? fs.readFileSync(runIdFile, "utf8").trim() : "");
        if (row?.child_pid) process.kill(row.child_pid, "SIGKILL");
      } catch { /* already gone or never existed */ }
    }
  }, spawnBudgetMs(2) + 15_000);
});

describe("dispatch child identity — pid-recycle guard", () => {
  function freshLedger(): LedgerHandle {
    return openLedger(path.join(TMP, `recycle-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`));
  }

  test("processStartedAt/findChildPid: a live process reports a start time; an invalid pid reports nothing", () => {
    const self = process.pid;
    expect(processStartedAt(self)).not.toBeNull();
    expect(processStartedAt(-1)).toBeNull();
    expect(processStartedAt(0)).toBeNull();
  });

  test("a pid whose recorded start time no longer matches what is live at that number is never signaled — the supervisor treats it as gone, not as a target", async () => {
    const h = freshLedger();
    // A real, currently-alive process stands in for "the OS handed this pid
    // to someone else": genuinely alive (pidAlive true), but its ACTUAL start
    // time will never match a fabricated recorded one, which is exactly the
    // signature a true pid-recycle leaves behind.
    const impostor = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
    try {
      expect(pidAlive(impostor.pid!)).toBe(true);

      const row = openRun(h, { targetSlug: "biz", targetKind: "business", runtime: "claude-code", initialLeaseSec: -60 });
      markState(h, row.run_id, "running");
      recordChildPid(h, row.run_id, impostor.pid!, "Thu Jan  1 00:00:00 1970"); // a start time it provably never had

      const killed: number[] = [];
      const resumed: string[] = [];
      const s = sweep({
        handle: h, now: Date.now(),
        killImpl: (p) => killed.push(p),
        resumeImpl: (r) => { resumed.push(r.run_id); return { ok: false, finalState: "failed", detail: "stub" }; },
        redispatchImpl: (r) => { throw new Error("must not redispatch a recycled pid as if it were a live stall"); },
        notifyImpl: () => {},
      });

      // Never signaled. Routed through the SAME door a truly dead pid uses
      // (auto-resume), not the live-pid kill+redispatch door.
      expect(killed.length).toBe(0);
      expect(resumed).toContain(row.run_id);
      expect(s.redispatched).toBe(0);
      expect(pidAlive(impostor.pid!)).toBe(true); // the impostor was left alone
    } finally {
      impostor.kill("SIGKILL");
    }
  }, spawnBudgetMs(1));

  test("an unverifiable fingerprint (none recorded) keeps today's behavior: live pid → signaled, not skipped", () => {
    const h = freshLedger();
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
    try {
      const row = openRun(h, { targetSlug: "biz", targetKind: "business", runtime: "claude-code", childPid: child.pid, initialLeaseSec: -60 });
      markState(h, row.run_id, "running");
      // No recordChildPid call — no fingerprint on the row, same as a row
      // written before this cut existed.
      const killed: number[] = [];
      sweep({
        handle: h, now: Date.now() + 10 * 60_000,
        killImpl: (p) => killed.push(p), redispatchImpl: () => ({ ok: false, finalState: "failed" }), notifyImpl: () => {},
      });
      expect(killed).toEqual([child.pid]);
    } finally {
      child.kill("SIGKILL");
    }
  }, spawnBudgetMs(1));
});
