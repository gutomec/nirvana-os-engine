/**
 * deps-home.ts — the ONE place every dependency the engine installs may live.
 *
 * The rule, in one line: nothing the engine installs may land outside
 * `~/.nirvana`. Node packages go to `~/.nirvana/node_modules`, Python packages
 * to `~/.nirvana/python`, and every tool that downloads a runtime of its own
 * (Chromium for Puppeteer, browsers for Playwright, model weights for
 * Hugging Face) is pinned to `~/.nirvana/cache/<tool>`. The single exception is
 * a real system program — ffmpeg, git, pandoc — which belongs to the machine's
 * package manager and is installed once, globally, on purpose.
 *
 * Why this file exists. `paths.js` has always exported DEPS_DIR
 * (`~/.nirvana/node_modules`) and the engine's own three libraries have always
 * been installed there. The squad activator never used it: `installNode` ran
 * the package manager with `cwd: squadDir`, `installSubApps` ran it once per
 * sub-app directory, and `_synthesizeFromManifests` handed a squad's bare
 * package.json straight back with `cwd: squadDir`. The comment above that line
 * explained the choice as avoiding a stray node_modules at the `~/squads` root
 * — which it did, by creating one stray per squad instead. Activating a single
 * squad that declares puppeteer + remotion writes ~276 MB into
 * `~/squads/<slug>/node_modules`, and nothing pinned the browser cache, so the
 * same activation dropped another ~892 MB of Chromium into `~/.cache/puppeteer`.
 * Measured on the owner's machine, 2026-09-02: 1.47 GB of duplicated
 * node_modules across two trees and 8.1 GB of unpinned tool caches.
 *
 * The three primitives below are what a caller needs:
 *   depsEnv()   — the environment that makes every tool write to ~/.nirvana
 *   install()   — add packages to the shared store (merges; never prunes)
 *   link()      — point a consumer directory at the shared store
 *
 * What a stray install does to a linked consumer, measured 2026-09-02:
 *   - `bun install` inside a linked directory writes THROUGH the link and adds
 *     to the shared store. Nothing is pruned; the other consumers keep working.
 *     A careless install contributes instead of duplicating.
 *   - `npm install` does not: it reports "Removing non-directory node_modules",
 *     deletes the link and builds a fresh local tree. The store survives intact,
 *     but that consumer silently goes back to its own copy.
 * There is no way to stop npm from doing this, so the answer is three-layered:
 * the contract tells agents not to (AGENTS.md), `nrv deps status` and
 * `nrv doctor` detect the tree that appeared, and `nrv deps adopt --apply`
 * folds it back in. Detection is why findStrays() exists.
 *
 * Resolution is by symlink, not by NODE_PATH alone. Bun honours NODE_PATH and
 * so does Node's CJS require, but Node's ESM loader ignores it — and a squad
 * script invoked as `node scripts/x.mjs`, or a `bunx remotion` that re-execs
 * node, would then fail to resolve what is plainly installed. A `node_modules`
 * symlink is understood by every runtime and every loader, costs one inode, and
 * keeps exactly one physical copy on disk. Both are set: the symlink for
 * resolution, NODE_PATH for the cases where a tool copies a script elsewhere
 * before running it.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawnSync } from "node:child_process";

/**
 * Every path is computed PER CALL from the environment, never captured at
 * module load. paths.js resolves its object once at require time — correct for
 * a process that has one home, wrong for a test that sets NIRVANA_HOME to a
 * fixture, and the stale value is invisible: the store simply points at the
 * previous home and everything "works" against the wrong directory.
 * The formulas below are the same ones paths.js uses, so both agree.
 */
function home(): string {
  return process.env.NIRVANA_HOME || os.homedir();
}

/** `~/.nirvana` — the root every installed dependency lives under. */
export function nirvanaHome(): string {
  return path.join(home(), ".nirvana");
}

/** The shared node_modules — `paths.DEPS_DIR`, same overrides. */
export function depsStore(): string {
  return process.env.NIRVANA_DEPS_DIR || process.env.DEPS_DIR || path.join(nirvanaHome(), "node_modules");
}

/**
 * The manifest that governs the store. It sits in the store's PARENT, because
 * that is where the package manager expects to find it, and it is the same
 * `~/.nirvana/package.json` the engine installer has always written.
 */
export function depsManifest(): string {
  return path.join(path.dirname(depsStore()), "package.json");
}

/** `~/.nirvana/python` — PYTHONUSERBASE, so `pip install --user` lands here. */
export function pythonHome(): string {
  return path.join(nirvanaHome(), "python");
}

/** `~/.nirvana/cache/<tool>` — one pinned cache per tool that downloads runtimes. */
export function depsCache(tool: string): string {
  return path.join(nirvanaHome(), "cache", tool);
}

function ensure(dir: string): void {
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* best-effort */ }
}

