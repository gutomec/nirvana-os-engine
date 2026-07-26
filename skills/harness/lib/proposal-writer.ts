/**
 * proposal-writer.ts — turns analyzed patterns into actionable proposals.
 *
 * Each proposal has: title, rationale, hypothesis, proposed_change (textual diff
 * suggestion), expected_metric_delta. The actual diff application is manual —
 * proposals are reviewed by humans before applying.
 *
 * Phase 8 (meta-Nirvana) da nirvana-evolution.
 */

import type { Pattern } from "./pattern-analyzer.ts";

export interface Proposal {
  id: string;
  pattern_kind: Pattern["kind"];
  title: string;
  rationale: string;
  hypothesis: string;
  proposed_change: string;
  expected_metric_delta: string;
  entity_type: Pattern["entity_type"];
  entity_id: string;
  severity: Pattern["severity"];
  generated_at: string;
  status: "pending";
}

function uniqId(): string {
  return `prop-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function writeProposals(patterns: Pattern[]): Proposal[] {
  const out: Proposal[] = [];

  for (const p of patterns) {
    let title = "";
    let hypothesis = "";
    let proposed_change = "";
    let expected = "";

    switch (p.kind) {
      case "LOW_GATE_PASS_RATE": {
        title = `Investigate low gate pass-rate of '${p.entity_id}'`;
        hypothesis = `Either (a) the rubric for ${p.entity_id}'s deliverables is too strict, (b) the employees lack mind-clone grounding for the dominant brief type, or (c) the brief amplifier is not running and outputs lack context.`;
        proposed_change = [
          `1. Pull last 10 failing traces of '${p.entity_id}' and bucket by rubric criterion that scored lowest.`,
          `2. If a single criterion dominates → re-calibrate that criterion's weight or threshold in the rubric.`,
          `3. If multiple employees are listed in weakest_employees, review their prompt + mind-clone bindings.`,
          `4. Verify quality_gate.judge_enabled is on for this business.`,
        ].join("\n");
        expected = `gate_pass_rate of '${p.entity_id}' rises by ≥ 0.10 within 30 days.`;
        break;
      }
      case "REVISION_HOTSPOT": {
        title = `Reduce revisions of employee '${p.entity_id}'`;
        hypothesis = `Employee produces outputs that consistently fail one or two criteria, requiring revision. Either prompt is missing important constraints or mind-clone weights are off.`;
        proposed_change = [
          `1. Read the last 5 critique payloads where '${p.entity_id}' was the agent_or_employee.`,
          `2. Identify the recurring critique items (same suggested_fix appearing ≥ 3×).`,
          `3. Patch the employee's .md prompt with explicit guidance for those items.`,
          `4. If mind-clone bindings exist, re-weight or add a complementary clone.`,
        ].join("\n");
        expected = `Revisions for '${p.entity_id}' drop ≥ 50% in 14 days.`;
        break;
      }
      case "COST_OUTLIER": {
        title = `Audit cost outlier trace ${p.entity_id}`;
        hypothesis = `Trace burned far more tokens than peers, likely due to runaway handoffs, large amplified brief, or repeated revisions.`;
        proposed_change = [
          `1. Open the trace in /observability and identify which span dominates cost.`,
          `2. If a single agent loops, add a max_turns cap or stall-watchdog hint.`,
          `3. If the brief was amplified to a huge size, lower max_handoffs or tighten the amplifier persona.`,
        ].join("\n");
        expected = `No business produces a cost outlier z ≥ 2.5 in the following 30 days for the same deliverable type.`;
        break;
      }
      case "AMPLIFICATION_GAP": {
        title = `Lower brief amplifier threshold (positive uplift detected)`;
        hypothesis = `Briefs that went through amplification pass the gate significantly more than non-amplified ones, but the amplifier is gated by a richness threshold. Lowering the threshold would let more briefs benefit.`;
        proposed_change = [
          `1. Lower default_threshold in skills/harness/lib/amplifier.ts from 0.6 to 0.7 (catches more briefs).`,
          `2. Monitor brief_amplification_uplift over the next 14 days.`,
          `3. If uplift remains > 0.15, keep the new threshold; otherwise revert.`,
        ].join("\n");
        expected = `brief_amplification_uplift stays ≥ 0.15 with higher amplification volume (target: 1.5× more amplifications).`;
        break;
      }
      case "SQUAD_FAILURE_RATE": {
        title = `Audit squad '${p.entity_id}' failure rate`;
        hypothesis = `Squad fails the gate often. Likely: workflow has missing handoff step, rubric mismatch, or one agent fails consistently.`;
        proposed_change = [
          `1. Find the latest failing trace of '${p.entity_id}' in /observability.`,
          `2. Trace which agent / task emitted the failure-aligned events.`,
          `3. Patch the workflow or agent .md as appropriate.`,
        ].join("\n");
        expected = `Squad gate_pass_rate ≥ 0.85 within 30 days.`;
        break;
      }
    }

    out.push({
      id: uniqId(),
      pattern_kind: p.kind,
      title,
      rationale: p.short_summary,
      hypothesis,
      proposed_change,
      expected_metric_delta: expected,
      entity_type: p.entity_type,
      entity_id: p.entity_id,
      severity: p.severity,
      generated_at: new Date().toISOString(),
      status: "pending",
    });
  }

  return out;
}
