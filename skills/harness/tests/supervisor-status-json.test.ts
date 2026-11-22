// supervisor-status-json.test.ts — `nrv supervisor status --json`.
//
// The table is for a person; a host surface (the Orca plugin's status bar item
// and panel) needs the same runs as data. The JSON lists the open runs first,
// then the newest ended ones when asked, each with the gate verdict and the
// outputs folder the delivery pipeline recorded on the row, and whether the
// ledger still reads it as in progress.
import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-supervisor-json-"));
process.env.NIRVANA_RUN_LEDGER_DB = path.join(TMP, "ledger.sqlite");

import { statusJson } from "../scripts/supervisor.ts";
import { markState, openLedger, openRun } from "../lib/run-ledger.ts";

const handle = openLedger(path.join(TMP, "case.sqlite"));
afterAll(() => {
  // Windows cannot delete a SQLite file that is still open.
  handle.close();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ }
});

test("lists open runs, then the newest ended ones with gate and outputs", () => {
  const done = openRun(handle, { projectId: "site", projectRoot: TMP, targetKind: "business", targetSlug: "web", meta: { outputs_root: "/out/site" } });
  markState(handle, done.run_id, "running");
  markState(handle, done.run_id, "verifying");
  markState(handle, done.run_id, "gated", { metaPatch: { gate: "pass" } });
  markState(handle, done.run_id, "delivered");
  const open = openRun(handle, { projectId: "book", projectRoot: TMP, targetKind: "squad", targetSlug: "copy" });
  markState(handle, open.run_id, "running");
  // Open in the ledger, but its lease ran out and no process is recorded.
  const stale = openRun(handle, { projectId: "old", projectRoot: TMP, targetKind: "squad", targetSlug: "copy", initialLeaseSec: -60 });

  // The two open rows were created in the same millisecond: their order is not asserted.
  expect(statusJson(true, 0, handle).runs.map(r => r.run_id).sort()).toEqual([stale.run_id, open.run_id].sort());

  const all = statusJson(true, 5, handle);
  expect(all.scope).toBe("all projects");
  const seen = all.runs.map(r => [r.project_id, r.state, r.in_progress, r.gate, r.outputs_root]);
  expect(seen.slice(0, 2).sort()).toEqual([
    ["book", "running", true, null, null],
    ["old", "dispatched", false, null, null],
  ]);
  expect(seen[2]).toEqual(["site", "delivered", false, "pass", "/out/site"]);
});