/**
 * The environment that keeps every tool inside ~/.nirvana.
 *
 * Deliberately NOT set: `npm_config_prefix`. Redirecting it would move global
 * `npm i -g` installs into ~/.nirvana/bin, but it also breaks nvm outright
 * ("nvm is not compatible with the npm config prefix option") and global CLIs
 * are the machine-level exception this policy already carves out. Also not set:
 * the package managers' own download caches (`~/.bun/install/cache`,
 * `~/.npm/_cacache`). Those are single, deduplicated, machine-wide caches
 * shared with every other project the user has — the opposite of the scatter
 * this file exists to stop — and hijacking them would slow down unrelated work.
 */
export function depsEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const store = depsStore();
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined) env[k] = v;

  // Resolution: prepend, never replace — a caller may have its own NODE_PATH.
  env.NODE_PATH = env.NODE_PATH && env.NODE_PATH !== store
    ? `${store}${path.delimiter}${env.NODE_PATH}`
    : store;

  // Tools that download a runtime of their own.
  env.PUPPETEER_CACHE_DIR = depsCache("puppeteer");
  env.PLAYWRIGHT_BROWSERS_PATH = depsCache("playwright");
  env.HF_HOME = depsCache("huggingface");
  env.TRANSFORMERS_CACHE = depsCache("huggingface");   // pre-4.x variable, still honoured
  env.PIP_CACHE_DIR = depsCache("pip");

  // Python packages: `pip install --user` resolves under PYTHONUSERBASE, and
  // the interpreter adds that same user-site to sys.path at startup, so one
  // variable covers both installing and importing.
  env.PYTHONUSERBASE = pythonHome();

  return env;
}

/** Create every directory depsEnv() points at, so a tool never fails on mkdir. */
export function ensureDepsHome(): void {
  ensure(depsStore());
  ensure(pythonHome());
  for (const t of ["puppeteer", "playwright", "huggingface", "pip"]) ensure(depsCache(t));
}

export type LinkResult = { status: "linked" | "already_linked" | "occupied" | "failed"; target?: string; error?: string };

/**
 * Point `<dir>/node_modules` at the shared store.
 *
 * `occupied` is reported, never overwritten: a real node_modules directory
 * there is somebody's installed tree, and deleting it is a decision for
 * `nrv deps adopt`, which moves the packages into the store first.
 */
export function link(dir: string): LinkResult {
  const store = depsStore();
  const target = path.join(dir, "node_modules");
  try {
    const st = fs.lstatSync(target);
    if (st.isSymbolicLink()) {
      const cur = fs.readlinkSync(target);
      if (path.resolve(path.dirname(target), cur) === path.resolve(store)) return { status: "already_linked", target };
      fs.unlinkSync(target);   // points somewhere else — repoint it
    } else {
      return { status: "occupied", target };
    }
  } catch { /* nothing there — the normal path */ }
  try {
    ensure(store);
    fs.symlinkSync(store, target, process.platform === "win32" ? "junction" : "dir");
    return { status: "linked", target };
  } catch (e) {
    return { status: "failed", target, error: (e as Error).message };
  }
}

/** Remove a node_modules symlink we created (leaves real directories alone). */
export function unlink(dir: string): boolean {
  const target = path.join(dir, "node_modules");
  try {
    if (!fs.lstatSync(target).isSymbolicLink()) return false;
    fs.unlinkSync(target);
    return true;
  } catch { return false; }
}

export type InstallResult = {
  status: "installed" | "already_present" | "failed" | "nothing_to_do";
  packages: string[];
  added: string[];
  error?: string;
  /** A sub-command failed (a flaky post-install) but every package resolved. */
  warning?: string;
  cmd?: string;
  /**
   * The exact argv handed to the package manager. Surfaced because a package
   * name is DATA: it is spawned as one array element, never joined into a shell
   * line, and the activator's injection tests assert that shape rather than
   * trusting the comment.
   */
  argv?: string[];
};

/** Which of these package specs is already in the store? */
export function present(pkgs: string[]): { have: string[]; missing: string[] } {
  const store = depsStore();
  const have: string[] = [], missing: string[] = [];
  for (const spec of pkgs) {
    const name = spec.startsWith("@")
      ? spec.split("@").slice(0, 2).join("@")
      : spec.split("@")[0];
    (fs.existsSync(path.join(store, name)) ? have : missing).push(spec);
  }
  return { have, missing };
}

/**
 * Install packages into the shared store.
 *
 * Uses `bun add --cwd <store parent>`, which MERGES into the manifest and
 * installs; a plain `bun install` would prune every package not declared in
 * that one manifest and so delete what other squads depend on. Verified
 * 2026-09-02: `bun add --cwd` preserved the pre-existing `yaml` entry and added
 * the new one alongside it.
 */
