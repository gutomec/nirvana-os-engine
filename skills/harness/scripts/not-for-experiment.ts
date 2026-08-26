#!/usr/bin/env bun
/**
 * not-for-experiment.ts — offline evaluator for the `not_for` firing rule.
 *
 * The router (router.js `notForFires`) decides when a fence vetoes a
 * capability: a fired fence multiplies the score by 0.4. The gate
 * (scripts/check-not-for-fires.ts) reports which fences never fire. Neither
 * measures the OTHER failure: a fence that fires on the very brief its own
 * capability should win — a self-fire, which hands the brief to a neighbour.
 * This script measures both, per rule variant, on the two corpora the repo
 * already has:
 *
 *   1. the library's example_briefs (the gate's corpus), tagged with the owner
 *      entity + capability, so every firing is classified as self (same
 *      capability), sibling (same entity, other capability) or cross;
 *   2. the routing eval (eval-routing.ts over the golden set + negatives), run
 *      with the variant injected into the router — the floors.
 *
 * The variant is injected without editing router.js: the file is compiled
 * in-process with `notForFires` replaced by a hook, and the module object that
 * eval-routing.ts holds is pointed at the variant's `route` for the duration of
 * one eval. The match index is built once and shared across variants —
 * not_for is not indexed, so the index does not depend on the rule. The
 * baseline variant is run through the hook and compared with an unpatched
 * eval, so a broken injection fails loudly instead of measuring nothing.
 *
 * Usage:
 *   bun skills/harness/scripts/not-for-experiment.ts variants [--json <out>] [--only a,b] [--no-routing]
 *   bun skills/harness/scripts/not-for-experiment.ts proposals [--json <out>]
 *
 * `proposals` lists, for every entity where most fences are dead, the dead
 * entries, the boundaries the data shows (capabilities of the entity ranking
 * in the top results for briefs owned by someone else, plus the redirect
 * targets the dead entries name), and short fence candidates per boundary:
 * surface phrases that occur in the neighbour's briefs and in none of the
 * entity's own. Read-only: touches no entity, writes only the --json file.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { parseArgs } from "../../_shared/lib/bun-helpers.ts";
import { runEval } from "./eval-routing.ts";

const require_ = createRequire(import.meta.url);
const LIB = path.join(import.meta.dir, "..", "lib");
const ROUTER_PATH = path.join(LIB, "router.js");
const bm25 = require_(path.join(LIB, "bm25.js"));
const registryLoader = require_(path.join(LIB, "registry-loader.js"));
/** The very module object eval-routing.ts holds (same resolved path, same CJS
 *  cache entry). Patched per variant, restored after. */
const router = require_(ROUTER_PATH);

const { flags, positional } = parseArgs(process.argv.slice(2));
const mode = positional[0] ?? "variants";
const jsonOut = typeof flags.json === "string" ? flags.json : null;
const onlyVariants = typeof flags.only === "string" ? new Set(flags.only.split(",")) : null;
const withRouting = !flags["no-routing"];

// ── text views ─────────────────────────────────────────────────────────────

/** Where an entry's subject ends and its commentary begins: an em/en dash
 *  clause, a "(use …)" redirect, a semicolon, or " - use …". */
const HEAD_SPLIT = /\s[—–]\s|\s+\((?:use|usar|prefira|see)\b|;\s|\s-\s+(?:use|usar)\b/i;

function ngrams(tokens: string[], n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i + n <= tokens.length; i++) out.push(tokens.slice(i, i + n).join(" "));
  return out;
}

interface TokenView { uniq: Set<string>; grams2: string[]; grams3: string[] }

function tokenView(text: string): TokenView {
  const tokens: string[] = bm25.tokenize(text);
  return { uniq: new Set(tokens), grams2: ngrams(tokens, 2), grams3: ngrams(tokens, 3) };
}

interface Entry { text: string; lc: string; len: number; full: TokenView; head: TokenView; entity: string; capId: string }
interface BriefView { lc: string; set: Set<string>; grams2: Set<string>; grams3: Set<string> }
interface Brief extends BriefView { text: string; entity: string; capId: string }

const entryMemo = new Map<string, Entry>();
function entryOf(text: string): Entry {
  let e = entryMemo.get(text);
  if (!e) {
    e = {
      text, lc: text.toLowerCase(), len: text.length,
      full: tokenView(text), head: tokenView(text.split(HEAD_SPLIT)[0]),
      entity: "", capId: "",
    };
    entryMemo.set(text, e);
  }
  return e;
}

