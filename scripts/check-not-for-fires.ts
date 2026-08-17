#!/usr/bin/env bun
/**
 * check-not-for-fires.ts — a fence that never fires is not a fence.
 *
 * `not_for` is the only exclusion lever BM25 has. The index carries no negation:
 * a capability stops winning a brief either by losing vocabulary — which also
 * loses the briefs it should win — or by a `not_for` entry firing and
 * multiplying its score by 0.4. Measured this week: narrowing a keyword did not
 * move a ranking at all (BM25 is bag-of-words, `design-token-system` still emits
 * `design` and `system`), while four short `not_for` entries fixed it.
 *
 * And it fails silently. The validator accepts any string; the author believes
 * the boundary is enforced; nothing fires; the squad keeps taking its
 * neighbour's briefs. Four squads audited this week had 24, 24 and 94 dead
 * entries each, and the pattern held across the library.
 *
 * **How firing actually works** (`router.js:510-519`, read, not assumed):
 *
 *   entry.length <= 25  →  substring: briefLc.includes(entry)
 *   entry.length >  25  →  token overlap: >= 2 content tokens AND
 *                          >= 60% of them present in the brief
 *
 * **Why the long path almost never fires.** A 13-token entry needs 8 of its
 * tokens in one brief. Measured against the 2,832 real example_briefs in this
 * library — the best corpus of user language we have — **902 of 910 long
 * entries fire against none of them**. That is the number this gate rests on,
 * and it is a measurement rather than an argument about suffixes: the first
 * theory here was that `(use some.capability.id)` suffixes made entries
 * unmatchable, and a probe disproved it (one such entry reaches 0.69 overlap
 * against its own prefix). Length is the cause; the suffix only adds to it.
 *
 * The gate therefore reports a long entry as dead when it fires against no real
 * brief, instead of guessing from its shape.
 *
 * **Why a baseline and not a hard cut.** 830 of 1,821 entries are dead today,
 * across 93 entities. A gate that turns every build red with no path out is a
 * gate everyone learns to skip — which is exactly how this one spent its first
 * day wired into `check:all` without `--strict`, printing 46% in red and exiting
 * 0. So `--strict` reads a recorded ceiling per entity and fails on two things:
 *
 *   an entity ABOVE its ceiling  →  the debt grew
 *   an entity with NO ceiling    →  new content, and new content enters at zero
 *
 * The second half is the point. Every other gate here is a regression gate: it
 * compares against a previous state, so content arriving for the first time has
 * nothing to fail against and enters at whatever quality it has. `tracking-360`
 * joined the flagship with 79 entries and 79 of them dead, and every gate stayed
 * green because none of them had a "before" to compare it to.
 *
 * Usage:
 *   bun scripts/check-not-for-fires.ts             # report
 *   bun scripts/check-not-for-fires.ts --strict    # exit 1 on growth, or on new content with any dead entry
 *   bun scripts/check-not-for-fires.ts --record    # write the ceiling from the current state
 *   bun scripts/check-not-for-fires.ts --json
 *   bun scripts/check-not-for-fires.ts <slug>      # one entity, with the dead entries listed
 *
 * The ceiling lives beside the registries, like the coverage ratchet's, so it
 * travels with the scope it describes and never puts entity names in the engine
 * repo. `--record` refuses to raise a ceiling without `--allow-regression`:
 * recording after a fix is routine, recording a regression has to be said out loud.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { parseArgs, paths as nrvPaths } from "../skills/_shared/lib/bun-helpers.ts";

const require_ = createRequire(import.meta.url);
const bm25 = require_(join(import.meta.dir, "..", "skills", "harness", "lib", "bm25.js"));
const registryLoader = require_(join(import.meta.dir, "..", "skills", "harness", "lib", "registry-loader.js"));

const { flags, positional } = parseArgs(process.argv.slice(2));
const only = positional[0];
/** A capabilities map to read instead of the live registry. Without it the only
 *  thing a test can assert is whatever library happens to be on the machine —
 *  which on CI is none, so the interesting assertions could not run at all. */
const fixture = typeof flags.registry === "string" ? flags.registry : null;
/** A pack content dir (squads/ + businesses/), for the build-time run. */
const packDir = typeof flags.pack === "string" ? flags.pack : null;

