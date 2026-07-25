#!/usr/bin/env bun
/**
 * validate-mind-clones.ts — CLI to audit mind-clone files against the canonical
 * format (frontmatter schema + 10 canonical body sections).
 *
 * Usage:
 *   bun validate-mind-clones.ts <path>             # validate a single .md or a directory
 *   bun validate-mind-clones.ts                    # validate the whole DNA library
 *   bun validate-mind-clones.ts --json             # machine-readable output
 *   bun validate-mind-clones.ts --quiet            # only report failures
 *
 * Exit codes:
 *   0  → all valid
 *   1  → at least one mind-clone failed validation
 *   2  → CLI usage error
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { validateMindCloneFile } from "../lib/mindclone-validator.ts";

const HOME = process.env.HOME || "";
const DEFAULT_DNA = process.env.DNA_LIBRARY || path.join(HOME, "businesses", "_library", "dna");

interface CliArgs {
  target: string;
  json: boolean;
  quiet: boolean;
  help: boolean;
}

function parseArgs(): CliArgs {
  const argv = process.argv.slice(2);
  const flags = { json: false, quiet: false, help: false };
  const positional: string[] = [];
  for (const a of argv) {
    if (a === "--json") flags.json = true;
    else if (a === "--quiet" || a === "-q") flags.quiet = true;
    else if (a === "--help" || a === "-h") flags.help = true;
    else positional.push(a);
  }
  return {
    target: positional[0] || DEFAULT_DNA,
    json: flags.json,
    quiet: flags.quiet,
    help: flags.help,
  };
}

const LOCALE_VARIANT = /\.[a-z]{2}(?:-[A-Z]{2})?\.md$/;

// Collect the persona file(s) to validate. When given a directory, only the
// canonical persona files (<clone>/agent/AGENT.md) are validated — NOT support
// docs like agent/SOUL.md, dna/dna-schema.md, README.md or LEGACY-*.md. When
// given a single .md path, validate it directly.
function* collectPersona(p: string, isTarget = false): Generator<string> {
  let st; try { st = fs.statSync(p); } catch { return; }
  if (st.isFile()) {
    if (isTarget && p.endsWith(".md") && !LOCALE_VARIANT.test(p) && !path.basename(p).startsWith(".")) yield p;
    return;
  }
  const agentMd = path.join(p, "agent", "AGENT.md");
  if (fs.existsSync(agentMd)) { yield agentMd; return; } // this directory is a clone
  for (const e of fs.readdirSync(p)) {
    if (e.startsWith(".")) continue;
    const sub = path.join(p, e);
    let s; try { s = fs.statSync(sub); } catch { continue; }
    if (s.isDirectory()) yield* collectPersona(sub, false);
    // loose .md files inside directories (README, etc.) are intentionally ignored
  }
}

function printHelp() {
  console.log(`validate-mind-clones — audit canonical mind-clone files

USAGE
  bun ~/.nirvana/skills/_shared/scripts/validate-mind-clones.ts [<path>] [--json] [--quiet]

ARGS
  <path>     File or directory. Defaults to \$DNA_LIBRARY (~/businesses/_library/dna).

FLAGS
  --json     Emit JSON (single object with results array). Suitable for CI.
  --quiet    Only print failures.
  --help     This message.

EXIT
  0  all valid
  1  one or more failed
  2  CLI usage error

EXAMPLES
  bun … validate-mind-clones.ts                              # full library audit
  bun … validate-mind-clones.ts ~/businesses/_library/dna/01-marketing-copy-vendas
  bun … validate-mind-clones.ts ~/businesses/_library/dna/01-marketing-copy-vendas/alex-hormozi.md
  bun … validate-mind-clones.ts --json --quiet | jq '.results[] | select(.ok == false)'
`);
}

const args = parseArgs();
if (args.help) { printHelp(); process.exit(0); }
if (!fs.existsSync(args.target)) {
  console.error(`error: path not found: ${args.target}`);
  process.exit(2);
}

const results: Array<{ file: string; ok: boolean; error_count: number; warning_count: number; errors: any[]; warnings: any[]; meta: any }> = [];
for (const file of collectPersona(args.target, true)) {
  const v = validateMindCloneFile(file);
  results.push({
    file,
    ok: v.ok,
    error_count: v.errors.length,
    warning_count: v.warnings.length,
    errors: v.errors,
    warnings: v.warnings,
    meta: v.meta || {},
  });
}

const okCount = results.filter(r => r.ok).length;
const failed = results.length - okCount;

if (args.json) {
  console.log(JSON.stringify({
    target: args.target,
    total: results.length,
    ok: okCount,
    failed,
    results: results.map(r => ({
      file: r.file.replace(HOME, "~"),
      ok: r.ok,
      errors: r.errors,
      warnings: args.quiet ? undefined : r.warnings,
    })),
  }, null, 2));
} else {
  for (const r of results) {
    if (args.quiet && r.ok) continue;
    const tag = r.ok ? "✓" : "✗";
    const rel = r.file.replace(HOME, "~");
    if (r.ok) {
      console.log(`${tag} ${rel}`);
    } else {
      console.log(`${tag} ${rel}`);
      for (const e of r.errors) console.log(`    [${e.code}] ${e.message}`);
    }
    for (const w of r.warnings) {
      if (!args.quiet) console.log(`    ! [${w.code}] ${w.message}`);
    }
  }
  console.log(`\nSummary: ${results.length} mind-clones · ${okCount} ok · ${failed} failed`);
}

process.exit(failed > 0 ? 1 : 0);
