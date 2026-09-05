// test-preload.ts — no test writes into the owner's real audit.
//
// Measured 2026-09-04: the machine's global audit held 134 events for the day
// and NOT ONE was a real dispatch — `p-handoff`, `p-broken-ledger`, webhook
// deliveries with `subject: run_1`, sixteen gate_passed paired with sixteen
// gate_failed. All of it fixture data from `bun test`, and all of it counted by
// `nrv doctor` as activity and mined by `nrv baseline` as signal.
//
// The cause is ordinary: a test that does not pin `HARNESS_LOGS_DIR` gets the
// resolver's fallback, which is the user's home. One line here removes the
// whole class, and a test that wants its own root still sets it and wins.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

if (!process.env.HARNESS_LOGS_DIR) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-test-logs-"));
  process.env.HARNESS_LOGS_DIR = dir;
}
// Same for the signing key: a test run must not create or read the install's.
// The floor a deleted HARNESS_LOGS_DIR falls to. A test that unsets the
// override is testing a real branch; it should not thereby gain a path to the
// owner's audit.
process.env.NIRVANA_TEST_LOGS_HOME = process.env.HARNESS_LOGS_DIR;

if (!process.env.NIRVANA_AUDIT_KEY) {
  process.env.NIRVANA_AUDIT_KEY = path.join(process.env.HARNESS_LOGS_DIR!, "audit-key");
}
