#!/usr/bin/env bun
/**
 * eval-routing.ts — routing eval harness over the fast router (router.js).
 *
 * Runs `route()` (default thresholds, amplify OFF — fully deterministic) over:
 *   - baselines/golden-routing.json   (built by build-golden-set.ts from the
 *     live registries' example_briefs; gitignored — private library derivative)
 *   - baselines/golden-negatives.json (committed, hand-written, neutral)
 *
 * Metrics (golden set): top-1 / top-3 accuracy and MRR — overall, per kind
 * (squad_capability | business), per language (pt | en | other). Scoring is
 * STRICT on the routing signal: a NO_MATCH on a golden case is a miss even if
 * the correct target appears in the diagnostic alternatives — the router
 * abstained, so nothing would have been dispatched.
 *
 *   - squad_capability exact hit: top candidate is the same squad + capability.
 *     Looser "same-squad" metric also reported (candidate resolves to the same
 *     squad via squad_capability.squad or business_route.route_to prefix).
 *   - business hit: top candidate is that business OR a business_route
 *     belonging to it.
 *
 * Negatives: NO_MATCH rate (fraction of NO_MATCH-expected cases yielding
 * NO_MATCH) and false-dispatch rate (fraction yielding HIGH). Ambiguity
 * probes: fraction yielding AMBIGUOUS.
 *
 * CLI: bun eval-routing.ts [--json] [--assert --min-top1 <f> --min-top3 <f>
 *      --min-mrr <f> --min-no-match <f>]   (fractions 0-1; values >1 = percent)
 * Exit 0 always in report mode; --assert exits 1 when a floor is violated.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const router = require(path.join(import.meta.dir, "..", "lib", "router.js"));
const registryLoader = require(path.join(import.meta.dir, "..", "lib", "registry-loader.js"));

export const GOLDEN_PATH = path.join(import.meta.dir, "..", "baselines", "golden-routing.json");
export const NEGATIVES_PATH = path.join(import.meta.dir, "..", "baselines", "golden-negatives.json");

// Env flags that change router behavior — flagged as warnings, never mutated.
const ROUTER_ENV_FLAGS = ["NIRVANA_ROUTER_DENSE", "NIRVANA_ROUTER_FUSION", "NIRVANA_ROUTER_INTENT_FILTER"];

// ── candidate resolution ────────────────────────────────────────────────────

/** Ranked candidate list implied by the stage-3 decision. NO_MATCH → []. */
function candidateList(stage3: any): any[] {
  if (!stage3) return [];
  if (stage3.signal === "HIGH") return [stage3.target, ...(stage3.alternatives || [])].filter(Boolean);
  if (stage3.signal === "AMBIGUOUS") return (stage3.alternatives || []).filter(Boolean);
  return [];
}

function isExactHit(cand: any, kase: any): boolean {
  const meta = (cand && cand.meta) || {};
  if (kase.kind === "squad_capability") {
    return meta.type === "squad_capability" && meta.squad === kase.squad && meta.capability_id === kase.capability_id;
  }
  // business: the business itself OR one of its auto-routes.
  return (meta.type === "business" && meta.slug === kase.slug)
    || (meta.type === "business_route" && meta.slug === kase.slug);
}

function isSameSquadHit(cand: any, kase: any): boolean {
  if (kase.kind !== "squad_capability") return isExactHit(cand, kase);
  const meta = (cand && cand.meta) || {};
  if (meta.type === "squad_capability") return meta.squad === kase.squad;
  if (meta.type === "business_route") return String(meta.route_to || "").split("::")[0] === kase.squad;
  return false;
}

/**
 * Fabric hit — what the SYSTEM actually does, as opposed to which doc ranked
 * first. A business brief that lands on one of that business's own squads is
 * not a routing failure: the cascade would dispatch that same squad through
 * the business. Strict top-1 measures doc preference and is boundary-heavy
 * (business docs and their squads' capability docs describe the same work, so
 * IDF shifts flip cases both ways); the fabric metric measures whether the
 * brief reached the right *organization*. Both are reported; the strict axis
 * keeps its floor, the fabric axis is the one that maps to delivered work.
 *
 * A business's fabric = itself + every squad reachable from its auto_routes
 * (`route_to` prefix) and its declared `capabilities` providers.
 */
