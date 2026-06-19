/**
 * brief-scorer.ts — heuristic 0-1 richness score of an incoming brief,
 * plus list of missing dimensions.
 *
 * No LLM call. Deterministic. Cached by content hash.
 *
 * Phase 4 da nirvana-evolution. Coexists with the LLM-based amplifier
 * already in router.js (Stage -2): scorer runs first and is cheap;
 * amplifier triggers only when scorer flags richness below threshold.
 *
 * Dimensions evaluated (each independently scored 0-1):
 *   - length         — adequate detail or single sentence?
 *   - objective      — verb of action + target outcome present?
 *   - audience       — for whom?
 *   - constraints    — time, budget, format, length, restrictions
 *   - examples       — references or contrast points
 *   - scope          — what's IN, what's OUT
 *   - success_criteria — how do we know we won?
 */

import { createHash } from "node:crypto";

export interface BriefScore {
  score: number;                 // 0-1; weighted average of dimensions
  dimensions: Record<DimensionKey, number>;
  missing_dimensions: DimensionKey[];   // dimensions with score < 0.5
  category_hint: CategoryKey | null;    // best-guess category
  word_count: number;
  reasons: string[];                    // human-readable diagnostics
  hash: string;                         // sha256 of brief, for cache
}

type DimensionKey = "length" | "objective" | "audience" | "constraints" | "examples" | "scope" | "success_criteria";
type CategoryKey = "marketing" | "content" | "code" | "design" | "research" | "juridical" | "fintech" | "generic";

const DIMENSION_WEIGHTS: Record<DimensionKey, number> = {
  length: 0.15,
  objective: 0.25,
  audience: 0.15,
  constraints: 0.15,
  examples: 0.10,
  scope: 0.10,
  success_criteria: 0.10,
};

// Heuristic keyword sets. Tuned to PT-BR + EN since briefs come in both.
const OBJECTIVE_VERBS = /\b(produz(?:a|ir)|cri(?:e|ar)|gere|gerar|escrev(?:a|er)|desenh(?:e|ar)|implement(?:e|ar)|construa|constru[íi]r|analis(?:e|ar)|pesquis(?:e|ar)|fa[çc]a|fazer|monte|montar|elabor(?:e|ar)|desenvolv(?:a|er)|propon(?:ha|ha-)|produce|create|generate|write|design|implement|build|analyze|research|make|develop|propose|draft|prepare)\b/i;
const AUDIENCE_HINTS = /\b(p[uú]blico|audi[êe]ncia|para (?:o |a )?(?:cliente|usu[áa]rio|leitor|comprador|investidor|advogado|m[ée]dico|gestor|CEO|engenheiro|estudante|crian[çc]a|m[ãa]e|pai)|stakeholders?|persona|target|audience|reader|user|customer|developer|admin|operator)\b/i;
const CONSTRAINT_HINTS = /\b(em (?:at[ée] )?\d+|max[ií]mo? de|m[íi]nimo de|prazo|deadline|or[çc]amento|budget|R\$\s*\d|\$\s*\d|word(?:s)?|palavras?|chars?|caracteres?|p[áa]ginas?|min(?:utos)?|hour(?:s)?|days?|dias?|WCAG|GDPR|LGPD|API|stack|tecnologia|formato)\b/i;
const EXAMPLE_HINTS = /\b(exemplo|por exemplo|como|tipo|similar a|inspirado em|baseado em|reference|example|like|similar|inspired)\b/i;
const SCOPE_IN_OUT = /\b(escopo|in[ -]?scope|out[ -]?of[ -]?scope|n[ãa]o (?:incluir|cobrir|abordar)|inclui(?:r)?|cobrir|abordar|fora do escopo)\b/i;
const SUCCESS_HINTS = /\b(sucesso|sucesso[s]?|crit[ée]rio[s]?|KPI|m[ée]trica|metric|target|alvo|goal|objetivo claro|measurable|mensur[áa]vel|definition of done)\b/i;