const RED = "\x1b[31m", GRN = "\x1b[32m", YEL = "\x1b[33m", DIM = "\x1b[2m", BOLD = "\x1b[1m", RST = "\x1b[0m";

/** Per-entity ceiling of dead entries.
 *
 *  Anchored to the GLOBAL nirvana home, never to the current scope. The ceiling
 *  describes the machine's authoring library (`~/squads`, `~/businesses`), which
 *  is global, so a path that moves with the working directory describes nothing:
 *  recorded from `~/nirvana-os` it landed in that repo's `.nirvana/`, and the
 *  pack build — which runs from `~/nirvana-packs` — found no ceiling at all and
 *  failed every pack as unrecorded content.
 *
 *  It must not live in the engine repo either: it names 151 library entities,
 *  and entity content does not belong in a content-free public engine.
 *
 *  A fixture run gets its own ceiling file, so tests never read or write the
 *  machine's. */
const BASELINE = fixture
  ? `${fixture}.baseline.json`
  : join((nrvPaths as Record<string, string>).NIRVANA_HOME ?? ".", ".nirvana", ".not-for-baseline.json");

function loadCeilings(): Record<string, number> | null {
  if (!existsSync(BASELINE)) return null;
  try { return JSON.parse(readFileSync(BASELINE, "utf8")).entities ?? {}; } catch { return null; }
}

// Mirrors router.js:506-508. If those move, this gate is measuring the wrong
// thing — which is why the numbers live here as named constants rather than
// inline, and why the test asserts they still match.
const SUBSTRING_MAX_CHARS = 25;
const MIN_CONTENT_TOKENS = 2;
const TOKEN_OVERLAP_MIN = 0.6;

/** Capabilities read straight off a pack's content tree, so the gate can run at
 *  build time against the bytes that ship instead of against whatever the
 *  author's machine happens to have indexed. The pack is a copy of the library,
 *  so the entity names — and therefore the ceiling — are the same. */
function capsFromPack(dir: string): Record<string, Array<Record<string, unknown>>> {
  const YAML = require_("yaml");
  const out: Record<string, Array<Record<string, unknown>>> = {};
  for (const [kind, manifest, key] of [
    ["squads", "squad.yaml", "squad"],
    ["businesses", "business.yaml", "business"],
  ] as const) {
    const root = join(dir, kind);
    if (!existsSync(root)) continue;
    for (const slug of readdirSync(root)) {
      const f = join(root, slug, manifest);
      if (!existsSync(f)) continue;
      let doc: Record<string, unknown>;
      try { doc = YAML.parse(readFileSync(f, "utf8")) ?? {}; } catch { continue; }
      // Key by the manifest's `name`, not the directory. The registry does the
      // same (registry.js:165), and the two differ often enough to matter:
      // `nirvana-rh-dp/` declares `nirvana-rh-departamento-pessoal`. Keying by
      // directory made a squad that has a ceiling look like new content and
      // failed the pack for it.
      const entity = typeof doc.name === "string" && doc.name ? doc.name : slug;
      for (const c of ((doc.capabilities as Array<Record<string, unknown>>) ?? [])) {
        const id = String(c?.id ?? "");
        if (!id) continue;
        (out[id] ??= []).push({ [key]: entity, not_for: c.not_for, example_briefs: c.example_briefs });
      }
    }
  }
  return out;
}

const caps: Record<string, Array<Record<string, unknown>>> = fixture
  ? JSON.parse(readFileSync(fixture, "utf8"))
  : packDir
    ? capsFromPack(packDir)
    : (registryLoader.loadAll()?.squads?.capabilities ?? {});

/** What a fence is judged AGAINST: the widest corpus of real user language we
 *  have. This is deliberately NOT the same set as `caps`.
 *
 *  A long entry is alive if it fires against any real brief — and briefs written
 *  for a neighbouring squad count, because a user writes them too. Judging a
 *  pack against only the 496 briefs it happens to carry marked the very same
 *  `landing-page-nirvana/squad.yaml` as 17-dead in the library and 21-dead in
 *  `marketing-growth`, from a file with a zero-line diff between the two. Same
 *  bytes, different verdict, because the corpus shrank.
 *
 *  A fixture run stays hermetic: tests judge against their fixture alone, never
 *  against whatever library the machine happens to have. */
