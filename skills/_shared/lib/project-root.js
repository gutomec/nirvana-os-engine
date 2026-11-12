/**
 * project-root.js — the one "walk up from cwd, stop at HOME or the
 * filesystem root" implementation in the engine.
 *
 * Before this module existed, paths.js, scope.ts, log-paths.ts, handoff.js
 * and wiki-lint.js each carried their own copy. Two drifted out of sync with
 * each other in the same afternoon (log-paths.ts's HOME hardening landed
 * separately from paths.js's, in a different shape), and two more
 * (handoff.js, wiki-lint.js) never received it at all: their walk still
 * treats a stray `~/.nirvana` (the engine's own install) as a project,
 * because they compare raw strings from `process.cwd()`/`.nirvana` markers
 * with no canonicalization and no HOME check.
 *
 * Written as CommonJS deliberately, matching brief-excerpt.js/.ts: a `.ts`
 * file requiring a `.ts` sibling under Bun on Windows can throw
 * `TypeError: require() async module` when that sibling's dependency chain
 * carries a top-level await (bun-helpers.ts's `await import("bun")`, which
 * scope.ts pulls in transitively). A plain `.js` with only `fs`/`os`/`path`
 * has no such chain, so both CJS callers (`require`) and ESM callers
 * (`import`) can reach it safely on every platform.
 *
 * HOME, the filesystem root and (on Windows) the OS-owned system directories
 * are never valid project roots, even carrying a marker: a stray
 * `~/.nirvana` sitting in HOME must never be mistaken for a project, and an
 * elevated PowerShell that starts in C:\Windows\System32 must never have
 * writes land there. Comparison goes through `realpathSync.native` — the
 * only resolver that expands a Windows 8.3 short path (`RUNNER~1`) to the
 * long form `os.homedir()` reports — and is case-insensitive on win32.
 *
 * The walk STOPS as soon as it reaches HOME, or as soon as HOME becomes
 * strictly nested under the current directory (meaning the current directory
 * is an ancestor of HOME): climbing further would leave the boundary that
 * contains HOME and enter real, unrelated ancestry above it. This mirrors
 * the fix in log-paths.ts (see git history, "the hook's project-root walk
 * stops at HOME, even on Windows") rather than the older skip-and-continue
 * shape paths.js/scope.ts had: on `os.tmpdir()` resolving *inside* HOME (the
 * Windows CI runner shape), a walk that starts in a temp fixture directory
 * climbs through HOME's own ancestry before it would reach the filesystem
 * root, and skip-and-continue risks matching a marker up there instead of
 * correctly reporting "no project in reach".
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

/** What makes a directory a Nirvana project: the file `nrv init` writes (and
 *  `nrv init --adopt` writes alone, for a folder that already holds work).
 *
 *  It used to be the first ancestor carrying any of `.env`, `.nirvana`, `.git`,
 *  `package.json` or `pyproject.toml`. Every repository has one of those, so a
 *  command run anywhere inside a repository adopted the repository's root as
 *  the project: run outputs landed at the root of an unrelated repository, and
 *  a hook writing an audit line created `.nirvana/` (logs, registries) in any
 *  folder an agent happened to work in — after which that bare `.nirvana/` was
 *  itself a marker. A project is now something that was declared one, never
 *  something inferred from files every codebase has. */
const PROJECT_MARKER = path.join('.nirvana', 'project.yaml');
const DEFAULT_MARKERS = [PROJECT_MARKER];

/** The OS's own resolver. `realpathSync.native` is the one that expands a
 *  Windows 8.3 short path; the JS `realpathSync` resolves symlinks but can
 *  hand the short form straight back. Falls back to `path.resolve` for a
 *  path that does not exist yet, where the resolved form is all there is to
 *  honestly compare. */
