#!/usr/bin/env bun
// fix-squad.ts — `nrv fix-squad <slug|path> [--apply]`
//
// Squad auto-diagnosis + auto-fix. Without --apply: writes
// SQUAD-DOCTOR-REPORT.md (problem + why + how to fix) and prints the summary.
// With --apply: applies the safe auto-fixes (e.g.: downgrades unproven
// validated fidelity to experimental) and regenerates the report.

import * as fs from "node:fs";
import * as path from "node:path";
import { paths, parseArgs, EXIT } from "../../_shared/lib/bun-helpers.ts";
import { collectFindings, writeDoctorReport, applyAutofixes } from "../lib/squad-doctor.ts";

const { positional, flags } = parseArgs();
if (!positional[0] || flags.h || flags.help) {
  console.error("usage: nrv fix-squad <slug|path> [--apply]");
  process.exit(positional[0] ? EXIT.OK : EXIT.INVALID_ARGS);
}

let squadPath = positional[0];
if (!fs.existsSync(squadPath)) {
  const cand = path.join(paths.SQUADS_DIR, squadPath);
  if (fs.existsSync(cand)) squadPath = cand;
}
squadPath = path.resolve(squadPath);
if (!fs.existsSync(squadPath) || !fs.statSync(squadPath).isDirectory()) {
  console.error(`[FAIL] squad not found: ${squadPath}`);
  process.exit(EXIT.FAILURES);
}

const slug = path.basename(squadPath);
const apply = !!flags.apply;

const findings = collectFindings(squadPath);
const report = writeDoctorReport(squadPath, findings, new Date().toISOString());
const nErr = findings.filter((f) => f.severity === "error").length;
const nWarn = findings.filter((f) => f.severity === "warn").length;

console.log(`Squad:     ${slug}`);
console.log(`Issues:    ${findings.length} (${nErr} error, ${nWarn} warning)`);
console.log(`Report:    ${report}`);

if (!apply) {
  if (findings.length) console.log(`\nApply the safe auto-fixes: nrv fix-squad ${slug} --apply`);
  process.exit(EXIT.OK);
}

const { applied, manual } = applyAutofixes(squadPath);
console.log("");
if (applied.length) {
  console.log("✓ Auto-fixes applied:");
  applied.forEach((a) => console.log(`  - ${a}`));
} else {
  console.log("No safe auto-fix applies (everything is a manual fix).");
}
if (manual.length) {
  console.log("\n⚠ Manual fixes (detailed in the report):");
  manual.forEach((m) => console.log(`  - ${m}`));
}
// Regenerates the report reflecting the post-fix state.
writeDoctorReport(squadPath, collectFindings(squadPath), new Date().toISOString());
process.exit(EXIT.OK);
