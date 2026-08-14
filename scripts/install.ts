#!/usr/bin/env bun
/**
 * Nirvana OS bootstrap installer.
 *
 * Copies the skills tree into ~/.nirvana/skills/ (the canonical shared tree,
 * linked into every INSTALLED runtime) and the CLI dispatchers into
 * ~/.local/bin/, then runs the hook installer (skills/_shared/scripts/install.ts)
 * to wire audit hooks into the runtimes present, idempotently.
 *
 * Re-running is safe (idempotent). Existing user settings are preserved.
 *
 * Usage:
 *   bun scripts/install.ts
 */

import { cpSync, existsSync, mkdirSync, chmodSync, readdirSync, rmSync, writeFileSync, readFileSync, statSync, symlinkSync, lstatSync, renameSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, dirname, join, resolve, relative, sep } from "node:path";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { createRequire } from "node:module";
// Shared with the uninstaller — see skills/_shared/lib/runtime-dirs.ts for why.
// Resolves both from the repo and from an extracted release tarball: the
// tarball ships scripts/install.ts next to the full skills/ tree.
import { RUNTIME_SKILL_DIRS, SKILLS, COPY_MARKER } from "../skills/_shared/lib/runtime-dirs.ts";

const requireCjs = createRequire(import.meta.url);
const HOME = homedir();
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_DIR = resolve(SCRIPT_DIR, "..");
const LOCAL_BIN = join(HOME, ".local/bin");
const SQUADS_DIR = join(HOME, "squads");
const BUSINESSES_DIR = join(HOME, "businesses");
const DNA_DIR = join(BUSINESSES_DIR, "_library/dna");
// Starter content no longer lives in this repo (the engine is content-free).
// It is resolved from the private packs repo: NIRVANA_PACKS_DIR (default
// ~/nirvana-packs), content root <packs>/starter-pack.
const PACKS_DIR = process.env.NIRVANA_PACKS_DIR ?? join(HOME, "nirvana-packs");
const STARTER_PACK = join(PACKS_DIR, "starter-pack");

