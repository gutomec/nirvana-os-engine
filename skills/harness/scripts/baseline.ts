#!/usr/bin/env bun
/**
 * Baseline KPI extractor.
 *
 * Streams ~/.harness-logs/<YYYY-MM-DD>/audit.jsonl files within a window
 * and produces a baseline snapshot conforming to
 * skills/harness/baselines/schema.json.
 *
 * Usage:
 *   bun baseline.ts [--days=30] [--save] [--output=path] [--root=path]
 *
 * Flags:
 *   --days N      Window size in days (default 30; max 365).
 *   --save        Write to skills/harness/baselines/<YYYY-MM-DD>.json (today).
 *   --output P    Explicit output path (overrides --save).
 *   --root P      Override audit logs root (default: $HARNESS_LOGS_DIR or ~/.harness-logs).
 *   --quiet       Suppress stderr progress.
 *   --json        Emit JSON only on stdout (no human summary).
 *
 * Exits 0 on success, 2 on usage error, 1 on I/O failure.
 */

import { readdirSync, existsSync, statSync, mkdirSync, writeFileSync, createReadStream } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { spawnSync } from "node:child_process";

const SCHEMA_VERSION = "1.0.0";

const SKILLS_ROOT = process.env.NIRVANA_SKILLS_DIR
  || (existsSync(join(homedir(), ".nirvana", "skills")) ? join(homedir(), ".nirvana", "skills") : join(homedir(), ".claude", "skills"));

interface CliArgs {
  days: number;
  save: boolean;
  output: string | null;
  root: string;
  quiet: boolean;
  jsonOnly: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    days: 30,
    save: false,
    output: null,
    root: require(join(SKILLS_ROOT, "_shared/lib/log-paths.ts")).harnessLogsDir(),
    quiet: false,
    jsonOnly: false,
  };
  for (const a of argv) {
    if (a === "--save") out.save = true;
    else if (a === "--quiet") out.quiet = true;
    else if (a === "--json") out.jsonOnly = true;
    else if (a.startsWith("--days=")) out.days = Math.max(1, Math.min(365, Number(a.split("=")[1] ?? "30")));
    else if (a.startsWith("--output=")) out.output = resolve(a.split("=")[1] ?? "");
    else if (a.startsWith("--root=")) out.root = resolve(a.split("=")[1] ?? "");
    else if (a === "--help" || a === "-h") {
      console.log("usage: baseline.ts [--days=N] [--save|--output=PATH] [--root=PATH] [--quiet] [--json]");
      process.exit(0);
    } else {
      console.error(`baseline: unknown arg '${a}'`);
      process.exit(2);
    }
  }
  return out;
}

function isoDay(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function daysInWindow(end: Date, days: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(end);
    d.setUTCDate(d.getUTCDate() - i);
    out.push(isoDay(d));
  }
  return out;
}

interface TraceRecord {
  trace_id: string;
  events: { event: string; ts: number; raw: Record<string, unknown> }[];
  firstTs: number;
  lastTs: number;
  totalCostUsd: number;
  costEmissionCount: number;
  hasDispatch: boolean;
  hasGatePassed: boolean;
  hasGateFailed: boolean;
  hasValidationFailed: boolean;
  hasBriefAmplified: boolean;
  hasBriefReceived: boolean;
  hasDelivered: boolean;
  revisionCount: number;
  businessSlugs: Set<string>;
  squadNames: Set<string>;
}

function emptyTrace(traceId: string): TraceRecord {
  return {
    trace_id: traceId,
    events: [],
    firstTs: Number.POSITIVE_INFINITY,
    lastTs: 0,
    totalCostUsd: 0,
    costEmissionCount: 0,
    hasDispatch: false,
    hasGatePassed: false,
    hasGateFailed: false,
    hasValidationFailed: false,
    hasBriefAmplified: false,
    hasBriefReceived: false,
    hasDelivered: false,
    revisionCount: 0,
    businessSlugs: new Set(),
    squadNames: new Set(),
  };
}

