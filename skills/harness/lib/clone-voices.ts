// clone-voices.ts — which mind-clones a run is offered, one rule for every path.
//
// A business worker (business-solo.ts) and a squad (squad-exec.ts) used to pick
// voices by different rules: one matched names anywhere in the brief, the other
// capped at two and searched with a different query. The owner's rule, in one
// place:
//
//   1. A clone counts as ASKED FOR only when the brief's "Request (verbatim)"
//      section names the person (clone-names.ts: a full name, a nickname, or a
//      surname after a voice cue), or when a line marks it as `clone <slug>`.
//      A brief that lists clones as facts about a product ("the pack ships
//      Saul Bass and Paula Scher") in another section asks for none.
//   2. Asked for and installed: offered, one slug per person, at most `limit`;
//      an ask past the limit is reported, never dropped in silence.
//   3. Asked for and absent, or a name two people share: reported in
//      `missing` / `ambiguous`, and the search does not stand in for it.
//   4. Nothing asked for: the clones the router suggested (`suggested`), when
//      it suggested any, checked against the library.
//   5. Neither: the library is searched on the part this run delivers and on
//      what the business or squad does (`extraQuery`), one slug per person, and
//      at most `limit` clones above the coverage gate are offered. Nothing above
//      the gate means no clone.

import { parseWorkBrief } from "./work-brief.ts";
import { buildPeople, personOf, scanNames, type Person } from "./clone-names.ts";
import type { CloneHit } from "../../_shared/lib/clone-search.ts";

export interface PickedVoice { slug: string; name: string; why: string }

export interface VoiceSelection {
  voices: PickedVoice[];
  /** Asked for by the brief and absent from the library, or without files on disk. */
  missing: string[];
  /** Names more than one person carries: the request has to say which. */
  ambiguous: Array<{ name: string; candidates: string[] }>;
  /** Asked for, installed, and left out because the run was already at `limit`. */
  overflow: string[];
  how: "asked" | "suggested" | "rerank" | "search" | "none";
}

/**
 * A classifier's pick among the voice candidates (the Jev, jev-voice.ts, when a
 * TypeSafe key is configured). `ok: false` means it could not answer, and the
 * lexical search decides; `ok: true` with no slug means no voice fits.
 */
export type VoiceRerank = (candidates: string[], request: string) => { ok: boolean; slug: string | null; confidence?: number; error?: string };

export interface VoiceSelectionInput {
  brief: string;
  names: Array<{ slug: string; name: string }>;
  /** True when the clone's files can be opened on this machine. */
  installed: (slug: string) => boolean;
  /** The library search: `query` ranks, `gateQuery` (the run's own words) is what coverage counts against. */
  search: (query: string, gateQuery?: string) => CloneHit[];
  /** Clones the run already carries (a seat's own): never offered twice. */
  taken?: Iterable<string>;
  /** Extra text for the search: what the business or squad does, or the sub-task it runs. */
  extraQuery?: string;
  /** Clones the router chose for this request (already validated by it; checked again here). */
  suggested?: string[];
  /** Between the router's suggestion and the lexical search: a classifier picks among the candidates. */
  rerank?: VoiceRerank;
  /** Candidates for the rerank beyond the search's (a business's seat voices). */
  rerankCandidates?: string[];
  limit?: number;
}

/** How many of the search's hits the rerank sees, before the extra candidates. */
export const RERANK_SEARCH_CANDIDATES = 8;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** What the search runs on: this run's part when the brief names one (the
 *  request also holds what other businesses deliver), plus what the business or
 *  squad does. The request itself only when the brief has no part. */
export function voiceQuery(brief: string, extra = ""): string {
  const s = parseWorkBrief(brief).sections;
  const part = (s["Your part"] ?? "").trim();
  const request = s["Request (verbatim)"] ?? "";
  // A part of a few words ("O roteiro.", "O plano da mudança.") says too little
  // to search on: one generic word carried clones over the gate. Then the
  // request joins it.
  const informative = (part.match(/\p{L}{4,}/gu) ?? []).length >= 6;
  const own = informative ? part : [request, part].filter(Boolean).join("\n");
  return [own, extra].filter(Boolean).join("\n") || brief;
}