const briefMemo = new Map<string, BriefView>();
/** Keyed by the lowercased brief — the string the router hands the rule. */
function briefViewOf(lc: string): BriefView {
  let b = briefMemo.get(lc);
  if (!b) {
    const tokens: string[] = bm25.tokenize(lc);
    b = { lc, set: new Set(tokens), grams2: new Set(ngrams(tokens, 2)), grams3: new Set(ngrams(tokens, 3)) };
    briefMemo.set(lc, b);
  }
  return b;
}

// ── the rule variants ──────────────────────────────────────────────────────

type LongRule = (e: Entry, b: BriefView) => boolean;
interface Variant { name: string; description: string; shortMax: number; long: LongRule }

const overlap = (min: number, part: "full" | "head" = "full"): LongRule => (e, b) => {
  const uniq = e[part].uniq;
  if (uniq.size < 2) return false;
  let matched = 0;
  for (const t of uniq) if (b.set.has(t)) matched++;
  return matched / uniq.size >= min;
};
const contiguous = (n: 2 | 3, part: "full" | "head" = "full"): LongRule => (e, b) => {
  const grams = n === 2 ? e[part].grams2 : e[part].grams3;
  const have = n === 2 ? b.grams2 : b.grams3;
  for (const g of grams) if (have.has(g)) return true;
  return false;
};
const either = (a: LongRule, b: LongRule): LongRule => (e, br) => a(e, br) || b(e, br);
const both = (a: LongRule, b: LongRule): LongRule => (e, br) => a(e, br) && b(e, br);

const VARIANTS: Variant[] = [
  { name: "baseline", description: "substring <=25; else >=2 tokens and >=60% overlap (router.js today)", shortMax: 25, long: overlap(0.6) },
  { name: "overlap-0.5", description: "as baseline, overlap >=50%", shortMax: 25, long: overlap(0.5) },
  { name: "overlap-0.4", description: "as baseline, overlap >=40%", shortMax: 25, long: overlap(0.4) },
  { name: "bigram", description: "substring <=25; else any contiguous 2 content tokens of the entry appear contiguously in the brief", shortMax: 25, long: contiguous(2) },
  { name: "trigram", description: "substring <=25; else any contiguous 3 content tokens", shortMax: 25, long: contiguous(3) },
  { name: "hybrid-3-or-0.6", description: "trigram OR overlap >=60%", shortMax: 25, long: either(contiguous(3), overlap(0.6)) },
  { name: "hybrid-2-or-0.6", description: "bigram OR overlap >=60%", shortMax: 25, long: either(contiguous(2), overlap(0.6)) },
  { name: "substring-40", description: "substring <=40; else overlap >=60% (expected worse)", shortMax: 40, long: overlap(0.6) },
  { name: "head-0.6", description: "overlap >=60% over the head clause only (dash commentary and '(use …)' tail removed)", shortMax: 25, long: overlap(0.6, "head") },
  { name: "head-0.5", description: "overlap >=50% over the head clause only", shortMax: 25, long: overlap(0.5, "head") },
  { name: "bigram-and-0.4", description: "bigram AND overlap >=40% (phrase evidence plus breadth)", shortMax: 25, long: both(contiguous(2), overlap(0.4)) },
  { name: "trigram-head-or-0.6", description: "trigram over the head clause OR overlap >=60% over the head clause", shortMax: 25, long: either(contiguous(3, "head"), overlap(0.6, "head")) },
];

function fires(v: Variant, e: Entry, b: BriefView): boolean {
  if (e.len <= v.shortMax) return e.len > 2 && b.lc.includes(e.lc);
  return v.long(e, b);
}

// ── corpus ─────────────────────────────────────────────────────────────────

const registries = registryLoader.loadAll();
const caps: Record<string, Array<Record<string, any>>> = registries?.squads?.capabilities ?? {};
if (!Object.keys(caps).length) {
  console.error("no capabilities in scope — nothing to measure");
  process.exit(2);
}

const briefs: Brief[] = [];
const entries: Entry[] = [];
for (const [capId, list] of Object.entries(caps)) {
  for (const c of list) {
    const entity: string | undefined = c.squad ?? c.business;
    if (!entity) continue;
    for (const b of (c.example_briefs ?? [])) {
      if (typeof b === "string") briefs.push({ ...briefViewOf(b.toLowerCase()), text: b, entity, capId });
    }
    for (const nf of (c.not_for ?? [])) {
      if (typeof nf === "string") entries.push({ ...entryOf(nf), entity, capId });
    }
  }
}