const corpusCaps: Array<Record<string, unknown>> = [
  ...Object.values(caps).flat(),
  ...(fixture ? [] : Object.values((registryLoader.loadAll()?.squads?.capabilities ?? {}) as Record<string, Array<Record<string, unknown>>>).flat()),
];
const briefSets: Array<Set<string>> = [];
for (const c of corpusCaps) {
  for (const b of ((c.example_briefs as string[]) ?? [])) {
    if (typeof b === "string") briefSets.push(new Set(bm25.tokenize(b)));
  }
}

type Verdict = "fires" | "dead" | "too-short";

function verdict(entry: string): Verdict {
  if (entry.length <= SUBSTRING_MAX_CHARS) {
    // The substring path fires on any brief containing the literal text. Two
    // characters or fewer can never fire (router.js:512).
    return entry.length > 2 ? "fires" : "too-short";
  }
  const tokens = [...new Set<string>(bm25.tokenize(entry))];
  if (tokens.length < MIN_CONTENT_TOKENS) return "dead";
  for (const bs of briefSets) {
    let matched = 0;
    for (const t of tokens) if (bs.has(t)) matched++;
    if (matched / tokens.length >= TOKEN_OVERLAP_MIN) return "fires";
  }
  return "dead";
}

interface Row { entity: string; total: number; dead: number; deadEntries: string[]; }
const rows = new Map<string, Row>();

for (const list of Object.values(caps)) {
  for (const c of list) {
    const slug = (c.squad ?? c.business) as string | undefined;
    if (!slug || (only && slug !== only)) continue;
    const row = rows.get(slug) ?? { entity: slug, total: 0, dead: 0, deadEntries: [] };
    for (const nf of ((c.not_for as string[]) ?? [])) {
      if (typeof nf !== "string") continue;
      row.total++;
      if (verdict(nf) !== "fires") {
        row.dead++;
        if (row.deadEntries.length < 40) row.deadEntries.push(nf);
      }
    }
    rows.set(slug, row);
  }
}

const all = [...rows.values()].filter((r) => r.total > 0);
const totalEntries = all.reduce((n, r) => n + r.total, 0);
const totalDead = all.reduce((n, r) => n + r.dead, 0);

// An entity is over budget when MOST of its fences are dead — that is the state
// where an author has a boundary in mind and the router has none. A single dead
// entry among many is noise; a majority is a broken contract. This drives the
// human report; the ceiling below drives --strict.
const overBudget = all.filter((r) => r.total >= 3 && r.dead / r.total > 0.5);

// ── The ceiling ────────────────────────────────────────────────────────────
const ceilings = loadCeilings();

/** Entities that grew past their ceiling, and entities that have none. The
 *  second list is the admission bar: content the ceiling has never seen enters
 *  at zero dead entries or it does not enter. */
const grew = ceilings ? all.filter((r) => r.dead > (ceilings[r.entity] ?? 0) && r.entity in ceilings) : [];
const unrecorded = ceilings ? all.filter((r) => !(r.entity in ceilings) && r.dead > 0) : [];
const failures = [...grew, ...unrecorded];

if (flags.record) {
  const now: Record<string, number> = {};
  for (const r of all) now[r.entity] = r.dead;
  const raised = ceilings ? all.filter((r) => r.dead > (ceilings[r.entity] ?? 0)) : [];
  if (raised.length && !flags["allow-regression"]) {
    console.error(`\n${RED}Refusing to record: ${raised.length} entity(ies) would get a HIGHER ceiling.${RST}`);
    for (const r of raised.slice(0, 10)) {
      console.error(`  ${r.entity.padEnd(34)} ${ceilings?.[r.entity] ?? 0} → ${r.dead}`);
    }
    console.error(`\n${DIM}  Fix the entries, or record deliberately with --allow-regression.${RST}\n`);
    process.exit(1);
  }
  const lowered = ceilings ? all.filter((r) => r.dead < (ceilings[r.entity] ?? Infinity)).length : 0;
  mkdirSync(dirname(BASELINE), { recursive: true });
  writeFileSync(BASELINE, JSON.stringify({ recorded_at: new Date().toISOString(), entities: now }, null, 2) + "\n");
  console.log(`\n${GRN}Ceiling recorded${RST} — ${all.length} entities, ${totalDead} dead entries`);
  if (lowered) console.log(`${GRN}  ${lowered} ceiling(s) lowered${RST}`);
  console.log(`${DIM}  ${BASELINE.replace(process.env.HOME ?? "~", "~")}${RST}\n`);
  process.exit(0);
}

