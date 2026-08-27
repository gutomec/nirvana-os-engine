// report.ts — the human table and the JSON contract of `nrv validate`.
//
// Text output follows the scripts/check-*.ts idiom (PASS/WARN/FAIL rows, ANSI
// colour, a verdict line). JSON is `nirvana.verify-report/v1`; `--all` and
// `--pack` wrap entity reports in `nirvana.verify-batch/v1`.

import type { Finding, Kind, VerifyReport } from "./types.ts";
import { VERIFY_EXIT } from "./types.ts";

const RED = "\x1b[31m", GRN = "\x1b[32m", YEL = "\x1b[33m", CYN = "\x1b[36m", DIM = "\x1b[2m", BOLD = "\x1b[1m", RST = "\x1b[0m";

export interface BatchReport {
  schema: "nirvana.verify-batch/v1";
  mode: "all" | "pack";
  kinds: Kind[];
  entities: number;
  summary: { admitted: number; rejected: number; errors: number; warnings: number; debt: number };
  reports: VerifyReport[];
  baseline: { present: boolean; path: string | null; recorded?: boolean; regressions?: Array<{ entity: string; added: string[] }> };
  exit_code: number;
  strict: boolean;
  checked_at: string;
}

export function countFindings(findings: Finding[]): { errors: number; warnings: number; debt: number } {
  let errors = 0, warnings = 0, debt = 0;
  for (const f of findings) {
    if (f.baselined) { debt++; continue; }
    if (f.severity === "error") errors++;
    else if (f.severity === "warning") warnings++;
  }
  return { errors, warnings, debt };
}

export function exitCodeFor(findings: Finding[], strict: boolean): number {
  const c = countFindings(findings);
  if (c.errors > 0) return VERIFY_EXIT.REJECTED;
  if (strict && c.warnings > 0) return VERIFY_EXIT.STRICT_WARNINGS;
  return VERIFY_EXIT.ADMITTED;
}

function home(p: string): string {
  const h = process.env.HOME ?? process.env.USERPROFILE ?? "";
  return h && p.startsWith(h) ? "~" + p.slice(h.length) : p;
}

function row(f: Finding): string {
  const tag = f.baselined ? `${CYN}DEBT${RST}`
    : f.severity === "error" ? `${RED}FAIL${RST}`
    : f.severity === "warning" ? `${YEL}WARN${RST}`
    : `${DIM}INFO${RST}`;
  const id = f.where ? `${f.id}:${f.where}` : f.id;
  const fix = f.fixer ? ` ${DIM}[fix: ${f.fixer}]${RST}` : f.autofix === "agentic" ? ` ${DIM}[agentic]${RST}` : "";
  return `  ${tag}  ${id.padEnd(36)} ${f.message}${fix}`;
}

export function renderReport(r: VerifyReport): string {
  const lines: string[] = [];
  lines.push(`${BOLD}VERIFY ${r.kind}:${r.slug}${RST} ${DIM}${home(r.dir)}${RST}`);
  const order = { error: 0, warning: 1, info: 2 } as const;
  const sorted = [...r.findings].sort((a, b) => (a.baselined ? 1 : 0) - (b.baselined ? 1 : 0) || order[a.severity] - order[b.severity] || a.id.localeCompare(b.id));
  for (const f of sorted) lines.push(row(f));
  lines.push(`  ${GRN}PASS${RST}  ${r.summary.passed} criteria`);
  if (r.fix_outcome && r.fix_outcome.mode !== "none") {
    const o = r.fix_outcome;
    const applied = r.fixes.filter((x) => x.applied).length;
    lines.push(`  ${DIM}fix: ${applied} fixer(s) applied · errors ${o.before.errors}→${o.after.errors} · warnings ${o.before.warnings}→${o.after.warnings}${o.rolled_back ? ` · ${RED}ROLLED BACK${RST}${DIM} (${o.rollback_reason})` : ""}${o.backup ? ` · backup ${home(o.backup)}` : ""}${RST}`);
    for (const x of r.fixes) if (x.error) lines.push(`  ${RED}fixer ${x.fixer} failed:${RST} ${x.error}`);
  }
  const mech = r.findings.filter((f) => f.fixer && !f.baselined).length;
  const verdictColor = r.verdict === "ADMITTED" ? GRN : RED;
  lines.push(`Verdict: ${verdictColor}${r.verdict}${RST} — ${r.summary.errors} error(s) · ${r.summary.warnings} warning(s) · ${r.summary.debt} baselined  ${DIM}(exit ${r.exit_code})${RST}`);
  if (mech > 0 && !r.fix_outcome) lines.push(`  ${DIM}${mech} finding(s) have a mechanical fixer: nrv validate ${r.kind} ${r.slug} --fix${RST}`);
  return lines.join("\n");
}

export function renderBatch(b: BatchReport, opts: { quiet?: boolean } = {}): string {
  const lines: string[] = [];
  lines.push(`${BOLD}VERIFY ${b.mode === "pack" ? "pack" : "all"} — ${b.kinds.join(", ")}${RST} ${DIM}${b.entities} entities${RST}`);
  for (const r of b.reports) {
    if (opts.quiet && r.exit_code === 0) continue;
    const mark = r.exit_code === 0 ? `${GRN}✓${RST}` : `${RED}✗${RST}`;
    lines.push(`  ${mark} ${(r.kind + ":" + r.slug).padEnd(46)} ${r.summary.errors} err · ${r.summary.warnings} warn · ${r.summary.debt} debt`);
    if (!opts.quiet || r.exit_code !== 0) {
      for (const f of r.findings.filter((x) => !x.baselined && x.severity === "error").slice(0, 6)) lines.push(`      ${RED}✗${RST} ${f.where ? `${f.id}:${f.where}` : f.id} — ${f.message}`);
    }
  }
  lines.push("");
  lines.push(`${b.summary.admitted} admitted · ${RED}${b.summary.rejected} rejected${RST} · ${b.summary.errors} error(s) · ${b.summary.warnings} warning(s) · ${b.summary.debt} baselined`);
  if (b.baseline.recorded) lines.push(`${GRN}Debt recorded${RST} → ${home(b.baseline.path ?? "")}`);
  if (b.baseline.regressions?.length) {
    lines.push(`${RED}Refusing to record: ${b.baseline.regressions.length} entity(ies) would gain NEW debt.${RST}`);
    for (const r of b.baseline.regressions.slice(0, 10)) lines.push(`  ${r.entity}: ${r.added.join(", ")}`);
    lines.push(`${DIM}  Fix the metadata, or record deliberately with --allow-regression.${RST}`);
  }
  if (!b.baseline.present) lines.push(`${DIM}No debt baseline: every baselineable warning counts. Record one with --record.${RST}`);
  lines.push(`${DIM}(exit ${b.exit_code})${RST}`);
  return lines.join("\n");
}
