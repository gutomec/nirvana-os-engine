/**
 * trace-builder.ts — agrupa eventos `audit.jsonl` em árvores de spans por
 * `trace_id`. Streaming-friendly: lê arquivos linha-a-linha sem materializar
 * o JSON inteiro em memória.
 *
 * Produz uma estrutura tipo Jaeger/Honeycomb consumível por UI:
 *
 *   {
 *     trace_id, project_id, root_event, status, duration_ms, cost_usd,
 *     event_count, business_slugs[], squad_names[],
 *     spans: [{ event, ts, parent_index, payload }],
 *   }
 *
 * Phase 2 da nirvana-evolution. Ver docs/nirvana-evolution/README.md.
 *
 * Achados que este módulo endereça (do baseline Fase 0):
 *
 *   - Trace_id fragmentation: hook do Claude Code emite `cost_emission` com
 *     `session_id` como trace_id, enquanto o harness emite `dispatch_*` com
 *     trace_id próprio. `correlateTraces()` cobre o primeiro nível desse problema
 *     associando session_id ↔ harness trace_id quando ambos aparecem na mesma
 *     janela temporal apertada (heurística declarada — não tenta inferir mágica).
 */

import { readdirSync, existsSync, statSync, createReadStream } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { harnessLogsDir } from "../../_shared/lib/log-paths.ts";

const TERMINAL_EVENTS = new Set(["gate_passed", "gate_failed", "validation_failed", "delivered", "dispatch_blocked"]);
const DISPATCH_EVENTS = new Set(["dispatch_business", "dispatch_squad", "dispatch_skill"]);

export interface TraceSpan {
  event: string;
  ts: number;
  ts_iso: string;
  parent_index: number; // -1 for root spans within this trace
  payload: Record<string, unknown>;
}

export interface TraceTree {
  trace_id: string;
  session_id: string | null;
  project_id: string | null;
  business_slug: string | null;
  squad_name: string | null;
  root_event: string;
  status: "passed" | "failed" | "in_progress" | "blocked" | "unknown";
  start_ts: number;
  end_ts: number;
  duration_ms: number;
  cost_usd: number;
  event_count: number;
  business_slugs: string[];
  squad_names: string[];
  spans: TraceSpan[];
  warnings: string[];
}

export interface BuildOptions {
  /** Audit logs root. Defaults to env $HARNESS_LOGS_DIR or ~/.harness-logs */
  root?: string;
  /** Window size in days (default 30). */
  days?: number;
  /** Cap on number of traces returned (after newest-first sort). Default 500. */
  limit?: number;
  /** Filter by business slug, squad name, or trace_id substring. */
  filter?: { business?: string; squad?: string; trace_id?: string; status?: TraceTree["status"] };
}

export interface BuildResult {
  traces: TraceTree[];
  orphan_event_lines: number;
  malformed_lines: number;
  scanned_files: string[];
  correlated_pairs: number;
}

