#!/usr/bin/env bun
/**
 * index.ts — rebuild the harness routing index (squads + businesses + mind-clones).
 *
 * Previously this wrapper invoked `node lib/registry-loader.js`, which is a
 * read-only library with no `main` entry — every call was a silent no-op,
 * leaving registries stale for days. This version delegates to the actual
 * indexer scripts and surfaces their output.
 *
 * Usage:
 *   nrv index                         # rebuild both, summary on stdout
 *   nrv index --if-stale              # skip a target when its registry is newer than every manifest
 *   nrv index --quiet                 # silence per-skill summaries, only emit final tally
 *   nrv index --json                  # emit machine-readable JSON to stdout
 *   nrv index squads | businesses | clones   # rebuild only one
 *
 * Exit codes:
 *   0  both registries rebuilt cleanly
 *   1  at least one indexer failed
 *   2  bad CLI usage
 */

import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { spawnSync } from "node:child_process";
import { paths, EXIT, BUN_BIN } from "../../_shared/lib/bun-helpers.ts";
import { resolveScope } from "../../_shared/lib/scope.ts";

const args = process.argv.slice(2);
const quiet = args.includes("--quiet") || args.includes("-q");
const jsonOut = args.includes("--json");
const ifStale = args.includes("--if-stale");
const targets = args.filter(a => !a.startsWith("-"));
const want = (t: string) => targets.length === 0 || targets.includes(t);

// Use the currently-running bun binary (BUN_BIN = process.execPath). The old
// `endsWith("/bun")` check was POSIX-only: on Windows execPath ends with
// `\bun.exe`, so it fell back to the bare "bun" and spawnSync failed with ENOENT
// whenever bun wasn't on PATH — the root cause of `nrv index` failing on Windows.
const BUN = BUN_BIN;

function runIndexer(label: string, scriptRelPath: string) {
  const start = Date.now();
  // Prefer the skills tree this script is actually running from (dev repo or
  // installed copy) so a newer engine never dispatches into a stale install;
  // fall back to the configured skills dir for exotic layouts.
  const runningSkillsRoot = path.resolve(import.meta.dir, "..", "..");
  const script = [
    path.join(runningSkillsRoot, scriptRelPath),
    path.join(paths.CLAUDE_SKILLS_DIR, scriptRelPath),
  ].find(p => fs.existsSync(p));
  if (!script) {
    return { label, ok: false, ms: 0, error: `indexer script missing: ${path.join(runningSkillsRoot, scriptRelPath)}`, stdout: "", stderr: "" };
  }
  const childArgs = [script];
  if (quiet) childArgs.push("--quiet");
  if (jsonOut) childArgs.push("--json");
  const r = spawnSync(BUN, childArgs, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  const ms = Date.now() - start;
  return {
    label,
    ok: r.status === 0,
    code: r.status ?? -1,
    ms,
    // Surface spawn errors (e.g. ENOENT when bun can't be launched) instead of
    // masking them as a bare "exit -1" with no cause.
    error: r.error ? `${r.error.message}` : undefined,
    stdout: r.stdout || "",
    stderr: r.stderr || "",
  };
}

// ── --if-stale staleness check ───────────────────────────────────────────
// A registry file newer than every manifest under its roots means the indexer
// has nothing new to see — skip it. Roots mirror what each indexer actually
// scans: squads → squads/lib/registry.js _computeDefaultRoots(), businesses →
// scope.businessDirs (index-businesses.ts), clones → scope.mindCloneDirs
// (index-clones.ts, which also reads the legacy nested layout → depth 2).

/**
 * Newest mtime among: each root dir, each asset dir under it, and each named
 * manifest file inside those dirs (dir mtimes catch added/removed assets;
 * manifest mtimes catch edits). Returns -1 when nothing exists. Pure — no
 * side effects; exported for tests.
 */
export function newestManifestMtime(roots: string[], manifestNames: string[], depth = 1): number {
  let newest = -1;
  const consider = (p: string) => {
    try { const m = fs.statSync(p).mtimeMs; if (m > newest) newest = m; } catch { /* missing */ }
  };
  const walk = (dir: string, level: number) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".")) continue;
      const sub = path.join(dir, e.name);
      consider(sub);
      for (const name of manifestNames) consider(path.join(sub, name));
      if (level < depth) walk(sub, level + 1);
    }
  };
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    consider(root);
    walk(root, 1);
  }
  return newest;
}

/**
 * A registry is fresh when it exists and is strictly newer than the newest
 * manifest. Missing registry → stale. No manifests at all (newest = -1) →
 * fresh (there is nothing new to index). Pure; exported for tests.
 */
export function registryIsFresh(registryPath: string, newestManifest: number): boolean {
  let regMtime: number;
  try { regMtime = fs.statSync(registryPath).mtimeMs; } catch { return false; }
  if (newestManifest < 0) return true;
  return regMtime > newestManifest;
}

