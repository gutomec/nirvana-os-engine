// structure-bounds.ts — Checks markdown has reasonable structure + within length expectations.

export async function evaluate(args: { artifact: string; content: string; offline?: boolean }) {
  const { content } = args;
  const fix_list: string[] = [];
  let score = 1.0;

  const lines = content.split("\n");
  const headings = lines.filter(l => /^#{1,6}\s/.test(l));
  const paragraphs = content.split(/\n\s*\n/).filter(p => p.trim().length > 0);
  const wordCount = content.split(/\s+/).filter(Boolean).length;

  // expect at least 1 H1
  const h1Count = lines.filter(l => /^#\s/.test(l)).length;
  if (h1Count === 0 && content.length > 300) {
    fix_list.push("No H1 heading found.");
    score -= 0.2;
  }
  if (h1Count > 1) {
    fix_list.push(`Multiple H1 headings (${h1Count}). Use exactly 1 H1 per doc.`);
    score -= 0.1;
  }

  // heading-to-paragraph ratio sanity
  if (headings.length > paragraphs.length * 2) {
    fix_list.push(`Too many headings vs paragraphs (${headings.length} vs ${paragraphs.length}). Looks skeletal.`);
    score -= 0.2;
  }

  // long-paragraph guard
  const veryLong = paragraphs.filter(p => p.length > 2000).length;
  if (veryLong > 3) {
    fix_list.push(`${veryLong} paragraphs exceed 2000 chars. Consider splitting.`);
    score -= 0.1;
  }

  // single-word lists (suggest expansion)
  const singleWordBullets = lines.filter(l => /^[-*]\s+\S+\s*$/.test(l)).length;
  if (singleWordBullets > 10) {
    fix_list.push(`${singleWordBullets} bullets with a single word. Expand or remove.`);
    score -= 0.1;
  }

  score = Math.max(0, Math.min(1, score));
  const passed = score >= 0.7;

  return {
    name: "structure-bounds",
    passed,
    score,
    reasoning: `Headings=${headings.length}, paragraphs=${paragraphs.length}, words=${wordCount}. ${passed ? "Structure OK." : "Structure issues found."}`,
    fix_list,
  };
}
