// stall-guard.test.ts — a dispatch ends itself on a confirmed stall, and never
// ends a worker that keeps showing a sign of life.
//
// The workers are fake `claude` CLIs (Bun scripts on PATH): one that never
// says anything, one that speaks once and goes silent, one that only writes
// files in the run's scaffold (outside the watched directory), one that only
// prints. The thresholds are the real settings, in fractions of a minute
// (execution.stall_timeout_min / execution.stall_no_start_min), and the
// sidecar ticks every 250 ms. No model is called.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writeFakeCli } from "./helpers/fake-cli.ts";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-stall-guard-"));
process.env.HARNESS_LOGS_DIR = path.join(TMP, "harness-logs");
process.env.NIRVANA_STATE_DB = path.join(TMP, "state.db");
process.env.NIRVANA_SKILLS_DIR = path.resolve(import.meta.dir, "..", "..");
process.env.NIRVANA_RUN_LEDGER_DB = path.join(TMP, "ledger.sqlite");

import { runHeadless } from "../lib/host-agent-driver.ts";
import { onLedgerStall } from "../../_shared/lib/host-agent-driver.ts";
import { getRun, markState, openLedger, openRun, pidAlive } from "../lib/run-ledger.ts";
import { stallVerdict, dispatcherOwnsStall, leaseLongExpired, STALLED_EXIT } from "../lib/stall-guard.ts";

const DB = path.join(TMP, "ledger.sqlite");
const BIN = path.join(TMP, "bin");
const PIDS = path.join(TMP, "pids");
fs.mkdirSync(PIDS, { recursive: true });

// One fake, four behaviours (FAKE_MODE). Each records its pid, so the test can
// prove the stalled one was ended.
writeFakeCli(BIN, "claude", `
  import * as fs from "node:fs";
  import * as path from "node:path";
  fs.writeFileSync(path.join(${JSON.stringify(PIDS)}, process.env.FAKE_MODE + ".pid"), String(process.pid));
  await Bun.stdin.text();
  const mode = process.env.FAKE_MODE;
  const done = () => { console.log(JSON.stringify({ type: "result", result: "done", session_id: "s-" + mode, total_cost_usd: 0 })); process.exit(0); };
  if (mode === "silent") { await Bun.sleep(60_000); done(); }
  if (mode === "once") { console.error("starting"); await Bun.sleep(60_000); done(); }
  if (mode === "files") {
    for (let i = 0; i < 8; i++) { await Bun.sleep(800); fs.writeFileSync(path.join(process.env.FAKE_SCAFFOLD, "notes-" + i + ".md"), "step " + i); }
    done();
  }
  if (mode === "prints") {
    for (let i = 0; i < 8; i++) { await Bun.sleep(800); console.error("tick " + i); }
    done();
  }
`);

const saved: Record<string, string | undefined> = {};
const KEYS = ["PATH", "FAKE_MODE", "FAKE_SCAFFOLD", "NIRVANA_STALL_TIMEOUT_MIN", "NIRVANA_STALL_NO_START_MIN", "NIRVANA_ORCA_HOST"];

beforeAll(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  process.env.PATH = `${BIN}${path.delimiter}${saved.PATH ?? ""}`;
  process.env.NIRVANA_ORCA_HOST = "off";
  // 2.4 s of silence, 2.4 s to a first sign of life.
  process.env.NIRVANA_STALL_TIMEOUT_MIN = "0.04";
  process.env.NIRVANA_STALL_NO_START_MIN = "0.04";
});

afterAll(() => {
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  onLedgerStall(null);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ }
});

function run(mode: string) {
  const h = openLedger(DB);
  const scaffold = fs.mkdtempSync(path.join(TMP, `scaffold-${mode}-`));
  const deliverables = path.join(scaffold, "deliverables");
  fs.mkdirSync(deliverables, { recursive: true });
  const opened = openRun(h, {
    targetSlug: "fake", targetKind: "squad", runtime: "claude-code", projectId: `p-${mode}`, traceId: `p-${mode}`,
    meta: { scaffold_root: scaffold, outputs_root: deliverables },
  });
  markState(h, opened.run_id, "running");
  process.env.FAKE_MODE = mode;
  process.env.FAKE_SCAFFOLD = scaffold;
  const started = Date.now();
  const res = runHeadless({
    runtime: "claude-code", prompt: "work", cwd: scaffold, yolo: true,
    ledger: { runId: opened.run_id, dbPath: DB, intervalMs: 250, leaseSec: 120, watchDir: deliverables },
    stallBudgetMs: 1_000,
  });
  return { h, runId: opened.run_id, res, ms: Date.now() - started, scaffold };
}

function workerPid(mode: string): number {
  return Number(fs.readFileSync(path.join(PIDS, `${mode}.pid`), "utf8"));
}