// ── corpus metrics ─────────────────────────────────────────────────────────

interface EntityRow { entity: string; total: number; dead_gate: number; dead_measured: number; short_never_fire: number; self_fire_cap: number }

interface CorpusMetrics {
  entries: number;
  briefs: number;
  live_measured: number;
  live_gate: number;
  dead_gate: number;
  short_entries: number;
  short_never_fire: number;
  self_fire_cap: number;
  self_fire_entity: number;
  self_only: number;
  cross_fire: number;
  clean_cross: number;
  pairs: { self: number; sibling: number; cross: number };
  over_budget: number;
  self_fire_examples: Array<{ entity: string; capability_id: string; entry: string; brief: string }>;
  by_entity: EntityRow[];
}

/** The gate's over-budget rule: at least 3 fences and most of them dead. */
const overBudgetRow = (r: { total: number; dead_gate: number }) => r.total >= 3 && r.dead_gate / r.total > 0.5;

function corpusMetrics(v: Variant): CorpusMetrics {
  const m: CorpusMetrics = {
    entries: entries.length, briefs: briefs.length,
    live_measured: 0, live_gate: 0, dead_gate: 0, short_entries: 0, short_never_fire: 0,
    self_fire_cap: 0, self_fire_entity: 0, self_only: 0, cross_fire: 0, clean_cross: 0,
    pairs: { self: 0, sibling: 0, cross: 0 }, over_budget: 0, self_fire_examples: [], by_entity: [],
  };
  const rows = new Map<string, EntityRow>();
  for (const e of entries) {
    let fired = false, selfCap = false, selfEntity = false, cross = false;
    let example: Brief | null = null;
    for (const b of briefs) {
      if (!fires(v, e, b)) continue;
      fired = true;
      if (b.entity === e.entity) {
        selfEntity = true;
        if (b.capId === e.capId) { selfCap = true; m.pairs.self++; if (!example) example = b; }
        else m.pairs.sibling++;
      } else { cross = true; m.pairs.cross++; }
    }
    const short = e.len <= v.shortMax;
    const liveGate = short ? e.len > 2 : fired;
    if (short) { m.short_entries++; if (!fired) m.short_never_fire++; }
    if (fired) m.live_measured++;
    if (liveGate) m.live_gate++; else m.dead_gate++;
    if (selfCap) m.self_fire_cap++;
    if (selfEntity) m.self_fire_entity++;
    if (selfCap && !cross) m.self_only++;
    if (cross) m.cross_fire++;
    if (cross && !selfCap) m.clean_cross++;
    if (selfCap && example && m.self_fire_examples.length < 12) {
      m.self_fire_examples.push({ entity: e.entity, capability_id: e.capId, entry: e.text, brief: example.text });
    }
    const row = rows.get(e.entity) ?? { entity: e.entity, total: 0, dead_gate: 0, dead_measured: 0, short_never_fire: 0, self_fire_cap: 0 };
    row.total++;
    if (!liveGate) row.dead_gate++;
    if (!fired) row.dead_measured++;
    if (short && !fired) row.short_never_fire++;
    if (selfCap) row.self_fire_cap++;
    rows.set(e.entity, row);
  }
  m.by_entity = [...rows.values()].sort((a, b) => b.dead_gate - a.dead_gate || a.entity.localeCompare(b.entity));
  m.over_budget = m.by_entity.filter(overBudgetRow).length;
  return m;
}

// ── routing metrics (variant injected into the router) ─────────────────────

const hook = { rule: null as Variant | null, calls: 0 };
(globalThis as any).__notForVariant = (entry: string, briefLc: string) => {
  hook.calls++;
  return fires(hook.rule!, entryOf(entry), briefViewOf(briefLc));
};

/** router.js compiled in-process with `notForFires` delegating to the hook.
 *  Relative requires resolve against router.js's own directory, so bm25,
 *  registry-loader and paths are the same instances the original uses. */