function isFabricHit(cand: any, kase: any, fabric: Map<string, Set<string>>): boolean {
  if (isExactHit(cand, kase)) return true;
  if (kase.kind !== "business") return isSameSquadHit(cand, kase);
  const meta = (cand && cand.meta) || {};
  const owned = fabric.get(kase.slug);
  if (!owned) return false;
  const squad = meta.type === "squad_capability" || meta.type === "squad"
    ? meta.squad
    : meta.type === "business_route" ? String(meta.route_to || "").split("::")[0] : null;
  return !!squad && owned.has(squad);
}

/** business slug → set of squads it dispatches (auto_routes + capability providers). */
export function buildBusinessFabric(registries: any): Map<string, Set<string>> {
  const fabric = new Map<string, Set<string>>();
  const routing = registries?.businesses?._business_routing || {};
  const capIndex = registries?.squads?.capabilities || {};
  for (const [slug, entry] of Object.entries<any>(registries?.businesses?.businesses || {})) {
    const owned = new Set<string>();
    for (const r of (routing[slug]?.auto_routes || [])) {
      const target = String(r.capability || r.route_to || "").split("::")[0];
      if (target) owned.add(target);
    }
    for (const capId of (entry.capabilities || [])) {
      for (const p of (capIndex[capId] || [])) if (p.squad) owned.add(p.squad);
    }
    fabric.set(slug, owned);
  }
  return fabric;
}

// ── accumulators ────────────────────────────────────────────────────────────

interface Axis {
  n: number;
  top1: number;
  top3: number;
  rrSum: number;
  sameSquadTop1: number;
  fabricTop1: number;
}
const newAxis = (): Axis => ({ n: 0, top1: 0, top3: 0, rrSum: 0, sameSquadTop1: 0, fabricTop1: 0 });

function axisRates(a: Axis) {
  return {
    n: a.n,
    top1: a.n ? a.top1 / a.n : 0,
    top3: a.n ? a.top3 / a.n : 0,
    mrr: a.n ? a.rrSum / a.n : 0,
    same_squad_top1: a.n ? a.sameSquadTop1 / a.n : 0,
    fabric_top1: a.n ? a.fabricTop1 / a.n : 0,
  };
}

// ── eval ────────────────────────────────────────────────────────────────────

export interface RunEvalOptions {
  goldenPath?: string;
  negativesPath?: string;
  registries?: any;
  quiet?: boolean;
}

