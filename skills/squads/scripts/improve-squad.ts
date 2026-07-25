#!/usr/bin/env bun
/**
 * improve-squad.ts — atomic mutator that applies consensus_diff to a squad.
 *
 * Pipeline per squad:
 *   1. score (lib/squad-audit-criteria.js)
 *   2. consensus loop (lib/squad-audit-consensus.js)
 *   3. backup atomically to ~/squads-legacy-v5/<slug>.<ts>/
 *   4. apply mechanical patches (lib/mechanical-fixers.js)
 *   5. re-validate via validate-squad
 *   6. on failure: rollback from backup
 *   7. on success: re-score; persist verdict in audit-state
 *
 * Flags:
 *   --slug <name>     (required)
 *   --dry-run         skip step 3-7, just print what would happen
 *   --apply           required to mutate (safety guard)
 *   --verbose
 */

import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { exec, paths, parseArgs, EXIT } from "../../_shared/lib/bun-helpers.ts";
import { resolveScope, enumerate } from "../../_shared/lib/scope.ts";

const { scoreSquad } = require("../lib/squad-audit-criteria.js");
const { runConsensus } = require("../lib/squad-audit-consensus.js");
const { applyMechanicalFixes } = require("../lib/mechanical-fixers.js");
const { verifyImprovement } = require("../lib/squad-audit-verifier.js");
const { runQualityJudge } = require("../../_shared/lib/quality-judge.js");

const { positional, flags } = parseArgs();
const slug = (flags.slug as string) || positional[0];
const dryRun = !!flags["dry-run"];
const apply = !!flags.apply;
const verbose = !!flags.verbose || !!flags.v;
const withJudge = !!flags["with-judge"];  // opt-in extra rubric-based gate

if (!slug) {
  console.error("usage: improve-squad.ts <slug> [--apply | --dry-run] [--verbose]");
  process.exit(EXIT.INVALID_ARGS);
}
if (!apply && !dryRun) {
  console.error("[improve-squad] safety: pass --dry-run or --apply");
  process.exit(EXIT.INVALID_ARGS);
}

const scope = resolveScope();
const match = enumerate(scope, "squads").find(e => e.slug === slug && !e.overridden);
if (!match) {
  console.error(`[improve-squad] squad '${slug}' not in scope=${scope.mode}`);
  process.exit(EXIT.INVALID_ARGS);
}
const squadDir = match.dir;

// Project root wins for persistence (covers BOTH project and merge mode):
// branch on scope.projectRoot, NOT mode === "project". Otherwise merge-mode
// project squads leak state into the global skills tree and collide across projects.
const stateDir = scope.projectRoot
  ? path.join(scope.projectRoot, ".nirvana", ".audit-state", slug)
  : path.join(paths.CLAUDE_SKILLS_DIR, "squads", ".audit-state", slug);
fs.mkdirSync(stateDir, { recursive: true });

const log = (msg: string) => { if (verbose) console.error(`[improve] ${msg}`); };