function isoDay(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function daysWindow(end: Date, days: number): Set<string> {
  const s = new Set<string>();
  for (let i = 0; i < days; i++) {
    const d = new Date(end);
    d.setUTCDate(d.getUTCDate() - i);
    s.add(isoDay(d));
  }
  return s;
}

async function readLines(path: string, fn: (obj: Record<string, unknown> | null) => void): Promise<{ parseErrors: number }> {
  let parseErrors = 0;
  const stream = createReadStream(path, { encoding: "utf8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const raw of rl) {
    const line = raw.trim();
    if (!line) continue;
    try {
      fn(JSON.parse(line) as Record<string, unknown>);
    } catch {
      parseErrors++;
      fn(null);
    }
  }
  return { parseErrors };
}

function classifyStatus(spans: TraceSpan[]): TraceTree["status"] {
  // Walk in reverse — last terminal event wins.
  for (let i = spans.length - 1; i >= 0; i--) {
    const e = spans[i].event;
    if (e === "gate_passed" || e === "delivered") return "passed";
    if (e === "gate_failed" || e === "validation_failed") return "failed";
    if (e === "dispatch_blocked") return "blocked";
  }
  return spans.some((s) => s.event === "invocation_start" || s.event === "brief_received" || DISPATCH_EVENTS.has(s.event)) ? "in_progress" : "unknown";
}

function pickRootEvent(spans: TraceSpan[]): string {
  const dispatches = spans.filter((s) => DISPATCH_EVENTS.has(s.event));
  if (dispatches.length > 0) return dispatches[0].event;
  const brief = spans.find((s) => s.event === "brief_received");
  if (brief) return brief.event;
  return spans[0]?.event ?? "unknown";
}

function attachParentIndices(spans: TraceSpan[]): void {
  // Simple parent inference: a span with `parent_trace_id` or `parent_index`
  // wins; otherwise we attach each span to the most recent dispatch event,
  // and dispatches to the most recent brief_received (or -1 if none).
  let lastBriefIdx = -1;
  let lastDispatchIdx = -1;
  for (let i = 0; i < spans.length; i++) {
    const s = spans[i];
    const explicit = s.payload.parent_index;
    if (typeof explicit === "number" && explicit >= -1 && explicit < spans.length) {
      s.parent_index = explicit;
      continue;
    }
    if (s.event === "brief_received") {
      s.parent_index = -1;
      lastBriefIdx = i;
      continue;
    }
    if (DISPATCH_EVENTS.has(s.event)) {
      s.parent_index = lastBriefIdx;
      lastDispatchIdx = i;
      continue;
    }
    if (lastDispatchIdx >= 0) {
      s.parent_index = lastDispatchIdx;
    } else if (lastBriefIdx >= 0) {
      s.parent_index = lastBriefIdx;
    } else {
      s.parent_index = -1;
    }
  }
}

function summarize(traceId: string, events: Record<string, unknown>[]): TraceTree {
  const spans: TraceSpan[] = events
    .map((ev) => {
      const tsStr = typeof ev.ts === "string" ? ev.ts : null;
      const ts = tsStr ? Date.parse(tsStr) : NaN;
      return {
        event: String(ev.event ?? ""),
        ts: Number.isNaN(ts) ? 0 : ts,
        ts_iso: tsStr ?? "",
        parent_index: -1,
        payload: ev,
      };
    })
    .sort((a, b) => a.ts - b.ts);

  attachParentIndices(spans);

  const businessSet = new Set<string>();
  const squadSet = new Set<string>();
  let totalCost = 0;
  let projectId: string | null = null;
  let sessionId: string | null = null;
  for (const sp of spans) {
    const p = sp.payload;
    // Aceita o alias bare (`business`/`squad`) que o maestro agêntico grava via
    // echo (SKILL.md), além do canônico `business_slug`/`squad_name` do caminho
    // CLI. Como os leitores re-leem o JSONL cru a cada run, isto recupera
    // retroativamente todo o histórico já em disco (E3).
    const biz = p.business_slug ?? p.business;
    if (typeof biz === "string") businessSet.add(biz);
    const sqd = p.squad_name ?? p.squad;
    if (typeof sqd === "string") squadSet.add(sqd);
    if (typeof p.project_id === "string") projectId ??= p.project_id;
    if (typeof p.session_id === "string") sessionId ??= p.session_id;
    if (sp.event === "cost_emission" && typeof p.total_cost_usd === "number") totalCost += p.total_cost_usd;
  }

  const start = spans.length > 0 ? spans[0].ts : 0;
  const end = spans.length > 0 ? spans[spans.length - 1].ts : 0;

  return {
    trace_id: traceId,
    session_id: sessionId,
    project_id: projectId,
    business_slug: businessSet.size === 1 ? [...businessSet][0] : null,
    squad_name: squadSet.size === 1 ? [...squadSet][0] : null,
    root_event: pickRootEvent(spans),
    status: classifyStatus(spans),
    start_ts: start,
    end_ts: end,
    duration_ms: Math.max(0, end - start),
    cost_usd: totalCost,
    event_count: spans.length,
    business_slugs: [...businessSet].sort(),
    squad_names: [...squadSet].sort(),
    spans,
    warnings: [],
  };
}

/**
 * Tries to attach orphan session_id traces (cost-only) to harness traces by
 * checking temporal overlap. Heuristic: if a harness trace has any span with
 * `session_id` field matching another trace's `trace_id`, merge them.
 *
 * Conservative: only merges when the link is explicit (same session_id field).
 * No timestamp fuzzy matching — that's intentional to avoid false-positives.
 */
function correlateTraces(traces: TraceTree[]): number {
  const byTraceId = new Map<string, TraceTree>();
  for (const t of traces) byTraceId.set(t.trace_id, t);
  let merged = 0;

  for (const t of traces) {
    if (!t.session_id) continue;
    const cousin = byTraceId.get(t.session_id);
    if (!cousin || cousin === t) continue;
    // cousin is the session-rooted trace (cost-only); merge its spans into t
    for (const sp of cousin.spans) {
      t.spans.push({ ...sp });
    }
    t.spans.sort((a, b) => a.ts - b.ts);
    t.cost_usd += cousin.cost_usd;
    t.event_count = t.spans.length;
    t.start_ts = Math.min(t.start_ts, cousin.start_ts || t.start_ts);
    t.end_ts = Math.max(t.end_ts, cousin.end_ts || t.end_ts);
    t.duration_ms = Math.max(0, t.end_ts - t.start_ts);
    t.warnings.push(`merged_session_trace:${cousin.trace_id}`);
    // remove cousin from main list
    byTraceId.delete(cousin.trace_id);
    merged++;
  }
  // Rebuild list in deterministic order, dropping merged-away cousins.
  traces.length = 0;
  for (const t of byTraceId.values()) traces.push(t);
  traces.sort((a, b) => b.start_ts - a.start_ts);
  return merged;
}

export async function build(opts: BuildOptions = {}): Promise<BuildResult> {
  const root = opts.root ?? process.env.HARNESS_LOGS_DIR ?? harnessLogsDir();
  const days = Math.max(1, Math.min(365, opts.days ?? 30));
  const limit = Math.max(1, opts.limit ?? 500);
  const filter = opts.filter ?? {};

  const eventsByTrace = new Map<string, Record<string, unknown>[]>();
  let orphanLines = 0;
  let malformed = 0;
  const scanned: string[] = [];

  if (!existsSync(root)) {
    return { traces: [], orphan_event_lines: 0, malformed_lines: 0, scanned_files: [], correlated_pairs: 0 };
  }

  const valid = daysWindow(new Date(), days);
  const dayDirs = readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && valid.has(e.name))
    .map((e) => e.name)
    .sort();

  for (const dayDir of dayDirs) {
    const file = join(root, dayDir, "audit.jsonl");
    if (!existsSync(file)) continue;
    scanned.push(file);
    const { parseErrors } = await readLines(file, (obj) => {
      if (!obj) return; // parseErrors counts it; avoid double-counting here
      const tid = typeof obj.trace_id === "string" ? obj.trace_id : null;
      if (!tid) {
        orphanLines++;
        return;
      }
      let arr = eventsByTrace.get(tid);
      if (!arr) {
        arr = [];
        eventsByTrace.set(tid, arr);
      }
      arr.push(obj);
    });
    malformed += parseErrors;
  }

  const traces: TraceTree[] = [];
  for (const [tid, evs] of eventsByTrace.entries()) {
    traces.push(summarize(tid, evs));
  }
  const correlated = correlateTraces(traces);

  // Apply filters AFTER correlation so merged traces pass the business filter properly.
  let filtered = traces;
  if (filter.business) filtered = filtered.filter((t) => t.business_slugs.includes(filter.business!));
  if (filter.squad) filtered = filtered.filter((t) => t.squad_names.includes(filter.squad!));
  if (filter.trace_id) filtered = filtered.filter((t) => t.trace_id.includes(filter.trace_id!));
  if (filter.status) filtered = filtered.filter((t) => t.status === filter.status);

  return {
    traces: filtered.slice(0, limit),
    orphan_event_lines: orphanLines,
    malformed_lines: malformed,
    scanned_files: scanned,
    correlated_pairs: correlated,
  };
}

export function findTrace(result: BuildResult, traceId: string): TraceTree | null {
  return result.traces.find((t) => t.trace_id === traceId) ?? null;
}

// Helpers exported for unit tests
export const __internal__ = {
  summarize,
  classifyStatus,
  pickRootEvent,
  attachParentIndices,
  correlateTraces,
  daysWindow,
  isoDay,
};
