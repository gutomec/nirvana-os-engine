// supervisor-quota.test.ts — the sweep waits for a quota reset, and files what
// it does in the swept project's own audit.
//
// 2026-10-14: a sweep resumed a run 16 minutes before the reset its own last
// error named ("try again at 1:21 AM"), burned a retry and withheld it; its
// events went to the global log of the folder the sweep started in, where the
// project's coordinator never looked.
import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { parseAuditLine } from "../../_shared/lib/cloudevents.js";
import { sweep, resumeOutcome, type RecoveryResult } from "../scripts/supervisor.ts";
import { openLedger, openRun, getRun, markState, patchMeta, quotaWaitOf, type RunRow } from "../lib/run-ledger.ts";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-supervisor-quota-"));
afterAll(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ } });

let seq = 0;
const ledger = () => openLedger(path.join(TMP, `ledger-${seq++}.sqlite`));
const deadPid = () => spawnSync(process.execPath, ["-e", "0"], { stdio: "ignore" }).pid!;

/** "h:mm AM" for a local time, the way Codex prints it. */
function clock(at: Date): string {
  const h = at.getHours();
  return `${h % 12 === 0 ? 12 : h % 12}:${String(at.getMinutes()).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}
const quotaMessage = (at: Date) =>
  `You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at ${clock(at)}.`;

function project(): string {
  const dir = fs.mkdtempSync(path.join(TMP, "proj-"));
  fs.mkdirSync(path.join(dir, ".nirvana"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".nirvana", "project.yaml"), "name: p\n");
  return dir;
}

/** The 05:29 → 10:41 row of the incident: verifying, lease expired, dispatcher and worker dead. */
function orphanedOnQuota(h: ReturnType<typeof ledger>, root: string, resetAt: Date): RunRow {
  const row = openRun(h, {
    traceId: "20261014-site-finalizar", projectId: "20261014-site-finalizar", projectRoot: root,
    targetSlug: "design", targetKind: "business", runtime: "codex", childPid: deadPid(), sessionId: "sess",
    initialLeaseSec: -60, meta: { dispatcher_pid: deadPid() },
  });
  markState(h, row.run_id, "running");
  return markState(h, row.run_id, "verifying", { error: quotaMessage(resetAt) });
}

describe("the sweep and a quota stop", () => {
  test("a row stopped on a quota whose reset is ahead is left alone: no resume, no retry, one event per reset", () => {
    const h = ledger();
    const root = project();
    const reset = new Date(Date.now() + 20 * 60_000);
    const row = orphanedOnQuota(h, root, reset);
    const resumed: RunRow[] = [];
    const resumeImpl = (r: RunRow): RecoveryResult => { resumed.push(r); return { ok: true, finalState: "delivered" }; };
    const savedLogs = process.env.HARNESS_LOGS_DIR;
    delete process.env.HARNESS_LOGS_DIR;   // the project's own audit, not the test's global one
    try {
      const s1 = sweep({ handle: h, allProjects: true, resumeImpl, notifyImpl: () => {} });
      const s2 = sweep({ handle: h, allProjects: true, resumeImpl, notifyImpl: () => {} });
      expect(s1.quotaWaiting).toBe(1);
      expect(s2.quotaWaiting).toBe(1);
    } finally { process.env.HARNESS_LOGS_DIR = savedLogs; }
    expect(resumed).toHaveLength(0);
    const after = getRun(h, row.run_id)!;
    expect(after.retries).toBe(0);
    expect(after.state).toBe("verifying");
    const day = new Date().toISOString().slice(0, 10);
    const file = path.join(root, ".nirvana", "logs", "harness", day, "audit.jsonl");
    const events = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(l => parseAuditLine(l));
    const waits = events.filter((e: any) => e.event === "x_ledger_quota_wait");
    expect(waits).toHaveLength(1);
    expect(Math.abs(Date.parse(waits[0].reset_at) - reset.getTime())).toBeLessThan(60_000);
  });

  test("at or after the reset, the run resumes", () => {
    const h = ledger();
    const root = project();
    const reset = new Date(Date.now() + 20 * 60_000);
    const row = orphanedOnQuota(h, root, reset);
    const resumed: RunRow[] = [];
    sweep({ handle: h, allProjects: true, now: reset.getTime() + 5 * 60_000, notifyImpl: () => {}, resumeImpl: (r) => { resumed.push(r); return { ok: true, finalState: "delivered" }; } });
    expect(resumed.map(r => r.run_id)).toEqual([row.run_id]);
    expect(getRun(h, row.run_id)!.retries).toBe(1);
  });

  test("the reset the delivery recorded wins over the text", () => {
    const h = ledger();
    const root = project();
    const row = openRun(h, { projectRoot: root, runtime: "codex", childPid: deadPid(), initialLeaseSec: -60 });
    markState(h, row.run_id, "failed", { error: "anything" });
    const at = new Date(Date.now() + 3600_000).toISOString();
    patchMeta(h, row.run_id, { stop_reason: "quota", quota_reset_at: at, quota_reset_named: true });
    expect(quotaWaitOf(getRun(h, row.run_id)!)).toMatchObject({ resetAt: at, named: true });
    expect(quotaWaitOf(getRun(h, row.run_id)!, Date.parse(at) + 1)).toBeNull();
  });

  test("a revision that stops on quota again reads as a wait, not a failure of the work", () => {
    expect(resumeOutcome(75)).toMatchObject({ ok: false, finalState: "failed" });
    expect(resumeOutcome(75).detail).toContain("quota");
  });
});

describe("a foreground sweep is stoppable", () => {
  // 2026-10-14: the coordinator's `nrv supervisor sweep` held a revision for
  // half an hour; SIGTERM ended the sweep and left the revision and its judge
  // running, and the tree had to be walked by hand.
  // POSIX only: on Windows a SIGTERM sent by another process is TerminateProcess,
  // which no handler can catch. There the user stops a foreground sweep with
  // Ctrl+C, and the console delivers that to every process attached to it,
  // the worker included.
  test.skipIf(process.platform === "win32")("SIGTERM ends the sweep and the worker it started", async () => {
    const { writeFakeCli } = await import("./helpers/fake-cli.ts");
    const { spawn } = await import("node:child_process");
    const { pidAlive } = await import("../lib/run-ledger.ts");
    const root = project();
    const bin = path.join(TMP, "bin-stop");
    const pidFile = path.join(TMP, "worker.pid");
    writeFakeCli(bin, "claude", `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 120000);\n`);
    const db = path.join(TMP, "ledger-stop.sqlite");
    const h = openLedger(db);
    const oroot = path.join(root, "outputs", "p", "deliverables");
    fs.mkdirSync(oroot, { recursive: true });
    fs.writeFileSync(path.join(root, "prompt.md"), "faça a entrega");
    // A stalled run with a live pid: the sweep kills it and redispatches, and
    // the redispatched worker is the fake that never ends.
    const stalled = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], { stdio: "ignore", detached: true });
    stalled.unref();
    const row = openRun(h, {
      projectId: "p", traceId: "p", projectRoot: root, targetKind: "agent-x", runtime: "claude-code", childPid: stalled.pid, initialLeaseSec: -60,
      meta: { prompt_path: path.join(root, "prompt.md"), project_dir: root, project_root: root, outputs_root: oroot },
    });
    markState(h, row.run_id, "running");
    h.db.run("UPDATE runs SET heartbeat_at = ? WHERE run_id = ?", [new Date(Date.now() - 3600_000).toISOString(), row.run_id]);
    const sweeper = spawn(process.execPath, [path.join(import.meta.dir, "..", "scripts", "supervisor.ts"), "sweep", "--all-projects"], {
      cwd: root, stdio: "ignore",
      env: { ...process.env, NIRVANA_RUN_LEDGER_DB: db, PATH: `${bin}${path.delimiter}${process.env.PATH}`, NIRVANA_NO_DESKTOP_NOTIFY: "1", NRV_IN_SWEEP: "" },
    });
    let worker = 0;
    for (let i = 0; i < 300 && !worker; i++) {
      await Bun.sleep(100);
      try { worker = Number(fs.readFileSync(pidFile, "utf8")) || 0; } catch { /* not yet */ }
    }
    expect(worker).toBeGreaterThan(0);
    expect(pidAlive(worker)).toBe(true);
    const exited = new Promise<number | null>((resolve) => sweeper.on("exit", (code) => resolve(code)));
    sweeper.kill("SIGTERM");
    expect(await exited).toBe(0);
    for (let i = 0; i < 50 && pidAlive(worker); i++) await Bun.sleep(100);
    expect(pidAlive(worker)).toBe(false);
    try { process.kill(stalled.pid!, "SIGKILL"); } catch { /* the sweep ended it */ }
  }, 60_000);
});
