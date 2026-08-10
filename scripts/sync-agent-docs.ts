#!/usr/bin/env bun
/**
 * sync-agent-docs.ts — AGENTS.md is the single source of the agent contract.
 * CLAUDE.md and GEMINI.md are byte-identical copies each runtime reads by its
 * own convention. Edit AGENTS.md only, then run this. publish-engine.ts fails
 * closed on drift, so a forgotten sync can never ship divergent contracts.
 *
 * Usage: bun scripts/sync-agent-docs.ts [--check]
 */
import { copyFileSync, readFileSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = join(ROOT, "AGENTS.md");
const COPIES = ["CLAUDE.md", "GEMINI.md"].map((f) => join(ROOT, f));

if (!existsSync(SOURCE)) {
  console.error("AGENTS.md not found — nothing to sync.");
  process.exit(1);
}

const checkOnly = process.argv.includes("--check");
const canonical = readFileSync(SOURCE, "utf8");
let drifted = 0;

for (const copy of COPIES) {
  const same = existsSync(copy) && readFileSync(copy, "utf8") === canonical;
  if (same) { console.log(`  = ${copy.slice(ROOT.length + 1)} (in sync)`); continue; }
  drifted++;
  if (checkOnly) { console.error(`  ! ${copy.slice(ROOT.length + 1)} DRIFTED from AGENTS.md`); continue; }
  copyFileSync(SOURCE, copy);
  console.log(`  ✓ ${copy.slice(ROOT.length + 1)} regenerated from AGENTS.md`);
}

process.exit(checkOnly && drifted > 0 ? 1 : 0);
