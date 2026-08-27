#!/usr/bin/env bun
/**
 * verify.ts — `nrv validate`, the admission gate for squads, businesses and
 * mind-clones (`nrv verify` is an alias).
 *
 *   nrv validate <squad|business|mind-clone> <slug|path> [--fix] [--strict] [--json] [--no-retrieval] [--baseline <file>]
 *   nrv validate <path>                               kind detected from the manifest on disk
 *   nrv validate <kind> --all [--fix] [--strict] [--json] [--record [--allow-regression]] [--root <dir>]
 *   nrv validate --pack <content-dir> [<kind>|--all-kinds] [--json] [--record]
 *   nrv validate                                      DEPRECATED: runs the system doctor; use `nrv doctor`
 *
 * Kind aliases: biz → business · clone, mc → mind-clone.
 *
 * Exit codes: 0 admitted · 1 an error the baseline does not cover · 2 only
 * warnings, under --strict · 64 usage error or unknown entity (EX_USAGE; the
 * engine's EXIT.INVALID_ARGS is 4 and 2 is reserved for the strict verdict).
 *
 * Contract and criteria: docs/architecture/validate-gate.md.
 */
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import {
  KINDS, VERIFY_EXIT, VerifyUsageError, kindFromAlias, renderBatch, renderReport, verifyAll, verifyEntity, verifyPack,
  type Kind,
} from "../lib/verify/index.ts";

const BOOL_FLAGS = new Set(["fix", "strict", "json", "all", "record", "allow-regression", "no-retrieval", "all-kinds", "quiet", "q", "help", "h"]);
const VALUE_FLAGS = new Set(["baseline", "pack", "root"]);

interface Args { positional: string[]; flags: Record<string, string | boolean>; roots: string[]; }

/** Boolean flags never swallow the next token (`--fix mind-clone x` must work). */
function parse(argv: string[]): Args {
  const out: Args = { positional: [], flags: {}, roots: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") { out.positional.push(...argv.slice(i + 1)); break; }
    if (!a.startsWith("-")) { out.positional.push(a); continue; }
    const body = a.replace(/^--?/, "");
    const eq = body.indexOf("=");
    const name = eq === -1 ? body : body.slice(0, eq);
    const inline = eq === -1 ? null : body.slice(eq + 1);
    if (VALUE_FLAGS.has(name)) {
      const v = inline ?? argv[++i];
      if (v === undefined) throw new VerifyUsageError(`--${name} needs a value`);
      if (name === "root") out.roots.push(v); else out.flags[name] = v;
    } else if (BOOL_FLAGS.has(name)) {
      out.flags[name] = inline ?? true;
    } else {
      throw new VerifyUsageError(`unknown option --${name}`);
    }
  }
  return out;
}

function usage(): string {
  return `nrv validate — the admission gate for squads, businesses and mind-clones

USAGE
  nrv validate <squad|business|mind-clone> <slug|path> [--fix] [--strict] [--json]
  nrv validate <path>                        kind detected from the manifest on disk
  nrv validate <kind> --all [--fix] [--strict] [--json] [--record [--allow-regression]] [--root <dir>]
  nrv validate --pack <content-dir> [<kind>|--all-kinds] [--json] [--record]

OPTIONS
  --fix              apply the mechanical fixers (backup, re-check, rollback on a new error)
  --fix=agentic      not available yet
  --strict           warnings also reject (exit 2)
  --json             nirvana.verify-report/v1 (one entity) or nirvana.verify-batch/v1
  --record           --all/--pack: record the current debt as the baseline (merge; refuses growth)
  --allow-regression allow --record to add debt
  --baseline <file>  baseline file (default: $NIRVANA_HOME/.nirvana/.verify-baseline.json)
  --no-retrieval     skip the self-retrieval axis
  --root <dir>       --all: scan this root instead of the installed library (repeatable)
  --quiet            batch: list only rejected entities

KIND ALIASES  biz → business · clone, mc → mind-clone

EXIT  0 admitted · 1 error not covered by the baseline · 2 only warnings, with --strict · 64 usage / unknown entity

The system doctor moved to \`nrv doctor\`. \`nrv validate\` with no arguments still runs it, with a deprecation notice, for one release.`;
}

