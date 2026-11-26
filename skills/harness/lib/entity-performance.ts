// entity-performance.ts — what the audit says about one business or one squad.
//
// The audit records every run, trace by trace. This reads a window of it and
// answers per entity: how many runs, how each ended, how often the gate passed
// at the first round, how many correction rounds it took, how long, how much,
// and which findings keep coming back.
//
// Where each number comes from:
//   entity        `dispatch_business.business_slug`, `dispatch_squad.squad_slug`
//                 (+ `capability_id`). A trace that dispatched a business is
//                 that business's run; the squads it used inside are not
//                 credited with its outcome.
//   outcome       the last `delivered` (with `reservations: true` or an
//                 `x_delivered_with_reservations` in the trace) or
//                 `x_delivery_withheld`; with neither, `verify_failed`,
//                 `agent_exec_failed` or `squad_run_failed` make it failed.
//   gate          `gate_passed` / `gate_failed`; a correction round is a
//                 `revision_auto` not marked `counted: false`.
//   duration      from the dispatch event to the first outcome event.
//   cost          `agent_executed.cost_usd`, when the runtime reported one.
//   findings      `failed_rubrics` on `revision_auto` and `gate_failed`; for a
//                 run from before that field, the run's section of
//                 `_GATE-FINDINGS.md` when an event names its outputs folder,
//                 and the `serious` lines of `x_delivery_withheld`.
//
// A value the audit does not hold is null, never zero.

import * as fs from "node:fs";
import * as path from "node:path";
import { build, type TraceTree } from "./trace-builder.ts";
import { harnessLogsDir } from "../../_shared/lib/log-paths.ts";
import { GATE_FINDINGS_FILE, MATERIAL_DEFECT, UNPROVEN_CRITERION } from "./delivery-pipeline.ts";

export type EntityKind = "business" | "squad";
export type RunOutcome = "delivered" | "delivered_with_reservations" | "withheld" | "failed" | "other";

export interface FindingCount {
  finding: string;
  /** Runs of this entity in which the finding failed at least once. */
  runs: number;
}

export interface EntityPerformance {
  kind: EntityKind;
  slug: string;
  runs: number;
  delivered: number;
  delivered_with_reservations: number;
  withheld: number;
  failed: number;
  /** Runs with no recorded end: still running, stopped, or waiting on a quota. */
  other: number;
  /** Runs that reached the quality gate. */
  gated_runs: number;
  /** Gated runs whose first gate round passed ÷ gated runs. Null with no gated run. */
  first_pass_gate_rate: number | null;
  /** Mean correction rounds over the gated runs. Null with no gated run. */
  mean_correction_rounds: number | null;
  /** Median time from dispatch to the first outcome. Null when no run has both. */
  median_duration_ms: number | null;
  /** Sum of the worker costs the runtimes reported. Null when none reported one. */
  total_cost_usd: number | null;
  /** Runs behind `total_cost_usd`. */
  cost_known_runs: number;
  /** Gated runs whose failures are known by name (a first-pass run counts: it has none). */
  findings_known_runs: number;
  /** Most frequent first. */
  findings: FindingCount[];
  /** Squads only: the capabilities that ran, most frequent first. */
  capabilities: { id: string; runs: number }[];
  last_run_at: string | null;
}

export interface PerformanceReport {
  window_days: number;
  logs_root: string;
  generated_at: string;
  /** Sorted by runs, most first. */
  entities: EntityPerformance[];
}

export interface PerformanceOptions {
  /** Window in days (default 30). */
  days?: number;
  /** Audit logs root. Default: the project's, as every reader resolves it. */
  root?: string;
  /** Where the project is, when `root` is not given. */
  cwd?: string;
}

interface RunFacts {
  outcome: RunOutcome;
  gated: boolean;
  firstPass: boolean;
  corrections: number;
  durationMs: number | null;
  costUsd: number | null;
  /** Null when the run failed the gate and nothing names what failed. */
  findings: Set<string> | null;
  startedAt: number;
  capabilities: string[];
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** The failures one run's section of `_GATE-FINDINGS.md` names, or null when
 *  the file or the section is not there. The file is shared by every run that
 *  wrote to the same folder, so only the sections headed by this trace count. */
function findingsFromFile(outputsRoot: string, traceId: string): Set<string> | null {
  let text: string;
  try { text = fs.readFileSync(path.join(outputsRoot, GATE_FINDINGS_FILE), "utf8"); } catch { return null; }
  const out = new Set<string>();
  let mine = false, seen = false;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("## Gate run · ")) { mine = line.startsWith(`## Gate run · ${traceId} · `); seen ||= mine; continue; }
    if (!mine || !line.startsWith("- ")) continue;
    if (line.includes("· judge: material defect")) out.add(MATERIAL_DEFECT);
    else if (/^- \*\*SERIOUS\*\* blocking criterion /.test(line)) out.add(UNPROVEN_CRITERION);
    else { const m = line.match(/^- (?:\*\*SERIOUS\*\* )?`[^`]*` · `([^`]+)`/); if (m) out.add(m[1]); }
  }
  return seen ? out : null;
}

