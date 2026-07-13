/**
 * structure-bounds.js — deterministic check for required markdown sections.
 *
 * Mirrors volume-bounds.js but for headers. Catches the case where a brief
 * has the right word count but skipped 3 of 12 mandatory sections — proxy
 * for "structural completeness" that word-count alone cannot prove.
 *
 * Match strategy: case-insensitive substring match. "## Resumo executivo" and
 * "### resumo: ..." both satisfy a required entry of "Resumo executivo".
 * Trade-off: tolerant matching avoids false positives on minor wording drift,
 * accepts false positives when an unrelated header coincidentally contains
 * the substring. Aceitable because the upstream judge can override.
 *
 * API:
 *   const r = check({ text, required_sections });
 *   // r → { verdict, found_count, missing, present, message }
 *   //   verdict ∈ 'pass' | 'missing_sections' | 'skipped'
 *
 * 'skipped' when required_sections is null/empty/non-array.
 */

'use strict';

function extractHeaders(text) {
  if (!text || typeof text !== 'string') return [];
  const headers = [];
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (m) headers.push(m[2].trim());
  }
  return headers;
}

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function check({ text, required_sections }) {
  if (!Array.isArray(required_sections) || required_sections.length === 0) {
    return { verdict: 'skipped', found_count: 0, missing: [], present: [], message: 'no required_sections declared' };
  }
  const headers = extractHeaders(text).map(normalize);
  const missing = [];
  const present = [];
  for (const req of required_sections) {
    const needle = normalize(req);
    if (!needle) continue;
    const hit = headers.some(h => h.includes(needle) || needle.includes(h));
    if (hit) present.push(req);
    else missing.push(req);
  }
  if (missing.length === 0) {
    return {
      verdict: 'pass',
      found_count: present.length,
      missing: [],
      present,
      message: `all ${present.length} required section(s) found`,
    };
  }
  return {
    verdict: 'missing_sections',
    found_count: present.length,
    missing,
    present,
    message: `${missing.length} of ${required_sections.length} required section(s) missing: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? '…' : ''}`,
  };
}

module.exports = { check, extractHeaders, normalize };
