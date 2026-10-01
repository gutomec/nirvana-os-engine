// run-ledger-test-isolation.test.ts — a test process never writes the user's run
// ledger, nor the run-signals beside it.
//
// markState() mirrors every terminal decision into <ledger dir>/run-signals, and
// that directory comes from resolveLedgerDbPath(), not from the handle. A test
// that opened its ledger at a temp path still wrote its signals next to the
// user's real ledger: on 2026-09-30 ~/.nirvana/run-signals held run_a.json,
// run_glance.json and dozens of `"trace_id":"t"` withheld runs, all fixtures.
import { describe, expect, test, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  openLedger, openRun, markState, resolveLedgerDbPath, runSignalDir, runSignalPath,
} from "../lib/run-ledger.ts";

const REAL = path.join(os.homedir(), ".nirvana");
// Other test files pin their own roots at module scope and bun runs every file in
// one process, so the assertion is about where the ledger may NEVER be.
const outsideTheUsersHome = (p: string) => !path.resolve(p).startsWith(REAL + path.sep);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-ledger-isolation-"));
afterAll(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ } });

function withEnvUnset<T>(keys: string[], fn: () => T): T {
  const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe("run ledger under the test preload", () => {
  test("the ledger and its run-signals never resolve into the user's home", () => {
    expect(outsideTheUsersHome(resolveLedgerDbPath())).toBeTrue();
    expect(outsideTheUsersHome(runSignalDir())).toBeTrue();
  });

  test("a test that deletes NIRVANA_RUN_LEDGER_DB still does not reach them", () => {
    withEnvUnset(["NIRVANA_RUN_LEDGER_DB", "NIRVANA_HOME"], () => {
      expect(runSignalDir()).toBe(path.join(path.resolve(process.env.NIRVANA_TEST_LOGS_HOME!), "run-signals"));
    });
  });

  test("a run on a ledger opened at its own path leaves no signal in the user's home", () => {
    // The delivery-pipeline shape: an explicit DB path, no env pin of its own.
    const handle = openLedger(path.join(TMP, "ledger.sqlite"));
    const row = openRun(handle, { traceId: "t", projectId: "p", projectRoot: null });
    markState(handle, row.run_id, "running");
    markState(handle, row.run_id, "withheld");

    expect(fs.existsSync(runSignalPath(row.run_id))).toBeTrue();
    expect(outsideTheUsersHome(runSignalPath(row.run_id))).toBeTrue();
    expect(fs.existsSync(path.join(REAL, "run-signals", `${row.run_id}.json`))).toBeFalse();
  });
});
