#!/usr/bin/env bun
/**
 * activate-squad.ts — cross-platform replacement for activate-squad.sh
 *
 * Squad activation wrapper. Delegates to ../lib/activator.js (Node lib that
 * handles all install logic) and forwards exit codes per the contract:
 *   0 = ok / activated
 *   1 = failures present
 *   2 = confirmations required (heavy installs / sudo)
 *   4 = invalid args / squad not found
 *
 * Runs identically on macOS, Linux, Windows native (Bun), WSL2, Docker.
 * The legacy activate-squad.sh wrapper now delegates here via _delegator.sh.
 */

import * as path from "node:path";
import * as fs from "node:fs";
import { exec, paths, log, EXIT, BUN_BIN } from "../../_shared/lib/bun-helpers.ts";
import { resolveScope, enumerate } from "../../_shared/lib/scope.ts";

const args = process.argv.slice(2);
const cmd = args[0];
const slug = args[1];
const rest = args.slice(2);

const QUIET = rest.includes("--quiet") || rest.includes("-q");

function emitSummary(rc: number) {
  if (QUIET) return;
  switch (rc) {
    case 0: console.error("[activate-squad] ✓ ok — squad ready (or already active)."); break;
    case 1: console.error("[activate-squad] ✗ failures present — see 'failures' array in JSON above; re-run with --verbose for live install logs."); break;
    case 2: console.error("[activate-squad] ⚠ confirmations required — heavy downloads or sudo flagged; re-run with --confirm-heavy to accept."); break;
    case 4: console.error("[activate-squad] ✗ invalid args or squad not found."); break;
    default: console.error(`[activate-squad] ? unexpected exit code: ${rc}`); break;
  }
}

function usage() {
  console.error(`usage: activate-squad <activate|status|deactivate> <slug> [--dry-run] [--confirm-heavy] [--verbose|-v] [--quiet|-q]

Reads <SQUADS_DIR>/<slug>/dependencies.yaml and installs each declared
dependency. Idempotent. Heavy items (>1 GB) require --confirm-heavy.

State persists at ~/.claude/squads-state/<slug>/activated.json.
Template:  ${paths.CLAUDE_SKILLS_DIR}/squads/templates/dependencies.template.yaml`);
}

if (!cmd || ["-h", "--help"].includes(cmd)) {
  usage();
  process.exit(cmd ? EXIT.OK : EXIT.INVALID_ARGS);
}

if (!["activate", "status", "deactivate"].includes(cmd)) {
  console.error(`unknown command: ${cmd}`);
  usage();
  process.exit(EXIT.INVALID_ARGS);
}

if (!slug) {
  console.error(`usage: activate-squad ${cmd} <slug> [flags]`);
  process.exit(EXIT.INVALID_ARGS);
}

// Resolve squad path via scope (project / global / merge with override)
const scope = resolveScope();
const match = enumerate(scope, "squads").find(e => e.slug === slug && !e.overridden);
if (!match) {
  console.error(`[activate-squad] squad '${slug}' not found in scope=${scope.mode}`);
  console.error(`[activate-squad] searched: ${scope.squadDirs.join(" → ") || "(empty)"}`);
  process.exit(EXIT.INVALID_ARGS);
}
if (!process.env.NIRVANA_VERBOSE) {
  console.error(`[activate-squad] resolved '${slug}' from ${match.source}: ${match.dir}`);
}

// Find activator.js — sibling library
const LIB = path.join(paths.CLAUDE_SKILLS_DIR, "squads", "lib", "activator.js");

// Forward to activator.js with the resolved path injected via env. Also
// route state writes to the project's .nirvana/state/squads when the squad
// resolved from project source — so a project-scoped squad never persists
// install state into another project's HOME global state dir.
const env: Record<string, string> = { ...process.env, NIRVANA_RESOLVED_SQUAD_PATH: match.dir };
if (match.source === "project" && scope.projectRoot) {
  env.NIRVANA_STATE_DIR = path.join(scope.projectRoot, ".nirvana", "state", "squads");
}
const cmdLine = `${JSON.stringify(BUN_BIN)} ${JSON.stringify(LIB)} ${cmd} ${JSON.stringify(slug)} ${rest.map(a => JSON.stringify(a)).join(" ")}`;
const result = exec(cmdLine, { silent: false, env });

// activator.js prints JSON to stdout — we already streamed via inherit
// (silent: false) so nothing else to do; just propagate exit code
const rc = result.code ?? (result.ok ? EXIT.OK : EXIT.FAILURES);
emitSummary(rc);
process.exit(rc);
