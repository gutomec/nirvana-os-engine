// orca.js — Orca host detection, in CJS so `harness/lib/audit.js` (the
// canonical emitter, CommonJS) can require() it without crossing the ESM
// boundary Windows enforces as a hard error. orca.ts is the typed face and
// adds everything that spawns the `orca` CLI. Same shape as log-paths.js/.ts
// and audit-provenance.js/.ts.
//
// Orca (https://orca.dev) is a HOST, not a runtime: it manages workspaces,
// terminals and the agents that run in them (claude, codex, gemini, ...). A
// terminal it opens carries its identity in the environment, and that is the
// only thing this module reads. Nothing here touches Orca itself, so every
// function is safe to call from any terminal on any operating system: outside
// Orca they answer null and change nothing.
//
// Measured on Orca 1.4.198 (macOS): a terminal exports TERM_PROGRAM=Orca,
// ORCA_WORKTREE_ID (`<repoId>::<path>`), ORCA_TERMINAL_HANDLE, ORCA_PANE_KEY,
// ORCA_TAB_ID, ORCA_APP_VERSION, ORCA_USER_DATA_PATH and the ORCA_AGENT_HOOK_*
// endpoint its status hooks post to.
'use strict';

/** The variables Orca's agent hooks use to attribute a session to a pane. A
 *  headless child that inherits them is reported to Orca as THAT pane's agent
 *  (measured: `claude -p` spawned in an Orca terminal registered the pane as a
 *  claude session; the same child without them registered nothing). The
 *  engine strips them from the children it spawns, so the pane keeps
 *  describing the process the user started there. */
const PANE_ENV_KEYS = ['ORCA_PANE_KEY', 'ORCA_TAB_ID', 'ORCA_AGENT_LAUNCH_TOKEN', 'ORCA_TERMINAL_HANDLE'];

function insideOrcaTerminal(env) {
  const e = env || process.env;
  return e.TERM_PROGRAM === 'Orca' || Boolean(e.ORCA_TERMINAL_HANDLE) || Boolean(e.ORCA_WORKTREE_ID);
}

/** What the environment says about the enclosing Orca terminal; null outside one. */
function detectOrca(env) {
  const e = env || process.env;
  if (!insideOrcaTerminal(e)) return null;
  return {
    worktreeId: e.ORCA_WORKTREE_ID || null,
    terminalHandle: e.ORCA_TERMINAL_HANDLE || null,
    paneKey: e.ORCA_PANE_KEY || null,
    tabId: e.ORCA_TAB_ID || null,
    appVersion: e.ORCA_APP_VERSION || null,
    userDataPath: e.ORCA_USER_DATA_PATH || null,
  };
}

/** The `orca` block an audit event carries when emitted from an Orca terminal,
 *  so a reader (Glance, `nrv audit where`) can say which workspace and pane a
 *  run happened in. Null outside Orca: the block never appears there. */
function orcaAuditContext(env) {
  const ctx = detectOrca(env);
  if (!ctx) return null;
  const out = {};
  if (ctx.worktreeId) out.worktree_id = ctx.worktreeId;
  if (ctx.terminalHandle) out.terminal_handle = ctx.terminalHandle;
  if (ctx.paneKey) out.pane_key = ctx.paneKey;
  if (ctx.appVersion) out.app_version = ctx.appVersion;
  return Object.keys(out).length ? out : null;
}

/**
 * The executable to call, by the rule Orca's own skill guide states: an
 * explicit ORCA_CLI_COMMAND (managed WSL sessions) wins; a dev checkout
 * (ORCA_DEV_REPO_ROOT) uses `orca-dev`; on Linux OUTSIDE an Orca terminal the
 * name is `orca-ide`, because bare `orca` there is normally the GNOME screen
 * reader and running it starts speech on the user's machine; otherwise `orca`.
 */
function resolveOrcaExecutable(env, platform) {
  const e = env || process.env;
  const p = platform || process.platform;
  if (e.ORCA_CLI_COMMAND) return e.ORCA_CLI_COMMAND;
  if (e.ORCA_DEV_REPO_ROOT) return 'orca-dev';
  if (p === 'linux' && !insideOrcaTerminal(e)) return 'orca-ide';
  return 'orca';
}

/** A copy of `env` without the pane identity (see PANE_ENV_KEYS). */
function stripOrcaPaneEnv(env) {
  const out = Object.assign({}, env || process.env);
  for (const k of PANE_ENV_KEYS) delete out[k];
  return out;
}

/**
 * The host mode as the environment alone can tell it: `NIRVANA_ORCA_HOST` is
 * the variable behind the `host.orca` setting (auto | on | off). `auto` (or
 * unset) means "inside an Orca terminal"; `on` forces the host even from a
 * plain terminal (the app must be running); `off` disables every Orca call.
 * orca.ts resolves the same key through the settings core (config files
 * included); this reader exists for the CJS emitter, which has env only.
 */
function orcaHostActiveEnv(env) {
  const e = env || process.env;
  const mode = String(e.NIRVANA_ORCA_HOST || 'auto').trim().toLowerCase();
  if (mode === 'off' || mode === '0' || mode === 'false') return false;
  if (mode === 'on' || mode === '1' || mode === 'true') return true;
  return insideOrcaTerminal(e);
}

/** The `--worktree` selector for the workspace a run belongs to: the enclosing
 *  Orca worktree when there is one, else the project root by path. */
function orcaWorkspaceSelector(projectRoot, env) {
  const e = env || process.env;
  if (e.ORCA_WORKTREE_ID) return `id:${e.ORCA_WORKTREE_ID}`;
  if (projectRoot) return `path:${projectRoot}`;
  return 'active';
}

module.exports = {
  PANE_ENV_KEYS,
  insideOrcaTerminal,
  detectOrca,
  orcaAuditContext,
  resolveOrcaExecutable,
  stripOrcaPaneEnv,
  orcaHostActiveEnv,
  orcaWorkspaceSelector,
};
