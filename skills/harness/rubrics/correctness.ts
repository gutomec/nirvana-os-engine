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

  // placeholder density
  const placeholders = (content.match(/\b(TODO|TBD|PLACEHOLDER|XXX|FIXME|\[INSERT|\[FILL)\b/gi) || []).length;
  const wordCount = content.split(/\s+/).filter(Boolean).length;
  const phPerKWord = wordCount > 0 ? placeholders / (wordCount / 1000) : 0;
  if (phPerKWord > 5) {
    fix_list.push(`Too many placeholders (${placeholders} in ${wordCount} words = ${phPerKWord.toFixed(1)}/Kword). Resolve TODOs/TBDs.`);
    score -= 0.3;
  }

  // heading presence (for prose)
  const hasHeadings = /^#{1,4}\s/m.test(content);
  if (!hasHeadings && content.length > 500 && args.artifact.endsWith(".md")) {
    fix_list.push("No markdown headings in a 500+ byte markdown file — add structure.");
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
