/**
 * anomaly-detector.ts — z-score sobre KPIs por business / squad e detecção de
 * traces individuais fora da norma estatística.
 *
 * Princípios de design:
 *  - Não dispara para entidades novas (sample size < min_samples)
 *  - Cooldown por entidade evita ruído (mesma anomalia não dispara 2× em N min)
 *  - Determinístico: dado o mesmo input, mesmo output sempre
 *  - Sem fontes externas — opera sobre o resultado de trace-builder
 */

import type { TraceTree } from "./trace-builder.ts";

export interface AnomalyThresholds {
  z_score: number;           // default 2.5
  min_samples: number;       // default 10
  cooldown_minutes: number;  // default 60 (apenas relevante para uso com state persistido)
}

export const DEFAULT_THRESHOLDS: AnomalyThresholds = {
  z_score: 2.5,
  min_samples: 10,
  cooldown_minutes: 60,
};

export type AnomalyKind = "cost_outlier" | "latency_outlier" | "failure_rate_outlier" | "trace_cost_spike" | "trace_latency_spike";

export interface Anomaly {
  kind: AnomalyKind;
  entity_type: "business" | "squad" | "trace";
  entity_id: string;
  z_score: number;
  current_value: number;
  baseline_mean: number;
  baseline_stddev: number;
  sample_size: number;
  detected_at: string;
  example_trace_id?: string;
  message: string;
}

interface AggStats {
  values: number[];
  mean: number;
  stddev: number;
  count: number;
}

function stats(values: number[]): AggStats {
  if (values.length === 0) return { values: [], mean: 0, stddev: 0, count: 0 };
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / values.length;
  return { values: [...values], mean, stddev: Math.sqrt(variance), count: values.length };
}

function zScore(value: number, mean: number, stddev: number): number {
  if (stddev === 0) return 0;
  return (value - mean) / stddev;
}

interface DetectOptions {
  thresholds?: Partial<AnomalyThresholds>;
  /** Recent window (more recent traces) — used as "current" sample. */
  recent_count?: number;
  /** When provided, only detect anomalies for these entities. */
  entity_filter?: { businesses?: string[]; squads?: string[] };
}

/**
 * Detects anomalies by splitting traces into a "baseline" tail and a "recent"
 * head. For each (business, squad), computes mean/stddev of cost/latency on the
 * baseline, then flags recent traces that lie ≥ z_score deviations away.
 *
 * Also computes failure-rate anomaly: when failure rate over recent window
 * exceeds `mean + z*stddev` of historical failure rates per entity.
 */
