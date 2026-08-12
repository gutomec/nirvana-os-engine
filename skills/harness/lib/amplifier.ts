/**
 * amplifier.ts — Phase 4 coordinator.
 *
 * Given a brief, decides one of:
 *   - skip:        brief is rich enough; proceed to dispatch
 *   - clarify:     return clarifying questions for user (interactive mode)
 *   - infer:       generate inferred assumptions, hand off to existing
 *                  LLM amplifier (router Stage -2) or proceed with assumptions
 *                  attached
 *
 * Coexists with the LLM-based amplifier already in router.js. The router's
 * amplifier ignores low-richness briefs by default (it ran historically only
 * on WEAK strength); this module is the deterministic complement.
 *
 * Phase 4 da nirvana-evolution.
 */

import { scoreBrief, type BriefScore } from "./brief-scorer.ts";
import { buildClarification, type ClarificationOutput, type Question } from "./clarification-prompt.ts";

let _audit: { emit: (e: string, payload: unknown, ctx?: unknown) => void } | null = null;
function audit() {
  if (_audit) return _audit;
  try { _audit = require("./audit.js"); return _audit!; }
  catch { _audit = { emit: () => {} }; return _audit!; }
}

export type Mode = "interactive" | "inferred" | "skip-if-rich";

export interface AmplifyOpts {
  threshold: number;              // 0-1; score below this triggers amplification
  mode: Mode;
  trace_id?: string;
  business_slug?: string;
  squad_name?: string;
  category_hint?: string | null;  // overrides scorer-detected category
  maxQuestions?: number;
}

export const DEFAULT_OPTS: AmplifyOpts = {
  threshold: 0.6,
  mode: "skip-if-rich",
};

export type AmplifyDecision =
  | { action: "skip"; score: BriefScore; reason: string }
  | { action: "clarify"; score: BriefScore; clarification: ClarificationOutput }
  | { action: "infer"; score: BriefScore; inferred_brief: string; assumptions: { dimension: string; assumption: string }[] };

/**
 * Inferred amplification — when user is non-interactive or explicit
 * `mode: "inferred"`, the amplifier fabricates conservative assumptions
 * for each missing dimension and emits them in the audit log so dispatch
 * can pass them as context to the target. The actual LLM-rich amplification
 * still goes through router.js Stage -2; this is the pre-flight deterministic
 * layer.
 */
function buildInferredAssumptions(score: BriefScore): { dimension: string; assumption: string }[] {
  const out: { dimension: string; assumption: string }[] = [];
  for (const dim of score.missing_dimensions) {
    switch (dim) {
      case "objective":
        out.push({ dimension: dim, assumption: "Assumindo que o objetivo é produzir o output mais comum para esta categoria, com qualidade publicável." });
        break;
      case "audience":
        out.push({ dimension: dim, assumption: "Assumindo audiência média do segmento; tom profissional, não técnico." });
        break;
      case "constraints":
        out.push({ dimension: dim, assumption: "Sem restrições declaradas: usando defaults razoáveis (PT-BR, formato padrão da categoria, prazo de até 24h)." });
        break;
      case "examples":
        out.push({ dimension: dim, assumption: "Sem referência declarada: o agente decide estilo conforme melhor prática da categoria." });
        break;
      case "scope":
        out.push({ dimension: dim, assumption: "Escopo interpretado como mínimo viável: entregável principal apenas, sem extras." });
        break;
      case "success_criteria":
        out.push({ dimension: dim, assumption: "Critério de sucesso: passar quality gate da rubric correspondente, sem revisão obrigatória." });
        break;
      case "length":
        out.push({ dimension: dim, assumption: "Comprimento alvo: padrão da categoria (post curto ≈ 200 palavras; longform ≈ 1500-2500)." });
        break;
    }
  }
  return out;
}

function attachAssumptions(brief: string, assumptions: { dimension: string; assumption: string }[]): string {
  if (assumptions.length === 0) return brief;
  const block = ["", "[inferred assumptions — please correct if wrong]"];
  for (const a of assumptions) block.push(`  - ${a.dimension}: ${a.assumption}`);
  return brief.trim() + "\n" + block.join("\n");
}

export function amplify(brief: string, opts: Partial<AmplifyOpts> = {}): AmplifyDecision {
  const cfg = { ...DEFAULT_OPTS, ...opts };
  const score = scoreBrief(brief);

  audit().emit("brief_scored", {
    score: score.score,
    word_count: score.word_count,
    missing_dimensions: score.missing_dimensions,
    category_hint: score.category_hint,
    hash: score.hash,
  }, {
    trace_id: cfg.trace_id,
    business_slug: cfg.business_slug,
    squad_name: cfg.squad_name,
  });

  if (score.score >= cfg.threshold) {
    return { action: "skip", score, reason: `richness ${score.score} >= threshold ${cfg.threshold}` };
  }

  if (cfg.mode === "interactive") {
    const clarification = buildClarification(score, {
      maxQuestions: cfg.maxQuestions ?? 4,
      category: cfg.category_hint ?? score.category_hint,
    });
    audit().emit("clarification_emitted", {
      questions: clarification.questions.length,
      category: clarification.category,
    }, { trace_id: cfg.trace_id });
    return { action: "clarify", score, clarification };
  }

  // inferred / skip-if-rich (which already returned above)
  const assumptions = buildInferredAssumptions(score);
  audit().emit("brief_amplified", {
    score_before: score.score,
    inferred_assumptions_count: assumptions.length,
    mode: cfg.mode,
    amplifier_used: "heuristic_inferred",
  }, { trace_id: cfg.trace_id });
  return {
    action: "infer",
    score,
    inferred_brief: attachAssumptions(brief, assumptions),
    assumptions,
  };
}

// Recursion guard helper: cap to 1 round of amplification. Caller checks
// `score.score < threshold && already_amplified === true` and proceeds with warning.
export function shouldAmplifyAgain(score: BriefScore, threshold: number, alreadyAmplifiedOnce: boolean): boolean {
  if (alreadyAmplifiedOnce) return false;
  return score.score < threshold;
}
