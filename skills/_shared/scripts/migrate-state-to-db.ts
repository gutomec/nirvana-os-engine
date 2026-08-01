#!/usr/bin/env bun
/**
 * migrate-state-to-db.ts — one-shot migration from JSONL audit logs into the
 * SQLite-backed state.db.
 *
 * Walks the project's audit log roots and copies events into audit_events.
 * Idempotent: keys events by (trace_id, ts, event) hash and skips duplicates.
 *
 * Usage:
 *   bun migrate-state-to-db.ts [--dry-run] [--root <dir>] [--verbose]
 *
 * Default roots scanned (when --root not given):
 *   <projectRoot>/.harness-logs/
 *   <projectRoot>/.maestro-logs/
 *   <projectRoot>/.nirvana/logs/harness/
 *   <projectRoot>/.nirvana/logs/maestro/
 *   ~/.harness-logs/
 *   ~/.maestro-logs/
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { parseArgs, EXIT } from "../lib/bun-helpers.ts";
import { resolveScope } from "../lib/scope.ts";

const sdb = require("../lib/state-db.js");

const { flags } = parseArgs();
const dryRun = !!flags["dry-run"];
const verbose = !!flags.verbose || !!flags.v;
const rootOverride = flags.root as string | undefined;

const scope = resolveScope();
const handle = sdb.openDb(scope.projectRoot);
if (!handle.available) {
  console.error(`[migrate] SQLite unavailable: ${handle.reason}`);
  process.exit(EXIT.FAILURES);
}

const candidateRoots = rootOverride
  ? [rootOverride]
  : [
    scope.projectRoot && path.join(scope.projectRoot, ".harness-logs"),
    scope.projectRoot && path.join(scope.projectRoot, ".maestro-logs"),
    scope.projectRoot && path.join(scope.projectRoot, ".nirvana", "logs", "harness"),
    scope.projectRoot && path.join(scope.projectRoot, ".nirvana", "logs", "maestro"),
    path.join(os.homedir(), ".harness-logs"),
    path.join(os.homedir(), ".maestro-logs"),
  ].filter(Boolean) as string[];

const seen = new Set<string>();
{
  // Pre-load existing event hashes to make migration idempotent.
  const existing = sdb.listAudit(handle, {}, 100_000);
  for (const e of existing) seen.add(hashEvent(e.trace_id, e.ts, e.event));
}

function hashEvent(traceId: string | null, ts: string, event: string): string {
  return crypto.createHash("sha1").update(`${traceId || ""}|${ts}|${event}`).digest("hex").slice(0, 16);
}

function* walkJsonl(root: string): Generator<string> {
  if (!fs.existsSync(root)) return;
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { continue; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile() && /\.jsonl?$/.test(e.name)) yield full;
    }
  }
}

let scanned = 0;
let inserted = 0;
let skipped = 0;
let errored = 0;

for (const root of candidateRoots) {
  if (verbose) console.error(`[migrate] scanning ${root}`);
  for (const file of walkJsonl(root)) {
    let lines: string[];
    try { lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean); }
    catch { continue; }
    for (const ln of lines) {
      scanned++;
      let ev: any;
      try { ev = JSON.parse(ln); }
      catch { errored++; continue; }
      if (!ev.event || !ev.ts) { errored++; continue; }
      const key = hashEvent(ev.trace_id ?? null, ev.ts, ev.event);
      if (seen.has(key)) { skipped++; continue; }
      seen.add(key);
      if (!dryRun) {
        try {
          // bypass emitAudit timestamp setter — use the original ts
          handle.db.run(
            "INSERT INTO audit_events (trace_id, project_id, ts, event, payload) VALUES (?, ?, ?, ?, ?)",
            [
              ev.trace_id || null,
              ev.project_id || null,
              ev.ts,
              ev.event,
              JSON.stringify(ev),
            ],
          );
          inserted++;
        } catch (e: any) {
          errored++;
          if (verbose) console.error(`[migrate] insert failed: ${e.message}`);
        }
      } else {
        inserted++;
      }
    }
  }
}

console.log(`[migrate] ${dryRun ? "DRY-RUN" : "applied"}:`);
console.log(`  scanned:  ${scanned}`);
console.log(`  inserted: ${inserted}`);
console.log(`  skipped (dupes): ${skipped}`);
console.log(`  errored:  ${errored}`);
process.exit(EXIT.OK);
