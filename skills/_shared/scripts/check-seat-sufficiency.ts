#!/usr/bin/env bun
/**
 * check-seat-sufficiency.ts — a seat that cannot stand alone does not enter.
 *
 * The per-task clone model (0.7.0) makes "no clone" a legitimate outcome of
 * every dispatch — which turns the employee body into the seat's whole method.
 * Until this gate, nothing read it: a 2-line role label passed every check a
 * 260-line operating manual passed.
 *
 * The measure is skills/_shared/lib/seat-sufficiency.js — sections + decision
 * content, calibrated against the whole library (488 rich → 0 thin, 28 real
 * thin seats found, every verdict on the short side verified by reading).
 *
 * SINCE THE ADMISSION GATE, THIS FILE IS A WRAPPER over `verifyAll("business")`
 * and its `seat_thin` criterion — the same measure, asked once, in the place
 * every other admission question is asked. Flags, output and exit codes are
 * FROZEN: this gate's tests are untouched and its callers (`SKILL.md` Round 5,
 * the pack build) need no edit.
 *
 * Same debt pattern as the admission gate and the fence ceiling:
 *
 *   a seat the baseline has never seen  →  enters SUFFICIENT or not at all
 *   a recorded thin seat                →  tolerated until enriched; the debt
 *                                          may only shrink
 *
 * `--record` refuses to add debt without `--allow-regression` — recording
 * after enrichment is routine, recording new thinness is said out loud. The
 * baseline lives in machine state ($NIRVANA_HOME/.nirvana/): it names library
 * entities, which never belong in the engine repo, and it must not move with
 * the working directory.
 *
 * Usage:
 *   bun check-seat-sufficiency.ts                  # whole library (scope-aware)
 *   bun check-seat-sufficiency.ts <business-slug>  # one business, listing signals
 *   bun check-seat-sufficiency.ts --strict         # exit 1 on new/grown thinness
 *   bun check-seat-sufficiency.ts --record [--allow-regression]
 *   bun check-seat-sufficiency.ts --json
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { parseArgs, paths as nrvPaths } from "../lib/bun-helpers.ts";
import { verifyAll } from "../lib/verify/index.ts";

const require_ = createRequire(import.meta.url);
const { sufficiencyOfFile } = require_("../lib/seat-sufficiency.js");

const { flags, positional } = parseArgs(process.argv.slice(2));
const only = positional[0];
const RED = "\x1b[31m", GRN = "\x1b[32m", YEL = "\x1b[33m", DIM = "\x1b[2m", BOLD = "\x1b[1m", RST = "\x1b[0m";

const BASELINE = typeof flags.baseline === "string"
  ? flags.baseline // tests point this at a fixture, never at the machine's
  : join((nrvPaths as Record<string, string>).NIRVANA_HOME ?? ".", ".nirvana", ".seat-sufficiency-baseline.json");

/** Businesses root override for tests; default is the resolved scope. */
const rootsFlag = typeof flags.businesses === "string" ? flags.businesses : null;

interface Seat { key: string; business: string; employee: string; signals: Record<string, number>; }
const thin: Seat[] = [];
let seats = 0;

