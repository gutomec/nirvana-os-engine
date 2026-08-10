#!/usr/bin/env bun
/**
 * self-retrieval-gate.ts — the blocking creation gate of ROUTING_METADATA_CONTRACT.md §9.
 *
 * Given an entity (business slug | squad slug | capability id | mind-clone slug):
 *   1. reindex stale registries (`bun harness/scripts/index.ts --if-stale --quiet`),
 *   2. route each of the entity's example_briefs through the deterministic router
 *      (router.js route(), amplify OFF — READ-ONLY import, zero LLM),
 *   3. report per-brief top-1 hit/miss with the actual top-3.
 *
 * Clones have no example_briefs; their self-retrieval axis is the routing
 * one_liner over the clone BM25 corpus — same invariant as eval-clone-routing.ts
 * axis 1 and MIND_CLONE_CREATION_PIPELINE.md phase 5.
 *
 * Exit codes: 0 = every brief hits top-1 (with --lenient: top-3); 1 = at least
 * one miss OR the entity has no briefs to check (contract requires >= 3);
 * 2 = bad usage / unknown entity.
 *
 * CLI:
 *   bun self-retrieval-gate.ts <entity> [--lenient] [--json] [--no-reindex]
 *                              [--kind business|squad|capability|clone]
 *
 * `<entity>` kind is auto-detected against the registries. A capability id may
 * be provider-scoped as `<squad>:<capability.id>` when several squads provide it.
 */

import * as path from "node:path";
import { spawnSync } from "node:child_process";

const router = require(path.join(import.meta.dir, "..", "..", "harness", "lib", "router.js"));
const registryLoader = require(path.join(import.meta.dir, "..", "..", "harness", "lib", "registry-loader.js"));
const bm25 = require(path.join(import.meta.dir, "..", "..", "harness", "lib", "bm25.js"));

import { loadCloneRegistry } from "../lib/clone-resolver.ts";
import { buildCloneDocForTest } from "../lib/clone-search.ts";

export type EntityKind = "business" | "squad" | "capability" | "clone";

export interface BriefResult {
  brief: string;
  /** true when the expected entity is at rank 1 (or <=3 with lenient). */
  hit: boolean;
  /** 1-based rank of the expected entity among the router's candidates; null when absent. */
  rank: number | null;
  /** stage-3 signal (HIGH | AMBIGUOUS | NO_MATCH) — clones report "CLONE_BM25". */
  signal: string;
  top3: Array<{ id: string; type: string; normalized: number }>;
}

export interface GateResult {
  entity: string;
  kind: EntityKind;
  lenient: boolean;
  briefs: BriefResult[];
  passed: boolean;
  /** set when the gate fails without routing anything (e.g. no example_briefs). */
  reason?: string;
}

export interface GateOptions {
  lenient?: boolean;
  kind?: EntityKind;
  /** injected registries (tests). When present, no reindex is spawned. */
  registries?: any;
  /** injected clone registry (tests). */
  cloneRegistry?: Record<string, any>;
  /** default true; false skips the index --if-stale spawn. */
  reindex?: boolean;
}

// ── reindex ────────────────────────────────────────────────────────────────

