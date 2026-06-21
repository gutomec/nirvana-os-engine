/**
 * observability-handler.ts — single dispatcher for the Phase 2 observability
 * endpoints. Plugs into glance/server.ts via one delegation block.
 *
 * Endpoints:
 *   GET /api/observability/traces[?days=30&limit=200&business=X&status=passed]
 *   GET /api/observability/traces/:trace_id
 *   GET /api/observability/anomalies[?days=30]
 *   GET /api/observability/dashboards/business/:slug
 *   GET /api/observability/dashboards/summary
 *
 * Frontend is observability.html in the same dir; it's served at /observability.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { build, findTrace, type TraceTree, type BuildResult } from "../../trace-builder.ts";
import { detect, type Anomaly } from "../../anomaly-detector.ts";

const HTML_PATH = join(import.meta.dir, "observability.html");

interface ParsedQuery {
  days: number;
  limit: number;
  business: string | null;
  squad: string | null;
  status: TraceTree["status"] | null;
  trace_id: string | null;
}

function parseQuery(u: URL): ParsedQuery {
  return {
    days: Math.max(1, Math.min(365, Number(u.searchParams.get("days") ?? "30") || 30)),
    limit: Math.max(1, Math.min(2000, Number(u.searchParams.get("limit") ?? "200") || 200)),
    business: u.searchParams.get("business") || null,
    squad: u.searchParams.get("squad") || null,
    status: (u.searchParams.get("status") as TraceTree["status"] | null) || null,
    trace_id: u.searchParams.get("trace_id") || null,
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function trimSpansForList(trace: TraceTree, max = 50): TraceTree {
  if (trace.spans.length <= max) return trace;
  return {
    ...trace,
    spans: [...trace.spans.slice(0, Math.floor(max / 2)), ...trace.spans.slice(-Math.floor(max / 2))],
    warnings: [...trace.warnings, `spans_truncated_from_${trace.spans.length}_to_${max}`],
  };
}

function dashboardForBusiness(traces: TraceTree[], slug: string) {
  const matched = traces.filter((t) => t.business_slugs.includes(slug));
  if (matched.length === 0) {
    return { business: slug, sample_size: 0, message: "no traces in window for this business" };
  }
  const gateDecided = matched.filter((t) => t.status === "passed" || t.status === "failed");
  const passed = gateDecided.filter((t) => t.status === "passed").length;
  const failed = gateDecided.length - passed;
  const costs = matched.map((t) => t.cost_usd).filter((v) => v > 0);
  const lats = matched.map((t) => t.duration_ms).filter((v) => v > 0);
  const sortedCosts = [...costs].sort((a, b) => a - b);
  const sortedLats = [...lats].sort((a, b) => a - b);
  const p50 = (arr: number[]) => (arr.length === 0 ? null : arr[Math.floor(arr.length / 2)]);
  const p95 = (arr: number[]) => (arr.length === 0 ? null : arr[Math.min(arr.length - 1, Math.floor(arr.length * 0.95))]);
  const sparkline = (arr: number[]) => arr.slice(-30);
  return {
    business: slug,
    sample_size: matched.length,
    gate_pass_rate: gateDecided.length > 0 ? passed / gateDecided.length : null,
    gate_decisions: gateDecided.length,
    cost: {
      total_usd: costs.reduce((a, b) => a + b, 0),
      p50_usd: p50(sortedCosts),
      p95_usd: p95(sortedCosts),
      sparkline: sparkline(matched.map((t) => t.cost_usd)),
    },
    latency_seconds: {
      p50: p50(sortedLats) !== null ? (p50(sortedLats) as number) / 1000 : null,
      p95: p95(sortedLats) !== null ? (p95(sortedLats) as number) / 1000 : null,
      sparkline: sparkline(matched.map((t) => t.duration_ms / 1000)),
    },
    revisions: {
      total: matched.reduce((acc, t) => acc + t.spans.filter((s) => s.event === "revision").length, 0),
    },
    top_employees: topEmployees(matched),
    recent_traces: matched.slice(0, 10).map((t) => ({
      trace_id: t.trace_id,
      status: t.status,
      duration_seconds: t.duration_ms / 1000,
      cost_usd: t.cost_usd,
      root_event: t.root_event,
    })),
  };
}

function topEmployees(traces: TraceTree[]): { employee: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const t of traces) {
    for (const s of t.spans) {
      const emp = (s.payload as Record<string, unknown>).agent_or_employee;
      if (typeof emp === "string") counts.set(emp, (counts.get(emp) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([employee, count]) => ({ employee, count }));
}

function summary(traces: TraceTree[]): {
  total_traces: number;
  by_status: Record<string, number>;
  unique_businesses: number;
  unique_squads: number;
  total_cost_usd: number;
  top_businesses: { business: string; count: number }[];
} {
  const by_status: Record<string, number> = {};
  const businessCount = new Map<string, number>();
  const squadSet = new Set<string>();
  let totalCost = 0;
  for (const t of traces) {
    by_status[t.status] = (by_status[t.status] ?? 0) + 1;
    totalCost += t.cost_usd;
    for (const b of t.business_slugs) businessCount.set(b, (businessCount.get(b) ?? 0) + 1);
    for (const s of t.squad_names) squadSet.add(s);
  }
  const top_businesses = [...businessCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([business, count]) => ({ business, count }));
  return {
    total_traces: traces.length,
    by_status,
    unique_businesses: businessCount.size,
    unique_squads: squadSet.size,
    total_cost_usd: totalCost,
    top_businesses,
  };
}

let _cachedBuild: { ts: number; days: number; result: BuildResult } | null = null;
async function cachedBuild(days: number, force = false): Promise<BuildResult> {
  const TTL_MS = 30 * 1000;
  if (!force && _cachedBuild && _cachedBuild.days === days && Date.now() - _cachedBuild.ts < TTL_MS) {
    return _cachedBuild.result;
  }
  const result = await build({ days });
  _cachedBuild = { ts: Date.now(), days, result };
  return result;
}

export async function handleObservabilityRoute(req: Request, u: URL): Promise<Response | null> {
  const p = u.pathname;

  if (p === "/observability" || p === "/observability/") {
    if (!existsSync(HTML_PATH)) {
      return new Response("observability.html not found", { status: 500 });
    }
    const html = readFileSync(HTML_PATH, "utf8");
    return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
  }

  if (!p.startsWith("/api/observability/")) return null;

  if (req.method !== "GET") {
    return jsonResponse({ error: "method not allowed" }, 405);
  }

  const q = parseQuery(u);

  if (p === "/api/observability/traces") {
    const r = await cachedBuild(q.days);
    const filter: NonNullable<Parameters<typeof build>[0]>["filter"] = {};
    if (q.business) filter.business = q.business;
    if (q.squad) filter.squad = q.squad;
    if (q.status) filter.status = q.status;
    let filtered = r.traces;
    if (filter.business) filtered = filtered.filter((t) => t.business_slugs.includes(filter.business!));
    if (filter.squad) filtered = filtered.filter((t) => t.squad_names.includes(filter.squad!));
    if (filter.status) filtered = filtered.filter((t) => t.status === filter.status);
    return jsonResponse({
      traces: filtered.slice(0, q.limit).map((t) => trimSpansForList(t, 12)),
      total_matching: filtered.length,
      stats: {
        scanned_files: r.scanned_files.length,
        orphan_event_lines: r.orphan_event_lines,
        malformed_lines: r.malformed_lines,
        correlated_pairs: r.correlated_pairs,
      },
      summary: summary(filtered),
    });
  }

  const traceMatch = p.match(/^\/api\/observability\/traces\/([^/]+)$/);
  if (traceMatch) {
    const id = decodeURIComponent(traceMatch[1]);
    const r = await cachedBuild(q.days);
    const t = findTrace(r, id);
    if (!t) return jsonResponse({ error: "trace_not_found", trace_id: id }, 404);
    return jsonResponse({ trace: t });
  }

  if (p === "/api/observability/anomalies") {
    const r = await cachedBuild(q.days);
    const anomalies: Anomaly[] = detect(r.traces);
    return jsonResponse({
      anomalies,
      total: anomalies.length,
      window_days: q.days,
    });
  }

  if (p === "/api/observability/dashboards/summary") {
    const r = await cachedBuild(q.days);
    return jsonResponse({ window_days: q.days, summary: summary(r.traces) });
  }

  const dashMatch = p.match(/^\/api\/observability\/dashboards\/business\/([^/]+)$/);
  if (dashMatch) {
    const slug = decodeURIComponent(dashMatch[1]);
    const r = await cachedBuild(q.days);
    return jsonResponse({ window_days: q.days, ...dashboardForBusiness(r.traces, slug) });
  }

  return null;
}