export function install(pkgs: string[], opts: { dryRun?: boolean; bun?: string } = {}): InstallResult {
  const clean = pkgs.map((p) => String(p).trim()).filter(Boolean);
  if (clean.length === 0) return { status: "nothing_to_do", packages: [], added: [] };

  const { missing } = present(clean);
  if (missing.length === 0) return { status: "already_present", packages: clean, added: [] };

  const root = path.dirname(depsStore());
  ensureDepsHome();
  ensure(root);
  if (!fs.existsSync(depsManifest())) {
    fs.writeFileSync(depsManifest(), JSON.stringify({ name: "nirvana-deps", private: true, dependencies: {} }, null, 2) + "\n", "utf8");
  }

  const bun = opts.bun || process.env.NIRVANA_BUN || "bun";
  const argv = [bun, "add", "--cwd", root, ...missing];
  const cmd = argv.join(" ");
  if (opts.dryRun) return { status: "nothing_to_do", packages: clean, added: missing, cmd, argv };

  // argv, never a shell line: a token like `left-pad && echo pwned` is one
  // argument to the package manager and can never become a second command.
  const r = spawnSync(argv[0], argv.slice(1), { encoding: "utf8", env: depsEnv() });
  if (r.status === 0) return { status: "installed", packages: clean, added: missing, cmd, argv };

  // A non-zero exit is not proof that nothing installed. Puppeteer's
  // post-install fails outright when it cannot fetch chrome-headless-shell,
  // after every one of the 339 packages has already been resolved, downloaded
  // and extracted — and the browser it DID fetch is the one the squad needs.
  // Trusting the exit code alone made the caller discard a complete install and
  // abort, so verify against the store instead of believing the status.
  const after = present(clean);
  const detail = (r.stderr || r.stdout || r.error?.message || "install failed").trim().slice(0, 400);
  if (after.missing.length === 0) {
    return { status: "installed", packages: clean, added: missing, cmd, argv, error: undefined, warning: detail };
  }
  return {
    status: "failed",
    packages: clean,
    added: clean.filter((p) => !after.missing.includes(p)),
    cmd,
    argv,
    error: `${after.missing.length} package(s) still missing (${after.missing.slice(0, 3).join(", ")}) — ${detail}`,
  };
}

export type Stray = { dir: string; kind: "node_modules" | "lockfile" | "manifest"; bytes: number; entries: number };

const SCAN_SKIP = new Set([".git", "node_modules", ".runs", "dist", "outputs", ".cache", "Library", ".Trash"]);

/**
 * Find installed dependency trees that are NOT the shared store.
 *
 * Only real directories count, never our own symlinks — a linked consumer is
 * the fixed state, not a finding.
 */
export function findStrays(roots: string[], maxDepth = 4): Stray[] {
  // Compare REAL paths on both sides. On macOS `/var` is a symlink to
  // `/private/var`, so a store under a temp dir resolves to a different string
  // than the one depsStore() reports — and the store would report itself as a
  // stray. The same trap exists on any machine whose home sits behind a
  // symlinked mount.
  const store = realOrSelf(depsStore());
  const out: Stray[] = [];

  const walk = (dir: string, depth: number) => {
    if (depth > maxDepth) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.name === "node_modules") {
        // A symlink is the cure, not the disease.
        if (realOrSelf(full) === store) continue;
        let st: fs.Stats;
        try { st = fs.lstatSync(full); } catch { continue; }
        if (st.isSymbolicLink()) continue;
        let count = 0;
        try { count = fs.readdirSync(full).length; } catch { /* unreadable */ }
        out.push({ dir: full, kind: "node_modules", bytes: dirSize(full), entries: count });
        continue;   // never descend into one
      }
      if (!e.isDirectory() || e.name.startsWith(".") || SCAN_SKIP.has(e.name)) continue;
      walk(full, depth + 1);
    }
  };

  for (const r of roots) { try { if (fs.existsSync(r)) walk(r, 0); } catch { /* skip */ } }
  return out.sort((a, b) => b.bytes - a.bytes);
}

/** realpath when the path exists, the resolved path otherwise. */
function realOrSelf(p: string): string {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

/** du -s, in bytes, without shelling out. Cheap enough at the depths we scan. */
export function dirSize(dir: string): number {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) { stack.push(full); continue; }
      try { total += fs.statSync(full).size; } catch { /* vanished */ }
    }
  }
  return total;
}

export function human(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  const u = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1024, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)}${u[i]}`;
}

/** The content roots a scan should cover by default. */
export function defaultScanRoots(): string[] {
  const h = home();
  return [
    process.env.SQUADS_DIR || path.join(h, "squads"),
    process.env.BUSINESSES_DIR || path.join(h, "businesses"),
    process.env.NIRVANA_PACKS_DIR || path.join(h, "nirvana-packs"),
  ];
}
