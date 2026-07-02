/**
 * critique.ts — transforms a JudgeOutput into a revision instruction the
 * target agent can act on.
 *
 * Sorts critique items by severity (high → medium → low), filters to fixable,
 * groups by criterion, and renders a single prompt fragment.
 *
 * Phase 3 da nirvana-evolution.
 */

import type { JudgeOutput, CritiqueItem } from "./judge.ts";

const SEVERITY_ORDER: Record<CritiqueItem["severity"], number> = { high: 0, medium: 1, low: 2 };

export interface RevisionInstruction {
  rubric_name: string;
  previous_score: number;
  pass_threshold: number;
  priority_items: CritiqueItem[];
  prompt_fragment: string;
}

/**
 * Order critique by severity (descending). Stable for identical severities.
 */
export function prioritize(critique: CritiqueItem[]): CritiqueItem[] {
  return [...critique]
    .map((c, i) => ({ c, i }))
    .sort((a, b) => {
      const ds = SEVERITY_ORDER[a.c.severity] - SEVERITY_ORDER[b.c.severity];
      return ds !== 0 ? ds : a.i - b.i;
    })
    .map((x) => x.c);
}

/**
 * Build the revision instruction text given the judge verdict. The text is
 * embedded into the next dispatch prompt as a "you must fix" preamble.
 *
 * Strategy:
 *  - Surface up to 6 highest-severity items (max user-visible noise)
 *  - Keep the original output in the prompt as reference
 *  - Mark which criteria FAILED specifically (caller may want to skip
 *    revising criteria already passed)
 */
export function buildRevisionInstruction(
  judgeOutput: JudgeOutput,
  passThreshold: number,
  maxItems = 6,
): RevisionInstruction {
  const priority = prioritize(judgeOutput.critique).slice(0, maxItems);
  const failedCriteria = judgeOutput.criteria_scores.filter(
    (c) => c.score / 10 < (passThreshold / 100),
  );

  const lines: string[] = [];
  lines.push(`The previous output failed quality gate '${judgeOutput.rubric_name}' with score ${judgeOutput.total_score}/${passThreshold}.`);
  lines.push("");
  lines.push("You MUST address the following issues, in priority order:");
  for (let i = 0; i < priority.length; i++) {
    const it = priority[i];
    lines.push(`${i + 1}. [${it.severity.toUpperCase()}] ${it.issue}`);
    if (it.suggested_fix) lines.push(`   → suggested fix: ${it.suggested_fix}`);
  }
  if (failedCriteria.length > 0) {
    lines.push("");
    lines.push(`Criteria below their pass score: ${failedCriteria.map((c) => c.name).join(", ")}.`);
    lines.push("Focus your changes on these. Do NOT touch criteria already passing.");
  }
  lines.push("");
  lines.push("Produce the revised output. Same format as before. Do not explain your changes; just deliver.");

  return {
    rubric_name: judgeOutput.rubric_name,
    previous_score: judgeOutput.total_score,
    pass_threshold: passThreshold,
    priority_items: priority,
    prompt_fragment: lines.join("\n"),
  };
}
