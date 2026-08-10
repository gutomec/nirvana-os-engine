#!/usr/bin/env bun
/**
 * uninstall-engine.ts — remove the Nirvana-OS ENGINE (Layer 1).
 *
 * Removes: audit hooks (via the hook uninstaller), the per-runtime skill
 * entries we created — symlinks AND copies (restoring any pre-Nirvana backup) —
 * the CLI dispatchers in ~/.local/bin, and the shared engine tree
 * (~/.nirvana/skills + node_modules).
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
import { existsSync, lstatSync, readlinkSync, rmSync, renameSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
// Same list the installer wires — see skills/_shared/lib/runtime-dirs.ts.
import { RUNTIME_SKILL_DIRS, SKILLS, COPY_MARKER } from "../lib/runtime-dirs.ts";

const HOME = homedir();
const NIRVANA_DIR = join(HOME, ".nirvana");
const NIRVANA_SKILLS = join(NIRVANA_DIR, "skills");
const NIRVANA_DEPS = join(NIRVANA_DIR, "node_modules");
const LOCAL_BIN = join(HOME, ".local", "bin");
const BINARIES = ["nrv", "nrv-gemini", "nrv-hermes"];
// Roots a runtime entry may legitimately point at: the canonical tree, plus the
// legacy pre-~/.nirvana root that machines installed before the migration use.
const OWNED_SKILL_ROOTS = [NIRVANA_SKILLS, join(HOME, ".claude", "skills")];

const DRY = process.argv.includes("--dry");
const tag = DRY ? "[dry] would remove" : "removed";
function rm(p: string): void { if (!DRY) { try { rmSync(p, { recursive: true, force: true }); } catch { /* best-effort */ } } }

/**
 * A symlink is ours when it resolves into one of our skill roots — INCLUDING a
 * dangling one, whose target was already deleted. existsSync() is false for a
 * broken link, so the link itself has to be read (lstat + readlink); otherwise
 * an interrupted or re-run uninstall leaves dead links behind forever.
 */
function ownedSymlink(p: string): boolean {
  let target: string;
  try {
    if (!lstatSync(p).isSymbolicLink()) return false;
    target = resolve(dirname(p), readlinkSync(p));
  } catch { return false; }
  return OWNED_SKILL_ROOTS.some((root) => target === root || target.startsWith(root + sep));
}

/**
 * A directory is ours when it carries the marker the installer writes into every
 * COPY it makes (Windows, Codex, --copy-skills). Without this check the
 * uninstaller removed nothing at all on Windows and never for Codex.
 */
function ownedCopy(p: string): boolean {
  try { return lstatSync(p).isDirectory() && existsSync(join(p, COPY_MARKER)); } catch { return false; }
}

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

// 2. Per-runtime skill entries — only what WE created: our symlinks (live or
// dangling) and our copies. Anything else at that path is the user's and stays.
// The pre-Nirvana backup is restored after removing either kind.
console.log("[2/4] Runtime skill links");
for (const rtDir of RUNTIME_SKILL_DIRS) {
  for (const s of SKILLS) {
    const linkPath = join(rtDir, s);
    const kind = ownedSymlink(linkPath) ? "symlink" : ownedCopy(linkPath) ? "copy" : null;
    if (!kind) {
      // Report only what actually sits there, so a skipped entry is visible.
      if (existsSync(linkPath)) console.log(`  kept    ${linkPath}  (not ours — left untouched)`);
      continue;
    }
    rm(linkPath);
    const bak = `${linkPath}.pre-nirvana.bak`;
    if (existsSync(bak)) {
      if (!DRY) { try { renameSync(bak, linkPath); } catch { /* best-effort */ } }
      console.log(`  ${tag} ${linkPath}  (${kind}, restored pre-Nirvana backup)`);
    } else {
      console.log(`  ${tag} ${linkPath}  (${kind})`);
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