describe("the stall rules", () => {
  const th = { silenceMs: 90 * 60_000, noStartMs: 45 * 60_000 };
  test("healthy runs measured silent for 72 minutes are not stalls at the defaults", () => {
    expect(stallVerdict({ startedAt: 0, lastActivityAt: 10 * 60_000, everActive: true, now: 82 * 60_000, thresholds: th })).toBeNull();
  });
  test("90 minutes of silence is; 45 minutes without a first sign of life is", () => {
    expect(stallVerdict({ startedAt: 0, lastActivityAt: 5 * 60_000, everActive: true, now: 95 * 60_000, thresholds: th })?.rule).toBe("silence");
    expect(stallVerdict({ startedAt: 0, lastActivityAt: 0, everActive: false, now: 45 * 60_000, thresholds: th })?.rule).toBe("never_started");
    expect(stallVerdict({ startedAt: 0, lastActivityAt: 0, everActive: true, now: 45 * 60_000, thresholds: th })).toBeNull();
  });
  test("0 turns a rule off", () => {
    expect(stallVerdict({ startedAt: 0, lastActivityAt: 0, everActive: false, now: 10 ** 9, thresholds: { silenceMs: 0, noStartMs: 0 } })).toBeNull();
  });
});

describe("through the driver, with fake workers", () => {
  test("a worker that never starts is ended, the row is stalled for the agent, and the result says why", () => {
    const { h, runId, res, ms } = run("silent");
    expect(res.ok).toBe(false);
    expect(res.stalled?.rule).toBe("never_started");
    expect(res.error).toMatch(/^stalled: the worker never started/);
    expect(ms).toBeLessThan(30_000);
    const row = getRun(h, runId)!;
    expect(row.state).toBe("stalled");
    expect((row.meta.stall as any).rule).toBe("never_started");
    expect(row.meta.salvaged).toBe(true);
    expect((row.meta.stall_guard as any).silence_ms).toBe(2_400);
    expect(pidAlive(workerPid("silent"))).toBe(false);
  }, 40_000);

  test("a worker that spoke once and went silent is ended by the silence rule", () => {
    const { h, runId, res } = run("once");
    expect(res.stalled?.rule).toBe("silence");
    expect(getRun(h, runId)!.state).toBe("stalled");
    expect(pidAlive(workerPid("once"))).toBe(false);
  }, 40_000);

  test("a worker that only writes files in its scaffold, outside the watched folder, is never ended", () => {
    const { h, runId, res } = run("files");
    expect(res.stalled).toBeUndefined();
    expect(res.ok).toBe(true);
    expect(getRun(h, runId)!.state).toBe("running");
  }, 40_000);

  test("a worker that only prints in the gaps is never ended", () => {
    const { h, runId, res } = run("prints");
    expect(res.stalled).toBeUndefined();
    expect(res.ok).toBe(true);
    expect(getRun(h, runId)!.state).toBe("running");
  }, 40_000);

  test("a registered handler (what nrv dispatch and nrv revise install) receives the stall", () => {
    const seen: string[] = [];
    onLedgerStall((stall) => { seen.push(stall.rule); });
    try { run("silent"); } finally { onLedgerStall(null); }
    expect(seen).toEqual(["never_started"]);
  }, 40_000);
});

describe("who owns the decision", () => {
  const base = { run_id: "r", trace_id: null, project_id: null, project_root: null, target_slug: null, target_kind: null, state: "running", child_pid: null, session_id: null, runtime: null, retries: 0, max_retries: 2, created_at: "", updated_at: "" } as any;
  const guard = { stall_guard: { silence_ms: 90 * 60_000, no_start_ms: 45 * 60_000 } };
  test("a live dispatcher owns it until its run is silent for the threshold plus the grace", () => {
    const now = Date.parse("2026-10-15T12:00:00Z");
    const fresh = { ...base, heartbeat_at: new Date(now - 60 * 60_000).toISOString(), meta: guard };
    const old = { ...base, heartbeat_at: new Date(now - 106 * 60_000).toISOString(), meta: guard };
    expect(dispatcherOwnsStall(fresh, now, () => true)).toBe(true);
    expect(dispatcherOwnsStall(old, now, () => true)).toBe(false);
    expect(dispatcherOwnsStall(fresh, now, () => false)).toBe(false);
    expect(dispatcherOwnsStall({ ...fresh, meta: { stall_guard: { silence_ms: 0, no_start_ms: 0 } } }, now, () => true)).toBe(false);
  });
  test("a lease expired past the threshold plus the grace is the waiter's safety net", () => {
    const now = Date.parse("2026-10-15T12:00:00Z");
    expect(leaseLongExpired({ ...base, lease_expires_at: new Date(now - 106 * 60_000).toISOString(), meta: guard }, now)).toBe(true);
    expect(leaseLongExpired({ ...base, lease_expires_at: new Date(now - 30 * 60_000).toISOString(), meta: guard }, now)).toBe(false);
  });
  test("exit 76 is its own code", () => {
    expect(STALLED_EXIT).toBe(76);
  });
});
