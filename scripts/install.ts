#!/usr/bin/env bun
/**
 * Nirvana OS bootstrap installer.
 *
 * Copies the skills tree into ~/.claude/skills/ and the CLI dispatchers
 * into ~/.local/bin/, then runs the hook installer (skills/_shared/scripts/install.ts)
 * to wire audit hooks into Claude Code and Gemini-CLI idempotently.
 *
 * Re-running is safe (idempotent). Existing user settings are preserved.
 *
 * Usage:
 *   bun scripts/install.ts
 */

import { cpSync, existsSync, mkdirSync, chmodSync, readdirSync, rmSync, writeFileSync, readFileSync, statSync, symlinkSync, lstatSync, renameSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve, relative, sep } from "node:path";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { createRequire } from "node:module";

const requireCjs = createRequire(import.meta.url);
const HOME = homedir();
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_DIR = resolve(SCRIPT_DIR, "..");
const LOCAL_BIN = join(HOME, ".local/bin");
const SQUADS_DIR = join(HOME, "squads");
const BUSINESSES_DIR = join(HOME, "businesses");
const DNA_DIR = join(BUSINESSES_DIR, "_library/dna");
const STARTER_PACK = join(REPO_DIR, "starter-pack");

// Canonical SHARED location — the skills tree + deps live ONCE under ~/.nirvana
// so every runtime (claude-code, codex, antigravity, gemini, hermes) shares one
// copy and the system survives removal of any single runtime, including Claude
// Code. Each runtime consumes the tree via per-entry symlinks.
const NIRVANA_DIR = join(HOME, ".nirvana");
const NIRVANA_SKILLS = join(NIRVANA_DIR, "skills");
const NIRVANA_DEPS = join(NIRVANA_DIR, "node_modules");
const RUNTIME_SKILL_DIRS = [
  join(HOME, ".claude/skills"),     // primary — always linked
  join(HOME, ".codex/skills"),
  join(HOME, ".gemini/skills"),
  join(HOME, ".antigravity/skills"),
];

const SKILLS = ["harness", "businesses", "squads", "_shared", "nirvana-os"];
const BINARIES = ["nrv", "nrv-gemini", "nrv-hermes"];
const IS_WINDOWS = process.platform === "win32";

const args = process.argv.slice(2);
const FLAG_CHECK = args.includes("--check");
const FLAG_STARTER = args.includes("--starter");
const FLAG_NO_STARTER = args.includes("--no-starter");
const FLAG_DRY = args.includes("--dry");
const FLAG_NO_INDEX = args.includes("--no-index");
const FLAG_WITH_HERMES = args.includes("--with-hermes");
const FLAG_NO_HERMES = args.includes("--no-hermes");
const FLAG_NO_HERMES_HOOKS = args.includes("--no-hermes-hooks");

function header(): void {
  console.log("Nirvana OS installer");
  console.log(`  source:        ${REPO_DIR}`);
  console.log(`  skills target: ${NIRVANA_SKILLS}`);
  console.log(`  deps target:   ${NIRVANA_DEPS}`);
  console.log(`  bin target:    ${LOCAL_BIN}`);
  console.log();
}

