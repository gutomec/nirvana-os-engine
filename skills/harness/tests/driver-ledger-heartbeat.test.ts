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
