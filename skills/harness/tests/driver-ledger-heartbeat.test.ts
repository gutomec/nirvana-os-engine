// driver-ledger-heartbeat.test.ts — the runHeadless lease/heartbeat contract:
// renews on activity, stops on stall, default 45-min timeout for ledgered
// runs, and no dangling sidecar after every exit path. The "child" is a fake
// `claude` executable (bash) that prints then sleeps — no real runtime spawned.
import { parseAuditLine } from "../../_shared/lib/cloudevents.js";
import { describe, expect, test, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writeFakeCli } from "./helpers/fake-cli.ts";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-driver-hb-test-"));
process.env.HARNESS_LOGS_DIR = path.join(TMP, "harness-logs");
process.env.NIRVANA_STATE_DB = path.join(TMP, "state.db");
process.env.NIRVANA_SKILLS_DIR = path.resolve(import.meta.dir, "..", "..");
process.env.NIRVANA_RUN_LEDGER_DB = path.join(TMP, "ledger.sqlite");

import { runHeadless, resolveLedgerTimeoutMs, LEDGER_DEFAULT_TIMEOUT_MS } from "../lib/host-agent-driver.ts";
import { openLedger, openRun, getRun, markState, pidAlive } from "../lib/run-ledger.ts";

const DB = path.join(TMP, "ledger.sqlite");

// Fake `claude` on PATH: activity ticks on stderr (0s, 0.4s, 0.8s), then a
// silent stall, then the final result JSON on stdout. The stall (4s) against
// the 1.2s budget the stall test below configures leaves ~2.8s of slack — a
// loaded Windows runner's scheduling jitter has room to delay several 250ms
// polls in a row and the stall still gets noticed before the process exits.
const FAKE_BIN = path.join(TMP, "bin");
fs.mkdirSync(FAKE_BIN, { recursive: true });
writeFakeCli(FAKE_BIN, "claude", `
  console.error("tick 1");
  await Bun.sleep(400);
  console.error("tick 2");
  await Bun.sleep(400);
  console.error("tick 3");
  await Bun.sleep(4000);
  console.log(JSON.stringify({ type: "result", result: "done", session_id: "fake-session-123", total_cost_usd: 0.01 }));
  // Exit immediately after the write, as the bash original did — it keeps the
  // fake's shape tight. It is no longer load-bearing: the assertion that used to
  // race against this teardown was measuring the wrong thing and is gone (see
  // the stall check below). Renewing on the final write is correct behaviour, so
  // no amount of exiting sooner would have fixed it.
  process.exit(0);
`);
const ORIGINAL_PATH = process.env.PATH;
// path.delimiter, not ":" — Windows separates PATH entries with ";".
process.env.PATH = `${FAKE_BIN}${path.delimiter}${ORIGINAL_PATH}`;

afterAll(() => {
  process.env.PATH = ORIGINAL_PATH;
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ }
});

