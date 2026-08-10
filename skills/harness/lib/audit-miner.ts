/**
 * audit-miner.ts — mines patterns out of the harness audit log.
 *
 * Phase 8 (meta-Nirvana) da nirvana-evolution.
 *
 * Reuses trace-builder.build() to get a structured TraceTree[], then
 * derives per-business and per-employee aggregate metrics from the spans.
 * Identifies "weak spots": businesses with low gate_pass_rate, employees
 * with high revision count, capabilities with cost outliers, briefs that
 * recurrently amplify (low scorer richness).
 *
 * Output is a `MiningReport` consumable by pattern-analyzer.
 */

import { build, type TraceTree, type BuildOptions } from "./trace-builder.ts";

export interface BusinessStats {
  business: string;
  trace_count: number;
  gate_pass_rate: number | null;
  revision_count: number;
  total_cost_usd: number;
  mean_cost_usd: number;
  mean_latency_ms: number;
  weakest_employees: { employee: string; revisions: number }[];
}

export interface SquadStats {
  squad: string;
  trace_count: number;
  gate_pass_rate: number | null;
  mean_cost_usd: number;
  mean_latency_ms: number;
}

export interface BriefAmplificationFinding {
  brief_amplified_count: number;
  amplified_pass_rate: number | null;
  not_amplified_pass_rate: number | null;
}

export interface MiningReport {
  window_days: number;
  total_traces: number;
  businesses: BusinessStats[];
  squads: SquadStats[];
  amplification: BriefAmplificationFinding;
  hot_employees: { employee: string; revisions: number; businesses: string[] }[];
  high_cost_traces: { trace_id: string; cost_usd: number; business: string | null }[];
  generated_at: string;
}

function tracesByBusiness(traces: TraceTree[]): Map<string, TraceTree[]> {
  const m = new Map<string, TraceTree[]>();
  for (const t of traces) {
    for (const b of t.business_slugs) {
      if (!m.has(b)) m.set(b, []);
      m.get(b)!.push(t);
    }
  }
  return m;
}

function tracesBySquad(traces: TraceTree[]): Map<string, TraceTree[]> {
  const m = new Map<string, TraceTree[]>();
  for (const t of traces) {
    for (const s of t.squad_names) {
      if (!m.has(s)) m.set(s, []);
      m.get(s)!.push(t);
    }
  }
  return m;
}

function countRevisions(t: TraceTree): number {
  return t.spans.filter((s) => s.event === "revision" || s.event === "revision_dispatched").length;
}

function employeeRevisions(traces: TraceTree[]): Map<string, { revisions: number; businesses: Set<string> }> {
  const m = new Map<string, { revisions: number; businesses: Set<string> }>();
  for (const t of traces) {
    for (const s of t.spans) {
      const emp = typeof (s.payload as Record<string, unknown>).agent_or_employee === "string"
        ? (s.payload as Record<string, unknown>).agent_or_employee as string
        : null;
      if (!emp) continue;
      if (!m.has(emp)) m.set(emp, { revisions: 0, businesses: new Set() });
      const slot = m.get(emp)!;
      if (s.event === "revision" || s.event === "revision_dispatched") slot.revisions++;
      for (const b of t.business_slugs) slot.businesses.add(b);
    }
  }
  return m;
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function passRate(traces: TraceTree[]): number | null {
  const decided = traces.filter((t) => t.status === "passed" || t.status === "failed");
  if (decided.length === 0) return null;
  const passed = decided.filter((t) => t.status === "passed").length;
  return passed / decided.length;
}

export async function mine(opts: BuildOptions & { high_cost_z: number } = { high_cost_z: 2 }): Promise<MiningReport> {
  const build_result = await build(opts);
  const traces = build_result.traces;
  const days = opts.days ?? 30;

  const byBiz = tracesByBusiness(traces);
  const businesses: BusinessStats[] = [];
  for (const [biz, ts] of byBiz.entries()) {
    const empMap = employeeRevisions(ts);
    const weakest = [...empMap.entries()]
      .map(([employee, v]) => ({ employee, revisions: v.revisions }))
      .filter((e) => e.revisions > 0)
      .sort((a, b) => b.revisions - a.revisions)
      .slice(0, 3);
    const costs = ts.map((t) => t.cost_usd).filter((v) => v > 0);
    const lats = ts.map((t) => t.duration_ms).filter((v) => v > 0);
    businesses.push({
      business: biz,
      trace_count: ts.length,
      gate_pass_rate: passRate(ts),
      revision_count: ts.reduce((s, t) => s + countRevisions(t), 0),
      total_cost_usd: ts.reduce((s, t) => s + t.cost_usd, 0),
      mean_cost_usd: mean(costs),
      mean_latency_ms: mean(lats),
      weakest_employees: weakest,
    });
  }
  businesses.sort((a, b) => {
    // Sort: businesses with low pass-rate first, then high revision count
    const ar = a.gate_pass_rate ?? 1;
    const br = b.gate_pass_rate ?? 1;
    if (ar !== br) return ar - br;
    return b.revision_count - a.revision_count;
  });

  const bySquad = tracesBySquad(traces);
  const squads: SquadStats[] = [];
  for (const [sq, ts] of bySquad.entries()) {
    squads.push({
      squad: sq,
      trace_count: ts.length,
      gate_pass_rate: passRate(ts),
      mean_cost_usd: mean(ts.map((t) => t.cost_usd).filter((v) => v > 0)),
      mean_latency_ms: mean(ts.map((t) => t.duration_ms).filter((v) => v > 0)),
    });
  }

  // Amplification finding
  const ampTraces = traces.filter((t) => t.spans.some((s) => s.event === "brief_amplified"));
  const noAmpTraces = traces.filter((t) => !t.spans.some((s) => s.event === "brief_amplified"));
  const amplification: BriefAmplificationFinding = {
    brief_amplified_count: ampTraces.length,
    amplified_pass_rate: passRate(ampTraces),
    not_amplified_pass_rate: passRate(noAmpTraces),
  };

  // Hot employees across all businesses
  const allEmp = employeeRevisions(traces);
  const hotEmployees = [...allEmp.entries()]
    .map(([employee, v]) => ({ employee, revisions: v.revisions, businesses: [...v.businesses].sort() }))
    .filter((e) => e.revisions > 0)
    .sort((a, b) => b.revisions - a.revisions)
    .slice(0, 10);

  // High-cost traces (z-score relative to all costs in window)
  const allCosts = traces.map((t) => t.cost_usd).filter((v) => v > 0);
  let highCost: MiningReport["high_cost_traces"] = [];
  if (allCosts.length >= 10) {
    const m = mean(allCosts);
    const sd = Math.sqrt(mean(allCosts.map((c) => (c - m) ** 2)));
    if (sd > 0) {
      highCost = traces
        .filter((t) => t.cost_usd > 0 && (t.cost_usd - m) / sd >= opts.high_cost_z)
        .map((t) => ({ trace_id: t.trace_id, cost_usd: t.cost_usd, business: t.business_slug }))
        .sort((a, b) => b.cost_usd - a.cost_usd)
        .slice(0, 10);
    }
  }

  return {
    window_days: days,
    total_traces: traces.length,
    businesses,
    squads,
    amplification,
    hot_employees: hotEmployees,
    high_cost_traces: highCost,
    generated_at: new Date().toISOString(),
  };
}
