/**
 * paths.js — scope-aware path resolution across the Nirvana system.
 *
 * Returns paths that automatically follow NIRVANA_SCOPE (global/project/merge)
 * by reading <project>/.env via scope.ts. In project mode, registry/state/logs
 * persist under <project>/.nirvana/ instead of $HOME, so two scope=project
 * projects on the same machine never collide.
 *
 * Usage (default — scope-aware, recommended):
 *   const paths = require('./paths.js');
 *   paths.SQUADS_REGISTRY_PATH  // resolves per current scope
 *
 * Usage (explicit scope override, useful for tests / cross-project tooling):
 *   const { resolvePaths } = require('./paths.js');
 *   const p = resolvePaths({ mode: 'global' });
 *   p.SQUADS_REGISTRY_PATH
 *
 * Usage (legacy global-only — opt-out of scope awareness):
 *   const p = resolvePaths({ mode: 'global', skipScopeFile: true });
 *
 * Resolution priority (highest wins):
 *   1. process.env.<KEY> — explicit override (CI / scripts)
 *   2. scope-aware path (when scope.mode = 'project' and projectRoot is found)
 *   3. global default ($NIRVANA_HOME or $HOME)
 *
 * Backward compatibility:
 *   When NIRVANA_SCOPE is unset or 'global', behaviour is identical to the
 *   previous (constant) version. No change for existing global installations.
 */

'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');

const HOME = os.homedir();
const NIRVANA_HOME = process.env.NIRVANA_HOME || HOME;
const join = (...parts) => path.join(...parts);

// ─────────────────────────────────────────────────────────────────────
// Project root + .env detection (mirrors scope.ts logic, keeps this file
// dependency-free so it stays loadable from CommonJS callers like
// activator.js / registry.js without TS).
// ─────────────────────────────────────────────────────────────────────

const SCOPE_MARKERS = ['.env', '.nirvana', '.git', 'package.json', 'pyproject.toml'];

// HOME and the OS root are never valid projectRoots — even if .env or .nirvana
// happen to exist there. Otherwise the resolver treats the user's HOME as a
// project, which collapses every scope-aware lookup. (Encountered when our own
// state-db created ~/.nirvana/state.db while running outside any project.)
function isInvalidProjectRoot(dir) {
  if (!dir) return true;
  if (dir === '/' || dir === '') return true;
  try {
    if (path.resolve(dir) === path.resolve(process.env.HOME || os.homedir())) return true;
  } catch {}
  return false;
}