/** The names behind the `serious` lines of an `x_delivery_withheld`. */
function findingsFromSerious(lines: unknown): string[] {
  if (!Array.isArray(lines)) return [];
  const out: string[] = [];
  for (const l of lines) {
    const s = str(l);
    const m = s.match(/: (\S+) failed$/);
    if (m) out.push(m[1]);
    else if (s.includes("material defect")) out.push(MATERIAL_DEFECT);
    else if (s.includes("blocking criterion")) out.push(UNPROVEN_CRITERION);
  }
  return out;
}

function factsOf(t: TraceTree, dispatchEvent: string): RunFacts {
  let dispatchTs = 0, firstOutcomeTs = 0;
  let last: RunOutcome | null = null;
  let failure = false, reservations = false;
  let firstGate: "pass" | "fail" | null = null;
  let corrections = 0, correctionsBeforeGate = 0;
  let cost: number | null = null;
  const named = new Set<string>();
  let namedByAudit = false;
  const roots = new Set<string>();
  const capabilities: string[] = [];

  for (const sp of t.spans) {
    const p = sp.payload as Record<string, unknown>;
    for (const k of ["outputs_root", "outputs_dir"]) if (str(p[k])) roots.add(str(p[k]));
    if (Array.isArray(p.failed_rubrics)) { namedByAudit = true; for (const r of p.failed_rubrics) if (str(r)) named.add(str(r)); }
    const outcomeAt = () => { if (!firstOutcomeTs && dispatchTs) firstOutcomeTs = sp.ts; };
    switch (sp.event) {
      case dispatchEvent:
        dispatchTs ||= sp.ts;
        if (str(p.capability_id)) capabilities.push(str(p.capability_id));
        break;
      case "revision_auto":
        if (p.counted !== false) { corrections++; if (!firstGate) correctionsBeforeGate++; }
        break;
      case "gate_passed": firstGate ??= "pass"; break;
      case "gate_failed": firstGate ??= "fail"; break;
      case "x_delivered_with_reservations": reservations = true; break;
      case "delivered":
        last = p.reservations === true || reservations ? "delivered_with_reservations" : "delivered";
        reservations = false;
        outcomeAt();
        break;
      case "x_delivery_withheld":
        last = "withheld";
        for (const f of findingsFromSerious(p.serious)) named.add(f);
        outcomeAt();
        break;
      case "verify_failed": case "squad_run_failed":
        failure = true; outcomeAt();
        break;
      case "agent_exec_failed":
        // The judge of a comparison failing is not the entity's run failing.
        if (str(p.employee) !== "judge-x") { failure = true; outcomeAt(); }
        break;
      case "agent_executed":
        if (typeof p.cost_usd === "number" && str(p.employee) !== "judge-x") cost = (cost ?? 0) + p.cost_usd;
        break;
    }
  }

  const gated = firstGate !== null;
  // The gate's events carry the final round only: a run that passed after a
  // correction failed first, so "first pass" also needs zero rounds before it.
  const firstPass = firstGate === "pass" && correctionsBeforeGate === 0;
  let findings: Set<string> | null = null;
  if (gated) {
    if (firstPass && corrections === 0) findings = new Set();
    else if (namedByAudit) findings = named;
    else {
      for (const root of roots) {
        const fromFile = findingsFromFile(root, t.trace_id);
        if (fromFile) { findings = new Set([...named, ...fromFile]); break; }
      }
      if (!findings && named.size) findings = named;
    }
  }
  return {
    outcome: last ?? (failure ? "failed" : "other"),
    gated, firstPass, corrections,
    durationMs: dispatchTs && firstOutcomeTs >= dispatchTs ? firstOutcomeTs - dispatchTs : null,
    costUsd: cost, findings, startedAt: dispatchTs || t.start_ts, capabilities,
  };
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function aggregate(kind: EntityKind, slug: string, runs: RunFacts[]): EntityPerformance {
  const count = (o: RunOutcome) => runs.filter(r => r.outcome === o).length;
  const gated = runs.filter(r => r.gated);
  const costs = runs.map(r => r.costUsd).filter((v): v is number => v !== null);
  const byFinding = new Map<string, number>();
  for (const r of gated) for (const f of r.findings ?? []) byFinding.set(f, (byFinding.get(f) ?? 0) + 1);
  const byCapability = new Map<string, number>();
  for (const r of runs) for (const id of new Set(r.capabilities)) byCapability.set(id, (byCapability.get(id) ?? 0) + 1);
  const ranked = <K extends string>(m: Map<string, number>, key: K) =>
    [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name, n]) => ({ [key]: name, runs: n })) as ({ [P in K]: string } & { runs: number })[];
  const lastStart = Math.max(0, ...runs.map(r => r.startedAt));
  return {
    kind, slug,
    runs: runs.length,
    delivered: count("delivered"),
    delivered_with_reservations: count("delivered_with_reservations"),
    withheld: count("withheld"),
    failed: count("failed"),
    other: count("other"),
    gated_runs: gated.length,
    first_pass_gate_rate: gated.length ? gated.filter(r => r.firstPass).length / gated.length : null,
    mean_correction_rounds: gated.length ? gated.reduce((s, r) => s + r.corrections, 0) / gated.length : null,
    median_duration_ms: median(runs.map(r => r.durationMs).filter((v): v is number => v !== null)),
    total_cost_usd: costs.length ? costs.reduce((a, b) => a + b, 0) : null,
    cost_known_runs: costs.length,
    findings_known_runs: gated.filter(r => r.findings !== null).length,
    findings: ranked(byFinding, "finding"),
    capabilities: ranked(byCapability, "id"),
    last_run_at: lastStart ? new Date(lastStart).toISOString() : null,
  };
}

