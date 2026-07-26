#!/usr/bin/env bun
/**
 * route.ts — full pipeline (brief → routing decision → optional dispatch).
 */

import * as path from "node:path";
import { exec, paths, EXIT, BUN_BIN } from "../../_shared/lib/bun-helpers.ts";

const ROUTER = path.join(paths.CLAUDE_SKILLS_DIR, "harness", "lib", "router.js");
const args = process.argv.slice(2);
const r = exec(`${JSON.stringify(BUN_BIN)} ${JSON.stringify(ROUTER)} route ${args.map(a => JSON.stringify(a)).join(" ")}`, { silent: true });
if (r.stdout) process.stdout.write(r.stdout);
if (r.stderr) process.stderr.write(r.stderr);
process.exit(r.code ?? (r.ok ? EXIT.OK : EXIT.FAILURES));
