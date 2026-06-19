#!/usr/bin/env bun
/**
 * nrv validate-trace <trace_id>
 *
 * Asserts that every mind-clone declared in `target_plan_committed` has a
 * matching `mind_clone_injected` event for the same trace_id. Returns exit
 * code 0 on pass, 1 on fail (missing injections, dispatch_blocked, or no
 * declared mind-clones to validate).
 *
 * Usage:
 *   nrv validate-trace <trace_id>           # human-readable report
 *   nrv validate-trace <trace_id> --json    # machine-readable JSON
 *
 * See: docs/plans/dispatch-quality-gate-and-mind-clone-injection.md
 */

import { validateTrace, formatReport } from "../lib/dispatch.ts";

const args = process.argv.slice(2);
const traceId = args.find(a => !a.startsWith("--"));
const jsonOut = args.includes("--json");

if (!traceId) {
  console.error("usage: nrv validate-trace <trace_id> [--json]");
  process.exit(2);
}

const report = validateTrace(traceId);

if (jsonOut) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(formatReport(report));
}

process.exit(report.ok ? 0 : 1);
