// run-completion-signal.test.ts — a dispatch that finishes tells the runtime
// that started it, without the caller polling the process table.
//
// The gap: `nrv dispatch --exec` already lands every run on a ledger row
// (delivered/withheld/failed/abandoned), but nothing outside that row ever
// learns the decision. A caller that backgrounds the dispatch with
// `nohup … &` and returns has no door to ask "is trace X done?" once the run
// leaves the ACTIVE_STATES the existing `run-track list` / `supervisor
// status` show — a terminal row simply stops appearing anywhere.
//
// The fix: markState() mirrors every terminal-ish decision into a small
// sentinel file next to the ledger DB (`writeRunSignal`, exercised here
// indirectly through the file it produces), and `nrv run-track status|wait`
// read it back — `status` for a one-shot check (works by run_id OR trace_id,
// covers terminal rows the old commands hid), `wait` for a blocking caller
// that gets woken by an fs.watch event on the sentinel directory rather than
// a sleep-and-poll loop.
import { describe, expect, test, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-run-signal-"));
const SKILLS = path.resolve(import.meta.dir, "..", "..");

const ENV_BEFORE = {
  HARNESS_LOGS_DIR: process.env.HARNESS_LOGS_DIR,
  NIRVANA_STATE_DB: process.env.NIRVANA_STATE_DB,
  NIRVANA_SKILLS_DIR: process.env.NIRVANA_SKILLS_DIR,
  NIRVANA_RUN_LEDGER_DB: process.env.NIRVANA_RUN_LEDGER_DB,
  NIRVANA_NO_DESKTOP_NOTIFY: process.env.NIRVANA_NO_DESKTOP_NOTIFY,
};
process.env.HARNESS_LOGS_DIR = path.join(TMP, "harness-logs");
process.env.NIRVANA_STATE_DB = path.join(TMP, "state.db");
process.env.NIRVANA_SKILLS_DIR = SKILLS;
process.env.NIRVANA_RUN_LEDGER_DB = path.join(TMP, "default-ledger.sqlite");
process.env.NIRVANA_NO_DESKTOP_NOTIFY = "1";

import {
  openLedger, openRun, getRun, markState, findByTraceId, runSignalPath, runSignalDir,
  type LedgerHandle,
} from "../lib/run-ledger.ts";
import { spawnBudgetMs } from "./helpers/test-budgets.ts";

let dbSeq = 0;
function freshLedger(): LedgerHandle {
  return openLedger(path.join(TMP, `sig-case-${dbSeq++}.sqlite`));
}

afterAll(() => {
  for (const [k, v] of Object.entries(ENV_BEFORE)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ }
});

// ── 1. the sentinel file itself ────────────────────────────────────────────

describe("run-ledger — done sentinel", () => {
  test("a delivered run writes a sentinel carrying trace, state, outputs and when", () => {
    const h = freshLedger();
    const { run_id } = openRun(h, { traceId: "trace-ok-1", projectId: "p1", targetSlug: "biz", targetKind: "business", meta: { outputs_root: "/tmp/out-1" } });
    markState(h, run_id, "running");
    markState(h, run_id, "gated");
    markState(h, run_id, "delivered");

    const sigPath = runSignalPath(run_id);
    expect(fs.existsSync(sigPath)).toBe(true);
    const signal = JSON.parse(fs.readFileSync(sigPath, "utf8"));
    expect(signal.run_id).toBe(run_id);
    expect(signal.trace_id).toBe("trace-ok-1");
    expect(signal.state).toBe("delivered");
    expect(signal.outputs_root).toBe("/tmp/out-1");
    expect(typeof signal.ended_at).toBe("string");
    expect(Date.parse(signal.ended_at)).toBeGreaterThan(0);
  });

  test("a withheld run and a failed run write sentinels too — not only the success path", () => {
    const h = freshLedger();

    const w = openRun(h, { traceId: "trace-withheld", meta: {} });
    markState(h, w.run_id, "running");
    markState(h, w.run_id, "gated");
    markState(h, w.run_id, "withheld", { error: "gate failed" });
    const wSignal = JSON.parse(fs.readFileSync(runSignalPath(w.run_id), "utf8"));
    expect(wSignal.state).toBe("withheld");
    expect(wSignal.error).toBe("gate failed");

    const f = openRun(h, { traceId: "trace-failed", meta: {} });
    markState(h, f.run_id, "running");
    markState(h, f.run_id, "failed", { error: "runtime crashed" });
    const fSignal = JSON.parse(fs.readFileSync(runSignalPath(f.run_id), "utf8"));
    expect(fSignal.state).toBe("failed");
    expect(fSignal.error).toBe("runtime crashed");
  });

  test("intermediate states write no sentinel — only a real decision does", () => {
    const h = freshLedger();
    const { run_id } = openRun(h, { traceId: "trace-mid", meta: {} });
    markState(h, run_id, "running");
    markState(h, run_id, "verifying");
    markState(h, run_id, "gated");
    expect(fs.existsSync(runSignalPath(run_id))).toBe(false);
  });

  test("findByTraceId resolves the most recent row for a trace, null when unknown", () => {
    const h = freshLedger();
    const a = openRun(h, { traceId: "shared-trace", meta: {} });
    markState(h, a.run_id, "running");
    markState(h, a.run_id, "failed", { error: "first attempt died" });
    // A later attempt under the SAME trace (a resumed run) — the newest wins.
    const b = openRun(h, { traceId: "shared-trace", meta: {} });
    markState(h, b.run_id, "running");
    markState(h, b.run_id, "delivered");

    const found = findByTraceId(h, "shared-trace")!;
    expect(found.run_id).toBe(b.run_id);
    expect(found.state).toBe("delivered");
    expect(findByTraceId(h, "no-such-trace")).toBeNull();
  });
});

// ── 2. `nrv run-track status` — the query a reconnecting caller uses ──────

describe("nrv run-track status", () => {
  const db = path.join(TMP, "status.sqlite");
  const env = { ...process.env, NIRVANA_RUN_LEDGER_DB: db, NIRVANA_SKILLS_DIR: SKILLS };
  const runTrack = (args: string[]) =>
    spawnSync(process.execPath, [path.join(SKILLS, "harness", "scripts", "run-track.ts"), ...args], { encoding: "utf8", env });

  test("a live run reports its current (non-final) state, not an absence", () => {
    const outputs = path.join(TMP, "status-live-outputs");
    fs.mkdirSync(outputs, { recursive: true });
    const runId = runTrack(["open", "--target", "biz-a", "--kind", "business", "--project", "p-status-live", "--outputs", outputs, "--trace", "t-live"]).stdout.trim();

    const r = runTrack(["status", runId]);
    expect(r.stdout).toContain("running");
    expect(r.status).not.toBe(0);
    expect([2, 1, 5]).not.toContain(r.status);   // not mistaken for any terminal outcome

    // Same answer by trace_id — a reconnecting caller rarely kept the generated run_id.
    const byTrace = runTrack(["status", "t-live"]);
    expect(byTrace.stdout).toContain(runId.length ? "running" : "");
    expect(byTrace.stdout).toContain("running");
  }, spawnBudgetMs(3));

  test("delivered / withheld / failed each get their own exit code and survive being asked about later", () => {
    const outputs = path.join(TMP, "status-outputs");
    fs.mkdirSync(outputs, { recursive: true });

    const okId = runTrack(["open", "--target", "biz-b", "--kind", "business", "--project", "p-status-ok", "--outputs", outputs]).stdout.trim();
    expect(runTrack(["close", okId, "--state", "delivered"]).status).toBe(0);
    const okStatus = runTrack(["status", okId]);
    expect(okStatus.status).toBe(0);
    expect(okStatus.stdout).toContain("delivered");

    const whId = runTrack(["open", "--target", "biz-c", "--kind", "business", "--project", "p-status-wh", "--outputs", outputs]).stdout.trim();
    expect(runTrack(["close", whId, "--state", "withheld", "--error", "gate failed"]).status).toBe(0);
    const whStatus = runTrack(["status", whId]);
    expect(whStatus.status).toBe(2);
    expect(whStatus.stdout).toContain("withheld");

    const failId = runTrack(["open", "--target", "biz-d", "--kind", "business", "--project", "p-status-fail", "--outputs", outputs]).stdout.trim();
    expect(runTrack(["close", failId, "--state", "failed", "--error", "sem cota"]).status).toBe(0);
    const failStatus = runTrack(["status", failId]);
    expect(failStatus.status).toBe(1);
    expect(failStatus.stdout).toContain("failed");
    expect(failStatus.stdout).toContain("sem cota");

    // The whole point: asking AGAIN, well after the process that ran the
    // dispatch is gone, still gets a truthful answer — not silence.
    const again = runTrack(["status", okId]);
    expect(again.status).toBe(0);
    expect(again.stdout).toContain("delivered");
  }, spawnBudgetMs(6));

  test("--json carries the trace, the outputs path and when it ended", () => {
    const outputs = path.join(TMP, "status-json-outputs");
    fs.mkdirSync(outputs, { recursive: true });
    const runId = runTrack(["open", "--target", "biz-e", "--kind", "business", "--project", "p-status-json", "--outputs", outputs, "--trace", "t-json"]).stdout.trim();
    runTrack(["close", runId, "--state", "delivered"]);
    const r = runTrack(["status", runId, "--json"]);
    const payload = JSON.parse(r.stdout.trim());
    expect(payload.run_id).toBe(runId);
    expect(payload.trace_id).toBe("t-json");
    expect(payload.state).toBe("delivered");
    expect(payload.outputs_root).toBe(outputs);
    expect(typeof payload.ended_at).toBe("string");
  }, spawnBudgetMs(2));

  test("an unknown id is a clean miss, not a crash", () => {
    const r = runTrack(["status", "run-does-not-exist"]);
    expect(r.status).toBe(5);
    expect(r.stderr).toContain("no run found");
  }, spawnBudgetMs(1));
});

// ── 3. `nrv run-track wait` — a blocking caller, woken by the signal ──────

describe("nrv run-track wait", () => {
  const db = path.join(TMP, "wait.sqlite");
  const env = { ...process.env, NIRVANA_RUN_LEDGER_DB: db, NIRVANA_SKILLS_DIR: SKILLS };
  const runTrackScript = path.join(SKILLS, "harness", "scripts", "run-track.ts");
  const runTrack = (args: string[]) => spawnSync(process.execPath, [runTrackScript, ...args], { encoding: "utf8", env });

  test("a run that is already done returns immediately with the right state", () => {
    const outputs = path.join(TMP, "wait-done-outputs");
    fs.mkdirSync(outputs, { recursive: true });
    const runId = runTrack(["open", "--target", "biz-f", "--kind", "business", "--project", "p-wait-done", "--outputs", outputs]).stdout.trim();
    runTrack(["close", runId, "--state", "delivered"]);

    const started = Date.now();
    const r = runTrack(["wait", runId]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("delivered");
    expect(Date.now() - started).toBeLessThan(3_000);
  }, spawnBudgetMs(2));

  test("a caller detached from the dispatch is woken the moment it finishes — not by a 30s poll", async () => {
    const outputs = path.join(TMP, "wait-live-outputs");
    fs.mkdirSync(outputs, { recursive: true });
    const runId = runTrack(["open", "--target", "biz-g", "--kind", "business", "--project", "p-wait-live", "--outputs", outputs]).stdout.trim();

    const started = Date.now();
    const waiter = spawn(process.execPath, [runTrackScript, "wait", runId], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    waiter.stdout.on("data", (d) => { out += String(d); });

    // Simulates the real shape: the dispatch is still doing work when the
    // caller starts waiting, and finishes a moment later — exactly the
    // `( nohup nrv dispatch … & )` timing this signal exists for.
    await new Promise((r) => setTimeout(r, 400));
    expect(runTrack(["close", runId, "--state", "delivered"]).status).toBe(0);

    const [code] = await new Promise<[number | null]>((resolve) => {
      waiter.on("exit", (c) => resolve([c]));
    });
    const elapsed = Date.now() - started;
    expect(code).toBe(0);
    expect(out).toContain("delivered");
    // Event-driven: woken within ~a second of the close, nowhere near the 30s
    // DB-polling backstop. A poll-only implementation would clear this too
    // slowly to pass a tight bound like this reliably.
    expect(elapsed).toBeLessThan(10_000);
  }, spawnBudgetMs(2) + 15_000);

  test("a failing dispatch wakes the waiter too, with the failure state and reason", async () => {
    const outputs = path.join(TMP, "wait-fail-outputs");
    fs.mkdirSync(outputs, { recursive: true });
    const runId = runTrack(["open", "--target", "biz-h", "--kind", "business", "--project", "p-wait-fail", "--outputs", outputs]).stdout.trim();

    const waiter = spawn(process.execPath, [runTrackScript, "wait", runId], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    waiter.stdout.on("data", (d) => { out += String(d); });

    await new Promise((r) => setTimeout(r, 300));
    expect(runTrack(["close", runId, "--state", "failed", "--error", "runtime sem cota"]).status).toBe(0);

    const code = await new Promise<number | null>((resolve) => { waiter.on("exit", resolve); });
    expect(code).toBe(1);
    expect(out).toContain("failed");
    expect(out).toContain("runtime sem cota");
  }, spawnBudgetMs(2) + 15_000);

  test("--timeout gives up honestly instead of hanging forever", () => {
    const outputs = path.join(TMP, "wait-timeout-outputs");
    fs.mkdirSync(outputs, { recursive: true });
    const runId = runTrack(["open", "--target", "biz-i", "--kind", "business", "--project", "p-wait-timeout", "--outputs", outputs]).stdout.trim();
    const started = Date.now();
    const r = runTrack(["wait", runId, "--timeout", "1"]);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(r.status).toBe(6);
  }, spawnBudgetMs(2) + 10_000);

  test("waiting on an unknown id is a clean miss", () => {
    const r = runTrack(["wait", "run-does-not-exist"]);
    expect(r.status).toBe(5);
  }, spawnBudgetMs(1));
});

// ── 4. the directory the signal lives in ──────────────────────────────────

describe("runSignalDir", () => {
  test("sits next to the ledger DB the process is already using", () => {
    expect(runSignalDir()).toBe(path.join(path.dirname(process.env.NIRVANA_RUN_LEDGER_DB!), "run-signals"));
  });
});
