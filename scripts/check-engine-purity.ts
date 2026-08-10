#!/usr/bin/env bun
/**
 * check-engine-purity.ts — the engine repo must contain NO entity content.
 *
 * Phase 1 of the routing-360 overhaul moved all entity content (squads,
 * businesses, mind-clone DNA) to the private nirvana-packs repo. This gate
 * fails (exit 1) if any entity content is found back in the ENGINE repo:
 *
 *   - a `business.yaml` or `squad.yaml` file
 *   - a mind-clone `MANIFEST.yaml` (one with a top-level `routing:` or
 *     `manifest:` block)
 *   - a `dna-schema.md` file
 *   - a directory holding an AGENT.md + SOUL.md pair (mind-clone agent layout)
 *
 * Allowlisted roots (scaffolding the engine legitimately ships):
 *   skills/<skill>/templates/**   (includes skills/_shared/templates/**)
 *   skills/<skill>/schemas/**
 *   examples/**                   (docs-only walkthroughs, no real entities)
 *
 * Skipped entirely: .git, node_modules, dist (build output) and gitignored
 * local-only dirs (tmp, _private, .readme-work, .sanitization-work, .nirvana,
 * scratch) — those never ship, and several are not part of the repo at all.
 *
 * Usage: bun scripts/check-engine-purity.ts
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const SKIP_DIRS = new Set([
  ".git", "node_modules", "dist", "tmp", "_private",
  ".readme-work", ".sanitization-work", ".nirvana", "scratch",
]);

const ALLOWLIST = [
  /^skills\/[^/]+\/templates\//,
  /^skills\/[^/]+\/schemas\//,
  /^examples\//,
];

const isAllowlisted = (rel: string): boolean => ALLOWLIST.some((re) => re.test(rel));

const isMindCloneManifest = (abs: string): boolean => {
  try {
    return /^(routing|manifest):/m.test(readFileSync(abs, "utf8"));
  } catch {
    return false; // unreadable/binary — not a manifest
  }
};

const offenses: string[] = [];

function walk(dir: string, rel: string): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const names = new Set(entries.filter((e) => e.isFile()).map((e) => e.name));
  if (names.has("AGENT.md") && names.has("SOUL.md") && !isAllowlisted(`${rel}/`)) {
    offenses.push(`${rel || "."}/  (AGENT.md + SOUL.md pair)`);
  }
  for (const e of entries) {
    const abs = join(dir, e.name);
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(abs, childRel);
      continue;
    }
    if (isAllowlisted(childRel)) continue;
    if (e.name === "business.yaml" || e.name === "squad.yaml") {
      offenses.push(`${childRel}  (${e.name})`);
    } else if (e.name === "MANIFEST.yaml" && isMindCloneManifest(abs)) {
      offenses.push(`${childRel}  (mind-clone MANIFEST.yaml)`);
    } else if (e.name === "dna-schema.md") {
      offenses.push(`${childRel}  (dna-schema.md)`);
    }
  }
}

if (!existsSync(REPO)) {
  console.error(`repo not found: ${REPO}`);
  process.exit(2);
}
walk(REPO, "");

if (offenses.length > 0) {
  console.error(`ENGINE PURITY: FAIL — ${offenses.length} entity-content file(s) in the engine repo:`);
  for (const o of offenses.sort()) console.error(`  ${o}`);
  console.error("\nEntity content belongs in the nirvana-packs repo, never in the engine.");
  process.exit(1);
}
console.log("ENGINE PURITY: OK — no entity content in the engine repo.");
