// correctness.ts — Does the artifact substantively address what the brief asked?
//
// Heuristic version (offline-safe): checks that the file has real content
// (not stub), has structural markers (headings, paragraphs), and isn't
// dominated by placeholders. For deeper judgment, plug in an LLM call.

export async function evaluate(args: { artifact: string; content: string; offline?: boolean }) {
  const { content } = args;
  const fix_list: string[] = [];
  let score = 1.0;

  if (content.length < 200) {
    fix_list.push("Artifact is too short (< 200 bytes) — looks like a stub.");
    score -= 0.5;
  }

  // Placeholder density. Markers are UPPERCASE conventions and are matched
  // case-SENSITIVELY on purpose: the old /i flag made the marker TODO match
  // the Portuguese word "todo" ("todo o tráfego"), failing any dense PT-BR
  // prose — a language the engine's deliverables ship in every day. A
  // lowercase "todo" is prose; an uppercase "TODO" is a marker in any
  // language. The bracketed forms stay case-insensitive: "[insert name]" is
  // a placeholder at any casing and collides with no natural-language word.
  const placeholders =
    (content.match(/\b(TODO|TBD|PLACEHOLDER|XXX|FIXME)\b/g) || []).length +
    (content.match(/\[(INSERT|FILL)/gi) || []).length;
  const wordCount = content.split(/\s+/).filter(Boolean).length;
  const phPerKWord = wordCount > 0 ? placeholders / (wordCount / 1000) : 0;
  if (phPerKWord > 5) {
    fix_list.push(`Too many placeholders (${placeholders} in ${wordCount} words = ${phPerKWord.toFixed(1)}/Kword). Resolve TODOs/TBDs.`);
    score -= 0.3;
  }

  // Structure presence (for prose). Headings are ONE form of structure, not
  // the only one: bold-line pseudo-headings ("**Identidade**") and list items
  // are structure too (the seat-sufficiency measure learned this against 574
  // real files), and some briefs explicitly forbid headings — a rubric that
  // cannot see the brief must not punish obeying it. Only a long, genuinely
  // structureless markdown wall is flagged.
  const hasHeadings = /^#{1,4}\s/m.test(content);
  const hasPseudoHeadings = /^\*\*[^*\n]{2,80}\*\*:?\s*$/m.test(content);
  const hasLists = /^\s*(?:[-*•]|\d+[.)])\s+\S/m.test(content);
  if (!hasHeadings && !hasPseudoHeadings && !hasLists && content.length > 500 && args.artifact.endsWith(".md")) {
    fix_list.push("No structure (headings, bold pseudo-headings or lists) in a 500+ byte markdown file — add some, unless the brief forbids it.");
    score -= 0.2;
  }

  // generic AI tells
  const aiTells = [
    /\bIt'?s (worth|important) (to )?not(e|ing)\b/gi,
    /\bIn summary\b/gi,
    /\bIn conclusion\b/gi,
    /\bAs an? (AI|language model)\b/gi,
  ];
  let tellHits = 0;
  for (const re of aiTells) tellHits += (content.match(re) || []).length;
  if (tellHits > 5) {
    fix_list.push(`Detected ${tellHits} generic AI phrases ("It's worth noting", "In conclusion", etc.). Tighten the prose.`);
    score -= 0.15;
  }

  score = Math.max(0, Math.min(1, score));
  const passed = score >= 0.65 && content.length >= 200;

  return {
    name: "correctness",
    passed,
    score,
    reasoning: passed
      ? `Heuristic correctness check passed (score ${score.toFixed(2)}, words=${wordCount}).`
      : `Heuristic check found issues (score ${score.toFixed(2)}).`,
    fix_list,
  };
}
