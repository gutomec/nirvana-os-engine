/**
 * log-paths.js — CommonJS implementation of "where do the harness logs
 * live". log-paths.ts re-exports this file, typed, so every ESM importer
 * keeps working unchanged (mirrors brief-excerpt.js/.ts).
 *
 * Moved here so a `.js` caller (context-budget.js) can `require()` it
 * directly instead of reaching for the `.ts` — the pattern this file itself
 * used to be an instance of, and that this cut removes as a class: a plain
 * `.js` `require()`d from another `.js` never crosses the CJS/ESM boundary
 * that only Windows' Bun enforces as a hard error for a `.ts` whose
 * dependency chain carries a top-level await.
 *
 * Resolution order (first match wins):
 *   1. $HARNESS_LOGS_DIR / $MAESTRO_LOGS_DIR (explicit override, honored everywhere)
 *   2. <projectRoot>/.nirvana/logs/{harness,maestro}/  (when running inside a project)
 *   3. ~/.harness-logs/ / ~/.maestro-logs/            (fallback, no project context)
 *
 * The project-root walk itself lives in project-root.js — see that file for
 * why HOME (and everything between `start` and HOME) is never a valid root.
 */

'use strict';

const os = require('os');
const path = require('path');
const { findProjectRoot } = require('./project-root.js');

function resolveProjectRoot(opts) {
  const options = opts || {};
  // `?? findProjectRoot(...)` in the original: null and undefined both fall
  // through to the walk, matching every existing caller (several pass
  // `projectRoot: X || undefined` specifically to opt into that fallback).
  return options.projectRoot != null ? options.projectRoot : findProjectRoot(options.cwd || process.cwd());
}

function harnessLogsDir(opts) {
  if (process.env.HARNESS_LOGS_DIR) return path.resolve(process.env.HARNESS_LOGS_DIR);
  const root = resolveProjectRoot(opts);
  if (root) return path.join(root, '.nirvana', 'logs', 'harness');
  return path.join(os.homedir(), '.harness-logs');
}

function maestroLogsDir(opts) {
  if (process.env.MAESTRO_LOGS_DIR) return path.resolve(process.env.MAESTRO_LOGS_DIR);
  const root = resolveProjectRoot(opts);
  if (root) return path.join(root, '.nirvana', 'logs', 'maestro');
  return path.join(os.homedir(), '.maestro-logs');
}

function todayAuditFile(opts) {
  const today = new Date().toISOString().slice(0, 10);
  return path.join(harnessLogsDir(opts), today, 'audit.jsonl');
}

module.exports = { harnessLogsDir, maestroLogsDir, todayAuditFile };