// Canonical SHARED location — the skills tree + deps live ONCE under ~/.nirvana
// so every runtime (claude-code, codex, antigravity, gemini, pi, hermes) shares
// one copy and the system survives removal of any single runtime, including
// Claude Code. Each runtime consumes the tree via per-entry symlinks.
const NIRVANA_DIR = join(HOME, ".nirvana");
const NIRVANA_SKILLS = join(NIRVANA_DIR, "skills");
const NIRVANA_DEPS = join(NIRVANA_DIR, "node_modules");
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
// Forces COPYING the skills into the runtime dirs instead of symlinking (Windows
// already forces this automatically; useful on any FS/runtime that cannot resolve links).
const FLAG_COPY_SKILLS = args.includes("--copy-skills");

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
  if (FLAG_DRY) {
    // --dry used to be honored only by the starter-pack sync and the hermes
    // config, so a "preview" still REPLACED the installed engine and relinked
    // every runtime. A flag that promises to look and then writes is worse than
    // no flag: whoever runs it to inspect an upgrade has already taken it.
    console.log(`[1/4] DRY RUN — would copy ${SKILLS.length} skill tree(s) → ${NIRVANA_SKILLS}`);
    for (const skill of SKILLS) console.log(`        ${join(REPO_DIR, "skills", skill)} → ${join(NIRVANA_SKILLS, skill)}`);
    return;
  }
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
  if (FLAG_DRY) {
    console.log(`[2/4] DRY RUN — would install shared deps → ${NIRVANA_DEPS}`);
    return;
  }
  console.log("[2/4] Installing shared deps → ~/.nirvana/node_modules ...");
  mkdirSync(NIRVANA_DEPS, { recursive: true });
  // Windows bun is bun.exe; probe both so a fresh cli.mjs install (bun in ~/.bun,
  // not yet on PATH) still resolves an absolute path instead of falling back to
  // the bare "bun" (which would ENOENT when PATH lacks .bun\bin).
  const bunLocal = join(HOME, ".bun", "bin", IS_WINDOWS ? "bun.exe" : "bun");
  const bunBin = hasCmd("bun") ? "bun" : (existsSync(bunLocal) ? bunLocal : "bun");
  // Install into the pack repo (it carries package.json), then copy node_modules
  // to the shared location. Keeps ~/.nirvana free of a package.json that scope.ts
  // could mistake for a project root.
  const repoNM = join(REPO_DIR, "node_modules");
  if (!existsSync(repoNM)) {
    spawnSync(bunBin, ["install", "--no-save"], { cwd: REPO_DIR, stdio: ["ignore", "inherit", "inherit"] });
  }
  if (existsSync(repoNM)) {
    // dereference on Windows: preserving internal node_modules symlinks throws
    // EPERM without Developer Mode; materializing copies is robust on every OS.
    try { cpSync(repoNM, NIRVANA_DEPS, { recursive: true, dereference: IS_WINDOWS }); console.log("  ✓ deps in ~/.nirvana/node_modules"); }
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

// Point every installed runtime at the ONE shared skills tree. Symlinks are
// used where they truly work (Mac/Linux). On WINDOWS — and for CODEX, which
// do not resolve skill symlinks reliably — we COPY the tree (without
// node_modules; execution keeps resolving from ~/.nirvana/skills via
// paths.CLAUDE_SKILLS_DIR). A pre-existing REAL user dir is preserved
// (backup .pre-nirvana.bak), never destroyed; our own previous copies carry a
// marker and are regenerated idempotently (without accumulating backups).

/**
 * Free the runtime entry so it can be linked/copied. Returns false when the
 * entry belongs to the user and cannot be freed — the caller must then leave
 * that skill alone.
 *
 * We NEVER destroy a directory we did not create. When a real user directory
 * is found it is renamed to `<name>.pre-nirvana.bak` once. If a backup from an
 * earlier install is already there and ANOTHER foreign directory has appeared
 * meanwhile, we skip that entry with a loud warning instead of deleting it:
 * a numbered backup chain (.bak.2, .bak.3, …) would silently pile up copies
 * nobody asked for, and overwriting the first backup would destroy the
 * original. Skipping is the only option that loses nothing, and the message
 * tells the user exactly how to unblock it.
 */
function cleanRuntimeEntry(linkPath: string): boolean {
  if (isSymlink(linkPath)) { rmSync(linkPath, { force: true }); return true; }
  if (!existsSync(linkPath)) return true;
  if (existsSync(join(linkPath, COPY_MARKER))) { rmSync(linkPath, { recursive: true, force: true }); return true; } // our copy
  const bak = `${linkPath}.pre-nirvana.bak`;
  if (!existsSync(bak)) {
    renameSync(linkPath, bak);   // real user dir → backup once
    console.log(`  ⓘ ${linkPath} já existia e não é do Nirvana — guardado em ${bak}`);
    return true;
  }
  console.error(`  ! ${linkPath} não é do Nirvana e já existe um backup em ${bak} — pulei esta skill (nada foi apagado).`);
  console.error(`    Mova ou remova ${linkPath} (ou ${bak}) e rode a instalação de novo.`);
  return false;
}

function copyRuntimeSkill(target: string, linkPath: string): boolean {
  try {
    // dereference:false + filter: does not drag node_modules into the copy (heavy).
    cpSync(target, linkPath, { recursive: true, dereference: false, filter: (s) => basename(s) !== "node_modules" });
    // deps: junction node_modules → shared deps, so that scripts invoked
    // from the copied dir (e.g. `bun ~/.claude/skills/<s>/scripts/x.ts`) also
    // resolve `require('yaml')`/`import 'zod'`. A junction is transparent to the resolver.
    try {
      const nm = join(linkPath, "node_modules");
      if (existsSync(NIRVANA_DEPS) && !existsSync(nm)) symlinkSync(NIRVANA_DEPS, nm, IS_WINDOWS ? "junction" : undefined);
    } catch { /* best-effort — canonical execution via ~/.nirvana still resolves */ }
    try { writeFileSync(join(linkPath, COPY_MARKER), "Cópia de ~/.nirvana/skills regenerada por `nrv install`. Edite a fonte, não isto.\n"); } catch {}
    return true;
  } catch (e) {
    // Says WHY: a mute "fail" forces the user to debug blindly.
    console.log(`  ! copy failed for ${linkPath}: ${(e as Error).message}`);
    return false;
  }
}

/**
 * User content libraries, created EMPTY.
 *
 * The engine is core-only (it ships no squads/businesses/clones), but the user
 * needs the directories to exist to create their own — and `nrv doctor`
 * checks for their existence. Project scope already does this
 * (`init-project.ts` creates `.nirvana/{squads,businesses,mind-clones}`); this
 * is the global equivalent.
 *
 * NOT DESTRUCTIVE: recursive `mkdir` is a no-op when the directory already
 * exists — nothing is deleted or overwritten, and re-running the installer is
 * idempotent. Cross-OS: only `path.join` + `mkdirSync` (no shell command), with
 * EEXIST tolerated because on Windows Bun throws it even with `recursive: true`.
 */
function ensureContentLibraries(): void {
  console.log();
  if (FLAG_DRY) {
    console.log("Content libraries — DRY RUN (mkdir only, never deletes):");
    for (const dir of [SQUADS_DIR, BUSINESSES_DIR, DNA_DIR]) {
      console.log(`  ${existsSync(dir) ? "kept   " : "created"} ${dir}`);
    }
    return;
  }
  console.log("Content libraries (empty — ready for your own squads/businesses/mind-clones) ...");
  for (const dir of [SQUADS_DIR, BUSINESSES_DIR, DNA_DIR]) {
    const existed = existsSync(dir);
    try {
      mkdirSync(dir, { recursive: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== "EEXIST") {
        console.log(`  ! could not create ${dir}: ${(e as Error).message}`);
        continue;
      }
    }
    console.log(`  ${existed ? "✓ kept    " : "✓ created "}${dir}`);
  }
}

function linkRuntimes(): void {
  if (FLAG_DRY) {
    const installed = RUNTIME_SKILL_DIRS.filter(d => existsSync(dirname(d)));
    console.log(`[4/4] DRY RUN — would wire ${installed.length} installed runtime(s):`);
    for (const d of installed) console.log(`        ${d}`);
    return;
  }
  console.log("[4/4] Linking runtimes → shared skills tree ...");
  let linked = 0;
  for (const rtDir of RUNTIME_SKILL_DIRS) {
    // NO runtime is a prerequisite — not even Claude Code. A runtime is wired
    // only when it is actually installed (its home dir exists); otherwise we
    // would create ~/.claude on machines that never had Claude Code. The
    // canonical tree at ~/.nirvana/skills is the one thing always created, and
    // every runtime consumes it from there.
    if (!existsSync(dirname(rtDir))) continue; // runtime not installed
    // Copy when: Windows, --copy-skills, or Codex (parent basename === .codex).
    const isCodex = basename(dirname(rtDir)) === ".codex";
    const preferCopy = IS_WINDOWS || FLAG_COPY_SKILLS || isCodex;
    // EEXIST tolerated: on Windows Bun may throw it even with recursive:true.
    try { mkdirSync(rtDir, { recursive: true }); }
    catch (e) { if ((e as NodeJS.ErrnoException)?.code !== "EEXIST") throw e; }
    let mode = "symlink";
    for (const s of SKILLS) {
      const linkPath = join(rtDir, s);
      const target = join(NIRVANA_SKILLS, s);
      if (!existsSync(target)) continue;
      try {
        if (!cleanRuntimeEntry(linkPath)) { mode = "partial — conflitos pulados"; continue; }
        if (preferCopy) {
          mode = copyRuntimeSkill(target, linkPath) ? "copy" : "fail";
        } else {
          // DIRECTORY symlink: on Windows use a junction (asks for no Developer
          // Mode nor admin); a plain symlink without privilege falls back to copy.
          try { symlinkSync(target, linkPath, IS_WINDOWS ? "junction" : undefined); mode = "symlink"; }
          catch { mode = copyRuntimeSkill(target, linkPath) ? "copy (fallback)" : "fail"; }
        }
      } catch (e) { console.log(`  ! could not materialize ${linkPath}: ${(e as Error).message}`); mode = "fail"; }
    }
    linked++;
    console.log(`  ✓ ${rtDir} (${mode})`);
  }
  if (linked === 0) {
    console.log("  ◌ no skill-aware runtime installed yet — nothing linked.");
    console.log(`     The engine is complete at ${NIRVANA_SKILLS}; install a runtime and re-run this installer.`);
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
    // Resolve the skills dir like nrv.ts does: prefer ~/.nirvana/skills (the
    // shared root after the dotdir migration), fall back to legacy ~/.claude.
    'set "NRVTS=%USERPROFILE%\\.nirvana\\skills\\harness\\scripts\\nrv.ts"',
    'if not exist "%NRVTS%" set "NRVTS=%USERPROFILE%\\.claude\\skills\\harness\\scripts\\nrv.ts"',
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

  // Detect case/separator-insensitively: Windows PATH uses ';' and entries vary
  // in case and trailing backslash. `pathParts.includes(LOCAL_BIN)` (exact) gave
  // false "not on PATH" on Windows even when present.
  const norm = (p: string) => {
    let s = p.trim().replace(/[\\/]+$/, "");
    return IS_WINDOWS ? s.toLowerCase() : s;
  };
  const pathParts = (process.env.PATH ?? "").split(IS_WINDOWS ? ";" : ":").map(norm);
  if (!pathParts.includes(norm(LOCAL_BIN))) {
    console.log();
    console.log(`  ⓘ ${LOCAL_BIN} not on the current PATH — the hook installer adds it to your`);
    console.log(`     user PATH automatically (step 3). New terminals pick it up; for THIS`);
    if (IS_WINDOWS) {
      console.log('     window run:  set PATH=%USERPROFILE%\\.local\\bin;%PATH%');
    } else {
      console.log('     shell run:   export PATH="$HOME/.local/bin:$PATH"');
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
  // Under --dry the hook installer runs in its own read-only mode: it reports
  // what is wired without rewriting settings or appending the smoke sentinel.
  const r = spawnSync(process.execPath, FLAG_DRY ? [hookInstaller, "--check"] : [hookInstaller], { stdio: "inherit" });
  if (r.status !== 0 && !FLAG_DRY) {
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
  businesses: ["memory/projects", "memory/learned.md", ".squad-state", ".squads-outputs", ".vercel"],
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

interface SyncResult { added: string[]; updated: string[]; unchanged: string[]; removed: string[]; overwritten: string[]; hashes: Record<string, string>; breaking: BreakingChange[]; }

/** Contract change detected between the installed copy and what is arriving. */
interface BreakingChange { slug: string; detail: string; migration?: string }

/**
 * Delegates to the shared helper so that this installer and install-content
 * report exactly the same thing. The logic must NOT be rewritten here: the two
 * already duplicate `syncKind`, and that duplication is what nearly left the
 * buyer's update path without a breakage warning.
 */
function contractBreaks(installedDir: string, incomingDir: string, label: string): BreakingChange[] {
  try {
    // The repo is the source during installation; ~/.nirvana covers runs from
    // the already-installed tree.
    const libRoot = [join(REPO_DIR, "skills", "_shared", "lib"), join(NIRVANA_SKILLS, "_shared", "lib")]
      .find((d) => existsSync(join(d, "contract-breaks.ts")));
    if (!libRoot) return [];
    return requireCjs(join(libRoot, "contract-breaks.ts")).contractBreaks(installedDir, incomingDir, label);
  } catch { return []; }
}

function syncKind(kind: string, srcRoot: string, dstRoot: string, available: string[], old: Record<string, string>, dry: boolean): SyncResult {
  const excludes = RUNSTATE_EXCLUDES[kind] ?? [];
  const res: SyncResult = { added: [], updated: [], unchanged: [], removed: [], overwritten: [], hashes: {}, breaking: [] };
  if (available.length > 0) mkdirSync(dstRoot, { recursive: true });
  for (const slug of available) {
    const src = join(srcRoot, slug);
    const dst = join(dstRoot, slug);
    const h = hashDir(src, excludes);
    res.hashes[slug] = h;
    if (!existsSync(dst)) {
      res.added.push(slug);
      if (!dry) mirrorComponent(src, dst, excludes);
    } else if (!(slug in old)) {
      // Slug collision: it exists on disk but the pack NEVER owned it (not in
      // the manifest) — that is, it is a user creation with the same name as
      // one of our components. The pack is the source of truth and wins, by
      // policy; but overwriting silently makes their work vanish unexplained.
      // Warning is neither backup nor merge: it only makes the loss visible and actionable.
      res.overwritten.push(slug);
      if (!dry) mirrorComponent(src, dst, excludes);
    } else {
      const prev = old[slug] ?? hashDir(dst, excludes);
      if (prev !== h) {
        res.updated.push(slug);
        // BEFORE the mirror: the only moment when the installed surface and
        // the incoming one coexist. After overwriting, the old contract no
        // longer exists and the comparison would be impossible.
        res.breaking.push(...contractBreaks(dst, src, `${kind}/${slug}`));
        if (!dry) mirrorComponent(src, dst, excludes);
      }
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
    if (FLAG_STARTER) {
      // --starter was asked for but there is nothing to install: explain where
      // content comes from and continue — never fail the engine install.
      console.log("[4/4] Starter pack: no content found.");
      console.log(`      Looked in: ${STARTER_PACK}`);
      console.log("      (set NIRVANA_PACKS_DIR if your packs repo lives elsewhere)");
      console.log("      The engine ships without content. To get squads, businesses and mind-clones:");
      console.log("        - install a pack you own (unzip it and run: bun setup.ts), or");
      console.log("        - clone your private packs repo to ~/nirvana-packs, or");
      console.log("        - create your own entities with the creation pipelines (harness / squads / businesses skills).");
      console.log("      Continuing without content — empty libraries are ready at ~/squads, ~/businesses, ~/businesses/_library/dna.");
    } else {
      console.log("[4/4] Starter pack: skipped — no starter content found.");
    }
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
    console.log(`      ${label}: ${r.added.length} new · ${r.updated.length} updated · ${r.unchanged.length} unchanged · ${r.removed.length} removed${r.overwritten.length ? ` · ${r.overwritten.length} overwritten` : ""}`);
  line("squads", squads); line("businesses", businesses); line("mind-clones", clones);
  const kinds = [["squads", squads], ["businesses", businesses], ["mind-clones", clones]] as const;
  for (const [lbl, r] of kinds) {
    for (const s of r.added) console.log(`        + ${lbl}/${s} (new)`);
    for (const s of r.updated) console.log(`        ~ ${lbl}/${s} (updated)`);
    for (const s of r.removed) console.log(`        - ${lbl}/${s} (removed — dropped from pack)`);
    for (const s of r.overwritten) console.log(`        ! ${lbl}/${s} (OVERWRITTEN — was yours, same slug as a pack component)`);
  }

  // Contract breaks get their own block: a "~ atualizado" line does not tell
  // a prose improvement from a capability that vanished, and it is the latter
  // that makes the user's project stop working without anyone noticing.
  const breaks = kinds.flatMap(([, r]) => r.breaking);
  if (breaks.length > 0) {
    console.log();
    console.log(`  ATENÇÃO: ${breaks.length} mudança(s) de contrato ${FLAG_DRY ? "seriam aplicadas" : "aplicadas"} nesta atualização.`);
    console.log("  Projetos que dependiam dos itens abaixo precisam de ajuste:");
    for (const b of breaks) {
      console.log(`    ! ${b.slug}: ${b.detail}`);
      if (b.migration) console.log(`      → ${b.migration}`);
    }
    console.log("  Detalhe completo em CHANGES.json dentro de cada componente.");
  }

  // Collisions get their own block at the end: in a long "+/~" list the line
  // that matters slips by, and this is the only one that means lost work.
  const collisions = kinds.flatMap(([lbl, r]) => r.overwritten.map((s) => `${lbl}/${s}`));
  if (collisions.length > 0) {
    console.log();
    console.log(`  ${FLAG_DRY ? "WOULD OVERWRITE" : "OVERWRITTEN"}: ${collisions.length} component(s) you created share a slug with a pack component.`);
    for (const c of collisions) console.log(`    ! ${c}`);
    console.log("    The pack is the source of truth for its own components, so it wins — and there is no backup.");
    console.log("    To keep your version, give it a different slug (your own components are never touched).");
    console.log("    Your run-state (projects/, outputs/, memory/projects) was preserved.");
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

}

/**
 * Build the registries. Runs on EVERY install, which is the whole point of it
 * living out here.
 *
 * It used to be the tail of offerStarterPack(), below the `--no-starter` early
 * return — and `--no-starter` is exactly what both entry points pass
 * (packaging/cli/bin/cli.mjs and packaging/pack/setup.ts). So a plain
 * `npx @nirvana-os/cli` finished with no registry on disk at all and routing
 * degraded from the first minute, with nothing saying so. Pack buyers escaped
 * only by accident, because install-content.ts indexes on its own.
 *
 * CI never caught it because the smoke job runs `nrv index` by hand before the
 * doctor, and the doctor passes a registry that exists over an empty library.
 */
function buildRegistries(): void {
  // Windows CreateProcess only auto-appends .exe, never .cmd — spawning the
  // extensionless bash `nrv` there fails, so the post-install index silently
  // never ran (registries stayed empty until a manual `nrv index`). Target the
  // .cmd launcher on Windows.
  const nrvBin = join(LOCAL_BIN, IS_WINDOWS ? "nrv.cmd" : "nrv");
  if (FLAG_DRY) return; // no index on dry-run
  if (FLAG_NO_INDEX) { console.log("      Indexing deferred (--no-index)."); return; }
  if (!existsSync(nrvBin)) return;
  console.log("      Re-indexing registries...");
  const r = spawnSync(nrvBin, ["index"], { stdio: "inherit", shell: IS_WINDOWS });
  if (r.status !== 0) console.log("      ⚠ nrv index reported issues. Run manually to verify.");
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
  if (!hermesPresent()) return; // silent skip when Hermes is absent

  // Explicit opt-in: default NO. Headless only acts with --with-hermes.
  let ok = FLAG_WITH_HERMES;
  if (!ok) {
    if (!process.stdin.isTTY) return;
    console.log();
    console.log("[hermes] Hermes Agent detectado.");
    ok = await promptYesNo("Instalar a ponte do Nirvana-OS no Hermes (consulta + dispatch via nrv)?", false);
  }
  if (!ok) { console.log("      Pulei. Rode depois: bun scripts/install.ts --with-hermes"); return; }

  // 1. Register the bridge (single source via external_dirs pointing at the installed tree)
  if (existsSync(HERMES_BRIDGE_DIR)) wireHermesExternalDirs(HERMES_BRIDGE_DIR);
  else console.log("      ! ponte não encontrada em ~/.claude/skills — rode o install completo antes.");

  // 2. Audit hooks (sub-toggle; more invasive → separate opt-in)
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

/**
 * The last thing a new user reads, so it says the one thing that decides whether
 * they experience Nirvana at all.
 *
 * `nrv init` writes the agent contract (AGENTS.md + CLAUDE.md + GEMINI.md, one
 * per runtime family) into the project root. That contract is what tells the
 * runtime to invoke the orchestrator. Without it the skill has to activate by
 * description match alone, and when it does not, the brief is answered inline:
 * no dispatch, no quality gate, no audit trail — a normal coding session
 * wearing the system's name. Users who skip init do not see an error; they see
 * a worse product and blame it.
 *
 * `nrv glance` is deliberately absent: the cockpit is not finished, and the
 * first screen a new user sees should not be the weakest one.
 */
function summary(): void {
  console.log();
  console.log("Done.");
  console.log();
  console.log("\x1b[1mStart every project with nrv init — this is the important part.\x1b[0m");
  console.log();
  console.log("  nrv init ~/my-project     # creates the dir + the agent contract");
  console.log("  cd ~/my-project           # then just talk to your AI CLI");
  console.log();
  console.log("  Already have a folder? Run it there:  cd ~/existing && nrv init .");
  console.log();
  console.log("Why it matters: nrv init writes the contract (AGENTS.md / CLAUDE.md /");
  console.log("GEMINI.md) that tells your AI CLI to orchestrate through Nirvana-OS.");
  console.log("WITHOUT it, a brief is answered inline by a single agent — no dispatch");
  console.log("to your businesses and squads, no quality gate, no audit trail. It still");
  console.log("works; it just is not Nirvana-OS. Check any project with: nrv doctor");
  console.log();
  console.log("Verify this install:");
  console.log("  nrv install --check       # hooks wired");
  console.log("  nrv validate              # registries smoke-test");
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
  // Before the starter pack: with --no-starter the empty libraries still need
  // to exist all the same, and with a pack they are already ready to receive.
  ensureContentLibraries();
  await offerStarterPack();
  // After the starter pack (so seeded content is in the index) and outside it
  // (so an engine-only install gets registries too — see buildRegistries).
  buildRegistries();
  await offerHermesBridge();
  summary();
}

main();