export function detect(traces: TraceTree[], opts: DetectOptions = {}): Anomaly[] {
  const th = { ...DEFAULT_THRESHOLDS, ...(opts.thresholds ?? {}) };
  const recentCount = Math.max(1, opts.recent_count ?? 30);

  // Newest-first; build baseline from older history.
  const sorted = [...traces].sort((a, b) => b.start_ts - a.start_ts);
  const recent = sorted.slice(0, recentCount);
  const baseline = sorted.slice(recentCount);

  const anomalies: Anomaly[] = [];
  const now = new Date().toISOString();

  // Group baseline + recent by (entity_type, entity_id)
  type Group = { type: "business" | "squad"; id: string; baseline: TraceTree[]; recent: TraceTree[] };
  const groups = new Map<string, Group>();

  const keyOf = (type: "business" | "squad", id: string) => `${type}:${id}`;
  const ingest = (set: "baseline" | "recent", t: TraceTree) => {
    for (const b of t.business_slugs) {
      const k = keyOf("business", b);
      const g = groups.get(k) ?? { type: "business" as const, id: b, baseline: [], recent: [] };
      g[set].push(t);
      groups.set(k, g);
    }
    for (const s of t.squad_names) {
      const k = keyOf("squad", s);
      const g = groups.get(k) ?? { type: "squad" as const, id: s, baseline: [], recent: [] };
      g[set].push(t);
      groups.set(k, g);
    }
  };
  baseline.forEach((t) => ingest("baseline", t));
  recent.forEach((t) => ingest("recent", t));

  for (const g of groups.values()) {
    if (opts.entity_filter) {
      if (g.type === "business" && opts.entity_filter.businesses && !opts.entity_filter.businesses.includes(g.id)) continue;
      if (g.type === "squad" && opts.entity_filter.squads && !opts.entity_filter.squads.includes(g.id)) continue;
    }
    if (g.baseline.length < th.min_samples || g.recent.length === 0) continue;

    // Cost
    const baseCosts = g.baseline.map((t) => t.cost_usd).filter((v) => v > 0);
    const baseStats = stats(baseCosts);
    if (baseStats.count >= th.min_samples && baseStats.stddev > 0) {
      const recentCosts = g.recent.map((t) => t.cost_usd).filter((v) => v > 0);
      if (recentCosts.length > 0) {
        const recentMean = recentCosts.reduce((a, b) => a + b, 0) / recentCosts.length;
        const z = zScore(recentMean, baseStats.mean, baseStats.stddev);
        if (z >= th.z_score) {
          anomalies.push({
            kind: "cost_outlier",
            entity_type: g.type,
            entity_id: g.id,
            z_score: z,
            current_value: recentMean,
            baseline_mean: baseStats.mean,
            baseline_stddev: baseStats.stddev,
            sample_size: baseStats.count,
            detected_at: now,
            message: `${g.type} '${g.id}' recent cost mean $${recentMean.toFixed(4)} is ${z.toFixed(2)}σ above baseline $${baseStats.mean.toFixed(4)}.`,
          });
        }
      }
    }

    // Latency
    const baseLat = g.baseline.map((t) => t.duration_ms).filter((v) => v > 0);
    const latStats = stats(baseLat);
    if (latStats.count >= th.min_samples && latStats.stddev > 0) {
      const recentLat = g.recent.map((t) => t.duration_ms).filter((v) => v > 0);
      if (recentLat.length > 0) {
        const recentMean = recentLat.reduce((a, b) => a + b, 0) / recentLat.length;
        const z = zScore(recentMean, latStats.mean, latStats.stddev);
        if (z >= th.z_score) {
          anomalies.push({
            kind: "latency_outlier",
            entity_type: g.type,
            entity_id: g.id,
            z_score: z,
            current_value: recentMean,
            baseline_mean: latStats.mean,
            baseline_stddev: latStats.stddev,
            sample_size: latStats.count,
            detected_at: now,
            message: `${g.type} '${g.id}' recent latency mean ${(recentMean / 1000).toFixed(1)}s is ${z.toFixed(2)}σ above baseline ${(latStats.mean / 1000).toFixed(1)}s.`,
          });
        }
      }
    }

    // Failure rate
    const baseFail = g.baseline.filter((t) => t.status === "failed").length / g.baseline.length;
    const recentFail = g.recent.filter((t) => t.status === "failed").length / g.recent.length;
    // Use Wilson-ish heuristic: anomaly when recent rate > baseline + max(0.2, baseline)
    if (g.baseline.length >= th.min_samples && recentFail > baseFail + Math.max(0.2, baseFail)) {
      anomalies.push({
        kind: "failure_rate_outlier",
        entity_type: g.type,
        entity_id: g.id,
        z_score: 0,
        current_value: recentFail,
        baseline_mean: baseFail,
        baseline_stddev: 0,
        sample_size: g.baseline.length,
        detected_at: now,
        message: `${g.type} '${g.id}' recent failure rate ${(recentFail * 100).toFixed(0)}% vs baseline ${(baseFail * 100).toFixed(0)}%.`,
      });
    }
  }

  // Per-trace anomalies (trace_cost_spike / trace_latency_spike): for each
  // baseline distribution of cost / latency, flag individual recent traces
  // beyond z_score sigma.
  const allCosts = baseline.map((t) => t.cost_usd).filter((v) => v > 0);
  const costAll = stats(allCosts);
  const allLat = baseline.map((t) => t.duration_ms).filter((v) => v > 0);
  const latAll = stats(allLat);

  for (const t of recent) {
    if (costAll.count >= th.min_samples && costAll.stddev > 0 && t.cost_usd > 0) {
      const z = zScore(t.cost_usd, costAll.mean, costAll.stddev);
      if (z >= th.z_score) {
        anomalies.push({
          kind: "trace_cost_spike",
          entity_type: "trace",
          entity_id: t.trace_id,
          z_score: z,
          current_value: t.cost_usd,
          baseline_mean: costAll.mean,
          baseline_stddev: costAll.stddev,
          sample_size: costAll.count,
          detected_at: now,
          example_trace_id: t.trace_id,
          message: `Trace ${t.trace_id} cost $${t.cost_usd.toFixed(4)} (${z.toFixed(2)}σ above mean $${costAll.mean.toFixed(4)}).`,
        });
      }
    }
    if (latAll.count >= th.min_samples && latAll.stddev > 0 && t.duration_ms > 0) {
      const z = zScore(t.duration_ms, latAll.mean, latAll.stddev);
      if (z >= th.z_score) {
        anomalies.push({
          kind: "trace_latency_spike",
          entity_type: "trace",
          entity_id: t.trace_id,
          z_score: z,
          current_value: t.duration_ms,
          baseline_mean: latAll.mean,
          baseline_stddev: latAll.stddev,
          sample_size: latAll.count,
          detected_at: now,
          example_trace_id: t.trace_id,
          message: `Trace ${t.trace_id} latency ${(t.duration_ms / 1000).toFixed(1)}s (${z.toFixed(2)}σ above mean ${(latAll.mean / 1000).toFixed(1)}s).`,
        });
      }
    }
  }

  // Dedup: a single entity getting both cost + latency outliers is OK; but
  // identical (kind, entity_type, entity_id) tuples shouldn't appear twice.
  const seen = new Set<string>();
  const uniq: Anomaly[] = [];
  for (const a of anomalies) {
    const k = `${a.kind}|${a.entity_type}|${a.entity_id}`;
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(a);
  }
  return uniq.sort((a, b) => b.z_score - a.z_score);
}

/**
 * Filters anomalies that are still within their cooldown window (i.e. the same
 * (kind, entity_type, entity_id) was reported recently). Caller is responsible
 * for persisting `recently_reported` between runs (e.g. via state-db).
 */
export function applyCooldown(
  anomalies: Anomaly[],
  recently_reported: { key: string; reported_at: string }[],
  thresholds: AnomalyThresholds = DEFAULT_THRESHOLDS,
): Anomaly[] {
  const cutoff = Date.now() - thresholds.cooldown_minutes * 60_000;
  const recentKeys = new Set(
    recently_reported
      .filter((r) => Date.parse(r.reported_at) >= cutoff)
      .map((r) => r.key),
  );
  return anomalies.filter((a) => {
    const k = `${a.kind}|${a.entity_type}|${a.entity_id}`;
    return !recentKeys.has(k);
  });
}

// Exported for unit tests
export const __internal__ = { stats, zScore };
