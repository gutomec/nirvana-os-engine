#!/usr/bin/env bun
/**
 * migrate-batch-orchestrator.ts — pure Bun port of the legacy bash orchestrator.
 *
 * Migrates v4 squads in batches of N. Between each batch, prints a checkpoint
 * with cumulative stats so an agentic review can run before the next batch.
 *
 * Usage:
 *   bun migrate-batch-orchestrator.ts                    # process all remaining
 *   bun migrate-batch-orchestrator.ts --start-from N     # skip first N waves (n/a here, kept for compat)
 *   BATCH_SIZE=5 bun migrate-batch-orchestrator.ts       # smaller batches
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { exec, paths, EXIT } from "../../_shared/lib/bun-helpers.ts";

const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || "10", 10);
const STATE_DIR = path.join(os.homedir(), ".migrate-batch-state");
fs.mkdirSync(STATE_DIR, { recursive: true });

const SQUADS_LEGACY_DIR = paths.SQUADS_LEGACY_DIR;
const SQUADS_DIR = paths.SQUADS_DIR;

if (!fs.existsSync(SQUADS_LEGACY_DIR)) {
  console.log(`Nothing to migrate. Legacy dir does not exist: ${SQUADS_LEGACY_DIR}`);
  process.exit(EXIT.OK);
}

const remaining: string[] = fs.readdirSync(SQUADS_LEGACY_DIR)
  .filter((s) => fs.existsSync(path.join(SQUADS_LEGACY_DIR, s, "squad.yaml")))
  .filter((s) => !fs.existsSync(path.join(SQUADS_DIR, s)))
  .sort();

const TOTAL = remaining.length;
if (TOTAL === 0) {
  console.log(`Nothing to migrate. All squads already in ${SQUADS_DIR}.`);
  process.exit(EXIT.OK);
}

console.log(`── Pending: ${TOTAL} squad(s) — batches of ${BATCH_SIZE} ──\n`);

let wave = 0;
let processed = 0;
let waveOk = 0;
let waveFail = 0;
let totalOk = 0;
let totalFail = 0;
const failedSquads: string[] = [];

const migrateScript = path.join(paths.CLAUDE_SKILLS_DIR, "squads", "lib", "migrate-v4-to-v5.js");

function flushWave(waveId: number) {
  console.log("");
  console.log("═════════════════════════════════════════════════════════");
  console.log(`  WAVE ${waveId} COMPLETE`);
  console.log(`  ok=${waveOk}   fail=${waveFail}`);
  console.log(`  cumulative: ok=${totalOk}   fail=${totalFail}   processed=${processed}/${TOTAL}`);
  console.log("═════════════════════════════════════════════════════════");
  console.log(`  >>> AGENTIC-REVIEW-CHECKPOINT wave=${waveId} <<<`);
  console.log("═════════════════════════════════════════════════════════");
  console.log("");
  waveOk = 0;
  waveFail = 0;
}

for (const slug of remaining) {
  if (processed % BATCH_SIZE === 0) {
    wave++;
    if (wave > 1) flushWave(wave - 1);
    console.log(`── Wave ${wave} starting (next ${BATCH_SIZE} squads) ──`);
  }

  const logPath = path.join(STATE_DIR, `wave-${wave}.log`);
  const r = exec(`node ${JSON.stringify(migrateScript)} --overwrite ${JSON.stringify(slug)}`, { silent: true });
  fs.writeFileSync(logPath, (r.stdout || "") + (r.stderr ? "\n[stderr]\n" + r.stderr : ""));

  if (r.ok) {
    const lines = (r.stdout || "").trim().split("\n");
    const last = lines[lines.length - 2] || lines[lines.length - 1] || "";
    if (last.startsWith("✓")) {
      waveOk++;
      totalOk++;
      console.log(`✓ ${slug}`);
    } else {
      waveFail++;
      totalFail++;
      failedSquads.push(slug);
      console.log(`✗ ${slug} — ${last}`);
    }
  } else {
    waveFail++;
    totalFail++;
    failedSquads.push(slug);
    const lastErr = ((r.stderr || r.stdout || "").trim().split("\n").pop() || "").trim();
    console.log(`✗ ${slug} — ${lastErr}`);
  }
  processed++;
}

flushWave(wave);

console.log("");
console.log("═════════════════════════════════════════════════════════");
console.log("  ALL BATCHES DONE");
console.log(`  total ok=${totalOk}   total fail=${totalFail}   processed=${processed}`);
if (totalFail > 0) {
  console.log("");
  console.log("  Failed squads:");
  for (const s of failedSquads) console.log(`    - ${s}`);
}
console.log("═════════════════════════════════════════════════════════");

fs.writeFileSync(path.join(STATE_DIR, "summary.json"), JSON.stringify({
  total_attempted: processed,
  total_ok: totalOk,
  total_fail: totalFail,
  failed_squads: failedSquads,
  completed_at: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
}, null, 2));

process.exit(totalFail);
