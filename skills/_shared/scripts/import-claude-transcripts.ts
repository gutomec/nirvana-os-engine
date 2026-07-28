#!/usr/bin/env bun
/**
 * import-claude-transcripts.ts — backfill cost_emission events from Claude Code
 * persisted transcripts.
 *
 * Claude Code stores conversation transcripts at:
 *   ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl
 *
 * Each `assistant` message line carries a `usage` block with token counts.
 * This script walks the transcripts for the current project (or a specified
 * directory), aggregates per-message usage, and emits `cost_emission` audit
 * events into the SQLite state-db so Glance Cost dashboard reflects reality.
 *
 * Idempotent: each emit is keyed by (session_id, message_id) hash; replaying
 * the same transcripts is a no-op.
 *
 * Usage:
 *   bun import-claude-transcripts.ts                  # current project
 *   bun import-claude-transcripts.ts --cwd <dir>      # specific dir
 *   bun import-claude-transcripts.ts --all            # all projects
 *   bun import-claude-transcripts.ts --dry-run
 *   bun import-claude-transcripts.ts --since 2026-05-01
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { parseArgs, EXIT } from "../lib/bun-helpers.ts";

const SKILLS_ROOT = process.env.NIRVANA_SKILLS_DIR
  || (fs.existsSync(path.join(os.homedir(), ".nirvana", "skills")) ? path.join(os.homedir(), ".nirvana", "skills") : path.join(os.homedir(), ".claude", "skills"));

const audit = require(path.join(SKILLS_ROOT, "harness", "lib", "audit.js"));
const sdb = require(path.join(SKILLS_ROOT, "_shared", "lib", "state-db.js"));

const { flags } = parseArgs();
const dryRun = !!flags["dry-run"];
const cwd = (flags.cwd as string) || process.cwd();
const all = !!flags.all;
const sinceArg = (flags.since as string) || null;
const sinceMs = sinceArg ? new Date(sinceArg).getTime() : 0;

const PROJECTS_ROOT = path.join(os.homedir(), ".claude", "projects");

function encodeProjectPath(absPath: string): string {
  // Claude Code encodes the absolute path by replacing slashes with hyphens
  // and prefixing with a single dash. e.g. ~/foo → -Users-guto-foo.
  return absPath.replace(/\//g, "-");
}

function selectDirs(): string[] {
  if (all) {
    return fs.readdirSync(PROJECTS_ROOT)
      .map(name => path.join(PROJECTS_ROOT, name))
      .filter(p => fs.statSync(p).isDirectory());
  }
  const encoded = encodeProjectPath(path.resolve(cwd));
  const dir = path.join(PROJECTS_ROOT, encoded);
  if (!fs.existsSync(dir)) {
    console.error(`[import] no transcripts found for ${cwd} at ${dir}`);
    return [];
  }
  return [dir];
}

function listJsonl(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith(".jsonl"))
    .map(f => path.join(dir, f));
}

function dedupKey(sessionId: string, msgId: string): string {
  return crypto.createHash("sha1").update(`${sessionId}|${msgId}`).digest("hex").slice(0, 16);
}

// Pre-load existing message ids to make import idempotent
function loadSeenKeys(): Set<string> {
  const seen = new Set<string>();
  try {
    const handle = sdb.openDb(null);
    if (!handle.available) return seen;
    const events = sdb.listAudit(handle, { event: "cost_emission" }, 200_000);
    for (const e of events) {
      const sid = e.payload?.session_id || e.payload?.payload?.session_id;
      const mid = e.payload?.message_id || e.payload?.payload?.message_id;
      if (sid && mid) seen.add(dedupKey(sid, mid));
    }
  } catch {}
  return seen;
}

let totalLines = 0;
let totalEmitted = 0;
let totalSkipped = 0;
let totalErrored = 0;
let totalTokens = 0;
let totalCostUsd = 0;

const seen = loadSeenKeys();
const dirs = selectDirs();
console.error(`[import] scanning ${dirs.length} project dir(s)…${dryRun ? " (dry-run)" : ""}`);

for (const dir of dirs) {
  const projectId = path.basename(dir).replace(/^-/, "").replace(/-/g, "/");
  for (const file of listJsonl(dir)) {
    let raw: string;
    try { raw = fs.readFileSync(file, "utf8"); }
    catch { continue; }
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      totalLines++;
      let entry: any;
      try { entry = JSON.parse(line); }
      catch { totalErrored++; continue; }

      // Only assistant messages carry usage
      const msg = entry.message;
      if (!msg || msg.role !== "assistant" || !msg.usage) continue;

      const sessionId = entry.sessionId || msg.id || "unknown";
      const msgId = msg.id || `${sessionId}:${entry.uuid || crypto.randomBytes(4).toString("hex")}`;
      const key = dedupKey(sessionId, msgId);
      if (seen.has(key)) { totalSkipped++; continue; }
      seen.add(key);

      const ts = entry.timestamp || msg.timestamp || new Date().toISOString();
      const tsMs = new Date(ts).getTime();
      if (sinceMs && tsMs < sinceMs) { totalSkipped++; continue; }

      const usage = {
        input_tokens: Number(msg.usage.input_tokens || 0),
        output_tokens: Number(msg.usage.output_tokens || 0),
        cache_creation_input_tokens: Number(msg.usage.cache_creation_input_tokens || 0),
        cache_read_input_tokens: Number(msg.usage.cache_read_input_tokens || 0),
      };
      const totalTk = usage.input_tokens + usage.output_tokens
                    + usage.cache_creation_input_tokens + usage.cache_read_input_tokens;
      if (totalTk === 0) { totalSkipped++; continue; }

      // Local USD estimate (same default pricing as cost-aggregator)
      const usd = (
        usage.input_tokens * 3
        + usage.cache_creation_input_tokens * 3.75
        + usage.cache_read_input_tokens * 0.30
        + usage.output_tokens * 15
      ) / 1_000_000;
      totalTokens += totalTk;
      totalCostUsd += usd;

      const payload = {
        host: "claude-code",
        caller_id: "claude-code-transcript",
        session_id: sessionId,
        message_id: msgId,
        model: msg.model || null,
        usage,
        total_cost_usd: usd,
        duration_ms: null,
        is_sidechain: !!entry.isSidechain,
        stop_reason: msg.stop_reason || null,
      };

      if (!dryRun) {
        try {
          audit.emit("cost_emission", payload, {
            trace_id: sessionId,
            project_id: projectId,
          });
          totalEmitted++;
        } catch (e: any) {
          totalErrored++;
          console.error(`[import] emit failed: ${e.message}`);
        }
      } else {
        totalEmitted++;
      }
    }
  }
}

console.log("");
console.log(`══════ Transcript Import Result ${dryRun ? "(DRY-RUN)" : ""} ══════`);
console.log(`  scanned lines:    ${totalLines.toLocaleString()}`);
console.log(`  cost_emissions:   ${totalEmitted.toLocaleString()}`);
console.log(`  skipped (dupe):   ${totalSkipped.toLocaleString()}`);
console.log(`  errored:          ${totalErrored.toLocaleString()}`);
console.log(`  total tokens:     ${totalTokens.toLocaleString()}`);
console.log(`  estimated USD:    $${totalCostUsd.toFixed(4)}`);
console.log("");
process.exit(EXIT.OK);
