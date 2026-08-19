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
 * This is the entity-metadata slice of the admission bar. The full bar is the
 * ensemble the build already runs — validate-squad, check-not-for-fires --pack,
 * check-clone-bindings --pack, check-copy-drift — plus this file:
 *
 *   HARD (always fails — cheap to fix, zero debt in the source today):
 *     clone MANIFEST parses
 *     clone has routing.one_liner        (the definition of "enriched")
 *     clone category is bare             (not the numbered legacy `09-…` form)
 *     every entity has .nirvana-surface.json
 *
 *   BASELINED (absolute for NEW entities; recorded debt for existing ones):
 *     clone has validation_verdict       (68 gaps in today's source)
 *     clone has source_material          (23 gaps in today's source)
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
 * and it must not move with the working directory.
 *
 * Usage:
 *   bun scripts/check-entity-admission.ts --pack <content-dir>     # the bar (exit 1 on any violation)
 *   bun scripts/check-entity-admission.ts --pack <dir> --record    # write the debt baseline
 *   bun scripts/check-entity-admission.ts --pack <dir> --json
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { parseArgs, paths as nrvPaths } from "../skills/_shared/lib/bun-helpers.ts";

const require_ = createRequire(import.meta.url);
const YAML = require_("yaml");

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

// ── clones ─────────────────────────────────────────────────────────────────
const clonesRoot = join(packDir, "mind-clones");
let clones = 0;
if (existsSync(clonesRoot)) {
  for (const slug of readdirSync(clonesRoot)) {
    const mf = join(clonesRoot, slug, "MANIFEST.yaml");
    if (!existsSync(mf)) continue;
    clones++;
    scanned.add(slug);
    let doc: Record<string, unknown> = {};
    try { doc = YAML.parse(readFileSync(mf, "utf8")) ?? {}; }
    catch { violations.push({ entity: slug, kind: "hard", problem: "MANIFEST.yaml does not parse" }); continue; }
    const man = (doc.manifest ?? doc) as Record<string, unknown>;
    const routing = (doc.routing ?? {}) as Record<string, unknown>;

    if (!routing.one_liner) {
      violations.push({ entity: slug, kind: "hard", problem: "no routing.one_liner — invisible to semantic dispatch (MRR 0.05 vs 1.00)" });
    }
    const cat = String(doc.category ?? man.category ?? "");
    if (/^\d\d-/.test(cat)) {
      violations.push({ entity: slug, kind: "hard", problem: `numbered legacy category "${cat}" — the library is bare-form` });
    }
    const gaps: Gap[] = [];
    if (!(doc.validation_verdict ?? man.validation_verdict)) gaps.push("no_verdict");
    if (!(doc.source_material ?? man.source_material)) gaps.push("no_source");
    if (gaps.length) debtNow[slug] = gaps;
  }
}

// ── seats: every employee body must stand without a clone ──────────────────
// Baselined, not hard: alientech-360 ships 9 thin seats in the flagship today,
// and a hard bar with no immediate path out is the bar everyone learns to
// skip. When enrichment zeroes the debt, the bar is absolute in practice.
// Keyed by "business/employee.md" so two packs shipping the same business
// share the debt entry (same rule as clone slugs).
const { sufficiencyOfFile } = require_("../skills/_shared/lib/seat-sufficiency.js");
const bizRoot = join(packDir, "businesses");
if (existsSync(bizRoot)) {
  for (const biz of readdirSync(bizRoot)) {
    const empDir = join(bizRoot, biz, "employees");
    if (!existsSync(empDir)) continue;
    for (const f of readdirSync(empDir)) {
      if (!f.endsWith(".md")) continue;
      const key = `${biz}/${f}`;
      scanned.add(key);
      const r = sufficiencyOfFile(readFileSync(join(empDir, f), "utf8"));
      if (r.verdict === "thin") (debtNow[key] ??= []).push("thin_seat");
    }
  }
}

// ── surface files, every kind ──────────────────────────────────────────────
let entities = 0;
for (const kind of ["squads", "businesses", "mind-clones"]) {
  const root = join(packDir, kind);
  if (!existsSync(root)) continue;
  for (const slug of readdirSync(root)) {
    const dir = join(root, slug);
    const manifest = kind === "squads" ? "squad.yaml" : kind === "businesses" ? "business.yaml" : "MANIFEST.yaml";
    if (!existsSync(join(dir, manifest))) continue;
    entities++;
    if (!existsSync(join(dir, ".nirvana-surface.json"))) {
      violations.push({ entity: `${kind}/${slug}`, kind: "hard", problem: "no .nirvana-surface.json — outside the changes/drift mechanism" });
    }
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
