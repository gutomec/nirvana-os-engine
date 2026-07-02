/**
 * revision-dispatch.ts — orchestrates the judge → critique → revise loop.
 *
 * Input:  initial artifact + dispatch context.
 * Output: final artifact + judge history.
 *
 * Loop:
 *   1. judge(artifact) → verdict
 *   2. if pass → return immediately
 *   3. if fail and revisions_used < max_revisions → call revise() to produce
 *      new artifact, increment counter, go to (1)
 *   4. if max_revisions reached → emit revision_loop_exhausted, return last
 *      artifact with verdict=fail.
 *
 * Phase 3 da nirvana-evolution.
 *
 * Note: `revise` is provided by the caller because what counts as a
 * "re-dispatch" depends on the target type (business employee turn, squad
 * agent call, single-shot LLM regeneration). This module is purely
 * orchestration.
 */

import type { RubricMeta } from "./rubric-selector.ts";
import type { JudgeOutput } from "./judge.ts";
import { judge, type JudgeInput, type JudgeOpts } from "./judge.ts";
import { buildRevisionInstruction, type RevisionInstruction } from "./critique.ts";

let _audit: { emit: (e: string, payload: unknown, ctx?: unknown) => void } | null = null;
function audit() {
  if (_audit) return _audit;
  try { _audit = require("./audit.js"); return _audit!; }
  catch { _audit = { emit: () => {} }; return _audit!; }
}

export interface ReviseFn {
  (params: {
    previous_artifact: string;
    revision_instruction: RevisionInstruction;
    attempt_index: number;
  }): Promise<{ artifact: string; cost_usd?: number; latency_ms?: number; error?: string }>;
}

export interface LoopOpts {
  max_revisions: number;
  judgeOpts?: JudgeOpts;
}

export interface LoopResult {
  final_artifact: string;
  final_verdict: "pass" | "fail";
  attempts: { judge_output: JudgeOutput; artifact: string; revision?: RevisionInstruction; revise_error?: string }[];
  total_revisions: number;
  exhausted: boolean;
  total_judge_calls: number;
}

export const DEFAULT_MAX_REVISIONS = 2;

export async function runRevisionLoop(
  initialInput: JudgeInput,
  revise: ReviseFn,
  opts: Partial<LoopOpts> = {},
): Promise<LoopResult> {
  const max = Math.max(0, Math.min(5, opts.max_revisions ?? DEFAULT_MAX_REVISIONS));
  const attempts: LoopResult["attempts"] = [];
  let currentArtifact = initialInput.artifact;
  let revisions = 0;

  while (true) {
    const inputForJudge: JudgeInput = { ...initialInput, artifact: currentArtifact };
    const verdict = await judge(inputForJudge, opts.judgeOpts);
    const attempt: LoopResult["attempts"][number] = { judge_output: verdict, artifact: currentArtifact };

    if (verdict.verdict === "pass" || revisions >= max) {
      attempts.push(attempt);
      if (verdict.verdict !== "pass") {
        audit().emit("revision_loop_exhausted", {
          rubric_name: verdict.rubric_name,
          total_revisions: revisions,
          final_score: verdict.total_score,
          pass_threshold: initialInput.rubric.pass_threshold,
        }, {
          trace_id: initialInput.trace_id,
          business_slug: initialInput.business_slug,
          squad_name: initialInput.squad_name,
        });
      }
      return {
        final_artifact: currentArtifact,
        final_verdict: verdict.verdict,
        attempts,
        total_revisions: revisions,
        exhausted: verdict.verdict !== "pass" && revisions >= max,
        total_judge_calls: attempts.length,
      };
    }

    const instruction = buildRevisionInstruction(verdict, initialInput.rubric.pass_threshold);
    attempt.revision = instruction;

    audit().emit("revision_dispatched", {
      rubric_name: verdict.rubric_name,
      attempt_index: revisions + 1,
      previous_score: verdict.total_score,
      priority_items: instruction.priority_items.length,
    }, {
      trace_id: initialInput.trace_id,
      business_slug: initialInput.business_slug,
      squad_name: initialInput.squad_name,
    });

    let revised: Awaited<ReturnType<ReviseFn>>;
    try {
      revised = await revise({
        previous_artifact: currentArtifact,
        revision_instruction: instruction,
        attempt_index: revisions + 1,
      });
    } catch (e) {
      attempt.revise_error = (e as Error).message;
      attempts.push(attempt);
      audit().emit("revision_loop_exhausted", {
        rubric_name: verdict.rubric_name,
        total_revisions: revisions,
        final_score: verdict.total_score,
        reason: "revise_callback_threw",
        error: attempt.revise_error,
      }, { trace_id: initialInput.trace_id });
      return {
        final_artifact: currentArtifact,
        final_verdict: "fail",
        attempts,
        total_revisions: revisions,
        exhausted: true,
        total_judge_calls: attempts.length,
      };
    }

    if (revised.error || !revised.artifact) {
      attempt.revise_error = revised.error ?? "empty_artifact";
      attempts.push(attempt);
      audit().emit("revision_loop_exhausted", {
        rubric_name: verdict.rubric_name,
        total_revisions: revisions,
        final_score: verdict.total_score,
        reason: "revise_returned_error",
        error: attempt.revise_error,
      }, { trace_id: initialInput.trace_id });
      return {
        final_artifact: currentArtifact,
        final_verdict: "fail",
        attempts,
        total_revisions: revisions,
        exhausted: true,
        total_judge_calls: attempts.length,
      };
    }

    attempts.push(attempt);
    currentArtifact = revised.artifact;
    revisions++;
  }
}
