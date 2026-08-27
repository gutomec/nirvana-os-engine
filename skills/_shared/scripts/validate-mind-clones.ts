#!/usr/bin/env bun
/**
 * validate-mind-clones.ts — compatibility alias of `nrv validate mind-clone --all`.
 *
 * The audit runs through the admission gate (skills/_shared/lib/verify); the
 * output keeps the keys the old script printed (`target`, `total`, `ok`,
 * `failed`, `results[].{file, ok, errors, warnings}`) and adds `findings`.
 * A legacy flat persona file (`<dir>/<slug>.md`) is still validated with the
 * frontmatter validator, as before.
 *
 * Usage:
 *   bun validate-mind-clones.ts <path>             # a clone dir, a library root, or a legacy .md
 *   bun validate-mind-clones.ts                    # the whole DNA library
 *   bun validate-mind-clones.ts --json             # machine-readable output
 *   bun validate-mind-clones.ts --quiet            # only report failures
 *   bun validate-mind-clones.ts --no-retrieval     # skip the self-retrieval axis
 *
 * Exit codes:
 *   0  → all valid
 *   1  → at least one mind-clone failed validation
 *   2  → CLI usage error
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { paths } from "../lib/bun-helpers.ts";
import { validateMindCloneFile } from "../lib/mindclone-validator.ts";
import { verifyAll, verifyEntity, type VerifyReport } from "../lib/verify/index.ts";

const HOME = process.env.HOME || process.env.USERPROFILE || "";
const DEFAULT_DNA = process.env.DNA_LIBRARY || (paths as Record<string, string>).DNA_LIBRARY || path.join(HOME, "businesses", "_library", "dna");

interface CliArgs { target: string; json: boolean; quiet: boolean; help: boolean; retrieval: boolean; }

function parseArgs(): CliArgs {
  const argv = process.argv.slice(2);
  const flags = { json: false, quiet: false, help: false, retrieval: true };
  const positional: string[] = [];
  for (const a of argv) {
    if (a === "--json") flags.json = true;
    else if (a === "--quiet" || a === "-q") flags.quiet = true;
    else if (a === "--help" || a === "-h") flags.help = true;
    else if (a === "--no-retrieval") flags.retrieval = false;
    else positional.push(a);
  }
  return { target: positional[0] || DEFAULT_DNA, ...flags };
}

function printHelp() {
  console.log(`validate-mind-clones — audit mind-clones through the admission gate (alias of \`nrv validate mind-clone --all\`)

USAGE
  bun ~/.nirvana/skills/_shared/scripts/validate-mind-clones.ts [<path>] [--json] [--quiet] [--no-retrieval]

ARGS
  <path>     A clone directory, a library root, or a legacy persona .md. Defaults to \$DNA_LIBRARY (~/businesses/_library/dna).

FLAGS
  --json          Emit JSON (single object with results array). Suitable for CI.
  --quiet         Only print failures.
  --no-retrieval  Skip the self-retrieval axis.
  --help          This message.

EXIT
  0  all valid
  1  one or more failed
  2  CLI usage error

The full gate, with --fix, --strict and the debt baseline: nrv validate mind-clone <slug|path> (nrv validate --help).
`);
}

interface Result { file: string; ok: boolean; error_count: number; warning_count: number; errors: any[]; warnings: any[]; findings?: any[]; meta: any; }

function fromReport(r: VerifyReport): Result {
  const issue = (f: VerifyReport["findings"][number]) => ({ code: f.id, message: f.message, ...(f.where ? { path: f.where } : {}) });
  const errors = r.findings.filter((f) => f.severity === "error" && !f.baselined).map(issue);
  const warnings = r.findings.filter((f) => f.severity === "warning" && !f.baselined).map(issue);
  return {
    file: path.join(r.dir, "MANIFEST.yaml"), ok: r.exit_code === 0,
    error_count: errors.length, warning_count: warnings.length, errors, warnings, findings: r.findings,
    meta: { slug: r.slug, verdict: r.verdict, debt: r.summary.debt },
  };
}

const args = parseArgs();
if (args.help) { printHelp(); process.exit(0); }
if (!fs.existsSync(args.target)) {
  console.error(`error: path not found: ${args.target}`);
  process.exit(2);
}

const results: Result[] = [];
const st = fs.statSync(args.target);
if (st.isFile()) {
  const v = validateMindCloneFile(args.target);
  results.push({ file: args.target, ok: v.ok, error_count: v.errors.length, warning_count: v.warnings.length, errors: v.errors, warnings: v.warnings, meta: v.meta || {} });
} else if (fs.existsSync(path.join(args.target, "MANIFEST.yaml"))) {
  results.push(fromReport(await verifyEntity("mind-clone", args.target, { retrieval: args.retrieval })));
} else {
  const batch = await verifyAll("mind-clone", { roots: [args.target], retrieval: args.retrieval });
  for (const r of batch.reports) results.push(fromReport(r));
}

const okCount = results.filter((r) => r.ok).length;
const failed = results.length - okCount;

if (args.json) {
  console.log(JSON.stringify({
    target: args.target,
    total: results.length,
    ok: okCount,
    failed,
    results: results.map((r) => ({
      file: HOME ? r.file.replace(HOME, "~") : r.file,
      ok: r.ok,
      errors: r.errors,
      warnings: args.quiet ? undefined : r.warnings,
      ...(r.findings ? { findings: r.findings } : {}),
    })),
  }, null, 2));
} else {
  for (const r of results) {
    if (args.quiet && r.ok) continue;
    const tag = r.ok ? "✓" : "✗";
    const rel = HOME ? r.file.replace(HOME, "~") : r.file;
    console.log(`${tag} ${rel}`);
    if (!r.ok) for (const e of r.errors) console.log(`    [${e.code}] ${e.message}`);
    if (!args.quiet) for (const w of r.warnings) console.log(`    ! [${w.code}] ${w.message}`);
  }
  console.log(`\nSummary: ${results.length} mind-clones · ${okCount} ok · ${failed} failed`);
}

process.exit(failed > 0 ? 1 : 0);