function compileVariantRouter(): any {
  const src = fs.readFileSync(ROUTER_PATH, "utf8");
  const fn = /function notForFires\(entry, briefLc, briefTokenSet\) \{\n[\s\S]*?\n\}\n/;
  if (!fn.test(src)) throw new Error("notForFires block not found in router.js — the rule moved; update this evaluator");
  const patched = src.replace(fn, "function notForFires(entry, briefLc, briefTokenSet) {\n  return globalThis.__notForVariant(entry, briefLc, briefTokenSet);\n}\n");
  const mod = { exports: {} as any };
  new Function("exports", "require", "module", "__filename", "__dirname", patched)(
    mod.exports, createRequire(ROUTER_PATH), mod, ROUTER_PATH, LIB,
  );
  if (typeof mod.exports.route !== "function") throw new Error("variant router compiled without route()");
  return mod.exports;
}

interface RoutingMetrics {
  n: number; top1: number; top1_count: number; top3: number; mrr: number;
  squad_top1: number; business_top1: number; fabric_top1: number;
  no_match_rate: number; false_dispatch_rate: number; ambiguous_rate: number;
  signals: Record<string, number>; hook_calls: number;
}

function pickRouting(r: Awaited<ReturnType<typeof runEval>>, hookCalls: number): RoutingMetrics {
  const o = r.golden.overall;
  return {
    n: r.golden.total, top1: o.top1, top1_count: Math.round(o.top1 * r.golden.total), top3: o.top3, mrr: o.mrr,
    squad_top1: r.golden.by_kind.squad_capability?.top1 ?? 0,
    business_top1: r.golden.by_kind.business?.top1 ?? 0,
    fabric_top1: r.golden.by_kind.business?.fabric_top1 ?? 0,
    no_match_rate: r.negatives.no_match.no_match_rate,
    false_dispatch_rate: r.negatives.no_match.false_dispatch_rate,
    ambiguous_rate: r.negatives.ambiguous.ambiguous_rate,
    signals: r.golden.signals, hook_calls: hookCalls,
  };
}

const prepared = router.prepareMatchIndex(registries);
let variantRouter: any = null;

async function routingMetrics(v: Variant): Promise<RoutingMetrics> {
  variantRouter ??= compileVariantRouter();
  const original = { route: router.route, prepareMatchIndex: router.prepareMatchIndex };
  hook.rule = v; hook.calls = 0;
  router.route = variantRouter.route;
  router.prepareMatchIndex = () => prepared;
  try {
    const r = await runEval({ quiet: true, registries });
    if (hook.calls === 0) throw new Error("the injected rule was never called — routing numbers would not be the variant's");
    return pickRouting(r, hook.calls);
  } finally {
    router.route = original.route;
    router.prepareMatchIndex = original.prepareMatchIndex;
    hook.rule = null;
  }
}

/** The routing-eval.test.ts floors, for the record. The decision uses the
 *  stricter bar: no regression against the unpatched run. */
const TEST_FLOORS = { top1: 0.965, top3: 0.98, mrr: 0.97, squad_top1: 0.98, business_top1: 0.84, fabric_top1: 0.875, no_match_rate: 0.73 };

function testFloorsKept(r: RoutingMetrics): boolean {
  return r.top1 >= TEST_FLOORS.top1 && r.top3 >= TEST_FLOORS.top3 && r.mrr >= TEST_FLOORS.mrr
    && r.squad_top1 >= TEST_FLOORS.squad_top1 && r.business_top1 >= TEST_FLOORS.business_top1
    && r.fabric_top1 >= TEST_FLOORS.fabric_top1 && r.no_match_rate >= TEST_FLOORS.no_match_rate
    && r.false_dispatch_rate === 0;
}

// ── variants mode ──────────────────────────────────────────────────────────

const pct = (n: number, d: number) => (d ? (100 * n / d).toFixed(1) + "%" : "n/a");