function findProjectRoot(start) {
  let cur = path.resolve(start);
  for (let i = 0; i < 30; i++) {
    if (!isInvalidProjectRoot(cur)) {
      for (const m of SCOPE_MARKERS) {
        if (fs.existsSync(path.join(cur, m))) return cur;
      }
    }
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
  return null;
}

// Expand $VAR and ${VAR} references using process.env + values seen earlier in
// the same dotenv file. Falls back to the literal `$VAR` text only when no
// substitution is available (preserves user intent for non-env strings).
function expandEnvRefs(value, scope) {
  if (typeof value !== 'string') return value;
  return value.replace(/\$\{([A-Za-z_][\w]*)\}|\$([A-Za-z_][\w]*)/g, (full, braced, bare) => {
    const key = braced || bare;
    if (process.env[key] != null && process.env[key] !== '') return process.env[key];
    if (scope && scope[key] != null && scope[key] !== '') return scope[key];
    return full;
  });
}

function loadDotenv(envPath) {
  if (!fs.existsSync(envPath)) return {};
  const out = {};
  for (const raw of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    // Expand $VAR / ${VAR} using process.env + previously seen keys in this file.
    out[k] = expandEnvRefs(v, out);
  }
  return out;
}

function detectScope(opts = {}) {
  if (opts.skipScopeFile) {
    return { mode: opts.mode || 'global', projectRoot: null, dotenv: {} };
  }
  const cwd = opts.cwd || process.cwd();
  const projectRoot = process.env.NIRVANA_PROJECT_ROOT
    ? path.resolve(process.env.NIRVANA_PROJECT_ROOT)
    : findProjectRoot(cwd);
  const dotenv = projectRoot ? loadDotenv(path.join(projectRoot, '.env')) : {};
  const cliMode = (() => {
    for (const a of (process.argv || []).slice(2)) {
      if (a.startsWith('--scope=')) return a.slice(8);
    }
    return null;
  })();
  const envMode = (process.env.NIRVANA_SCOPE || dotenv.NIRVANA_SCOPE || '').toLowerCase();
  const mode = opts.mode
    || cliMode
    || (['project', 'merge', 'global'].includes(envMode) ? envMode : 'global');
  return { mode, projectRoot, dotenv };
}

// ─────────────────────────────────────────────────────────────────────
// Core resolver
// ─────────────────────────────────────────────────────────────────────

function resolvePaths(opts = {}) {
  const scope = detectScope(opts);
  const { mode, projectRoot, dotenv } = scope;
  const cfg = (k) => process.env[k] || dotenv[k];

  // Canonical SHARED skills tree + deps. These live in the neutral ~/.nirvana
  // location so every runtime (claude-code, codex, antigravity, hermes) shares
  // ONE copy and the system survives removal of any single runtime — including
  // Claude Code. Falls back to the legacy ~/.claude/skills only while a machine
  // has not migrated yet. Override via NIRVANA_SKILLS_DIR / NIRVANA_DEPS_DIR.
  const nirvanaSkills = join(NIRVANA_HOME, '.nirvana', 'skills');
  const SKILLS_ROOT = cfg('NIRVANA_SKILLS_DIR') || cfg('CLAUDE_SKILLS_DIR')
    || (fs.existsSync(nirvanaSkills) ? nirvanaSkills : join(HOME, '.claude', 'skills'));
  const DEPS_DIR = cfg('NIRVANA_DEPS_DIR') || cfg('DEPS_DIR') || join(NIRVANA_HOME, '.nirvana', 'node_modules');

  // Project-scoped persistence: WHENEVER there is a project root, registry /
  // state / logs live under <project>/.nirvana/, regardless of scope mode.
  // Rationale: nrv is always invoked from inside the project dir; keeping the
  // run's artifacts inside that dir is the principled default — the project
  // becomes self-contained, the global HOME stays clean across many projects,
  // and historical browsing per project is trivial (it's all right there).
  // `mode` still governs which assets are VISIBLE (squads/businesses/clones)
  // via scope.ts. NIRVANA_HOME is the fallback ONLY when no project root is
  // detected (running from $HOME or any non-project dir).
  const projectScoped = !!projectRoot;
  const dotNirvana = projectRoot ? join(projectRoot, '.nirvana') : null;

  const projectPath = (sub) => projectScoped ? join(dotNirvana, sub) : null;

  const p = {
    HOME,
    NIRVANA_HOME,
    NIRVANA_SCOPE_MODE: mode,
    NIRVANA_PROJECT_ROOT: projectRoot,

    // Source-of-truth dirs (these stay global; scope.ts handles enumeration
    // overlay for project-local squads/businesses)
    SQUADS_DIR:               cfg('SQUADS_DIR')               || join(NIRVANA_HOME, 'squads'),
    SQUADS_LEGACY_DIR:        cfg('SQUADS_LEGACY_DIR')        || join(NIRVANA_HOME, 'squads-legacy-v4'),
    BUSINESSES_DIR:           cfg('BUSINESSES_DIR')           || join(NIRVANA_HOME, 'businesses'),
    BUSINESSES_LIBRARY:       cfg('BUSINESSES_LIBRARY')       || join(NIRVANA_HOME, 'businesses', '_library'),
    DNA_LIBRARY:              cfg('DNA_LIBRARY')              || join(NIRVANA_HOME, 'businesses', '_library', 'dna'),

    // Project-anchored: registry/state/logs follow the project WHENEVER a project
    // root exists (any scope mode — see projectScoped note above). HOME is the
    // fallback only when no project is detected. `mode` governs asset VISIBILITY,
    // not persistence location.
    HARNESS_LOGS_DIR:         cfg('HARNESS_LOGS_DIR')         || projectPath('logs/harness') || join(NIRVANA_HOME, '.harness-logs'),
    MAESTRO_LOGS_DIR:         cfg('MAESTRO_LOGS_DIR')         || projectPath('logs/maestro') || join(NIRVANA_HOME, '.maestro-logs'),

    BUSINESSES_REGISTRY_PATH: cfg('BUSINESSES_REGISTRY_PATH') || projectPath('.businesses-registry.json') || join(NIRVANA_HOME, '.businesses-registry.json'),
    SQUADS_REGISTRY_PATH:     cfg('SQUADS_REGISTRY_PATH')     || projectPath('.squads-registry.json')     || join(NIRVANA_HOME, '.squads-registry.json'),

    SQUADS_STATE_DIR:         cfg('NIRVANA_STATE_DIR')        || projectPath('state/squads')              || join(NIRVANA_HOME, '.nirvana', 'squads-state'),

    // Scope-aware authoritative state DB. Race-prone surfaces (audit, gates,
    // decisions) live here. See ~/.claude/skills/_shared/lib/state-db.js.
    STATE_DB:                 cfg('NIRVANA_STATE_DB')         || projectPath('state.db')                  || join(NIRVANA_HOME, '.nirvana', 'state.db'),

    PROJECTS_OUTPUT_DIR:      cfg('PROJECTS_OUTPUT_DIR')      || projectPath('outputs')                   || '.projects-outputs',

    // Constants (not scope-aware): always live in HOME
    CLAUDE_CONFIG_DIR:        cfg('CLAUDE_CONFIG_DIR')        || join(HOME, '.claude'),
    CLAUDE_AGENTS_DIR:        cfg('CLAUDE_AGENTS_DIR')        || join(HOME, '.claude', 'agents'),

    // Canonical shared skills tree + deps (neutral ~/.nirvana location). Every
    // runtime symlinks to SKILLS_ROOT; DEPS_DIR holds the single node_modules.
    // CLAUDE_SKILLS_DIR is kept as a back-compat alias of SKILLS_ROOT so legacy
    // consumers automatically follow the new location.
    SKILLS_ROOT,
    DEPS_DIR,
    CLAUDE_SKILLS_DIR:        SKILLS_ROOT,
  };

  p.MAESTRO_DIR = cfg('MAESTRO_DIR') || join(p.SQUADS_DIR, 'business-nirvana-maestro');

  return p;
}

// Default export: scope-aware paths resolved against current cwd / env
const defaultPaths = resolvePaths();

// Plain object resolved ONCE at require time against the current cwd/scope.
// This is correct for short-lived `bun script.ts` runs invoked from the
// project cwd: the snapshot matches the process's scope for its whole life.
// It does NOT re-resolve — a long-lived process that changes cwd or scope
// must call resolvePaths() again (or bun-helpers.invalidatePathsCache()) to
// pick up the new scope; reading keys off this export will keep returning
// the values captured at require time.
module.exports = defaultPaths;
module.exports.resolvePaths = resolvePaths;
module.exports.detectScope = detectScope;
