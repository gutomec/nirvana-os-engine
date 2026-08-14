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
  boolean: ["all", "json", "quiet", "parity", "safety"],
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

/**
 * --parity: the measurement that actually says something.
 *
 * Self-retrieval routes a brief that IS the index (example_briefs are indexed at
 * ×2 weight), so it lands near 100% in any language and proves only that BM25
 * works. The paired probes in baselines/golden-parity.json are paraphrases held
 * out of every manifest: same intent, two languages, wording that appears
 * nowhere in the corpus. The contract is agreement — both members must reach the
 * same destination — because which destination is right is a corpus question,
 * and whether the answer depends on the user's language is an engine question.
 */
/**
 * --safety: parity and abstention in one view.
 *
 * Any change aimed at cross-language routing has two ways to look good and be
 * wrong. It can raise parity by dispatching more confidently on briefs that
 * should ask first, and it can protect the negatives by retrieving nothing at
 * all. Reporting both together is what makes an improvement legible as one.
 */
if (flags.safety) {
  const parityFile = new URL("../baselines/golden-parity.json", import.meta.url).pathname;
  const negFile = new URL("../baselines/golden-negatives.json", import.meta.url).pathname;
  const { pairs } = JSON.parse(await Bun.file(parityFile).text()) as { pairs: Array<{ id: string; pt: string; en: string }> };
  const negRaw = JSON.parse(await Bun.file(negFile).text()) as Record<string, any>;
  const negatives: string[] = (negRaw.cases ?? negRaw.negatives ?? []).map((n: any) => n.brief ?? n).filter((b: unknown) => typeof b === "string");

  const landed = async (brief: string, floor: number): Promise<{ dest: string | null; signal: string }> => {
    try {
      const r = await router.route(brief, { registries: all, amplify: false });
      const s3 = r.stage3 ?? {};
      const alts = (s3.alternatives ?? []) as Array<Record<string, unknown>>;
      const dest = s3.target ? resolveDestination(s3.target) : alts.length ? resolveDestination(alts[0]) : null;
      return { dest, signal: String(s3.signal) };
    } catch { return { dest: null, signal: "ERROR" }; }
  };

  console.log(`\n${BOLD}DENSE FLOOR SWEEP${RST}`);
  console.log(`${DIM}  ${pairs.length} paraphrase pairs · ${negatives.length} out-of-domain negatives${RST}\n`);
  console.log(`  ${"arm".padStart(6)} ${"parity".padStart(8)} ${"negatives that went HIGH".padStart(26)}`);
  for (const floor of [1.01]) { // one row today: there is no arm to sweep
    let agree = 0;
    for (const p of pairs) {
      const [a, b] = [await landed(p.pt, floor), await landed(p.en, floor)];
      if (a.dest && a.dest === b.dest) agree++;
    }
    let broke = 0;
    for (const n of negatives) if ((await landed(n, floor)).signal === "HIGH") broke++;
    const pp = (100 * agree) / pairs.length;
    const label = floor > 1 ? "  off" : floor.toFixed(2);
    const c = broke > 0 ? RED : pp >= 50 ? GRN : YEL;
    console.log(`  ${label.padStart(6)} ${c}${pp.toFixed(0).padStart(7)}%${RST} ${String(broke).padStart(25)}`);
  }
  console.log(`\n${DIM}  A change is only an improvement when parity rises and the negatives column does not.${RST}\n`);
  process.exit(0);
}

if (flags.parity) {
  const file = new URL("../baselines/golden-parity.json", import.meta.url).pathname;
  const { pairs } = JSON.parse(await Bun.file(file).text()) as {
    pairs: Array<{ id: string; pt: string; en: string }>;
  };
  const rows: Array<{ id: string; pt: string | null; en: string | null; agree: boolean; bothEmpty: boolean }> = [];
  for (const p of pairs) {
    // Where the brief LANDS, which is not the same as what it dispatches to.
    // An AMBIGUOUS result has no `target` — it asks the user to confirm — but it
    // has ranked candidates, and the first one is where the brief arrived. The
    // first cut of this script read `target` alone and scored every ambiguity as
    // "found nothing", which made a router that was working look like one that
    // was not.
    const dest = async (brief: string): Promise<string | null> => {
      try {
        const r = await router.route(brief, { registries: all, amplify: false });
        const s3 = r.stage3 ?? {};
        if (s3.target) return resolveDestination(s3.target);
        const alts = (s3.alternatives ?? []) as Array<Record<string, unknown>>;
        return alts.length ? resolveDestination(alts[0]) : null;
      } catch { return null; }
    };
    const [ptDest, enDest] = [await dest(p.pt), await dest(p.en)];
    rows.push({ id: p.id, pt: ptDest, en: enDest, agree: ptDest === enDest, bothEmpty: !ptDest && !enDest });
  }
  const agreed = rows.filter((r) => r.agree).length;
  const hollow = rows.filter((r) => r.agree && r.bothEmpty).length;
  const out = {
    pairs: rows.length,
    agreed,
    agreed_with_a_destination: agreed - hollow,
    agreed_by_both_finding_nothing: hollow,
    parity_pct: Number(((100 * (agreed - hollow)) / rows.length).toFixed(1)),
    rows,
  };
  if (asJson) { console.log(JSON.stringify(out, null, 2)); process.exit(0); }
  console.log(`\n${BOLD}CROSS-LANGUAGE PARITY — same intent, two languages${RST}`);
  console.log(`${DIM}  ${rows.length} paraphrase pairs, held out of the index.${RST}\n`);
  for (const r of rows) {
    const mark = r.bothEmpty ? `${YEL}—${RST}` : r.agree ? `${GRN}=${RST}` : `${RED}≠${RST}`;
    console.log(`  ${mark} ${r.id.padEnd(18)} pt→${(r.pt ?? "nothing").padEnd(30)} en→${r.en ?? "nothing"}`);
  }
  const color = out.parity_pct >= 80 ? GRN : out.parity_pct >= 50 ? YEL : RED;
  console.log(`\n  ${BOLD}parity: ${color}${out.parity_pct}%${RST}${BOLD} (${out.agreed_with_a_destination}/${rows.length} landed on the same place)${RST}`);
  if (hollow) console.log(`${DIM}  ${hollow} more agreed by both finding nothing, which is agreement without value.${RST}`);
  console.log();
  process.exit(0);
}

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
