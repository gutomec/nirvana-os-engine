// shortlist.ts — who could deliver a request, ranked by words, zero tokens.
//
// `nrv find` prints it for the orchestrator, and the Jev decider (lib/jev-router.ts)
// asks its questions over it. It used to live in scripts/find.ts; a lib module
// does not import a script, so the ranking lives here and find.ts renders it.
//
// Measured on 48 labeled requests (2026-10-13): one mixed list of five put the
// right business in front of the orchestrator for 78% of the parts; businesses
// and squads ranked apart put it in the first five for 95% of them.
//
// One BM25 pass: the named target comes from the router's own explicit-mention
// detector (`detectTargetMention`), not from a second run of the whole router.

import * as path from "node:path";
import { createRequire } from "node:module";
import { businessCard, squadCard } from "./routing-cards.ts";
import { buildPeople, scanNames, type Person } from "./clone-names.ts";
import { loadCloneRegistry } from "../../_shared/lib/clone-resolver.ts";

const require_ = createRequire(import.meta.url);
const router = require_(path.join(import.meta.dir, "router.js"));
const loader = require_(path.join(import.meta.dir, "registry-loader.js"));

/** How many of each kind the shortlist prints: past eight the recall stopped moving. */
export const SHORTLIST_SIZE = 8;

export interface Shortlist {
  named: { kind: "business" | "squad"; slug: string } | null;
  businesses: Array<{ slug: string; card: string; coverage: string }>;
  squads: Array<{ slug: string; capability: string | null; card: string; coverage: string }>;
  clones: { named: string[]; ambiguous: Array<{ name: string; candidates: string[] }>; missing: string[] };
}

/**
 * Stage-2 matches, best first, split into businesses and squads, one line per
 * destination. Pure: the registries give the cards, the matches the order.
 */
export function rankShortlist(matches: any[], registries: any, size = SHORTLIST_SIZE): Pick<Shortlist, "businesses" | "squads"> {
  const bizReg = registries.businesses?.businesses ?? {};
  const sqReg = registries.squads?.squads ?? {};
  const caps = registries.squads?.capabilities ?? {};
  const cov = (m: any) => (m?.coverage && typeof m.coverage.matched === "number" ? `${m.coverage.matched}/${m.coverage.total}` : "");
  const businesses: Shortlist["businesses"] = [];
  const squads: Shortlist["squads"] = [];
  for (const m of matches) {
    const t = m?.meta?.type;
    if (t === "business" || t === "business_route") {
      // A business route belongs to its business: the seat it names is not dispatchable alone.
      const slug = m.meta.slug;
      if (!slug || businesses.some((b) => b.slug === slug) || businesses.length >= size || !bizReg[slug]) continue;
      businesses.push({ slug, card: businessCard(slug, bizReg[slug]), coverage: cov(m) });
    } else {
      const slug = router.resolveDestination(m);
      if (!slug || squads.some((s) => s.slug === slug) || squads.length >= size || !sqReg[slug]) continue;
      const capability = t === "squad_capability" ? (m.meta.capability_id ?? null) : null;
      squads.push({ slug, capability, card: squadCard(slug, sqReg[slug], caps), coverage: cov(m) });
    }
    if (businesses.length >= size && squads.length >= size) break;
  }
  return { businesses, squads };
}

/** The BM25 index of a registries object, built once: rebuilding it cost ~0.25 s per call. */
const preparedIndexes = new WeakMap<object, unknown>();
function preparedFor(registries: any): unknown {
  let p = preparedIndexes.get(registries);
  if (!p) { p = router.prepareMatchIndex(registries); preparedIndexes.set(registries, p); }
  return p;
}

/** The target the request names by slug, as the router's Stage 0.5 reads it. */
export function namedTarget(brief: string, registries: any): Shortlist["named"] {
  try {
    const mention = router.detectTargetMention(brief, registries);
    if (!mention) return null;
    if (mention.type === "business") return registries.businesses?.businesses?.[mention.slug] ? { kind: "business", slug: mention.slug } : null;
    return { kind: "squad", slug: mention.slug };
  } catch { return null; }
}

/** The clone library grouped by person, built once per loaded registry. */
const peopleByRegistry = new WeakMap<object, Person[]>();
export function peopleFor(cloneRegistry: Record<string, any>): Person[] {
  let p = peopleByRegistry.get(cloneRegistry);
  if (!p) {
    p = buildPeople(Object.entries(cloneRegistry).map(([slug, c]) => ({ slug, name: String(c?.display_name || slug) })));
    peopleByRegistry.set(cloneRegistry, p);
  }
  return p;
}

export interface ShortlistOpts {
  size?: number;
  /** The clone registry (`mind_clones` of the registry file); read from disk when absent. */
  cloneRegistry?: Record<string, any>;
}

/** Businesses and squads ranked apart, each line its routing card, plus the target and clones the request names. */
export async function shortlist(brief: string, registries: any = loader.loadAll(), opts: ShortlistOpts | number = {}): Promise<Shortlist> {
  const o: ShortlistOpts = typeof opts === "number" ? { size: opts } : opts;
  const size = o.size ?? SHORTLIST_SIZE;
  const prepared = preparedFor(registries);
  const intent = await router.stage1IntentClassify(brief, {});
  const matches = await router.stage2MatchHybrid(intent, registries, { brief, preparedMatchIndex: prepared, topK: 400 });
  const { businesses, squads } = rankShortlist(matches, registries, size);
  const named = namedTarget(brief, registries);
  let clones: Shortlist["clones"] = { named: [], ambiguous: [], missing: [] };
  try {
    const reg = o.cloneRegistry ?? (loadCloneRegistry({}) as Record<string, any>);
    const scan = scanNames(brief, peopleFor(reg));
    clones = { named: scan.matches.map((m) => m.slug), ambiguous: scan.ambiguous, missing: scan.unknown };
  } catch { /* a library that cannot be read names no clone */ }
  return { named, businesses, squads, clones };
}