// The gate answers "is this seat thin"; the signals below are read straight
// from the file only to PRINT them (`h=… decisions=… chars=…`), which is what
// the single-business listing has always shown.
const batch = await verifyAll("business", {
  roots: rootsFlag ? [rootsFlag] : undefined,
  baselinePath: null, retrieval: false, stateDir: null, emit: null,
});
for (const report of batch.reports) {
  if (only && report.slug !== only) continue;
  const empDir = join(report.dir, "employees");
  if (existsSync(empDir)) seats += readdirSync(empDir).filter((f) => f.endsWith(".md")).length;
  for (const f of report.findings) {
    if (f.id !== "seat_thin") continue;
    const employee = (f.where ?? "").replace(/^employees\//, "");
    let signals: Record<string, number> = {};
    try { signals = sufficiencyOfFile(readFileSync(join(empDir, employee), "utf8")).signals; } catch { /* printed only */ }
    thin.push({ key: `${report.slug}/${employee}`, business: report.slug, employee, signals });
  }
}

function loadBaseline(): string[] | null {
  if (!existsSync(BASELINE)) return null;
  try { return JSON.parse(readFileSync(BASELINE, "utf8")).thin_seats ?? []; } catch { return null; }
}
const baseline = loadBaseline();

if (flags.record) {
  const prev = new Set(baseline ?? []);
  const grew = thin.filter((s) => !prev.has(s.key));
  if (baseline && grew.length && !flags["allow-regression"]) {
    console.error(`\n${RED}Refusing to record: ${grew.length} seat(s) would be NEW debt.${RST}`);
    for (const s of grew.slice(0, 10)) console.error(`  ${s.key}`);
    console.error(`\n${DIM}  Enrich the seat, or record deliberately with --allow-regression.${RST}\n`);
    process.exit(1);
  }
  mkdirSync(dirname(BASELINE), { recursive: true });
  writeFileSync(BASELINE, JSON.stringify({ recorded_at: new Date().toISOString(), thin_seats: thin.map((s) => s.key).sort() }, null, 2) + "\n");
  console.log(`${GRN}Seat debt recorded${RST} — ${thin.length} thin seat(s) of ${seats}`);
  console.log(`${DIM}  ${BASELINE.replace(process.env.HOME ?? "~", "~")}${RST}`);
  process.exit(0);
}

const known = new Set(baseline ?? []);
const newThin = thin.filter((s) => !known.has(s.key));

if (flags.json) {
  console.log(JSON.stringify({ seats, thin: thin.map((s) => s.key), new_thin: newThin.map((s) => s.key), baseline_present: !!baseline }, null, 2));
  process.exit(flags.strict && (newThin.length || !baseline) ? 1 : 0);
}

console.log(`\n${BOLD}SEAT SUFFICIENCY — can every seat stand without a clone?${RST}`);
console.log(`${DIM}  ${seats} seats scanned · measure: sections + decision lines (seat-sufficiency.js)${RST}\n`);

if (only) {
  const mine = thin.filter((s) => s.business === only);
  if (!mine.length) { console.log(`  ${GRN}${only}: every seat is sufficient.${RST}\n`); process.exit(0); }
  for (const s of mine) {
    console.log(`  ${RED}✗${RST} ${s.employee.padEnd(34)} h=${s.signals.headings} decisions=${s.signals.decisionLines} chars=${s.signals.bodyChars}`);
  }
  console.log(`\n${DIM}  Enrich with: bun skills/_shared/scripts/enrich-employee-method.ts --slugs=${only}${RST}\n`);
  process.exit(flags.strict && mine.some((s) => !known.has(s.key)) ? 1 : 0);
}

if (!baseline) {
  console.log(`  thin: ${thin.length}/${seats}`);
  console.log(`  ${YEL}No debt baseline recorded.${RST} ${DIM}Run: check-seat-sufficiency.ts --record${RST}\n`);
  process.exit(flags.strict ? 1 : 0);
}
if (newThin.length) {
  console.log(`  ${RED}${newThin.length} seat(s) are NEW thinness — a seat enters sufficient or not at all:${RST}`);
  for (const s of newThin.slice(0, 12)) console.log(`    ${RED}✗${RST} ${s.key}`);
  console.log();
}
const remaining = thin.length - newThin.length;
console.log(`  recorded debt: ${remaining ? YEL : GRN}${remaining}${RST} of ${known.size} baselined${remaining < known.size ? ` ${GRN}(${known.size - remaining} enriched — re-record to lower the ceiling)${RST}` : ""}`);
if (!newThin.length) console.log(`  ${GRN}No seat is new thinness.${RST}`);
console.log();
process.exit(flags.strict && newThin.length ? 1 : 0);
