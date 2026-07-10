#!/usr/bin/env bun
/**
 * watch-fs.ts — filesystem-based audit daemon (evidence over claims).
 *
 * Watches a project directory and emits `artifact_touched` audit events
 * whenever files are created/modified/renamed inside it. Independent of
 * any agent — works for Cursor, Antigravity, Aider, future Gemini, anything.
 * If the agent lies about what it did, the filesystem doesn't.
 *
 * Usage:
 *   nrv watch-fs <project_path>                    # watch one project, emit events
 *   nrv watch-fs <project> --trace abc123          # tag events with given trace_id
 *   nrv watch-fs <project> --label gemini-real     # custom host label
 *   nrv watch-fs <project> --quiet                 # suppress stdout, only emit events
 *
 * Each event written:
 *   { ts, event: "artifact_touched", host: "fs-watch", trace_id, file_path,
 *     action: "create" | "modify" | "rename" | "delete", cwd }
 *
 * Ignores: .git/, node_modules/, .nirvana/state/, *.swp, .DS_Store, ~ tempfiles.
 *
 * Failure mode: log to stderr, don't crash. Survives single-file errors.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { parseArgs, EXIT } from "../../_shared/lib/bun-helpers.ts";

const SKILLS_ROOT = process.env.NIRVANA_SKILLS_DIR
  || (fs.existsSync(path.join(os.homedir(), ".nirvana", "skills")) ? path.join(os.homedir(), ".nirvana", "skills") : path.join(os.homedir(), ".claude", "skills"));
const { harnessLogsDir } = require(path.join(SKILLS_ROOT, "_shared/lib/log-paths.ts"));
const HARNESS_LOGS_ROOT = harnessLogsDir();

const IGNORE_DIRS = new Set([".git", "node_modules", ".DS_Store", ".idea", ".vscode", "__pycache__", "dist", "build"]);
const IGNORE_DIR_SUFFIXES = [".nirvana/state", ".harness-logs", ".bun"];
const IGNORE_FILE_PATTERNS = [/\.swp$/, /~$/, /^\.#/, /\.tmp$/, /\.pyc$/];

function shouldIgnore(filePath: string): boolean {
  const base = path.basename(filePath);
  for (const re of IGNORE_FILE_PATTERNS) if (re.test(base)) return true;
  if (IGNORE_DIRS.has(base)) return true;
  for (const suffix of IGNORE_DIR_SUFFIXES) if (filePath.includes(suffix)) return true;
  if (filePath.includes("/.git/") || filePath.includes("/node_modules/")) return true;
  return false;
}

function todayDir(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function appendEvent(ev: Record<string, any>): void {
  try {
    const dir = path.join(HARNESS_LOGS_ROOT, todayDir());
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "audit.jsonl"), JSON.stringify(ev) + "\n", "utf8");
  } catch (e: any) {
    process.stderr.write(`[watch-fs] failed to append: ${e.message}\n`);
  }
}

// Debounce by (path, action) to coalesce rapid file events (editors save in 2-3 events).
const recentEvents = new Map<string, number>();
const DEBOUNCE_MS = 300;

function shouldEmit(key: string): boolean {
  const now = Date.now();
  const last = recentEvents.get(key) || 0;
  if (now - last < DEBOUNCE_MS) return false;
  recentEvents.set(key, now);
  // Garbage collect old entries every 1000 events
  if (recentEvents.size > 1000) {
    const cutoff = now - 60_000;
    for (const [k, t] of recentEvents) if (t < cutoff) recentEvents.delete(k);
  }
  return true;
}

function classifyAction(filePath: string, eventType: string): "create" | "modify" | "rename" | "delete" {
  if (eventType === "rename") {
    return fs.existsSync(filePath) ? "create" : "delete";
  }
  return "modify";
}

async function main() {
  const { positional, flags } = parseArgs();

  if (flags.h || flags.help) {
    console.log(`watch-fs — filesystem-based audit daemon (evidence over claims)

USAGE
  nrv watch-fs <project_path>                  watch one project
  nrv watch-fs <path> --trace <trace_id>       tag events with given trace
  nrv watch-fs <path> --label <host>           custom host label (default fs-watch)
  nrv watch-fs <path> --quiet                  suppress stdout

WHAT IT DOES
  Watches the project dir and emits audit events for every file create/modify/
  delete. Independent of any agent — works for Cursor, Antigravity, Aider,
  Gemini, Claude, anything. Use it when an agent doesn't have hooks (or when
  you don't trust its claims).

  Events written to ~/.harness-logs/<today>/audit.jsonl with host="fs-watch"
  (or your --label). Show up in Glance Runs and 'nrv watch'.

EXAMPLES
  nrv watch-fs ~/projects/meu-novo-projeto
  nrv watch-fs ~/projects/meu-novo-projeto --trace gemini-2026-05
  nrv watch-fs ~/projects/foo --label cursor-fs
`);
    process.exit(EXIT.OK);
  }

  const target = positional[0];
  if (!target) {
    process.stderr.write("nrv watch-fs: missing <project_path>\n");
    process.exit(EXIT.INVALID_ARGS);
  }
  const root = path.resolve(target.replace(/^~/, os.homedir()));
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    process.stderr.write(`nrv watch-fs: not a directory: ${root}\n`);
    process.exit(EXIT.INVALID_ARGS);
  }

  const traceId = flags.trace ? String(flags.trace) : `fs-${crypto.randomBytes(4).toString("hex")}-${Date.now()}`;
  const hostLabel = flags.label ? String(flags.label) : "fs-watch";
  const quiet = !!flags.quiet;

  if (!quiet) {
    process.stderr.write(`fs-watch: ${root}\n`);
    process.stderr.write(`trace_id: ${traceId}\n`);
    process.stderr.write(`host:     ${hostLabel}\n`);
    process.stderr.write(`(Ctrl-C to stop)\n\n`);
  }

  // Emit watch_started event
  appendEvent({
    ts: new Date().toISOString(),
    trace_id: traceId,
    host: hostLabel,
    event: "watch_started",
    cwd: root,
  });

  // Recursive watch — Bun supports `recursive: true` on macOS/Windows; on Linux
  // it falls back per-directory. We use the higher-level fs.watch with recursive.
  let watcher: fs.FSWatcher;
  try {
    watcher = fs.watch(root, { recursive: true }, (eventType, filename) => {
      if (!filename) return;
      const fullPath = path.join(root, filename);
      if (shouldIgnore(fullPath)) return;

      const action = classifyAction(fullPath, eventType);
      const key = `${action}:${fullPath}`;
      if (!shouldEmit(key)) return;

      const ev: Record<string, any> = {
        ts: new Date().toISOString(),
        trace_id: traceId,
        host: hostLabel,
        event: "artifact_touched",
        action,
        file_path: fullPath,
        cwd: root,
      };

      // Best-effort size attribution for created/modified files
      if (action === "create" || action === "modify") {
        try {
          const st = fs.statSync(fullPath);
          ev.size_bytes = st.size;
        } catch { /* file might be gone already */ }
      }

      appendEvent(ev);
      if (!quiet) {
        process.stderr.write(`${ev.ts.slice(11, 19)} ${action.padEnd(7)} ${path.relative(root, fullPath)}\n`);
      }
    });
  } catch (e: any) {
    process.stderr.write(`nrv watch-fs: cannot watch ${root}: ${e.message}\n`);
    process.exit(EXIT.FAILURES);
  }

  // Graceful shutdown
  const stop = () => {
    appendEvent({
      ts: new Date().toISOString(),
      trace_id: traceId,
      host: hostLabel,
      event: "watch_stopped",
      cwd: root,
    });
    watcher.close();
    process.exit(EXIT.OK);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  // Keep alive
  await new Promise(() => {});
}

main().catch(e => { process.stderr.write(`watch-fs: ${e.message}\n`); process.exit(EXIT.FAILURES); });
