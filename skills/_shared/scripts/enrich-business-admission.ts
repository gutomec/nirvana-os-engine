#!/usr/bin/env bun
/**
 * enrich-business-admission.ts — repairs what the business admission gate
 * marks `autofix: "agentic"` on its buyer-facing surface, and proves it with
 * the gate itself.
 *
 * THE FINDINGS IT ANSWERS
 *
 *   routing_metadata_incomplete   `not_for` absent, or example_briefs in one
 *                                 language only (§6.9). The router reads both.
 *   auto_route_never_fires        a pattern that fires against no example_brief
 *                                 (§13.2). Measured on the pack sources
 *                                 2026-09-02: 341 of them across 27 businesses,
 *                                 all the v1 ticket dialect
 *                                 (`type:strategy|approval-gate|…`) — routing by
 *                                 ticket-type token, which no brief written in
 *                                 a human language ever contains.
 *   readme_thin                   the README is the scaffold the mechanical
 *                                 fixer wrote, not the document a buyer opens.
 *
 * The mechanical fixers refuse all three on purpose: each one is meaning. This
 * script writes the meaning with a headless LLM and keeps every deterministic
 * check the gate would run — on the candidate, BEFORE anything touches disk:
 *
 *   not_for          4-20 short token entries, 3-25 chars each (router.js
 *                    penalises by substring; past 25 chars the fence stops
 *                    firing), no "(use X)" suffix, no colon.
 *   example_briefs   existing + new, deduped, ≤30, every new one 20-1000 chars
 *                    and free of the business's own slug (§5); afterwards the
 *                    set classifies as BOTH pt and en by the gate's own
 *                    `classify`.
 *   routes           3-16, `(?i)` prefix (the gate compiles case-insensitive
 *                    ONLY with the prefix; the runtime router always does —
 *                    the prefix is the one form both agree on), compiles, is
 *                    not a catch-all, names an existing seat, fires on ≥1
 *                    brief; and every brief fires ≥1 route, so the business is
 *                    a candidate for each brief it declares as its own.
 *   readme           ≥40 lines, `## ` sections, ≥3 of the 4 groups the gate
 *                    looks for, no path into anyone's home directory.
 *
 * Writes are surgical: `not_for` and `example_briefs` replace their own
 * top-level blocks in business.yaml (indentation matched to the file), the
 * `auto_routes:` block of routing.yaml is replaced whole (the dead routes ARE
 * the defect; brief_intake and every other key survive verbatim), README.md
 * is written only when it was the target. Then the gate runs again on disk:
 * errors may not grow and every targeted finding must be gone, or every file
 * is restored from its backup and the attempt's failures feed the next prompt.
 *
 * `--dir` and `--pack` exist because pack SOURCES are not installed entities:
 * they live outside the resolved scope and have no registry. Neither mode
 * reindexes anything or touches a registry — the self-retrieval gate is the
 * installed library's question, asked by `nrv validate` after install.
 *
 * CLI:
 *   bun enrich-business-admission.ts --slugs=a,b            # installed library
 *   bun enrich-business-admission.ts --dir=<business-dir>   # one directory
 *   bun enrich-business-admission.ts --pack=<content-dir>   # every business of a pack source
 *   --dry --attempts=N --runtime=R --model=M --scratch=DIR --timeout-min=N --budget-usd=N
 *
 * Exit codes: 0 = batch done (statuses in the report), 2 = bad usage.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveScope } from "../lib/scope.ts";
import { paths } from "../lib/bun-helpers.ts";
import { classify } from "../lib/corpus-language.ts";
import { checkSync, readBusiness, type BusinessRead } from "../lib/verify/kinds/business.ts";
import { surfaceRegenFixer } from "../lib/verify/common.ts";
import { runHeadless, runtimeAvailable, type Runtime } from "../../harness/lib/host-agent-driver.ts";
import {
  backupFile, extractJson, restoreBackup, topLevelBlockSpan, verifyYamlSurgical, yamlScalar, type BackupEntry,
} from "./enrich-routing-metadata.ts";

const YAML = require("yaml");

// ═══════════════════════════════════════════════════════════════════════════
// Pure helpers (unit-tested, no LLM, no filesystem beyond what they receive)
// ═══════════════════════════════════════════════════════════════════════════

export const NOT_FOR_MAX_CHARS = 25;
export const README_MIN_LINES = 40;
export const EXAMPLE_BRIEFS_MAX = 30;
const CATCH_ALL = new Set([".*", ".+", "(?i).*", "(?i).+", "^.*$", "^.+$", "(?i)^.*$", "(?i)^.+$", ".*?"]);

export interface Route { pattern: string; route_to: string; why?: string }
export interface Generated { not_for: string[]; example_briefs: string[]; routes: Route[]; readme: string | null }
export interface Needs { notFor: boolean; briefLangs: boolean; routes: boolean; readme: boolean }

/** The gate's own compile: `(?i)` prefix → the i flag, nothing else. */
export function compileRoute(pattern: string): RegExp | null {
  try {
    const ci = pattern.startsWith("(?i)");
    return new RegExp(ci ? pattern.slice(4) : pattern, ci ? "i" : "");
  } catch { return null; }
}

