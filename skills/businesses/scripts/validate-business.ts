#!/usr/bin/env bun
/**
 * validate-business.ts — the business entry point of the admission gate.
 *
 * Until Business Protocol 2.0 this script was forty lines that spawned
 * `loader.ts` and printed whatever it said: no flags, no catalog, no repair,
 * and a verdict that answered one question (does the manifest parse?) out of
 * the thirty-nine §16.2 asks. It now delegates to the shared runner, so
 * `nrv validate business <slug>` and this script are literally the same code
 * path and cannot drift.
 *
 *   validate-business.ts <slug|path> [--fix] [--strict] [--json] [--report]
 *   validate-business.ts --all [--fix] [--strict] [--json] [--report]
 *
 *   --fix        apply the mechanical fixers (backup, re-check, rollback)
 *   --strict     warnings reject too (exit 2)
 *   --json       nirvana.verify-report/v1 (one business) or -batch/v1 (--all)
 *   --report     also write the JSON under .audit-state/<slug>/verify.json
 *   --no-retrieval  skip the self-retrieval axis
 *
 * Exit: 0 admitted · 1 an error the baseline does not cover · 2 only warnings,
 * under --strict · 64 usage error or unknown business.
 *
 * Criteria and contract: skills/businesses/BUSINESS_PROTOCOL_V2.md §16 and
 * docs/architecture/validate-gate.md.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { paths } from "../../_shared/lib/bun-helpers.ts";
import { enumerate, resolveScope } from "../../_shared/lib/scope.ts";
import {
  VERIFY_EXIT, VerifyUsageError, renderBatch, renderReport, verifyAll, verifyEntity,
  type BatchReport, type VerifyReport,
} from "../../_shared/lib/verify/index.ts";

const KNOWN = new Set(["fix", "strict", "json", "all", "report", "no-retrieval", "quiet", "help", "h"]);

const argv = process.argv.slice(2);
const flags = new Set<string>();
const positional: string[] = [];
for (const a of argv) {
  if (!a.startsWith("-")) { positional.push(a); continue; }
  const name = a.replace(/^--?/, "");
  if (!KNOWN.has(name)) {
    console.error(`validate-business: unknown option --${name}`);
    console.error(USAGE);
    process.exit(VERIFY_EXIT.USAGE);
  }
  flags.add(name);
}

const USAGE = `usage: validate-business <slug|path>|--all [--fix] [--strict] [--json] [--report] [--no-retrieval]

  Admission gate for a business (Business Protocol 2.0 §16). Same catalog,
  same fixers and same exit codes as \`nrv validate business\`.

  0 admitted · 1 error · 2 warnings under --strict · 64 usage / unknown business`;

if (flags.has("help") || flags.has("h")) { console.log(USAGE); process.exit(VERIFY_EXIT.ADMITTED); }

/**
 * Where a report lands. Project scope keeps it inside the project (a business
 * of one project must not leak its verdict into another); global scope uses the
 * businesses skill dir, the same split `audit-businesses-score.ts` already made.
 */
function reportDir(slug: string): string {
  const scope = resolveScope();
  const base = scope.projectRoot
    ? path.join(scope.projectRoot, ".nirvana", ".audit-state")
    : path.join(paths.CLAUDE_SKILLS_DIR, "businesses", ".audit-state");
  return path.join(base, slug);
}

function writeReport(r: VerifyReport): void {
  const dir = reportDir(r.slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "verify.json"), JSON.stringify(r, null, 2) + "\n", "utf8");
  if (!flags.has("json")) console.log(`report: ${path.join(dir, "verify.json")}`);
}

/** A slug the scope knows, a path, or nothing this machine can resolve. */
function resolveTarget(target: string): string {
  if (fs.existsSync(path.resolve(target))) return path.resolve(target);
  const scoped = enumerate(resolveScope(), "businesses").find((e) => e.slug === target && !e.overridden)?.dir;
  return scoped ?? target;
}

async function main(): Promise<number> {
  const common = {
    fix: flags.has("fix") ? ("mechanical" as const) : (false as const),
    strict: flags.has("strict"),
    retrieval: !flags.has("no-retrieval"),
  };

  if (flags.has("all")) {
    if (positional.length) throw new VerifyUsageError(`--all takes no <slug> (got ${positional[0]})`);
    const batch: BatchReport = await verifyAll("business", common);
    console.log(flags.has("json") ? JSON.stringify(batch, null, 2) : renderBatch(batch, { quiet: flags.has("quiet") }));
    if (flags.has("report")) for (const r of batch.reports) writeReport(r);
    return batch.exit_code;
  }

  const target = positional[0];
  if (!target) throw new VerifyUsageError("a <slug> or a path is required (or --all)");
  if (positional.length > 1) throw new VerifyUsageError(`unexpected argument: ${positional[1]}`);
  const report = await verifyEntity("business", resolveTarget(target), common);
  console.log(flags.has("json") ? JSON.stringify(report, null, 2) : renderReport(report));
  if (flags.has("report")) writeReport(report);
  return report.exit_code;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    if (e instanceof VerifyUsageError) {
      console.error(`validate-business: ${e.message}`);
      console.error(USAGE);
      process.exit(e.exit);
    }
    console.error(`validate-business: ${e?.stack ?? e}`);
    process.exit(VERIFY_EXIT.REJECTED);
  });
