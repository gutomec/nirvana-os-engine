/**
 * env-path.js — a path override read from the environment, expanded, or nothing.
 *
 * A runtime that loads a `.env` without shell expansion (dotenv semantics)
 * hands the engine values such as `$NIRVANA_HOME/.harness-logs` literally.
 * `path.resolve` reads that as a path relative to the cwd, and the first write
 * creates a folder literally named `$NIRVANA_HOME` wherever the agent happens
 * to run.
 *
 * Every reader of a directory or file override goes through here. `~`, `$VAR`
 * and `${VAR}` are expanded from the environment, over a few passes so a
 * variable whose own value is a reference (`NIRVANA_HOME=$HOME`) resolves too.
 * A value that is still relative, or still carries a `$`, is not a location the
 * user could have meant: it is ignored with one warning per variable, and the
 * caller falls through to its next rung exactly as if the variable were unset.
 *
 * CommonJS on purpose, like log-paths.js: `.js` callers require() it directly.
 */

'use strict';

const os = require('os');
const path = require('path');

const MAX_PASSES = 4;
const REF = /\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)/g;
const warned = new Set();

/** Absolute on this platform, or a Windows drive / UNC path on any platform. */
function isAbsolutePath(p) {
  return path.isAbsolute(p) || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\');
}

/** The expanded, absolute form of `value`, or null when it is not one. */
function expandPath(value, env) {
  if (typeof value !== 'string') return null;
  const source = env || process.env;
  let v = value.trim();
  if (!v) return null;
  for (let i = 0; i < MAX_PASSES && v.includes('$'); i++) {
    const next = v.replace(REF, (full, braced, bare) => {
      const got = source[braced || bare];
      return got ? got : full;
    });
    if (next === v) break;
    v = next;
  }
  if (v === '~' || v.startsWith('~/') || v.startsWith('~\\')) v = path.join(os.homedir(), v.slice(1));
  if (v.includes('$') || !isAbsolutePath(v)) return null;
  return path.isAbsolute(v) ? path.resolve(v) : v;
}

/** `env[name]` as an absolute path, or null when unset or unusable (warned once). */
function envPath(name, env) {
  const source = env || process.env;
  const raw = source[name];
  if (raw == null || raw === '') return null;
  const resolved = expandPath(raw, source);
  if (resolved === null && !warned.has(name)) {
    warned.add(name);
    process.stderr.write(`[nirvana] ignoring ${name}=${JSON.stringify(raw)}: not an absolute path after expanding ~ and $VAR\n`);
  }
  return resolved;
}

module.exports = { envPath, expandPath, isAbsolutePath };