async function streamFile(
  path: string,
  onLine: (lineNum: number, parsed: Record<string, unknown> | null, rawErr: Error | null) => void,
): Promise<void> {
  const stream = createReadStream(path, { encoding: "utf8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  let n = 0;
  for await (const raw of rl) {
    n++;
    const line = raw.trim();
    if (!line) continue;
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      onLine(n, obj, null);
    } catch (err) {
      onLine(n, null, err as Error);
    }
  }
}

function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function percentile(nums: number[], p: number): number | null {
  if (nums.length === 0) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)));
  return sorted[idx];
}

function confidenceFor(sampleSize: number): "high" | "medium" | "low" | "unmeasurable" {
  if (sampleSize === 0) return "unmeasurable";
  if (sampleSize < 10) return "low";
  if (sampleSize < 30) return "medium";
  return "high";
}

function gitSha(repoRoot: string): string | null {
  const res = spawnSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], { encoding: "utf8" });
  if (res.status !== 0) return null;
  return res.stdout.trim() || null;
}

async function collect(args: CliArgs): Promise<{
  traces: Map<string, TraceRecord>;
  eventCounts: Map<string, number>;
  orphanLines: number;
  parseErrors: number;
  scannedFiles: string[];
}> {
  const traces = new Map<string, TraceRecord>();
  const eventCounts = new Map<string, number>();
  let orphanLines = 0;
  let parseErrors = 0;
  const scannedFiles: string[] = [];

  if (!existsSync(args.root)) {
    return { traces, eventCounts, orphanLines, parseErrors, scannedFiles };
  }

  const windowEnd = new Date();
  const validDays = new Set(daysInWindow(windowEnd, args.days));

  const entries = readdirSync(args.root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && validDays.has(e.name))
    .map((e) => e.name)
    .sort();

  for (const dayDir of entries) {
    const file = join(args.root, dayDir, "audit.jsonl");
    if (!existsSync(file)) continue;
    scannedFiles.push(file);

    await streamFile(file, (_n, obj, err) => {
      if (err || !obj) {
        parseErrors++;
        return;
      }
      const event = typeof obj.event === "string" ? obj.event : null;
      if (!event) return;
      eventCounts.set(event, (eventCounts.get(event) ?? 0) + 1);

      const traceId = typeof obj.trace_id === "string" ? obj.trace_id : null;
      if (!traceId) {
        orphanLines++;
        return;
      }
      const tsStr = typeof obj.ts === "string" ? obj.ts : null;
      const ts = tsStr ? Date.parse(tsStr) : NaN;

      let tr = traces.get(traceId);
      if (!tr) {
        tr = emptyTrace(traceId);
        traces.set(traceId, tr);
      }
      if (!Number.isNaN(ts)) {
        if (ts < tr.firstTs) tr.firstTs = ts;
        if (ts > tr.lastTs) tr.lastTs = ts;
      }
      tr.events.push({ event, ts: Number.isNaN(ts) ? 0 : ts, raw: obj });

      switch (event) {
        case "cost_emission": {
          const cost = typeof obj.total_cost_usd === "number" ? obj.total_cost_usd : 0;
          tr.totalCostUsd += cost;
          tr.costEmissionCount++;
          break;
        }
        case "dispatch_business": {
          tr.hasDispatch = true;
          const b = obj.business_slug ?? obj.business; // alias agêntico (E3)
          if (typeof b === "string") tr.businessSlugs.add(b);
          break;
        }
        case "dispatch_squad": {
          tr.hasDispatch = true;
          const s = obj.squad_name ?? obj.squad; // alias agêntico (E3)
          if (typeof s === "string") tr.squadNames.add(s);
          break;
        }
        case "gate_passed":
          tr.hasGatePassed = true;
          break;
        case "gate_failed":
          tr.hasGateFailed = true;
          break;
        case "validation_failed":
          tr.hasValidationFailed = true;
          break;
        case "brief_amplified":
          tr.hasBriefAmplified = true;
          break;
        case "brief_received":
          tr.hasBriefReceived = true;
          break;
        case "delivered":
          tr.hasDelivered = true;
          break;
        case "revision":
          tr.revisionCount++;
          break;
        default:
          break;
      }
    });
  }

  return { traces, eventCounts, orphanLines, parseErrors, scannedFiles };
}

