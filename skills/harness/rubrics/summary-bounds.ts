// summary-bounds.ts — WARNING-only check that a _SUMMARY.md (the public-API
// handoff summary) stays within the context budget (~600 words / ~800 tokens).
//
// Reuses volume-bounds.js for word counting (no reimplementation). It NEVER
// fails the gate (passed is always true) — it surfaces overage so the maestro
// keeps the summary bounded. The budget is a convention (HARNESS_PROTOCOL_V1
// §6 / §7.4), made visible here, not a hard inline block.

import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";

const SKILLS_ROOT = process.env.NIRVANA_SKILLS_DIR
  || (fs.existsSync(path.join(os.homedir(), ".nirvana", "skills")) ? path.join(os.homedir(), ".nirvana", "skills") : path.join(os.homedir(), ".claude", "skills"));

const { countWords } = require(path.join(SKILLS_ROOT, "_shared/lib/volume-bounds.js"));

const WORD_BUDGET = 600; // ~800 tokens

export async function evaluate(args: { artifact: string; content: string; offline?: boolean }) {
  const { content } = args;
  const words = countWords(content);
  const fix_list: string[] = [];
  let score = 1.0;

  if (words > WORD_BUDGET) {
    const overBy = words - WORD_BUDGET;
    const overPct = Math.round((overBy / WORD_BUDGET) * 100);
    score = Math.max(0, Math.round((1 - overPct / 100) * 100) / 100);
    fix_list.push(
      `_SUMMARY is ${words} words, ${overPct}% over the ${WORD_BUDGET}-word budget (~800 tokens). ` +
      `Trim it — move detail into the body deliverable; the summary is the bounded public API of the handoff.`
    );
  }

  return {
    name: "summary-bounds",
    passed: true, // WARNING-only: never blocks the gate
    score,
    reasoning: `_SUMMARY word count = ${words} (budget ${WORD_BUDGET}). ${words > WORD_BUDGET ? "Over budget — warning only, not a block." : "Within budget."}`,
    fix_list,
  };
}
