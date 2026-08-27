#!/usr/bin/env bun
/**
 * check-entity-admission.ts — new content enters whole, or it does not enter.
 *
 * Every other gate in the pack build asks a relational question: does a fence
 * fire against the brief corpus, does a binding resolve inside the artifact,
 * do two copies agree. None of them reads the entity's OWN metadata — which is
 * how tracking-360 walked into the flagship on 2026-08-16 with three clones
 * carrying no `routing:` block: each was internally consistent, nothing
 * compared it to a previous state (there was none), and every gate stayed
 * green. MRR for an unrouted clone is 0.05 against 1.00 routed — the clone
 * shipped, and was invisible.
 *
 * SINCE THE ADMISSION GATE (`nrv validate`), THIS FILE IS A WRAPPER. The
 * questions below are asked by `verifyPack` (skills/_shared/lib/verify/), one
 * criterion each, and translated back into this gate's own vocabulary. Its
 * flags, its output and its exit codes are FROZEN: `build-all-packs.sh:318`
 * calls it unchanged and its tests are untouched. What changed is that there
 * is now one implementation of "is this entity admissible" instead of two that
 * could drift.
 *
 *   HARD (always fails — cheap to fix, zero debt in the source today):
 *     clone MANIFEST parses                     manifest_parse
 *     clone has routing.one_liner               routing_block_missing / one_liner_missing
 *     clone category is bare                    category_numbered
 *     every entity has .nirvana-surface.json    surface_missing
 *
 *   BASELINED (absolute for NEW entities; recorded debt for existing ones):
 *     clone has validation_verdict              validation_verdict_missing
 *     clone has source_material                 source_material_missing
 *     every seat stands without a clone         seat_thin
 *
 * The split follows the fence gate's lesson: verdict and source_material are
 * produced by the validation pipeline, not by a text edit — a bar that fails
 * 68 entities with no path out is a bar everyone learns to skip. So existing
 * debt is recorded per entity and may only shrink; an entity the baseline has
 * never seen enters complete. `--record` refuses to add debt without
 * `--allow-regression`.
 *
 * The baseline lives beside the machine's global state (like the fence
 * ceiling): it names library entities, which never belong in the engine repo,
 * and it must not move with the working directory. It stays in ITS OWN legacy
 * shape (`.admission-baseline.json`, `{entities: {slug: Gap[]}}`) — the gate's
 * own `.verify-baseline.json` imports it once, and until every pack build has
 * moved over, the two must both be readable.
 *
 * Usage:
 *   bun scripts/check-entity-admission.ts --pack <content-dir>     # the bar (exit 1 on any violation)
 *   bun scripts/check-entity-admission.ts --pack <dir> --record    # write the debt baseline
 *   bun scripts/check-entity-admission.ts --pack <dir> --json
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs, paths as nrvPaths } from "../skills/_shared/lib/bun-helpers.ts";
import { verifyPack } from "../skills/_shared/lib/verify/index.ts";
import type { Finding, VerifyReport } from "../skills/_shared/lib/verify/index.ts";

const { flags } = parseArgs(process.argv.slice(2));
const packDir = typeof flags.pack === "string" ? flags.pack : null;
if (!packDir || !existsSync(packDir)) {
  console.error("usage: check-entity-admission.ts --pack <content-dir> [--record] [--json]");
  process.exit(2);
}

const RED = "\x1b[31m", GRN = "\x1b[32m", YEL = "\x1b[33m", DIM = "\x1b[2m", BOLD = "\x1b[1m", RST = "\x1b[0m";

const BASELINE = flags.baseline && typeof flags.baseline === "string"
  ? flags.baseline // tests point this at a fixture; never at the machine's
  : join((nrvPaths as Record<string, string>).NIRVANA_HOME ?? ".", ".nirvana", ".admission-baseline.json");

type Gap = "no_verdict" | "no_source" | "thin_seat";
function loadBaseline(): Record<string, Gap[]> | null {
  if (!existsSync(BASELINE)) return null;
  try { return JSON.parse(readFileSync(BASELINE, "utf8")).entities ?? {}; } catch { return null; }
}

interface Violation { entity: string; kind: "hard" | "debt"; problem: string; }
const violations: Violation[] = [];
const debtNow: Record<string, Gap[]> = {};
const scanned = new Set<string>();

/**
 * The HARD half, by criterion id. `routing_block_missing` and
 * `one_liner_missing` are one bar with two causes (no block at all, or a block
 * without the line), so both carry the sentence this gate has always printed.
 */
const HARD_CLONE: Record<string, string | ((f: Finding) => string)> = {
  manifest_parse: "MANIFEST.yaml does not parse",
  routing_block_missing: "no routing.one_liner — invisible to semantic dispatch (MRR 0.05 vs 1.00)",
  one_liner_missing: "no routing.one_liner — invisible to semantic dispatch (MRR 0.05 vs 1.00)",
  category_numbered: (f) => f.message,
};

/** The BASELINED half: which criterion becomes which recorded gap. */
const DEBT_CLONE: Record<string, Gap> = {
  validation_verdict_missing: "no_verdict",
  source_material_missing: "no_source",
};

const PLURAL = { squad: "squads", business: "businesses", "mind-clone": "mind-clones" } as const;

const batch = await verifyPack(packDir, { baselinePath: null, retrieval: false, stateDir: null, emit: null });