/** What the gate reports as agentic on this business, read from its findings. */
export function needsOf(findings: Array<{ id: string; evidence?: string }>): Needs {
  const rmi = findings.find((f) => f.id === "routing_metadata_incomplete");
  const ev = rmi?.evidence ?? "";
  return {
    notFor: /\bnot_for\b/.test(ev),
    briefLangs: /example_briefs in both/.test(ev),
    routes: findings.some((f) => f.id === "auto_route_never_fires"),
    readme: findings.some((f) => f.id === "readme_thin" || f.id === "readme_missing"),
  };
}

export function validateGenerated(
  raw: unknown,
  ctx: { needs: Needs; slug: string; seats: string[]; existingBriefs: string[]; existingNotFor: string[] },
): { ok: boolean; errors: string[]; cleaned?: Generated } {
  const errors: string[] = [];
  const g = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean) : []);

  // ── not_for ──
  let notFor = ctx.existingNotFor;
  if (ctx.needs.notFor) {
    notFor = [...new Set(strs(g.not_for))];
    if (notFor.length < 4 || notFor.length > 20) errors.push(`not_for: ${notFor.length} entries — need 4-20`);
    for (const n of notFor) {
      if (n.length < 3 || n.length > NOT_FOR_MAX_CHARS) errors.push(`not_for: "${n.slice(0, 30)}" is ${n.length} chars — 3-${NOT_FOR_MAX_CHARS} (the router penalises by substring; longer never fires)`);
      if (/\(use\b/i.test(n) || n.includes(":")) errors.push(`not_for: "${n.slice(0, 30)}" — no "(use X)" suffix, no colon; a fence is a short token list`);
    }
  }

  // ── example_briefs ──
  const added = strs(g.example_briefs_add);
  const lowerExisting = new Set(ctx.existingBriefs.map((b) => b.toLowerCase()));
  const newOnes = added.filter((b) => !lowerExisting.has(b.toLowerCase()));
  for (const b of newOnes) {
    if (b.length < 20 || b.length > 1000) errors.push(`example_briefs_add: length out of 20-1000: "${b.slice(0, 40)}"`);
    if (b.toLowerCase().includes(ctx.slug.toLowerCase())) errors.push(`example_briefs_add: carries the business's own slug — self-retrieval would pass for the wrong reason (§5): "${b.slice(0, 40)}"`);
  }
  const briefs = [...ctx.existingBriefs, ...newOnes];
  if (briefs.length > EXAMPLE_BRIEFS_MAX) errors.push(`example_briefs: ${briefs.length} after merge — cap is ${EXAMPLE_BRIEFS_MAX}; add fewer`);
  if (ctx.needs.briefLangs || ctx.needs.routes) {
    const langs = new Set(briefs.map(classify));
    if (!langs.has("en") || !langs.has("pt")) errors.push(`example_briefs: need BOTH en and pt after merge — found ${[...langs].sort().join("+") || "none"} (the gate's classify counts language markers; write a brief a native would type)`);
  }

  // ── routes ──
  let routes: Route[] = [];
  if (ctx.needs.routes) {
    const rawRoutes = Array.isArray(g.routes) ? g.routes : [];
    if (rawRoutes.length < 3 || rawRoutes.length > 16) errors.push(`routes: ${rawRoutes.length} — need 3-16`);
    const seatSet = new Set(ctx.seats);
    const compiled: Array<{ route: Route; re: RegExp }> = [];
    for (const r of rawRoutes) {
      const o = (r && typeof r === "object" ? r : {}) as Record<string, unknown>;
      const pattern = typeof o.pattern === "string" ? o.pattern.trim() : "";
      const route_to = typeof o.route_to === "string" ? o.route_to.trim() : "";
      const why = typeof o.why === "string" ? o.why.trim().split("\n")[0].slice(0, 160) : undefined;
      const label = pattern.slice(0, 48) || "(empty)";
      if (!pattern.startsWith("(?i)")) { errors.push(`routes: ${label} — every pattern starts with (?i); the gate compiles case-insensitive only with the prefix`); continue; }
      if (CATCH_ALL.has(pattern)) { errors.push(`routes: ${label} matches every brief — a catch-all is ignored and silences every route below it`); continue; }
      const re = compileRoute(pattern);
      if (!re) { errors.push(`routes: ${label} does not compile as a JavaScript regex`); continue; }
      if (!seatSet.has(route_to)) { errors.push(`routes: route_to "${route_to}" is not a seat of ${ctx.slug} (seats: ${ctx.seats.join(", ")})`); continue; }
      if (!briefs.some((b) => re.test(b))) { errors.push(`routes: ${label} fires against none of the ${briefs.length} example_briefs — add a brief it fires on, or drop the route`); continue; }
      compiled.push({ route: { pattern, route_to, ...(why ? { why } : {}) }, re });
    }
    for (const b of briefs) {
      if (!compiled.some((c) => c.re.test(b))) errors.push(`routes: no route fires on the brief "${b.slice(0, 70)}" — the business would not be a candidate for its own brief`);
    }
    routes = compiled.map((c) => c.route);
  }

  // ── readme ──
  let readme: string | null = null;
  if (ctx.needs.readme) {
    readme = typeof g.readme === "string" ? g.readme.trim() + "\n" : null;
    if (!readme) errors.push("readme: missing — a README was requested");
    else {
      const lines = readme.split("\n").length;
      if (lines < README_MIN_LINES) errors.push(`readme: ${lines} lines — the gate wants at least ${README_MIN_LINES}`);
      const lower = readme.toLowerCase();
      const groups = [["## "], ["employee", "funcionário", "cargo", "role", "seat"], ["usage", "uso", "como", "getting started"], ["domain", "domínio", "description", "descrição", "sobre", "what it"]];
      const covered = groups.filter((gr) => gr.some((kw) => lower.includes(kw))).length;
      if (covered < 3) errors.push(`readme: covers ${covered}/4 of the section groups the gate looks for (headings, employees, usage, domain)`);
      if (/\/Users\/|\/home\/|~\//.test(readme)) errors.push("readme: points at a path in someone's home directory — a buyer's copy lives elsewhere");
      if (/\b(TODO|FIXME)\b/.test(readme) || /Replace it with the real thing/.test(readme)) errors.push("readme: still carries scaffold text");
    }
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, errors: [], cleaned: { not_for: notFor, example_briefs: briefs, routes, readme } };
}

/** The indent the file already uses for top-level list items ("" or "  "). */
export function listIndentOf(yamlText: string): string {
  const m = /^[A-Za-z_][\w.-]*:\s*\n(\s*)- /m.exec(yamlText);
  return m ? m[1] : "  ";
}

/** Replace (or append) a top-level list block, matching the file's indent. */
export function setTopLevelList(text: string, key: string, items: string[]): string {
  const indent = listIndentOf(text);
  const emitted = [`${key}:`, ...items.map((it) => `${indent}- ${yamlScalar(it)}`)].join("\n") + "\n";
  const span = topLevelBlockSpan(text, key);
  if (span) return text.slice(0, span.start) + emitted + text.slice(span.end);
  let t = text;
  if (!t.endsWith("\n")) t += "\n";
  return t + emitted;
}

const HEADER = [
  "# Business Protocol 2.0 §13.2: a route makes the business a candidate AND selects",
  "# the seat that receives the brief. First pattern that matches wins, so the order",
  "# below runs specific to general. Every pattern fires against at least one",
  "# example_brief of this business; a pattern that fires only in the author's head",
  "# is not a route.",
];

/** Rewrite the `auto_routes:` block of routing.yaml; every other key survives verbatim. */
export function setAutoRoutes(routingText: string | null, routes: Route[], intake: string | null): string {
  const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
  const body = routes.flatMap((r) => [...(r.why ? [`# ${r.why}`] : []), `- pattern: ${q(r.pattern)}`, `  route_to: ${r.route_to}`]);
  const block = [...HEADER, "auto_routes:", ...body].join("\n") + "\n";
  let text = routingText ?? "";
  if (!text.trim()) return `brief_intake:\n  default_employee: ${intake ?? routes[0]?.route_to ?? ""}\n  alternates: []\n${block}`;
  if (!text.endsWith("\n")) text += "\n";
  const span = topLevelBlockSpan(text, "auto_routes");
  if (!span) return text + block;
  // A comment run directly above the old block belongs to it: drop it too.
  let start = span.start;
  const before = text.slice(0, start).split("\n");
  before.pop(); // the empty tail after the last \n
  while (before.length && /^#/.test(before[before.length - 1])) before.pop();
  start = before.length ? before.join("\n").length + 1 : 0;
  return text.slice(0, start) + block + text.slice(span.end);
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

function readCapped(file: string, cap: number): string {
  if (!fs.existsSync(file)) return "";
  const s = fs.readFileSync(file, "utf8");
  return s.length > cap ? s.slice(0, cap) + "\n…(truncated for prompt)" : s;
}

function seatDigest(b: BusinessRead): string {
  return b.seats.map((s) => {
    const d = s.data ?? {};
    const pick = (k: string) => (d[k] === undefined ? "" : ` ${k}=${JSON.stringify(d[k])}`);
    return `- ${s.name}:${pick("role")}${pick("is_brief_intake")}${pick("reports_to")}${pick("manages")}\n    description: ${String(d.description ?? "").slice(0, 320)}`;
  }).join("\n");
}

const CONTRACT = `
THE CONTRACT (Business Protocol 2.0 §6.9 and §13.2, distilled):
- not_for: 4-20 SHORT entries, 3-25 characters each, 2-4 content words. A fence is a token the
  router penalises by substring — "recrutar desenvolvedor", "hire developers", "on-call 24x7".
  PT and EN are SEPARATE entries. Never a sentence, never "(use X)", never a colon. Only what
  the business genuinely refuses — a defensive fence removes it from a comparison it might win.
- example_briefs_add: new briefs written as a REAL user types them — first person, symptom
  language, conjugated AND infinitive verb forms, concrete nouns of the domain. 20-1000 chars.
  Add what is needed so the set carries BOTH English and Portuguese and so every route below
  fires on at least one brief. Never include the business's own slug.
- routes: the auto_routes of routing.yaml, REPLACING the current ones. Each pattern is a regex
  with the (?i) prefix, PT and EN in one alternation, verb STEMS (escrev\\w* covers
  escrever/escreva/escrevendo), accent variants where diacritics occur (c[oó]digo), anchored on
  content nouns — never scaffold words (quero, preciso, please, help). First match wins: order
  SPECIFIC to GENERAL, and give each route a one-line "why" when its position matters.
  route_to names a seat that RECEIVES briefs: the intake seat, the leads/heads, and cross-cutting
  utility seats (QA, security, compliance). An individual contributor is reached through the org
  chart by its lead, never by routing a whole brief around the lead. Every route MUST fire on at
  least one example_brief (existing + added), and every example_brief MUST fire at least one route.
- readme (only when requested): the document a BUYER opens first, in English, 45-75 lines,
  Markdown with "## " sections (it MAY contain fenced code blocks — keep the JSON valid, newlines as \n): what the business is (2-3 paragraphs, concrete artifacts), the
  domains, what it produces, the org chart as a list of seats with one line each, the ship gate
  (what acceptance blocks), usage (how to brief it: \`nrv run <slug> "<brief>"\` and the intake
  seat), and layout. Never a path into a home directory, never a TODO, never marketing adjectives.
`.trim();

export function buildPrompt(slug: string, dir: string, b: BusinessRead, needs: Needs, retryFeedback: string | null): string {
  const wanted: string[] = [];
  if (needs.notFor) wanted.push('"not_for": string[]');
  wanted.push('"example_briefs_add": string[]   // may be empty when the existing set already satisfies the rules');
  if (needs.routes) wanted.push('"routes": [{ "pattern": string, "route_to": string, "why": string|null }]');
  if (needs.readme) wanted.push('"readme": string   // the full README.md as Markdown');
  return [
    `You are completing the buyer-facing surface of the Nirvana-OS business "${slug}" so it passes the admission gate.`,
    "Your ONLY output is one JSON object — no prose, no markdown fences. UTF-8, PT-BR diacritics intact, no trailing commas.",
    "",
    CONTRACT,
    "",
    "FIELDS TO GENERATE (JSON object with exactly these keys):",
    "{",
    wanted.map((w) => "  " + w).join(",\n"),
    "}",
    "",
    retryFeedback ? `PREVIOUS ATTEMPT FEEDBACK (fix exactly this, without breaking the rules above):\n${retryFeedback}\n` : "",
    "SOURCE MATERIAL:",
    "=== business.yaml ===",
    readCapped(path.join(dir, "business.yaml"), 12000),
    "=== routing.yaml (current — its auto_routes are the v1 ticket dialect and will be REPLACED by yours) ===",
    readCapped(path.join(dir, "routing.yaml"), 5000) || "(absent)",
    "=== org-chart.yaml ===",
    readCapped(path.join(dir, "org-chart.yaml"), 3000) || "(absent)",
    `=== seats (${b.seats.length}) — name, role, intake flag, reporting line, description ===`,
    seatDigest(b),
    "",
    "Answer with the JSON object only.",
  ].join("\n");
}

// ═══════════════════════════════════════════════════════════════════════════
// Pipeline
// ═══════════════════════════════════════════════════════════════════════════

export interface GenResult { ok: boolean; json: unknown; costUsd: number | null; error?: string }
export type GenerateFn = (prompt: string) => GenResult;
export interface RunCtx { attempts: number; backupRoot: string; generate: GenerateFn }

export interface BusinessReport {
  slug: string;
  dir: string;
  status: "enriched" | "gate_failed" | "skipped" | "dry";
  needs: Needs;
  attempts: number;
  findings_before: { errors: number; warnings: number; dead_routes: number };
  findings_after: { errors: number; warnings: number; dead_routes: number } | null;
  files_written: string[];
  cost_usd: number;
  errors: string[];
}

function summarize(findings: Array<{ id: string; severity: string }>) {
  return {
    errors: findings.filter((f) => f.severity === "error").length,
    warnings: findings.filter((f) => f.severity === "warning").length,
    dead_routes: findings.filter((f) => f.id === "auto_route_never_fires").length,
  };
}

export async function enrichBusinessDir(dir: string, ctx: RunCtx, opts: { dry?: boolean } = {}): Promise<BusinessReport> {
  const slug = path.basename(dir);
  const before = checkSync(dir) as Array<{ id: string; severity: string; evidence?: string }>;
  const needs = needsOf(before);
  const report: BusinessReport = {
    slug, dir, status: "skipped", needs, attempts: 0,
    findings_before: summarize(before), findings_after: null, files_written: [], cost_usd: 0, errors: [],
  };
  if (!needs.notFor && !needs.briefLangs && !needs.routes && !needs.readme) {
    report.errors.push("nothing agentic to repair on the buyer-facing surface");
    return report;
  }
  if (opts.dry) { report.status = "dry"; return report; }

  const b = readBusiness(dir);
  if (!b.manifest) { report.errors.push(`business.yaml does not load: ${b.parseError}`); return report; }
  const seats = b.seats.map((s) => s.name);
  const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  const existingBriefs = strs(b.manifest.example_briefs);
  const existingNotFor = strs(b.manifest.not_for);
  const intake = b.seats.find((s) => s.data?.is_brief_intake === true)?.name ?? null;

  const bizPath = path.join(dir, "business.yaml");
  const routingPath = path.join(dir, "routing.yaml");
  const readmePath = path.join(dir, "README.md");
  let retryFeedback: string | null = null;

  for (let attempt = 1; attempt <= ctx.attempts; attempt++) {
    report.attempts = attempt;
    const prompt = buildPrompt(slug, dir, b, needs, retryFeedback);
    let gen = ctx.generate(prompt);
    report.cost_usd += gen.costUsd || 0;
    const vctx = { needs, slug, seats, existingBriefs, existingNotFor };
    let validation = validateGenerated(gen.json, vctx);
    if (gen.ok && !validation.ok) {
      // One in-attempt shape repair (sibling pattern): feed the errors back once.
      const repair = prompt + "\n\nYOUR PREVIOUS ANSWER FAILED VALIDATION:\n- " + validation.errors.slice(0, 25).join("\n- ") + "\n\nAnswer again with a corrected JSON object only.";
      gen = ctx.generate(repair);
      report.cost_usd += gen.costUsd || 0;
      validation = validateGenerated(gen.json, vctx);
    }
    if (!gen.ok || !validation.ok) {
      const errs = [...(gen.error ? [gen.error] : []), ...validation.errors];
      report.errors.push(...errs.map((e) => `attempt ${attempt}: ${e}`));
      retryFeedback = errs.slice(0, 25).join("\n");
      continue;
    }
    const c = validation.cleaned!;

    // ── write, surgically ──
    const backups: BackupEntry[] = [];
    const written: string[] = [];
    const oldBiz = fs.readFileSync(bizPath, "utf8");
    let newBiz = oldBiz;
    const touched: string[] = []; const intended: Record<string, unknown> = {};
    if (needs.notFor) { newBiz = setTopLevelList(newBiz, "not_for", c.not_for); touched.push("not_for"); intended.not_for = c.not_for; }
    if (c.example_briefs.length !== existingBriefs.length) { newBiz = setTopLevelList(newBiz, "example_briefs", c.example_briefs); touched.push("example_briefs"); intended.example_briefs = c.example_briefs; }
    if (touched.length) {
      const integrity = verifyYamlSurgical(oldBiz, newBiz, touched, intended);
      if (!integrity.ok) { report.errors.push(...integrity.errors.map((e) => `attempt ${attempt}: integrity: ${e}`)); retryFeedback = integrity.errors.join("\n"); continue; }
      backups.push(backupFile(ctx.backupRoot, bizPath));
      fs.writeFileSync(bizPath, newBiz, "utf8"); written.push(`business.yaml (${touched.join(", ")})`);
    }
    if (needs.routes) {
      const oldRouting = fs.existsSync(routingPath) ? fs.readFileSync(routingPath, "utf8") : null;
      const newRouting = setAutoRoutes(oldRouting, c.routes, intake);
      const intendedRoutes = c.routes.map((r) => ({ pattern: r.pattern, route_to: r.route_to }));
      // A routing.yaml written from nothing also gains brief_intake — declare it, or the
      // integrity check reads it as an unexpected key.
      const routingTouched = oldRouting ? ["auto_routes"] : ["auto_routes", "brief_intake"];
      const integrity = verifyYamlSurgical(oldRouting ?? "", newRouting, routingTouched, { auto_routes: intendedRoutes });
      if (!integrity.ok) {
        for (const bk of backups) restoreBackup(bk);
        report.errors.push(...integrity.errors.map((e) => `attempt ${attempt}: routing integrity: ${e}`)); retryFeedback = integrity.errors.join("\n"); continue;
      }
      backups.push(backupFile(ctx.backupRoot, routingPath));
      fs.writeFileSync(routingPath, newRouting, "utf8"); written.push(`routing.yaml (auto_routes ×${c.routes.length})`);
    }
    if (needs.readme && c.readme) {
      backups.push(backupFile(ctx.backupRoot, readmePath));
      fs.writeFileSync(readmePath, c.readme, "utf8"); written.push("README.md");
    }
    // The surface hashes the prose just rewritten; left alone it reads `surface_stale`
    // on the very next gate run. Same fixer `--fix` uses; restored with the rest on revert.
    const surfacePath = path.join(dir, ".nirvana-surface.json");
    backups.push(backupFile(ctx.backupRoot, surfacePath));
    surfaceRegenFixer("business")({ dir, finding: { id: "surface_stale" } } as never);

    // ── prove with the gate itself, on disk ──
    const after = checkSync(dir) as Array<{ id: string; severity: string; evidence?: string }>;
    const afterNeeds = needsOf(after);
    const sumAfter = summarize(after);
    const problems: string[] = [];
    if (sumAfter.errors > report.findings_before.errors) problems.push(`errors grew ${report.findings_before.errors} → ${sumAfter.errors}: ${after.filter((f) => f.severity === "error").map((f) => f.id).join(", ")}`);
    if (needs.notFor && afterNeeds.notFor) problems.push("not_for still reported missing");
    if ((needs.briefLangs || needs.routes) && afterNeeds.briefLangs) problems.push("example_briefs still in one language per the gate");
    if (needs.routes && sumAfter.dead_routes > 0) problems.push(`${sumAfter.dead_routes} route(s) still fire on no brief per the gate`);
    if (needs.readme && afterNeeds.readme) problems.push("README still thin per the gate");
    try {
      const { loadBusiness } = await import("../../businesses/lib/loader.ts");
      loadBusiness(dir);
    } catch (e) { problems.push(`loadBusiness rejected the write: ${String(e).split("\n")[0]}`); }

    if (problems.length) {
      for (const bk of backups) restoreBackup(bk);
      report.errors.push(...problems.map((p) => `attempt ${attempt}: ${p}`));
      retryFeedback = problems.join("\n");
      continue;
    }
    report.status = "enriched";
    report.files_written = written;
    report.findings_after = sumAfter;
    return report;
  }
  report.status = "gate_failed";
  return report;
}

function packBusinessDirs(contentDir: string): string[] {
  const root = path.join(contentDir, "businesses");
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).sort().map((s) => path.join(root, s)).filter((d) => fs.existsSync(path.join(d, "business.yaml")));
}

// ═══════════════════════════════════════════════════════════════════════════
// CLI
// ═══════════════════════════════════════════════════════════════════════════

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | null => { const hit = argv.find((a) => a.startsWith(`--${name}=`)); return hit ? hit.slice(name.length + 3) : null; };
  const has = (name: string) => argv.includes(`--${name}`);

  const dry = has("dry");
  const attempts = Math.max(1, Number(flag("attempts") || 3));
  const runtime = (flag("runtime") || "claude-code") as Runtime;
  const model = flag("model") || undefined;
  const scratch = flag("scratch") || path.join(os.tmpdir(), "nirvana-enrich-business");
  const timeoutMs = Math.max(1, Number(flag("timeout-min") || 12)) * 60 * 1000;
  // The README is most of the output; at $3 a full answer was cut by the cap
  // mid-generation (measured 2026-09-02: error_max_budget_usd, empty result).
  const budgetUsd = Number(flag("budget-usd") || 5);

  let dirs: string[] = [];
  if (flag("dir")) dirs = [path.resolve(flag("dir")!.replace(/^~(?=$|\/)/, os.homedir()))];
  else if (flag("pack")) dirs = packBusinessDirs(path.resolve(flag("pack")!.replace(/^~(?=$|\/)/, os.homedir())));
  else if (flag("slugs")) dirs = flag("slugs")!.split(",").map((s) => s.trim()).filter(Boolean).map((s) => findBusinessDir(s) ?? s);
  else { console.error("usage: bun enrich-business-admission.ts (--slugs=a,b | --dir=<business-dir> | --pack=<content-dir>) [--dry] [--attempts=N] [--runtime=R] [--model=M] [--scratch=DIR] [--timeout-min=N] [--budget-usd=N]"); process.exit(2); }
  dirs = dirs.filter((d) => { const ok = fs.existsSync(path.join(d, "business.yaml")); if (!ok) console.error(`skip: no business.yaml at ${d}`); return ok; });
  if (!dirs.length) { console.error("enrich-business: no business selected"); process.exit(2); }

  if (dry) {
    for (const d of dirs) {
      const r = await enrichBusinessDir(d, { attempts: 0, backupRoot: "", generate: () => ({ ok: false, json: null, costUsd: 0 }) }, { dry: true });
      const n = r.needs; const want = [n.notFor && "not_for", n.briefLangs && "briefs-lang", n.routes && `routes(${r.findings_before.dead_routes} dead)`, n.readme && "readme"].filter(Boolean).join(", ");
      console.log(`  ${r.slug}: ${want || "nothing agentic"}`);
    }
    process.exit(0);
  }
  if (!runtimeAvailable(runtime)) { console.error(`enrich-business: runtime '${runtime}' not on PATH`); process.exit(2); }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupRoot = path.join(scratch, `backups-${stamp}`);
  fs.mkdirSync(backupRoot, { recursive: true });
  const generate: GenerateFn = (prompt) => {
    const res = runHeadless({ runtime, prompt, cwd: os.tmpdir(), allowedTools: [], permissionMode: "default", model, maxBudgetUsd: budgetUsd, timeoutMs });
    const json = res.ok ? extractJson(res.result) : null;
    return { ok: !!json, json, costUsd: res.costUsd, error: res.ok ? (json ? undefined : "no JSON object in the model output") : (res.error || "generation run failed") };
  };
  const ctx: RunCtx = { attempts, backupRoot, generate };
  const reports: BusinessReport[] = [];
  for (const d of dirs) {
    console.log(`[enrich-business] → ${path.basename(d)}`);
    const r = await enrichBusinessDir(d, ctx);
    reports.push(r);
    const a = r.findings_after;
    console.log(`[enrich-business]   ${r.status}${a ? ` — warnings ${r.findings_before.warnings}→${a.warnings}, dead routes ${r.findings_before.dead_routes}→${a.dead_routes}` : ""}${r.files_written.length ? ` · ${r.files_written.join(", ")}` : ""}${r.errors.length && r.status !== "enriched" ? ` — ${r.errors[r.errors.length - 1].slice(0, 140)}` : ""}`);
  }
  const reportPath = path.join(scratch, `enrich-business-${stamp}.json`);
  fs.writeFileSync(reportPath, JSON.stringify({ started_at: stamp, runtime, model: model || null, attempts, total_cost_usd: reports.reduce((n, r) => n + r.cost_usd, 0), businesses: reports, backup_root: backupRoot }, null, 2) + "\n");
  const counts: Record<string, number> = {};
  for (const r of reports) counts[r.status] = (counts[r.status] || 0) + 1;
  console.log(`[enrich-business] ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(" · ")} · cost=$${reports.reduce((n, r) => n + r.cost_usd, 0).toFixed(2)}`);
  console.log(`[enrich-business] report → ${reportPath}`);
  process.exit(0);
}
