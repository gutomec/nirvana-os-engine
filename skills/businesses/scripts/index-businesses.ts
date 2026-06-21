#!/usr/bin/env bun
/**
 * index-businesses.ts — rebuild ~/.businesses-registry.json
 *
 * Cross-platform replacement for index-businesses.sh. Reads businesses from
 * BUSINESSES_DIR (env-resolved), runs lib/registry.ts (Bun) to walk + validate +
 * write the registry. Forwards stdout. Exit code passes through. No Python.
 */

import * as path from "node:path";
import * as fs from "node:fs";
import { exec, paths, parseArgs, EXIT, BUN_BIN } from "../../_shared/lib/bun-helpers.ts";
import { resolveScope } from "../../_shared/lib/scope.ts";

const { flags } = parseArgs();
const quiet = !!flags.quiet || !!flags.q;

const scope = resolveScope();
const SKILL_DIR = path.join(paths.CLAUDE_SKILLS_DIR, "businesses");
const REGISTRY_LIB = path.join(SKILL_DIR, "lib", "registry.ts");

// Roots to scan: scope.businessDirs already resolved (project / global / merge)
const roots = scope.businessDirs.length > 0 ? scope.businessDirs : [paths.BUSINESSES_DIR];
const targetRegistry = paths.BUSINESSES_REGISTRY_PATH;

if (!quiet) {
  console.error(`[index-businesses] scope=${scope.mode} → scanning: ${roots.join(", ")}`);
  console.error(`[index-businesses] registry → ${targetRegistry}`);
}

// Pass roots via env BUSINESSES_DIR (single root) or via positional (multi root).
// registry.py defaults to BUSINESSES_DIR + walks subdirs; for multi-root we pass
// each via --root flag. Project mode: only project root. Global: only global.
// Merge: both, with project last (overrides on slug clash via registry merge logic).
const rootArgs = roots.length > 0 ? `--roots ${roots.map(r => JSON.stringify(r)).join(" ")}` : "";
const cmd = `${JSON.stringify(BUN_BIN)} ${JSON.stringify(REGISTRY_LIB)} rebuild ${rootArgs} --output ${JSON.stringify(targetRegistry)} ${quiet ? "--quiet" : ""}`.trim();
const r = exec(cmd, {
  silent: false,
  env: {
    BUSINESSES_DIR: roots[0] || paths.BUSINESSES_DIR,
    BUSINESSES_REGISTRY_PATH: targetRegistry,
  },
});
process.exit(r.code ?? (r.ok ? EXIT.OK : EXIT.FAILURES));
