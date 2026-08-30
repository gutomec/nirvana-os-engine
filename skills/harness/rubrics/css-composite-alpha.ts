// css-composite-alpha.ts — catches a decorative layer whose visible alpha is
// compounded away to nothing by a glass sheet stacked on top of it.
//
// The incident this rubric exists for (PR #175, this engine, 2026-08-30): a
// `.field-bg` layer used `color-mix(in oklab, var(--accent) 30%, transparent)`
// gradients, rendered BEHIND a glass sheet declaring `--sheet-a: 0.6` — the
// sheet's own tint is 60% opaque, so only (1 − 0.6) = 40% of whatever sits
// behind it (the gradient) shows through. The producing agent's own
// _SUMMARY.md claimed to have opened Chrome and read computed styles showing
// a visible "wash" — but nobody computed the COMPOSITE: 30% × 40% = 12%
// effective alpha, invisible in practice, especially against a light theme's
// near-white surfaces. `.css` was not in GATEABLE_EXTS at all, so this file
// was invisible to the gate before it ever got a chance to check anything.
//
// Scope, deliberately narrow: only alpha used INSIDE a gradient function
// (radial-gradient/linear-gradient/conic-gradient). A gradient wash is the
// "ambient effect meant to be seen" pattern the incident was about. A flat
// `--status-success-bg: color-mix(..., 14%, transparent)` token is a
// different, tolerant-of-subtlety design choice (a small semantic tint, not
// a page-wide wash) — scanning those too produced false positives against
// this engine's own real tokens.css on first try, which is exactly the kind
// of blunt-instrument static check the incident's own report warned against.
//
// This is a static-analysis smoke test, not a renderer: it cannot know
// whether a gradient actually renders BEHIND a given sheet in the real
// cascade — that needs a browser — so a flag here is evidence for a human or
// a browser-capable auditor to look at, not a final verdict on its own.

const SHEET_ALPHA_VAR = /--[\w-]*-a\b\s*:\s*([0-9]*\.?[0-9]+)\s*;/g;
const GRADIENT_START = /(?:radial|linear|conic)-gradient\(/g;
const COLOR_MIX_ALPHA = /color-mix\([^)]*?,\s*[^,]+?\s+(\d{1,3})%\s*,\s*transparent\s*\)/g;
const RGBA_ALPHA = /rgba?\([^)]*,\s*([0-9]*\.?[0-9]+)\s*\)/g;

// Below this, the composited color is generally imperceptible against a
// light-theme near-white surface. Not a WCAG number — WCAG contrast needs the
// actual colors on both sides, which a lexical scan cannot see. This is a
// conservative "probably invisible, go check it" floor.
const VISIBILITY_FLOOR = 0.15;

/** Extract the substrings of every gradient(...) call, matching parens by
 * hand — regex cannot express arbitrary nesting depth, and a gradient wash
 * routinely nests color-mix(...)/var(...) calls inside it. */
function gradientBodies(content: string): string[] {
  const bodies: string[] = [];
  for (const m of content.matchAll(GRADIENT_START)) {
    const openIdx = m.index! + m[0].length - 1; // index of the "(" itself
    let depth = 1;
    let i = openIdx + 1;
    for (; i < content.length && depth > 0; i++) {
      if (content[i] === "(") depth++;
      else if (content[i] === ")") depth--;
    }
    bodies.push(content.slice(openIdx + 1, i - 1));
  }
  return bodies;
}

export async function evaluate(args: { artifact: string; content: string; offline?: boolean }) {
  const { content } = args;

  const sheetAlphas: number[] = [];
  for (const m of content.matchAll(SHEET_ALPHA_VAR)) {
    const v = Number.parseFloat(m[1]);
    if (Number.isFinite(v) && v > 0 && v <= 1) sheetAlphas.push(v);
  }

  const decorativeAlphas: number[] = [];
  for (const body of gradientBodies(content)) {
    for (const m of body.matchAll(COLOR_MIX_ALPHA)) {
      const pct = Number.parseFloat(m[1]);
      if (Number.isFinite(pct)) decorativeAlphas.push(pct / 100);
    }
    for (const m of body.matchAll(RGBA_ALPHA)) {
      const v = Number.parseFloat(m[1]);
      if (Number.isFinite(v) && v > 0 && v < 1) decorativeAlphas.push(v);
    }
  }

  // Nothing to compound — most CSS never declares a sheet alpha, or never
  // uses a gradient wash, at all.
  if (sheetAlphas.length === 0 || decorativeAlphas.length === 0) {
    return {
      name: "css-composite-alpha",
      passed: true,
      score: 1.0,
      reasoning: "No glass-sheet alpha stacked with a gradient wash's decorative alpha in this file — nothing to compound.",
      fix_list: [],
    };
  }

  // The worst case is the MOST opaque sheet (highest alpha) — it blocks the
  // most of what sits behind it, so it passes through the LEAST.
  const worstSheetAlpha = Math.max(...sheetAlphas);
  const passThrough = 1 - worstSheetAlpha;
  const flagged: { decorative: number; composite: number }[] = [];
  for (const dec of decorativeAlphas) {
    const composite = dec * passThrough;
    if (composite < VISIBILITY_FLOOR) flagged.push({ decorative: dec, composite });
  }

  if (flagged.length === 0) {
    return {
      name: "css-composite-alpha",
      passed: true,
      score: 1.0,
      reasoning: `Composited alpha stays above the ${VISIBILITY_FLOOR} visibility floor for every gradient wash found (worst-case sheet at ${worstSheetAlpha} alpha passes through ${(passThrough * 100).toFixed(0)}%).`,
      fix_list: [],
    };
  }

  const worst = flagged.reduce((a, b) => (a.composite < b.composite ? a : b));
  return {
    name: "css-composite-alpha",
    passed: false,
    score: Math.max(0, worst.composite / VISIBILITY_FLOOR),
    reasoning: `A gradient wash at ${(worst.decorative * 100).toFixed(0)}% composited behind a glass sheet at ${worstSheetAlpha} alpha (passes through only ${(passThrough * 100).toFixed(0)}%) lands at ~${(worst.composite * 100).toFixed(0)}% effective — likely imperceptible, especially in a light theme. This is a lexical smoke test: it cannot confirm the gradient actually renders behind the sheet, so verify visually before trusting the flag either way.`,
    fix_list: [
      `Raise the gradient's own opacity so decorative_alpha × ${passThrough.toFixed(2)} clears ${VISIBILITY_FLOOR}, or verify in a browser that the composite is intentional and visible.`,
    ],
  };
}
