// clone-voices.ts — which mind-clones a run is offered, one rule for every path.
//
// A business worker (business-solo.ts) and a squad (squad-exec.ts) used to pick
// voices by different rules: one matched names anywhere in the brief, the other
// capped at two and searched with a different query. The owner's rule, in one
// place:
//
//   1. A clone counts as ASKED FOR only when the brief's "Request (verbatim)"
//      section names it (slug or display name), or when a line marks it as
//      `clone <slug>`. A brief that lists clones as facts about a product
//      ("the pack ships Saul Bass and Paula Scher") asks for none.
//   2. Asked for and installed: offered, at most `limit`.
//   3. Asked for and not installed: reported in `missing`, never silently
//      dropped, and the search does not stand in for it.
//   4. Nothing asked for: the whole library is searched on the request and the
//      part this run delivers, and at most `limit` clones above the coverage
//      gate are offered. Nothing above the gate means no clone.

import { parseWorkBrief } from "./work-brief.ts";
import type { CloneHit } from "../../_shared/lib/clone-search.ts";

export interface PickedVoice { slug: string; name: string; why: string }

export interface VoiceSelection {
  voices: PickedVoice[];
  /** Asked for by the brief and absent from the library, or without files on disk. */
  missing: string[];
  how: "asked" | "search" | "none";
}

export interface VoiceSelectionInput {
  brief: string;
  names: Array<{ slug: string; name: string }>;
  /** True when the clone's files can be opened on this machine. */
  installed: (slug: string) => boolean;
  search: (query: string) => CloneHit[];
  /** Clones the run already carries (a seat's own): never offered twice. */
  taken?: Iterable<string>;
  /** Extra text for the search, e.g. the sub-task a squad runs. */
  extraQuery?: string;
  limit?: number;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** What the request is about: its own words and this run's part, without the
 *  decisions and criteria around them. A brief with no sections is all request. */
export function voiceQuery(brief: string, extra = ""): string {
  const s = parseWorkBrief(brief).sections;
  return [s["Request (verbatim)"], s["Your part"], extra].filter(Boolean).join("\n") || brief;
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

export function selectVoices(input: VoiceSelectionInput): VoiceSelection {
  const limit = input.limit ?? 3;
  const taken = new Set(input.taken ?? []);
  const voices: PickedVoice[] = [];
  const missing: string[] = [];
  const known = new Set(input.names.map((c) => c.slug));

  const request = (parseWorkBrief(input.brief).sections["Request (verbatim)"] ?? input.brief).toLowerCase();
  const asked: Array<{ slug: string; name: string }> = [];
  for (const c of input.names) {
    const name = c.name.toLowerCase();
    const inRequest = request.includes(c.slug) || request.includes(c.slug.replace(/-/g, " ")) || (name.length > 3 && request.includes(name));
    const marked = new RegExp(`(^|[^a-z0-9_-])clones?[\\s:=]+\`?${escapeRe(c.slug)}\`?($|[^a-z0-9_-])`, "i").test(input.brief);
    if (inRequest || marked) asked.push(c);
  }
  const unknown = unknownMarked(input.brief, known);

  for (const c of asked) {
    if (taken.has(c.slug)) continue;
    if (!input.installed(c.slug)) { missing.push(c.slug); continue; }
    if (voices.length >= limit) continue;
    taken.add(c.slug);
    voices.push({ slug: c.slug, name: c.name, why: "asked for in the brief" });
  }
  for (const slug of unknown) if (!missing.includes(slug)) missing.push(slug);
  if (asked.length || unknown.length) return { voices, missing, how: "asked" };

  for (const h of input.search(voiceQuery(input.brief, input.extraQuery))) {
    if (voices.length >= limit) break;
    if (h.below_gate !== false || taken.has(h.slug) || !input.installed(h.slug)) continue;
    taken.add(h.slug);
    voices.push({ slug: h.slug, name: h.display_name, why: `matches ${h.coverage.matched}/${h.coverage.total} of the request's terms` });
  }
  return { voices, missing, how: voices.length ? "search" : "none" };
}

/** The one line a prompt carries for a clone that was asked for and cannot be loaded. */
export function missingVoiceNotice(missing: string[]): string {
  if (!missing.length) return "";
  return `Asked for but not installed: ${missing.map((s) => `\`${s}\``).join(", ")}. You are not loading ${missing.length > 1 ? "their" : "its"} persona: work from general knowledge, never claim the voice, and say in the deliverable that it was missing.`;
}