function readAuditEvents(): Array<Record<string, unknown>> {
  const root = process.env.HARNESS_LOGS_DIR!;
  const out: Array<Record<string, unknown>> = [];
  if (!fs.existsSync(root)) return out;
  for (const day of fs.readdirSync(root)) {
    const f = path.join(root, day, "audit.jsonl");
    if (!fs.existsSync(f)) continue;
    for (const line of fs.readFileSync(f, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try { out.push(parseAuditLine(line)); } catch { /* skip */ }
    }
  }
  return out;
}

describe("driver — ledger default timeout", () => {
  test("explicit timeoutMs always wins; ledgered runs default to a 7-day backstop; unledgered stay uncapped", () => {
    expect(resolveLedgerTimeoutMs({ timeoutMs: 1234, ledger: { runId: "x" } })).toBe(1234);
    expect(resolveLedgerTimeoutMs({ ledger: { runId: "x" } })).toBe(LEDGER_DEFAULT_TIMEOUT_MS);
    // A BACKSTOP, above the work rather than inside it: hangs are caught by the
    // lease expiring after the last sign of life, not by the clock. 24h used to
    // sit BELOW this machine's longest ledgered run (25.5h) — a ceiling under
    // the observed maximum kills finished work instead of catching a runaway.
    expect(LEDGER_DEFAULT_TIMEOUT_MS).toBe(7 * 24 * 60 * 60_000);
    expect(resolveLedgerTimeoutMs({})).toBeUndefined();
  });
});

describe("driver — heartbeat sidecar", () => {
  test("renews the lease on activity, stops on stall, cleans up promptly", () => {
    const h = openLedger(DB);
    const row = openRun(h, { targetSlug: "fake", targetKind: "business", runtime: "claude-code", initialLeaseSec: 5 });
    const t0 = Date.parse(row.heartbeat_at!);
    const leaseBefore = Date.parse(row.lease_expires_at!);

    const res = runHeadless({
      runtime: "claude-code",
      prompt: "hello",
      cwd: TMP,
      yolo: true,
      ledger: { runId: row.run_id, dbPath: DB, intervalMs: 250, leaseSec: 120 },
      stallBudgetMs: 1200,
    });

    // Result round-trips through the capture files (fd-redirected stdio).
    expect(res.ok).toBe(true);
    expect(res.sessionId).toBe("fake-session-123");
    expect(res.result).toBe("done");
    expect(res.costUsd).toBe(0.01);

    const after = getRun(h, row.run_id)!;
    // Renewed at least once during the active phase (stderr ticks).
    expect(Date.parse(after.heartbeat_at!)).toBeGreaterThan(t0);
    expect(Date.parse(after.lease_expires_at!)).toBeGreaterThan(leaseBefore);
    // "Stopped renewing during the stall" is asserted through the audit event,
    // not through the freshness of heartbeat_at at the moment the test looks.
    //
    // A previous version checked `Date.now() - heartbeat_at >= 1200` and flaked
    // on CI roughly one run in three (macOS and Windows both). It was asserting
    // something the design contradicts: the sidecar renews on ANY new output,
    // and the child's final result JSON is new output. Whether the heartbeat
    // looks stale depends on where the 250ms poll happens to land relative to
    // that last write — and killing the child sooner does not help, because the
    // bytes are already in the capture file by then. Renewing on the final write
    // is correct behaviour, so the assertion was wrong, not the timing.
    //
    // The event proves the property outright: the sidecar emits it once
    // (`stallRecorded` guard) with the measured gap, and 2.2s of silence against
    // a 1.2s budget gives it ~8 polls to notice. Nothing to race.
    const stallEvents = readAuditEvents().filter(e => e.event === "x_ledger_stall_observed" && e.run_id === row.run_id);
    expect(stallEvents.length).toBeGreaterThanOrEqual(1);
    expect(Number(stallEvents[0].gap_ms)).toBeGreaterThanOrEqual(1200);
    // And it recorded WHICH heartbeat went stale, so the link between the stall
    // and the lease is still covered.
    expect(typeof stallEvents[0].heartbeat_at).toBe("string");

    // No dangling sidecar (the managed equivalent of "all timers cleared"):
    // give the SIGTERM/sentinel a moment, then look for the run id in ps.
    Bun.sleepSync(400);
    const pg = spawnSync("pgrep", ["-f", row.run_id], { encoding: "utf8" });
    expect((pg.stdout || "").trim()).toBe("");
  }, 20_000);

  test("unledgered calls keep byte-for-byte legacy behavior (pipes, no sidecar)", () => {
    const res = runHeadless({ runtime: "claude-code", prompt: "hi", cwd: TMP, yolo: true, timeoutMs: 10_000 });
    expect(res.ok).toBe(true);
    expect(res.sessionId).toBe("fake-session-123");
    expect(res.result).toBe("done");
  }, 20_000);
});

// ── the sidecar NAMES what it saw ────────────────────────────────────────
//
// The defect this covers, measured on 2026-08-27 (trace 70341260): a squad ran
// 418s on Codex and wrote 113 files, and the audit held sixteen events, eleven
// of them a content-free `x_ledger_lease_renewed`. The sidecar was already
// sweeping the outputs root every tick to answer "alive?"; it threw away WHICH
// files moved. The Glance has consumed `artifact_touched` all along.

/** A second fake `claude`, in its own bin dir, so the module-level fake above
 *  keeps its exact behaviour for the tests that already depend on it. */
function withWritingFake<T>(name: string, body: string, run: () => T): T {
  const bin = path.join(TMP, `bin-${name}`);
  writeFakeCli(bin, "claude", body);
  const saved = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${saved}`;
  try { return run(); } finally { process.env.PATH = saved; }
}

function touchEvents(runId: string): Array<Record<string, unknown>> {
  return readAuditEvents().filter(e => e.event === "artifact_touched" && e.run_id === runId);
}

/**
 * The orphan probe. Poke the watched directory AFTER the dispatch returned and
 * prove nobody answers: a live sidecar would renew the lease and append an
 * `artifact_touched`; a dead one leaves both exactly where they were. The run
 * row is deliberately left non-terminal, so "the sidecar is gone" can only be
 * explained by the parent's teardown.
 */
function proveNoOrphan(handle: ReturnType<typeof openLedger>, runId: string, watchDir: string, intervalMs: number): void {
  Bun.sleepSync(intervalMs * 2);
  const before = getRun(handle, runId)!;
  const touchesBefore = touchEvents(runId).length;
  expect(isTerminalState(before.state)).toBe(false);
  fs.writeFileSync(path.join(watchDir, "poke-after-the-run-ended.md"), "anybody home?", "utf8");
  Bun.sleepSync(intervalMs * 5);
  expect(getRun(handle, runId)!.heartbeat_at).toBe(before.heartbeat_at);
  expect(touchEvents(runId).length).toBe(touchesBefore);
}

const isTerminalState = (s: string): boolean => ["delivered", "withheld", "abandoned"].includes(s);

describe("driver — the heartbeat reports files, not just liveness", () => {
  test("every file the child writes is named in an artifact_touched; noise never is", () => {
    const h = openLedger(DB);
    const row = openRun(h, { traceId: "trace-touch", projectId: "proj-touch", targetSlug: "fake", targetKind: "squad", initialLeaseSec: 120 });
    const watch = path.join(TMP, "watch-happy");
    fs.mkdirSync(watch, { recursive: true });

    const res = withWritingFake("touch", `
      import * as fs from "node:fs";
      import * as path from "node:path";
      const dir = ${JSON.stringify(watch)};
      fs.mkdirSync(path.join(dir, "node_modules", "pkg"), { recursive: true });
      for (const name of ["step-1.md", "step-2.md", "step-3.md"]) {
        await Bun.sleep(400);
        fs.writeFileSync(path.join(dir, name), "content of " + name);
        fs.writeFileSync(path.join(dir, "node_modules", "pkg", name + ".js"), "vendored noise");
      }
      await Bun.sleep(900);
      console.log(JSON.stringify({ type: "result", result: "done", session_id: "touch-session", total_cost_usd: 0 }));
      process.exit(0);
    `, () => runHeadless({
      runtime: "claude-code", prompt: "write three files", cwd: TMP, yolo: true,
      ledger: { runId: row.run_id, dbPath: DB, intervalMs: 250, leaseSec: 120, watchDir: watch, touchEventsMax: 100 },
    }));
    expect(res.ok).toBe(true);

    const named = touchEvents(row.run_id).map(e => path.basename(String(e.file_path)));
    expect(named).toContain("step-1.md");
    expect(named).toContain("step-2.md");
    expect(named).toContain("step-3.md");
    expect(named.some(n => n.endsWith(".js"))).toBe(false);
    const first = touchEvents(row.run_id)[0];
    expect(first.trace_id).toBe("trace-touch");
    expect(first.action).toBe("modify");
    expect(Number(first.size_bytes)).toBeGreaterThan(0);
    expect(first.source).toBe("ledger-heartbeat");

    proveNoOrphan(h, row.run_id, watch, 250);
  }, 30_000);

  test("touchEventsMax 0 keeps the old event stream: liveness renewed, nothing named", () => {
    const h = openLedger(DB);
    const row = openRun(h, { traceId: "trace-off", targetSlug: "fake", targetKind: "squad", initialLeaseSec: 120 });
    const watch = path.join(TMP, "watch-off");
    fs.mkdirSync(watch, { recursive: true });
    const lease = Date.parse(row.lease_expires_at!);

    const res = withWritingFake("off", `
      import * as fs from "node:fs";
      import * as path from "node:path";
      for (const name of ["a.md", "b.md"]) { await Bun.sleep(400); fs.writeFileSync(path.join(${JSON.stringify(watch)}, name), name); }
      await Bun.sleep(600);
      console.log(JSON.stringify({ type: "result", result: "done", session_id: "off-session", total_cost_usd: 0 }));
      process.exit(0);
    `, () => runHeadless({
      runtime: "claude-code", prompt: "write two files", cwd: TMP, yolo: true,
      ledger: { runId: row.run_id, dbPath: DB, intervalMs: 250, leaseSec: 120, watchDir: watch, touchEventsMax: 0 },
    }));
    expect(res.ok).toBe(true);
    expect(touchEvents(row.run_id)).toEqual([]);
    // The switch silences the REPORT, never the liveness the supervisor reads.
    expect(Date.parse(getRun(h, row.run_id)!.lease_expires_at!)).toBeGreaterThan(lease);
  }, 30_000);

  test("a run that FAILS leaves no sidecar behind either", () => {
    const h = openLedger(DB);
    const row = openRun(h, { traceId: "trace-fail", targetSlug: "fake", targetKind: "squad", initialLeaseSec: 120 });
    const watch = path.join(TMP, "watch-fail");
    fs.mkdirSync(watch, { recursive: true });

    // The gap between the write and the exit is the ONLY window a poll can
    // land in — the parent SIGTERMs the sidecar the instant this process
    // exits (see host-agent-driver.ts's runWithLedgerHeartbeat), with no
    // grace period. 400ms left room for at most one 250ms tick, which a
    // loaded Windows runner (slower process scheduling, occasionally a
    // stretched sleepSync) can miss outright. A wide window turns "exactly
    // one poll must land just right" into "several get the chance to".
    const res = withWritingFake("fail", `
      import * as fs from "node:fs";
      import * as path from "node:path";
      await Bun.sleep(400);
      fs.writeFileSync(path.join(${JSON.stringify(watch)}, "half-written.md"), "the run dies here");
      await Bun.sleep(2000);
      process.stderr.write("boom\\n");
      process.exit(1);
    `, () => runHeadless({
      runtime: "claude-code", prompt: "fail halfway", cwd: TMP, yolo: true,
      ledger: { runId: row.run_id, dbPath: DB, intervalMs: 250, leaseSec: 120, watchDir: watch, touchEventsMax: 100 },
    }));
    expect(res.ok).toBe(false);
    // It reported the work the run DID do before dying — evidence survives failure.
    expect(touchEvents(row.run_id).map(e => path.basename(String(e.file_path)))).toContain("half-written.md");
    proveNoOrphan(h, row.run_id, watch, 250);
  }, 30_000);
});

// ── the sidecar's own exit conditions, without a cooperative parent ──────
//
// The two paths above are torn down by a parent that reaches its `finally`.
// A watcher whose only exit is a signal from a parent that never sends one is
// worse than no watcher, so these spawn the sidecar directly and take the
// parent's cooperation away.

const RUN_LEDGER = path.resolve(import.meta.dir, "..", "lib", "run-ledger.ts");
const sidecars: ChildProcess[] = [];

/** Spawned the way the driver spawns it (detached, stdio ignored). NOT
 *  unref'd, and observed through the `exit` event rather than the pid: a
 *  detached child of a process that is still running stays a zombie until it
 *  is reaped, and a zombie answers `kill(pid, 0)` — polling the pid would
 *  report every one of these as alive forever. */
function spawnSidecar(runId: string, extra: string[]): ChildProcess {
  const child = spawn(process.execPath, [
    RUN_LEDGER, "heartbeat", "--run-id", runId, "--db", DB,
    "--interval", "200", "--lease", "120", ...extra,
  ], { detached: true, stdio: "ignore", env: { ...process.env } });
  sidecars.push(child);
  return child;
}

const stillRunning = (c: ChildProcess): boolean => c.exitCode === null && c.signalCode === null;

function exitedWithin(child: ChildProcess, ms: number): Promise<boolean> {
  if (!stillRunning(child)) return Promise.resolve(true);
  return new Promise<boolean>(resolve => {
    const timer = setTimeout(() => resolve(false), ms);
    child.once("exit", () => { clearTimeout(timer); resolve(true); });
  });
}

afterAll(() => {
  for (const c of sidecars) { try { if (stillRunning(c)) c.kill("SIGKILL"); } catch { /* already gone */ } }
});

describe("driver — the sidecar dies on its own", () => {
  test("the parent is SIGKILLed mid-run: no sentinel, no SIGTERM, and the sidecar still exits", async () => {
    const h = openLedger(DB);
    const row = openRun(h, { targetSlug: "fake", targetKind: "squad", initialLeaseSec: 300 });
    // A stand-in parent that will never write a done file and never signal.
    const parent = spawn(process.execPath, ["-e", "await Bun.sleep(60000)"], { detached: true, stdio: "ignore" });
    const sidecar = spawnSidecar(row.run_id, ["--parent", String(parent.pid)]);
    await Bun.sleep(700);
    expect(stillRunning(sidecar)).toBe(true);          // it really was running

    parent.kill("SIGKILL");
    expect(await exitedWithin(sidecar, 8_000)).toBe(true);
    // The RUN outlives its watcher: losing observability must never terminate work.
    expect(isTerminalState(getRun(h, row.run_id)!.state)).toBe(false);
  }, 30_000);

  test("the run reaching a terminal state ends the sidecar even with the parent still alive", async () => {
    const h = openLedger(DB);
    const row = openRun(h, { targetSlug: "fake", targetKind: "squad", initialLeaseSec: 300 });
    const sidecar = spawnSidecar(row.run_id, ["--parent", String(process.pid)]);
    await Bun.sleep(700);
    expect(stillRunning(sidecar)).toBe(true);

    markState(h, row.run_id, "running");
    markState(h, row.run_id, "delivered");
    expect(await exitedWithin(sidecar, 8_000)).toBe(true);
  }, 30_000);

  test("the done sentinel ends it, and a run row that never existed ends it immediately", async () => {
    const h = openLedger(DB);
    const row = openRun(h, { targetSlug: "fake", targetKind: "squad", initialLeaseSec: 300 });
    const done = path.join(TMP, "done-sentinel");
    const sidecar = spawnSidecar(row.run_id, ["--parent", String(process.pid), "--done", done]);
    await Bun.sleep(700);
    expect(stillRunning(sidecar)).toBe(true);
    fs.writeFileSync(done, "done", "utf8");
    expect(await exitedWithin(sidecar, 8_000)).toBe(true);

    expect(await exitedWithin(spawnSidecar("run-that-never-existed", ["--parent", String(process.pid)]), 8_000)).toBe(true);
  }, 30_000);
});
