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
 * Usage:
 *   bun scripts/check-not-for-fires.ts             # report
 *   bun scripts/check-not-for-fires.ts --strict    # exit 1 if any entity is over budget
 *   bun scripts/check-not-for-fires.ts --json
 *   bun scripts/check-not-for-fires.ts <slug>      # one entity, with the dead entries listed
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { parseArgs } from "../skills/_shared/lib/bun-helpers.ts";

const require_ = createRequire(import.meta.url);
const bm25 = require_(join(import.meta.dir, "..", "skills", "harness", "lib", "bm25.js"));
const registryLoader = require_(join(import.meta.dir, "..", "skills", "harness", "lib", "registry-loader.js"));

const { flags, positional } = parseArgs(process.argv.slice(2));
const only = positional[0];
/** A capabilities map to read instead of the live registry. Without it the only
 *  thing a test can assert is whatever library happens to be on the machine —
 *  which on CI is none, so the interesting assertions could not run at all. */
const fixture = typeof flags.registry === "string" ? flags.registry : null;

const RED = "\x1b[31m", GRN = "\x1b[32m", YEL = "\x1b[33m", DIM = "\x1b[2m", BOLD = "\x1b[1m", RST = "\x1b[0m";

// Mirrors router.js:506-508. If those move, this gate is measuring the wrong
// thing — which is why the numbers live here as named constants rather than
// inline, and why the test asserts they still match.
const SUBSTRING_MAX_CHARS = 25;
const MIN_CONTENT_TOKENS = 2;
const TOKEN_OVERLAP_MIN = 0.6;

const caps: Record<string, Array<Record<string, unknown>>> = fixture
  ? JSON.parse(readFileSync(fixture, "utf8"))
  : (registryLoader.loadAll()?.squads?.capabilities ?? {});

/** Every real example_brief in the library: the user-language corpus we have. */
const briefSets: Array<Set<string>> = [];
for (const list of Object.values(caps)) {
  for (const c of list) {
    for (const b of ((c.example_briefs as string[]) ?? [])) {
      if (typeof b === "string") briefSets.push(new Set(bm25.tokenize(b)));
    }
  }
}
const briefStrings: string[] = [];
for (const list of Object.values(caps)) {
  for (const c of list) {
    for (const b of ((c.example_briefs as string[]) ?? [])) {
      if (typeof b === "string") briefStrings.push(b.toLowerCase());
    }
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
// entry among many is noise; a majority is a broken contract.
const overBudget = all.filter((r) => r.total >= 3 && r.dead / r.total > 0.5);

if (flags.json) {
  console.log(JSON.stringify({ entities: all.length, entries: totalEntries, dead: totalDead, over_budget: overBudget }, null, 2));
  process.exit(flags.strict && overBudget.length ? 1 : 0);
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
  process.exit(flags.strict && r.dead / r.total > 0.5 ? 1 : 0);
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

process.exit(flags.strict && overBudget.length ? 1 : 0);
