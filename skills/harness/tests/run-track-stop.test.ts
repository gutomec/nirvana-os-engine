// run-track-stop.test.ts — `nrv run-track stop` ends a run for good.
//
// Killing a run's processes by hand left its ledger row open; once the lease
// expired the supervisor took it for a crash and resumed it. A Grok run its
// owner had stopped would have come back by itself. stop ends the dispatcher
// and the worker and closes the row, so nothing resumes it.
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { abandon, getRun, markState, openLedger, openRun, patchMeta, pidAlive, processStartedAt, recordChildPid, runProcesses } from "../lib/run-ledger.ts";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-run-stop-"));
const PROJECT = path.join(TMP, "project");
fs.mkdirSync(path.join(PROJECT, ".nirvana"), { recursive: true });
const DB = path.join(TMP, "ledger.sqlite");
const RUN_TRACK = path.resolve(import.meta.dir, "..", "scripts", "run-track.ts");
const started: number[] = [];

afterAll(() => {
  for (const pid of started) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ }
});

/** A sleeping process this test is not the parent of, so a killed one is gone
 *  at once instead of lingering as this process's unreaped child. */
function sleeper(): number {
  const r = spawnSync(process.execPath, ["-e",
    `const c = require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { detached: true, stdio: "ignore" }); c.unref(); console.log(c.pid);`,
  ], { encoding: "utf8" });
  const pid = Number(r.stdout.trim());
  started.push(pid);
  return pid;
}

function stop(target: string) {
  return spawnSync(process.execPath, [RUN_TRACK, "stop", target], {
    cwd: PROJECT, encoding: "utf8",
    env: { ...process.env, NIRVANA_RUN_LEDGER_DB: DB, NIRVANA_PROJECT_ROOT: PROJECT, NIRVANA_NO_DESKTOP_NOTIFY: "1" },
  });
}

function openWith(projectId: string, dispatcher: number, worker: number, dispatcherStartedAt?: string) {
  const h = openLedger(DB);
  const row = openRun(h, {
    projectId, traceId: projectId, projectRoot: PROJECT, targetSlug: "awwwards", targetKind: "squad", runtime: "grok-cli",
    meta: { dispatcher_pid: dispatcher, dispatcher_started_at: dispatcherStartedAt ?? processStartedAt(dispatcher) },
  });
  recordChildPid(h, row.run_id, worker, processStartedAt(worker));
  return { h, runId: row.run_id };
}

async function gone(pid: number): Promise<boolean> {
  const deadline = Date.now() + 5_000;
  while (pidAlive(pid) && Date.now() < deadline) await Bun.sleep(50);
  return !pidAlive(pid);
}