const CATEGORY_KEYWORDS: Record<CategoryKey, RegExp> = {
  marketing: /\b(campanha|posicionamento|concorr[êe]ncia|ads?|m[ií]dia|sem|seo|funil|lead|crm|brand|marca|engaj|conversão|conversao|posicionamento)\b/i,
  content: /\b(post|carrossel|reel|story|blog|artigo|livro|cap[ií]tulo|copy|newsletter|email|caption|legend)\b/i,
  code: /\b(api|endpoint|component(?:e)?|biblioteca|library|refator(?:ar|ação|acao)?|refactor|bug|fix|implement(?:ar|ação|acao)?|deploy|build|test|unit|integration|merge|pr|commit|typescript|javascript|python|go|rust|react|vue|angular|svelte|tsx|jsx|node|bun|express|fastify|django|flask|rails)\b/i,
  design: /\b(design|landing|hero|figma|wireframe|prototype|ui|ux|t[oô]ken|tokens|sistema de design|brand|logo|color|paleta|typography|tipografia)\b/i,
  research: /\b(pesquisa|research|invest[ií]gar|benchmark|compar(?:a|ar|ação|acao)|mercado|market|due[ -]?dilig[êe]ncia|relat[óo]rio)\b/i,
  juridical: /\b(jur[ií]dico|legal|contrato|parecer|peti[çc][ãa]o|jurisprud[êe]ncia|s[úu]mula|ac[óo]rd[ãa]o|stj|stf|trt|tjmg|cnj|lgpd|cdc|clt)\b/i,
  fintech: /\b(dre|fluxo de caixa|cashflow|valuation|equity|stock options|cap table|fintech|cr[ée]dito|pagamento|payment|bacen|cvm|pix|investor)\b/i,
  generic: /.^/, // never matches
};

function pickCategory(brief: string): CategoryKey | null {
  let best: { key: CategoryKey; matches: number } | null = null;
  for (const [key, rx] of Object.entries(CATEGORY_KEYWORDS) as [CategoryKey, RegExp][]) {
    if (key === "generic") continue;
    const matches = (brief.match(new RegExp(rx.source, "gi")) ?? []).length;
    if (matches > 0 && (!best || matches > best.matches)) best = { key, matches };
  }
  return best?.key ?? null;
}

function scoreLength(brief: string): { score: number; word_count: number } {
  const wc = brief.trim().split(/\s+/).filter(Boolean).length;
  // <5 words = vague; 5-20 = thin; 20-60 = adequate; 60+ = rich
  if (wc < 5) return { score: 0.1, word_count: wc };
  if (wc < 20) return { score: 0.4, word_count: wc };
  if (wc < 60) return { score: 0.75, word_count: wc };
  return { score: 0.95, word_count: wc };
}

function regexScore(brief: string, rx: RegExp): number {
  return rx.test(brief) ? 0.9 : 0.15;
}

function multiHitScore(brief: string, rx: RegExp): number {
  const matches = (brief.match(new RegExp(rx.source, "gi")) ?? []).length;
  if (matches === 0) return 0.15;
  if (matches === 1) return 0.6;
  return 0.9;
}

const _cache = new Map<string, BriefScore>();

export function scoreBrief(brief: string): BriefScore {
  const trimmed = brief.trim();
  const hash = createHash("sha256").update(trimmed).digest("hex").slice(0, 16);
  const cached = _cache.get(hash);
  if (cached) return cached;

  const lenSc = scoreLength(trimmed);
  const dims: Record<DimensionKey, number> = {
    length: lenSc.score,
    objective: regexScore(trimmed, OBJECTIVE_VERBS),
    audience: regexScore(trimmed, AUDIENCE_HINTS),
    constraints: multiHitScore(trimmed, CONSTRAINT_HINTS),
    examples: regexScore(trimmed, EXAMPLE_HINTS),
    scope: regexScore(trimmed, SCOPE_IN_OUT),
    success_criteria: regexScore(trimmed, SUCCESS_HINTS),
  };

  let weightedTotal = 0;
  for (const [k, w] of Object.entries(DIMENSION_WEIGHTS) as [DimensionKey, number][]) {
    weightedTotal += dims[k] * w;
  }

  const missing: DimensionKey[] = [];
  for (const k of Object.keys(dims) as DimensionKey[]) {
    if (dims[k] < 0.5) missing.push(k);
  }

  const reasons: string[] = [];
  if (lenSc.word_count < 20) reasons.push(`brief is short (${lenSc.word_count} words)`);
  if (dims.objective < 0.5) reasons.push("no clear action verb / objective");
  if (dims.audience < 0.5) reasons.push("audience/persona not specified");
  if (dims.constraints < 0.5) reasons.push("constraints (time, budget, format, length) not declared");
  if (dims.examples < 0.5) reasons.push("no example or reference point");
  if (dims.scope < 0.5) reasons.push("scope boundaries (IN/OUT) not declared");
  if (dims.success_criteria < 0.5) reasons.push("success criteria not measurable");

  const result: BriefScore = {
    score: Math.round(weightedTotal * 100) / 100,
    dimensions: dims,
    missing_dimensions: missing,
    category_hint: pickCategory(trimmed),
    word_count: lenSc.word_count,
    reasons,
    hash,
  };
  _cache.set(hash, result);
  return result;
}

export function clearCache(): void {
  _cache.clear();
}

export const __internal__ = { pickCategory, scoreLength, DIMENSION_WEIGHTS };
