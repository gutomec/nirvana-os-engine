#!/usr/bin/env bun
/**
 * audit-batch-orchestrator.ts — sequentially runs improve-squad over all
 * red+yellow squads in current scope, with progress tracking + final summary.
 * Pure Bun: cross-OS + cross-agent-runtime (Claude Code / Codex / Gemini CLI).
 *
 * Replaces audit-batch-orchestrator.sh — bash is no longer accepted in this
 * system per SCRIPT_CONTRACT.md.
 *
 * Flags:
 *   --apply              actually mutate (required)
 *   --dry-run            print plan only
 *   --tier red|yellow    filter to one tier
 *   --limit N            stop after N squads
 */

import * as path from "node:path";
import * as fs from "node:fs";
import { exec, paths, parseArgs, EXIT } from "../../_shared/lib/bun-helpers.ts";
import { resolveScope } from "../../_shared/lib/scope.ts";

const { flags } = parseArgs();
const APPLY = !!flags.apply;
const DRY_RUN = !!flags["dry-run"];
const TIER = (flags.tier as string) || "";
const LIMIT = flags.limit ? parseInt(flags.limit as string, 10) : 0;
const WITH_JUDGE = !!flags["with-judge"];
const FORCE_JUDGE = !!flags["force-judge"];

if (!APPLY && !DRY_RUN) {
  console.error("[orchestrator] safety: pass --dry-run or --apply");
  process.exit(EXIT.INVALID_ARGS);
}

const SKILLS = paths.CLAUDE_SKILLS_DIR;
// STATE_DIR must agree with the scorer subprocess (audit-squads-score.ts), which
// writes project-scoped when a project root exists. Resolve with the same rule —
// project root wins (covers BOTH project and merge mode) — so the orchestrator
// reads scores from the path the scorer actually wrote, and writes batch-results.json
// into the project (not the read-only global skills tree).
const SCOPE = resolveScope();
const STATE_DIR = SCOPE.projectRoot
  ? path.join(SCOPE.projectRoot, ".nirvana", ".audit-state")
  : path.join(SKILLS, "squads", ".audit-state");
fs.mkdirSync(STATE_DIR, { recursive: true });

console.error("[orchestrator] re-scoring all squads...");
const score = exec(`bun ${JSON.stringify(path.join(SKILLS, "squads", "scripts", "audit-squads-score.ts"))} --quiet`, { silent: true });
if (!score.ok) {
  console.error("[orchestrator] FAIL: scoring failed:", score.stderr || score.error);
  process.exit(EXIT.FAILURES);
}

const scoresPath = path.join(STATE_DIR, "scores.json");
if (!fs.existsSync(scoresPath)) {
  console.error(`[orchestrator] FAIL: scores.json missing at ${scoresPath}`);
  process.exit(EXIT.FAILURES);
}
const report = JSON.parse(fs.readFileSync(scoresPath, "utf8"));

let picks: any[] = report.scores.filter((s: any) => s.tier === "red" || s.tier === "yellow");
if (TIER) picks = picks.filter((s: any) => s.tier === TIER);
if (LIMIT > 0) picks = picks.slice(0, LIMIT);

const total = picks.length;
console.error(`[orchestrator] ${total} squads to process${TIER ? ` (tier=${TIER})` : ""}`);

// Cost guard: --with-judge invokes the LLM-as-judge gate per squad. At ~$0.03-0.10
// per call, batches >20 squads can run $1+ silently. Force the user to confirm
// with --force-judge so the bill is intentional.
if (WITH_JUDGE && total > 20 && !FORCE_JUDGE) {
  const minUsd = (total * 0.03).toFixed(2);
  const maxUsd = (total * 0.10).toFixed(2);
  const minutes = Math.ceil((total * 90) / 60);
  console.error("");
  console.error(`[orchestrator] WARNING: --with-judge across ${total} squads`);
  console.error(`  estimated cost: ~$${minUsd}-${maxUsd} USD (1 LLM judge call per squad)`);
  console.error(`  estimated time: ~${minutes} min sequential`);
  console.error(`  to proceed, re-run with --force-judge`);
  console.error("");
  process.exit(EXIT.INVALID_ARGS);
}