/** A dispatch that only wrote the scaffold, with nothing after it, ran nothing. */
function scaffoldOnly(t: TraceTree): boolean {
  const ran = new Set(["gate_passed", "gate_failed", "delivered", "x_delivery_withheld", "verify_failed", "verify_passed", "agent_executed", "agent_exec_failed"]);
  const dispatches = t.spans.filter(s => s.event === "dispatch_business");
  return dispatches.length > 0 && dispatches.every(s => s.payload.mode === "scaffold-only") && !t.spans.some(s => ran.has(s.event));
}

export async function entityPerformance(opts: PerformanceOptions = {}): Promise<PerformanceReport> {
  const days = Math.max(1, Math.min(365, Math.floor(opts.days ?? 30)));
  const root = opts.root ?? harnessLogsDir({ cwd: opts.cwd });
  const { traces } = await build({ root, days, limit: Number.MAX_SAFE_INTEGER });
  const runsOf = new Map<string, RunFacts[]>();
  const add = (kind: EntityKind, slug: string, facts: RunFacts) => {
    const key = `${kind}:${slug}`;
    if (!runsOf.has(key)) runsOf.set(key, []);
    runsOf.get(key)!.push(facts);
  };
  for (const t of traces) {
    const business = new Set<string>(), squads = new Set<string>();
    for (const sp of t.spans) {
      const p = sp.payload as Record<string, unknown>;
      if (sp.event === "dispatch_business" && str(p.business_slug ?? p.business)) business.add(str(p.business_slug ?? p.business));
      if (sp.event === "dispatch_squad" && str(p.squad_slug ?? p.squad_name ?? p.squad)) squads.add(str(p.squad_slug ?? p.squad_name ?? p.squad));
    }
    if (business.size) {
      if (scaffoldOnly(t)) continue;
      const facts = factsOf(t, "dispatch_business");
      for (const slug of business) add("business", slug, facts);
    } else if (squads.size) {
      const facts = factsOf(t, "dispatch_squad");
      for (const slug of squads) add("squad", slug, facts);
    }
  }
  const entities = [...runsOf.entries()].map(([key, runs]) => {
    const cut = key.indexOf(":");
    return aggregate(key.slice(0, cut) as EntityKind, key.slice(cut + 1), runs);
  }).sort((a, b) => b.runs - a.runs || a.slug.localeCompare(b.slug));
  return { window_days: days, logs_root: root, generated_at: new Date().toISOString(), entities };
}

/** A finding travels to the worker once the entity has this many gated runs... */
export const RECURRING_MIN_GATED_RUNS = 3;
/** ...and the same finding failed in this many of them. */
export const RECURRING_MIN_RUNS = 2;
const RECURRING_MAX_LISTED = 5;

/** The findings of one entity that came back often enough to say up front. */
export function recurringFindings(e: EntityPerformance | undefined): FindingCount[] {
  if (!e || e.gated_runs < RECURRING_MIN_GATED_RUNS) return [];
  return e.findings.filter(f => f.runs >= RECURRING_MIN_RUNS).slice(0, RECURRING_MAX_LISTED);
}

/**
 * The block a dispatch appends to its worker's directive when the entity's
 * gate keeps failing on the same things, or "" when it does not. Never throws:
 * a dispatch must not depend on being able to read its own history.
 */
export async function recurringFindingsDirective(kind: EntityKind, slug: string, opts: PerformanceOptions = {}): Promise<string> {
  try {
    if (!slug) return "";
    const report = await entityPerformance(opts);
    const entity = report.entities.find(e => e.kind === kind && e.slug === slug);
    const found = recurringFindings(entity);
    if (!found.length) return "";
    const n = entity!.gated_runs;
    return `\nRECURRING FINDINGS for this ${kind} in its last ${n} runs: ${found.map(f => `${f.finding} (${f.runs} of ${n} runs)`).join("; ")}. Get these right the first time.`;
  } catch { return ""; }
}
