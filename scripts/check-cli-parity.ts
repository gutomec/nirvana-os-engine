#!/usr/bin/env bun
// check-cli-parity.ts — gate that the two dispatchers stay in sync with the
// single command table (skills/harness/lib/commands.ts). Run in the build.
//
// Verifies:
//   1. bin/nrv (bash) case names+aliases == the table's names+aliases.
//   2. skills/harness/scripts/nrv.ts case names+aliases == the table's.
//   3. every non-custom command's target file exists under skills/.
//
// Exit 0 = in sync · 1 = drift (prints exactly what diverged).
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { COMMANDS, META_NAMES } from "../skills/harness/lib/commands.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKILLS = join(ROOT, "skills");

// Flag-style aliases (--version, -h, …) are conventions, not dispatch-divergence
// risks, so they are excluded from the comparison on every side.
const keep = (tok: string): boolean => tok !== "" && tok !== "*" && !tok.startsWith("-");
const clean = (tok: string): string => tok.replace(/^["']|["']$/g, "");

// All command names the table declares (canonical + non-flag aliases).
const tableNames = new Set<string>();
for (const c of COMMANDS) { tableNames.add(c.name); for (const a of c.aliases ?? []) if (keep(a)) tableNames.add(a); }

// Bash top-level case labels: `  name|alias|"")` at exactly 2-space indent.
function bashNames(): Set<string> {
  const src = readFileSync(join(ROOT, "bin", "nrv"), "utf8");
  const out = new Set<string>();
  for (const m of src.matchAll(/^ {2}(\S[^)\n]*)\)/gm)) {
    for (const raw of m[1].split("|")) { const tok = clean(raw); if (keep(tok)) out.add(tok); }
  }
  return out;
}

// nrv.ts switch labels: `case "name":` (possibly several per line).
function tsNames(): Set<string> {
  const src = readFileSync(join(SKILLS, "harness", "scripts", "nrv.ts"), "utf8");
  const out = new Set<string>();
  for (const m of src.matchAll(/case\s+"([^"]*)"/g)) { const tok = clean(m[1]); if (keep(tok)) out.add(tok); }
  return out;
}

function diff(label: string, table: Set<string>, impl: Set<string>): string[] {
  const errs: string[] = [];
  for (const n of table) if (!impl.has(n)) errs.push(`  ${label}: MISSING "${n}" (in table, not in ${label})`);
  for (const n of impl) if (!table.has(n)) errs.push(`  ${label}: EXTRA "${n}" (in ${label}, not in table)`);
  return errs;
}

const errors: string[] = [];
errors.push(...diff("bin/nrv", tableNames, bashNames()));
errors.push(...diff("nrv.ts", tableNames, tsNames()));

// Target files exist (non-custom).
for (const c of COMMANDS) {
  if (c.custom || META_NAMES.has(c.name) || !c.target) continue;
  if (!existsSync(join(SKILLS, c.target))) errors.push(`  target MISSING: ${c.name} -> skills/${c.target}`);
}

if (errors.length) {
  console.error(`CLI parity FAILED (${errors.length}):`);
  for (const e of errors) console.error(e);
  process.exit(1);
}
console.log(`CLI parity OK — ${COMMANDS.length} commands in sync across table, bin/nrv, nrv.ts; all targets exist.`);