function reindexIfStale(): void {
  const script = path.join(import.meta.dir, "..", "..", "harness", "scripts", "index.ts");
  const r = spawnSync(process.execPath, [script, "--if-stale", "--quiet"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (r.status !== 0) {
    // Non-fatal: the gate can still run on the existing registries, but say so.
    process.stderr.write(`[self-retrieval-gate] WARN: reindex failed (exit ${r.status}) — routing against possibly stale registries\n`);
    if (r.stderr) process.stderr.write(r.stderr);
  }
}

// ── entity resolution ──────────────────────────────────────────────────────

interface ResolvedEntity {
  kind: EntityKind;
  /** cases to route; expected is checked by matchers below. */
  cases: Array<{ brief: string; squad?: string; capability_id?: string; slug?: string }>;
}

function squadCapabilities(squadsRegistry: any, squad: string): Array<{ capability_id: string; provider: any }> {
  const out: Array<{ capability_id: string; provider: any }> = [];
  for (const [capId, providers] of Object.entries(squadsRegistry.capabilities || {})) {
    for (const p of (Array.isArray(providers) ? providers : []) as any[]) {
      if (p && p.squad === squad) out.push({ capability_id: capId, provider: p });
    }
  }
  for (const [squadName, caps] of Object.entries(squadsRegistry._v4_inferred_capabilities || {})) {
    if (squadName !== squad) continue;
    for (const cap of (Array.isArray(caps) ? caps : []) as any[]) {
      if (cap && typeof cap.capability_id === "string") out.push({ capability_id: cap.capability_id, provider: cap });
    }
  }
  return out;
}

function capabilityProviders(squadsRegistry: any, capId: string): Array<{ squad: string; provider: any }> {
  const out: Array<{ squad: string; provider: any }> = [];
  for (const p of ((squadsRegistry.capabilities || {})[capId] || []) as any[]) {
    if (p && typeof p.squad === "string") out.push({ squad: p.squad, provider: p });
  }
  for (const [squadName, caps] of Object.entries(squadsRegistry._v4_inferred_capabilities || {})) {
    for (const cap of (Array.isArray(caps) ? caps : []) as any[]) {
      if (cap && cap.capability_id === capId) out.push({ squad: squadName, provider: cap });
    }
  }
  return out;
}

function briefsOf(provider: any): string[] {
  return (Array.isArray(provider?.example_briefs) ? provider.example_briefs : [])
    .filter((b: any) => typeof b === "string" && b.trim())
    .map((b: string) => b.trim());
}

export function resolveEntity(
  entity: string,
  registries: any,
  cloneRegistry: Record<string, any>,
  kindOverride?: EntityKind,
): ResolvedEntity | null {
  const businesses = registries?.businesses?.businesses || {};
  const squadsReg = registries?.squads || {};

  // Provider-scoped capability: "<squad>:<capability.id>".
  let capSquadScope: string | null = null;
  let capId = entity;
  if (entity.includes(":")) {
    const [scope, rest] = [entity.slice(0, entity.indexOf(":")), entity.slice(entity.indexOf(":") + 1)];
    capSquadScope = scope;
    capId = rest;
  }

  const isBusiness = Object.prototype.hasOwnProperty.call(businesses, entity);
  const squadCaps = squadCapabilities(squadsReg, entity);
  const capProviders = capId.includes(".") ? capabilityProviders(squadsReg, capId) : [];
  const isClone = Object.prototype.hasOwnProperty.call(cloneRegistry || {}, entity);

  const kind: EntityKind | null =
    kindOverride
    ?? (isBusiness ? "business"
      : squadCaps.length > 0 ? "squad"
      : capProviders.length > 0 ? "capability"
      : isClone ? "clone"
      : null);
  if (!kind) return null;

  if (kind === "business") {
    if (!isBusiness) return null;
    const briefs = briefsOf(businesses[entity]);
    return { kind, cases: briefs.map((brief) => ({ brief, slug: entity })) };
  }

  if (kind === "squad") {
    if (squadCaps.length === 0) return null;
    const cases: ResolvedEntity["cases"] = [];
    for (const { capability_id, provider } of squadCaps) {
      for (const brief of briefsOf(provider)) cases.push({ brief, squad: entity, capability_id });
    }
    return { kind, cases };
  }

  if (kind === "capability") {
    let providers = capProviders;
    if (capSquadScope) providers = providers.filter((p) => p.squad === capSquadScope);
    if (providers.length === 0) return null;
    const cases: ResolvedEntity["cases"] = [];
    for (const { squad, provider } of providers) {
      for (const brief of briefsOf(provider)) cases.push({ brief, squad, capability_id: capId });
    }
    return { kind, cases };
  }

  // clone: the self-retrieval axis is the one_liner (eval-clone-routing axis 1).
  const clone = (cloneRegistry || {})[entity];
  if (!clone) return null;
  const oneLiner = clone?.match?.one_liner;
  const cases = typeof oneLiner === "string" && oneLiner.trim()
    ? [{ brief: oneLiner.trim(), slug: entity }]
    : [];
  return { kind: "clone", cases };
}

// ── hit matching (mirrors eval-routing.ts semantics) ───────────────────────

function candidateList(stage3: any): any[] {
  if (!stage3) return [];
  if (stage3.signal === "HIGH") return [stage3.target, ...(stage3.alternatives || [])].filter(Boolean);
  if (stage3.signal === "AMBIGUOUS") return (stage3.alternatives || []).filter(Boolean);
  return [];
}

function isHit(cand: any, kind: EntityKind, kase: { squad?: string; capability_id?: string; slug?: string }): boolean {
  const meta = (cand && cand.meta) || {};
  if (kind === "business") {
    return (meta.type === "business" && meta.slug === kase.slug)
      || (meta.type === "business_route" && meta.slug === kase.slug);
  }
  if (kind === "capability") {
    return meta.type === "squad_capability" && meta.squad === kase.squad && meta.capability_id === kase.capability_id;
  }
  // squad: any capability of the squad, or a business_route dispatching to it.
  if (meta.type === "squad_capability") return meta.squad === kase.squad;
  if (meta.type === "business_route") return String(meta.route_to || "").split("::")[0] === kase.squad;
  return false;
}

// ── the gate ───────────────────────────────────────────────────────────────

export async function runGate(entity: string, opts: GateOptions = {}): Promise<GateResult> {
  const lenient = !!opts.lenient;
  const injected = !!opts.registries || !!opts.cloneRegistry;
  if (!injected && opts.reindex !== false) reindexIfStale();

  const registries = opts.registries || registryLoader.loadAll();
  const cloneRegistry = opts.cloneRegistry || safeLoadCloneRegistry();

  const resolved = resolveEntity(entity, registries, cloneRegistry, opts.kind);
  if (!resolved) {
    return { entity, kind: (opts.kind || "business") as EntityKind, lenient, briefs: [], passed: false, reason: `entity not found in any registry: ${entity}` };
  }
  if (resolved.cases.length === 0) {
    const what = resolved.kind === "clone" ? "routing.one_liner" : "example_briefs";
    return {
      entity, kind: resolved.kind, lenient, briefs: [], passed: false,
      reason: `entity has no ${what} — the contract requires them before creation counts as done (ROUTING_METADATA_CONTRACT.md §5/§8)`,
    };
  }

  const maxRank = lenient ? 3 : 1;
  const briefs: BriefResult[] = [];

  if (resolved.kind === "clone") {
    // Clone corpus BM25 — same construction as eval-clone-routing.ts axis 1.
    const docs = Object.values(cloneRegistry).map(buildCloneDocForTest as any);
    const idx = bm25.buildIndex(docs);
    for (const kase of resolved.cases) {
      const hits = bm25.query(idx, kase.brief, { topK: 3 });
      let rank: number | null = null;
      for (let i = 0; i < hits.length; i++) {
        if (hits[i]?.doc?.slug === kase.slug) { rank = i + 1; break; }
      }
      briefs.push({
        brief: kase.brief,
        hit: rank !== null && rank <= maxRank,
        rank,
        signal: "CLONE_BM25",
        top3: hits.slice(0, 3).map((h: any) => ({ id: `clone:${h.doc.slug}`, type: "mind_clone", normalized: h.normalized })),
      });
    }
  } else {
    // amplify OFF: deterministic, zero LLM — same context as eval-routing.ts.
    const ctx = { registries, amplify: false };
    for (const kase of resolved.cases) {
      const result = await router.route(kase.brief, ctx);
      const s3 = result.stage3 || {};
      const ranked = candidateList(s3);
      let rank: number | null = null;
      for (let i = 0; i < ranked.length; i++) {
        if (isHit(ranked[i], resolved.kind, kase)) { rank = i + 1; break; }
      }
      briefs.push({
        brief: kase.brief,
        hit: rank !== null && rank <= maxRank,
        rank,
        signal: s3.signal || "?",
        top3: ranked.slice(0, 3).map((c: any) => ({
          id: c.id || c.meta?.slug || c.meta?.capability_id || "?",
          type: c.meta?.type || "?",
          normalized: typeof c.normalized === "number" ? c.normalized : 0,
        })),
      });
    }
  }

  return { entity, kind: resolved.kind, lenient, briefs, passed: briefs.every((b) => b.hit) };
}

function safeLoadCloneRegistry(): Record<string, any> {
  try { return loadCloneRegistry() || {}; } catch { return {}; }
}

// ── CLI ────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const lenient = argv.includes("--lenient");
  const wantJson = argv.includes("--json");
  const noReindex = argv.includes("--no-reindex");
  let kind: EntityKind | undefined;
  const kindIdx = argv.indexOf("--kind");
  if (kindIdx !== -1 && argv[kindIdx + 1]) {
    const v = argv[kindIdx + 1];
    if (["business", "squad", "capability", "clone"].includes(v)) kind = v as EntityKind;
    else { console.error(`self-retrieval-gate: invalid --kind '${v}'`); process.exit(2); }
  }
  const entity = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--kind")[0];
  if (!entity) {
    console.error("usage: bun self-retrieval-gate.ts <entity> [--lenient] [--json] [--no-reindex] [--kind business|squad|capability|clone]");
    process.exit(2);
  }

  const r = await runGate(entity, { lenient, kind, reindex: !noReindex });

  if (wantJson) {
    process.stdout.write(JSON.stringify(r, null, 2) + "\n");
  } else {
    console.log(`SELF-RETRIEVAL GATE — ${r.kind}:${r.entity} (${r.lenient ? "lenient, top-3" : "strict, top-1"})`);
    if (r.reason) console.log(`FAIL: ${r.reason}`);
    for (const b of r.briefs) {
      const mark = b.hit ? "HIT " : "MISS";
      const rank = b.rank === null ? "-" : `#${b.rank}`;
      console.log(`  [${mark}] rank=${rank} signal=${b.signal} :: ${b.brief.length > 80 ? b.brief.slice(0, 77) + "..." : b.brief}`);
      if (!b.hit) {
        for (const t of b.top3) console.log(`         top: ${t.type} · ${t.id} (${t.normalized.toFixed(3)})`);
        if (b.top3.length === 0) console.log("         top: (no candidates — NO_MATCH)");
      }
    }
    const hits = r.briefs.filter((b) => b.hit).length;
    console.log(`${r.passed ? "PASS" : "FAIL"} — ${hits}/${r.briefs.length} briefs hit ${r.lenient ? "top-3" : "top-1"}`);
    if (!r.passed) console.log("Fix the metadata per skills/_shared/ROUTING_METADATA_CONTRACT.md (never the router) and rerun.");
  }
  process.exit(r.passed ? 0 : 1);
}
