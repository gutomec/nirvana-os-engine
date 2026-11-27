#!/usr/bin/env bun
// performance.ts — `nrv performance`: how each business and squad has been
// doing, read from the audit. Written for an agent to read: plain sentences
// and what the numbers mean. Read-only: it emits no audit event.
//
//   nrv performance                         every entity with a run in the window, most runs first
//   nrv performance <business|squad> <slug> one entity in detail
//   --days N   the window (default 30, at most 365)   --json   machine-readable
//
// Exit: 0 printed · 4 wrong arguments.
import { EXIT, parseArgs } from "../../_shared/lib/bun-helpers.ts";
import { entityPerformance, recurringFindings, RECURRING_MIN_GATED_RUNS, RECURRING_MIN_RUNS, type EntityPerformance } from "../lib/entity-performance.ts";

const USAGE = [
  "usage: nrv performance [<business|squad> <slug>] [--days N] [--json]",
  "  (no target)               every business and squad with a run in the window, most runs first",
  "  <business|squad> <slug>   one entity in detail, with the findings that keep failing its gate",
  "  --days N                  the window in days (default 30, at most 365)",
  "  --json                    machine-readable; a value the audit does not hold is null",
].join("\n");

const { positional, flags } = parseArgs();
const fail = (line: string): never => { console.error(`${line}\n${USAGE}`); process.exit(EXIT.INVALID_ARGS); };
if (flags.help === true || flags.h === true) { console.log(USAGE); process.exit(EXIT.OK); }

let days = 30;
if (flags.days !== undefined) {
  days = typeof flags.days === "string" ? Number(flags.days) : NaN;
  if (!Number.isInteger(days) || days < 1 || days > 365) fail("performance: --days is a whole number of days from 1 to 365");
}
const [kind, slug] = positional;
if (positional.length > 2 || (kind !== undefined && (!slug || (kind !== "business" && kind !== "squad")))) {
  fail("performance: name the entity as `business <slug>` or `squad <slug>`, or give none for all of them");
}

const report = await entityPerformance({ days });
const json = flags.json === true;

const pct = (v: number | null): string => (v === null ? "unknown" : `${Math.round(v * 100)}%`);
const rounds = (v: number | null): string => (v === null ? "unknown" : v.toFixed(1));
const money = (v: number | null): string => (v === null ? "unknown" : `$${v.toFixed(2)}`);
function duration(ms: number | null): string {
  if (ms === null) return "unknown";
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

const LEGEND = [
  "How to read it: a run is one dispatch of the entity. ok = delivered clean, resv = delivered with reservations, held = withheld by the gate, fail = no verifiable deliverable, open = no recorded end.",
  "1st pass = share of the runs that reached the gate and passed it with no correction. corr = mean correction rounds per gated run. time = median from dispatch to outcome. cost = what the runtimes reported for the workers; corrections and the judge are not in it.",
  "\"unknown\" means the audit holds no such value for these runs; it is not zero.",
];
const PER_PROJECT = "The audit is per project: run this from the project whose runs you want, or widen the window with --days.";

if (kind === undefined) {
  if (json) { console.log(JSON.stringify({ ok: true, ...report })); process.exit(EXIT.OK); }
  if (!report.entities.length) {
    console.log(`No business or squad was dispatched in the last ${report.window_days} day(s) in the audit at ${report.logs_root}.`);
    console.log(PER_PROJECT);
    process.exit(EXIT.OK);
  }
  console.log(`Performance of ${report.entities.length} entit${report.entities.length === 1 ? "y" : "ies"} over the last ${report.window_days} day(s), most runs first (audit: ${report.logs_root}).`);
  console.log("");
  const rows = report.entities.map(e => [
    `${e.kind} ${e.slug}`, String(e.runs), String(e.delivered), String(e.delivered_with_reservations), String(e.withheld),
    String(e.failed), String(e.other), pct(e.first_pass_gate_rate), rounds(e.mean_correction_rounds),
    duration(e.median_duration_ms), money(e.total_cost_usd), e.findings[0] ? `${e.findings[0].finding} (${e.findings[0].runs})` : "-",
  ]);
  const head = ["entity", "runs", "ok", "resv", "held", "fail", "open", "1st pass", "corr", "time", "cost", "top finding (runs)"];
  const width = head.map((h, i) => Math.max(h.length, ...rows.map(r => r[i].length)));
  for (const r of [head, ...rows]) console.log(r.map((cell, i) => cell.padEnd(width[i])).join("  ").trimEnd());
  console.log("");
  for (const line of LEGEND) console.log(line);
  console.log("One entity in detail: nrv performance <business|squad> <slug>.");
  process.exit(EXIT.OK);
}

const entity: EntityPerformance | undefined = report.entities.find(e => e.kind === kind && e.slug === slug);
if (json) {
  console.log(JSON.stringify({
    ok: true, window_days: report.window_days, logs_root: report.logs_root, generated_at: report.generated_at,
    entity: entity ?? null, recurring: recurringFindings(entity),
  }));
  process.exit(EXIT.OK);
}
if (!entity) {
  console.log(`The ${kind} ${slug} has no run in the last ${report.window_days} day(s) in the audit at ${report.logs_root}.`);
  console.log(PER_PROJECT);
  process.exit(EXIT.OK);
}

const e = entity;
console.log(`${e.kind} ${e.slug}: ${e.runs} run(s) in the last ${report.window_days} day(s)${e.last_run_at ? `, the last one on ${e.last_run_at.slice(0, 10)}` : ""}.`);
console.log(`Outcomes: ${e.delivered} delivered, ${e.delivered_with_reservations} delivered with reservations, ${e.withheld} withheld, ${e.failed} failed, ${e.other} with no recorded end.`);
if (e.gated_runs) {
  console.log(`Gate: ${e.gated_runs} run(s) reached it; ${pct(e.first_pass_gate_rate)} passed at the first round, and a gated run took ${rounds(e.mean_correction_rounds)} correction round(s) on average.`);
} else {
  console.log("Gate: no run reached it, so the first-pass rate and the correction rounds are unknown.");
}
console.log(`Median time from dispatch to outcome: ${duration(e.median_duration_ms)}.`);
console.log(e.total_cost_usd === null
  ? "Cost: unknown; no runtime reported one for these runs."
  : `Cost: ${money(e.total_cost_usd)} reported by the runtimes for the workers of ${e.cost_known_runs} of ${e.runs} run(s); corrections and the judge are not in it.`);
if (e.capabilities.length) console.log(`Capabilities: ${e.capabilities.map(c => `${c.id} (${c.runs})`).join(", ")}.`);
if (e.findings.length) {
  console.log(`What failed the gate, by the number of runs it failed in (named for ${e.findings_known_runs} of ${e.gated_runs} gated run(s)):`);
  for (const f of e.findings) console.log(`  ${f.finding}: ${f.runs} run(s)`);
} else if (e.gated_runs > e.findings_known_runs) {
  console.log(`What failed the gate is not named in the audit for ${e.gated_runs - e.findings_known_runs} gated run(s) from before the audit carried it.`);
} else if (e.gated_runs) {
  console.log("No gate finding is on record for these runs.");
}
const recurring = recurringFindings(e);
console.log(recurring.length
  ? `The next dispatch of this ${e.kind} tells its worker up front about: ${recurring.map(f => f.finding).join(", ")}.`
  : `Nothing is passed to the next worker: that takes ${RECURRING_MIN_GATED_RUNS} gated runs and the same finding in ${RECURRING_MIN_RUNS} of them.`);
process.exit(EXIT.OK);