// Squads roots — mirror of squads/lib/registry.js _computeDefaultRoots().
function squadsRoots(): string[] {
  const mode = paths.NIRVANA_SCOPE_MODE || "global";
  const projectRoot = paths.NIRVANA_PROJECT_ROOT;
  const projectSquads = projectRoot
    ? (process.env.NIRVANA_PROJECT_SQUADS_DIR || path.join(projectRoot, ".nirvana", "squads"))
    : null;
  if (mode === "project" && projectSquads) return [projectSquads];
  const roots = [paths.SQUADS_LEGACY_DIR, paths.SQUADS_DIR];
  if (mode === "merge" && projectSquads) roots.push(projectSquads);
  roots.push(path.join(process.cwd(), "squads"));
  return roots;
}

export type RegistryTarget = "squads" | "businesses" | "clones";

/**
 * Registry path + newest content mtime for one target. Mirrors what each
 * indexer actually scans (see the --if-stale note above). Mtime stats only —
 * cheap enough for the route-entrypoint pre-flight (lib/preflight-index.ts).
 * Exported for tests and for the pre-flight.
 */
export function stalenessTarget(label: RegistryTarget): { registry: string; newest: number } {
  if (label === "squads") {
    return { registry: paths.SQUADS_REGISTRY_PATH, newest: newestManifestMtime(squadsRoots(), ["squad.yaml"]) };
  }
  if (label === "businesses") {
    const scope = resolveScope();
    const roots = scope.businessDirs.length > 0 ? scope.businessDirs : [paths.BUSINESSES_DIR];
    return { registry: paths.BUSINESSES_REGISTRY_PATH, newest: newestManifestMtime(roots, ["business.yaml"]) };
  }
  const scope = resolveScope();
  const roots = scope.mindCloneDirs.length > 0 ? scope.mindCloneDirs : [paths.DNA_LIBRARY];
  const registry = scope.projectRoot
    ? path.join(scope.projectRoot, ".nirvana", ".mind-clones-registry.json")
    : path.join(os.homedir(), ".nirvana", ".mind-clones-registry.json");
  return { registry, newest: newestManifestMtime(roots, ["MANIFEST.yaml", "manifest.yaml"], 2) }; // depth 2: legacy nested layout
}

/** True when every routing registry is newer than its content roots. */
export function allRegistriesFresh(): boolean {
  return (["squads", "businesses", "clones"] as const).every((label) => {
    const t = stalenessTarget(label);
    return registryIsFresh(t.registry, t.newest);
  });
}

/** Returns a skip result when --if-stale finds the target's registry fresh, else null. */
function maybeSkip(label: RegistryTarget): any | null {
  if (!ifStale) return null;
  const t = stalenessTarget(label);
  if (!registryIsFresh(t.registry, t.newest)) return null;
  return { label, ok: true, skipped: true, code: 0, ms: 0, stdout: "", stderr: "" };
}

if (import.meta.main) {
  const results: any[] = [];
  if (want("squads"))     results.push(maybeSkip("squads")     ?? runIndexer("squads",     "squads/scripts/index-squads.ts"));
  if (want("businesses")) results.push(maybeSkip("businesses") ?? runIndexer("businesses", "businesses/scripts/index-businesses.ts"));
  if (want("clones") || want("mind-clones")) results.push(maybeSkip("clones") ?? runIndexer("clones", "_shared/scripts/index-clones.ts"));
  // Step 4: derive .routing-digest.md + .keyword-aliases.json from the three
  // registries (only when at least one of them actually rebuilt this run).
  if (want("digest") || results.some(r => r.ok && !r.skipped)) results.push(runIndexer("digest", "harness/scripts/build-routing-digest.ts"));

  if (jsonOut) {
    console.log(JSON.stringify({
      ok: results.every(r => r.ok),
      results: results.map(r => ({ label: r.label, ok: r.ok, skipped: !!r.skipped, code: r.code, ms: r.ms, stdout: r.stdout, stderr: r.stderr })),
    }, null, 2));
  } else {
    for (const r of results) {
      if (!quiet && r.stdout.trim()) {
        process.stdout.write(r.stdout);
        if (!r.stdout.endsWith("\n")) process.stdout.write("\n");
      }
      if (r.stderr.trim()) process.stderr.write(r.stderr);
      if (!r.ok) {
        console.error(`[index] ✗ ${r.label} failed (exit ${r.code}, ${r.ms}ms)${r.error ? " — " + r.error : ""}`);
      } else if (!quiet) {
        // --quiet suppresses per-target success lines (the documented "only
        // emit final tally" behavior); failures always print above.
        console.log(r.skipped
          ? `[index] ✓ ${r.label} up to date (registry newer than manifests) — skipped`
          : `[index] ✓ ${r.label} rebuilt in ${r.ms}ms`);
      }
    }
    const totalMs = results.reduce((s, r) => s + r.ms, 0);
    const failed = results.filter(r => !r.ok).length;
    console.log(`[index] ${results.length - failed}/${results.length} ok · ${totalMs}ms total`);
  }

  process.exit(results.every(r => r.ok) ? EXIT.OK : EXIT.FAILURES);
}
