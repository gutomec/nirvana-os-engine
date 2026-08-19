/**
 * seat-sufficiency.js — can this seat execute without a clone?
 *
 * The per-task clone model (0.7.0) has a second half: when no clone elevates
 * the work, THE SEAT EXECUTES ON ITS OWN METHOD. That requires the employee
 * body to carry method — and until this file, nothing in the system read a
 * single byte after the frontmatter: a 2-line role label scored identically to
 * a 260-line operating manual on every gate (loader parses frontmatter only,
 * the audit's c3 checks that frontmatter EXISTS, check-clone-bindings reads
 * two fields).
 *
 * The measure is sections + decision content, NOT line count. Calibrated
 * against all 574 employees in the authoring library (2026-08-19): a naive
 * line bar flagged 86, but 58 of those are dense-shorts — real method in few
 * lines (`qa-antagonist`: 15 lines, 8 numbered reject-criteria). The rule
 * below splits the library 488 rich → 0 thin, 86 short → 28 thin, and every
 * short-side verdict was verified by reading.
 *
 * One-sentence principle: a seat is sufficient when its body carries at least
 * 5 decision-bearing lines organized under at least 2 section headings — or
 * compensates for a missing skeleton with sheer decision density (>= 10), or
 * for scarce markers with deep prose method (>= 4 sections and >= 1500 chars).
 *
 * A "decision line" is one of:
 *   - a DO/DON'T marker in either language (the forms live in DO_DONT_RE)
 *   - a number or threshold (percent, comparator, decimal — PT decimal comma
 *     included: rich files write "F1 0,63" — or a count with a unit)
 *   - a list item with >= 30 chars of substance (kills noun checklists like
 *     "1. Posicionamento" while keeping "1. Capacidade exposta sem evidência…")
 *   - a markdown table data row (threshold tables and decision matrices)
 *   - a fenced-code line, capped at 5 per block (a canonical output contract
 *     is method; a giant code dump must not buy sufficiency alone)
 *
 * Headings are H2/H3 plus bold-line pseudo-headings (`**Identidade**`), in any
 * language — structure counts, names do not.
 *
 * CommonJS on purpose (like handoff.js): consumed by Bun TS gates AND by the
 * node-CJS audit criteria.
 */
"use strict";

const HEADING_RE = /^#{2,3}\s+\S/;
const PSEUDO_HEADING_RE = /^\*\*[^*]{2,60}\*\*:?\s*$/;
const DO_DONT_RE = /\b(nunca|sempre|jamais|não\s+(?:faço|aprovo|aceito|entrego|invento|vendo)|never|always|do not|don't|reprovado|proibido|recuso|refuse|veto|rejeito|reject)\b/i;
const THRESHOLD_RE = /(\d+\s*%|[<>≥≤]=?\s*\d|\b\d+[.,]\d+\b|\b\d+\s*(x|vezes|segundos|min(utos)?|dias|horas|semanas|itens|linhas|palavras|rounds?|rodadas?)\b)/i;
const NUMBERED_ITEM_RE = /^\s*(\*\*)?\d+[.)]\s/;
const BULLET_ITEM_RE = /^\s*[-*•]\s+\S/;
const TABLE_ROW_RE = /^\s*\|.+\|\s*$/;
const TABLE_SEPARATOR_RE = /^\s*\|[\s:|-]+\|\s*$/;
const FENCE_RE = /^\s*(```|~~~)/;
const CODE_LINES_PER_BLOCK_CAP = 5;
const SUBSTANTIVE_ITEM_MIN_CHARS = 30;

/** Strip YAML frontmatter; returns the markdown body. */
function stripFrontmatter(content) {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(content);
  return m ? content.slice(m[0].length) : content;
}

/**
 * Judge a seat's body. Pass the BODY (after frontmatter) — or use
 * `sufficiencyOfFile(content)` below for whole-file convenience.
 *
 * @param {string} body
 * @returns {{ verdict: "sufficient"|"thin", signals: { headings: number, decisionLines: number, bodyChars: number, nonEmptyLines: number } }}
 */
function seatSufficiency(body) {
  let headings = 0;
  let decisionLines = 0;
  let bodyChars = 0;
  let nonEmptyLines = 0;
  let inCode = false;
  let codeLinesThisBlock = 0;

  for (const raw of String(body || "").split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    nonEmptyLines++;
    bodyChars += line.trim().length;

    if (FENCE_RE.test(line)) {
      inCode = !inCode;
      codeLinesThisBlock = 0;
      continue;
    }
    if (inCode) {
      // Code is method (an output contract, a runnable check) up to a point.
      if (codeLinesThisBlock < CODE_LINES_PER_BLOCK_CAP) {
        decisionLines++;
        codeLinesThisBlock++;
      }
      continue;
    }
    if (HEADING_RE.test(line) || PSEUDO_HEADING_RE.test(line.trim())) {
      headings++;
      continue;
    }
    const isTableRow = TABLE_ROW_RE.test(line) && !TABLE_SEPARATOR_RE.test(line);
    const isSubstantiveItem =
      (NUMBERED_ITEM_RE.test(line) || BULLET_ITEM_RE.test(line)) &&
      line.trim().length >= SUBSTANTIVE_ITEM_MIN_CHARS;
    if (isTableRow || isSubstantiveItem || DO_DONT_RE.test(line) || THRESHOLD_RE.test(line)) {
      decisionLines++;
    }
  }

  const sufficient =
    (headings >= 2 && decisionLines >= 5) ||   // skeleton + method
    decisionLines >= 10 ||                      // headless but dense
    (headings >= 4 && bodyChars >= 1500);       // prose-method: deep sections, few markers

  return {
    verdict: sufficient ? "sufficient" : "thin",
    signals: { headings, decisionLines, bodyChars, nonEmptyLines },
  };
}

/** Whole-file convenience: strips frontmatter first. */
function sufficiencyOfFile(content) {
  return seatSufficiency(stripFrontmatter(content));
}

module.exports = { seatSufficiency, sufficiencyOfFile, stripFrontmatter };
