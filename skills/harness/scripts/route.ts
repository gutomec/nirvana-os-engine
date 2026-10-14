#!/usr/bin/env bun
/**
 * route.ts — the keyword router's full pipeline on one brief, as a diagnostic.
 *
 * It prints what BM25 would match. It never dispatches and never decides who
 * executes: `nrv dispatch --auto` routes with the cards or agentic router, and
 * `nrv find` is the shortlist the orchestrator reads.
 */

import * as path from "node:path";
import { exec, paths, EXIT, BUN_BIN } from "../../_shared/lib/bun-helpers.ts";
import { preflightReindex } from "../lib/preflight-index.ts";

const ROUTER = path.join(paths.CLAUDE_SKILLS_DIR, "harness", "lib", "router.js");
const args = process.argv.slice(2);

const ROUTE_HELP = [
  'nrv route "<brief>" [--json] [--prefer business|squad|auto] [--no-amplify] [--force-amplify]',
  "",
  "Diagnostic: what the keyword router (BM25) matches for a brief, stage by stage.",
  "It never decides who executes and never dispatches. `nrv dispatch --auto` routes",
  "with the cards or agentic router; `nrv find` prints the shortlist the orchestrator reads.",
].join("\n");

if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
  console.log(ROUTE_HELP);
  process.exit(args.length === 0 ? EXIT.INVALID_ARGS : EXIT.OK);
}

// Never route against a stale corpus (routing-360 Phase 2.5); <50ms when fresh.
preflightReindex();

const r = exec(`${JSON.stringify(BUN_BIN)} ${JSON.stringify(ROUTER)} route ${args.map(a => JSON.stringify(a)).join(" ")}`, { silent: true });
if (r.stdout) process.stdout.write(r.stdout);
if (r.stderr) process.stderr.write(r.stderr);
process.exit(r.code ?? (r.ok ? EXIT.OK : EXIT.FAILURES));
