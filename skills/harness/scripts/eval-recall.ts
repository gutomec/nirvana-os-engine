#!/usr/bin/env bun
// eval-recall.ts — can the orchestrator SEE what it needs to choose?
//
// Every routing measurement in this repo scored RANKING: which entity comes
// first. That is the fast router's question. The agentic path asks a different
// one, and it is the only part of it that is machinery rather than judgement:
// Phase 3 Pass 1 retrieves a shortlist, Pass 2 opens the finalists and decides.
// Pass 2 can only judge what Pass 1 put on the table. If the right entity is
// not in the shortlist, no amount of reasoning recovers it — the orchestrator
// decides correctly over a list that lacks the answer, and nothing anywhere
// reports a problem.
//
// It measures the KEYWORD path specifically. Since 0.14.1 Phase 3 Pass 1 reads
// the whole catalog instead — 68 businesses and 223 squads cost ~6,200 tokens,
// the same as the shortlist that used to stand in for them — so a miss here is
// no longer a miss in the protocol. What it still tells you is how much a
// keyword shortlist would cost if anyone reintroduced one, and which entities
// are invisible to lexical matching, which is worth knowing when writing an
// entity someone may one day search for.
//
// That is what this measures, against briefs that were dispatched, executed and
// PASSED THE GATE — `nrv mine-briefs` builds the corpus, and a brief that
// delivered is a stronger label than a routing opinion.
//
//   nrv eval-recall                       # against baselines/real-briefs.json
//   nrv eval-recall --corpus <file.json>
//   nrv eval-recall --at 5,10,15,30       # the cut-offs to report
//   nrv eval-recall --exclude-named       # drop briefs that name their own target
//   nrv eval-recall --misses              # list what is invisible, and where
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

const argv = process.argv.slice(2);
const has = (f: string) => argv.includes(`--${f}`);
const val = (f: string, d: string) => { const i = argv.indexOf(`--${f}`); return i >= 0 ? argv[i + 1] : d; };
if (has("help") || argv.includes("-h")) {
  console.error("Usage: nrv eval-recall [--corpus <file>] [--at 5,10,15,30] [--exclude-named] [--misses]");
  console.error("");
  console.error("  Does the Phase 3 shortlist CONTAIN the entity that actually delivered?");
  console.error("  Build the corpus first with: nrv mine-briefs --write");
  process.exit(0);
}

const CORPUS = path.resolve(val("corpus", path.join(import.meta.dir, "..", "baselines", "real-briefs.json")));
const CUTS = val("at", "5,10,15,30").split(",").map(Number).filter(n => n > 0);
const MAX = Math.max(...CUTS);

let cases: Array<{ kind: string; slug: string; brief: string }>;
try { cases = JSON.parse(fs.readFileSync(CORPUS, "utf8")).cases; }
catch {
  console.error(`No corpus at ${CORPUS.replace(process.env.HOME || "", "~")}.`);
  console.error("Build it from work that already ran:  nrv mine-briefs --write");
  process.exit(2);
}

const nrv = path.join(process.env.HOME || "", ".local", "bin", "nrv");
const shortlist = (brief: string, kind: string): string[] => {
  const r = spawnSync(fs.existsSync(nrv) ? nrv : "nrv",
    ["search", brief.slice(0, 600), `--kind=${kind}`, `--limit=${MAX}`, "--json"],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  try { return (JSON.parse(r.stdout).results ?? []).map((x: any) => x.slug).filter(Boolean); }
  catch { return []; }
};

const pool = has("exclude-named")
  ? cases.filter(c => !c.brief.toLowerCase().includes(c.slug.toLowerCase()))
  : cases;

const hits: Record<number, number> = Object.fromEntries(CUTS.map(n => [n, 0]));
const byKind: Record<string, { n: number; hit: number }> = {};
const misses: Array<{ kind: string; slug: string; pos: number; brief: string }> = [];

for (const c of pool) {
  const pos = shortlist(c.brief, c.kind).indexOf(c.slug);
  for (const n of CUTS) if (pos >= 0 && pos < n) hits[n]++;
  (byKind[c.kind] ||= { n: 0, hit: 0 }).n++;
  if (pos >= 0 && pos < 15) byKind[c.kind].hit++;
  else misses.push({ kind: c.kind, slug: c.slug, pos, brief: c.brief.replace(/\s+/g, " ").slice(0, 64) });
}

const pct = (a: number, b: number) => b ? `${(100 * a / b).toFixed(1)}%` : "—";
console.log(`\nRECALL — can Pass 2 see what it must choose between?`);
console.log(`  corpus .......... ${pool.length} briefs that passed the gate${has("exclude-named") ? " (excluding those that name their own target)" : ""}`);
console.log(`  distinct targets  ${new Set(pool.map(c => c.slug)).size}\n`);
for (const n of CUTS) console.log(`  recall@${String(n).padStart(2)} ....... ${pct(hits[n], pool.length).padStart(6)}  (${hits[n]}/${pool.length})`);
console.log("");
for (const [k, v] of Object.entries(byKind)) console.log(`  @15 ${k.padEnd(10)} ${pct(v.hit, v.n).padStart(6)}  (${v.hit}/${v.n})`);

if (has("misses")) {
  console.log(`\n  invisible or past 15 — ${misses.length}:`);
  const byTarget: Record<string, number> = {};
  for (const m of misses) byTarget[`${m.kind}:${m.slug}`] = (byTarget[`${m.kind}:${m.slug}`] ?? 0) + 1;
  for (const [t, c] of Object.entries(byTarget).sort((a, b) => b[1] - a[1])) console.log(`    ${String(c).padStart(3)}×  ${t}`);
}
console.log(`\n  A miss is not a misranking: lexical search never surfaced the entity that`);
console.log(`  DID the work. Phase 3 Pass 1 reads the whole catalog for exactly this`);
console.log(`  reason — 68 businesses + 223 squads cost about what this shortlist does.\n`);
