#!/usr/bin/env bun
/**
 * find.ts — debug-route a brief through the harness router.
 */

import * as path from "node:path";
import { exec, paths, EXIT, BUN_BIN } from "../../_shared/lib/bun-helpers.ts";

const SKILL_DIR = path.join(paths.CLAUDE_SKILLS_DIR, "harness");
const ROUTER = path.join(SKILL_DIR, "lib", "router.js");

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("usage: find <brief> [--json]");
  process.exit(EXIT.INVALID_ARGS);
}

const r = exec(`${JSON.stringify(BUN_BIN)} ${JSON.stringify(ROUTER)} find ${args.map(a => JSON.stringify(a)).join(" ")}`, { silent: true });
if (r.stdout) process.stdout.write(r.stdout);
if (r.stderr) process.stderr.write(r.stderr);
process.exit(r.code ?? (r.ok ? EXIT.OK : EXIT.FAILURES));