function buildKpis(
  traces: Map<string, TraceRecord>,
  evCounts?: Map<string, number>,
): Record<string, unknown> {
  const all = [...traces.values()];
  const gateDecided = all.filter((t) => t.hasGatePassed || t.hasGateFailed || t.hasValidationFailed);
  const dispatched = all.filter((t) => t.hasDispatch);
  // A trace is "passed" only if it has gate_passed AND no failure signal in the same trace.
  // Mixed signals (rare but possible across chunks/revisions) are conservatively counted as failed.
  const passed = gateDecided.filter((t) => t.hasGatePassed && !t.hasGateFailed && !t.hasValidationFailed).length;
  const failed = gateDecided.length - passed;

  const dispatchCosts = dispatched.map((t) => t.totalCostUsd).filter((v) => v > 0);
  const dispatchLatencies = dispatched
    .filter((t) => t.firstTs !== Number.POSITIVE_INFINITY && t.lastTs > t.firstTs)
    .map((t) => (t.lastTs - t.firstTs) / 1000);

  const firstPass = gateDecided.filter(
    (t) => t.hasGatePassed && !t.hasGateFailed && !t.hasValidationFailed && t.revisionCount === 0,
  ).length;

  const isPass = (t: TraceRecord) => t.hasGatePassed && !t.hasGateFailed && !t.hasValidationFailed;
  const ampDecided = gateDecided.filter((t) => t.hasBriefAmplified);
  const noAmpDecided = gateDecided.filter((t) => !t.hasBriefAmplified);
  const ampRate = ampDecided.length > 0 ? ampDecided.filter(isPass).length / ampDecided.length : null;
  const noAmpRate = noAmpDecided.length > 0 ? noAmpDecided.filter(isPass).length / noAmpDecided.length : null;
  const uplift = ampRate !== null && noAmpRate !== null ? ampRate - noAmpRate : null;

  const kpis: Record<string, unknown> = {};

  kpis.gate_pass_rate = {
    value: gateDecided.length > 0 ? passed / gateDecided.length : null,
    sample_size: gateDecided.length,
    confidence: confidenceFor(gateDecided.length),
    raw: { passed, failed, gate_decided: gateDecided.length },
    unmeasurable_reason: gateDecided.length === 0 ? "no gate_passed/gate_failed/validation_failed events in window" : null,
  };

  kpis.first_pass_pass_rate = {
    value: gateDecided.length > 0 ? firstPass / gateDecided.length : null,
    sample_size: gateDecided.length,
    confidence: confidenceFor(gateDecided.length),
    raw: { first_pass_passed: firstPass, gate_decided: gateDecided.length, traces_with_revision: gateDecided.filter((t) => t.revisionCount > 0).length },
    unmeasurable_reason: gateDecided.length === 0 ? "no gate decisions in window" : null,
  };

  kpis.mean_dispatch_cost_usd = {
    value: median(dispatchCosts),
    sample_size: dispatchCosts.length,
    confidence: confidenceFor(dispatchCosts.length),
    raw: {
      p50: median(dispatchCosts),
      p95: percentile(dispatchCosts, 95),
      total_usd: dispatchCosts.reduce((s, v) => s + v, 0),
      dispatches_observed: dispatched.length,
    },
    unmeasurable_reason: dispatchCosts.length === 0 ? "no traces with dispatch_business/dispatch_squad and non-zero cost" : null,
  };

  kpis.mean_dispatch_latency_seconds = {
    value: median(dispatchLatencies),
    sample_size: dispatchLatencies.length,
    confidence: confidenceFor(dispatchLatencies.length),
    raw: {
      p50: median(dispatchLatencies),
      p95: percentile(dispatchLatencies, 95),
    },
    unmeasurable_reason: dispatchLatencies.length === 0 ? "no traces with measurable first-to-last span" : null,
  };

  kpis.observability_recall = {
    value: null,
    sample_size: 0,
    confidence: "unmeasurable",
    raw: {},
    unmeasurable_reason: "phase 2 (trace viewer) not yet implemented; recall requires Fase 2 viewer",
  };

  kpis.regression_smoke_pass_rate = {
    value: null,
    sample_size: 0,
    confidence: "unmeasurable",
    raw: {},
    unmeasurable_reason: "phase 1 (regression suite) not yet implemented",
  };

  kpis.revision_loop_efficacy = {
    value: null,
    sample_size: 0,
    confidence: "unmeasurable",
    raw: { revision_events_in_window: all.reduce((s, t) => s + t.revisionCount, 0) },
    unmeasurable_reason: "phase 3 (judge + revision-dispatch) not yet implemented; revision events present but loop semantics absent",
  };

  kpis.memory_retrieval_precision_at_5 = {
    value: null,
    sample_size: 0,
    confidence: "unmeasurable",
    raw: {},
    unmeasurable_reason: "phase 6 (semantic memory) not yet implemented",
  };

  kpis.brief_amplification_uplift = {
    value: uplift,
    sample_size: ampDecided.length + noAmpDecided.length,
    confidence: confidenceFor(Math.min(ampDecided.length, noAmpDecided.length)),
    raw: {
      amplified_pass_rate: ampRate,
      not_amplified_pass_rate: noAmpRate,
      amplified_decided: ampDecided.length,
      not_amplified_decided: noAmpDecided.length,
    },
    unmeasurable_reason: uplift === null ? "need at least 1 amplified and 1 non-amplified gate decision" : null,
  };

  kpis.self_improver_proposals_accepted = {
    value: null,
    sample_size: 0,
    confidence: "unmeasurable",
    raw: {},
    unmeasurable_reason: "phase 8 (meta-Nirvana) not yet implemented",
  };

  return kpis;
}

