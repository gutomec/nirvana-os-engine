/**
 * volume-bounds.js — deterministic word-count check against a declared target.
 *
 * Runs before the LLM judge. Cheap, exact, no API call. The judge sees the
 * deterministic verdict and can use it as evidence rather than re-counting.
 *
 * A "target" can come from any of these (callers choose which to pass):
 *   - { target_words: [min, max] }       e.g. [7000, 9000]
 *   - { word_target: 8000, tolerance: 0.20 }   single point ± tolerance
 *   - { min_words: 500 }                 floor only, no ceiling
 *
 * Returns { verdict, count, target, deviation, message }.
 *   verdict ∈ 'pass' | 'over' | 'under' | 'skipped'
 *
 * Word counting: whitespace-split after stripping HTML/Markdown decoration.
 * Not perfect for CJK languages (those need character-based counts) — caller
 * can pass `mode: 'chars'` to fall back to graphemes.
 */

'use strict';

function countWords(text, mode = 'words') {
  if (!text) return 0;
  if (mode === 'chars') return [...text.replace(/\s+/g, '')].length;
  // Strip code fences (don't count code as prose). Preserve their absence.
  const stripped = text
    .replace(/```[\s\S]*?```/g, ' ')           // fenced code blocks
    .replace(/`[^`\n]+`/g, ' ')                // inline code
    .replace(/<[^>]+>/g, ' ')                  // HTML tags
    .replace(/!\[[^\]]*\]\([^)]+\)/g, ' ')     // markdown images
    .replace(/\[[^\]]*\]\([^)]+\)/g, ' ')      // markdown links → drop the URL but the text already counts
    .replace(/[#*_>\-]+/g, ' ')                // markdown decoration
    .replace(/\s+/g, ' ')
    .trim();
  if (!stripped) return 0;
  return stripped.split(' ').filter(Boolean).length;
}

function resolveTarget(target) {
  if (!target || typeof target !== 'object') return null;
  if (Array.isArray(target.target_words) && target.target_words.length === 2) {
    const [min, max] = target.target_words.map(Number);
    if (Number.isFinite(min) && Number.isFinite(max)) return { kind: 'range', min, max };
  }
  if (Number.isFinite(target.word_target)) {
    const tol = Number.isFinite(target.tolerance) ? Number(target.tolerance) : 0.20;
    const point = Number(target.word_target);
    return { kind: 'point', point, min: Math.round(point * (1 - tol)), max: Math.round(point * (1 + tol)), tolerance: tol };
  }
  if (Number.isFinite(target.min_words)) {
    return { kind: 'floor', min: Number(target.min_words), max: null };
  }
  return null;
}

function check({ text, target, mode }) {
  const t = resolveTarget(target);
  if (!t) {
    return { verdict: 'skipped', count: countWords(text, mode), target: null, message: 'no target declared' };
  }
  const count = countWords(text, mode);
  if (t.max != null && count > t.max) {
    const overBy = count - t.max;
    const overPct = Math.round((overBy / t.max) * 100);
    return {
      verdict: 'over',
      count,
      target: t,
      deviation: { absolute: overBy, percent: overPct },
      message: `word count ${count} exceeds upper bound ${t.max} by ${overPct}% (+${overBy} words). Overdelivery may indicate scope drift.`,
    };
  }
  if (t.min != null && count < t.min) {
    const underBy = t.min - count;
    const underPct = Math.round((underBy / t.min) * 100);
    return {
      verdict: 'under',
      count,
      target: t,
      deviation: { absolute: -underBy, percent: -underPct },
      message: `word count ${count} below lower bound ${t.min} by ${underPct}% (-${underBy} words).`,
    };
  }
  return {
    verdict: 'pass',
    count,
    target: t,
    deviation: { absolute: 0, percent: 0 },
    message: `word count ${count} within ${t.min}..${t.max ?? '∞'}.`,
  };
}

module.exports = { check, countWords, resolveTarget };
