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
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve, relative, isAbsolute } from "node:path";
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

// Run artifacts are not entity content, but they are the same mistake wearing
// different clothes: the trace of USING the engine, committed into the engine.
// Nine of them reached the public repo — a brief, a HANDOFF, a business's
// outputs, a generated report — because `outputs/` was never gitignored and
// this gate only looked for squad.yaml-shaped things.
//
// The guarded paths are ASKED OF THE ENGINE, not remembered here. A hardcoded
// list is a list that goes stale the day someone changes where a run writes,
// and the leak it misses looks exactly like the one it caught. So the same
// resolvers the runtime uses answer the question, with a static floor in case
// resolution ever fails.
function runArtifactRoots(): string[] {
  const roots = new Set<string>(["outputs", ".nirvana", ".harness-logs"]);   // floor
  try {
    // The resolvers honour env overrides; neutralise them so we ask about the
    // DEFAULT layout, which is the one a contributor's repo will have.
    const saved = { out: process.env.NIRVANA_OUTPUTS_DIR, logs: process.env.HARNESS_LOGS_DIR };
    delete process.env.NIRVANA_OUTPUTS_DIR;
    delete process.env.HARNESS_LOGS_DIR;
    try {
      const scope = require(join(REPO, "skills/_shared/lib/scope.ts"));
      const logs = require(join(REPO, "skills/_shared/lib/log-paths.ts"));
      for (const abs of [
        scope.outputsDir({ projectRoot: REPO }),
        logs.harnessLogsDir({ projectRoot: REPO }),
        logs.maestroLogsDir?.({ projectRoot: REPO }),
      ]) {
        if (typeof abs !== "string") continue;
        const rel = relative(REPO, abs);
        // Only paths INSIDE the repo matter; a run writing to $HOME is not our problem.
        if (rel && !rel.startsWith("..") && !isAbsolute(rel)) roots.add(rel.split("/")[0]);
      }
    } finally {
      if (saved.out !== undefined) process.env.NIRVANA_OUTPUTS_DIR = saved.out;
      if (saved.logs !== undefined) process.env.HARNESS_LOGS_DIR = saved.logs;
    }
  } catch {
    // Resolver moved or failed to load — the floor above still guards the
    // three paths that leaked once, and the drift test will say so out loud.
  }
  return [...roots];
}

// Checking the git INDEX rather than the disk: a developer running a dispatch
// inside their clone is normal and must stay silent; committing one is the fault.
const trackedRunArtifacts = (() => {
  try {
    const out = Bun.spawnSync(["git", "ls-files", ...runArtifactRoots()], { cwd: REPO }).stdout.toString().trim();
    return out ? out.split("\n") : [];
  } catch {
    return [];   // no git (a tarball checkout) — nothing to judge
  }
})();
for (const f of trackedRunArtifacts) offenses.push(`${f}  (dispatch run artifact — gitignore it)`);

if (offenses.length > 0) {
  console.error(`ENGINE PURITY: FAIL — ${offenses.length} entity-content file(s) in the engine repo:`);
  for (const o of offenses.sort()) console.error(`  ${o}`);
  console.error("\nEntity content belongs in the nirvana-packs repo, never in the engine.");
  process.exit(1);
}
console.log("ENGINE PURITY: OK — no entity content in the engine repo.");