async function runVariants() {
  const selected = VARIANTS.filter((v) => !onlyVariants || onlyVariants.has(v.name) || v.name === "baseline");
  console.error(`[not-for-experiment] ${entries.length} entries · ${briefs.length} briefs · ${selected.length} variants · routing ${withRouting ? "on" : "off"}`);

  let reference: RoutingMetrics | null = null;
  if (withRouting) {
    const t = Date.now();
    reference = pickRouting(await runEval({ quiet: true, registries }), 0);
    console.error(`[not-for-experiment] reference (unpatched) routing eval: top-1 ${pct(reference.top1_count, reference.n)} · MRR ${reference.mrr.toFixed(4)} · ${((Date.now() - t) / 1000).toFixed(1)}s`);
  }

  const base = corpusMetrics(VARIANTS[0]);
  const results: any[] = [];
  for (const v of selected) {
    const t = Date.now();
    const corpus = v.name === "baseline" ? base : corpusMetrics(v);
    let routing: RoutingMetrics | null = null;
    if (withRouting) {
      routing = await routingMetrics(v);
      if (v.name === "baseline" && reference) {
        const same = routing.top1_count === reference.top1_count && Math.abs(routing.mrr - reference.mrr) < 1e-9
          && routing.false_dispatch_rate === reference.false_dispatch_rate && routing.no_match_rate === reference.no_match_rate;
        if (!same) throw new Error(`injection check failed: baseline through the hook (${routing.top1_count}, ${routing.mrr}) differs from the unpatched run (${reference.top1_count}, ${reference.mrr})`);
        console.error(`[not-for-experiment] injection check passed: baseline through the hook reproduces the unpatched eval (${routing.hook_calls} rule calls)`);
      }
    }
    const floorsKept = routing && reference
      ? routing.top1_count >= reference.top1_count && routing.mrr >= reference.mrr - 1e-9 && routing.false_dispatch_rate === 0
      : null;
    const wins = floorsKept === true
      && corpus.self_fire_cap <= base.self_fire_cap && corpus.self_fire_entity <= base.self_fire_entity
      && corpus.live_measured > base.live_measured && corpus.live_gate >= base.live_gate;
    results.push({
      name: v.name, description: v.description, short_max_chars: v.shortMax,
      corpus: { ...corpus, by_entity: undefined }, routing,
      floors_kept: floorsKept, test_floors_kept: routing ? testFloorsKept(routing) : null, wins,
    });
    console.error(`[not-for-experiment] ${v.name.padEnd(22)} live ${pct(corpus.live_measured, corpus.entries)} (gate ${pct(corpus.live_gate, corpus.entries)}) · self-fire cap ${corpus.self_fire_cap} ent ${corpus.self_fire_entity} · cross ${corpus.cross_fire}`
      + (routing ? ` · top-1 ${pct(routing.top1_count, routing.n)} MRR ${routing.mrr.toFixed(4)} fd ${routing.false_dispatch_rate}` : "")
      + ` · ${((Date.now() - t) / 1000).toFixed(1)}s`);
  }

  const out = {
    generated_at: new Date().toISOString(),
    corpus: { entries: entries.length, briefs: briefs.length, entities: new Set(entries.map((e) => e.entity)).size },
    decision_rule: "floors kept (top-1 count, MRR, false-dispatch = 0 against the unpatched run) AND self-fire (capability and entity) not worse AND more live fences (measured), with the gate's live count not lower",
    test_floors: TEST_FLOORS,
    reference_routing: reference,
    baseline_by_entity: base.by_entity,
    variants: results,
  };
  if (jsonOut) { fs.mkdirSync(path.dirname(jsonOut), { recursive: true }); fs.writeFileSync(jsonOut, JSON.stringify(out, null, 2) + "\n"); }

  console.log("");
  console.log(`${"variant".padEnd(22)} ${"live".padStart(7)} ${"gate".padStart(7)} ${"selfcap".padStart(7)} ${"selfent".padStart(7)} ${"cross".padStart(6)} ${"top-1".padStart(7)} ${"MRR".padStart(7)} ${"fd".padStart(5)} ${"win".padStart(4)}`);
  for (const r of results) {
    const c = r.corpus, g = r.routing;
    console.log(`${r.name.padEnd(22)} ${pct(c.live_measured, c.entries).padStart(7)} ${pct(c.live_gate, c.entries).padStart(7)} ${String(c.self_fire_cap).padStart(7)} ${String(c.self_fire_entity).padStart(7)} ${String(c.cross_fire).padStart(6)} ${(g ? pct(g.top1_count, g.n) : "-").padStart(7)} ${(g ? g.mrr.toFixed(4) : "-").padStart(7)} ${(g ? String(g.false_dispatch_rate) : "-").padStart(5)} ${(r.wins ? "yes" : "no").padStart(4)}`);
  }
  const winners = results.filter((r) => r.wins).map((r) => r.name);
  console.log(`\nwinners under the decision rule: ${winners.length ? winners.join(", ") : "none"}`);
}

// ── proposals mode ─────────────────────────────────────────────────────────

