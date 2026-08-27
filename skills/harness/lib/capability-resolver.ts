// capability-resolver.ts — which capability of a squad a dispatch actually runs.
//
// A squad is not one entry point. The installed library declares 657
// capabilities across 204 squads, each one with its own workflow, its own
// `produces` and its own acceptance contract. The engine dispatched all of them
// through a single literal: `dispatch.ts` stamped `"squad.execute"` on the Run,
// on every artifact ref and on the Glance target, and `squad-exec.ts` never
// received a capability at all — it sent the whole manifest plus the first three
// agents and the first three tasks in alphabetical order. The provenance was
// false and the prompt was a coin toss.
//
// This module answers one question — given a squad and a brief, which
// capability? — with a fixed ladder, and says which rung answered:
//
//   explicit  the caller named it (`--squad <slug>:<capabilityId>`, `use squad
//             <slug>:<cap>:` in a Glance Message, a multi-target plan node).
//             The caller is in command: an id the squad does not declare is
//             honoured and named in `warning`, never silently replaced.
//   single    the squad declares exactly one capability. No brief needed.
//   bm25      the squad declares several: score them against the brief with the
//             same documents and the same index the router builds, restricted to
//             this squad's providers. Ties and a brief with no term overlap fall
//             to the first declared id, with `score: 0` on the audit event so the
//             absence of a signal is visible rather than dressed up as a match.
//   legacy    the squad declares none — a v4 manifest, or a squad the registry
//             has never seen. `squad.execute` is then the honest answer: it is
//             what the engine will run, and `squad-exec` recognizes it as "no
//             capability" and keeps the historical prompt byte for byte.
//
// v4 inferred capabilities (`_v4_inferred_capabilities`) are deliberately NOT a
// rung. They are a discovery surface the indexer synthesizes so a v4 squad is
// findable; they are not entry points the squad declared, so they never become
// provenance.

import { createRequire } from "node:module";

const requireCjs = createRequire(import.meta.url);

/** The capability id a squad without `capabilities[]` runs under — the only
 *  place in the engine that still names it. */
export const LEGACY_CAPABILITY_ID = "squad.execute";

/** Which rung of the ladder answered. */
export type CapabilitySource = "explicit" | "single" | "bm25" | "legacy";

export interface SquadCapabilityResolution {
  capabilityId: string;
  source: CapabilitySource;
  /** BM25 score of the winner; `0` when no term of the brief matched anything. */
  score?: number;
  /** Capability ids the squad declares, in manifest order; empty for a v4 squad. */
  declared: string[];
  /** The explicit id is not among the declared ones — honoured, and named. */
  warning?: string;
}

/** The slice of the squads registry this module reads. */
export interface SquadsCapabilityRegistry {
  squads?: Record<string, { capabilities?: unknown } | undefined>;
  capabilities?: Record<string, unknown>;
  [key: string]: unknown;
}

export type CapabilityAudit = (event: string, payload: Record<string, unknown>) => void;

export interface ResolveSquadCapabilityInput {
  slug: string;
  /** The brief BM25 scores against; absent or empty skips straight to the first declared id. */
  brief?: string;
  /** A capability the caller named. Wins the ladder. */
  explicit?: string | null;
  /** Registry to read; defaults to the one `nrv index` maintains. */
  registry?: SquadsCapabilityRegistry;
  /** Audit sink for `x_capability_resolved`; the resolution never depends on it. */
  audit?: CapabilityAudit;
  /** Extra fields on the audit event (trace_id, project_id, …). */
  auditContext?: Record<string, unknown>;
}

/** `<slug>[:<capabilityId>]` — the same spec grammar `evaluator-selection.ts`
 *  parses out of `NIRVANA_GAUNTLET_EVALUATOR=squad:<slug>[:<capabilityId>]`.
 *  Returns null for a value that names no slug. */
export function parseSquadTarget(value: string): { slug: string; capabilityId: string | null } | null {
  const match = /^([^:\s]+)(?::([^:\s]+))?$/.exec(String(value ?? "").trim());
  if (!match) return null;
  return { slug: match[1].toLowerCase(), capabilityId: match[2] ? match[2].toLowerCase() : null };
}

/** The reverse: the CLI/plan token for a resolved target. */
export function formatSquadTarget(slug: string, capabilityId?: string | null): string {
  return capabilityId && capabilityId !== LEGACY_CAPABILITY_ID ? `${slug}:${capabilityId}` : slug;
}

