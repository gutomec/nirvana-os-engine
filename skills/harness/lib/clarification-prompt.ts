/**
 * clarification-prompt.ts — generates 2-4 focused clarifying questions when
 * a brief's richness score is below the amplifier threshold.
 *
 * Phase 4 da nirvana-evolution.
 *
 * Sources:
 *  - missing_dimensions from brief-scorer
 *  - category-specific templates from templates/amplification/<category>.md
 *
 * Returns: array of `Question` plus a single combined prompt string suitable
 * for surfacing to the user (interactive mode) or feeding to the LLM
 * amplifier (inferred mode).
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import type { BriefScore } from "./brief-scorer.ts";

const TEMPLATES_DIR = join(import.meta.dir, "..", "templates", "amplification");

export interface Question {
  dimension: string;
  question: string;
  example_answer?: string;
}

export interface ClarificationOutput {
  questions: Question[];
  category: string | null;
  prompt: string;     // formatted block ready to show user
  inferred_assumptions: { dimension: string; assumption: string }[];
}

// Fallback questions when no template applies
const GENERIC_QUESTIONS: Record<string, Question> = {
  objective: {
    dimension: "objective",
    question: "Qual é o resultado concreto que você quer ao final?",
    example_answer: "Um post de blog de 1500 palavras com 3 takeaways acionáveis.",
  },
  audience: {
    dimension: "audience",
    question: "Para quem este entregável é destinado?",
    example_answer: "Pequenos empreendedores de e-commerce brasileiros.",
  },
  constraints: {
    dimension: "constraints",
    question: "Quais restrições devem ser respeitadas (prazo, orçamento, formato, tamanho)?",
    example_answer: "Entrega em 24h, máximo 2000 palavras, formato markdown.",
  },
  examples: {
    dimension: "examples",
    question: "Tem alguma referência ou exemplo de algo similar que aprovou?",
    example_answer: "Estilo similar ao blog da Stripe / artigos da Paul Graham.",
  },
  scope: {
    dimension: "scope",
    question: "O que está dentro e o que está fora do escopo?",
    example_answer: "Dentro: análise técnica. Fora: implementação de código.",
  },
  success_criteria: {
    dimension: "success_criteria",
    question: "Como você saberá que o entregável foi bem-sucedido?",
    example_answer: "Quando o relatório responder as 5 perguntas declaradas e gerar pelo menos 3 ações.",
  },
  length: {
    dimension: "length",
    question: "Pode dar mais detalhe sobre o contexto e o que você espera?",
    example_answer: "(qualquer detalhe ajuda)",
  },
};

interface CategoryTemplate {
  category: string;
  questions: Question[];
}

function loadTemplate(category: string): CategoryTemplate | null {
  const file = join(TEMPLATES_DIR, `${category}.md`);
  if (!existsSync(file)) return null;
  const raw = readFileSync(file, "utf8");
  // Format: H2 == dimension, body of section is the question (first paragraph),
  // followed by optional "_Example:_ ..." line.
  const questions: Question[] = [];
  const blocks = raw.split(/^##\s+/m).slice(1);
  for (const block of blocks) {
    const [header, ...rest] = block.split("\n");
    const dimension = header.trim().toLowerCase().replace(/\s+/g, "_");
    const body = rest.join("\n").trim();
    const questionLine = body.split("\n").find((l) => l.trim() && !l.toLowerCase().startsWith("_example"))?.trim() ?? "";
    const exampleMatch = body.match(/_Example:_\s*(.+)/i);
    if (questionLine) {
      questions.push({
        dimension,
        question: questionLine,
        example_answer: exampleMatch?.[1]?.trim(),
      });
    }
  }
  return { category, questions };
}

/**
 * Pick questions for the dimensions that scored below 0.5. Prefer
 * category-specific templates; fall back to GENERIC_QUESTIONS.
 *
 * Caps at `maxQuestions` (default 4) to avoid overwhelming the user.
 */
export function buildClarification(
  score: BriefScore,
  opts: { maxQuestions?: number; category?: string | null } = {},
): ClarificationOutput {
  const max = Math.max(1, Math.min(6, opts.maxQuestions ?? 4));
  const category = opts.category ?? score.category_hint ?? null;
  const template = category ? loadTemplate(category) : null;
  const templateByDim = new Map<string, Question>();
  if (template) for (const q of template.questions) templateByDim.set(q.dimension, q);

  const picked: Question[] = [];
  for (const dim of score.missing_dimensions) {
    if (picked.length >= max) break;
    const q = templateByDim.get(dim) ?? GENERIC_QUESTIONS[dim];
    if (q) picked.push(q);
  }

  const lines: string[] = [];
  lines.push(`Brief richness: ${(score.score * 100).toFixed(0)}/100${category ? ` (category: ${category})` : ""}`);
  lines.push("Para entregar com qualidade, preciso esclarecer:");
  for (let i = 0; i < picked.length; i++) {
    const q = picked[i];
    lines.push(`${i + 1}. ${q.question}`);
    if (q.example_answer) lines.push(`   exemplo: ${q.example_answer}`);
  }

  return {
    questions: picked,
    category,
    prompt: lines.join("\n"),
    inferred_assumptions: [],
  };
}

export const __internal__ = { loadTemplate, GENERIC_QUESTIONS };