/** Entity name → packs under ~/nirvana-packs that ship it (by manifest name). */
function packOrigins(): Map<string, string[]> {
  const root = path.join(homedir(), "nirvana-packs");
  const packs: Array<[string, string]> = [];
  if (fs.existsSync(path.join(root, "genesis-content"))) packs.push(["genesis-circle", path.join(root, "genesis-content")]);
  const contentRoot = path.join(root, "packs-content");
  if (fs.existsSync(contentRoot)) {
    for (const d of fs.readdirSync(contentRoot)) {
      const full = path.join(contentRoot, d);
      if (!d.startsWith("_") && fs.statSync(full).isDirectory()) packs.push([d, full]);
    }
  }
  const origins = new Map<string, string[]>();
  for (const [label, dir] of packs) {
    for (const [kind, manifest] of [["squads", "squad.yaml"], ["businesses", "business.yaml"]] as const) {
      const kindDir = path.join(dir, kind);
      if (!fs.existsSync(kindDir)) continue;
      for (const slug of fs.readdirSync(kindDir)) {
        const f = path.join(kindDir, slug, manifest);
        if (!fs.existsSync(f)) continue;
        const m = fs.readFileSync(f, "utf8").match(/^name:\s*["']?([^"'\n]+?)["']?\s*$/m);
        const name = m ? m[1].trim() : slug;
        (origins.get(name) ?? origins.set(name, []).get(name)!).push(label);
      }
    }
  }
  return origins;
}

const stopMemo = new Map<string, boolean>();
/** A surface word the tokenizer would drop (stopword or single char). */
function isStop(word: string): boolean {
  let s = stopMemo.get(word);
  if (s === undefined) { s = bm25.tokenize(word).length === 0; stopMemo.set(word, s); }
  return s;
}

const SURFACE_SPLIT = /[^\p{L}\p{N}]+/u;
const FENCE_MAX_CHARS = 25;

/** Candidate short fences a brief offers: 1-3 word surface phrases, accents
 *  kept (the substring path compares raw lowercase text), no stopword at
 *  either end, template placeholders removed, <=25 chars. */
function surfaceCandidates(lc: string): Set<string> {
  const words = lc.replace(/\{\{[^}]*\}\}/g, " ").split(SURFACE_SPLIT).filter(Boolean);
  const out = new Set<string>();
  for (let n = 1; n <= 3; n++) {
    for (let i = 0; i + n <= words.length; i++) {
      const gram = words.slice(i, i + n);
      if (isStop(gram[0]) || isStop(gram[n - 1])) continue;
      const phrase = gram.join(" ");
      if (phrase.length < 4 || phrase.length > FENCE_MAX_CHARS || /^\d+$/.test(phrase)) continue;
      out.add(phrase);
    }
  }
  return out;
}

const count = (phrase: string, list: Brief[]) => list.reduce((n, b) => n + (b.lc.includes(phrase) ? 1 : 0), 0);

interface Suggestion { fence: string; chars: number; declared_vocabulary: boolean; hits_neighbour: number; hits_intruded: number; hits_own: number; hits_corpus: number }
interface Boundary {
  neighbour: string;
  neighbour_capabilities: string[];
  intruding_capabilities: string[];
  source: "measured" | "declared" | "both";
  briefs_intruded: number;
  runner_up: number;
  suggested: Suggestion[];
}

/** A phrase too common across the library to be a boundary of anything. */
const GENERIC_MAX_CORPUS_HITS = 40;
const MIN_SPECIFICITY = 0.4;

