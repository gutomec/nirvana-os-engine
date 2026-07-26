/**
 * pattern-analyzer.ts — converts MiningReport findings into named, actionable
 * patterns the proposal-writer can act on.
 *
 * Phase 8 (meta-Nirvana) da nirvana-evolution.
 *
 * Pattern categories:
 *   - LOW_GATE_PASS_RATE: business with gate_pass_rate < 0.7 and trace_count >= 5
 *   - REVISION_HOTSPOT:   employee with revisions >= 3 in window
 *   - COST_OUTLIER:       trace whose cost is z >= 2.5 above mean
 *   - AMPLIFICATION_GAP:  pass_rate(amp) > pass_rate(no_amp) + 0.15, suggesting amplifier should run more often
 */

import type { MiningReport } from "./audit-miner.ts";

export type PatternKind =
  | "LOW_GATE_PASS_RATE"
  | "REVISION_HOTSPOT"
  | "COST_OUTLIER"
  | "AMPLIFICATION_GAP"
  | "SQUAD_FAILURE_RATE";

export interface Pattern {
  kind: PatternKind;
  severity: "low" | "medium" | "high";
  entity_type: "business" | "squad" | "employee" | "trace" | "global";
  entity_id: string;
  evidence: Record<string, unknown>;
  short_summary: string;
}

function severityFromRate(rate: number): Pattern["severity"] {
  if (rate < 0.5) return "high";
  if (rate < 0.7) return "medium";
  return "low";
}

export function analyzePatterns(report: MiningReport): Pattern[] {
  const out: Pattern[] = [];

  // 1. LOW_GATE_PASS_RATE per business
  for (const b of report.businesses) {
    if (b.trace_count < 5 || b.gate_pass_rate === null) continue;
    if (b.gate_pass_rate < 0.7) {
      out.push({
        kind: "LOW_GATE_PASS_RATE",
        severity: severityFromRate(b.gate_pass_rate),
        entity_type: "business",
        entity_id: b.business,
        evidence: {
          gate_pass_rate: b.gate_pass_rate,
          trace_count: b.trace_count,
          revision_count: b.revision_count,
          weakest_employees: b.weakest_employees,
        },
        short_summary: `Business '${b.business}' passes gate only ${(b.gate_pass_rate * 100).toFixed(0)}% of the time across ${b.trace_count} traces.`,
      });
    }
  }

  // 2. REVISION_HOTSPOT per employee
  for (const e of report.hot_employees) {
    if (e.revisions < 3) continue;
    out.push({
      kind: "REVISION_HOTSPOT",
      severity: e.revisions >= 8 ? "high" : e.revisions >= 5 ? "medium" : "low",
      entity_type: "employee",
      entity_id: e.employee,
      evidence: { revisions: e.revisions, businesses: e.businesses },
      short_summary: `Employee '${e.employee}' triggered ${e.revisions} revisions in the window across ${e.businesses.length} business(es).`,
    });
  }

  // 3. COST_OUTLIER per trace
  for (const t of report.high_cost_traces) {
    out.push({
      kind: "COST_OUTLIER",
      severity: "medium",
      entity_type: "trace",
      entity_id: t.trace_id,
      evidence: { cost_usd: t.cost_usd, business: t.business },
      short_summary: `Trace ${t.trace_id} cost $${t.cost_usd.toFixed(4)}${t.business ? ` (business '${t.business}')` : ""} — z-score ≥ 2.`,
    });
  }

  // 4. AMPLIFICATION_GAP — when amplified briefs pass MORE than non-amplified by ≥ 15pp,
  // the gate is paying off and we should amplify more often.
  const amp = report.amplification.amplified_pass_rate;
  const noAmp = report.amplification.not_amplified_pass_rate;
  if (amp !== null && noAmp !== null) {
    const gap = amp - noAmp;
    if (gap >= 0.15) {
      out.push({
        kind: "AMPLIFICATION_GAP",
        severity: gap >= 0.3 ? "high" : "medium",
        entity_type: "global",
        entity_id: "amplifier_threshold",
        evidence: { amplified_pass_rate: amp, not_amplified_pass_rate: noAmp, gap, amplified_count: report.amplification.brief_amplified_count },
        short_summary: `Amplified briefs pass ${(gap * 100).toFixed(0)}pp more than non-amplified. Consider lowering scorer threshold.`,
      });
    }
  }

  // 5. SQUAD_FAILURE_RATE
  for (const s of report.squads) {
    if (s.trace_count < 5 || s.gate_pass_rate === null) continue;
    if (s.gate_pass_rate < 0.7) {
      out.push({
        kind: "SQUAD_FAILURE_RATE",
        severity: severityFromRate(s.gate_pass_rate),
        entity_type: "squad",
        entity_id: s.squad,
        evidence: { gate_pass_rate: s.gate_pass_rate, trace_count: s.trace_count },
        short_summary: `Squad '${s.squad}' passes only ${(s.gate_pass_rate * 100).toFixed(0)}% in ${s.trace_count} traces.`,
      });
    }
  }

  return out;
}
