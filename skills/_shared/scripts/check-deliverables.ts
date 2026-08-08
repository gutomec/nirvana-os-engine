#!/usr/bin/env bun
/**
 * check-deliverables.ts — deterministic post-execution gate.
 *
 * Runs two cheap checks against a delivery directory or single file:
 *   1. artifact-existence-gate — every src/href/markdown-link in HTML/MD
 *      must point to a file that exists (or be marked as a placeholder).
 *   2. volume-bounds — when targets.json declares word counts per file,
 *      each file must be within its target ± tolerance.
 *
 * Usage:
 *   bun check-deliverables.ts <path> [--targets <targets.json>] [--json]
 *
 * targets.json shape:
 *   {
 *     "files": {
 *       "briefs/execution-briefs-part-A.md": { "target_words": [7000, 9000] },
 *       "briefs/image-briefs-product-and-print.md": { "word_target": 10000, "tolerance": 0.20 }
 *     }
 *   }
 *
 * Exit codes:
 *   0 — all checks passed
 *   1 — at least one check failed
 *   2 — invalid args / target file missing
 */

import * as fs from "node:fs";
import * as path from "node:path";

const aeg = require("../lib/artifact-existence-gate.js");
const vb = require("../lib/volume-bounds.js");

const argv = process.argv.slice(2);
const target = argv.find(a => !a.startsWith("--"));
const jsonFlag = argv.includes("--json");
const targetsIdx = argv.indexOf("--targets");
const targetsPath = targetsIdx >= 0 ? argv[targetsIdx + 1] : null;

if (!target) {
  console.error("usage: check-deliverables <path> [--targets <targets.json>] [--json]");
  process.exit(2);
}
const root = path.resolve(target);
if (!fs.existsSync(root)) {
  console.error(`path not found: ${root}`);
  process.exit(2);
}

const isDir = fs.statSync(root).isDirectory();

// 1. artifact-existence
const aegResult = isDir
  ? aeg.checkDir(root, { extensions: [".html", ".htm", ".md", ".markdown", ".css"] })
  : { ok: true, files: [aeg.checkFile(root)], totals: null };

// 2. volume-bounds
let targets: Record<string, any> = {};
if (targetsPath) {
  if (!fs.existsSync(targetsPath)) {
    console.error(`targets file not found: ${targetsPath}`);
    process.exit(2);
  }
  try {
    targets = JSON.parse(fs.readFileSync(targetsPath, "utf8")).files || {};
  } catch (e: any) {
    console.error(`targets parse error: ${e.message}`);
    process.exit(2);
  }
}
const volumeResults: Array<{ file: string; result: any }> = [];
for (const [relFile, target] of Object.entries(targets)) {
  const full = path.resolve(root, relFile);
  if (!fs.existsSync(full)) {
    volumeResults.push({ file: relFile, result: { verdict: "skipped", message: "file not found" } });
    continue;
  }
  const text = fs.readFileSync(full, "utf8");
  volumeResults.push({ file: relFile, result: vb.check({ text, target }) });
}

const aegMissingTotal = isDir
  ? aegResult.totals!.missing
  : aegResult.files[0].missing.length;
const volumeFails = volumeResults.filter(v => v.result.verdict === "over" || v.result.verdict === "under");
const ok = aegMissingTotal === 0 && volumeFails.length === 0;

if (jsonFlag) {
  console.log(JSON.stringify({
    ok,
    artifact_existence: aegResult,
    volume_bounds: volumeResults,
  }, null, 2));
  process.exit(ok ? 0 : 1);
}

// Text mode
console.log(`=== check-deliverables · ${root} ===`);
console.log("");
console.log("Artifact existence:");
if (isDir) {
  const t = aegResult.totals!;
  console.log(`  files scanned: ${t.files_scanned}`);
  console.log(`  refs total:    ${t.refs_total}`);
  console.log(`  missing:       ${t.missing}`);
  console.log(`  placeholders:  ${t.placeholders}`);
} else {
  const f = aegResult.files[0];
  console.log(`  refs:          ${f.refs.length}`);
  console.log(`  missing:       ${f.missing.length}`);
  console.log(`  placeholders:  ${f.placeholders.length}`);
}
if (aegMissingTotal > 0) {
  console.log("");
  console.log("Missing references:");
  const fileList = isDir ? aegResult.files : aegResult.files;
  for (const f of fileList) {
    if (!f.missing || f.missing.length === 0) continue;
    console.log(`  ${path.relative(root, f.path)}`);
    for (const m of f.missing) console.log(`    L${m.line} [${m.kind}] ${m.target}`);
  }
}

if (volumeResults.length > 0) {
  console.log("");
  console.log("Volume bounds:");
  for (const v of volumeResults) {
    const r = v.result;
    const marker = r.verdict === "pass" ? "✓" : r.verdict === "skipped" ? "·" : "✗";
    console.log(`  ${marker} ${v.file}: ${r.message}`);
  }
}

console.log("");
console.log(ok ? "RESULT: pass" : "RESULT: fail");
process.exit(ok ? 0 : 1);
