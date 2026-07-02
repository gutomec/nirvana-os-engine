#!/usr/bin/env bun
/**
 * audit-businesses-score.ts — score every business on the 11-criteria
 * Nirvana rubric. Writes scores to `.audit-state/scores.json` and prints
 * an ASCII summary + by-tier counts.
 *
 * Usage:
 *   bun audit-businesses-score.ts            # all businesses, table out
 *   bun audit-businesses-score.ts --quiet    # only totals
 *   bun audit-businesses-score.ts --json     # JSON to stdout
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { paths, parseArgs, EXIT } from "../../_shared/lib/bun-helpers.ts";
import { resolveScope, enumerate } from "../../_shared/lib/scope.ts";

const { scoreBusiness } = require(path.join(paths.CLAUDE_SKILLS_DIR, "businesses", "lib", "business-audit-criteria.js"));

const { flags } = parseArgs();
const QUIET = !!flags.quiet || !!flags.q;
const JSON_OUT = !!flags.json;

const scope = resolveScope();
// Project root wins for persistence (covers BOTH project and merge mode):
// branch on scope.projectRoot, NOT mode === "project". Otherwise merge-mode
// project businesses leak scores into the global skills tree and collide across
// projects. In the SHARED project `.audit-state/` the squads scorer already owns
// `scores.json`, so businesses write `businesses-scores.json` to avoid a clash.
// In the GLOBAL location businesses live in their OWN dir (squads/.audit-state vs
// businesses/.audit-state), so the legacy `scores.json` name is kept there.
const STATE_DIR = scope.projectRoot
  ? path.join(scope.projectRoot, ".nirvana", ".audit-state")
  : path.join(paths.CLAUDE_SKILLS_DIR, "businesses", ".audit-state");
const OUT_FILE = scope.projectRoot ? "businesses-scores.json" : "scores.json";
fs.mkdirSync(STATE_DIR, { recursive: true });

const entries = enumerate(scope, "businesses")
  .filter((e) => !e.overridden)
  .filter((e) => fs.existsSync(path.join(e.dir, "business.yaml")));

const scores: any[] = [];
for (const e of entries) {
  const r = scoreBusiness(e.dir);
  scores.push(r);
}

scores.sort((a, b) => a.score - b.score);

const byTier = scores.reduce((acc: any, s: any) => { acc[s.tier] = (acc[s.tier] || 0) + 1; return acc; }, {});

const report = {
  generated_at: new Date().toISOString(),
  scope: { mode: scope.mode, projectRoot: scope.projectRoot },
  total: scores.length,
  by_tier: byTier,
  scores,
};
fs.writeFileSync(path.join(STATE_DIR, OUT_FILE), JSON.stringify(report, null, 2));

if (JSON_OUT) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(EXIT.OK);
}

if (!QUIET) {
  for (const s of scores) {
    const bar = "█".repeat(Math.round(s.score / 5));
    console.log(`  ${s.tier.padEnd(6)} ${String(s.score).padStart(3)}  ${bar.padEnd(20)} ${s.slug}`);
  }
  console.log("");
}
console.log("──── totals ────");
console.log(`  red:    ${byTier.red || 0}`);
console.log(`  yellow: ${byTier.yellow || 0}`);
console.log(`  green:  ${byTier.green || 0}`);
console.log(`  total:  ${scores.length}`);

process.exit(EXIT.OK);