export async function runEval(opts: RunEvalOptions = {}) {
  const goldenPath = opts.goldenPath || GOLDEN_PATH;
  const negativesPath = opts.negativesPath || NEGATIVES_PATH;
  if (!fs.existsSync(goldenPath)) {
    throw new Error(`golden set not found at ${goldenPath} — run build-golden-set.ts first`);
  }
  const golden = JSON.parse(fs.readFileSync(goldenPath, "utf8"));
  const negatives = fs.existsSync(negativesPath)
    ? JSON.parse(fs.readFileSync(negativesPath, "utf8"))
    : { cases: [] };

  const registries = opts.registries || registryLoader.loadAll();
  // amplify OFF: zero LLM calls, fully deterministic given the same registries.
  const ctx = { registries, amplify: false };

  const warnings: string[] = [];
  for (const flag of ROUTER_ENV_FLAGS) {
    if (process.env[flag] === "1") warnings.push(`${flag}=1 is set — results are NOT the default-router baseline`);
  }

  const started = Date.now();
  const businessFabric = buildBusinessFabric(registries);
  const overall = newAxis();
  const byKind: Record<string, Axis> = {};
  const byLanguage: Record<string, Axis> = {};
  const signals: Record<string, number> = { HIGH: 0, AMBIGUOUS: 0, NO_MATCH: 0 };

  const cases: any[] = golden.cases || [];
  let done = 0;
  for (const kase of cases) {
    const result = await router.route(kase.brief, ctx);
    const s3 = result.stage3 || {};
    signals[s3.signal] = (signals[s3.signal] || 0) + 1;
    const ranked = candidateList(s3);

    const axes = [
      overall,
      (byKind[kase.kind] ||= newAxis()),
      (byLanguage[kase.language] ||= newAxis()),
    ];
    const top1 = ranked.length > 0 && isExactHit(ranked[0], kase);
    const top3 = ranked.slice(0, 3).some((c) => isExactHit(c, kase));
    let rr = 0;
    for (let i = 0; i < ranked.length; i++) {
      if (isExactHit(ranked[i], kase)) { rr = 1 / (i + 1); break; }
    }
    const sameSquad = ranked.length > 0 && isSameSquadHit(ranked[0], kase);
    const fabric = ranked.length > 0 && isFabricHit(ranked[0], kase, businessFabric);
    for (const a of axes) {
      a.n++;
      if (top1) a.top1++;
      if (top3) a.top3++;
      a.rrSum += rr;
      if (sameSquad) a.sameSquadTop1++;
      if (fabric) a.fabricTop1++;
    }

    done++;
    if (!opts.quiet && done % 250 === 0) {
      console.error(`[eval-routing] ${done}/${cases.length} golden cases…`);
    }
  }

  // Negatives + ambiguity probes.
  const negNoMatch = { n: 0, no_match: 0, high: 0, ambiguous: 0 };
  const negAmbiguous = { n: 0, ambiguous: 0, high: 0, no_match: 0, high_on_accepted: 0 };
  for (const kase of negatives.cases || []) {
    const result = await router.route(kase.brief, ctx);
    const s3 = result.stage3 || {};
    if (kase.expected === "NO_MATCH") {
      negNoMatch.n++;
      if (s3.signal === "NO_MATCH") negNoMatch.no_match++;
      else if (s3.signal === "HIGH") negNoMatch.high++;
      else if (s3.signal === "AMBIGUOUS") negNoMatch.ambiguous++;
    } else if (kase.expected === "AMBIGUOUS") {
      negAmbiguous.n++;
      if (s3.signal === "AMBIGUOUS") negAmbiguous.ambiguous++;
      else if (s3.signal === "NO_MATCH") negAmbiguous.no_match++;
      else if (s3.signal === "HIGH") {
        negAmbiguous.high++;
        const accepted: string[] = Array.isArray(kase.accepted_targets) ? kase.accepted_targets : [];
        const meta = (s3.target && s3.target.meta) || {};
        const resolved = meta.squad || meta.slug || String(meta.route_to || "").split("::")[0];
        if (accepted.includes(resolved)) negAmbiguous.high_on_accepted++;
      }
    }
  }

  return {
    generated_at: new Date().toISOString(),
    duration_ms: Date.now() - started,
    golden_meta: {
      path: goldenPath,
      generated_at: golden.generated_at,
      counts: golden.counts,
    },
    warnings,
    golden: {
      total: overall.n,
      signals,
      overall: axisRates(overall),
      by_kind: Object.fromEntries(Object.entries(byKind).map(([k, a]) => [k, axisRates(a)])),
      by_language: Object.fromEntries(Object.entries(byLanguage).map(([k, a]) => [k, axisRates(a)])),
    },
    negatives: {
      no_match: {
        n: negNoMatch.n,
        no_match_rate: negNoMatch.n ? negNoMatch.no_match / negNoMatch.n : 0,
        false_dispatch_rate: negNoMatch.n ? negNoMatch.high / negNoMatch.n : 0,
        signals: { NO_MATCH: negNoMatch.no_match, HIGH: negNoMatch.high, AMBIGUOUS: negNoMatch.ambiguous },
      },
      ambiguous: {
        n: negAmbiguous.n,
        ambiguous_rate: negAmbiguous.n ? negAmbiguous.ambiguous / negAmbiguous.n : 0,
        signals: { AMBIGUOUS: negAmbiguous.ambiguous, HIGH: negAmbiguous.high, NO_MATCH: negAmbiguous.no_match },
        high_on_accepted: negAmbiguous.high_on_accepted,
      },
    },
  };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const pct = (f: number) => (f * 100).toFixed(1) + "%";

function printReport(r: Awaited<ReturnType<typeof runEval>>) {
  const row = (label: string, a: any) =>
    `${label.padEnd(26)} ${String(a.n).padStart(5)}  ${pct(a.top1).padStart(7)}  ${pct(a.top3).padStart(7)}  ${a.mrr.toFixed(3).padStart(6)}  ${pct(a.same_squad_top1).padStart(9)}  ${pct(a.fabric_top1).padStart(9)}`;

  console.log(`ROUTING EVAL — fast router (amplify OFF, default thresholds)`);
  console.log(`golden set: ${r.golden.total} cases (built ${r.golden_meta.generated_at})  ·  eval ${(r.duration_ms / 1000).toFixed(1)}s`);
  for (const w of r.warnings) console.log(`WARNING: ${w}`);
  console.log("");
  console.log(`${"axis".padEnd(26)} ${"n".padStart(5)}  ${"top-1".padStart(7)}  ${"top-3".padStart(7)}  ${"MRR".padStart(6)}  ${"same-sq@1".padStart(9)}  ${"fabric@1".padStart(9)}`);
  console.log(row("overall", r.golden.overall));
  for (const [k, a] of Object.entries(r.golden.by_kind)) console.log(row(`kind:${k}`, a));
  for (const [k, a] of Object.entries(r.golden.by_language)) console.log(row(`lang:${k}`, a));
  console.log("");
  console.log(`signals on golden: HIGH=${r.golden.signals.HIGH} AMBIGUOUS=${r.golden.signals.AMBIGUOUS} NO_MATCH=${r.golden.signals.NO_MATCH}`);
  console.log("");
  const nm = r.negatives.no_match;
  const am = r.negatives.ambiguous;
  console.log(`NEGATIVES (expected NO_MATCH, n=${nm.n}): NO_MATCH ${pct(nm.no_match_rate)} · false-dispatch (HIGH) ${pct(nm.false_dispatch_rate)} · AMBIGUOUS ${nm.signals.AMBIGUOUS}`);
  console.log(`AMBIGUITY PROBES (expected AMBIGUOUS, n=${am.n}): AMBIGUOUS ${pct(am.ambiguous_rate)} · HIGH ${am.signals.HIGH} (on accepted: ${am.high_on_accepted}) · NO_MATCH ${am.signals.NO_MATCH}`);
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const wantJson = argv.includes("--json");
  const assert = argv.includes("--assert");
  const num = (flag: string): number | null => {
    const i = argv.indexOf(flag);
    if (i === -1 || argv[i + 1] === undefined) return null;
    let v = Number(argv[i + 1]);
    if (!Number.isFinite(v)) return null;
    if (v > 1) v = v / 100; // percent form accepted
    return v;
  };

  const r = await runEval({ quiet: wantJson });
  if (wantJson) {
    process.stdout.write(JSON.stringify(r, null, 2) + "\n");
  } else {
    printReport(r);
  }

  if (assert) {
    const floors: Array<[string, number | null, number]> = [
      ["--min-top1", num("--min-top1"), r.golden.overall.top1],
      ["--min-top3", num("--min-top3"), r.golden.overall.top3],
      ["--min-mrr", num("--min-mrr"), r.golden.overall.mrr],
      ["--min-no-match", num("--min-no-match"), r.negatives.no_match.no_match_rate],
    ];
    const violations = floors.filter(([, min, actual]) => min !== null && actual < min);
    if (violations.length) {
      for (const [flag, min, actual] of violations) {
        console.error(`ASSERT FAILED: ${flag} ${min} > actual ${actual.toFixed(4)}`);
      }
      process.exit(1);
    }
    console.error("ASSERT OK — all floors met.");
  }
  process.exit(0);
}
