/**
 * bun-helpers.ts — cross-platform helpers shared by every migrated `.ts`
 * script in the Nirvana framework. Designed for Bun runtime; falls back to
 * Node when invoked via `node`.
 *
 * Why Bun: native Windows support without WSL/Git Bash, embedded POSIX
 * commands (cat/find/grep/etc.), shell syntax via `Bun.$`. Migrating from
 * `.sh` to `.ts` makes the system work identically on macOS/Linux/Windows
 * with one runtime install.
 *
 * Public API (intentionally small):
 *   - $          re-export of Bun.$ (with Node fallback that throws)
 *   - exec()     run a command, capture output, structured result
 *   - exists()   path existence
 *   - readJson() / writeJson()
 *   - paths      cross-platform env-resolved paths (HOME, SQUADS_DIR, etc.)
 *   - log        consistent stderr logger with --quiet honoring
 *   - parseArgs  tiny CLI flag parser
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";

// ─────────────────────────────────────────────────────────────────────
// Bun.$ re-export with Node fallback
// ─────────────────────────────────────────────────────────────────────

let bunShell: any;
try {
  // @ts-ignore — Bun-only import
  bunShell = (await import("bun")).$;
} catch {
  // Running under Node: provide a minimal shim that funnels to execSync
  bunShell = (strings: TemplateStringsArray, ...values: any[]) => {
    const cmd = String.raw({ raw: strings }, ...values);
    return {
      async text() { return execSync(cmd, { encoding: "utf8" }); },
      async quiet() { execSync(cmd, { stdio: "pipe" }); return this; },
      async nothrow() { try { execSync(cmd, { stdio: "ignore" }); } catch {} return this; },
    };
  };
}
export const $ = bunShell;

// ─────────────────────────────────────────────────────────────────────
// Paths — re-export of _shared/lib/paths.js (the canonical resolver)
// ─────────────────────────────────────────────────────────────────────

const SKILLS_ROOT = process.env.NIRVANA_SKILLS_DIR
  || (fs.existsSync(path.join(os.homedir(), ".nirvana", "skills")) ? path.join(os.homedir(), ".nirvana", "skills") : path.join(os.homedir(), ".claude", "skills"));

const PATHS_JS_CANDIDATES = [
  path.join(SKILLS_ROOT, "_shared", "lib", "paths.js"),
  path.resolve(import.meta.dir || __dirname, "paths.js"),
];

let _paths: Record<string, string> | null = null;
/** Invalidate the cached paths object so the next access re-reads process.env.
 *  Used by Glance Settings panel after live-reloading .env vars. */
export function invalidatePathsCache(): void { _paths = null; }
function loadPaths(): Record<string, string> {
  if (_paths) return _paths;
  for (const p of PATHS_JS_CANDIDATES) {
    if (fs.existsSync(p)) {
      // dynamic require for both Bun + Node compatibility
      const mod = require(p);
      _paths = mod;
      return _paths;
    }
  }
  // Fallback synth
  const HOME = os.homedir();
  const NIRVANA_HOME = process.env.NIRVANA_HOME || HOME;
  _paths = {
    HOME, NIRVANA_HOME,
    SQUADS_DIR: process.env.SQUADS_DIR || path.join(NIRVANA_HOME, "squads"),
    SQUADS_LEGACY_DIR: process.env.SQUADS_LEGACY_DIR || path.join(NIRVANA_HOME, "squads-legacy-v4"),
    BUSINESSES_DIR: process.env.BUSINESSES_DIR || path.join(NIRVANA_HOME, "businesses"),
    BUSINESSES_LIBRARY: process.env.BUSINESSES_LIBRARY || path.join(NIRVANA_HOME, "businesses", "_library"),
    DNA_LIBRARY: process.env.DNA_LIBRARY || path.join(NIRVANA_HOME, "businesses", "_library", "dna"),
    HARNESS_LOGS_DIR: process.env.HARNESS_LOGS_DIR || path.join(NIRVANA_HOME, ".harness-logs"),
    MAESTRO_LOGS_DIR: process.env.MAESTRO_LOGS_DIR || path.join(NIRVANA_HOME, ".maestro-logs"),
    BUSINESSES_REGISTRY_PATH: process.env.BUSINESSES_REGISTRY_PATH || path.join(NIRVANA_HOME, ".businesses-registry.json"),
    SQUADS_REGISTRY_PATH: process.env.SQUADS_REGISTRY_PATH || path.join(NIRVANA_HOME, ".squads-registry.json"),
    SQUADS_STATE_DIR: process.env.NIRVANA_STATE_DIR || path.join(NIRVANA_HOME, ".nirvana", "squads-state"),
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR || path.join(HOME, ".claude"),
    CLAUDE_AGENTS_DIR: process.env.CLAUDE_AGENTS_DIR || path.join(HOME, ".claude", "agents"),
    CLAUDE_SKILLS_DIR: process.env.CLAUDE_SKILLS_DIR || SKILLS_ROOT,
    PROJECTS_OUTPUT_DIR: process.env.PROJECTS_OUTPUT_DIR || ".projects-outputs",
    MAESTRO_DIR: process.env.MAESTRO_DIR || path.join(NIRVANA_HOME, "squads", "business-nirvana-maestro"),
  };
  return _paths;
}
export const paths = new Proxy({}, {
  get: (_, key: string) => loadPaths()[key],
}) as any;

