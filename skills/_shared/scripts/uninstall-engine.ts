#!/usr/bin/env bun
/**
 * uninstall-engine.ts — remove the Nirvana-OS ENGINE (Layer 1).
 *
 * Removes: audit hooks (via the hook uninstaller), the per-runtime skills
 * symlinks (restoring any pre-Nirvana backup), the CLI dispatchers in
 * ~/.local/bin, and the shared engine tree (~/.nirvana/skills + node_modules).
 *
 * KEEPS (Layer 2 + user data): ~/squads, ~/businesses (your capability library
 * and any installed paid packs), ~/.nirvana/packs/ (pack ownership manifests),
 * ~/.nirvana-license/, and ~/.harness-logs/. Engine and content are independent
 * layers — uninstalling the engine never touches your content.
 *
 * Runs the hook uninstaller FIRST (it lives inside the tree we delete last).
 *
 * Usage:
 *   nrv uninstall --engine        # remove the engine, keep content
 *   nrv uninstall --engine --dry  # report what would be removed, change nothing
 */
import { existsSync, lstatSync, rmSync, renameSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = homedir();
const NIRVANA_DIR = join(HOME, ".nirvana");
const NIRVANA_SKILLS = join(NIRVANA_DIR, "skills");
const NIRVANA_DEPS = join(NIRVANA_DIR, "node_modules");
const LOCAL_BIN = join(HOME, ".local", "bin");
const SKILLS = ["harness", "businesses", "squads", "_shared"];
const BINARIES = ["nrv", "nrv-gemini", "nrv-hermes"];
const RUNTIME_SKILL_DIRS = [
  join(HOME, ".claude/skills"),
  join(HOME, ".codex/skills"),
  join(HOME, ".gemini/skills"),
  join(HOME, ".antigravity/skills"),
];

const DRY = process.argv.includes("--dry");
const tag = DRY ? "[dry] would remove" : "removed";
function isSymlink(p: string): boolean { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } }
function rm(p: string): void { if (!DRY) { try { rmSync(p, { recursive: true, force: true }); } catch { /* best-effort */ } } }

console.log("Nirvana-OS — engine uninstall");
console.log("  removes: hooks, runtime skill links, ~/.local/bin CLI, ~/.nirvana engine tree");
console.log("  keeps:   ~/squads, ~/businesses, installed packs, license, audit logs\n");

// 1. Hooks — run the hook uninstaller while the tree still exists.
const hookInstaller = join(NIRVANA_SKILLS, "_shared", "scripts", "install.ts");
if (existsSync(hookInstaller)) {
  console.log("[1/4] Audit hooks");
  if (DRY) console.log("  [dry] would run the hook uninstaller (Claude / Gemini / Antigravity)");
  else spawnSync(process.execPath, [hookInstaller, "--uninstall"], { stdio: "inherit" });
} else {
  console.log("[1/4] Audit hooks — hook uninstaller not found, skipping");
}

// 2. Per-runtime skill symlinks — only OUR symlinks; restore pre-Nirvana backups.
console.log("[2/4] Runtime skill links");
for (const rtDir of RUNTIME_SKILL_DIRS) {
  for (const s of SKILLS) {
    const linkPath = join(rtDir, s);
    if (isSymlink(linkPath)) {
      rm(linkPath);
      const bak = `${linkPath}.pre-nirvana.bak`;
      if (existsSync(bak)) { if (!DRY) { try { renameSync(bak, linkPath); } catch { /* best-effort */ } } console.log(`  ${tag} ${linkPath}  (restored pre-Nirvana backup)`); }
      else console.log(`  ${tag} ${linkPath}`);
    }
  }
}

// 3. CLI dispatchers.
console.log("[3/4] CLI dispatchers (~/.local/bin)");
for (const bin of BINARIES) {
  for (const f of [join(LOCAL_BIN, bin), join(LOCAL_BIN, `${bin}.cmd`)]) {
    if (existsSync(f)) { rm(f); console.log(`  ${tag} ${f}`); }
  }
}

// 4. Engine tree — skills + shared deps. Keep ~/.nirvana/packs + license if present.
console.log("[4/4] Engine tree (~/.nirvana)");
if (existsSync(NIRVANA_SKILLS)) { rm(NIRVANA_SKILLS); console.log(`  ${tag} ${NIRVANA_SKILLS}`); }
if (existsSync(NIRVANA_DEPS)) { rm(NIRVANA_DEPS); console.log(`  ${tag} ${NIRVANA_DEPS}`); }
// Remove ~/.nirvana entirely only if nothing else lives there (no packs/license/etc.).
try {
  const left = existsSync(NIRVANA_DIR) ? readdirSync(NIRVANA_DIR).filter((e) => e !== ".DS_Store") : [];
  if (left.length === 0 && existsSync(NIRVANA_DIR)) { rm(NIRVANA_DIR); console.log(`  ${tag} ${NIRVANA_DIR} (was empty)`); }
  else if (left.length) console.log(`  kept ${NIRVANA_DIR} (still holds: ${left.join(", ")})`);
} catch { /* best-effort */ }

// Hermes bridge note (wired into ~/.hermes/config.yaml, not removed here).
if (existsSync(join(HOME, ".hermes", "config.yaml"))) {
  console.log("\nNote: if you wired the Hermes bridge, remove the Nirvana entries from");
  console.log("  ~/.hermes/config.yaml (skills.external_dirs + hooks) manually.");
}

console.log(`\n${DRY ? "Dry run complete — nothing changed." : "Done. Engine removed; your content was kept."}`);
console.log("Reinstall anytime:  npx @nirvana-os/cli");