function buildSnapshot(
  args: CliArgs,
  data: Awaited<ReturnType<typeof collect>>,
  kpis: Record<string, unknown>,
): Record<string, unknown> {
  const end = new Date();
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - args.days);

  const allTraces = data.traces;
  const dispatched = [...allTraces.values()].filter((t) => t.hasDispatch);
  const gateDecided = [...allTraces.values()].filter((t) => t.hasGatePassed || t.hasGateFailed || t.hasValidationFailed);

  const eventCountsObj: Record<string, number> = {};
  for (const [k, v] of [...data.eventCounts.entries()].sort()) eventCountsObj[k] = v;

  // Surface trace_id fragmentation between hook-emitted (cost_emission) and harness-emitted
  // (dispatch_business/dispatch_squad) events. When the two populations of trace_ids don't
  // overlap, cost-per-dispatch KPIs read as unmeasurable even though both signals exist.
  const dispatchedWithCost = dispatched.filter((t) => t.totalCostUsd > 0).length;
  const dispatchedNoCost = dispatched.length - dispatchedWithCost;
  const fragmentationNote =
    dispatched.length > 0 && dispatchedWithCost === 0
      ? `trace_id fragmentation detected: ${dispatched.length} dispatched traces have zero cost_emission rows. Hook-emitted cost events likely use claude-code session_id as trace_id while harness uses its own. Cost-per-dispatch KPIs require unifying these in a later phase.`
      : null;

  return {
    meta: {
      computed_at: new Date().toISOString(),
      window_days: args.days,
      window_start: start.toISOString(),
      window_end: end.toISOString(),
      audit_logs_root: args.root,
      schema_version: SCHEMA_VERSION,
      git_sha: gitSha(resolve(import.meta.dir, "..", "..", "..")),
      notes: fragmentationNote,
    },
    kpis,
    event_counts: eventCountsObj,
    trace_summary: {
      distinct_traces: allTraces.size,
      traces_with_dispatch: dispatched.length,
      traces_with_gate_decision: gateDecided.length,
      orphan_event_lines: data.orphanLines,
      dispatched_with_cost: dispatchedWithCost,
      dispatched_without_cost: dispatchedNoCost,
    },
  };
}