function canonical(dir) {
  const resolved = path.resolve(dir);
  try {
    return fs.realpathSync.native ? fs.realpathSync.native(resolved) : fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function sameDir(a, b) {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** Is `descendant` strictly inside `ancestor`? */
function isUnder(descendant, ancestor) {
  const prefix = ancestor.endsWith(path.sep) ? ancestor : ancestor + path.sep;
  return process.platform === 'win32'
    ? descendant.toLowerCase().startsWith(prefix.toLowerCase())
    : descendant.startsWith(prefix);
}

function homeDir(opts) {
  return canonical((opts && opts.home) || process.env.HOME || os.homedir());
}

/**
 * Is `dir` a directory that must never be treated as a project root, even if
 * it happens to carry a marker file?
 *
 * @param {string} dir
 * @param {{home?: string}} [opts] `home` overrides the resolved HOME, for tests.
 */
/**
 * The shared scratch roots on this platform. `os.tmpdir()` is the per-user one
 * (on macOS a path under /var/folders); the literals cover the system-wide ones
 * that tools write to directly.
 * @returns {string[]}
 */
function tempRootDirs() {
  const out = [];
  try { out.push(os.tmpdir()); } catch { /* no tmpdir — nothing to exclude */ }
  for (const p of ['/tmp', '/private/tmp', '/var/tmp', '/private/var/tmp']) out.push(p);
  return out.map((d) => { try { return canonical(d); } catch { return d; } });
}

function isInvalidProjectRoot(dir, opts) {
  if (!dir) return true;
  if (dir === '/' || dir === '') return true;
  try {
    const resolved = canonical(dir);
    if (resolved === path.parse(resolved).root) return true;
    if (sameDir(resolved, homeDir(opts))) return true;
    // A temp ROOT is never a project, for the same reason HOME is not: it is
    // shared scratch space, and anything on the machine may drop a marker in
    // it. Measured 2026-09-03: `/private/tmp` held a `.nirvana` and a
    // `package.json` left by unrelated tools, so every scope resolution from a
    // path under /tmp adopted `/private/tmp` as the project — and a dispatch
    // launched from a scratch directory wrote its brief, kernel and audit chain
    // there, believing it was inside a project.
    //
    // The rule is `sameDir`, not `isUnder`, exactly like the HOME rule above: a
    // directory CREATED under temp with its own marker (every test fixture in
    // this repo) is still a legitimate project root. It is the shared root
    // itself that cannot be one.
    for (const t of tempRootDirs()) {
      if (sameDir(resolved, t)) return true;
    }
    // The engine's own home is not a project either. It carries the dependency
    // store's package.json, so a command run from inside it (or from
    // ~/.nirvana/outputs/<run>) adopted ~/.nirvana as the project and wrote a
    // second ~/.nirvana/.nirvana with registries, logs and a state.db. Seen on
    // the maintainer machine, 2026-09-16.
    if (sameDir(resolved, path.join(process.env.NIRVANA_HOME || homeDir(opts), '.nirvana'))) return true;
    if (process.platform === 'win32') {
      const systemDirs = [process.env.SystemRoot, process.env.ProgramFiles, process.env['ProgramFiles(x86)']]
        .filter(Boolean)
        .map(canonical);
      for (const sd of systemDirs) {
        if (sameDir(resolved, sd) || isUnder(resolved, sd)) return true;
      }
    }
  } catch { /* unreadable path — treat as usable and let the caller fail loudly */ }
  return false;
}

/**
 * Walk up from `start` to the nearest Nirvana project root.
 *
 * @param {string} start
 * @param {{markers?: string[], home?: string}} [opts]
 *   `markers` — what to look for (default: `.nirvana/project.yaml`, the one
 *   definition of a project). Only a lookup for something that is NOT a
 *   project, such as a config file (validators/limits.ts), passes its own.
 *   `home` overrides the resolved HOME, for tests.
 * @returns {string | null}
 */
function findProjectRoot(start, opts) {
  const options = opts || {};
  const markers = options.markers || DEFAULT_MARKERS;
  let dir = canonical(path.resolve(start));
  const home = homeDir(options);
  const root = path.parse(dir).root;
  while (dir !== root && !sameDir(dir, home) && !isUnder(home, dir)) {
    if (!isInvalidProjectRoot(dir, options)) {
      for (const marker of markers) {
        if (fs.existsSync(path.join(dir, marker))) return dir;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Does `dir` hold a declared project? */
function isProjectRoot(dir, opts) {
  if (!dir || isInvalidProjectRoot(dir, opts)) return false;
  return fs.existsSync(path.join(dir, PROJECT_MARKER));
}

/** `NIRVANA_PROJECT_ROOT` as a project root, or null when it is unset or names
 *  a directory that can never be one. A dispatcher serving no project hands
 *  its children the user's home as their root; read as a project, that home
 *  would give every child a project `.env`, scope and ledger of its own. */
function pinnedProjectRoot(env, opts) {
  const pinned = (env || process.env).NIRVANA_PROJECT_ROOT;
  if (!pinned) return null;
  const resolved = path.resolve(pinned);
  return isInvalidProjectRoot(resolved, opts) ? null : resolved;
}

/**
 * The project this process serves: `NIRVANA_PROJECT_ROOT` when set (the caller
 * named it; a dispatcher pins it for its children), else the walk from `cwd`.
 * Null when there is none.
 *
 * @param {{cwd?: string, env?: Record<string, string|undefined>, home?: string}} [opts]
 * @returns {string | null}
 */
function resolveProjectRoot(opts) {
  const options = opts || {};
  const env = options.env || process.env;
  if (env.NIRVANA_PROJECT_ROOT) return pinnedProjectRoot(env, options);
  return findProjectRoot(options.cwd || process.cwd(), options);
}

/** What a `.nirvana/` holds when real work happened in its folder. */
const PROJECT_STATE = ['run-kernel.sqlite', 'state.db', 'logs', 'outputs',
  '.squads-registry.json', '.businesses-registry.json', '.mind-clones-registry.json'];

/**
 * The nearest folder, from `start` up to HOME's boundary, whose `.nirvana/`
 * holds project state but that was never declared a project (no
 * `project.yaml`). Null when a declared project is reached first, or when
 * nothing like that is in reach. It is what `nrv doctor` shows with the adopt
 * command: such a folder was a project under the old marker rule, and stops
 * being one under this one.
 *
 * @param {string} start
 * @param {{home?: string}} [opts]
 * @returns {{dir: string, state: string[]} | null}
 */
function undeclaredProjectState(start, opts) {
  const options = opts || {};
  let dir = canonical(path.resolve(start));
  const home = homeDir(options);
  const root = path.parse(dir).root;
  while (dir !== root && !sameDir(dir, home) && !isUnder(home, dir)) {
    if (!isInvalidProjectRoot(dir, options)) {
      if (fs.existsSync(path.join(dir, PROJECT_MARKER))) return null;
      const store = path.join(dir, '.nirvana');
      if (fs.existsSync(store)) {
        const state = PROJECT_STATE.filter((m) => fs.existsSync(path.join(store, m)));
        if (fs.existsSync(path.join(dir, 'outputs'))) state.push('../outputs');
        if (state.length) return { dir, state };
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** The engine's own store, `<NIRVANA_HOME|HOME>/.nirvana`: where state lives
 *  when no project is in reach. */
function globalStoreDir(env) {
  const e = env || process.env;
  return path.join(e.NIRVANA_HOME || e.HOME || os.homedir(), '.nirvana');
}

/** Where run outputs go: `<project>/outputs`, or `<store>/outputs` when there
 *  is no project. The one answer for the dispatcher, scope.ts and the squad
 *  output resolver, which used to fall back to three different places (the
 *  cwd, the store, the start directory). */
function outputsBaseDir(projectRoot, env) {
  return projectRoot ? path.join(projectRoot, 'outputs') : path.join(globalStoreDir(env), 'outputs');
}

const SCOPE_MODES = ['global', 'project', 'merge'];

/** The scope a project declares in its manifest (`scope` in
 *  .nirvana/project.yaml), or null when there is no manifest or no valid
 *  value. The manifest is written as JSON (a YAML 1.2 subset); a hand-edited
 *  YAML `scope:` line is read too. This is where a project's scope lives: the
 *  `.env` held it before the manifest existed and is only a fallback now. */
function manifestScope(projectRoot) {
  if (!projectRoot) return null;
  let text;
  try { text = fs.readFileSync(path.join(projectRoot, '.nirvana', 'project.yaml'), 'utf8'); } catch { return null; }
  let value = null;
  try { value = JSON.parse(text).scope; }
  catch { const m = /^\s*scope:\s*["']?([a-z]+)/m.exec(text); value = m ? m[1] : null; }
  return SCOPE_MODES.includes(value) ? value : null;
}

/** The scope in force for a project, one precedence for every reader:
 *  an explicit NIRVANA_SCOPE in the environment (a spawner pinning it, a CI
 *  run) > the project's manifest > a legacy NIRVANA_SCOPE line in the
 *  project's .env (projects created before the manifest) > global. */
function resolveScopeMode(projectRoot, env, dotenv) {
  const fromEnv = String((env || process.env).NIRVANA_SCOPE || '').toLowerCase();
  if (SCOPE_MODES.includes(fromEnv)) return fromEnv;
  const fromManifest = manifestScope(projectRoot);
  if (fromManifest) return fromManifest;
  const fromDotenv = String((dotenv || {}).NIRVANA_SCOPE || '').toLowerCase();
  return SCOPE_MODES.includes(fromDotenv) ? fromDotenv : 'global';
}

module.exports = {
  PROJECT_MARKER,
  DEFAULT_MARKERS,
  isProjectRoot,
  pinnedProjectRoot,
  resolveProjectRoot,
  undeclaredProjectState,
  globalStoreDir,
  outputsBaseDir,
  manifestScope,
  resolveScopeMode,
  canonical,
  sameDir,
  isUnder,
  isInvalidProjectRoot,
  findProjectRoot,
};
