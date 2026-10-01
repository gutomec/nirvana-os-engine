#!/usr/bin/env bun
/**
 * find.ts — debug-route a brief through the harness router.
 */

import * as path from "node:path";
import { exec, paths, EXIT, BUN_BIN } from "../../_shared/lib/bun-helpers.ts";
import { preflightReindex } from "../lib/preflight-index.ts";

const SKILL_DIR = path.join(paths.CLAUDE_SKILLS_DIR, "harness");
const ROUTER = path.join(SKILL_DIR, "lib", "router.js");

const raw = process.argv.slice(2);
if (raw.length === 0) {
  console.error("usage: find <brief> [--json] [--amplify]");
  process.exit(EXIT.INVALID_ARGS);
}
// A shortlist for the orchestrator, which already understood the request: no
// LLM. The router would otherwise amplify a short brief with a model call
// (about 18 s and 29k tokens each time, measured on a real run) and answer
// differently on each pass. --amplify asks for it.
const args = raw.includes("--amplify") ? raw.filter((a) => a !== "--amplify") : [...raw, "--no-amplify"];

// Never route against a stale corpus (routing-360 Phase 2.5); <50ms when fresh.
preflightReindex();

const r = exec(`${JSON.stringify(BUN_BIN)} ${JSON.stringify(ROUTER)} find ${args.map(a => JSON.stringify(a)).join(" ")}`, { silent: true });
if (r.stdout) process.stdout.write(r.stdout);
if (r.stderr) process.stderr.write(r.stderr);
process.exit(r.code ?? (r.ok ? EXIT.OK : EXIT.FAILURES));
