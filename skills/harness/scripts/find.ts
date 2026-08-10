#!/usr/bin/env bun
/**
 * find.ts — debug-route a brief through the harness router.
 */

import * as path from "node:path";
import { exec, paths, EXIT, BUN_BIN } from "../../_shared/lib/bun-helpers.ts";
import { preflightReindex } from "../lib/preflight-index.ts";
import { maybeSweep } from "./supervisor.ts";

const SKILL_DIR = path.join(paths.CLAUDE_SKILLS_DIR, "harness");
const ROUTER = path.join(SKILL_DIR, "lib", "router.js");

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("usage: find <brief> [--json]");
  process.exit(EXIT.INVALID_ARGS);
}

// Never route against a stale corpus (routing-360 Phase 2.5); <50ms when fresh.
preflightReindex();
// Never-stall guarantee (Phase 4): recover forgotten runs lazily (<20ms idle).
maybeSweep();

const r = exec(`${JSON.stringify(BUN_BIN)} ${JSON.stringify(ROUTER)} find ${args.map(a => JSON.stringify(a)).join(" ")}`, { silent: true });
if (r.stdout) process.stdout.write(r.stdout);
if (r.stderr) process.stderr.write(r.stderr);
process.exit(r.code ?? (r.ok ? EXIT.OK : EXIT.FAILURES));