// ─────────────────────────────────────────────────────────────────────
// Process exec — cross-platform, structured result
// ─────────────────────────────────────────────────────────────────────

/**
 * Absolute path to the current JS runtime (Bun). Use this to run helper
 * .js/.ts files instead of a literal "node" — a clean machine that follows
 * SETUP.md has only Bun, no Node. Bun runs both .js and .ts directly.
 */
export const BUN_BIN = process.execPath;

export interface ExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
  error?: string;
}

export function exec(cmd: string, opts: { cwd?: string; env?: Record<string, string>; timeoutMs?: number; silent?: boolean } = {}): ExecResult {
  const stdio = opts.silent ? "pipe" : (process.env.NIRVANA_VERBOSE === "1" ? "inherit" : "pipe");
  try {
    const out = execSync(cmd, {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env || {}) },
      timeout: opts.timeoutMs ?? 600_000,
      stdio,
      encoding: "utf8",
    });
    return { ok: true, stdout: out || "", stderr: "", code: 0 };
  } catch (e: any) {
    return {
      ok: false,
      stdout: e.stdout?.toString() || "",
      stderr: e.stderr?.toString() || "",
      code: e.status ?? null,
      error: e.message,
    };
  }
}

export function commandExists(cmd: string): boolean {
  const probe = process.platform === "win32" ? `where ${cmd}` : `command -v ${cmd}`;
  return exec(probe, { silent: true }).ok;
}

// ─────────────────────────────────────────────────────────────────────
// File helpers
// ─────────────────────────────────────────────────────────────────────

export const exists = (p: string) => fs.existsSync(p);
export const readJson = <T = any>(p: string): T => JSON.parse(fs.readFileSync(p, "utf8"));
export const writeJson = (p: string, data: any, indent = 2) =>
  fs.writeFileSync(p, JSON.stringify(data, null, indent));
// Tolerante a EEXIST: no Windows o Bun pode lançar EEXIST mesmo com
// recursive:true (e existsSync não enxerga junctions direito). No Mac/Linux o
// catch nunca dispara.
export const ensureDir = (p: string) => {
  try { fs.mkdirSync(p, { recursive: true }); }
  catch (e) { if ((e as NodeJS.ErrnoException)?.code !== "EEXIST") throw e; }
};
export const expandPath = (p: string) =>
  p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;

// ─────────────────────────────────────────────────────────────────────
// Logging
// ─────────────────────────────────────────────────────────────────────

let _quiet = false;
export const log = {
  setQuiet(v: boolean) { _quiet = v; },
  info(msg: string) { if (!_quiet) console.error(`[info] ${msg}`); },
  ok(msg: string) { if (!_quiet) console.error(`[ok]   ${msg}`); },
  warn(msg: string) { if (!_quiet) console.error(`[warn] ${msg}`); },
  fail(msg: string) { console.error(`[fail] ${msg}`); },
};

// ─────────────────────────────────────────────────────────────────────
// Tiny CLI parser — short flags, long flags, positionals
// ─────────────────────────────────────────────────────────────────────

export interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
}

export function parseArgs(argv: string[] = process.argv.slice(2)): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const name = a.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("-")) {
          flags[name] = next; i++;
        } else {
          flags[name] = true;
        }
      }
    } else if (a.startsWith("-") && a.length > 1) {
      flags[a.slice(1)] = true;
    } else {
      positional.push(a);
    }
  }
  if ("quiet" in flags || "q" in flags) _quiet = true;
  if ("verbose" in flags || "v" in flags) process.env.NIRVANA_VERBOSE = "1";
  return { positional, flags };
}

// ─────────────────────────────────────────────────────────────────────
// Standard exit codes per SCRIPT_CONTRACT.md
// ─────────────────────────────────────────────────────────────────────

export const EXIT = {
  OK: 0,
  FAILURES: 1,
  CONFIRMATION_REQUIRED: 2,
  INVALID_ARGS: 4,
} as const;
