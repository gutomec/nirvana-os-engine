// deprescribe-tasks.ts — Squad Protocol v6 §36: a task states its outcome; the steps go.
//
// Usage:
//   bun deprescribe-tasks.ts <root> [<root>…]              report (nothing written)
//   bun deprescribe-tasks.ts <root> --apply                rewrite the task files under <root>
//   bun deprescribe-tasks.ts <root> --json                 machine-readable report
//   bun deprescribe-tasks.ts <root> --include-library      accept the installed library (SQUADS_DIR) as a root
//
// For every `tasks/*.md` below a root: add `## Outcome` when it is missing and
// remove the `## Steps` section whole (heading to the next h1/h2, or the end of
// the file). Nothing else moves; a trailing attribution comment line stays.
// The outcome paragraph is derived, in order, from the frontmatter
// `description`, the first paragraph after the title, or the `## Output`
// paragraph joined with the first acceptance criterion; the report records the
// source per file and flags the file `weak` when the description was unusable,
// which is the list a curation pass rewrites.
//
// The installed library is refused unless `--include-library` is passed: pack
// content is authored under ~/nirvana-packs and the installed copy is
// watermarked per buyer, so the two are migrated in place, never one copied
// over the other.
import * as fs from "node:fs";
import * as path from "node:path";
import { paths } from "../../_shared/lib/bun-helpers.ts";

export const OUTCOME_HEADING = "## Outcome";
export const OUTCOME_PLACEHOLDER = "(state what must be true when this task is done)";
const STEPS_RE = /^## Steps\b[^\n]*\n?/m;
const ATTRIBUTION_LINE_RE = /^\[\/\/\]: # \([A-Za-z0-9_-]{22}\)$/;

export type OutcomeSource = "present" | "description" | "title-paragraph" | "output" | "placeholder";
export type TaskChange = { file: string; outcome_added: boolean; outcome_source: OutcomeSource; steps_removed: boolean; weak: boolean };
export type Report = { roots: string[]; scanned: number; changed: TaskChange[]; weak: number; applied: boolean };