let clones = 0;
let entities = 0;
for (const report of batch.reports as VerifyReport[]) {
  entities++;
  const byId = new Map<string, Finding>();
  for (const f of report.findings) if (!byId.has(f.id)) byId.set(f.id, f);
  const seen = new Set<string>();
  const hard = (problem: string) => {
    if (seen.has(problem)) return;
    seen.add(problem);
    violations.push({ entity: report.slug, kind: "hard", problem });
  };

  if (report.kind === "mind-clone") {
    clones++;
    scanned.add(report.slug);
    for (const [id, problem] of Object.entries(HARD_CLONE)) {
      const f = byId.get(id);
      if (f) hard(typeof problem === "string" ? problem : problem(f));
    }
    // A manifest that does not parse says nothing about the rest of itself.
    if (!byId.has("manifest_parse")) {
      const gaps: Gap[] = [];
      for (const [id, gap] of Object.entries(DEBT_CLONE)) if (byId.has(id)) gaps.push(gap);
      if (gaps.length) debtNow[report.slug] = gaps;
    }
  }

  if (report.kind === "business") {
    // Keyed by "business/employee.md" so two packs shipping the same business
    // share the debt entry (same rule as clone slugs). Every seat is scanned,
    // not only the thin ones: a seat that was enriched must be able to LEAVE
    // the baseline when `--record` merges.
    const empDir = join(report.dir, "employees");
    if (existsSync(empDir)) {
      for (const f of readdirSync(empDir)) if (f.endsWith(".md")) scanned.add(`${report.slug}/${f}`);
    }
    for (const f of report.findings) {
      if (f.id !== "seat_thin") continue;
      const key = `${report.slug}/${(f.where ?? "").replace(/^employees\//, "")}`;
      (debtNow[key] ??= []).push("thin_seat");
    }
  }

  if (byId.has("surface_missing")) {
    violations.push({
      entity: `${PLURAL[report.kind]}/${report.slug}`, kind: "hard",
      problem: "no .nirvana-surface.json — outside the changes/drift mechanism",
    });
  }
}

// ── the debt verdict ───────────────────────────────────────────────────────
const baseline = loadBaseline();
if (flags.record) {
  const prev = baseline ?? {};
  const grew = Object.entries(debtNow).filter(([slug, gaps]) =>
    gaps.some((g) => !(prev[slug] ?? []).includes(g)));
  if (baseline && grew.length && !flags["allow-regression"]) {
    console.error(`\n${RED}Refusing to record: ${grew.length} entity(ies) would gain NEW debt.${RST}`);
    for (const [slug, gaps] of grew.slice(0, 10)) console.error(`  ${slug}: ${gaps.join(", ")}`);
    console.error(`\n${DIM}  Fix the metadata, or record deliberately with --allow-regression.${RST}\n`);
    process.exit(1);
  }
  // MERGE, never replace: the baseline is global per slug while a pack is one
  // slice of the library. Recording from pack A must not erase what only pack
  // B can see. An entity scanned here and clean has its debt cleared; an
  // entity not in this pack keeps its record untouched.
  const merged: Record<string, Gap[]> = { ...(baseline ?? {}) };
  for (const slug of scanned) {
    if (debtNow[slug]) merged[slug] = debtNow[slug];
    else delete merged[slug];
  }
  mkdirSync(dirname(BASELINE), { recursive: true });
  writeFileSync(BASELINE, JSON.stringify({ recorded_at: new Date().toISOString(), entities: merged }, null, 2) + "\n");
  console.log(`${GRN}Admission debt recorded${RST} — ${Object.keys(merged).length} entity(ies) with gaps (${Object.keys(debtNow).length} in this pack)`);
  console.log(`${DIM}  ${BASELINE.replace(process.env.HOME ?? "~", "~")}${RST}`);
  process.exit(0);
}

for (const [slug, gaps] of Object.entries(debtNow)) {
  for (const g of gaps) {
    const known = baseline ? (baseline[slug] ?? []).includes(g) : false;
    if (!known) {
      const label = g === "no_verdict" ? "no validation_verdict"
        : g === "no_source" ? "no source_material"
        : "thin seat — no method to stand on without a clone (seat-sufficiency)";
      violations.push({
        entity: slug, kind: "debt",
        problem: baseline && slug in baseline
          ? `${label} — a NEW gap on a known entity`
          : `${label} — new content enters complete`,
      });
    }
  }
}

if (flags.json) {
  console.log(JSON.stringify({ clones, entities, violations, debt: debtNow, baseline_present: !!baseline }, null, 2));
  process.exit(violations.length || !baseline ? 1 : 0);
}

console.log(`\n${BOLD}ENTITY ADMISSION — new content enters whole${RST}`);
console.log(`${DIM}  ${entities} entities (${clones} clones) · ${packDir.replace(process.env.HOME ?? "~", "~")}${RST}\n`);

if (!baseline) {
  console.log(`  ${YEL}No debt baseline recorded.${RST} ${DIM}Run: check-entity-admission.ts --pack <dir> --record${RST}\n`);
  process.exit(1);
}
if (!violations.length) {
  const debtCount = Object.keys(debtNow).length;
  console.log(`  ${GRN}Every entity meets the bar.${RST}${debtCount ? `${DIM} (${debtCount} carrying recorded metadata debt — may only shrink)${RST}` : ""}\n`);
  process.exit(0);
}
for (const v of violations.slice(0, 20)) {
  console.log(`  ${RED}✗${RST} ${v.entity.padEnd(34)} ${v.problem}`);
}
if (violations.length > 20) console.log(`  ${DIM}… and ${violations.length - 20} more${RST}`);
console.log(`\n${DIM}  HARD problems are fixed in the entity; debt problems mean a new or grown`);
console.log(`  metadata gap — run the validation pipeline, or record deliberately.${RST}\n`);
process.exit(1);