function runDoctor(argv: string[]): never {
  process.stderr.write("deprecated: `nrv validate` without arguments runs the system doctor; use `nrv doctor`.\n" +
    "           `nrv validate <squad|business|mind-clone> <slug>` is the admission gate (nrv validate --help).\n");
  const script = process.env.NIRVANA_VERIFY_DOCTOR_SCRIPT || path.join(import.meta.dir, "..", "..", "harness", "scripts", "doctor-system.ts");
  const r = spawnSync(process.execPath, [script, ...argv], { stdio: "inherit" });
  process.exit(r.status ?? 1);
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  let args: Args;
  try { args = parse(argv); }
  catch (e: any) {
    if (e instanceof VerifyUsageError) { console.error(`nrv validate: ${e.message}`); console.error(); console.error(usage()); return VERIFY_EXIT.USAGE; }
    throw e;
  }
  const { positional, flags } = args;
  if (flags.help || flags.h) { console.log(usage()); return 0; }

  const bare = positional.length === 0 && !flags.all && !flags.pack;
  if (bare) runDoctor(argv);

  const json = !!flags.json;
  const strict = !!flags.strict;
  const fix: false | "mechanical" | "agentic" = flags.fix === true ? "mechanical" : flags.fix === "mechanical" ? "mechanical" : flags.fix === "agentic" ? "agentic" : flags.fix ? (() => { throw new VerifyUsageError(`--fix accepts mechanical or agentic, not ${flags.fix}`); })() : false;
  const common = {
    fix, strict,
    retrieval: !flags["no-retrieval"],
    baselinePath: typeof flags.baseline === "string" ? flags.baseline : undefined,
  };

  if (flags.pack) {
    const packDir = String(flags.pack);
    const kindArg = positional[0] ? kindFromAlias(positional[0]) : null;
    if (positional[0] && !kindArg) throw new VerifyUsageError(`unknown kind: ${positional[0]} (squad|business|mind-clone)`);
    const b = await verifyPack(packDir, { ...common, kinds: kindArg ? [kindArg] : [...KINDS], record: !!flags.record, allowRegression: !!flags["allow-regression"] });
    console.log(json ? JSON.stringify(b, null, 2) : renderBatch(b, { quiet: !!(flags.quiet || flags.q) }));
    return b.exit_code;
  }

  const kind: Kind | "auto" = kindFromAlias(positional[0]) ?? "auto";
  if (flags.all) {
    if (kind === "auto") throw new VerifyUsageError(`--all needs a kind: nrv validate <squad|business|mind-clone> --all`);
    const b = await verifyAll(kind, { ...common, roots: args.roots.length ? args.roots : undefined, record: !!flags.record, allowRegression: !!flags["allow-regression"] });
    console.log(json ? JSON.stringify(b, null, 2) : renderBatch(b, { quiet: !!(flags.quiet || flags.q) }));
    return b.exit_code;
  }

  const target = kind === "auto" ? positional[0] : positional[1];
  if (!target) throw new VerifyUsageError(kind === "auto" ? `unknown kind or path: ${positional[0]}` : `nrv validate ${positional[0]} needs a <slug|path> (or --all)`);
  if (positional.length > (kind === "auto" ? 1 : 2)) throw new VerifyUsageError(`unexpected argument: ${positional[kind === "auto" ? 1 : 2]}`);
  const r = await verifyEntity(kind, target, common);
  console.log(json ? JSON.stringify(r, null, 2) : renderReport(r));
  return r.exit_code;
}

main().then((code) => process.exit(code)).catch((e) => {
  if (e instanceof VerifyUsageError) { console.error(`nrv validate: ${e.message}`); process.exit(e.exit); }
  console.error(`nrv validate: ${e?.stack ?? e}`);
  process.exit(1);
});
