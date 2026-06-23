#!/usr/bin/env bun
// normalize-employee-maxturns.ts — Batch-normalize the `maxTurns` field in
// every employees/*.md frontmatter under ~/businesses.
//
// Why: pre-MAX-POWER v2, some employees had maxTurns as low as 30. Complex
// pipelines aborted silently before completing. The fix is to raise every
// employee below the target to the target uniformly.
//
// Idempotent: re-running yields the same result; values >= target are left
// untouched.
//
// Usage:
//   bun normalize-employee-maxturns.ts --target 400 --dry-run
//   bun normalize-employee-maxturns.ts --target 400 --apply
//
// Optional flags:
//   --target <n>          Default 400.
//   --apply               Actually write. Without it, runs in dry mode.
//   --businesses-dir <p>  Default ~/businesses
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

function parseArg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i === -1) return fallback;
  const next = process.argv[i + 1];
  if (!next || next.startsWith("--")) return fallback;
  return next;
}

const target = parseInt(parseArg("--target", "400") || "400", 10);
const apply = process.argv.includes("--apply");
const dryRun = !apply || process.argv.includes("--dry-run");
const businessesDir = parseArg("--businesses-dir", path.join(os.homedir(), "businesses"))!;

if (!fs.existsSync(businessesDir)) {
  console.error(`ERROR: businesses dir not found: ${businessesDir}`);
  process.exit(2);
}

// glob ~/businesses/*/employees/*.md (no external dep)
function collectEmployees(root: string): string[] {
  const out: string[] = [];
  for (const biz of fs.readdirSync(root, { withFileTypes: true })) {
    if (!biz.isDirectory()) continue;
    const empDir = path.join(root, biz.name, "employees");
    if (!fs.existsSync(empDir)) continue;
    for (const f of fs.readdirSync(empDir)) {
      if (f.endsWith(".md")) out.push(path.join(empDir, f));
    }
  }
  return out;
}

const files = collectEmployees(businessesDir);
console.log(`Scanning ${files.length} employee manifests in ${businessesDir}`);
console.log(`Target maxTurns: ${target}`);
console.log(`Mode: ${dryRun ? "DRY-RUN" : "APPLY"}`);
console.log("");

const changes: { file: string; from: number; to: number }[] = [];
const noChange: string[] = [];
const noField: string[] = [];

for (const f of files) {
  const content = fs.readFileSync(f, "utf8");
  const m = content.match(/^maxTurns:\s*(\d+)\s*$/m);
  if (!m) {
    noField.push(f);
    continue;
  }
  const current = parseInt(m[1], 10);
  if (current >= target) {
    noChange.push(f);
    continue;
  }
  changes.push({ file: f, from: current, to: target });
  if (!dryRun) {
    const updated = content.replace(/^maxTurns:\s*\d+\s*$/m, `maxTurns: ${target}`);
    fs.writeFileSync(f, updated);
  }
}

const rel = (p: string) => p.replace(os.homedir(), "~");

console.log(`Files with no maxTurns field: ${noField.length}`);
console.log(`Files already at or above target: ${noChange.length}`);
console.log(`Files to ${dryRun ? "be" : ""}updat${dryRun ? "ed" : "ed"}: ${changes.length}`);
console.log("");

if (changes.length > 0) {
  console.log("Changes:");
  for (const c of changes) {
    console.log(`  ${rel(c.file)}: ${c.from} → ${c.to}`);
  }
}

if (dryRun && changes.length > 0) {
  console.log("\n(dry run — re-run with --apply to write)");
}

process.exit(0);