function loadDefaultRegistry(): SquadsCapabilityRegistry {
  try {
    const loader = requireCjs("./registry-loader.js") as { loadSquads(): { registry: SquadsCapabilityRegistry } };
    return loader.loadSquads().registry;
  } catch { return {}; }
}

/** Capability ids the squad's manifest declares, in the order the registry kept. */
export function declaredCapabilities(registry: SquadsCapabilityRegistry, slug: string): string[] {
  const entry = registry?.squads?.[slug];
  const ids = entry && Array.isArray((entry as { capabilities?: unknown }).capabilities)
    ? ((entry as { capabilities: unknown[] }).capabilities)
    : [];
  return ids.filter((id): id is string => typeof id === "string" && id.length > 0);
}

/** BM25 over this squad's capability documents only — the same `buildMatchDocs`
 *  text the router scores, so a capability that wins here would win there. */
function scoreWithinSquad(registry: SquadsCapabilityRegistry, slug: string, brief: string): { capabilityId: string; score: number } | null {
  if (!brief.trim()) return null;
  let best: { capabilityId: string; score: number } | null = null;
  try {
    const router = requireCjs("./router.js") as { buildMatchDocs(squads: unknown, businesses: unknown): Array<{ id: string; text: string; meta: Record<string, unknown> }> };
    const bm25 = requireCjs("./bm25.js") as { buildIndex(docs: unknown[]): unknown; query(index: unknown, q: string, opts?: { topK?: number }): Array<{ doc: { meta: Record<string, unknown> }; score: number }> };
    const docs = router.buildMatchDocs(registry, null)
      .filter(doc => doc.meta?.type === "squad_capability" && doc.meta?.squad === slug && typeof doc.meta?.capability_id === "string");
    if (!docs.length) return null;
    const hits = bm25.query(bm25.buildIndex(docs), brief, { topK: docs.length });
    // One capability has two documents (curated metadata + indexed body); the
    // better of the two is the capability's score, as in the router.
    const byCapability = new Map<string, number>();
    for (const hit of hits) {
      const id = String(hit.doc.meta.capability_id);
      byCapability.set(id, Math.max(byCapability.get(id) ?? 0, hit.score));
    }
    for (const [capabilityId, score] of [...byCapability].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
      if (score > 0) { best = { capabilityId, score }; break; }
    }
  } catch { return null; }
  return best;
}

/**
 * The capability a squad dispatch runs, and the rung that decided it.
 *
 * Pure with respect to the resolution: the audit sink is a side channel, and a
 * missing or unreadable registry resolves to `legacy` instead of throwing — a
 * dispatch never fails because the index is stale.
 */
export function resolveSquadCapability(input: ResolveSquadCapabilityInput): SquadCapabilityResolution {
  const registry = input.registry ?? loadDefaultRegistry();
  const declared = declaredCapabilities(registry, input.slug);
  const explicit = input.explicit?.trim() ? input.explicit.trim() : null;

  let resolution: SquadCapabilityResolution;
  if (explicit && explicit !== LEGACY_CAPABILITY_ID) {
    resolution = {
      capabilityId: explicit, source: "explicit", declared,
      ...(declared.length && !declared.includes(explicit)
        ? { warning: `squad '${input.slug}' does not declare '${explicit}'; dispatching it because the caller named it` }
        : {}),
    };
  } else if (declared.length === 1) {
    resolution = { capabilityId: declared[0], source: "single", declared };
  } else if (declared.length > 1) {
    const scored = scoreWithinSquad(registry, input.slug, input.brief ?? "");
    resolution = { capabilityId: scored?.capabilityId ?? declared[0], source: "bm25", score: scored?.score ?? 0, declared };
  } else {
    resolution = { capabilityId: LEGACY_CAPABILITY_ID, source: "legacy", declared };
  }

  input.audit?.("x_capability_resolved", {
    ...input.auditContext,
    squad_slug: input.slug,
    capability_id: resolution.capabilityId,
    source: resolution.source,
    declared_count: declared.length,
    ...(resolution.score !== undefined ? { score: Number(resolution.score.toFixed(4)) } : {}),
    ...(resolution.warning ? { warning: resolution.warning } : {}),
  });
  return resolution;
}