function humanSummary(snap: Record<string, unknown>): string {
  const meta = snap.meta as Record<string, unknown>;
  const trace = snap.trace_summary as Record<string, unknown>;
  const kpis = snap.kpis as Record<string, { value: number | null; sample_size: number; confidence: string }>;

  const fmt = (v: number | null, digits = 3) => (v === null ? "n/a" : v.toFixed(digits));

  return [
    `Nirvana baseline — window: ${meta.window_days}d (${(meta.window_start as string).slice(0, 10)} → ${(meta.window_end as string).slice(0, 10)})`,
    `Distinct traces: ${trace.distinct_traces}  |  dispatched: ${trace.traces_with_dispatch}  |  gate-decided: ${trace.traces_with_gate_decision}`,
    `Orphan event lines: ${trace.orphan_event_lines}`,
    ``,
    `KPI                                       value     n        confidence`,
    `---------------------------------------- --------- -------- -----------`,
    `gate_pass_rate                            ${fmt(kpis.gate_pass_rate.value).padEnd(9)} ${String(kpis.gate_pass_rate.sample_size).padEnd(8)} ${kpis.gate_pass_rate.confidence}`,
    `first_pass_pass_rate                      ${fmt(kpis.first_pass_pass_rate.value).padEnd(9)} ${String(kpis.first_pass_pass_rate.sample_size).padEnd(8)} ${kpis.first_pass_pass_rate.confidence}`,
    `mean_dispatch_cost_usd                    ${fmt(kpis.mean_dispatch_cost_usd.value, 4).padEnd(9)} ${String(kpis.mean_dispatch_cost_usd.sample_size).padEnd(8)} ${kpis.mean_dispatch_cost_usd.confidence}`,
    `mean_dispatch_latency_seconds             ${fmt(kpis.mean_dispatch_latency_seconds.value, 1).padEnd(9)} ${String(kpis.mean_dispatch_latency_seconds.sample_size).padEnd(8)} ${kpis.mean_dispatch_latency_seconds.confidence}`,
    `brief_amplification_uplift                ${fmt(kpis.brief_amplification_uplift.value).padEnd(9)} ${String(kpis.brief_amplification_uplift.sample_size).padEnd(8)} ${kpis.brief_amplification_uplift.confidence}`,
    ``,
    `Unmeasurable yet (await phases 1/2/3/6/8):`,
    `  observability_recall, regression_smoke_pass_rate, revision_loop_efficacy,`,
    `  memory_retrieval_precision_at_5, self_improver_proposals_accepted`,
  ].join("\n");
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  collect(args)
    .then((data) => {
      const kpis = buildKpis(data.traces, data.eventCounts);
      const snap = buildSnapshot(args, data, kpis);

      let outputPath: string | null = args.output;
      if (!outputPath && args.save) {
        const baselinesDir = resolve(import.meta.dir, "..", "baselines");
        mkdirSync(baselinesDir, { recursive: true });
        const todayDir = isoDay(new Date());
        outputPath = join(baselinesDir, `${todayDir}.json`);
      }

      if (outputPath) {
        writeFileSync(outputPath, JSON.stringify(snap, null, 2) + "\n", "utf8");
        if (!args.quiet) console.error(`baseline: wrote ${outputPath}`);
      }

      if (args.jsonOnly) {
        process.stdout.write(JSON.stringify(snap, null, 2) + "\n");
      } else {
        process.stdout.write(humanSummary(snap) + "\n");
      }
    })
    .catch((err) => {
      console.error(`baseline: failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    });
}

if (import.meta.main) {
  main();
}

export {
  parseArgs,
  daysInWindow,
  isoDay,
  median,
  percentile,
  confidenceFor,
  collect,
  buildKpis,
  buildSnapshot,
  emptyTrace,
};
