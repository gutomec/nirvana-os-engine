#!/usr/bin/env bun
/**
 * audit-squads-score.ts — programmatic 13-criteria scorer for all squads in
 * the current scope (project / global / merge). Read-only.
 *
 * Outputs:
 *   stdout: ASCII table grouped by tier
 *   ~/.nirvana/skills/squads/.audit-state/scores.json (or <project>/.nirvana/.audit-state/ in project mode)
 *
 * Flags:
 *   --json          machine-readable JSON to stdout (still writes file)
 *   --slug <name>   audit a single squad
 *   --tier <red|yellow|green>   filter output by tier
 *   --quiet
 */

import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { paths, parseArgs, EXIT } from "../../_shared/lib/bun-helpers.ts";
import { resolveScope, enumerate } from "../../_shared/lib/scope.ts";

const { scoreSquad, TOTAL_MAX, CRITERIA } = require("../lib/squad-audit-criteria.js");

const { flags } = parseArgs();
const quiet = !!flags.quiet || !!flags.q;
const emitJson = !!flags.json;
const slugFilter = (flags.slug as string) || null;
const tierFilter = (flags.tier as string) || null;

const scope = resolveScope();
// Project root wins for persistence (covers BOTH project and merge mode):
// branch on scope.projectRoot, NOT mode === "project". Otherwise merge-mode
// project squads leak scores into the global skills tree and collide across projects.
const stateDir = scope.projectRoot
  ? path.join(scope.projectRoot, ".nirvana", ".audit-state")
  : path.join(paths.CLAUDE_SKILLS_DIR, "squads", ".audit-state");
fs.mkdirSync(stateDir, { recursive: true });
const outFile = path.join(stateDir, "scores.json");

let entries = enumerate(scope, "squads").filter(e => !e.overridden);
if (slugFilter) entries = entries.filter(e => e.slug === slugFilter);

if (!quiet) console.error(`[audit] scope=${scope.mode} · scoring ${entries.length} squads...`);

const scores = entries.map(e => scoreSquad(e.dir));
scores.sort((a, b) => a.score - b.score); // worst-first

if (tierFilter) {
  const filtered = scores.filter(s => s.tier === tierFilter);
  if (!emitJson) printTable(filtered);
} else {
  if (!emitJson) {
    const byTier = { red: scores.filter(s => s.tier === "red"), yellow: scores.filter(s => s.tier === "yellow"), green: scores.filter(s => s.tier === "green") };
    printSection("RED   (<60, must fix)", byTier.red);
    printSection("YELLOW (60-79, should fix)", byTier.yellow);
    printSection("GREEN (≥80, ok)", byTier.green, true);
    console.log("");
    console.log(`──── totals ────`);
    console.log(`  red:    ${byTier.red.length}`);
    console.log(`  yellow: ${byTier.yellow.length}`);
    console.log(`  green:  ${byTier.green.length}`);
    console.log(`  total:  ${scores.length}`);
  }
}

const report = {
  generated_at: new Date().toISOString(),
  scope: { mode: scope.mode, projectRoot: scope.projectRoot },
  total: scores.length,
  by_tier: {
    red: scores.filter(s => s.tier === "red").length,
    yellow: scores.filter(s => s.tier === "yellow").length,
    green: scores.filter(s => s.tier === "green").length,
  },
  total_max: TOTAL_MAX,
  criteria: CRITERIA.map((c: any) => ({ id: c.id, name: c.name, max: c.max })),
  scores,
};
fs.writeFileSync(outFile, JSON.stringify(report, null, 2));

if (emitJson) {
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}

if (!quiet) console.error(`[audit] wrote ${outFile}`);
process.exit(EXIT.OK);

// ─────────────────────────────────────────────────────────────────────
function printSection(title: string, rows: any[], collapse = false) {
  if (rows.length === 0) return;
  console.log("");
  console.log(`══ ${title} (${rows.length}) ══`);
  if (collapse && rows.length > 5) {
    rows.slice(0, 3).forEach(r => printRow(r));
    console.log(`  …and ${rows.length - 3} more`);
  } else {
    rows.forEach(r => printRow(r));
  }
}
function printRow(s: any) {
  const tierGlyph = { red: "✗", yellow: "·", green: "✓" }[s.tier] || "?";
  const fix = s.fixable_count > 0 ? ` (${s.fixable_count} fixable)` : "";
  console.log(`  ${tierGlyph} ${s.slug.padEnd(40)}  ${String(s.score).padStart(3)}/${s.max}${fix}`);
}
function printTable(rows: any[]) {
  rows.forEach(printRow);
}
