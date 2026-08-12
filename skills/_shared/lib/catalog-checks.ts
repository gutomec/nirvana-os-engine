/**
 * catalog-checks.ts — Capability-catalog compliance checks.
 *
 * Implements the checks declared in CAPABILITY_CATALOG_V1.yaml
 * `validation_rules` (reserved_prefix_check, unknown_namespace_check,
 * unknown_domain_check) plus two diagnostic reports demanded by the
 * routing-360 audit: capability-id collisions and score_boost values
 * outside the runtime's effective clamp range.
 *
 * Pure functions over in-memory records — no filesystem access except
 * loadCatalog(). Consumed by _shared/scripts/capability-doctor.ts and
 * covered by _shared/tests/catalog-checks.test.ts.
 *
 * All checks are warn/report level: legacy content never hard-fails.
 * The squad-level escape hatch `experimental_domains: true` suppresses
 * unknown-namespace and unknown-domain findings (per catalog governance),
 * but never reserved-prefix findings.
 */

import * as fs from "node:fs";

export interface CatalogData {
  version: string;
  namespaces: Set<string>;
  domains: Set<string>;
  reserved_prefixes: Set<string>;
}

/** One declared capability (squad capabilities[] entry or business capability id). */
export interface CapabilityRecord {
  id: string;
  provider: string;                     // squad or business slug
  provider_kind: "squad" | "business";
  domains: string[];                    // capability-level domains (empty for business refs)
  score_boost?: number;
  experimental: boolean;                // provider manifest sets experimental_domains: true
}

/** One provider-level domain declaration (business.domains rows). */
export interface DomainRow {
  provider: string;
  provider_kind: "squad" | "business";
  domain: string;
  capability_id?: string;               // set when the domain comes from a capability entry
  experimental: boolean;
}

export interface UnknownNamespaceFinding {
  id: string;
  prefix: string;
  provider: string;
  provider_kind: "squad" | "business";
}

export interface ReservedPrefixFinding {
  id: string;
  prefix: string;
  provider: string;
  provider_kind: "squad" | "business";
}

export interface UnknownDomainFinding {
  domain: string;
  provider: string;
  provider_kind: "squad" | "business";
  capability_id?: string;
}

export interface CollisionFinding {
  id: string;
  providers: string[];                  // unique squad slugs providing this id
}

export interface ScoreBoostFinding {
  id: string;
  provider: string;
  declared: number;
  clamped: number;
}

/**
 * Effective score_boost range applied at runtime by the harness router
 * (skills/harness/lib/router.js clamps declared boosts to this window).
 * Declaring outside it is legal but has no additional effect.
 */
export const SCORE_BOOST_EFFECTIVE_RANGE = { min: 1.0, max: 1.3 } as const;

export function namespaceOf(id: string): string {
  return String(id).split(".")[0];
}

/** Parse CAPABILITY_CATALOG_V1.yaml into lookup sets. */
export function loadCatalog(catalogPath: string): CatalogData {
  const YAML = require("yaml");
  const parsed = YAML.parse(fs.readFileSync(catalogPath, "utf8"));
  return {
    version: String(parsed?.version || "unknown"),
    namespaces: new Set(
      (Array.isArray(parsed?.namespaces) ? parsed.namespaces : [])
        .map((n: any) => n?.prefix)
        .filter((p: any) => typeof p === "string"),
    ),
    domains: new Set(
      (Array.isArray(parsed?.domains) ? parsed.domains : [])
        .map((d: any) => d?.id)
        .filter((d: any) => typeof d === "string"),
    ),
    reserved_prefixes: new Set(
      (Array.isArray(parsed?.reserved_prefixes) ? parsed.reserved_prefixes : [])
        .filter((p: any) => typeof p === "string"),
    ),
  };
}

/**
 * unknown_namespace_check — capability id prefix not in the catalog.
 * Warning level. Suppressed when the provider manifest declares
 * `experimental_domains: true`. Reserved prefixes are excluded here:
 * they surface in checkReservedPrefixes() as violations instead.
 */
export function checkUnknownNamespaces(
  caps: CapabilityRecord[],
  catalog: CatalogData,
): UnknownNamespaceFinding[] {
  const out: UnknownNamespaceFinding[] = [];
  for (const c of caps) {
    if (c.experimental) continue;
    const prefix = namespaceOf(c.id);
    if (catalog.namespaces.has(prefix)) continue;
    if (catalog.reserved_prefixes.has(prefix)) continue; // reported as violation
    out.push({ id: c.id, prefix, provider: c.provider, provider_kind: c.provider_kind });
  }
  return out;
}

/**
 * reserved_prefix_check — capability id uses a protocol-reserved prefix.
 * Violation level. The experimental escape hatch does NOT apply.
 */
export function checkReservedPrefixes(
  caps: CapabilityRecord[],
  catalog: CatalogData,
): ReservedPrefixFinding[] {
  const out: ReservedPrefixFinding[] = [];
  for (const c of caps) {
    const prefix = namespaceOf(c.id);
    if (!catalog.reserved_prefixes.has(prefix)) continue;
    out.push({ id: c.id, prefix, provider: c.provider, provider_kind: c.provider_kind });
  }
  return out;
}

/**
 * unknown_domain_check — declared domain not in the catalog.
 * Warning level. Suppressed by `experimental_domains: true`.
 */
export function checkUnknownDomains(
  rows: DomainRow[],
  catalog: CatalogData,
): UnknownDomainFinding[] {
  const out: UnknownDomainFinding[] = [];
  for (const r of rows) {
    if (r.experimental) continue;
    if (catalog.domains.has(r.domain)) continue;
    out.push({
      domain: r.domain,
      provider: r.provider,
      provider_kind: r.provider_kind,
      capability_id: r.capability_id,
    });
  }
  return out;
}

/**
 * Collision report — capability ids provided by 2+ distinct squads.
 * Informational: multi-provider ids are legal (the router disambiguates),
 * but heavy collisions (e.g. media.video.compose x10) blur discovery.
 * Business records are references, not providers — they never count.
 */
export function findCollisions(caps: CapabilityRecord[]): CollisionFinding[] {
  const byId = new Map<string, Set<string>>();
  for (const c of caps) {
    if (c.provider_kind !== "squad") continue;
    let set = byId.get(c.id);
    if (!set) byId.set(c.id, (set = new Set()));
    set.add(c.provider);
  }
  const out: CollisionFinding[] = [];
  for (const [id, providers] of byId) {
    if (providers.size >= 2) out.push({ id, providers: [...providers].sort() });
  }
  return out.sort((a, b) => b.providers.length - a.providers.length || a.id.localeCompare(b.id));
}

/**
 * score_boost report — declared boost outside the runtime's effective
 * clamp range [1.0, 1.3]. The declaration is legal per schema ([0, 2])
 * but the router clamps it, so the declared intent is silently ignored.
 */
export function checkScoreBoost(caps: CapabilityRecord[]): ScoreBoostFinding[] {
  const { min, max } = SCORE_BOOST_EFFECTIVE_RANGE;
  const out: ScoreBoostFinding[] = [];
  for (const c of caps) {
    if (typeof c.score_boost !== "number") continue;
    if (c.score_boost >= min && c.score_boost <= max) continue;
    out.push({
      id: c.id,
      provider: c.provider,
      declared: c.score_boost,
      clamped: Math.min(max, Math.max(min, c.score_boost)),
    });
  }
  return out;
}
