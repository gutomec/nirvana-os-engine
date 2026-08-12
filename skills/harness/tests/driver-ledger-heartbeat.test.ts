// driver-ledger-heartbeat.test.ts — the runHeadless lease/heartbeat contract:
// renews on activity, stops on stall, default 45-min timeout for ledgered
// runs, and no dangling sidecar after every exit path. The "child" is a fake
// `claude` executable (bash) that prints then sleeps — no real runtime spawned.
import { describe, expect, test, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writeFakeCli } from "./helpers/fake-cli.ts";
import { spawnSync } from "node:child_process";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-driver-hb-test-"));
process.env.HARNESS_LOGS_DIR = path.join(TMP, "harness-logs");
process.env.NIRVANA_STATE_DB = path.join(TMP, "state.db");
process.env.NIRVANA_SKILLS_DIR = path.resolve(import.meta.dir, "..", "..");
process.env.NIRVANA_RUN_LEDGER_DB = path.join(TMP, "ledger.sqlite");

import { runHeadless, resolveLedgerTimeoutMs, LEDGER_DEFAULT_TIMEOUT_MS } from "../lib/host-agent-driver.ts";
import { openLedger, openRun, getRun } from "../lib/run-ledger.ts";

const DB = path.join(TMP, "ledger.sqlite");

// Fake `claude` on PATH: activity ticks on stderr (0s, 0.4s, 0.8s), then a
// 2.2s silent stall, then the final result JSON on stdout.
const FAKE_BIN = path.join(TMP, "bin");
fs.mkdirSync(FAKE_BIN, { recursive: true });
writeFakeCli(FAKE_BIN, "claude", `
  console.error("tick 1");
  await Bun.sleep(400);
  console.error("tick 2");
  await Bun.sleep(400);
  console.error("tick 3");
  await Bun.sleep(2200);
  console.log(JSON.stringify({ type: "result", result: "done", session_id: "fake-session-123", total_cost_usd: 0.01 }));
  // Exit in the same breath as the write. The final result IS activity, so any
  // sidecar tick landing between the write and process teardown renews the lease
  // and the "stopped renewing during the stall" assertion sees a fresh heartbeat.
  // The bash original exited immediately after printf; Bun's teardown widened
  // that window enough to make the race show up roughly one run in three.
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
      try { out.push(JSON.parse(line)); } catch { /* skip */ }
    }
  }
  return out;
}

describe("driver — ledger default timeout", () => {
  test("explicit timeoutMs always wins; ledgered runs default to a 24h backstop; unledgered stay uncapped", () => {
    expect(resolveLedgerTimeoutMs({ timeoutMs: 1234, ledger: { runId: "x" } })).toBe(1234);
    expect(resolveLedgerTimeoutMs({ ledger: { runId: "x" } })).toBe(LEDGER_DEFAULT_TIMEOUT_MS);
    // 24h is a BACKSTOP: hangs are caught by the activity heartbeat (~5 min
    // stall budget), not by the clock, so real long-form work is never killed.
    expect(LEDGER_DEFAULT_TIMEOUT_MS).toBe(24 * 60 * 60_000);
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
    // Stopped renewing during the stall: the last heartbeat is old relative to
    // run end (the quiet stretch was 2.2s with a 1.2s stall budget).
    expect(Date.now() - Date.parse(after.heartbeat_at!)).toBeGreaterThanOrEqual(1200);
    // The stall itself was observed and recorded.
    const stallEvents = readAuditEvents().filter(e => e.event === "x_ledger_stall_observed" && e.run_id === row.run_id);
    expect(stallEvents.length).toBeGreaterThanOrEqual(1);
    expect(Number(stallEvents[0].gap_ms)).toBeGreaterThanOrEqual(1200);

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
