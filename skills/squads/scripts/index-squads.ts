#!/usr/bin/env bun
/**
 * index-squads.ts — rebuild ~/.squads-registry.json
 *
 * Cross-platform replacement for index-squads.sh. Walks SQUADS_DIR + legacy
 * + cwd, validates manifests, computes content hashes, emits registry.
 */

import * as path from "node:path";
import * as fs from "node:fs";
import { exec, paths, parseArgs, EXIT, BUN_BIN } from "../../_shared/lib/bun-helpers.ts";

const args = process.argv.slice(2);
const quiet = args.includes("--quiet") || args.includes("-q");
const emitJson = args.includes("--json");

const SKILL_DIR = path.join(paths.CLAUDE_SKILLS_DIR, "squads");
const REGISTRY_LIB = path.join(SKILL_DIR, "lib", "registry.js");

if (!fs.existsSync(REGISTRY_LIB)) {
  console.error(`[index-squads] FAIL: lib/registry.js not found at ${REGISTRY_LIB}`);
  process.exit(EXIT.INVALID_ARGS);
}

if (emitJson) {
  const r = exec(`${JSON.stringify(BUN_BIN)} ${JSON.stringify(REGISTRY_LIB)} scan`, { silent: false });
  process.exit(r.code ?? EXIT.OK);
}

const summary = exec(`${JSON.stringify(BUN_BIN)} ${JSON.stringify(REGISTRY_LIB)} rebuild`, { silent: true });
if (!summary.ok) {
  console.error("[index-squads] FAIL: rebuild failed");
  console.error(summary.stderr || summary.error);
  process.exit(EXIT.FAILURES);
}

if (!quiet) {
  console.log(summary.stdout);

  // v5 capabilities table
  const registryPath = paths.SQUADS_REGISTRY_PATH;
  if (fs.existsSync(registryPath)) {
    const reg = JSON.parse(fs.readFileSync(registryPath, "utf8"));
    const rows = Object.entries(reg.squads ?? {})
      .filter(([_, s]: any) => s.protocol === "5.0")
      .map(([name, s]: any) => ({ name, version: s.version, caps: s.capabilities.length, path: s.manifest_path }));
    console.log("\nv5 squads with capabilities:\n----------------------------");
    if (rows.length === 0) {
      console.log("  (none — create one with *squad create or copy templates/squad.yaml.tmpl)");
    } else {
      const widthName = Math.max(...rows.map(r => r.name.length), 4);
      rows.forEach(r => console.log(`  ${r.name.padEnd(widthName)}  v${r.version}  caps=${r.caps}  ${r.path}`));
    }
  }
}
process.exit(EXIT.OK);