function proposals() {
  const base = corpusMetrics(VARIANTS[0]);
  const overBudget = base.by_entity.filter(overBudgetRow);
  const target = new Set(overBudget.map((r) => r.entity));
  const origins = packOrigins();
  const manifests: Record<string, any> = registries?.squads?.squads ?? {};

  const briefsOfEntity = new Map<string, Brief[]>();
  const briefsOfCap = new Map<string, Brief[]>();
  for (const b of briefs) {
    (briefsOfEntity.get(b.entity) ?? briefsOfEntity.set(b.entity, []).get(b.entity)!).push(b);
    const k = `${b.entity}::${b.capId}`;
    (briefsOfCap.get(k) ?? briefsOfCap.set(k, []).get(k)!).push(b);
  }
  // The vocabulary a capability declares for retrieval (keywords, description,
  // examples): a candidate built from it is domain language, not incidental
  // phrasing of one brief.
  const declaredVocab = new Map<string, Set<string>>();
  for (const [capId, list] of Object.entries(caps)) {
    for (const c of list) {
      const entity: string | undefined = c.squad ?? c.business;
      if (!entity) continue;
      const text = [c.description ?? "", ...(c.keywords ?? []), ...(c.examples ?? []), ...(c.domains ?? [])].join(" ");
      declaredVocab.set(`${entity}::${capId}`, new Set(bm25.tokenize(text)));
    }
  }
  const inDeclared = (phrase: string, capKeys: string[]) => {
    const toks: string[] = bm25.tokenize(phrase);
    return toks.length > 0 && capKeys.some((k) => { const v = declaredVocab.get(k); return !!v && toks.every((t) => v.has(t)); });
  };

  // Measured boundaries: for every brief, the capability docs of a target
  // entity that rank in the top 5 for a brief someone else owns. Raw BM25,
  // metadata docs only — the ranking a fence acts on. The owner ranks first by
  // construction (its example_briefs are indexed), so the signal is presence
  // next to it, and `runner_up` counts the briefs where the entity sits
  // immediately behind the owner — the doc that wins once the brief is
  // paraphrased. A boundary is keyed per neighbour entity, except between
  // capabilities of the same entity, where it is keyed per target capability
  // so the own and neighbour brief sets never coincide.
  interface Bound { entity: string; neighbour: string; capsA: Set<string>; capsB: Set<string>; intruded: Brief[]; runnerUp: number; declared: boolean }
  const bounds = new Map<string, Bound>();
  const bound = (entity: string, capA: string, neighbour: string, capB: string): Bound => {
    const k = entity === neighbour ? `${entity}=>${neighbour}::${capB}` : `${entity}=>${neighbour}`;
    return bounds.get(k) ?? bounds.set(k, { entity, neighbour, capsA: new Set(), capsB: new Set(), intruded: [], runnerUp: 0, declared: false }).get(k)!;
  };
  for (const b of briefs) {
    const ranked = bm25.query(prepared.index, b.text, { topK: 12 })
      .filter((r: any) => r.doc.meta.type === "squad_capability" && !r.doc.meta.via_body)
      .slice(0, 5);
    const ownerRank = ranked.findIndex((r: any) => r.doc.meta.squad === b.entity && r.doc.meta.capability_id === b.capId);
    ranked.forEach((r: any, rank: number) => {
      const E = r.doc.meta.squad, capA = r.doc.meta.capability_id;
      if (!target.has(E) || (E === b.entity && capA === b.capId)) return;
      const x = bound(E, capA, b.entity, b.capId);
      x.capsA.add(capA); x.capsB.add(b.capId); x.intruded.push(b);
      if (rank === ownerRank + 1) x.runnerUp++;
    });
  }
  // Declared boundaries: the "(use x.y.z)" redirects inside the entries.
  const entriesByEntity = new Map<string, Entry[]>();
  for (const e of entries) (entriesByEntity.get(e.entity) ?? entriesByEntity.set(e.entity, []).get(e.entity)!).push(e);
  for (const entity of target) {
    for (const e of entriesByEntity.get(entity) ?? []) {
      for (const m of e.text.matchAll(/\b(?:use|usar|prefira|see)\s+([a-z0-9_]+(?:\.[a-z0-9_]+){2,})/gi)) {
        for (const provider of caps[m[1]] ?? []) {
          const F: string | undefined = provider.squad ?? provider.business;
          if (!F || (F === entity && m[1] === e.capId)) continue;
          const x = bound(entity, e.capId, F, m[1]);
          x.declared = true; x.capsA.add(e.capId); x.capsB.add(m[1]);
        }
      }
    }
  }

  const out: Record<string, any> = {};
  for (const row of overBudget) {
    const E = row.entity;
    const ownAll = briefsOfEntity.get(E) ?? [];
    const dead = (entriesByEntity.get(E) ?? []).filter((e) => !(e.len <= 25 ? e.len > 2 : briefs.some((b) => fires(VARIANTS[0], e, b))));
    const boundaries: Boundary[] = [];
    const mine = [...bounds.values()].filter((x) => x.entity === E)
      .sort((a, b) => Number(b.declared) - Number(a.declared) || b.runnerUp - a.runnerUp || b.intruded.length - a.intruded.length);
    for (const x of mine) {
      if (!x.declared && x.intruded.length < 2) continue;
      const sibling = x.neighbour === E;
      const neighbourKeys = [...x.capsB].map((c) => `${x.neighbour}::${c}`);
      const neighbourBriefs = sibling
        ? neighbourKeys.flatMap((k) => briefsOfCap.get(k) ?? [])
        : (briefsOfEntity.get(x.neighbour) ?? []);
      const own = sibling ? [...x.capsA].flatMap((c) => briefsOfCap.get(`${E}::${c}`) ?? []) : ownAll;
      const candidates = new Set<string>();
      for (const b of neighbourBriefs) for (const c of surfaceCandidates(b.lc)) candidates.add(c);
      const scored: Suggestion[] = [];
      for (const c of candidates) {
        if (count(c, own) > 0) continue;
        const hitsNeighbour = count(c, neighbourBriefs);
        if (hitsNeighbour < Math.min(2, neighbourBriefs.length)) continue;
        const hitsCorpus = count(c, briefs);
        if (hitsCorpus > GENERIC_MAX_CORPUS_HITS || hitsNeighbour / hitsCorpus < MIN_SPECIFICITY) continue;
        scored.push({
          fence: c, chars: c.length, declared_vocabulary: inDeclared(c, neighbourKeys),
          hits_neighbour: hitsNeighbour, hits_intruded: count(c, x.intruded), hits_own: 0, hits_corpus: hitsCorpus,
        });
      }
      scored.sort((a, b) => Number(b.declared_vocabulary) - Number(a.declared_vocabulary)
        || b.hits_intruded - a.hits_intruded
        || (b.hits_neighbour / b.hits_corpus) - (a.hits_neighbour / a.hits_corpus)
        || b.hits_neighbour - a.hits_neighbour || a.chars - b.chars);
      const picked: Suggestion[] = [];
      for (const s of scored) {
        if (picked.some((p) => p.fence.includes(s.fence) || s.fence.includes(p.fence))) continue;
        picked.push(s);
        if (picked.length === 4) break;
      }
      boundaries.push({
        neighbour: x.neighbour, neighbour_capabilities: [...x.capsB].sort(), intruding_capabilities: [...x.capsA].sort(),
        source: x.declared && x.intruded.length ? "both" : x.declared ? "declared" : "measured",
        briefs_intruded: x.intruded.length, runner_up: x.runnerUp, suggested: picked,
      });
      if (boundaries.length === 8) break;
    }
    const manifestPath: string | undefined = manifests[E]?.manifest_path;
    out[E] = {
      origin: { packs: origins.get(E) ?? [], live_manifest: manifestPath ?? null, standalone: !(origins.get(E)?.length) },
      total: row.total, dead: row.dead_gate, self_fire_cap: row.self_fire_cap,
      own_briefs: ownAll.length,
      dead_entries: dead.map((e) => e.text),
      boundaries,
    };
  }

  const result = {
    generated_at: new Date().toISOString(),
    rule: "router.js today: substring <=25 chars, else >=2 content tokens and >=60% token overlap; dead = fires on no example_brief in the library",
    corpus: { entries: entries.length, briefs: briefs.length, entities_over_budget: overBudget.length },
    how_to_read: "boundaries: 'measured' = a capability of the entity ranked top-5 (raw BM25, metadata docs) for a brief the neighbour owns, 'runner_up' = how many of those briefs had it immediately behind the owner; 'declared' = an entry redirects to the neighbour's capability. Suggested fences occur in the neighbour's briefs and in none of the entity's own (the fenced capability's own, for a sibling boundary), so they cannot self-fire on this corpus; 'declared_vocabulary' = every token of the phrase is in the neighbour capability's keywords/description/examples",
    entities: out,
  };
  if (jsonOut) { fs.mkdirSync(path.dirname(jsonOut), { recursive: true }); fs.writeFileSync(jsonOut, JSON.stringify(result, null, 2) + "\n"); }
  for (const [E, r] of Object.entries(out)) {
    console.log(`${E} — ${r.dead}/${r.total} dead · origin ${r.origin.packs.join(",") || "standalone"} · ${r.boundaries.length} boundaries`);
    for (const b of r.boundaries) {
      const to = b.neighbour === E ? `${E}::${b.neighbour_capabilities.join("|")}` : b.neighbour;
      console.log(`  -> ${to} [${b.source}] intruded ${b.briefs_intruded} runner-up ${b.runner_up}: ${b.suggested.map((s: Suggestion) => `"${s.fence}"${s.declared_vocabulary ? "*" : ""}(${s.hits_neighbour}/${s.hits_corpus})`).join(" ") || "(no clean candidate)"}`);
    }
  }
}

if (mode === "variants") await runVariants();
else if (mode === "proposals") proposals();
else { console.error(`unknown mode "${mode}" — use variants | proposals`); process.exit(2); }
