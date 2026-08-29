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

/** The marker files paths.js and scope.ts have always used. handoff.js and
 *  wiki-lint.js pass a narrower list (their own historical behaviour) via
 *  `opts.markers` — the walk hardening applies regardless of which list. */
const DEFAULT_MARKERS = ['.env', '.nirvana', '.git', 'package.json', 'pyproject.toml'];

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
function isInvalidProjectRoot(dir, opts) {
  if (!dir) return true;
  if (dir === '/' || dir === '') return true;
  try {
    const resolved = canonical(dir);
    if (resolved === path.parse(resolved).root) return true;
    if (sameDir(resolved, homeDir(opts))) return true;
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
 * Walk up from `start` looking for a Nirvana project root marker.
 *
 * @param {string} start
 * @param {{markers?: string[], home?: string}} [opts]
 *   `markers` — file/dir names that identify a project root (default: the
 *   five paths.js/scope.ts have always used). `home` overrides the resolved
 *   HOME, for tests.
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

module.exports = {
  DEFAULT_MARKERS,
  canonical,
  sameDir,
  isUnder,
  isInvalidProjectRoot,
  findProjectRoot,
};
