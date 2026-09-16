// deprescribe-tasks.ts — Squad Protocol v6 §36: tasks state the outcome, steps are reference.
//
// Usage:
//   bun deprescribe-tasks.ts <root> [<root>…]            report (nothing written)
//   bun deprescribe-tasks.ts <root> --apply              rewrite the task files under <root>
//   bun deprescribe-tasks.ts <root> --json               machine-readable report
//
// For every `tasks/*.md` below a root that has no `## Outcome`: derive the
// outcome paragraph from the frontmatter `description` (or the first paragraph
// after the title), insert it before the first section, and relabel `## Steps`
// as the author's reference method. Nothing else moves. The installed library
// (SQUADS_DIR) is refused on purpose: pack content is authored under
// ~/nirvana-packs and the installed copy is watermarked per buyer.
import * as fs from "node:fs";
import * as path from "node:path";
import { paths } from "../../_shared/lib/bun-helpers.ts";

export const STEPS_HEADING = "## Steps";
export const STEPS_REFERENCE_HEADING = "## Steps (reference method, optional)";
export const OUTCOME_HEADING = "## Outcome";

export type TaskChange = { file: string; outcome_added: boolean; steps_relabelled: boolean };
export type Report = { roots: string[]; scanned: number; changed: TaskChange[]; applied: boolean };

function frontmatterDescription(src: string): string {
  const fm = src.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return "";
  const line = fm[1].split(/\r?\n/).find((l) => /^\s*description\s*:/.test(l));
  if (!line) return "";
  return line.replace(/^\s*description\s*:\s*/, "").trim().replace(/^(["'])([\s\S]*)\1$/, "$2").trim();
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

/** The rewritten document, or null when the task already states its outcome
 *  and carries no `## Steps` heading to relabel. */
export function deprescribeTask(src: string): { next: string; outcome_added: boolean; steps_relabelled: boolean } | null {
  const hasOutcome = new RegExp(`^${OUTCOME_HEADING}\\s*$`, "m").test(src);
  const stepsRe = new RegExp(`^${STEPS_HEADING}\\s*$`, "m");
  const hasBareSteps = stepsRe.test(src);
  if (hasOutcome && !hasBareSteps) return null;

  let next = src;
  let outcome_added = false;
  if (!hasOutcome) {
    const fmEnd = (() => { const m = next.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/); return m ? m[0].length : 0; })();
    const body = next.slice(fmEnd);
    const text = frontmatterDescription(next) || firstParagraphAfterTitle(body);
    const outcome = text ? `${OUTCOME_HEADING}\n${text.replace(/\.?$/, ".")}\n\n` : `${OUTCOME_HEADING}\n(state what must be true when this task is done)\n\n`;
    const firstSection = body.search(/^##\s/m);
    if (firstSection >= 0) {
      next = next.slice(0, fmEnd) + body.slice(0, firstSection) + outcome + body.slice(firstSection);
    } else {
      next = next.replace(/\s*$/, "") + "\n\n" + outcome.trimEnd() + "\n";
    }
    outcome_added = true;
  }
  const steps_relabelled = hasBareSteps;
  if (hasBareSteps) next = next.replace(stepsRe, STEPS_REFERENCE_HEADING);
  return { next, outcome_added, steps_relabelled };
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
  const report: Report = { roots, scanned: 0, changed: [], applied: !!opts.apply };
  for (const root of roots) {
    for (const file of taskFiles(root)) {
      report.scanned++;
      const src = fs.readFileSync(file, "utf8");
      const r = deprescribeTask(src);
      if (!r) continue;
      if (opts.apply) fs.writeFileSync(file, r.next, "utf8");
      report.changed.push({ file, outcome_added: r.outcome_added, steps_relabelled: r.steps_relabelled });
    }
  }
  return report;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const json = argv.includes("--json");
  const roots = argv.filter((a) => !a.startsWith("--")).map((a) => path.resolve(a));
  if (!roots.length) {
    console.error("usage: bun deprescribe-tasks.ts <root> [<root>…] [--apply] [--json]");
    process.exit(2);
  }
  const library = path.resolve(String(paths.SQUADS_DIR));
  for (const root of roots) {
    if (!fs.existsSync(root)) { console.error(`root not found: ${root}`); process.exit(2); }
    if (root === library || root.startsWith(library + path.sep)) {
      console.error(`refused: ${root} is the installed library (SQUADS_DIR); author pack content under ~/nirvana-packs instead`);
      process.exit(3);
    }
  }
  const report = deprescribeRoots(roots, { apply });
  if (json) { console.log(JSON.stringify(report, null, 2)); }
  else {
    console.log(`${apply ? "applied" : "report"}: ${report.scanned} task file(s) scanned, ${report.changed.length} to change`);
    for (const c of report.changed) {
      const what = [c.outcome_added ? "outcome" : "", c.steps_relabelled ? "steps→reference" : ""].filter(Boolean).join(", ");
      console.log(`  ${apply ? "rewrote" : "would rewrite"} ${c.file} (${what})`);
    }
    if (!apply && report.changed.length) console.log("run again with --apply to write");
  }
}