function frontmatterDescription(src: string): string {
  const fm = src.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return "";
  const line = fm[1].split(/\r?\n/).find((l) => /^\s*description\s*:/.test(l));
  if (!line) return "";
  return line.replace(/^\s*description\s*:\s*/, "").trim().replace(/^(["'])([\s\S]*)\1$/, "$2").trim();
}

/** A description the outcome can rest on: six words or more, no scaffold. */
export function descriptionIsWeak(desc: string): boolean {
  if (!desc) return true;
  if (/what this accomplishes|what-this-accomplishes|\{\{|TODO/i.test(desc)) return true;
  return desc.split(/\s+/).length < 6;
}

function firstParagraphAfterTitle(body: string): string {
  const lines = body.split(/\r?\n/);
  let i = lines.findIndex((l) => /^#\s/.test(l));
  if (i < 0) return "";
  const para: string[] = [];
  for (i += 1; i < lines.length; i++) {
    const l = lines[i];
    if (/^#{1,6}\s/.test(l)) break;
    if (!l.trim()) { if (para.length) break; continue; }
    para.push(l.trim());
  }
  return para.join(" ");
}

function sectionBody(body: string, heading: string): string {
  const re = new RegExp(`^## ${heading}\\b[^\\n]*\\n([\\s\\S]*?)(?=^#{1,2}\\s|(?![\\s\\S]))`, "m");
  const m = body.match(re);
  return m ? m[1].trim() : "";
}

function outputPlusCriterion(body: string): string {
  const output = sectionBody(body, "Output").split(/\n\s*\n/)[0]?.replace(/\s+/g, " ").trim() ?? "";
  const criterion = (sectionBody(body, "Acceptance Criteria").split(/\r?\n/).find((l) => /^\s*[-*]\s+\S/.test(l)) ?? "")
    .replace(/^\s*[-*]\s+/, "").trim();
  if (output.split(/\s+/).length < 4) return "";
  return criterion ? `${output.replace(/\.?$/, "")}. Done when: ${criterion.replace(/\.?$/, "")}.` : output;
}

function removeSteps(src: string): { next: string; removed: boolean } {
  let next = src;
  let removed = false;
  for (let guard = 0; guard < 8; guard++) {
    const m = STEPS_RE.exec(next);
    if (!m) break;
    const start = m.index;
    const after = next.slice(start + m[0].length);
    const stop = after.search(/^#{1,2}\s/m);
    let end = stop >= 0 ? start + m[0].length + stop : next.length;
    let tail = next.slice(start, end);
    // A trailing attribution comment belongs to the file, not to the section.
    const kept = tail.split(/\r?\n/).filter((l) => ATTRIBUTION_LINE_RE.test(l));
    next = next.slice(0, start) + (kept.length ? kept.join("\n") + "\n" : "") + next.slice(end);
    removed = true;
  }
  if (removed) next = next.replace(/\n{3,}/g, "\n\n").replace(/[ \t]+\n/g, "\n");
  return { next, removed };
}

/** The rewritten document, or null when the task already states its outcome
 *  and carries no `## Steps` section. */
export function deprescribeTask(src: string): { next: string; outcome_added: boolean; outcome_source: OutcomeSource; steps_removed: boolean; weak: boolean } | null {
  const hasOutcome = new RegExp(`^${OUTCOME_HEADING}\\s*$`, "m").test(src);
  const desc = frontmatterDescription(src);
  const weak = descriptionIsWeak(desc);
  const steps = removeSteps(src);
  if (hasOutcome && !steps.removed) return null;

  let next = steps.next;
  let outcome_added = false;
  let outcome_source: OutcomeSource = "present";
  if (!hasOutcome) {
    const fmEnd = (() => { const m = next.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/); return m ? m[0].length : 0; })();
    const body = next.slice(fmEnd);
    let text = "";
    if (!weak) { text = desc; outcome_source = "description"; }
    else {
      const para = firstParagraphAfterTitle(body);
      if (para && para.split(/\s+/).length >= 6) { text = para; outcome_source = "title-paragraph"; }
      else {
        const derived = outputPlusCriterion(body);
        if (derived) { text = derived; outcome_source = "output"; }
        else { text = OUTCOME_PLACEHOLDER; outcome_source = "placeholder"; }
      }
    }
    const paragraph = outcome_source === "placeholder" ? text : text.replace(/\.?$/, ".");
    const outcome = `${OUTCOME_HEADING}\n${paragraph}\n\n`;
    const firstSection = body.search(/^##\s/m);
    if (firstSection >= 0) next = next.slice(0, fmEnd) + body.slice(0, firstSection) + outcome + body.slice(firstSection);
    else next = next.replace(/\s*$/, "") + "\n\n" + outcome.trimEnd() + "\n";
    outcome_added = true;
  }
  if (!next.endsWith("\n")) next += "\n";
  return { next, outcome_added, outcome_source, steps_removed: steps.removed, weak };
}

function* taskFiles(root: string): Generator<string> {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { stack.push(full); continue; }
      if (e.isFile() && e.name.endsWith(".md") && path.basename(dir) === "tasks") yield full;
    }
  }
}

export function deprescribeRoots(roots: string[], opts: { apply?: boolean } = {}): Report {
  const report: Report = { roots, scanned: 0, changed: [], weak: 0, applied: !!opts.apply };
  for (const root of roots) {
    for (const file of taskFiles(root)) {
      report.scanned++;
      const src = fs.readFileSync(file, "utf8");
      const r = deprescribeTask(src);
      if (r?.weak || (!r && descriptionIsWeak(frontmatterDescription(src)))) report.weak++;
      if (!r) continue;
      if (opts.apply) fs.writeFileSync(file, r.next, "utf8");
      report.changed.push({ file, outcome_added: r.outcome_added, outcome_source: r.outcome_source, steps_removed: r.steps_removed, weak: r.weak });
    }
  }
  return report;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const json = argv.includes("--json");
  const includeLibrary = argv.includes("--include-library");
  const roots = argv.filter((a) => !a.startsWith("--")).map((a) => path.resolve(a));
  if (!roots.length) {
    console.error("usage: bun deprescribe-tasks.ts <root> [<root>…] [--apply] [--json] [--include-library]");
    process.exit(2);
  }
  const library = path.resolve(String(paths.SQUADS_DIR));
  for (const root of roots) {
    if (!fs.existsSync(root)) { console.error(`root not found: ${root}`); process.exit(2); }
    if (!includeLibrary && (root === library || root.startsWith(library + path.sep))) {
      console.error(`refused: ${root} is the installed library (SQUADS_DIR); pass --include-library to migrate it in place, and never copy it into a pack`);
      process.exit(3);
    }
  }
  const report = deprescribeRoots(roots, { apply });
  if (json) { console.log(JSON.stringify(report, null, 2)); }
  else {
    const bySource: Record<string, number> = {};
    for (const c of report.changed) bySource[c.outcome_source] = (bySource[c.outcome_source] || 0) + 1;
    console.log(`${apply ? "applied" : "report"}: ${report.scanned} task file(s) scanned, ${report.changed.length} ${apply ? "rewritten" : "to change"}, ${report.weak} weak (description unusable)`);
    console.log(`  outcome source: ${Object.entries(bySource).map(([k, v]) => `${k} ${v}`).join(" · ") || "none"}; steps removed: ${report.changed.filter((c) => c.steps_removed).length}`);
    if (!apply && report.changed.length) console.log("run again with --apply to write");
  }
}