describe("nrv run-track stop", () => {
  test("ends the dispatcher and the worker, and closes the run so nothing resumes it", async () => {
    const dispatcher = sleeper(), worker = sleeper();
    const { h, runId } = openWith("landing-a", dispatcher, worker);
    const r = stop(runId);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`${runId} stopped`);
    expect(await gone(dispatcher)).toBe(true);
    expect(await gone(worker)).toBe(true);
    const row = getRun(h, runId)!;
    expect(row.state).toBe("abandoned");
    expect(row.last_error).toBe("stopped by the user");
  }, 30_000);

  test("a project id stops every open run of that project and leaves the closed ones alone", async () => {
    const a = openWith("landing-b", sleeper(), sleeper());
    const b = openWith("landing-b", sleeper(), sleeper());
    const closed = openWith("landing-b", sleeper(), sleeper());
    abandon(closed.h, closed.runId, "earlier");
    const r = stop("landing-b");
    expect(r.status).toBe(0);
    expect(getRun(a.h, a.runId)!.state).toBe("abandoned");
    expect(getRun(b.h, b.runId)!.state).toBe("abandoned");
    expect(getRun(closed.h, closed.runId)!.last_error).toBe("earlier");
  }, 30_000);

  test("a dispatcher pid now held by another process is not signalled", async () => {
    const stranger = sleeper(), worker = sleeper();
    const { h, runId } = openWith("landing-c", stranger, worker, "Mon Jan  1 00:00:00 2001");
    expect(stop(runId).status).toBe(0);
    expect(await gone(worker)).toBe(true);
    expect(pidAlive(stranger)).toBe(true);
    expect(getRun(h, runId)!.state).toBe("abandoned");
  }, 30_000);

  // The report that found it: `stop` said "ended pid 38702" and the claude
  // worker, a grandchild of the dispatcher in a process group of its own,
  // kept running and spending until it was killed by hand.
  test.skipIf(process.platform === "win32")("a worker the dispatcher started as a grandchild in its own group is ended too", async () => {
    const pidFile = path.join(TMP, `grandchild-${Date.now()}.pid`);
    const grandchildScript = `const w = require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { detached: true, stdio: "ignore" }); require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(w.pid)); setTimeout(() => {}, 60000);`;
    const r = spawnSync(process.execPath, ["-e",
      `const c = require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(grandchildScript)}], { detached: true, stdio: "ignore" }); c.unref(); console.log(c.pid);`,
    ], { encoding: "utf8" });
    const dispatcher = Number(r.stdout.trim());
    started.push(dispatcher);
    const deadline = Date.now() + 5_000;
    while (!fs.existsSync(pidFile) && Date.now() < deadline) await Bun.sleep(50);
    const grandchild = Number(fs.readFileSync(pidFile, "utf8"));
    started.push(grandchild);
    const { h, runId } = openWith("landing-d", dispatcher, sleeper());
    const out = stop(runId);
    expect(out.status).toBe(0);
    expect(await gone(dispatcher)).toBe(true);
    expect(await gone(grandchild)).toBe(true);
    expect(getRun(h, runId)!.state).toBe("abandoned");
  }, 30_000);

  test("nothing open: says so and changes nothing", () => {
    const r = stop("no-such-project");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("nothing to stop");
  });
});

describe("nrv run-track status", () => {
  const status = (runId: string, extraEnv: Record<string, string> = {}) => spawnSync(process.execPath, [RUN_TRACK, "status", runId, "--json"], {
    cwd: PROJECT, encoding: "utf8",
    env: { ...process.env, NIRVANA_RUN_LEDGER_DB: DB, NIRVANA_PROJECT_ROOT: PROJECT, NIRVANA_NO_DESKTOP_NOTIFY: "1", ...extraEnv },
  });
  const deadPid = async () => { const pid = sleeper(); process.kill(pid, "SIGKILL"); await gone(pid); return pid; };

  // The report: status said killed while the dispatcher and its claude worker
  // kept working, because the recorded worker pid was a launcher that had exited.
  test("a dead worker pid with the dispatcher alive is not killed", async () => {
    const { runId } = openWith("status-a", sleeper(), sleeper());
    const h = openLedger(DB);
    recordChildPid(h, runId, await deadPid(), null);
    const out = status(runId);
    expect(JSON.parse(out.stdout).state).toBe("dispatched");  // the row's own state, never "killed"
  }, 30_000);

  test("with the dispatcher gone too, it is killed", async () => {
    const { runId } = openWith("status-b", await deadPid(), sleeper());
    const h = openLedger(DB);
    recordChildPid(h, runId, await deadPid(), null);
    expect(JSON.parse(status(runId).stdout).state).toBe("killed");
  }, 30_000);

  // 2026-10-14: a `verifying` row whose dispatcher had died five hours earlier
  // read as `verifying`, with an ended_at, its usage-limit error in `error`.
  test("a working row nobody drives any more is stale, and has no ended_at", async () => {
    const { h, runId } = openWith("status-c", await deadPid(), await deadPid());
    markState(h, runId, "running");
    markState(h, runId, "verifying", { error: "gate crashed" });
    const out = JSON.parse(status(runId).stdout);
    expect(out.state).toBe("stale");
    expect(out.ledger_state).toBe("verifying");
    expect(out.ended_at).toBeNull();
    expect(out.dispatcher_alive).toBe(false);
  }, 30_000);

  test("the same row stopped on a quota reads quota_wait, with retry_at, exit 75", async () => {
    const { h, runId } = openWith("status-d", await deadPid(), await deadPid());
    const reset = new Date(Date.now() + 2 * 3600_000);
    const hh = reset.getUTCHours();
    const clock = `${hh % 12 === 0 ? 12 : hh % 12}:${String(reset.getUTCMinutes()).padStart(2, "0")} ${hh < 12 ? "AM" : "PM"}`;
    markState(h, runId, "running");
    markState(h, runId, "verifying", { error: `You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at ${clock}.` });
    // TZ pinned: a reset with no date is read in local time, and the test writes it in UTC.
    const r = status(runId, { TZ: "UTC" });
    expect(r.status).toBe(75);
    const out = JSON.parse(r.stdout);
    expect(out.state).toBe("quota_wait");
    expect(out.ended_at).toBeNull();
    expect(Math.abs(Date.parse(out.retry_at) - reset.getTime())).toBeLessThan(60_000);
  }, 30_000);
});

