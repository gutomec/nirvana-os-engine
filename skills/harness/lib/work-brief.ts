// work-brief.ts — the brief the orchestrator writes for one business.
//
// The orchestrator is the only agent that talked to the user, so it is the one
// that turns the conversation into "what and why" for each business: the
// request verbatim (the source of truth, so a bad paraphrase is caught), the
// decisions already made, this business's part, its inputs, what done means
// and where to write. It never says "how": method, seats and plan are the
// worker's. The engine writes none of this text; it only checks that the six
// sections exist, and appends a decision the user makes mid-run.

import * as fs from "node:fs";

export const BRIEF_SECTIONS = ["Request (verbatim)", "Decisions", "Your part", "Inputs", "Done when", "Output"] as const;
export type BriefSection = (typeof BRIEF_SECTIONS)[number];

/** Sections that may say "None." but must be present. */
const MAY_BE_NONE: ReadonlySet<BriefSection> = new Set<BriefSection>(["Decisions", "Inputs"]);

export interface ParsedBrief {
  sections: Partial<Record<BriefSection, string>>;
  missing: BriefSection[];
  empty: BriefSection[];
}

const HEADING = /^##\s+(.+?)\s*$/;

function canonical(title: string): BriefSection | null {
  const t = title.trim().toLowerCase();
  return BRIEF_SECTIONS.find((s) => s.toLowerCase() === t) ?? null;
}

/** The six sections of a brief, and which are missing or empty. */
export function parseWorkBrief(text: string): ParsedBrief {
  const sections: Partial<Record<BriefSection, string>> = {};
  let current: BriefSection | null = null;
  let buffer: string[] = [];
  const flush = () => { if (current) sections[current] = buffer.join("\n").trim(); };
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    const m = HEADING.exec(line);
    if (m) {
      flush();
      current = canonical(m[1]);
      buffer = [];
      continue;
    }
    if (current) buffer.push(line);
  }
  flush();
  const missing = BRIEF_SECTIONS.filter((s) => sections[s] === undefined);
  const empty = BRIEF_SECTIONS.filter((s) => sections[s] !== undefined && !MAY_BE_NONE.has(s) && !sections[s]!.trim());
  return { sections, missing, empty };
}

export function briefProblems(parsed: ParsedBrief): string[] {
  return [
    ...parsed.missing.map((s) => `missing section: ## ${s}`),
    ...parsed.empty.map((s) => `empty section: ## ${s}`),
  ];
}

export interface Criterion { id: string; description: string; blocking: boolean }

/**
 * The "Done when" bullets as review criteria, ids d1..dn in order. A bullet
 * that ends in "(blocking)" or starts with "must" is blocking; the rest count
 * toward the score only.
 */
export function doneWhenCriteria(text: string): Criterion[] {
  const body = parseWorkBrief(text).sections["Done when"] ?? "";
  const items = body.split("\n")
    .map((l) => /^\s*(?:[-*]|\d+[.)])\s+(.*\S)\s*$/.exec(l)?.[1])
    .filter((x): x is string => !!x);
  return items.map((description, i) => {
    const blocking = /\(blocking\)\s*$/i.test(description) || /^must\b/i.test(description);
    return { id: `d${i + 1}`, description: description.replace(/\s*\(blocking\)\s*$/i, ""), blocking };
  });
}

/** The skeleton the orchestrator fills. Content follows the user's language; the headings stay as they are. */
export function briefTemplate(): string {
  return [
    "## Request (verbatim)",
    "<the user's own words, pasted, unedited>",
    "",
    "## Decisions",
    "- <what the user already decided in the conversation, one per line; \"None.\" when there is none>",
    "",
    "## Your part",
    "<what THIS business delivers, and what another business covers instead>",
    "",
    "## Inputs",
    "- <paths: attachments, another business's _SUMMARY.md; \"None.\" when there is none>",
    "",
    "## Done when",
    "- <an observable criterion; end it with (blocking) when the delivery fails without it>",
    "",
    "## Output",
    "<what the deliverable is made of: files and formats; the engine sets the folder>",
    "",
  ].join("\n");
}

/**
 * Append a decision to the "Decisions" section of a brief file, in place. The
 * worker re-reads the brief at every phase, so a decision the user makes while
 * the work runs reaches it without an interruption. A "None." placeholder is
 * replaced by the first real decision.
 */
export function appendDecision(file: string, decision: string): void {
  const text = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  const lines = text.split("\n");
  const start = lines.findIndex((l) => canonical(HEADING.exec(l)?.[1] ?? "") === "Decisions");
  const entry = `- ${decision.trim().replace(/\s+/g, " ")}`;
  if (start === -1) {
    fs.writeFileSync(file, `${text.trimEnd()}\n\n## Decisions\n${entry}\n`, "utf8");
    return;
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) if (HEADING.test(lines[i])) { end = i; break; }
  const body = lines.slice(start + 1, end).filter((l) => !/^\s*-?\s*none\.?\s*$/i.test(l));
  while (body.length && !body[body.length - 1].trim()) body.pop();
  const next = [...lines.slice(0, start + 1), ...body, entry, "", ...lines.slice(end)];
  fs.writeFileSync(file, next.join("\n").replace(/\n{3,}/g, "\n\n"), "utf8");
}