let success = 0, rolled_back = 0, other = 0;
const results: Array<{ slug: string; outcome: string; line: string }> = [];

// LoopGuard: in batch mode, max_steps = picks.length (no artificial cap).
// max_repeat=2 catches accidental re-queue of same slug. max_flat_steps=8
// triggers when 8 consecutive squads produce no progress (all rolled-back/other),
// signal that something systemic is broken (host runtime down, etc.).
const { createLoopGuard } = require(path.join(SKILLS, "_shared", "lib", "loop-guard.js"));
const guard = createLoopGuard({ max_steps: Math.max(picks.length + 1, 50), max_repeat: 2, max_flat_steps: 8 });
let loopHalted: any = null;

for (let i = 0; i < picks.length; i++) {
  const slug = picks[i].slug;
  // Progress marker = number of successes so far. Stays flat when nothing applies.
  guard.record("improve_squad", { slug }, success);
  const g = guard.check();
  if (g.stop) {
    loopHalted = g;
    process.stderr.write(`\n[orchestrator] LOOP-GUARD halt: ${g.reason} (after ${i} squads)\n`);
    try {
      const audit = require(path.join(SKILLS, "harness", "lib", "audit.js"));
      audit.emit("loop_detected", { source: "audit_batch_orchestrator", reason: g.reason, processed: i, total: picks.length, ...g });
    } catch {}
    break;
  }
  process.stderr.write(`[${String(i + 1).padStart(3, " ")}/${total}] ${slug.padEnd(42, " ")} `);

  const args = APPLY ? "--apply" : "--dry-run";
  const r = exec(`bun ${JSON.stringify(path.join(SKILLS, "squads", "scripts", "improve-squad.ts"))} ${slug} ${args}`, { silent: true });
  const lastLine = (r.stdout || r.stderr || "").trim().split("\n").pop() || "";

  if (DRY_RUN) {
    process.stderr.write("(dry-run)\n");
    results.push({ slug, outcome: "dry-run", line: lastLine });
    continue;
  }
  if (lastLine.includes("validation failed") || lastLine.includes("rolled-back")) {
    rolled_back++;
    process.stderr.write("✗ rolled-back\n");
    results.push({ slug, outcome: "rolled-back", line: lastLine });
  } else if (/pts/.test(lastLine)) {
    success++;
    const tierMatch = lastLine.match(/\([a-z]+ → [a-z]+\)/);
    const ptsMatch = lastLine.match(/\+\d+ pts/);
    process.stderr.write(`✓ ${tierMatch?.[0] || ""} ${ptsMatch?.[0] || ""}\n`);
    results.push({ slug, outcome: "applied", line: lastLine });
  } else {
    other++;
    process.stderr.write("? other\n");
    results.push({ slug, outcome: "other", line: lastLine });
  }
}
if (loopHalted) {
  console.error(`[orchestrator] WARNING: batch halted by LoopGuard. ${results.length}/${picks.length} processed. Reason: ${loopHalted.reason}`);
}

if (APPLY) {
  console.error("\n[orchestrator] post-batch re-scoring...");
  exec(`bun ${JSON.stringify(path.join(SKILLS, "squads", "scripts", "audit-squads-score.ts"))} --quiet`, { silent: true });
  const final = JSON.parse(fs.readFileSync(scoresPath, "utf8"));
  console.log("\n════════════════════════════════════════════════════════");
  console.log("  Batch complete");
  console.log("════════════════════════════════════════════════════════");
  console.log(`  applied:     ${success}`);
  console.log(`  rolled-back: ${rolled_back}`);
  console.log(`  other:       ${other}`);
  console.log(`  scores by tier (post-batch): ${JSON.stringify(final.by_tier)}`);
  fs.writeFileSync(path.join(STATE_DIR, "batch-results.json"), JSON.stringify({
    generated_at: new Date().toISOString(),
    success, rolled_back, other,
    by_tier: final.by_tier,
    results,
  }, null, 2));
}
process.exit(EXIT.OK);
