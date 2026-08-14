#!/usr/bin/env bun
/**
 * measure-language-parity.ts — does the language of a brief decide whether
 * routing finds the right target?
 *
 * The corpus answers with its own data. Every capability declares
 * `example_briefs`, and each of those has a known correct destination: the
 * capability that declares it. So "does this brief find its way home" is a
 * question the library can be asked about itself, thousands of times, with no
 * hand-authored fixture and no translation step.
 *
 * Split that answer by the brief's language and you get the number this whole
 * phase turns on. If English briefs come home at one rate and Portuguese ones at
 * another, language is a barrier — and the gap is how big.
 *
 * Usage:
 *   bun measure-language-parity.ts                 # sample 400, both arms
 *   bun measure-language-parity.ts --all           # every brief (slow)
 *   bun measure-language-parity.ts --n 100
 *   bun measure-language-parity.ts --json
 *
 * Deterministic: the sample is strided, never random, so two runs on the same
 * corpus compare directly.
 */
import { parseArgs } from "../../_shared/lib/bun-helpers.ts";

const { flags } = parseArgs(process.argv.slice(2), {
  boolean: ["all", "json", "quiet"],
  string: ["n"],
});
const SAMPLE = flags.all ? Infinity : Number(flags.n ?? 400);
const asJson = !!flags.json;

const RED = "\x1b[31m", GRN = "\x1b[32m", YEL = "\x1b[33m", DIM = "\x1b[2m", BOLD = "\x1b[1m", RST = "\x1b[0m";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const router = require("../lib/router.js");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const registryLoader = require("../lib/registry-loader.js");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { resolveDestination } = router;

/**
 * Language of a brief, by stopword vote.
 *
 * Crude on purpose: it only has to separate the two halves the corpus actually
 * has, and a wrong call on a handful of briefs moves a percentage point, not a
 * conclusion. Anything it cannot place lands in "other" and is reported apart
 * rather than folded into either side.
 */
const PT = /\b(para|com|uma|dos|das|não|criar|fazer|sobre|meu|minha|nossa|nosso|que|quero|preciso|empresa|conteúdo|vendas)\b/i;
const EN = /\b(the|for|with|and|create|build|make|write|our|my|need|want|about|from|into|report|content|sales)\b/i;
function languageOf(brief: string): "pt" | "en" | "other" {
  const pt = (brief.match(PT) || []).length;
  const en = (brief.match(EN) || []).length;
  if (pt > en) return "pt";
  if (en > pt) return "en";
  return "other";
}

interface Probe { brief: string; expected: string; lang: "pt" | "en" | "other"; }

function collectProbes(registries: Record<string, any>): Probe[] {
  // `capabilities` is keyed by capability id; each entry lists the providers
  // that declare it, and a provider names its `squad`. That squad is the
  // destination the brief should reach, so it is the ground truth here.
  const out: Probe[] = [];
  const caps = registries.squads?.capabilities ?? {};
  for (const list of Object.values(caps)) {
    for (const cap of (Array.isArray(list) ? list : []) as Array<Record<string, unknown>>) {
      const owner = (cap.squad ?? cap.business) as string | undefined;
      if (!owner) continue;
      for (const b of ((cap.example_briefs as string[]) ?? [])) {
        if (typeof b === "string" && b.trim().length > 12) {
          out.push({ brief: b.trim(), expected: owner, lang: languageOf(b) });
        }
      }
    }
  }
  return out;
}

/** Strided sample: deterministic, and spread across the whole corpus. */
function sample<T>(items: T[], n: number): T[] {
  if (!Number.isFinite(n) || items.length <= n) return items;
  const step = items.length / n;
  return Array.from({ length: n }, (_, i) => items[Math.floor(i * step)]);
}

interface Tally { total: number; top1: number; anySignal: number; noMatch: number; }
const blank = (): Tally => ({ total: 0, top1: 0, anySignal: 0, noMatch: 0 });

const all = registryLoader.loadAll();
const probes = sample(collectProbes(all), SAMPLE);
if (probes.length === 0) {
  console.error(`${RED}No example_briefs in the live registries — nothing to measure.${RST}`);
  console.error(`${DIM}This needs an installed content library. Run 'nrv index' first.${RST}`);
  process.exit(2);
}

const byLang: Record<string, Tally> = { pt: blank(), en: blank(), other: blank() };
const misses: Array<{ brief: string; lang: string; expected: string; got: string | null }> = [];

for (const p of probes) {
  const t = byLang[p.lang];
  t.total++;
  let r: Record<string, any>;
  try {
    r = await router.route(p.brief, { registries: all, amplify: false });
  } catch {
    continue;
  }
  // stage3.target is the decision: `{id: "squad_capability:<squad>:<cap>"}` or
  // `{id: "business:<slug>"}`. resolveDestination collapses either to the slug
  // a dispatch would actually go to.
  const s3 = r.stage3 ?? {};
  const top = s3.target ? resolveDestination(s3.target) : null;
  if (s3.signal === "NO_MATCH") t.noMatch++;
  else t.anySignal++;
  if (top === p.expected) t.top1++;
  else if (misses.length < 12) misses.push({ brief: p.brief.slice(0, 64), lang: p.lang, expected: p.expected, got: top });
}

const pct = (a: number, b: number) => (b === 0 ? 0 : (100 * a) / b);
const result = {
  probes: probes.length,
  by_language: Object.fromEntries(Object.entries(byLang).map(([k, t]) => [k, {
    briefs: t.total,
    self_retrieval_top1: Number(pct(t.top1, t.total).toFixed(1)),
    no_match: Number(pct(t.noMatch, t.total).toFixed(1)),
  }])),
  gap_pt_vs_en: Number((pct(byLang.en.top1, byLang.en.total) - pct(byLang.pt.top1, byLang.pt.total)).toFixed(1)),
};

if (asJson) {
  console.log(JSON.stringify({ ...result, misses }, null, 2));
  process.exit(0);
}

console.log(`\n${BOLD}LANGUAGE PARITY — does a brief come home?${RST}`);
console.log(`${DIM}  ${probes.length} example_briefs from the live corpus, each routed against its own declared owner.${RST}\n`);
console.log(`  ${"language".padEnd(10)} ${"briefs".padStart(7)} ${"finds its owner".padStart(16)} ${"no match".padStart(10)}`);
for (const [lang, t] of Object.entries(byLang)) {
  if (t.total === 0) continue;
  const p = pct(t.top1, t.total);
  const color = p >= 80 ? GRN : p >= 55 ? YEL : RED;
  console.log(`  ${lang.padEnd(10)} ${String(t.total).padStart(7)} ${color}${p.toFixed(1).padStart(15)}%${RST} ${pct(t.noMatch, t.total).toFixed(1).padStart(9)}%`);
}
const gap = result.gap_pt_vs_en;
console.log(`\n  ${BOLD}gap EN − PT: ${gap > 0 ? "+" : ""}${gap} points${RST}`);
console.log(`${DIM}  A gap near zero means language is not deciding the outcome. Anything else is the`);
console.log(`  cost of a lexical index over a corpus that speaks two languages.${RST}`);

if (misses.length) {
  console.log(`\n${DIM}  first misses:${RST}`);
  for (const m of misses.slice(0, 6)) {
    console.log(`${DIM}    [${m.lang}] "${m.brief}…"${RST}`);
    console.log(`${DIM}         wanted ${m.expected}, got ${m.got ?? "nothing"}${RST}`);
  }
}
console.log();
