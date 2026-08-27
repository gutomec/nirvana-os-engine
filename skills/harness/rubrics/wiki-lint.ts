// wiki-lint.ts — Detect classic LLM tells (vague attributions, hedging,
// promotional language) drawn from Wikipedia's "Signs of AI writing" guide.

// Pattern-based regex only (no word-list bans). Each entry flags a
// structural AI tell that aligns with the writing contract in CLAUDE.md /
// AGENTS.md / GEMINI.md. Patterns are cheap pass/fail; this rubric never
// rewrites prose.
const PROBLEMATIC_PATTERNS: { regex: RegExp; label: string; severity: number }[] = [
  { regex: /\b(some|many|certain) (?:experts|critics|commentators|observers|researchers)\b/gi, label: "vague attribution", severity: 0.3 },
  { regex: /\bit (?:has been|is) (?:argued|noted|suggested|observed|claimed)\b/gi, label: "passive attribution", severity: 0.3 },
  { regex: /\bIn (?:summary|conclusion|essence|the realm of|today'?s (?:world|landscape))\b/gi, label: "filler opener", severity: 0.4 },
  { regex: /\bas an? AI\b/gi, label: "AI self-reference", severity: 1.0 },
  { regex: /\b(?:not only .{1,40} but also)\b/gi, label: "negative parallelism", severity: 0.2 },
  { regex: /\bIt'?s (?:worth (?:noting|mentioning)|important to (?:note|remember|understand))\b/gi, label: "hedging filler", severity: 0.4 },
];

// Every signal above is a signal of ENGLISH prose: English filler openers,
// English passive attribution, and dash/hyphen densities calibrated on Latin
// punctuation. Run over Devanagari or Arabic they measure nothing — in trace
// 70341260 (27/08/2026) this rubric failed README.hi.md and README.ar.md for
// "em-dash overuse" and "hyphen-as-clause-stitching", and the delivery spent
// its whole revision budget on the complaint.
//
// The rubric therefore abstains when the writing is predominantly non-Latin.
// Script, not filename: a locale suffix (`.hi.md`) is a stronger signal when
// it is there, and absent from every Hindi document not named that way.
// Measured on the files from that trace: en/es READMEs score 0% non-Latin
// letters, zh 42%, hi 59%, ar 70% — the two clusters are far apart, so the
// threshold sits between them with room on both sides.
//
// WHAT THIS DOES NOT COVER: Portuguese, Spanish, French and every other
// Latin-script language stay under judgement, and the English-specific
// patterns still do not apply to them. Narrowing that needs real language
// detection, not a script check; this cut buys the gross case only.
const NON_LATIN_ABSTAIN_SHARE = 0.2;

function nonLatinLetterShare(content: string): number {
  const letters = content.match(/\p{L}/gu) ?? [];
  if (letters.length === 0) return 0;
  let nonLatin = 0;
  for (const ch of letters) if (!/\p{Script=Latin}/u.test(ch)) nonLatin++;
  return nonLatin / letters.length;
}

export async function evaluate(args: { artifact: string; content: string; offline?: boolean }) {
  const { content } = args;

  const share = nonLatinLetterShare(content);
  if (share > NON_LATIN_ABSTAIN_SHARE) {
    // `skipped` — not a pass. quality-gate.ts drops skipped rubrics from the
    // verdict on both sides: they never carry a PASS, and a file left with no
    // unskipped rubric lands on INDETERMINATE (exit 1), never on a silent 0.
    return {
      name: "wiki-lint",
      passed: false,
      score: 0,
      skipped: true,
      reasoning: `Not applicable: ${(share * 100).toFixed(0)}% of the letters are outside the Latin script, and these signals describe English prose.`,
      fix_list: [],
    };
  }

  const findings: { label: string; count: number; severity: number; sample?: string }[] = [];
  let severityTotal = 0;

  for (const p of PROBLEMATIC_PATTERNS) {
    const matches = content.match(p.regex);
    if (matches && matches.length > 0) {
      const weighted = matches.length * p.severity;
      severityTotal += weighted;
      findings.push({ label: p.label, count: matches.length, severity: p.severity, sample: matches[0] });
    }
  }

  // em-dash overuse (— more than ~5 per 1000 words)
  const emDashes = (content.match(/—/g) || []).length;
  const wordCount = content.split(/\s+/).filter(Boolean).length;
  const emDashesPerKWord = wordCount > 0 ? (emDashes / (wordCount / 1000)) : 0;
  if (emDashesPerKWord > 10) {
    findings.push({ label: "em-dash overuse", count: emDashes, severity: 0.3 });
    severityTotal += 0.3 * Math.min(emDashes, 5);
  }

  // En-dash overuse (–)
  const enDashes = (content.match(/–/g) || []).length;
  if (wordCount > 0 && (enDashes / (wordCount / 1000)) > 5) {
    findings.push({ label: "en-dash overuse", count: enDashes, severity: 0.3 });
    severityTotal += 0.3 * Math.min(enDashes, 5);
  }

  // Hyphen abuse (-) — the most common AI tell. Per the writing contract,
  // hyphens are ONLY for compound words and ranges. Anything else (clause
  // stitching, emphasis, list dividers) is wrong. Heuristic: count MID-LINE
  // hyphens surrounded by spaces (the "word - word" stitching pattern). We
  // require a non-space char before the space+hyphen run so markdown bullet
  // markers ("\n- item") and indented bullets do NOT count — they were a
  // false positive that made the gate unfixable. Compound words
  // ("local-first") have no surrounding spaces.
  const spacedHyphens = (content.match(/(?<=\S)[ \t]+-[ \t]+(?=\S)/g) || []).length;
  const hyphensPerKWord = wordCount > 0 ? (spacedHyphens / (wordCount / 1000)) : 0;
  if (hyphensPerKWord > 3) {
    findings.push({
      label: "hyphen-as-clause-stitching",
      count: spacedHyphens,
      severity: 1.0,
      sample: "use commas, colons, or periods instead (see the writing contract in AGENTS.md / CLAUDE.md / GEMINI.md)",
    });
    // Heavier weight than em-dash because users repeatedly flagged this as
    // the dominant AI tell in Nirvana-generated prose. Cap at 12 instances
    // so a single bad doc fails the gate hard.
    severityTotal += 1.0 * Math.min(spacedHyphens, 12);
  }

  // Score: 1.0 perfect, -0.05 per severity point
  const score = Math.max(0, 1 - severityTotal * 0.05);
  const passed = score >= 0.7;

  const fix_list = findings.slice(0, 6).map(f => `Reduce '${f.label}' (${f.count}x${f.sample ? `, e.g. "${f.sample.slice(0, 40)}"` : ""}).`);

  return {
    name: "wiki-lint",
    passed,
    score,
    reasoning: `Detected ${findings.length} pattern types${findings.length > 0 ? ` (worst: ${findings.slice(0, 3).map(f => f.label).join(", ")})` : ""}. Score ${score.toFixed(2)}.`,
    fix_list,
  };
}
