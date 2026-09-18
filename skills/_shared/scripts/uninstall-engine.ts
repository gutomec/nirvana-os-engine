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
import { existsSync, lstatSync, rmSync, renameSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
// Same list the installer wires — see skills/_shared/lib/runtime-dirs.ts.
import { LEGACY_RUNTIME_SKILL_DIRS, RUNTIME_SKILL_DIRS, SKILLS, RETIRED_SKILLS } from "../lib/runtime-dirs.ts";
import { classifyRuntimeEntry, findParkedBackup, foreignProvider } from "../lib/runtime-install.ts";

const HOME = homedir();
const NIRVANA_DIR = join(HOME, ".nirvana");
const NIRVANA_SKILLS = join(NIRVANA_DIR, "skills");
const NIRVANA_DEPS = join(NIRVANA_DIR, "node_modules");
const LOCAL_BIN = join(HOME, ".local", "bin");
const BINARIES = ["nrv", "nrv-gemini", "nrv-hermes"];
// Roots a runtime entry may legitimately point at: the canonical tree, plus the
// legacy pre-~/.nirvana root that machines installed before the migration use.
const OWNED_SKILL_ROOTS = [NIRVANA_SKILLS, join(HOME, ".claude", "skills")];
function isSymlinkEntry(p: string): boolean {
  try { return lstatSync(p).isSymbolicLink(); } catch { return false; }
}

const DRY = process.argv.includes("--dry");
const tag = DRY ? "[dry] would remove" : "removed";
function rm(p: string): void { if (!DRY) { try { rmSync(p, { recursive: true, force: true }); } catch { /* best-effort */ } } }

// Ownership lives in _shared/lib/runtime-install.ts (classifyRuntimeEntry), the
// same answer the installer gives: our symlink — a DANGLING one included, since
// existsSync() is false for a broken link — or a copy carrying COPY_MARKER.
// Without the copy rule the uninstaller removed nothing on Windows and never for
// Codex; without the dangling rule an interrupted uninstall left dead links.

console.log("Nirvana-OS — engine uninstall");
console.log("  removes: hooks, runtime skill links, ~/.local/bin CLI, ~/.nirvana engine tree");
console.log("  keeps:   ~/squads, ~/businesses, installed packs, license, audit logs\n");

// 1. Hooks — run the hook uninstaller while the tree still exists.
const hookInstaller = join(NIRVANA_SKILLS, "_shared", "scripts", "install.ts");
if (existsSync(hookInstaller)) {
  console.log("[1/4] Audit hooks");
  if (DRY) console.log("  [dry] would run the hook uninstaller (Claude / Gemini / Antigravity)");
  else spawnSync(process.execPath, [hookInstaller, "--uninstall"], { windowsHide: true, stdio: "inherit" });
} else {
  console.log("[1/4] Audit hooks — hook uninstaller not found, skipping");
}

// 2. Per-runtime skill entries — only what WE created: our symlinks (live or
// dangling) and our copies. Anything else at that path is the user's and stays.
// The pre-Nirvana backup is restored after removing either kind.
console.log("[2/4] Runtime skill links");
// Retired names are swept too: a machine that never reinstalled after a rename
// still has our old entry, and this is the last chance to remove it.
for (const rtDir of [...RUNTIME_SKILL_DIRS, ...LEGACY_RUNTIME_SKILL_DIRS.map((l) => l.skillsDir)]) {
  for (const s of [...SKILLS, ...RETIRED_SKILLS]) {
    const linkPath = join(rtDir, s);
    // The same skill placed here by another installer (skills.sh): its relative
    // symlink can resolve under the legacy ~/.claude/skills root and look like
    // ours. It is not ours to remove.
    if (foreignProvider(linkPath, s, NIRVANA_SKILLS)) {
      console.log(`  kept    ${linkPath}  (provided by another installer — left untouched)`);
      continue;
    }
    const cls = classifyRuntimeEntry(linkPath, OWNED_SKILL_ROOTS);
    const kind = cls !== "ours" ? null : isSymlinkEntry(linkPath) ? "symlink" : "copy";
    if (!kind) {
      // Report only what actually sits there, so a skipped entry is visible.
      if (existsSync(linkPath)) console.log(`  kept    ${linkPath}  (not ours — left untouched)`);
      continue;
    }
    rm(linkPath);
    const bak = findParkedBackup(linkPath);
    if (bak) {
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
