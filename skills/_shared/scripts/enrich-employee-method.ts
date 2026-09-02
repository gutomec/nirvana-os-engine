#!/usr/bin/env bun
/**
 * enrich-employee-method.ts — fills a thin seat with its own operating method.
 *
 * The per-task clone model (0.7.0) made "no clone" a legitimate outcome of any
 * dispatch, which turns the employee body into the seat's whole method. The
 * admission gate measures that body (`seat_thin`, seat-sufficiency.js) and
 * check-seat-sufficiency.ts has pointed at THIS script since the gate shipped —
 * but the script did not exist: a thin seat's `autofix: "agentic"` aimed at a
 * dangling reference, and the owner saw the pointer on screen with nothing
 * behind it (found 2026-09-01, auditing why created businesses read generic).
 *
 * The contract is enrich-routing-metadata.ts's, applied to seat bodies:
 *
 *   GENERATE   a headless LLM writes method sections grounded ONLY in what the
 *              seat and its business already declare — the frontmatter's
 *              self_score criteria, the authorized squads, the assigned
 *              clones, the org-chart position. Nothing invented.
 *   VALIDATE   shape first (section count, heading collisions, placeholders,
 *              language match, frontmatter-fence injection), then the SAME
 *              deterministic measure the admission gate runs: the assembled
 *              file must come out "sufficient" per sufficiencyOfFile.
 *   SURGICAL   the original file — frontmatter AND existing body — is
 *              preserved byte-identical as a prefix; generated sections are
 *              appended after it. A revert is a byte comparison away.
 *   GATE FIRST the measure is pure computation over text, so unlike the
 *              routing enricher this gate runs BEFORE the write: a candidate
 *              that fails never touches disk. Retries carry the signals
 *              (headings / decision lines) as feedback.
 *   PROVE      after a business's seats are written, its loader must still
 *              accept the whole business — a rejection reverts every seat of
 *              that business.
 *
 * No reindex and no self-retrieval gate on purpose: the body is not routing
 * metadata — BM25 and the agentic router never read past the frontmatter, so
 * retrieval cannot regress from this write.
 *
 * CLI (flags mirror enrich-routing-metadata.ts):
 *   bun enrich-employee-method.ts --slugs=biz-a,biz-b        [--seats=x,y] [--dry]
 *   bun enrich-employee-method.ts --missing [--limit=N]
 *   --attempts=N --runtime=R --model=M --scratch=DIR --timeout-min=N --budget-usd=N
 *
 * Exit codes: 0 = batch done (statuses in the report), 2 = bad usage.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { resolveScope } from "../lib/scope.ts";
import { paths } from "../lib/bun-helpers.ts";
import { runHeadless, runtimeAvailable, type Runtime } from "../../harness/lib/host-agent-driver.ts";
import { backupFile, detectLang, extractJson, restoreBackup, type BackupEntry } from "./enrich-routing-metadata.ts";

const require_ = createRequire(import.meta.url);
const { sufficiencyOfFile, stripFrontmatter } = require_("../lib/seat-sufficiency.js") as {
  sufficiencyOfFile(content: string): { verdict: "sufficient" | "thin"; signals: SeatSignals };
  stripFrontmatter(content: string): string;
};

export interface SeatSignals { headings: number; decisionLines: number; bodyChars: number; nonEmptyLines: number }

// ═══════════════════════════════════════════════════════════════════════════
// Pure helpers (unit-tested, no LLM, no filesystem beyond what they receive)
// ═══════════════════════════════════════════════════════════════════════════

export interface MethodSection { heading: string; body: string }

const normHeading = (s: string) =>
  String(s).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();

/** H2/H3 and bold-line pseudo-headings of the existing body, normalized —
 *  the same forms seat-sufficiency.js counts as structure. */
export function existingHeadings(content: string): Set<string> {
  const out = new Set<string>();
  for (const line of stripFrontmatter(content).split(/\r?\n/)) {
    const t = line.trim();
    const h = /^#{1,4}\s+(.+)$/.exec(t);
    if (h) { out.add(normHeading(h[1])); continue; }
    const p = /^\*\*([^*]{2,60})\*\*:?\s*$/.exec(t);
    if (p) out.add(normHeading(p[1]));
  }
  return out;
}

