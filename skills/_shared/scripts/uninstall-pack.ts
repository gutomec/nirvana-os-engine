#!/usr/bin/env bun
/**
 * uninstall-pack.ts — removes an installed paid pack, 100% LOCAL (no server),
 * based on the ~/.nirvana/packs/<slug>.json manifest. It is what
 * `nrv uninstall <slug> --kind=pack` calls.
 *
 * Preserves the user's WORK: run-state dirs (projects/, outputs/,
 * memory/, .squad-state, …) inside each component stay; only the pack's
 * content (squad/business/mind-clone definitions) is removed. Use --dry to preview.
 *
 *   nrv uninstall <slug> --kind=pack [--dry]
 */
import { existsSync, readFileSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = homedir();
const SQUADS_DIR = join(HOME, "squads");
const BUSINESSES_DIR = join(HOME, "businesses");
const DNA_DIR = join(BUSINESSES_DIR, "_library/dna");
const PACKS_DIR = join(HOME, ".nirvana", "packs");

const args = process.argv.slice(2);
const DRY = args.includes("--dry");
const slug = args.find((a) => !a.startsWith("-")) || null;

if (!slug) { console.error("uso: nrv uninstall <slug> --kind=pack [--dry]"); process.exit(2); }

const manifestPath = join(PACKS_DIR, `${slug}.json`);
if (!existsSync(manifestPath)) {
  console.error(`uninstall-pack: pack '${slug}' não está instalado (sem ${manifestPath}).`);
  process.exit(1);
}

interface Manifest { squads?: Record<string, string>; businesses?: Record<string, string>; "mind-clones"?: Record<string, string>; }
const man: Manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

// Preserved run-state dirs (1st segment of install-content's RUNSTATE_EXCLUDES).
const KEEP: Record<string, Set<string>> = {
  squads: new Set(["projects", "outputs", ".squad-state", ".squads-outputs", ".wiki-brain-state", ".vercel", ".omc", "_internal"]),
  businesses: new Set(["memory", ".squad-state", ".squads-outputs", ".vercel"]),
  "mind-clones": new Set(),
};
const ROOT: Record<string, string> = { squads: SQUADS_DIR, businesses: BUSINESSES_DIR, "mind-clones": DNA_DIR };

const tag = DRY ? "[dry] removeria" : "removido";
let removed = 0, kept = 0;

for (const kind of ["squads", "businesses", "mind-clones"] as const) {
  const comps = man[kind] ?? {};
  const keep = KEEP[kind];
  for (const comp of Object.keys(comps)) {
    const dir = join(ROOT[kind], comp);
    if (!existsSync(dir)) continue;
    // Deletes everything except the top-level run-state dirs.
    let entries: string[] = [];
    try { entries = readdirSync(dir); } catch { continue; }
    if (!DRY) {
      for (const e of entries) { if (!keep.has(e)) { try { rmSync(join(dir, e), { recursive: true, force: true }); } catch { /* ignore */ } } }
    }
    // businesses/memory/ holds the pack baseline + the user's projects/. Preserves
    // ONLY projects/ (= install-content's runstate); the pack baseline goes.
    const memDir = join(dir, "memory");
    if (kind === "businesses" && existsSync(memDir)) {
      for (const e of readdirSync(memDir)) {
        if (e === "projects") continue;
        if (!DRY) { try { rmSync(join(memDir, e), { recursive: true, force: true }); } catch { /* ignore */ } }
      }
      if (!DRY) { try { if (readdirSync(memDir).length === 0) rmSync(memDir, { recursive: true, force: true }); } catch { /* ignore */ } }
    }
    // Run-state actually preserved (read from disk after the prune; predicted on --dry).
    const survivors = DRY
      ? entries.filter((e) => keep.has(e) && !(kind === "businesses" && e === "memory" && !existsSync(join(memDir, "projects"))))
      : (() => { try { return readdirSync(dir); } catch { return []; } })();
    if (survivors.length === 0) {
      if (!DRY) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }
      console.log(`  ${tag} ${kind}/${comp}`);
    } else {
      kept++;
      console.log(`  ${tag} ${kind}/${comp}  ${"\x1b[2m"}(mantido run-state: ${survivors.join(", ")})\x1b[0m`);
    }
    removed++;
  }
}

if (!DRY) {
  try { unlinkSync(manifestPath); } catch { /* ignore */ }
  const nrv = join(HOME, ".local", "bin", "nrv");
  if (existsSync(nrv)) { console.log("  re-indexando registries..."); spawnSync(nrv, ["index"], { stdio: "inherit" }); }
}

console.log(`\n${DRY ? "Dry run — nada mudou." : `Pack '${slug}' removido`} (${removed} componente(s)${kept ? `, ${kept} com run-state preservado` : ""}).`);