(async () => {
  // 1. score
  log(`scoring ${slug}...`);
  const before = scoreSquad(squadDir);
  fs.writeFileSync(path.join(stateDir, "score-before.json"), JSON.stringify(before, null, 2));
  log(`score before: ${before.score}/100 (${before.tier})`);

  if (before.tier === "green") {
    console.log(`[improve-squad] ${slug}: already green (${before.score}/100); nothing to do`);
    process.exit(EXIT.OK);
  }

  // 2. consensus
  log("running consensus loop...");
  const consensus = await runConsensus({ scoreReport: before, squadDir, agenticMode: process.env.AGENTIC || "auto" });
  fs.writeFileSync(path.join(stateDir, "consensus.json"), JSON.stringify(consensus, null, 2));
  log(`consensus mode=${consensus.mode} status=${consensus.status} patches=${consensus.consensus_diff?.patches?.length ?? 0}`);

  if (!consensus.consensus_diff?.patches?.length) {
    console.log(`[improve-squad] ${slug}: no patches to apply; status=${consensus.status}`);
    process.exit(EXIT.OK);
  }

  if (dryRun) {
    console.log(`[improve-squad] ${slug}: DRY-RUN — ${consensus.consensus_diff.patches.length} patches would be applied:`);
    for (const p of consensus.consensus_diff.patches) {
      console.log(`  - ${p.kind} (criterion ${p.criterion ?? "?"})`);
    }
    process.exit(EXIT.OK);
  }

  // 3. backup
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = path.join(os.homedir(), "squads-legacy-v5", `${slug}.${ts}`);
  log(`backup → ${backupDir}`);
  fs.mkdirSync(path.dirname(backupDir), { recursive: true });
  // rsync excluding node_modules/output keeps backup small
  const rsyncResult = exec(`rsync -a --exclude=node_modules --exclude=output --exclude=.DS_Store ${JSON.stringify(squadDir + "/")} ${JSON.stringify(backupDir + "/")}`, { silent: true });
  if (!rsyncResult.ok) {
    console.error(`[improve-squad] backup failed: ${rsyncResult.error}`);
    process.exit(EXIT.FAILURES);
  }

  // 4. apply mechanical patches
  log("applying patches...");
  const applyResults = applyMechanicalFixes(squadDir, consensus.consensus_diff);
  fs.writeFileSync(path.join(stateDir, "apply-results.json"), JSON.stringify(applyResults, null, 2));
  const ok = applyResults.filter((r: any) => r.result?.ok).length;
  const failed = applyResults.length - ok;
  log(`applied ${ok}/${applyResults.length} patches (${failed} failed)`);

  // 5. validate (validate-squad expects a directory path, not a slug)
  log("validating squad...");
  const validate = exec(`bun ${JSON.stringify(path.join(paths.CLAUDE_SKILLS_DIR, "squads", "scripts", "validate-squad.ts"))} ${JSON.stringify(squadDir)}`, { silent: true });
  fs.writeFileSync(path.join(stateDir, "validation.json"), JSON.stringify({
    ok: validate.ok, code: validate.code, stdout: validate.stdout?.slice(0, 4000), stderr: validate.stderr?.slice(0, 2000),
  }, null, 2));

  // 6. rollback on failure
  if (!validate.ok) {
    log("validation failed → rolling back");
    exec(`rsync -a --delete --exclude=node_modules --exclude=output ${JSON.stringify(backupDir + "/")} ${JSON.stringify(squadDir + "/")}`, { silent: true });
    fs.writeFileSync(path.join(stateDir, "result.json"), JSON.stringify({
      slug, status: "validation-failed-rolled-back", before_score: before.score, backup: backupDir,
    }, null, 2));
    console.log(`[improve-squad] ${slug}: validation failed; rolled back from ${backupDir}`);
    process.exit(EXIT.FAILURES);
  }

  // 7. re-score
  const after = scoreSquad(squadDir);
  fs.writeFileSync(path.join(stateDir, "score-after.json"), JSON.stringify(after, null, 2));

  // 7.5. optional rubric-based quality judge (--with-judge flag).
  //      Default off because each call is ~$0.01-0.05; not viable in batch
  //      across 153 squads. Run on a single squad when you want a deeper gate
  //      than the existing verifier.
  if (withJudge) {
    log("running quality judge (post-execution rubric)...");
    const rubric = path.join(paths.CLAUDE_SKILLS_DIR, "_shared", "rubrics", "post-execution.md");
    const artifactSummary = JSON.stringify({
      slug,
      score_before: before.score, score_after: after.score, score_delta: after.score - before.score,
      patches_applied: ok, patches_failed: failed,
      validate_ok: validate.ok,
    }, null, 2);
    const judge = await runQualityJudge({
      phase: "post_execution",
      artifact: artifactSummary,
      rubric_path: rubric,
      context: { squadDir, applyResults: applyResults.map((r: any) => r.kind) },
      timeoutMs: 120_000,
    });
    fs.writeFileSync(path.join(stateDir, "judge.json"), JSON.stringify(judge, null, 2));
    log(`judge verdict: ${judge.verdict} (score=${judge.score ?? "n/a"})`);
    try {
      const audit = require(path.join(paths.CLAUDE_SKILLS_DIR, "harness", "lib", "audit.js"));
      audit.emit("approval_checkpoint", { source: "improve_squad_judge", slug, verdict: judge.verdict, score: judge.score });
      if (judge.verdict === "fail") audit.emit("approval_rejected", { source: "improve_squad_judge", slug, failed_checks: judge.failed_checks?.length || 0 });
      if (judge.verdict === "pass") audit.emit("approval_granted", { source: "improve_squad_judge", slug, score: judge.score });
    } catch {}
    if (judge.verdict === "fail") {
      log("judge rejected → rolling back");
      exec(`rsync -a --delete --exclude=node_modules --exclude=output ${JSON.stringify(backupDir + "/")} ${JSON.stringify(squadDir + "/")}`, { silent: true });
      fs.writeFileSync(path.join(stateDir, "result.json"), JSON.stringify({
        slug, status: "judge-rejected-rolled-back",
        before: { score: before.score, tier: before.tier },
        judge,
      }, null, 2));
      console.log(`[improve-squad] ${slug}: judge rejected; rolled back`);
      process.exit(EXIT.FAILURES);
    }
  }

  // 8. independent verifier (Claude Code CLI as separate reviewer).
  //    Only runs when patches included semantic-flagged work or env says always.
  //    Skipped silently if CLAUDE_CODE_OAUTH_TOKEN missing.
  let verify: any = { verdict: "skipped", reasons: ["verifier not invoked"] };
  const shouldVerify = consensus.mode === "agentic"
    || process.env.CLAUDE_AUDIT_VERIFY_ALWAYS === "1";
  if (shouldVerify) {
    log("running independent verifier (claude CLI)...");
    verify = verifyImprovement({
      slug, squadDir, backupDir,
      scoreBefore: before.score, scoreAfter: after.score,
      patchKinds: applyResults.map((r: any) => r.kind),
    });
    fs.writeFileSync(path.join(stateDir, "verify.json"), JSON.stringify(verify, null, 2));
    log(`verifier verdict: ${verify.verdict}${verify.reasons.length ? " (" + verify.reasons.slice(0, 1).join("; ") + ")" : ""}`);
    if (verify.verdict === "rollback") {
      log("verifier rejected → rolling back");
      exec(`rsync -a --delete --exclude=node_modules --exclude=output ${JSON.stringify(backupDir + "/")} ${JSON.stringify(squadDir + "/")}`, { silent: true });
      fs.writeFileSync(path.join(stateDir, "result.json"), JSON.stringify({
        slug, status: "verifier-rejected-rolled-back",
        before: { score: before.score, tier: before.tier },
        after: { score: before.score, tier: before.tier },
        delta: 0,
        patches_applied: 0,
        backup: backupDir,
        verify,
      }, null, 2));
      console.log(`[improve-squad] ${slug}: verifier rejected (${verify.reasons[0] || "no reason"}); rolled back`);
      process.exit(EXIT.FAILURES);
    }
  }

  fs.writeFileSync(path.join(stateDir, "result.json"), JSON.stringify({
    slug, status: "applied",
    before: { score: before.score, tier: before.tier },
    after: { score: after.score, tier: after.tier },
    delta: after.score - before.score,
    patches_applied: ok,
    backup: backupDir,
    verify,
  }, null, 2));
  const vNote = verify.verdict === "ok" ? " · verified" : (verify.verdict === "skipped" ? "" : ` · verify=${verify.verdict}`);
  console.log(`[improve-squad] ${slug}: ${before.score} → ${after.score} (${before.tier} → ${after.tier}) · +${after.score - before.score} pts · ${ok} patches${vNote} · backup ${backupDir}`);
  process.exit(EXIT.OK);
})();