/** The language the generated method must be written in: the existing body
 *  decides when it says anything; the frontmatter description is the fallback;
 *  PT-BR is the house default (employee content is user-language). */
export function expectedLang(seatContent: string): "pt" | "en" {
  const body = stripFrontmatter(seatContent).trim();
  if (body) {
    const l = detectLang(body);
    if (l !== "other") return l;
  }
  const desc = /^\s*description:\s*["']?(.+?)["']?\s*$/m.exec(seatContent);
  if (desc) {
    const l = detectLang(desc[1]);
    if (l !== "other") return l;
  }
  return "pt";
}

// TWO regexes on purpose: TODO/FIXME are markers only in UPPERCASE — a
// case-insensitive \bTODO\b matches "todo", one of the most common words in
// Portuguese ("todo indicador resolve até a origem" sits in a real seat's own
// frontmatter), and the first live run burned $5.86 rejecting three honest
// PT-BR generations for exactly that.
const PLACEHOLDER_MARKER_RE = /\b(TODO|FIXME)\b/;
const PLACEHOLDER_PROSE_RE = /\b(placeholder|replace with|lorem ipsum|preencher aqui)\b/i;
const hasPlaceholder = (s: string) => PLACEHOLDER_MARKER_RE.test(s) || PLACEHOLDER_PROSE_RE.test(s);
/** Appended-content budget: a seat is a working method, not a book — and the
 *  employee spawn concatenates every byte of it into the prompt (§6.8). */
export const MAX_GENERATED_CHARS = 9000;

export function validateSections(
  raw: unknown,
  ctx: { seatContent: string; lang: "pt" | "en" },
): { ok: boolean; errors: string[]; cleaned?: MethodSection[] } {
  const errors: string[] = [];
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const arr = Array.isArray(obj.sections) ? obj.sections : null;
  if (!arr) return { ok: false, errors: ["sections: missing or not an array"] };

  const taken = existingHeadings(ctx.seatContent);
  const cleaned: MethodSection[] = [];
  for (const s of arr) {
    const sec = (s && typeof s === "object" ? s : {}) as Record<string, unknown>;
    const heading = typeof sec.heading === "string" ? sec.heading.trim() : "";
    const body = typeof sec.body === "string" ? sec.body.trim() : "";
    if (!heading || heading.length < 3 || heading.length > 80) { errors.push(`heading out of 3-80 chars: "${heading.slice(0, 40)}"`); continue; }
    if (heading.includes("#")) { errors.push(`heading carries markdown marks — plain text only (## is added on assembly): "${heading.slice(0, 40)}"`); continue; }
    if (!body) { errors.push(`section "${heading.slice(0, 40)}": empty body`); continue; }
    // A line of exactly --- would read as a frontmatter fence to naive
    // splitters; a generated section never needs a thematic break.
    if (/^---\s*$/m.test(body)) { errors.push(`section "${heading.slice(0, 40)}": contains a --- line (frontmatter-fence injection)`); continue; }
    if (hasPlaceholder(body) || hasPlaceholder(heading)) { errors.push(`section "${heading.slice(0, 40)}": placeholder text — write the real method`); continue; }
    const norm = normHeading(heading);
    if (taken.has(norm)) { errors.push(`heading duplicates an existing section: "${heading.slice(0, 40)}"`); continue; }
    taken.add(norm);
    cleaned.push({ heading, body });
  }
  if (cleaned.length < 2 || cleaned.length > 8) errors.push(`sections: ${cleaned.length} valid — need 2-8`);

  const joined = cleaned.map((s) => `${s.heading}\n${s.body}`).join("\n");
  if (joined.length > MAX_GENERATED_CHARS) errors.push(`generated method is ${joined.length} chars — cap is ${MAX_GENERATED_CHARS} (a seat is a method, not a book)`);
  const lang = detectLang(joined);
  if (lang !== "other" && lang !== ctx.lang) errors.push(`language mismatch: seat is ${ctx.lang}, generated text reads ${lang}`);

  if (errors.length) return { ok: false, errors };

  // The admission measure itself, asked BEFORE any write: the assembled file
  // must be sufficient, or the attempt never touches disk.
  const assembled = assembleSeat(ctx.seatContent, cleaned);
  const verdict = sufficiencyOfFile(assembled);
  if (verdict.verdict !== "sufficient") {
    return { ok: false, errors: [sufficiencyFeedback(verdict.signals)] };
  }
  return { ok: true, errors: [], cleaned };
}

/** Original file preserved byte-identical as prefix (minus trailing blank
 *  lines); generated sections appended as H2 blocks. */
export function assembleSeat(originalContent: string, sections: MethodSection[]): string {
  const base = originalContent.replace(/\s+$/, "");
  const blocks = sections.map((s) => `## ${s.heading}\n\n${s.body}`).join("\n\n");
  return `${base}\n\n${blocks}\n`;
}

/** Retry feedback in the measure's own terms, so the model aims at the real
 *  bar instead of guessing which of the three sufficiency rules to satisfy. */
export function sufficiencyFeedback(signals: SeatSignals): string {
  return (
    `still thin after assembly: headings=${signals.headings} decisionLines=${signals.decisionLines} bodyChars=${signals.bodyChars}. ` +
    `Sufficiency needs (>=2 headings AND >=5 decision lines) OR >=10 decision lines OR (>=4 headings AND >=1500 chars). ` +
    `A decision line is a DO/DON'T rule (nunca/sempre/never/always/recuso...), a number or threshold, ` +
    `a list item with >=30 chars of substance, or a table data row. Write MORE CONCRETE rules, not more prose.`
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Library access + prompt
// ═══════════════════════════════════════════════════════════════════════════

function businessDirs(): string[] {
  const scope = resolveScope();
  return scope.businessDirs.length ? scope.businessDirs : [paths.BUSINESSES_DIR];
}

function findBusinessDir(slug: string): string | null {
  for (const root of businessDirs()) {
    const dir = path.join(root, slug);
    if (fs.existsSync(path.join(dir, "business.yaml"))) return dir;
  }
  return null;
}

export interface SeatFile { slug: string; file: string; content: string; verdict: "sufficient" | "thin"; signals: SeatSignals }

export function listSeats(bizDir: string): SeatFile[] {
  const dir = path.join(bizDir, "employees");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort().map((f) => {
    const file = path.join(dir, f);
    const content = fs.readFileSync(file, "utf8");
    const s = sufficiencyOfFile(content);
    return { slug: f.replace(/\.md$/, ""), file, content, verdict: s.verdict, signals: s.signals };
  });
}

function readCapped(file: string, cap: number): string {
  if (!fs.existsSync(file)) return "";
  const s = fs.readFileSync(file, "utf8");
  return s.length > cap ? s.slice(0, cap) + "\n…(truncated for prompt)" : s;
}

const METHOD_CONTRACT_DIGEST = `
WHAT METHOD CONTENT IS (the admission gate measures exactly this):
- Decision rules the seat applies alone: thresholds with numbers, DO/DON'T lines
  (nunca/sempre/recuso...), reject criteria, revision triggers. Digits, not spelled-out numbers.
- Procedures: the ordered steps of the seat's core loop, each step checkable.
- Boundaries: what this seat hands to which authorized squad, what escalates to
  the seat it reports to, what it refuses outright.
- Acceptance: how the seat judges its OWN output before handoff — anchor every
  self_score_contract criterion from the frontmatter in at least one concrete rule.

WHAT IS BANNED:
- Restating the role or description in different words. The frontmatter already says who the seat is.
- Inventing facts: no metrics presented as measured, no clients, partners, tools or
  history the business never declared. A threshold is the seat's own working rule, stated as a rule.
- Generic filler that would fit any business ("garanta a qualidade", "seja estratégico").
  Every rule must use THIS business's vocabulary.
- Placeholders, TODOs, headings that duplicate existing sections.
`.trim();

export function buildSeatPrompt(
  businessSlug: string,
  bizDir: string,
  seat: SeatFile,
  siblings: SeatFile[],
  lang: "pt" | "en",
  retryFeedback: string | null,
): string {
  const siblingHeadings = siblings
    .filter((s) => s.slug !== seat.slug && s.verdict === "sufficient")
    .slice(0, 3)
    .map((s) => `--- ${s.slug} ---\n` + stripFrontmatter(s.content).split("\n").filter((l) => /^#{2,3}\s/.test(l)).slice(0, 10).join("\n"))
    .join("\n") || "(no sufficient sibling to mirror)";

  return [
    `You are writing the OPERATING METHOD of the seat "${seat.slug}" of the Nirvana-OS business "${businessSlug}".`,
    "Under the per-task clone model a dispatch may run with no mind-clone, and then the seat executes on its own written method — the body you are about to extend is everything it has.",
    "Your ONLY output is one JSON object — no prose, no markdown fences:",
    "",
    '{ "sections": [ { "heading": string, "body": string } ] }',
    "",
    `3-5 sections. Headings are plain text (no # marks). Bodies are markdown, written in ${lang === "pt" ? "Brazilian Portuguese (PT-BR, diacritics intact)" : "English"} — the seat's own language.`,
    "The sections are APPENDED after the existing body: never repeat what it already says, never duplicate its headings.",
    "",
    METHOD_CONTRACT_DIGEST,
    "",
    retryFeedback ? `PREVIOUS ATTEMPT FEEDBACK (fix this without breaking the rules above):\n${retryFeedback}\n` : "",
    "SOURCE MATERIAL (everything you may ground the method in — nothing outside it):",
    `=== the seat (employees/${seat.slug}.md, frontmatter + current body) ===`,
    seat.content.length > 8000 ? seat.content.slice(0, 8000) + "\n…(truncated)" : seat.content,
    "=== business.yaml (excerpt) ===",
    readCapped(path.join(bizDir, "business.yaml"), 6000),
    "=== org-chart.yaml (excerpt) ===",
    readCapped(path.join(bizDir, "org-chart.yaml"), 2500),
    "=== headings of sufficient sibling seats (shape reference, NOT content to copy) ===",
    siblingHeadings,
    "",
    "Answer with the JSON object only.",
  ].join("\n");
}

// ═══════════════════════════════════════════════════════════════════════════
// Pipeline
// ═══════════════════════════════════════════════════════════════════════════

export interface GenResult { ok: boolean; json: unknown; costUsd: number | null; error?: string }
export type GenerateFn = (prompt: string) => GenResult;

export interface RunCtx {
  attempts: number;
  backupRoot: string;
  /** Test seam, same style as verify/agentic.ts `runHeadlessImpl`. */
  generate: GenerateFn;
}

export interface SeatReport {
  business: string;
  seat: string;
  status: "enriched" | "gate_failed" | "skipped" | "dry" | "reverted_by_loader";
  attempts: number;
  signals_before: SeatSignals;
  signals_after: SeatSignals | null;
  cost_usd: number;
  errors: string[];
}

export function enrichSeat(businessSlug: string, bizDir: string, seat: SeatFile, siblings: SeatFile[], ctx: RunCtx): { report: SeatReport; backup: BackupEntry | null } {
  const report: SeatReport = {
    business: businessSlug, seat: seat.slug, status: "skipped", attempts: 0,
    signals_before: seat.signals, signals_after: null, cost_usd: 0, errors: [],
  };
  const lang = expectedLang(seat.content);
  let retryFeedback: string | null = null;

  for (let attempt = 1; attempt <= ctx.attempts; attempt++) {
    report.attempts = attempt;
    const prompt = buildSeatPrompt(businessSlug, bizDir, seat, siblings, lang, retryFeedback);
    let gen = ctx.generate(prompt);
    report.cost_usd += gen.costUsd || 0;

    let validation = validateSections(gen.json, { seatContent: seat.content, lang });
    if (gen.ok && !validation.ok) {
      // One in-attempt shape repair: feed the errors back once (sibling pattern).
      const repairPrompt = prompt + "\n\nYOUR PREVIOUS ANSWER FAILED VALIDATION:\n- " + validation.errors.join("\n- ") + "\n\nAnswer again with a corrected JSON object only.";
      gen = ctx.generate(repairPrompt);
      report.cost_usd += gen.costUsd || 0;
      validation = validateSections(gen.json, { seatContent: seat.content, lang });
    }
    if (!gen.ok || !validation.ok) {
      report.errors.push(...(gen.error ? [`attempt ${attempt}: ${gen.error}`] : []), ...validation.errors.map((e) => `attempt ${attempt}: ${e}`));
      retryFeedback = validation.errors.join("\n") || gen.error || null;
      continue;
    }

    // The gate already passed inside validateSections — this write cannot be thin.
    const assembled = assembleSeat(seat.content, validation.cleaned!);
    const backup = backupFile(ctx.backupRoot, seat.file);
    fs.writeFileSync(seat.file, assembled, "utf8");
    report.signals_after = sufficiencyOfFile(assembled).signals;
    report.status = "enriched";
    return { report, backup };
  }
  report.status = "gate_failed";
  return { report, backup: null };
}

export async function enrichBusinessSeats(
  slug: string,
  ctx: RunCtx,
  opts: { seats?: string[] } = {},
): Promise<SeatReport[]> {
  const bizDir = findBusinessDir(slug);
  if (!bizDir) {
    return [{ business: slug, seat: "-", status: "skipped", attempts: 0, signals_before: { headings: 0, decisionLines: 0, bodyChars: 0, nonEmptyLines: 0 }, signals_after: null, cost_usd: 0, errors: ["business dir not found"] }];
  }
  const all = listSeats(bizDir);
  const thin = all.filter((s) => s.verdict === "thin" && (!opts.seats?.length || opts.seats.includes(s.slug)));
  if (!thin.length) {
    return [{ business: slug, seat: "-", status: "skipped", attempts: 0, signals_before: { headings: 0, decisionLines: 0, bodyChars: 0, nonEmptyLines: 0 }, signals_after: null, cost_usd: 0, errors: ["no thin seat matched"] }];
  }

  const reports: SeatReport[] = [];
  const backups: BackupEntry[] = [];
  for (const seat of thin) {
    const { report, backup } = enrichSeat(slug, bizDir, seat, all, ctx);
    reports.push(report);
    if (backup) backups.push(backup);
  }

  // Prove the business still loads whole. Frontmatter was never touched, so a
  // rejection here means the loader reads deeper than we assumed — revert
  // EVERY seat of this business rather than ship a business that will not load.
  if (backups.length) {
    try {
      const { loadBusiness } = await import("../../businesses/lib/loader.ts");
      loadBusiness(bizDir);
    } catch (e) {
      for (const b of backups) restoreBackup(b);
      for (const r of reports) if (r.status === "enriched") {
        r.status = "reverted_by_loader";
        r.errors.push(`loadBusiness rejected the enriched business: ${e}`);
      }
    }
  }
  return reports;
}

function listBusinessesWithThinSeats(limit: number): string[] {
  const out: string[] = [];
  for (const root of businessDirs()) {
    if (!fs.existsSync(root)) continue;
    for (const e of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!e.isDirectory() || e.name.startsWith(".") || e.name.startsWith("_")) continue;
      const dir = path.join(root, e.name);
      if (!fs.existsSync(path.join(dir, "business.yaml"))) continue;
      if (listSeats(dir).some((s) => s.verdict === "thin")) out.push(e.name);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// CLI
// ═══════════════════════════════════════════════════════════════════════════

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | null => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : null;
  };
  const has = (name: string) => argv.includes(`--${name}`);

  const dry = has("dry");
  const attempts = Math.max(1, Number(flag("attempts") || 3));
  const runtime = (flag("runtime") || "claude-code") as Runtime;
  const model = flag("model") || undefined;
  const scratch = flag("scratch") || path.join(os.tmpdir(), "nirvana-enrich-seats");
  const timeoutMs = Math.max(1, Number(flag("timeout-min") || 10)) * 60 * 1000;
  const budgetUsd = Number(flag("budget-usd") || 2);
  const seats = (flag("seats") || "").split(",").map((s) => s.trim()).filter(Boolean);

  let slugs: string[];
  if (flag("slugs")) {
    slugs = flag("slugs")!.split(",").map((s) => s.trim()).filter(Boolean);
  } else if (has("missing")) {
    slugs = listBusinessesWithThinSeats(Number(flag("limit") || 10));
  } else {
    console.error("usage: bun enrich-employee-method.ts (--slugs=biz-a,biz-b [--seats=x,y] | --missing [--limit=N]) [--dry] [--attempts=N] [--runtime=R] [--model=M] [--scratch=DIR] [--timeout-min=N] [--budget-usd=N]");
    process.exit(2);
  }
  if (!slugs.length) { console.error("enrich-seats: no business selected (nothing thin?)"); process.exit(0); }

  if (dry) {
    for (const slug of slugs) {
      const dir = findBusinessDir(slug);
      if (!dir) { console.log(`  ${slug}: NOT FOUND`); continue; }
      const thin = listSeats(dir).filter((s) => s.verdict === "thin" && (!seats.length || seats.includes(s.slug)));
      console.log(`  ${slug}: ${thin.length ? thin.map((s) => `${s.slug} (h=${s.signals.headings} d=${s.signals.decisionLines})`).join(", ") : "no thin seat"}`);
    }
    process.exit(0);
  }

  if (!runtimeAvailable(runtime)) { console.error(`enrich-seats: runtime '${runtime}' not on PATH`); process.exit(2); }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupRoot = path.join(scratch, `backups-${stamp}`);
  fs.mkdirSync(backupRoot, { recursive: true });

  const generate: GenerateFn = (prompt) => {
    const res = runHeadless({
      runtime, prompt, cwd: os.tmpdir(),
      allowedTools: [], // pure text generation — no filesystem, no web
      permissionMode: "default", model,
      maxBudgetUsd: budgetUsd, timeoutMs,
    });
    const json = res.ok ? extractJson(res.result) : null;
    return { ok: !!json, json, costUsd: res.costUsd, error: res.ok ? (json ? undefined : "no JSON object in the model output") : (res.error || "generation run failed") };
  };

  const ctx: RunCtx = { attempts, backupRoot, generate };
  const all: SeatReport[] = [];
  for (const slug of slugs) {
    console.log(`[enrich-seats] → ${slug}`);
    const reports = await enrichBusinessSeats(slug, ctx, { seats });
    for (const r of reports) {
      console.log(`[enrich-seats]   ${r.seat}: ${r.status}${r.signals_after ? ` (h=${r.signals_after.headings} d=${r.signals_after.decisionLines})` : ""}${r.errors.length ? ` — ${r.errors[r.errors.length - 1].slice(0, 120)}` : ""}`);
    }
    all.push(...reports);
  }

  const reportPath = path.join(scratch, `enrich-seats-${stamp}.json`);
  fs.writeFileSync(reportPath, JSON.stringify({
    started_at: stamp, slugs, attempts, runtime, model: model || null,
    total_cost_usd: all.reduce((n, r) => n + r.cost_usd, 0),
    seats: all, backup_root: backupRoot,
  }, null, 2) + "\n", "utf8");

  const counts: Record<string, number> = {};
  for (const r of all) counts[r.status] = (counts[r.status] || 0) + 1;
  console.log(`[enrich-seats] ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(" · ")} · cost=$${all.reduce((n, r) => n + r.cost_usd, 0).toFixed(2)}`);
  console.log(`[enrich-seats] report → ${reportPath}`);
  if (counts.enriched) {
    console.log(`[enrich-seats] debt shrank — re-record the ceiling: bun skills/_shared/scripts/check-seat-sufficiency.ts --record`);
  }
  process.exit(0);
}