/** Slugs a line marks as `clone <slug>` that the library does not know: a
 *  whole line (`- clone some-expert`), or a slug in backticks. A bare word after
 *  "clone" in prose ("clone the repo") is not a mark. */
function unknownMarked(brief: string, known: Set<string>): string[] {
  const out: string[] = [];
  const re = /^[ \t]*(?:[-*][ \t]+)?clones?[ \t:=]+(`?)([a-z0-9]+(?:-[a-z0-9]+)*)\1[ \t]*$/gim;
  for (let m = re.exec(brief); m; m = re.exec(brief)) {
    const slug = m[2].toLowerCase();
    if ((m[1] || slug.includes("-")) && !known.has(slug)) out.push(slug);
  }
  return out;
}

/**
 * A voice nobody asked for has to earn its place: at least three of the run's
 * own terms, and a third of them, in what the clone declares it does. The shared
 * gate (bm25.coverageBelowGate) lets three matches through whatever the length,
 * and on short parts one or two: measured 2026-10-13, 4 of 8 out-of-domain
 * requests were offered a clone ("pneu aro 15" got a game designer).
 */
export function voiceGate(h: Pick<CloneHit, "coverage">): boolean {
  const { matched, total } = h.coverage ?? { matched: null, total: 0 };
  if (typeof matched !== "number" || !total) return false;
  return matched >= 3 && matched / total >= 1 / 3;
}

let peopleCache: { names: Array<{ slug: string; name: string }>; people: Person[] } | null = null;
function peopleFor(names: Array<{ slug: string; name: string }>): Person[] {
  if (peopleCache?.names !== names) peopleCache = { names, people: buildPeople(names) };
  return peopleCache.people;
}

export function selectVoices(input: VoiceSelectionInput): VoiceSelection {
  const limit = input.limit ?? 3;
  const taken = new Set(input.taken ?? []);
  const voices: PickedVoice[] = [];
  const missing: string[] = [];
  const overflow: string[] = [];
  const known = new Set(input.names.map((c) => c.slug));
  const people = peopleFor(input.names);
  const nameOf = new Map(input.names.map((c) => [c.slug, c.name]));
  // A person counts once, whichever of their slugs a seat or an earlier pick took.
  const takenPeople = new Set([...taken].map((s) => personOf(people, s)?.key ?? s));
  const take = (slug: string, why: string, displayName?: string): boolean => {
    const who = personOf(people, slug)?.key ?? slug;
    if (taken.has(slug) || takenPeople.has(who)) return false;
    if (voices.length >= limit) { overflow.push(slug); return false; }
    taken.add(slug); takenPeople.add(who);
    voices.push({ slug, name: displayName ?? nameOf.get(slug) ?? slug, why });
    return true;
  };

  const sections = parseWorkBrief(input.brief).sections;
  const request = sections["Request (verbatim)"] ?? input.brief;
  const scan = scanNames(request, people);
  // `clone <slug>` lines count wherever the orchestrator wrote them (Decisions).
  const marked = input.names.filter((c) =>
    new RegExp(`(^|[^a-z0-9_-])clones?[\\s:=]+\`?${escapeRe(c.slug)}\`?($|[^a-z0-9_-])`, "i").test(input.brief));
  // A slug written as such is that clone; a person named is any of their slugs
  // that is installed, the canonical one first.
  const asked: string[][] = [
    ...marked.map((c) => [c.slug]),
    ...scan.matches.map((m) => {
      const p = people.find((q) => q.key === m.person);
      return m.via === "slug" || !p ? [m.slug] : [m.slug, ...p.slugs.filter((s) => s !== m.slug)];
    }),
  ];
  const unknown = unknownMarked(input.brief, known);

  const seenAsk = new Set<string>();
  for (const options of asked) {
    if (seenAsk.has(options[0])) continue;
    seenAsk.add(options[0]);
    const slug = options.find((s) => input.installed(s));
    if (!slug) { if (!missing.includes(options[0])) missing.push(options[0]); continue; }
    take(slug, "asked for in the brief");
  }
  for (const slug of unknown) if (!missing.includes(slug)) missing.push(slug);
  for (const name of scan.unknown) if (!missing.includes(name)) missing.push(name);
  if (asked.length || unknown.length || scan.unknown.length || scan.ambiguous.length) {
    return { voices, missing, ambiguous: scan.ambiguous, overflow, how: "asked" };
  }

  // The router read the request and chose these; the library still has the last word.
  for (const slug of input.suggested ?? []) {
    if (!known.has(slug) || !input.installed(slug)) continue;
    take(slug, "chosen by the router for this request");
  }
  if (voices.length) return { voices, missing, ambiguous: [], overflow: [], how: "suggested" };

  const own = voiceQuery(input.brief);
  const hits = input.search(voiceQuery(input.brief, input.extraQuery), own);
  // The classifier reads what each candidate declares and refuses, so it sees
  // the search's hits whatever their coverage, plus the extra candidates (the
  // seat voices, which a described person like "o autor de Rápido e Devagar"
  // reaches when the words do not).
  if (input.rerank) {
    const pool: string[] = [];
    const free = (slug: string) => {
      const who = personOf(people, slug)?.key ?? slug;
      return !taken.has(slug) && !takenPeople.has(who) && input.installed(slug);
    };
    const pooled = new Set<string>();
    for (const slug of [...hits.slice(0, RERANK_SEARCH_CANDIDATES).map((h) => h.slug), ...(input.rerankCandidates ?? [])]) {
      const who = personOf(people, slug)?.key ?? slug;
      if (pooled.has(who) || !free(slug)) continue;
      pooled.add(who);
      pool.push(slug);
    }
    if (pool.length) {
      let r: ReturnType<VoiceRerank>;
      try { r = input.rerank(pool, own); } catch { r = { ok: false, slug: null }; }
      if (r.ok) {
        if (r.slug && pool.includes(r.slug)) take(r.slug, `chosen by the Jev classifier among ${pool.length} candidates${typeof r.confidence === "number" ? ` (p=${r.confidence.toFixed(2)})` : ""}`);
        return { voices, missing, ambiguous: [], overflow: [], how: voices.length ? "rerank" : "none" };
      }
    }
  }
  for (const h of hits) {
    if (voices.length >= limit) break;
    if (h.below_gate !== false || !voiceGate(h) || !input.installed(h.slug)) continue;
    take(h.slug, `matches ${h.coverage.matched}/${h.coverage.total} of the request's terms`, h.display_name);
  }
  return { voices, missing, ambiguous: [], overflow: [], how: voices.length ? "search" : "none" };
}

/** The one line a prompt carries for a clone that was asked for and cannot be loaded. */
export function missingVoiceNotice(missing: string[]): string {
  if (!missing.length) return "";
  return `Asked for but not installed: ${missing.map((s) => `\`${s}\``).join(", ")}. You are not loading ${missing.length > 1 ? "their" : "its"} persona: work from general knowledge, never claim the voice, and say in the deliverable that it was missing.`;
}

/** The lines a prompt carries for asks the selection could not settle alone. */
export function unsettledVoiceNotice(sel: Pick<VoiceSelection, "ambiguous" | "overflow">): string {
  const lines: string[] = [];
  for (const a of sel.ambiguous ?? []) {
    lines.push(`"${a.name}" names more than one clone (${a.candidates.map((c) => `\`${c}\``).join(", ")}): none was loaded; say in the deliverable which one the request should name.`);
  }
  if (sel.overflow?.length) {
    lines.push(`Also asked for, past the limit of voices for one run: ${sel.overflow.map((s) => `\`${s}\``).join(", ")}. Not loaded; say so in the deliverable.`);
  }
  return lines.join("\n");
}
