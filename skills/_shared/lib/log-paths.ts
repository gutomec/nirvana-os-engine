// log-paths.ts — single source of truth for "where do the harness logs live".
// All read/write callers (audit emit, audit-view, validate-chain, quality-gate,
// employee-prompt, doctor, tui, baseline, etc.) MUST use this helper. Hardcoded
// `~/.harness-logs` paths create split brain: writes go per-project, reads still
// hit $HOME, the audit chain breaks.
//
// Resolution order (first match wins):
//   1. $HARNESS_LOGS_DIR (explicit override, honored everywhere)
//   2. <projectRoot>/.nirvana/logs/harness/   (when running inside a project)
//   3. ~/.harness-logs/                       (fallback, no project context)

import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";

function canonicalDir(dir: string): string {
  try {
    return fs.realpathSync.native ? fs.realpathSync.native(dir) : fs.realpathSync(dir);
  } catch {
    return path.resolve(dir);
  }
}

const sameDir = (a: string, b: string): boolean =>
  process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;

// Is `descendant` strictly inside `ancestor`?
const isStrictlyUnder = (ancestor: string, descendant: string): boolean => {
  const prefix = ancestor.endsWith(path.sep) ? ancestor : ancestor + path.sep;
  return process.platform === "win32"
    ? descendant.toLowerCase().startsWith(prefix.toLowerCase())
    : descendant.startsWith(prefix);
};

/**
 * Walk up from `start` looking for a Nirvana project root marker.
 *
 * HOME — and every directory between `start` and HOME — is never a valid
 * root, even carrying a marker: a stray ~/.nirvana (the engine's own
 * install) sitting in HOME, or on the way up to it, must never be mistaken
 * for a project. On Windows os.tmpdir() resolves *inside* the real HOME, so
 * a walk that starts in a temp dir passes through HOME's own ancestry before
 * it reaches the filesystem root — this is the branch that guards it.
 *
 * Comparison goes through the canonical path (Windows can hand back an 8.3
 * short form for one side and the long form for the other) and is
 * case-insensitive on Windows.
 */
function findProjectRoot(start: string): string | null {
  let dir = canonicalDir(path.resolve(start));
  const home = canonicalDir(os.homedir());
  const root = path.parse(dir).root;
  while (dir !== root && !sameDir(dir, home) && !isStrictlyUnder(dir, home)) {
    for (const marker of [".nirvana", ".env", ".git", "package.json", "pyproject.toml"]) {
      if (fs.existsSync(path.join(dir, marker))) return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function harnessLogsDir(opts: { cwd?: string; projectRoot?: string } = {}): string {
  if (process.env.HARNESS_LOGS_DIR) return path.resolve(process.env.HARNESS_LOGS_DIR);
  const root = opts.projectRoot ?? findProjectRoot(opts.cwd ?? process.cwd());
  if (root) return path.join(root, ".nirvana", "logs", "harness");
  return path.join(os.homedir(), ".harness-logs");
}

export function maestroLogsDir(opts: { cwd?: string; projectRoot?: string } = {}): string {
  if (process.env.MAESTRO_LOGS_DIR) return path.resolve(process.env.MAESTRO_LOGS_DIR);
  const root = opts.projectRoot ?? findProjectRoot(opts.cwd ?? process.cwd());
  if (root) return path.join(root, ".nirvana", "logs", "maestro");
  return path.join(os.homedir(), ".maestro-logs");
}

export function todayAuditFile(opts: { cwd?: string; projectRoot?: string } = {}): string {
  const today = new Date().toISOString().slice(0, 10);
  return path.join(harnessLogsDir(opts), today, "audit.jsonl");
}