describe("nrv run-track stop with stale pids", () => {
  // The row named a dispatcher dead since hours; the sweep's revise for the
  // run kept judging, and stop printed "stopped (no live process)".
  test("a revise started for the run is found by its command line and ended", async () => {
    const trace = `stale-${Date.now()}`;
    const fakeRevise = path.join(TMP, "revise.ts");
    fs.writeFileSync(fakeRevise, "setTimeout(() => {}, 60000);\n");
    const r0 = spawnSync(process.execPath, ["-e",
      `const c = require("node:child_process").spawn(process.execPath, [${JSON.stringify(fakeRevise)}, ${JSON.stringify(trace)}, "continue"], { detached: true, stdio: "ignore" }); c.unref(); console.log(c.pid);`,
    ], { encoding: "utf8" });
    const revisePid = Number(r0.stdout.trim());
    started.push(revisePid);
    expect(pidAlive(revisePid)).toBe(true);
    const deadDispatcher = sleeper();
    process.kill(deadDispatcher, "SIGKILL");
    await gone(deadDispatcher);
    const h = openLedger(DB);
    const row = openRun(h, { projectId: trace, traceId: trace, projectRoot: PROJECT, targetKind: "business", runtime: "codex",
      meta: { dispatcher_pid: deadDispatcher } });
    markState(h, row.run_id, "running");
    markState(h, row.run_id, "verifying");
    const r = stop(row.run_id);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(String(revisePid));
    expect(r.stdout).not.toContain("no live process");
    expect(await gone(revisePid)).toBe(true);
    expect(getRun(h, row.run_id)!.state).toBe("abandoned");
  }, 30_000);
});

describe("run-track stop reaches a run's processes when its pids are stale", () => {
  test("a revise for the run's trace, and the sweep recovering it, are found by what they run", () => {
    const h = openLedger(path.join(TMP, "ledger-procs.sqlite"));
    const row = openRun(h, { traceId: "20261014-site-finalizar", projectId: "20261014-site-finalizar", runtime: "codex" });
    const table = [
      { pid: 56705, ppid: 56702, command: `/Users/x/.bun/bin/bun /Users/x/.nirvana/skills/harness/scripts/revise.ts 20261014-site-finalizar The previous autonomous run… --no-color` },
      { pid: 56706, ppid: 1, command: `bun revise.ts 20261014-site-finalizar-2 "x"` },
      { pid: 56707, ppid: 1, command: `bun dispatch.ts 20261014-site-finalizar` },
    ];
    expect(runProcesses(row, table)).toEqual([56705]);
    // A sweep marks the row while it recovers it; a live one is part of the run.
    patchMeta(h, row.run_id, { recovering: true, recovered_by_pid: 2_147_483_000 });
    expect(runProcesses(getRun(h, row.run_id)!, [])).toEqual([]);
  });
});
