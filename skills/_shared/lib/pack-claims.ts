/**
 * pack-claims.ts — which installed packs deliver a component, read from their
 * manifests in ~/.nirvana/packs/<slug>.json.
 *
 * The same squad, business or mind-clone ships in several packs on purpose: a
 * component that serves a task in one pack serves the same task in another,
 * and every pack has to stand alone. All of them land in ONE library
 * directory. A pack that consults only its own manifest reads another pack's
 * copy as the buyer's work, so installing a second pack, updating either one or
 * uninstalling one of them misjudged the components they share. The overlay
 * and the uninstaller both ask here, so the two cannot disagree about who owns
 * what.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const PACK_KINDS = ["squads", "businesses", "mind-clones"] as const;
export type PackKind = typeof PACK_KINDS[number];

export interface PackClaim {
  /** Installed packs, other than the excluded one, that deliver this component. */
  packs: string[];
  /** The content hashes those packs recorded when they installed it. */
  hashes: Set<string>;
}

export const claimKey = (kind: PackKind | string, slug: string): string => `${kind}/${slug}`;

/**
 * Claims of every installed pack except `exceptSlug`, keyed by `<kind>/<slug>`.
 * An unreadable manifest is skipped: it cannot claim anything, and failing the
 * whole install over it would trade a real problem for a cosmetic one.
 */
export function readPackClaims(packsDir: string, exceptSlug: string): Map<string, PackClaim> {
  const claims = new Map<string, PackClaim>();
  let files: string[] = [];
  try { files = readdirSync(packsDir).filter((f) => f.endsWith(".json")); } catch { return claims; }
  for (const f of files.sort()) {
    const pack = f.slice(0, -".json".length);
    if (pack === exceptSlug) continue;
    let manifest: Record<string, unknown>;
    try { manifest = JSON.parse(readFileSync(join(packsDir, f), "utf8")); } catch { continue; }
    for (const kind of PACK_KINDS) {
      const recorded = manifest[kind];
      if (!recorded || typeof recorded !== "object") continue;
      for (const [slug, hash] of Object.entries(recorded as Record<string, unknown>)) {
        const key = claimKey(kind, slug);
        const claim = claims.get(key) ?? { packs: [], hashes: new Set<string>() };
        claim.packs.push(pack);
        if (typeof hash === "string") claim.hashes.add(hash);
        claims.set(key, claim);
      }
    }
  }
  return claims;
}