if (flags.json) {
  console.log(JSON.stringify({
    entities: all.length, entries: totalEntries, dead: totalDead,
    over_budget: overBudget,
    ceiling: ceilings ? { grew: grew.map((r) => r.entity), unrecorded: unrecorded.map((r) => r.entity) } : null,
  }, null, 2));
  process.exit(flags.strict && failures.length ? 1 : 0);
}

console.log(`\n${BOLD}NOT_FOR — does the fence fire?${RST}`);
console.log(`${DIM}  ${totalEntries} entries across ${all.length} entities, tested against ${briefSets.length} real briefs${RST}`);
console.log(`${DIM}  firing rule (router.js:510): <=${SUBSTRING_MAX_CHARS} chars by substring, longer by >=${TOKEN_OVERLAP_MIN * 100}% token overlap${RST}\n`);

if (only) {
  const r = all[0];
  if (!r) { console.log(`  ${YEL}${only}: no not_for entries${RST}\n`); process.exit(0); }
  const c = r.dead === 0 ? GRN : r.dead / r.total > 0.5 ? RED : YEL;
  console.log(`  ${r.entity}: ${c}${r.dead}/${r.total} dead${RST}`);
  for (const e of r.deadEntries) console.log(`    ${DIM}${e.length} chars · ${e.slice(0, 78)}${RST}`);
  console.log(`\n${DIM}  Rewrite each as 2-4 content words, <=${SUBSTRING_MAX_CHARS} chars, EN and PT as separate`);
  console.log(`  entries, accented and unaccented as separate entries, no "(use X)" suffix.${RST}\n`);
  process.exit(flags.strict && failures.some((f) => f.entity === r.entity) ? 1 : 0);
}

const pct = Math.round((100 * totalDead) / Math.max(totalEntries, 1));
const color = pct > 40 ? RED : pct > 15 ? YEL : GRN;
console.log(`  dead: ${color}${totalDead}/${totalEntries} (${pct}%)${RST}`);
console.log(`  entities where most fences are dead: ${overBudget.length ? RED : GRN}${overBudget.length}${RST}\n`);

for (const r of overBudget.sort((a, b) => b.dead - a.dead).slice(0, 15)) {
  console.log(`    ${RED}▼${RST} ${r.entity.padEnd(34)} ${r.dead}/${r.total}`);
}
if (overBudget.length > 15) console.log(`    ${DIM}… and ${overBudget.length - 15} more${RST}`);

console.log(`\n${DIM}  A dead entry costs nothing at retrieval — not_for is not BM25-indexed. What it`);
console.log(`  costs is the belief that a boundary exists. Inspect one with:`);
console.log(`    bun scripts/check-not-for-fires.ts <slug>${RST}\n`);

// ── The ceiling verdict ────────────────────────────────────────────────────
if (!all.length) process.exit(0);            // no library in scope — nothing to judge
if (!ceilings) {
  console.log(`  ${YEL}No ceiling recorded.${RST} ${DIM}Run: bun scripts/check-not-for-fires.ts --record${RST}\n`);
  process.exit(flags.strict ? 1 : 0);
}

if (grew.length) {
  console.log(`  ${RED}${grew.length} entity(ies) grew past their ceiling:${RST}`);
  for (const r of grew.slice(0, 10)) {
    console.log(`    ${RED}↑${RST} ${r.entity.padEnd(34)} ${ceilings[r.entity]} → ${r.dead}`);
  }
  console.log();
}
if (unrecorded.length) {
  console.log(`  ${RED}${unrecorded.length} entity(ies) are new to the ceiling and arrive with dead fences:${RST}`);
  for (const r of unrecorded.slice(0, 10)) {
    console.log(`    ${RED}✗${RST} ${r.entity.padEnd(34)} ${r.dead}/${r.total} dead`);
  }
  console.log(`\n${DIM}  New content enters at zero. Every other gate here compares against a`);
  console.log(`  previous state, so a first arrival has nothing to fail against — which is`);
  console.log(`  how 79 dead fences walked into the flagship pack green.${RST}\n`);
}
if (!failures.length) {
  console.log(`  ${GRN}No entity is above its ceiling, and nothing new arrived with a dead fence.${RST}\n`);
}

process.exit(flags.strict && failures.length ? 1 : 0);
