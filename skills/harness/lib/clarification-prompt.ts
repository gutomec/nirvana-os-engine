/**
 * clarification-prompt.ts — generates 2-4 focused clarifying questions when
 * a brief's richness score is below the amplifier threshold.
 *
 * Phase 4 of nirvana-evolution.
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
    question: "What concrete result do you want at the end?",
    example_answer: "A 1500-word blog post with 3 actionable takeaways.",
  },
  audience: {
    dimension: "audience",
    question: "Who is this deliverable for?",
    example_answer: "Small e-commerce entrepreneurs.",
  },
  constraints: {
    dimension: "constraints",
    question: "Which constraints must be respected (deadline, budget, format, size)?",
    example_answer: "Delivery within 24h, at most 2000 words, markdown format.",
  },
  examples: {
    dimension: "examples",
    question: "Is there a reference or example of something similar that you approved of?",
    example_answer: "A style similar to the Stripe blog / Paul Graham essays.",
  },
  scope: {
    dimension: "scope",
    question: "What is in scope and what is out of scope?",
    example_answer: "In: technical analysis. Out: code implementation.",
  },
  success_criteria: {
    dimension: "success_criteria",
    question: "How will you know the deliverable succeeded?",
    example_answer: "When the report answers the 5 stated questions and produces at least 3 actions.",
  },
  length: {
    dimension: "length",
    question: "Can you give more detail about the context and what you expect?",
    example_answer: "(any detail helps)",
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
  lines.push("To deliver with quality, I need to clarify:");
  for (let i = 0; i < picked.length; i++) {
    const q = picked[i];
    lines.push(`${i + 1}. ${q.question}`);
    if (q.example_answer) lines.push(`   example: ${q.example_answer}`);
  }

  return {
    questions: picked,
    category,
    prompt: lines.join("\n"),
    inferred_assumptions: [],
  };
}

export const __internal__ = { loadTemplate, GENERIC_QUESTIONS };