function hasCmd(cmd: string): boolean {
  try {
    return spawnSync(cmd, ["--version"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

let RSYNC_AVAILABLE = false;

// Nirvana-OS runs on Bun alone. rsync is preferred (fast incremental) but
// optional — copySkills falls back to a pure-Node copy. python3 is only needed
// for legacy/optional tooling, so it is a note, not a hard requirement. This
// keeps the installer working on clean Linux and Windows machines.
function preflight(): void {
  if (!hasCmd("python3")) {
    console.log("  note: python3 not found — that's fine, the toolchain runs on Bun.");
  }
  RSYNC_AVAILABLE = hasCmd("rsync");
  if (!RSYNC_AVAILABLE) {
    console.log("  note: rsync not found — using a built-in copy (works on Windows/clean Linux).");
  }
}

function copySkills(): void {
  console.log("[1/4] Copying skills tree → ~/.nirvana/skills ...");
  mkdirSync(NIRVANA_SKILLS, { recursive: true });
  for (const skill of SKILLS) {
    const src = join(REPO_DIR, "skills", skill);
    const dst = join(NIRVANA_SKILLS, skill);
    if (!existsSync(src)) {
      console.log(`  ! missing: ${src} — skipping`);
      continue;
    }
    if (RSYNC_AVAILABLE) {
      const r = spawnSync(
        "rsync",
        [
          "-a",
          "--delete",
          "--exclude=.DS_Store",
          "--exclude=node_modules",
          "--exclude=*.bak.*",
          `${src}/`,
          `${dst}/`,
        ],
        { stdio: ["ignore", "inherit", "inherit"] },
      );
      if (r.status !== 0) {
        console.error(`  ✗ rsync failed for ${skill}`);
        process.exit(1);
      }
    } else {
      // Pure-Node fallback (Windows / clean Linux without rsync). Emulate
      // --delete by clearing the destination first, then copy with a filter.
      rmSync(dst, { recursive: true, force: true });
      cpSync(src, dst, {
        recursive: true,
        filter: (s) =>
          !s.split(/[\\/]/).includes("node_modules") &&
          !s.endsWith(".DS_Store") &&
          !/\.bak\./.test(s),
      });
    }
    console.log(`  ✓ ${skill}`);
  }
  // Root-level loose files in skills/ (e.g. VERSION, EDITION) — copied verbatim
  // so `nrv --version` can read the pack version + edition label from the
  // installed skills dir. EDITION is absent in the full pack (defaults to
  // "Genesis Circle") and present in the free edition.
  for (const f of ["VERSION", "EDITION"]) {
    const src = join(REPO_DIR, "skills", f);
    if (existsSync(src)) {
      cpSync(src, join(NIRVANA_SKILLS, f));
      console.log(`  ✓ ${f}`);
    }
  }
}

function isSymlink(p: string): boolean {
  try { return lstatSync(p).isSymbolicLink(); } catch { return false; }
}

// Install the shared deps ONCE into ~/.nirvana/node_modules and symlink the tree
// root (+ each skill) so bare `require('yaml')` / `import "zod"` resolve from any
// file under any runtime's symlinked skills dir.
function installDeps(): void {
  console.log("[2/4] Installing shared deps → ~/.nirvana/node_modules ...");
  mkdirSync(NIRVANA_DEPS, { recursive: true });
  const bunBin = hasCmd("bun") ? "bun" : (existsSync(join(HOME, ".bun/bin/bun")) ? join(HOME, ".bun/bin/bun") : "bun");
  // Install into the pack repo (it carries package.json), then copy node_modules
  // to the shared location. Keeps ~/.nirvana free of a package.json that scope.ts
  // could mistake for a project root.
  const repoNM = join(REPO_DIR, "node_modules");
  if (!existsSync(repoNM)) {
    spawnSync(bunBin, ["install", "--no-save"], { cwd: REPO_DIR, stdio: ["ignore", "inherit", "inherit"] });
  }
  if (existsSync(repoNM)) {
    try { cpSync(repoNM, NIRVANA_DEPS, { recursive: true, dereference: false }); console.log("  ✓ deps in ~/.nirvana/node_modules"); }
    catch { console.log("  ! could not copy deps — run 'bun install' in the pack, then copy node_modules to ~/.nirvana/"); }
  } else {
    console.log("  ! bun install did not produce node_modules — run 'bun install' in the pack manually.");
  }
  const linkDeps = (p: string) => {
    try {
      if (isSymlink(p) || existsSync(p)) rmSync(p, { recursive: true, force: true });
      symlinkSync(NIRVANA_DEPS, p, IS_WINDOWS ? "junction" : undefined);
    } catch { /* best-effort */ }
  };
  linkDeps(join(NIRVANA_SKILLS, "node_modules"));
  for (const s of SKILLS) linkDeps(join(NIRVANA_SKILLS, s, "node_modules"));
}

// Point every installed runtime at the ONE shared skills tree via per-entry
// symlinks (matches how codex/gemini already consume it). A pre-existing REAL
// dir from a legacy install is backed up, never destroyed.
function linkRuntimes(): void {
  console.log("[4/4] Linking runtimes → shared skills tree ...");
  const claudePrimary = join(HOME, ".claude/skills");
  for (const rtDir of RUNTIME_SKILL_DIRS) {
    const isClaude = rtDir === claudePrimary;
    if (!isClaude && !existsSync(dirname(rtDir))) continue; // runtime not installed
    mkdirSync(rtDir, { recursive: true });
    for (const s of SKILLS) {
      const linkPath = join(rtDir, s);
      const target = join(NIRVANA_SKILLS, s);
      try {
        if (isSymlink(linkPath)) {
          rmSync(linkPath, { force: true });
        } else if (existsSync(linkPath)) {
          const bak = `${linkPath}.pre-nirvana.bak`;
          if (!existsSync(bak)) renameSync(linkPath, bak);
          else rmSync(linkPath, { recursive: true, force: true });
        }
        symlinkSync(target, linkPath, IS_WINDOWS ? "junction" : undefined);
      } catch { console.log(`  ! could not link ${linkPath}`); }
    }
    console.log(`  ✓ ${rtDir}`);
  }
}

// Windows launcher. PowerShell/cmd cannot run the bash `nrv` script directly
// (no extension, shebang not honored) — they error "Cannot run a document".
// We drop a `<bin>.cmd` next to it that delegates to Git Bash. Git Bash is
// resolved EXPLICITLY (common install dirs, then derived from `where git`); we
// never call the bare `bash` on PATH, because on Windows that usually resolves
// to the WSL stub in WindowsApps, which is the wrong shell.
function windowsLauncher(binName: string): string {
  return [
    "@echo off",
    "setlocal enabledelayedexpansion",
    'set "GB="',
    'for %%P in ("%ProgramFiles%\\Git\\bin\\bash.exe" "%ProgramFiles(x86)%\\Git\\bin\\bash.exe" "%LOCALAPPDATA%\\Programs\\Git\\bin\\bash.exe") do (',
    '  if not defined GB if exist "%%~P" set "GB=%%~P"',
    ")",
    "if not defined GB for /f \"delims=\" %%G in ('where git 2^>nul') do (",
    '  if not defined GB if exist "%%~dpG..\\bin\\bash.exe" set "GB=%%~dpG..\\bin\\bash.exe"',
    ")",
    "if not defined GB (",
    "  echo nrv requires Git for Windows ^(Git Bash^). Install: https://git-scm.com/download/win",
    "  exit /b 1",
    ")",
    `"!GB!" "%~dp0${binName}" %*`,
    "",
  ].join("\r\n");
}

// Windows launcher for `nrv` that needs ONLY Bun — no Git Bash / WSL. Runs the
// cross-platform dispatcher (skills/harness/scripts/nrv.ts) directly via Bun.
function windowsLauncherNrv(): string {
  return [
    "@echo off",
    "setlocal",
    'set "NRVTS=%USERPROFILE%\\.claude\\skills\\harness\\scripts\\nrv.ts"',
    'set "BUN=bun"',
    'where bun >nul 2>nul || set "BUN=%USERPROFILE%\\.bun\\bin\\bun.exe"',
    'if not exist "%BUN%" if /I not "%BUN%"=="bun" (',
    "  echo nrv requires Bun. Install: https://bun.sh",
    "  exit /b 1",
    ")",
    '"%BUN%" "%NRVTS%" %*',
    "",
  ].join("\r\n");
}

function copyBinaries(): void {
  console.log();
  console.log("[2/3] Copying CLI dispatchers...");
  mkdirSync(LOCAL_BIN, { recursive: true });
  for (const bin of BINARIES) {
    const src = join(REPO_DIR, "bin", bin);
    const dst = join(LOCAL_BIN, bin);
    if (!existsSync(src)) {
      console.log(`  ! missing: ${src} — skipping`);
      continue;
    }
    cpSync(src, dst);
    chmodSync(dst, 0o755);
    if (IS_WINDOWS) {
      // ASCII, CRLF, no BOM — so cmd parses it cleanly. `nrv` runs via Bun
      // directly (no Git Bash); `nrv-gemini` keeps the Git Bash delegation
      // (its fs-watch trap logic is bash-specific).
      const launcher = bin === "nrv" ? windowsLauncherNrv() : windowsLauncher(bin);
      writeFileSync(dst + ".cmd", launcher, { encoding: "ascii" });
    }
  }
  console.log(`  ✓ ${BINARIES.join(", ")}${IS_WINDOWS ? " (+ .cmd launchers — nrv via Bun, no Git Bash needed)" : ""}`);

  const sep = IS_WINDOWS ? ";" : ":";
  const pathParts = (process.env.PATH ?? "").split(sep);
  if (!pathParts.includes(LOCAL_BIN)) {
    console.log();
    console.log(`  ⚠ ${LOCAL_BIN} is not on PATH.`);
    if (IS_WINDOWS) {
      console.log("    Add it (PowerShell), then open a NEW terminal:");
      console.log('      setx PATH "%USERPROFILE%\\.local\\bin;%PATH%"');
    } else {
      console.log("    Add this to your ~/.zshrc or ~/.bashrc:");
      console.log('      export PATH="$HOME/.local/bin:$PATH"');
    }
  }
}

function wireHooks(): void {
  console.log();
  console.log("[3/3] Wiring audit hooks...");
  const hookInstaller = join(NIRVANA_SKILLS, "_shared/scripts/install.ts");
  if (!existsSync(hookInstaller)) {
    console.log(`  ! hook installer not found at ${hookInstaller} — skipping`);
    return;
  }
  const r = spawnSync(process.execPath, [hookInstaller], { stdio: "inherit" });
  if (r.status !== 0) {
    console.log("  ! hook installer reported issues — run 'nrv install --check' to inspect");
  }
}

function isLibraryEmpty(dir: string, candidateNames: string[]): boolean {
  if (!existsSync(dir)) return true;
  const entries = readdirSync(dir).filter((e) => !e.startsWith(".") && e !== "_library");
  if (entries.length === 0) return true;
  const overlapping = entries.filter((e) => candidateNames.includes(e));
  return overlapping.length === entries.length && entries.length === 0;
}

interface StarterAvailability {
  squads_empty: boolean;
  businesses_empty: boolean;
  mind_clones_empty: boolean;
  available_squads: string[];
  available_businesses: string[];
  available_mind_clones: string[];
}

function detectStarterAvailability(): StarterAvailability {
  const starterSquadsDir = join(STARTER_PACK, "squads");
  const starterBusinessesDir = join(STARTER_PACK, "businesses");
  const starterMindClonesDir = join(STARTER_PACK, "mind-clones");

  const availableSquads = existsSync(starterSquadsDir)
    ? readdirSync(starterSquadsDir).filter((e) => !e.startsWith(".") && existsSync(join(starterSquadsDir, e, "squad.yaml")))
    : [];
  const availableBusinesses = existsSync(starterBusinessesDir)
    ? readdirSync(starterBusinessesDir).filter((e) => !e.startsWith(".") && existsSync(join(starterBusinessesDir, e, "business.yaml")))
    : [];
  const availableMindClones = existsSync(starterMindClonesDir)
    ? readdirSync(starterMindClonesDir).filter((e) => !e.startsWith(".") && e !== "README.md" && existsSync(join(starterMindClonesDir, e, "MANIFEST.yaml")))
    : [];

  return {
    squads_empty: isLibraryEmpty(SQUADS_DIR, availableSquads),
    businesses_empty: isLibraryEmpty(BUSINESSES_DIR, availableBusinesses),
    mind_clones_empty: !existsSync(DNA_DIR) || readdirSync(DNA_DIR).filter((e) => !e.startsWith(".")).length === 0,
    available_squads: availableSquads,
    available_businesses: availableBusinesses,
    available_mind_clones: availableMindClones,
  };
}

async function promptYesNo(question: string, defaultYes = true): Promise<boolean> {
  if (!process.stdin.isTTY) return defaultYes;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const suffix = defaultYes ? " [Y/n] " : " [y/N] ";
  return new Promise((resolve) => {
    rl.question(question + suffix, (answer) => {
      rl.close();
      const a = answer.trim().toLowerCase();
      if (a === "") resolve(defaultYes);
      else resolve(a === "y" || a === "yes" || a === "s" || a === "sim");
    });
  });
}

// ── Pack sync (additive-merge with full per-component replace) ─────────────
// The pack is the source of truth. On (re)install each pack component fully
// REPLACES its installed copy (changed files in, removed files out), NEW
// components are added, and components dropped from the pack are removed — but
// removal is scoped to PACK-OWNED components (tracked in the manifest), so the
// squads/businesses/clones the USER created (via NSC/FdG/NBC) are never touched.
// User run-state inside a component (projects/, outputs/, memory/projects/, …)
// is preserved across the replace.

const PACK_MANIFEST = join(HOME, ".nirvana-pack.json");

const RUNSTATE_EXCLUDES: Record<string, string[]> = {
  squads: ["projects", "outputs", ".squad-state", ".squads-outputs", ".wiki-brain-state", ".vercel", ".omc", "_internal"],
  businesses: ["memory/projects", ".squad-state", ".squads-outputs", ".vercel"],
  "mind-clones": [],
};

interface PackManifest {
  version?: string; updated_at?: string;
  squads?: Record<string, string>; businesses?: Record<string, string>; "mind-clones"?: Record<string, string>;
}

function listFilesRel(root: string): string[] {
  const out: string[] = [];
  const walk = (d: string, base: string) => {
    for (const e of readdirSync(d)) {
      const abs = join(d, e);
      const rel = base ? `${base}/${e}` : e;
      let st; try { st = statSync(abs); } catch { continue; }
      if (st.isDirectory()) walk(abs, rel);
      else out.push(rel);
    }
  };
  if (existsSync(root)) walk(root, "");
  return out;
}

function isExcluded(rel: string, excludes: string[]): boolean {
  return excludes.some((e) => rel === e || rel.startsWith(e + "/"));
}

function hashDir(dir: string, excludes: string[]): string {
  const h = createHash("sha256");
  for (const rel of listFilesRel(dir).filter((r) => !isExcluded(r, excludes)).sort()) {
    h.update(rel); h.update("\0");
    try { h.update(readFileSync(join(dir, rel))); } catch { /* ignore */ }
  }
  return h.digest("hex");
}

// Mirror src → dst (copy changed/new, delete removed), preserving `excludes`.
function mirrorComponent(src: string, dst: string, excludes: string[]): void {
  mkdirSync(dst, { recursive: true });
  if (RSYNC_AVAILABLE) {
    // --checksum: compare by content, not size+mtime — the pack is the source of
    // truth, so a changed file must always win even if size/mtime coincide.
    const args = ["-a", "--checksum", "--delete"];
    for (const e of excludes) args.push(`--exclude=${e}`);
    args.push(`${src}/`, `${dst}/`);
    const r = spawnSync("rsync", args, { stdio: ["ignore", "ignore", "inherit"] });
    if (r.status === 0) return;
    // fall through to pure-Node on rsync failure
  }
  // Pure-Node mirror (Windows / no rsync): delete dst extras (except excludes), copy src over.
  const srcFiles = new Set(listFilesRel(src));
  for (const rel of listFilesRel(dst)) {
    if (srcFiles.has(rel) || isExcluded(rel, excludes)) continue;
    try { rmSync(join(dst, rel), { force: true }); } catch { /* ignore */ }
  }
  cpSync(src, dst, {
    recursive: true, force: true,
    filter: (s) => { const rel = relative(src, s).split(sep).join("/"); return rel === "" || !isExcluded(rel, excludes); },
  });
}

function loadManifest(): PackManifest {
  try { return JSON.parse(readFileSync(PACK_MANIFEST, "utf8")); } catch { return {}; }
}

interface SyncResult { added: string[]; updated: string[]; unchanged: string[]; removed: string[]; hashes: Record<string, string>; }

function syncKind(kind: string, srcRoot: string, dstRoot: string, available: string[], old: Record<string, string>, dry: boolean): SyncResult {
  const excludes = RUNSTATE_EXCLUDES[kind] ?? [];
  const res: SyncResult = { added: [], updated: [], unchanged: [], removed: [], hashes: {} };
  if (available.length > 0) mkdirSync(dstRoot, { recursive: true });
  for (const slug of available) {
    const src = join(srcRoot, slug);
    const dst = join(dstRoot, slug);
    const h = hashDir(src, excludes);
    res.hashes[slug] = h;
    if (!existsSync(dst)) {
      res.added.push(slug);
      if (!dry) mirrorComponent(src, dst, excludes);
    } else {
      const prev = old[slug] ?? hashDir(dst, excludes);
      if (prev !== h) { res.updated.push(slug); if (!dry) mirrorComponent(src, dst, excludes); }
      else res.unchanged.push(slug);
    }
  }
  // Remove components the pack USED to own but dropped — never user-created ones.
  for (const slug of Object.keys(old)) {
    if (available.includes(slug)) continue;
    const dst = join(dstRoot, slug);
    if (existsSync(dst)) { res.removed.push(slug); if (!dry) rmSync(dst, { recursive: true, force: true }); }
  }
  return res;
}

async function offerStarterPack(): Promise<void> {
  if (FLAG_NO_STARTER) {
    console.log();
    console.log("[4/4] Starter pack: skipped (--no-starter)");
    return;
  }

  const avail = detectStarterAvailability();
  const anyAvailable = avail.available_squads.length > 0 || avail.available_businesses.length > 0 || avail.available_mind_clones.length > 0;
  if (!anyAvailable) {
    console.log();
    console.log("[4/4] Starter pack: skipped — no starter content found in repo.");
    return;
  }

  const manifest = loadManifest();
  const firstRun = !existsSync(PACK_MANIFEST) && avail.squads_empty && avail.businesses_empty && avail.mind_clones_empty;

  console.log();
  console.log("[4/4] Starter pack — syncing (pack is source of truth: replace + add + remove; your run-state and your own creations are kept)");

  // Only prompt on a truly fresh interactive first install without --starter.
  if (!FLAG_STARTER && firstRun) {
    const ok = await promptYesNo("\nInstall the starter pack (squads, businesses, mind-clones) into your libraries?", true);
    if (!ok) {
      console.log(`      Skipped. Install later from: ${STARTER_PACK}/{squads,businesses,mind-clones}/`);
      return;
    }
  }

  const squads = syncKind("squads", join(STARTER_PACK, "squads"), SQUADS_DIR, avail.available_squads, manifest.squads ?? {}, FLAG_DRY);
  const businesses = syncKind("businesses", join(STARTER_PACK, "businesses"), BUSINESSES_DIR, avail.available_businesses, manifest.businesses ?? {}, FLAG_DRY);
  const clones = syncKind("mind-clones", join(STARTER_PACK, "mind-clones"), DNA_DIR, avail.available_mind_clones, manifest["mind-clones"] ?? {}, FLAG_DRY);

  console.log(FLAG_DRY ? "      DRY RUN — would apply:" : "      Applied:");
  const line = (label: string, r: SyncResult) =>
    console.log(`      ${label}: ${r.added.length} new · ${r.updated.length} updated · ${r.unchanged.length} unchanged · ${r.removed.length} removed`);
  line("squads", squads); line("businesses", businesses); line("mind-clones", clones);
  for (const [lbl, r] of [["squads", squads], ["businesses", businesses], ["mind-clones", clones]] as const) {
    for (const s of r.added) console.log(`        + ${lbl}/${s} (new)`);
    for (const s of r.updated) console.log(`        ~ ${lbl}/${s} (updated)`);
    for (const s of r.removed) console.log(`        - ${lbl}/${s} (removed — dropped from pack)`);
  }

  if (!FLAG_DRY) {
    let pkgVersion = "unknown";
    try { pkgVersion = JSON.parse(readFileSync(join(REPO_DIR, "package.json"), "utf8")).version; } catch { /* ignore */ }
    const newManifest: PackManifest = {
      version: pkgVersion,
      updated_at: new Date().toISOString(),
      squads: squads.hashes,
      businesses: businesses.hashes,
      "mind-clones": clones.hashes,
    };
    try { writeFileSync(PACK_MANIFEST, JSON.stringify(newManifest, null, 2) + "\n"); } catch { /* ignore */ }
  }

  const nrvBin = join(LOCAL_BIN, "nrv");
  if (FLAG_DRY) { /* no index on dry-run */ }
  else if (FLAG_NO_INDEX) console.log("      Indexing deferred (--no-index).");
  else if (existsSync(nrvBin)) {
    console.log("      Re-indexing registries...");
    const r = spawnSync(nrvBin, ["index"], { stdio: "inherit" });
    if (r.status !== 0) console.log("      ⚠ nrv index reported issues. Run manually to verify.");
  }
}

// ── Hermes Agent integration (opt-in) ─────────────────────────────────────
// Registers the Nirvana bridge skill into Hermes (skills.external_dirs) and,
// optionally, wires audit hooks (pre/post_tool_call). Both go into
// ~/.hermes/config.yaml. Fresh configs have `external_dirs: []` and `hooks: {}`,
// so we do a surgical text edit of just those lines (zero churn elsewhere). For
// the rare non-empty case we fall back to a yaml-lib round-trip (preserves
// comments + semantics). Idempotent; backs up before writing.

const HERMES_HOME = process.env.HERMES_HOME || join(HOME, ".hermes");
const HERMES_CONFIG = join(HERMES_HOME, "config.yaml");
const HERMES_BRIDGE_DIR = join(NIRVANA_SKILLS, "_shared/adapters/hermes/skills");
const HERMES_HOOK_SHIM = join(NIRVANA_SKILLS, "_shared/scripts/audit-emit-from-hermes-hook.ts");
const HERMES_HOOK_TOKEN = "audit-emit-from-hermes-hook.ts";
const HERMES_ALLOWLIST = join(HERMES_HOME, "shell-hooks-allowlist.json");

function hermesPresent(): boolean {
  try {
    const r = IS_WINDOWS
      ? spawnSync("where", ["hermes"], { stdio: "ignore" })
      : spawnSync("sh", ["-c", "command -v hermes"], { stdio: "ignore" });
    return r.status === 0;
  } catch {
    return false;
  }
}

function loadYamlLib(): any {
  try { return requireCjs("yaml"); } catch { /* try repo node_modules */ }
  try { return requireCjs(join(REPO_DIR, "node_modules", "yaml")); } catch { /* unavailable */ }
  return null;
}

function hermesBackup(raw: string): void {
  if (FLAG_DRY) return;
  try { writeFileSync(`${HERMES_CONFIG}.nirvana-backup.${Date.now()}`, raw, "utf8"); } catch { /* best-effort */ }
}

// Fallback only: full round-trip via the yaml lib (used when the target key is
// non-empty and not ours). Preserves comments + semantics; lineWidth:0 +
// indentSeq:false keeps reformatting churn minimal.
function patchHermesConfigYaml(mutate: (doc: any) => boolean): boolean {
  const YAML = loadYamlLib();
  if (!YAML) { console.log("      ! lib 'yaml' indisponível — pulei (rode 'bun install')."); return false; }
  const raw = readFileSync(HERMES_CONFIG, "utf8");
  const doc = YAML.parseDocument(raw);
  if (!mutate(doc)) return false;
  if (!FLAG_DRY) { hermesBackup(raw); writeFileSync(HERMES_CONFIG, doc.toString({ lineWidth: 0, indentSeq: false }), "utf8"); }
  return true;
}

// Project-skills env entry. Hermes expands ${VAR} in external_dirs and skips
// entries that don't resolve to an existing dir — so this is inert until the
// nrv-hermes wrapper exports NIRVANA_PROJECT_SKILLS=<project>/.agents/skills for
// that session (Tier 3). Per-session, no config mutation per run.
const HERMES_PROJECT_SKILLS_VAR = "${NIRVANA_PROJECT_SKILLS}";

function wireHermesExternalDirs(bridgeDir: string): void {
  if (!existsSync(HERMES_CONFIG)) { console.log("      ! ~/.hermes/config.yaml não encontrado — pulei."); return; }
  const raw = readFileSync(HERMES_CONFIG, "utf8");
  if (raw.includes(bridgeDir) && raw.includes(HERMES_PROJECT_SKILLS_VAR)) {
    console.log("      ✓ external_dirs já configurado (no-op)."); return;
  }
  // Surgical fast-path: empty list `external_dirs: []` (the fresh-config case).
  const emptyRe = /^([ \t]*)external_dirs:[ \t]*\[[ \t]*\][ \t]*$/m;
  const m = raw.match(emptyRe);
  if (m) {
    const ind = m[1];
    const block = `${ind}external_dirs:\n${ind}- ${bridgeDir}\n${ind}- "${HERMES_PROJECT_SKILLS_VAR}"`;
    if (!FLAG_DRY) { hermesBackup(raw); writeFileSync(HERMES_CONFIG, raw.replace(emptyRe, block), "utf8"); }
    console.log("      ✓ external_dirs: ponte + ${NIRVANA_PROJECT_SKILLS} (skills por projeto via nrv-hermes)");
    return;
  }
  // Fallback: non-empty list → yaml-lib merge.
  const did = patchHermesConfigYaml((doc) => {
    const cur = doc.getIn(["skills", "external_dirs"]);
    const arr: any[] = cur && typeof cur.toJSON === "function" ? cur.toJSON() : (Array.isArray(cur) ? cur : []);
    const clean = arr.filter((x) => typeof x === "string");
    const want = [bridgeDir, HERMES_PROJECT_SKILLS_VAR].filter((w) => !clean.includes(w));
    if (!want.length) return false;
    doc.setIn(["skills", "external_dirs"], [...clean, ...want]);
    return true;
  });
  console.log(did ? "      ✓ external_dirs atualizado (merge)." : "      ✓ external_dirs já configurado (no-op).");
}

function wireHermesAuditHooks(): void {
  if (!existsSync(HERMES_CONFIG)) { console.log("      ! ~/.hermes/config.yaml não encontrado — pulei."); return; }
  const cmdPre = `bun ${HERMES_HOOK_SHIM} pre`;
  const cmdPost = `bun ${HERMES_HOOK_SHIM} post`;
  const raw = readFileSync(HERMES_CONFIG, "utf8");
  if (raw.includes(HERMES_HOOK_TOKEN)) { console.log("      ✓ audit hooks já plugados (no-op)."); return; }
  // Surgical fast-path: empty map `hooks: {}` (the fresh-config case).
  const emptyRe = /^hooks:[ \t]*\{[ \t]*\}[ \t]*$/m;
  if (emptyRe.test(raw)) {
    const block = [
      "hooks:",
      "  pre_tool_call:",
      `  - matcher: "terminal|file"`,
      `    command: ${cmdPre}`,
      "    timeout: 5",
      "  post_tool_call:",
      `  - matcher: "terminal|file"`,
      `    command: ${cmdPost}`,
      "    timeout: 5",
    ].join("\n");
    if (!FLAG_DRY) { hermesBackup(raw); writeFileSync(HERMES_CONFIG, raw.replace(emptyRe, block), "utf8"); preApproveHermesHooks([cmdPre, cmdPost]); }
    console.log("      ✓ audit hooks (pre/post_tool_call) plugados + pré-aprovados.");
    return;
  }
  // Fallback: non-empty hooks → yaml-lib merge.
  const did = patchHermesConfigYaml((doc) => {
    let changed = false;
    for (const [evt, cmd] of [["pre_tool_call", cmdPre], ["post_tool_call", cmdPost]] as Array<[string, string]>) {
      const cur = doc.getIn(["hooks", evt]);
      const list: any[] = cur && typeof cur.toJSON === "function" ? cur.toJSON() : (Array.isArray(cur) ? cur : []);
      const kept = list.filter((h) => !(h && typeof h.command === "string" && h.command.includes(HERMES_HOOK_TOKEN)));
      const next = [...kept, { matcher: "terminal|file", command: cmd, timeout: 5 }];
      if (JSON.stringify(list) !== JSON.stringify(next)) { doc.setIn(["hooks", evt], next); changed = true; }
    }
    return changed;
  });
  if (did && !FLAG_DRY) preApproveHermesHooks([cmdPre, cmdPost]);
  console.log(did ? "      ✓ audit hooks plugados + pré-aprovados." : "      ✓ audit hooks já plugados (no-op).");
}

// Pre-approve our two (event, command) pairs in Hermes' shell-hook allowlist so
// the user doesn't get a consent prompt on first tool use. We only do this after
// the user said "yes" (or passed --with-hermes). Matches Hermes' _is_allowlisted
// which keys on (event, command) only (agent/shell_hooks.py:589-596).
function preApproveHermesHooks(commands: string[]): void {
  if (FLAG_DRY) return;
  let data: any = { approvals: [] };
  if (existsSync(HERMES_ALLOWLIST)) {
    try { data = JSON.parse(readFileSync(HERMES_ALLOWLIST, "utf8")); } catch { data = { approvals: [] }; }
  }
  if (!Array.isArray(data.approvals)) data.approvals = [];
  const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const pairs: Array<[string, string]> = [["pre_tool_call", commands[0]], ["post_tool_call", commands[1]]];
  for (const [event, command] of pairs) {
    data.approvals = data.approvals.filter((e: any) => !(e && e.event === event && e.command === command));
    data.approvals.push({ event, command, approved_at: now, script_mtime_at_approval: null });
  }
  try { writeFileSync(HERMES_ALLOWLIST, JSON.stringify(data, null, 2)); } catch { /* best-effort */ }
}

async function offerHermesBridge(): Promise<void> {
  if (FLAG_NO_HERMES) return;
  if (!hermesPresent()) return; // skip silencioso quando não há Hermes

  // Opt-in explícito: default NÃO. Headless só age com --with-hermes.
  let ok = FLAG_WITH_HERMES;
  if (!ok) {
    if (!process.stdin.isTTY) return;
    console.log();
    console.log("[hermes] Hermes Agent detectado.");
    ok = await promptYesNo("Instalar a ponte do Nirvana-OS no Hermes (consulta + dispatch via nrv)?", false);
  }
  if (!ok) { console.log("      Pulei. Rode depois: bun scripts/install.ts --with-hermes"); return; }

  // 1. Registrar a ponte (fonte única via external_dirs apontando pra árvore instalada)
  if (existsSync(HERMES_BRIDGE_DIR)) wireHermesExternalDirs(HERMES_BRIDGE_DIR);
  else console.log("      ! ponte não encontrada em ~/.claude/skills — rode o install completo antes.");

  // 2. Audit hooks (sub-toggle; mais invasivo → opt-in separado)
  if (!FLAG_NO_HERMES_HOOKS) {
    let wantHooks = FLAG_WITH_HERMES;
    if (!FLAG_WITH_HERMES && process.stdin.isTTY) {
      wantHooks = await promptYesNo("      Plugar também os audit hooks do Hermes (pre/post tool)? Pré-aprova 2 hooks em seu nome.", false);
    }
    if (wantHooks) wireHermesAuditHooks();
  }
  console.log("      ✓ Hermes pronto. Verifique: hermes skills list | grep nirvana");
}

function checkOnly(): void {
  console.log("=== Nirvana OS — install check ===");
  let allReady = true;

  for (const skill of SKILLS) {
    const installed = existsSync(join(NIRVANA_SKILLS, skill));
    console.log(`  skills/${skill}: ${installed ? "OK" : "MISSING"}`);
    if (!installed) allReady = false;
  }
  for (const bin of BINARIES) {
    const installed = existsSync(join(LOCAL_BIN, bin));
    console.log(`  bin/${bin}:        ${installed ? "OK" : "MISSING"}`);
    if (!installed) allReady = false;
  }

  const hookInstaller = join(NIRVANA_SKILLS, "_shared/scripts/install.ts");
  if (existsSync(hookInstaller)) {
    const r = spawnSync(process.execPath, [hookInstaller, "--check"], { stdio: "inherit" });
    if (r.status !== 0) allReady = false;
  } else {
    console.log("  hook installer:    MISSING");
    allReady = false;
  }

  // Starter availability
  const avail = detectStarterAvailability();
  console.log();
  console.log("Library state:");
  console.log(`  ~/squads/                          : ${avail.squads_empty ? "EMPTY" : "populated"}`);
  console.log(`  ~/businesses/                      : ${avail.businesses_empty ? "EMPTY" : "populated"}`);
  console.log(`  ~/businesses/_library/dna/         : ${avail.mind_clones_empty ? "EMPTY" : "populated"}`);
  console.log();
  console.log("Starter pack available:");
  console.log(`  squads:        ${avail.available_squads.length === 0 ? "(none)" : avail.available_squads.join(", ")}`);
  console.log(`  businesses:    ${avail.available_businesses.length === 0 ? "(none)" : avail.available_businesses.join(", ")}`);
  console.log(`  mind-clones:   ${avail.available_mind_clones.length === 0 ? "(none)" : avail.available_mind_clones.join(", ")}`);

  // Hermes bridge state (optional integration)
  console.log();
  console.log("Hermes Agent:");
  if (!hermesPresent()) {
    console.log("  hermes CLI:    not installed (bridge optional)");
  } else {
    const YAML = loadYamlLib();
    let extReg = false, hooksReg = false;
    if (YAML && existsSync(HERMES_CONFIG)) {
      try {
        const doc = YAML.parse(readFileSync(HERMES_CONFIG, "utf8")) || {};
        const ext = doc?.skills?.external_dirs || [];
        extReg = Array.isArray(ext) && ext.some((d: any) => typeof d === "string" && d.includes("adapters/hermes/skills"));
        const h = doc?.hooks || {};
        const flat = [...(Array.isArray(h.pre_tool_call) ? h.pre_tool_call : []), ...(Array.isArray(h.post_tool_call) ? h.post_tool_call : [])];
        hooksReg = flat.some((x: any) => x && typeof x.command === "string" && x.command.includes(HERMES_HOOK_TOKEN));
      } catch { /* ignore */ }
    }
    console.log(`  bridge skill:  ${extReg ? "registered (external_dirs)" : "not registered — run with --with-hermes"}`);
    console.log(`  audit hooks:   ${hooksReg ? "wired" : "not wired"}`);
  }

  console.log();
  console.log(allReady ? "Status: READY" : "Status: NEEDS SETUP — run 'bun scripts/install.ts'");
  process.exit(allReady ? 0 : 1);
}

function summary(): void {
  console.log();
  console.log("Done.");
  console.log();
  console.log("Next steps:");
  console.log("  nrv install --check     # verify all hooks are wired");
  console.log("  nrv validate            # smoke-test registries");
  console.log("  nrv glance              # open the cockpit");
  console.log("  nrv init ~/my-project   # bootstrap a new project");
}

async function main(): Promise<void> {
  if (FLAG_CHECK) {
    checkOnly();
    return;
  }

  header();
  preflight();
  copySkills();
  installDeps();
  copyBinaries();
  wireHooks();
  linkRuntimes();
  await offerStarterPack();
  await offerHermesBridge();
  summary();
}

main();
