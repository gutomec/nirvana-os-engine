#!/usr/bin/env bun
/**
 * enrich-routing-metadata.ts — routing-360 Phase 2.4: metadata enrichment pipeline.
 *
 * Generates the routing metadata the two matchers (agentic router + BM25) need,
 * for entities that lack it, via a headless LLM run — then GATES every write
 * with the self-retrieval gate (ROUTING_METADATA_CONTRACT.md §9) and the
 * library-wide eval watermarks. A write that fails its gate is reverted from a
 * backup; a batch that drops any watermark axis below its floor is reverted
 * whole. The library can only get better or stay identical — never worse.
 *
 *   CLONES    — build the `routing:` block (MIND_CLONE_ROUTING_CONTRACT.md) from
 *               MANIFEST + AGENT.md + SOUL.md + dna-schema headings, and write it
 *               into MANIFEST.yaml. ONLY the routing block is touched — voice /
 *               content files (AGENT.md, SOUL.md, dna/*) are never modified.
 *   BUSINESSES — generate ONLY the missing/broken fields of business.yaml
 *               (capabilities, keywords, example_briefs, truncated-description
 *               rewrite) plus brief-derived auto_routes into routing.yaml.
 *               Good fields are never overwritten.
 *
 * CLI:
 *   bun enrich-routing-metadata.ts --kind=clone    --slugs=a,b,c   [--dry]
 *   bun enrich-routing-metadata.ts --kind=clone    --missing --limit=10
 *   bun enrich-routing-metadata.ts --kind=business --slugs=x,y     [--dry]
 *   bun enrich-routing-metadata.ts --kind=business --missing --limit=5
 *
 * Options:
 *   --dry               select + plan only; no LLM, no writes
 *   --attempts=N        generation attempts per entity (default 2; each failed
 *                       gate reverts the write and feeds the misses back)
 *   --runtime=R         host runtime for generation (default claude-code)
 *   --model=M           model override for the generation runs
 *   --scratch=DIR       backups + batch report dir (default: os tmpdir)
 *   --timeout-min=N     per-generation wall clock (default 12)
 *   --budget-usd=N      per-generation dollar cap (default 3)
 *   --skip-final-eval   skip the batch-level watermark eval (pilot debugging only)
 *
 * Exit codes: 0 = batch done (statuses in the report), 1 = batch reverted by a
 * watermark floor violation, 2 = bad usage.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { resolveScope } from "../lib/scope.ts";
import { paths } from "../lib/bun-helpers.ts";
import { runHeadless, runtimeAvailable, type Runtime } from "../../harness/lib/host-agent-driver.ts";
import { runGate, type GateResult } from "./self-retrieval-gate.ts";

const YAML = require("yaml");

const REPO_ROOT = path.join(import.meta.dir, "..", "..", "..");
const HARNESS_INDEX = path.join(REPO_ROOT, "skills", "harness", "scripts", "index.ts");
const BUILD_GOLDEN = path.join(REPO_ROOT, "skills", "harness", "scripts", "build-golden-set.ts");

// Same shape validators.ts enforces (CAPABILITY_ID, not exported there).
const CAPABILITY_ID_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){2,}$/;

// ── watermark floors (mirrors harness/tests/routing-eval.test.ts and
//    _shared/tests/clone-routing-eval.test.ts — floors only move up) ─────────
export const EVAL_FLOORS = {
  top1_overall: 0.965,
  top3_overall: 0.98,
  mrr_overall: 0.97,
  top1_squad_capability: 0.98,
  top1_business: 0.84,
  negatives_no_match: 0.73,
  fabric_business: 0.875,
} as const;

export const CLONE_EVAL_FLOORS = {
  self_min: 301, // enriched-count watermark; also must never shrink vs before
  need_min: 45,
  scaffold_min: 9,
} as const;

// ═══════════════════════════════════════════════════════════════════════════
// Pure helpers (unit-tested, no LLM, no filesystem beyond what they receive)
// ═══════════════════════════════════════════════════════════════════════════

export interface CloneRoutingBlock {
  one_liner: string;
  domains: string[];
  serves: string;
  not_for: string;
  /** RETIRED (2026-08-18) — kept optional so legacy readers type-check; never written. */
  delegates_to?: string[];
  refuses: string[];
  /** legacy key preserved on merge; never generated */
  when_to_use?: string;
}

export interface BusinessPlan {
  needDescription: boolean;
  needCapabilities: boolean;
  needKeywords: boolean;
  needExampleBriefs: boolean;
  needAutoRoutes: boolean;
}

export interface BusinessGenerated {
  description?: string;
  capabilities?: string[];
  keywords?: string[];
  example_briefs?: string[];
  auto_routes?: Array<{ pattern: string; route_to: string }>;
}

/** Detects the old 500-char mid-word truncation: a long description whose last
 *  character is a letter/digit with no sentence-final punctuation. */
export function isTruncatedDescription(desc: string): boolean {
  const d = (desc || "").trim();
  if (d.length < 450) return false;
  return /[\p{L}\p{N}]$/u.test(d) && !/[.!?…"'»)\]]$/.test(d);
}

const PT_STOPWORDS = /(^|\s)(de|da|do|das|dos|para|por|com|sem|meu|minha|nosso|nossa|que|como|uma|um|não|nao|está|esta|são|sao|ção|preciso|quero)(\s|$)/i;

/** Cheap language heuristic used only for soft distribution checks. */
export function detectLang(s: string): "pt" | "en" | "other" {
  const t = (s || "").toLowerCase();
  if (/[ãõáéíóúâêôàçü]/.test(t) || PT_STOPWORDS.test(t)) return "pt";
  if (/^[\x00-\x7F]+$/.test(t)) return "en";
  return "other";
}

const NEGATION_RE = /(^|\s)(sem|não|nao|nunca|never|not|without)(\s|$)|em vez de|instead of/i;

/**
 * Canonical terms whose NAME contains a negation token. Rule 3a exists so a
 * clone stops winning queries it means to repel — it was never meant to ban
 * the industry's own vocabulary. "influence without authority" is what product
 * leaders type; "nao conformidade" is the ISO term; "no-code" is a category.
 * Matched accent-folded on the whole item, so only the term itself passes —
 * a sentence that merely contains it still trips the rule.
 */
const NEGATION_CANONICAL_TERMS = new Set([
  "influence without authority",
  "influencia sem autoridade",
  "lideranca sem autoridade",
  "no-code",
  "no code",
  "low-code",
  "low code",
  "no-show",
  "without thought",
  "design without thought",
  "nao conformidade",
  "nao conformidades",
  "nonconformity",
  "never events",
  "zero trust",
]);

/** True when the item is a canonical term that legitimately carries a negation word. */
function isCanonicalNegationTerm(item: string): boolean {
  return NEGATION_CANONICAL_TERMS.has(normTerm(item));
}

const normTerm = (s: string) =>
  String(s).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();

export function validateCloneBlock(
  raw: unknown,
  opts: { knownSlugs?: Set<string>; selfSlug?: string } = {},
): { ok: boolean; errors: string[]; cleaned?: CloneRoutingBlock } {
  const errors: string[] = [];
  const b = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;

  const oneLiner = typeof b.one_liner === "string" ? b.one_liner.trim() : "";
  if (!oneLiner) errors.push("one_liner: missing");
  else if (oneLiner.length > 120) errors.push(`one_liner: ${oneLiner.length} chars > 120 max`);

  const domainsRaw = Array.isArray(b.domains) ? b.domains : null;
  let domains: string[] = [];
  if (!domainsRaw) errors.push("domains: missing or not an array");
  else {
    domains = domainsRaw.filter((d): d is string => typeof d === "string").map((d) => d.trim()).filter(Boolean);
    // dedupe, preserve order
    domains = domains.filter((d, i) => domains.findIndex((x) => normTerm(x) === normTerm(d)) === i);
    if (domains.length < 20 || domains.length > 30) errors.push(`domains: ${domains.length} items — contract requires 20-30`);
    for (const d of domains) {
      if (d.length < 3 || d.length > 90) errors.push(`domains: item length out of 3-90: "${d.slice(0, 40)}"`);
      if (d.includes("/")) errors.push(`domains: no slashes — PT and EN are SEPARATE items: "${d.slice(0, 40)}"`);
      if (/:\s/.test(d)) errors.push(`domains: colon+space breaks YAML list parsing: "${d.slice(0, 40)}"`);
      if (NEGATION_RE.test(d) && !isCanonicalNegationTerm(d)) errors.push(`domains: negation leaks into the index (rule 3a): "${d.slice(0, 40)}"`);
    }
    const pt = domains.filter((d) => detectLang(d) === "pt").length;
    const en = domains.filter((d) => detectLang(d) === "en").length;
    if (pt < 6 || en < 6) errors.push(`domains: EN+PT pairs required — detected pt=${pt} en=${en} (need >=6 each)`);
  }

  const serves = typeof b.serves === "string" ? b.serves.trim() : "";
  if (!serves) errors.push("serves: missing");
  else {
    const words = serves.split(/\s+/).length;
    if (words > 520) errors.push(`serves: ${words} words — long serves dilutes BM25 (rule 3e, keep <=~350 words)`);
    if (/em vez de|instead of/i.test(serves)) errors.push("serves: negation phrasing (rule 3a) — affirmation only");
  }

  const notFor = typeof b.not_for === "string" ? b.not_for.trim() : "";
  if (!notFor) errors.push("not_for: missing");

  const refusesRaw = Array.isArray(b.refuses) ? b.refuses : null;
  let refuses: string[] = [];
  if (!refusesRaw) errors.push("refuses: missing or not an array");
  else {
    refuses = refusesRaw.filter((r): r is string => typeof r === "string").map((r) => r.trim()).filter(Boolean);
    if (refuses.length < 1) errors.push("refuses: empty");
    for (const r of refuses) if (r.length > 80) errors.push(`refuses: term too long (list of short terms, not prose): "${r.slice(0, 40)}"`);
  }

  // domains ∩ refuses = contradiction (rule 2 / index-clones warning)
  const refusedSet = new Set(refuses.map(normTerm));
  for (const d of domains) {
    if (refusedSet.has(normTerm(d))) errors.push(`domains/refuses contradiction: "${d}"`);
  }

  // delegates_to: RETIRED (2026-08-18). A clone is knowledge, not an actor — it
  // cannot delegate. The field froze "who was adjacent" against one library and
  // broke in every pack subset (805 pointers shipped unresolvable), while no
  // code path ever consumed it. The referral belongs in not_for prose (the
  // contract's "what it does not do, and WHO does"), and the live search answers the same
  // question against the library the user actually has. Existing lists on disk
  // are ignored, not deleted; new blocks are written without the field —
  // whatever the generator emitted is discarded here.

  const fatal = errors.filter((e) => !e.includes("non-fatal"));
  if (fatal.length) return { ok: false, errors };
  return {
    ok: true,
    errors,
    cleaned: { one_liner: oneLiner, domains, serves, not_for: notFor, refuses },
  };
}

/** true when the regex (JS-compiled with 'i', "(?i)" prefix stripped) fires on
 *  at least one of the briefs — the ROUTING_METADATA_CONTRACT §7 requirement. */
export function routePatternFires(pattern: string, briefs: string[]): boolean {
  let re: RegExp;
  try { re = new RegExp(String(pattern).replace(/^\(\?i\)/, ""), "i"); } catch { return false; }
  return briefs.some((b) => re.test(b));
}

export function validateBusinessGenerated(
  raw: unknown,
  plan: BusinessPlan,
  ctx: { slug: string; employeeSlugs: string[]; allBriefs: string[] },
): { ok: boolean; errors: string[]; cleaned?: BusinessGenerated } {
  const errors: string[] = [];
  const g = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const cleaned: BusinessGenerated = {};

  if (plan.needDescription) {
    const d = typeof g.description === "string" ? g.description.trim() : "";
    if (!d) errors.push("description: missing");
    else if (d.length < 20 || d.length > 2000) errors.push(`description: ${d.length} chars out of 20-2000`);
    else if (isTruncatedDescription(d)) errors.push("description: still ends mid-word");
    else cleaned.description = d;
  }

  if (plan.needCapabilities) {
    const caps = Array.isArray(g.capabilities)
      ? g.capabilities.filter((c): c is string => typeof c === "string").map((c) => c.trim()).filter(Boolean)
      : [];
    const valid = [...new Set(caps)].filter((c) => CAPABILITY_ID_RE.test(c));
    const invalid = caps.filter((c) => !CAPABILITY_ID_RE.test(c));
    if (invalid.length) errors.push(`capabilities: invalid ids (need snake.dot.case, >=3 segments): ${invalid.slice(0, 5).join(", ")}`);
    if (valid.length < 3) errors.push(`capabilities: ${valid.length} valid ids — need at least 3`);
    else cleaned.capabilities = valid.slice(0, 40);
  }

  if (plan.needKeywords) {
    const kw = Array.isArray(g.keywords)
      ? g.keywords.filter((k): k is string => typeof k === "string").map((k) => k.trim()).filter(Boolean)
      : [];
    const valid = [...new Set(kw)].filter((k) => k.length >= 2 && k.length <= 60);
    if (valid.length < 10) errors.push(`keywords: ${valid.length} valid items — need at least 10 (multilingual groups)`);
    else cleaned.keywords = valid.slice(0, 100);
  }

  if (plan.needExampleBriefs) {
    const briefs = Array.isArray(g.example_briefs)
      ? g.example_briefs.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean)
      : [];
    for (const x of briefs) {
      if (x.length < 20 || x.length > 1000) errors.push(`example_briefs: item length out of 20-1000: "${x.slice(0, 40)}"`);
      if (x.toLowerCase().includes(ctx.slug.toLowerCase())) {
        errors.push(`example_briefs: contains the entity's own slug — self-retrieval would pass for the wrong reason (§5): "${x.slice(0, 40)}"`);
      }
    }
    const pt = briefs.filter((x) => detectLang(x) === "pt").length;
    const en = briefs.filter((x) => detectLang(x) === "en").length;
    if (briefs.length < 3) errors.push(`example_briefs: ${briefs.length} — contract requires >=3`);
    if (pt < 1 || en < 1) errors.push(`example_briefs: need at least one PT and one EN (pt=${pt} en=${en})`);
    if (!errors.some((e) => e.startsWith("example_briefs"))) cleaned.example_briefs = briefs.slice(0, 30);
  }

  if (plan.needAutoRoutes) {
    const routesRaw = Array.isArray(g.auto_routes) ? g.auto_routes : [];
    const routes: Array<{ pattern: string; route_to: string }> = [];
    for (const r of routesRaw) {
      if (!r || typeof r !== "object") continue;
      const { pattern, route_to } = r as Record<string, unknown>;
      if (typeof pattern !== "string" || typeof route_to !== "string") continue;
      if (/^\(\?i\)/.test(pattern)) { errors.push(`auto_routes: no (?i) prefix — router compiles with 'i' already: ${pattern.slice(0, 40)}`); continue; }
      if (!ctx.employeeSlugs.includes(route_to)) { errors.push(`auto_routes: route_to '${route_to}' is not an employee of ${ctx.slug}`); continue; }
      if (!routePatternFires(pattern, ctx.allBriefs)) { errors.push(`auto_routes: pattern fires on none of the example_briefs (§7): ${pattern.slice(0, 60)}`); continue; }
      routes.push({ pattern, route_to });
    }
    if (routes.length < 1) errors.push("auto_routes: no valid route survived validation");
    else cleaned.auto_routes = routes.slice(0, 12);
  }

  // Fatal only when a REQUESTED field ends up absent from `cleaned`.
  const missing: string[] = [];
  if (plan.needDescription && !cleaned.description) missing.push("description");
  if (plan.needCapabilities && !cleaned.capabilities) missing.push("capabilities");
  if (plan.needKeywords && !cleaned.keywords) missing.push("keywords");
  if (plan.needExampleBriefs && !cleaned.example_briefs) missing.push("example_briefs");
  if (plan.needAutoRoutes && !cleaned.auto_routes) missing.push("auto_routes");
  if (missing.length) return { ok: false, errors };
  return { ok: true, errors, cleaned };
}

// ── YAML emission (matches the conventions of the existing library files) ───

/** Quote a scalar for inline YAML when needed; plain otherwise. */
export function yamlScalar(s: string): string {
  if (s === "" || /[:#"'\\{}\[\]&*!|>%@`,]|^[\s\-?]|\s$|^$/.test(s) || /^(true|false|null|~|yes|no|on|off)$/i.test(s) || /^[\d.+-]/.test(s)) {
    return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return s;
}

/** Word-wrap `text` (whitespace-normalized) at `width`, each line prefixed with
 *  `indent` — the body of a `>-` folded scalar. */
export function wrapFolded(text: string, indent: string, width = 96): string {
  const words = (text || "").split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if (cur && (indent.length + cur.length + 1 + w.length) > width) { lines.push(cur); cur = w; }
    else cur = cur ? `${cur} ${w}` : w;
  }
  if (cur) lines.push(cur);
  return lines.map((l) => indent + l).join("\n");
}

/** Emit the canonical `routing:` top-level block. Known keys in canonical
 *  order; a legacy `when_to_use` (merge-preserved) is kept after `serves`. */
export function emitCloneRoutingYaml(block: CloneRoutingBlock): string {
  const out: string[] = ["routing:"];
  out.push(`  one_liner: "${block.one_liner.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`);
  out.push("  domains:");
  for (const d of block.domains) out.push(`    - ${yamlScalar(d)}`);
  out.push("  serves: >-");
  out.push(wrapFolded(block.serves, "    "));
  if (block.when_to_use) {
    out.push("  when_to_use: >-");
    out.push(wrapFolded(block.when_to_use, "    "));
  }
  out.push("  not_for: >-");
  out.push(wrapFolded(block.not_for, "    "));
  // delegates_to is retired — new blocks do not carry the field at all.
  out.push("  refuses:");
  for (const r of block.refuses) out.push(`    - ${yamlScalar(r)}`);
  return out.join("\n") + "\n";
}

/** Span [start, end) of a top-level block (`key:` at column 0 through the last
 *  line before the next column-0 KEY). Column-0 `- ` list items belong to the
 *  block (the library's business.yaml files use that style). null when absent. */
export function topLevelBlockSpan(text: string, key: string): { start: number; end: number } | null {
  const lines = text.split("\n");
  const isTopLevelKey = (l: string) => /^[A-Za-z_"'][A-Za-z0-9_."' -]*:(\s|$)/.test(l);
  let startLine = -1;
  for (let i = 0; i < lines.length; i++) {
    if (new RegExp(`^${key}:(\\s|$)`).test(lines[i])) { startLine = i; break; }
  }
  if (startLine === -1) return null;
  let endLine = lines.length;
  for (let i = startLine + 1; i < lines.length; i++) {
    if (isTopLevelKey(lines[i])) { endLine = i; break; }
  }
  const start = lines.slice(0, startLine).join("\n").length + (startLine > 0 ? 1 : 0);
  const end = lines.slice(0, endLine).join("\n").length + (endLine > 0 && endLine < lines.length ? 1 : 0);
  return { start, end };
}

/** Insert (append) or replace the `routing:` block. Every other byte of the
 *  manifest is preserved verbatim — the diff is one block insertion/replacement. */
export function upsertCloneRoutingBlock(
  manifestText: string,
  block: CloneRoutingBlock,
): { text: string; mode: "insert" | "replace" } {
  const emitted = emitCloneRoutingYaml(block);
  const span = topLevelBlockSpan(manifestText, "routing");
  if (span) {
    return { text: manifestText.slice(0, span.start) + emitted + manifestText.slice(span.end), mode: "replace" };
  }
  let text = manifestText;
  if (!text.endsWith("\n")) text += "\n";
  return { text: text + "\n" + emitted, mode: "insert" };
}

/** Merge generated block over an existing partial `routing:` mapping — existing
 *  non-empty values always win (extend, never overwrite). */
export function mergeCloneRouting(existing: unknown, generated: CloneRoutingBlock): CloneRoutingBlock {
  const e = (existing && typeof existing === "object" ? existing : {}) as Record<string, unknown>;
  const strOr = (v: unknown, fb: string) => (typeof v === "string" && v.trim() ? v.trim() : fb);
  const arrOr = (v: unknown, fb: string[]) =>
    Array.isArray(v) && v.filter((x) => typeof x === "string" && x.trim()).length
      ? (v.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean))
      : fb;
  const merged: CloneRoutingBlock = {
    one_liner: strOr(e.one_liner, generated.one_liner),
    domains: arrOr(e.domains, generated.domains),
    serves: strOr(e.serves, generated.serves),
    not_for: strOr(e.not_for, generated.not_for),
    refuses: arrOr(e.refuses, generated.refuses),
  };
  if (typeof e.when_to_use === "string" && e.when_to_use.trim()) merged.when_to_use = e.when_to_use.trim();
  return merged;
}

/** Replace a top-level scalar (`key: value`, possibly wrapped over lines) with a
 *  folded-scalar rewrite. Used for the truncated-description fix. */
export function replaceTopLevelScalar(text: string, key: string, newValue: string): string {
  const span = topLevelBlockSpan(text, key);
  const emitted = `${key}: >-\n` + wrapFolded(newValue, "  ") + "\n";
  if (!span) {
    let t = text;
    if (!t.endsWith("\n")) t += "\n";
    return t + emitted;
  }
  return text.slice(0, span.start) + emitted + text.slice(span.end);
}

/** Append a new top-level list key at the end of the file (column-0 `- item`
 *  convention, matching the existing business.yaml style). When the key already
 *  exists (e.g. an empty `capabilities: []`), its block is replaced in place —
 *  never duplicated. */
export function appendTopLevelList(text: string, key: string, items: string[]): string {
  const lines = [`${key}:`];
  for (const it of items) lines.push(`- ${yamlScalar(it)}`);
  const emitted = lines.join("\n") + "\n";
  const span = topLevelBlockSpan(text, key);
  if (span) return text.slice(0, span.start) + emitted + text.slice(span.end);
  let t = text;
  if (!t.endsWith("\n")) t += "\n";
  return t + emitted;
}

/** Append auto_routes entries INSIDE the existing `auto_routes:` block of a
 *  routing.yaml (or create the block / the file). Existing entries and every
 *  other key are preserved verbatim. */
export function appendAutoRoutesBlock(
  routingText: string | null,
  routes: Array<{ pattern: string; route_to: string }>,
  opts: { confidence?: number } = {},
): string {
  const conf = opts.confidence ?? 0.95;
  const emit = (indent: string) =>
    routes
      .map((r) => `${indent}- pattern: "${r.pattern.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"\n${indent}  route_to: ${r.route_to}\n${indent}  confidence_threshold: ${conf}`)
      .join("\n") + "\n";

  if (routingText === null || !routingText.trim()) {
    return "auto_routes:\n" + emit("");
  }
  let text = routingText;
  if (!text.endsWith("\n")) text += "\n";
  const span = topLevelBlockSpan(text, "auto_routes");
  if (!span) return text + "auto_routes:\n" + emit("");
  const blockText = text.slice(span.start, span.end);
  // Inline empty form (`auto_routes: []`): convert to block form — appending
  // `- pattern:` items after an inline flow value is invalid YAML.
  if (/^auto_routes:\s*\[\s*\]\s*$/m.test(blockText.split("\n")[0])) {
    return text.slice(0, span.start) + "auto_routes:\n" + emit("") + text.slice(span.end);
  }
  // Inline NON-empty flow sequence: appending block items cannot merge with it.
  // Leave the file untouched; the caller decides what to do with the routes.
  if (/^auto_routes:\s*\[/.test(blockText.split("\n")[0])) return text;
  // Match the indentation of the existing entries (col-0 vs 2-space styles).
  const m = blockText.match(/^(\s*)- pattern:/m);
  const indent = m ? m[1] : "";
  return text.slice(0, span.start) + blockText.replace(/\n*$/, "\n") + emit(indent) + text.slice(span.end);
}

// ── integrity verification (parse-back) ─────────────────────────────────────

export function deepEqualNormalized(a: unknown, b: unknown): boolean {
  if (typeof a === "string" && typeof b === "string") {
    return a.replace(/\s+/g, " ").trim() === b.replace(/\s+/g, " ").trim();
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => deepEqualNormalized(x, b[i]));
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a as object).sort();
    const kb = Object.keys(b as object).sort();
    if (ka.join("\n") !== kb.join("\n")) return false;
    return ka.every((k) => deepEqualNormalized((a as any)[k], (b as any)[k]));
  }
  return a === b;
}

/** After writing, prove: new YAML parses; every top-level key except the
 *  touched ones is deep-equal to before; the touched keys carry the intent. */
export function verifyYamlSurgical(
  oldText: string,
  newText: string,
  touchedKeys: string[],
  intended: Record<string, unknown>,
): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  let oldDoc: any; let newDoc: any;
  try { oldDoc = YAML.parse(oldText) || {}; } catch (e) { errors.push(`old YAML unparseable: ${e}`); return { ok: false, errors }; }
  try { newDoc = YAML.parse(newText) || {}; } catch (e) { errors.push(`new YAML does not parse: ${e}`); return { ok: false, errors }; }

  for (const k of Object.keys(oldDoc)) {
    if (touchedKeys.includes(k)) continue;
    if (!deepEqualNormalized(oldDoc[k], newDoc[k])) errors.push(`untouched key changed: ${k}`);
  }
  for (const k of Object.keys(newDoc)) {
    if (!touchedKeys.includes(k) && !(k in oldDoc)) errors.push(`unexpected new key: ${k}`);
  }
  for (const [k, v] of Object.entries(intended)) {
    if (!deepEqualNormalized(newDoc[k], v)) errors.push(`touched key does not match intent: ${k}`);
  }
  return { ok: errors.length === 0, errors };
}

// ── backups ─────────────────────────────────────────────────────────────────

export interface BackupEntry {
  file: string;
  /** null when the file did not exist before (revert = delete). */
  backupPath: string | null;
}

export function backupFile(backupRoot: string, file: string): BackupEntry {
  if (!fs.existsSync(file)) return { file, backupPath: null };
  const rel = file.replace(/[\\/:]/g, "_");
  const backupPath = path.join(backupRoot, `${rel}.bak`);
  fs.mkdirSync(backupRoot, { recursive: true });
  fs.copyFileSync(file, backupPath);
  return { file, backupPath };
}

export function restoreBackup(entry: BackupEntry): void {
  if (entry.backupPath === null) {
    if (fs.existsSync(entry.file)) fs.rmSync(entry.file);
    return;
  }
  fs.copyFileSync(entry.backupPath, entry.file);
}

// ── LLM plumbing ────────────────────────────────────────────────────────────

export function extractJson(raw: string): any | null {
  let t = (raw || "").trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try { return JSON.parse(t.slice(start, end + 1)); } catch { return null; }
}

interface GenOptions {
  runtime: Runtime;
  model?: string;
  timeoutMs: number;
  budgetUsd: number;
}

function generateJson(prompt: string, opts: GenOptions): { ok: boolean; json: any; costUsd: number | null; durationMs: number; error?: string; raw: string } {
  const res = runHeadless({
    runtime: opts.runtime,
    prompt,
    cwd: os.tmpdir(),
    allowedTools: [], // pure text generation — no filesystem, no web
    permissionMode: "default",
    model: opts.model,
    maxBudgetUsd: opts.budgetUsd,
    timeoutMs: opts.timeoutMs,
  });
  const json = res.ok ? extractJson(res.result) : null;
  return {
    ok: !!json,
    json,
    costUsd: res.costUsd,
    durationMs: res.durationMs,
    error: res.ok ? (json ? undefined : "no JSON object in the model output") : (res.error || "generation run failed"),
    raw: res.result || "",
  };
}

// ── library access ──────────────────────────────────────────────────────────

function cloneDirs(): string[] {
  const scope = resolveScope();
  return scope.mindCloneDirs.length ? scope.mindCloneDirs : [paths.DNA_LIBRARY];
}

function businessDirs(): string[] {
  const scope = resolveScope();
  return scope.businessDirs.length ? scope.businessDirs : [paths.BUSINESSES_DIR];
}

function findDir(roots: string[], slug: string, markerFile: string): string | null {
  for (const root of roots) {
    const dir = path.join(root, slug);
    if (fs.existsSync(path.join(dir, markerFile))) return dir;
  }
  return null;
}

export function hasUsableRoutingBlock(manifest: any): boolean {
  const r = manifest?.routing || {};
  return !!(r.one_liner && Array.isArray(r.domains) && r.domains.length > 0 && (r.serves || r.when_to_use));
}

function listMissingClones(limit: number): string[] {
  const out: string[] = [];
  for (const root of cloneDirs()) {
    if (!fs.existsSync(root)) continue;
    for (const e of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!e.isDirectory() || e.name.startsWith(".")) continue;
      const mp = path.join(root, e.name, "MANIFEST.yaml");
      if (!fs.existsSync(mp)) continue;
      let m: any;
      try { m = YAML.parse(fs.readFileSync(mp, "utf8")); } catch { continue; }
      if (!hasUsableRoutingBlock(m)) out.push(e.name);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

export function buildBusinessPlan(manifest: any, autoRoutes: Array<{ pattern: string }> | null): BusinessPlan {
  const briefs: string[] = Array.isArray(manifest?.example_briefs) ? manifest.example_briefs : [];
  const routes = autoRoutes || [];
  const anyRouteFires = routes.some((r) => r && typeof r.pattern === "string" && routePatternFires(r.pattern, briefs));
  return {
    needDescription: isTruncatedDescription(String(manifest?.description || "")),
    needCapabilities: !Array.isArray(manifest?.capabilities) || manifest.capabilities.length === 0,
    needKeywords: !Array.isArray(manifest?.keywords) || manifest.keywords.length === 0,
    needExampleBriefs: briefs.length < 3,
    // Brief-facing auto_routes are missing when no declared route can ever fire
    // on the business's own example_briefs (§7: a pattern that never fires
    // silently disables the route).
    needAutoRoutes: briefs.length > 0 && !anyRouteFires,
  };
}

function listMissingBusinesses(limit: number): string[] {
  const out: string[] = [];
  for (const root of businessDirs()) {
    if (!fs.existsSync(root)) continue;
    for (const e of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!e.isDirectory() || e.name.startsWith(".") || e.name.startsWith("_")) continue;
      const bp = path.join(root, e.name, "business.yaml");
      if (!fs.existsSync(bp)) continue;
      let m: any;
      try { m = YAML.parse(fs.readFileSync(bp, "utf8")); } catch { continue; }
      const routing = readRoutingYaml(path.join(root, e.name));
      const plan = buildBusinessPlan(m, routing.autoRoutes);
      if (plan.needDescription || plan.needCapabilities || plan.needKeywords || plan.needExampleBriefs || plan.needAutoRoutes) {
        out.push(e.name);
      }
      if (out.length >= limit) return out;
    }
  }
  return out;
}

function readRoutingYaml(bizDir: string): { path: string; text: string | null; autoRoutes: Array<{ pattern: string; route_to: string }>; defaultEmployee: string | null } {
  const p = path.join(bizDir, "routing.yaml");
  if (!fs.existsSync(p)) return { path: p, text: null, autoRoutes: [], defaultEmployee: null };
  const text = fs.readFileSync(p, "utf8");
  let data: any = {};
  try { data = YAML.parse(text) || {}; } catch { /* keep {} */ }
  const routesRaw = data.auto_routes ?? data.routing?.auto_routes ?? [];
  const autoRoutes = (Array.isArray(routesRaw) ? routesRaw : [])
    .filter((r: any) => r && typeof r.pattern === "string" && typeof r.route_to === "string")
    .map((r: any) => ({ pattern: r.pattern, route_to: r.route_to }));
  const defaultEmployee = typeof data.brief_intake?.default_employee === "string" ? data.brief_intake.default_employee : null;
  return { path: p, text, autoRoutes, defaultEmployee };
}

function employeeSlugs(bizDir: string): string[] {
  const dir = path.join(bizDir, "employees");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => f.replace(/\.md$/, ""));
}

function readCapped(file: string | null, cap: number): string {
  if (!file || !fs.existsSync(file)) return "";
  const s = fs.readFileSync(file, "utf8");
  return s.length > cap ? s.slice(0, cap) + "\n…(truncated for prompt)" : s;
}

function firstExisting(dir: string, rels: string[]): string | null {
  for (const r of rels) {
    const p = path.join(dir, r);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// ── prompts ─────────────────────────────────────────────────────────────────

const CLONE_CONTRACT_DIGEST = `
THE CONTRACT (MIND_CLONE_ROUTING_CONTRACT.md, distilled — each rule exists because a defect was measured):
1. A domain enters ONLY with material backing: a framework, heuristic, methodology or playbook visible in the
   source material below. Famous-for-X without method-of-X means X stays out.
2. Never make the clone routable by what it REFUSES. Read the refusal sections (Limitations,
   "What You Refuse to Do", "NÃO use quando", "O que NUNCA diz") before writing. Refused territory goes in
   not_for / refuses ONLY.
3. BM25 has no negation. one_liner, domains and serves are INDEXED and must carry ONLY affirmation.
   not_for and refuses are NEVER indexed — write every refusal there, with any wording.
3a. Name a method by what it IS, never by what it avoids. Banned inside domains and serves:
   "em vez de", "sem", "não", "nunca", "never", "not", "without", "instead of".
3b. Cover vocabulary variants as SEPARATE domain items: PT and EN forms, acronym and spelled-out form,
   the layperson's word next to the practitioner's, and the inflection a user actually types (no stemming).
3d. Declare the SYMPTOM, not the scaffold: 3-4 domain items phrased as the owner describes the problem
   ("o app está confuso e ninguém completa a tarefa", "a margem caiu 2 meses seguidos"), with zero intent
   verbs ("quero", "preciso", "want") — state the problem, never the wish.
3d-bis. SYMPTOMS ARE THE TRAP FOR RULE 3a: the natural way to describe a problem is negative ("o
   espectador NÃO sente que está dentro da cena", "a equipe NÃO documenta requisitos"), and every such
   item poisons the index — the clone then wins the very query it should repel. Rewrite each symptom as
   the positive state that is missing or the observable fact:
     BAD  "o espectador não sente que está dentro da cena"
     GOOD "a cena parece distante e o espectador assiste de fora"
     BAD  "a equipe não documenta requisitos não funcionais"
     GOOD "requisitos de performance e segurança chegam ao time só depois do incidente"
     BAD  "metade da equipe usa IA escondido e a liderança não sabe"
     GOOD "metade da equipe usa IA escondido e a liderança descobre pelo resultado"
   Re-read every domain item and the serves paragraph for the banned words BEFORE answering; a single
   leak invalidates the whole block.
3e. serves must stay concise (<= ~350 words). BM25 normalizes by length: longer dilutes. Numbers as digits,
   never spelled out. Keep proper names of frameworks.
4. delegates_to may ONLY contain slugs from the NEIGHBORS list below (they are the real, existing clones).
   When a neighbor owns adjacent territory, name the boundary from this side inside not_for.
`.trim();

function buildClonePrompt(slug: string, dir: string, retryFeedback: string | null, neighbors: Array<{ slug: string; one_liner: string | null }>): string {
  const manifestText = readCapped(path.join(dir, "MANIFEST.yaml"), 8000);
  const agent = readCapped(firstExisting(dir, ["agent/AGENT.md", "AGENT.md"]), 14000);
  const soul = readCapped(firstExisting(dir, ["agent/SOUL.md", "SOUL.md"]), 5000);
  const dnaFile = firstExisting(dir, ["dna/dna-schema.md"]);
  const dnaHeadings = dnaFile
    ? fs.readFileSync(dnaFile, "utf8").split("\n").filter((l) => /^#{1,4}\s/.test(l)).slice(0, 120).join("\n")
    : "(no dna-schema.md)";

  return [
    `You are enriching the routing metadata of the mind-clone "${slug}" in the Nirvana-OS library.`,
    "The routing block is what makes a clone discoverable by NEED instead of by name. Your ONLY output is one JSON object — no prose, no markdown fences.",
    "",
    CLONE_CONTRACT_DIGEST,
    "",
    "OUTPUT SHAPE (single JSON object, UTF-8, PT-BR diacritics intact, no trailing commas):",
    "{",
    '  "one_liner": string,      // PT-BR, HARD MAX 120 characters. Who the clone is + the choice it is THE answer for. Include the signature method or credential that makes it unique.',
    '  "domains": string[],      // 20-30 items. Each concept TWICE: one PT item and one EN item. Include 3-4 symptom items in the owner\'s voice. No slashes, no ": ", no negation words.',
    '  "serves": string,         // PT-BR paragraph: when to choose this clone. Affirmation only, <= 350 words, digits for numbers, framework names preserved.',
    '  "not_for": string,        // PT-BR prose: what it does NOT do, and who does it instead — name the neighbor IN PROSE (delegates_to is retired: a slug list breaks in every pack subset; a name in prose degrades into a live search).',
    '  "refuses": string[]       // 5-15 short canonical terms (2-4 words each) it refuses. These filter contradicting manifest tags.',
    "}",
    "",
    retryFeedback ? `PREVIOUS ATTEMPT FEEDBACK (fix this without breaking the rules above):\n${retryFeedback}\n` : "",
    "SOURCE MATERIAL:",
    "=== MANIFEST.yaml ===",
    manifestText,
    "=== AGENT.md (excerpt) ===",
    agent || "(absent)",
    "=== SOUL.md (excerpt) ===",
    soul || "(absent)",
    "=== dna-schema.md headings ===",
    dnaHeadings,
    "",
    "=== NEIGHBORS (live search index — keep their home territory theirs; name them in not_for prose when they are the better pick) ===",
    neighbors.length
      ? neighbors.map((n) => `- ${n.slug}${n.one_liner ? ` — ${n.one_liner.slice(0, 140)}` : ""}`).join("\n")
      : "(none found)",
    "",
    "Answer with the JSON object only.",
  ].join("\n");
}

const BUSINESS_CONTRACT_DIGEST = `
THE CONTRACT (ROUTING_METADATA_CONTRACT.md, distilled):
- description: ENGLISH, front-loaded with what the business DELIVERS in the first ~120 chars. Concrete facts a
  router can match: inputs accepted, artifacts produced, methods, boundaries. No marketing fluff ("powerful",
  "state-of-the-art", "world-class", "seamless"). 20-2000 chars, complete sentences, never truncated. Never name
  what the business refuses (BM25 has no negation).
- capabilities: dot-separated snake_case ids, >= 3 segments (e.g. "fintech.regulatory_strategy.assess"),
  naming the concrete service areas the employees actually cover.
- keywords: multilingual synonym GROUPS — for each concept: EN form, PT form, accented AND unaccented spellings,
  layperson + practitioner words, the inflections users type. Item 2-60 chars.
- example_briefs: >= 3, at least one EN and one PT, phrased as a REAL user would (symptom language, first
  person, panic wording), covering conjugated AND infinitive verb forms. 20-1000 chars each. NEVER contain the
  business's own slug.
- auto_routes: regex patterns derived from the example_briefs. Match infinitive AND conjugated forms with verb
  stems (escrev\\w* covers escrever/escreva/escrevendo), EN and PT in one alternation, unaccented variants where
  diacritics occur (código|codigo). Anchor on content nouns + verb stems, never scaffold words (quero, preciso,
  please). No (?i) prefix — the router compiles with 'i'. Every pattern MUST fire on at least one example_brief.
`.trim();

function buildBusinessPrompt(
  slug: string,
  bizDir: string,
  plan: BusinessPlan,
  retryFeedback: string | null,
): string {
  const bizText = readCapped(path.join(bizDir, "business.yaml"), 9000);
  const routing = readRoutingYaml(bizDir);
  const empDir = path.join(bizDir, "employees");
  const employees = fs.existsSync(empDir)
    ? fs.readdirSync(empDir).filter((f) => f.endsWith(".md")).map((f) => {
        const head = fs.readFileSync(path.join(empDir, f), "utf8").split("\n").slice(0, 12).join("\n");
        return `--- ${f} ---\n${head}`;
      }).join("\n")
    : "(no employees dir)";

  const wanted: string[] = [];
  if (plan.needDescription) wanted.push('"description": string  // rewrite of the truncated description, ENGLISH, complete, 20-2000 chars');
  if (plan.needCapabilities) wanted.push('"capabilities": string[]  // 6-20 capability ids, dot.snake_case with >= 3 segments, from what the employees actually do');
  if (plan.needKeywords) wanted.push('"keywords": string[]  // 20-60 items in multilingual synonym groups');
  if (plan.needExampleBriefs) wanted.push('"example_briefs": string[]  // >= 5 real-user briefs, EN + PT mix');
  if (plan.needAutoRoutes) wanted.push('"auto_routes": [{"pattern": string, "route_to": string}]  // 2-5 routes; route_to MUST be one of the employee slugs listed below; every pattern MUST fire on at least one example_brief of the business');

  return [
    `You are enriching the routing metadata of the Nirvana-OS business "${slug}".`,
    "Generate ONLY the fields requested below (the other fields are good and must not be produced). Your ONLY output is one JSON object — no prose, no markdown fences.",
    "",
    BUSINESS_CONTRACT_DIGEST,
    "",
    "FIELDS TO GENERATE (JSON object with exactly these keys):",
    "{",
    wanted.map((w) => "  " + w).join(",\n"),
    "}",
    "",
    "Rules: UTF-8, PT-BR diacritics intact where PT text occurs. No trailing commas.",
    retryFeedback ? `\nPREVIOUS ATTEMPT FEEDBACK (fix this):\n${retryFeedback}\n` : "",
    "SOURCE MATERIAL:",
    "=== business.yaml ===",
    bizText,
    "=== routing.yaml ===",
    routing.text || "(absent)",
    `=== employees (${employeeSlugs(bizDir).join(", ") || "none"}) ===`,
    employees,
    "",
    "Answer with the JSON object only.",
  ].join("\n");
}

// ── reindex + gate ──────────────────────────────────────────────────────────

function reindexAll(): void {
  const r = spawnSync(process.execPath, [HARNESS_INDEX, "--quiet"], { encoding: "utf8", cwd: REPO_ROOT });
  if (r.status !== 0) throw new Error(`reindex failed (exit ${r.status}): ${r.stderr}`);
}

function reindexGlobalScope(): void {
  // Second scope: the installed system reads ~/.nirvana. Clones mirror
  // automatically (index-clones.ts); businesses/squads need a home-cwd run.
  const r = spawnSync(process.execPath, [HARNESS_INDEX, "--quiet"], { encoding: "utf8", cwd: os.homedir() });
  if (r.status !== 0) {
    process.stderr.write(`[enrich] WARN: global-scope reindex failed (exit ${r.status})\n`);
  }
}

/** Causal reading of a failed gate: true when the write introduced a NEW miss
 *  (a brief that hit before and misses now) or lowered the hit count. A gate
 *  that fails ONLY on briefs that already failed before the write did not
 *  regress — the defect pre-exists and reverting would not fix it. */
export function gateRegressed(before: GateResult, after: GateResult): boolean {
  const missedBriefs = (g: GateResult) => new Set(g.briefs.filter((b) => !b.hit).map((b) => b.brief));
  const beforeMisses = missedBriefs(before);
  const afterMisses = missedBriefs(after);
  for (const b of afterMisses) if (!beforeMisses.has(b)) return true;
  const hits = (g: GateResult) => g.briefs.filter((b) => b.hit).length;
  return hits(after) < hits(before);
}

function gateSummary(g: GateResult): string {
  const hits = g.briefs.filter((b) => b.hit).length;
  const misses = g.briefs.filter((b) => !b.hit)
    .map((b) => `MISS rank=${b.rank ?? "-"} :: "${b.brief.slice(0, 90)}" top=[${b.top3.map((t) => t.id).join(", ")}]`);
  return `${g.passed ? "PASS" : "FAIL"} ${hits}/${g.briefs.length}${g.reason ? ` (${g.reason})` : ""}${misses.length ? "\n  " + misses.join("\n  ") : ""}`;
}

// ── per-entity report rows ──────────────────────────────────────────────────

export interface EntityReport {
  slug: string;
  kind: "clone" | "business";
  status: "enriched" | "gate_failed_reverted" | "skipped" | "dry" | "reverted_by_batch";
  attempts: number;
  fields_written: string[];
  gate_before: string | null;
  gate_after: string | null;
  timings_ms: Record<string, number>;
  cost_usd: number;
  errors: string[];
}

// ═══════════════════════════════════════════════════════════════════════════
// Per-entity pipelines
// ═══════════════════════════════════════════════════════════════════════════

interface RunCtx {
  gen: GenOptions;
  attempts: number;
  backupRoot: string;
  knownCloneSlugs: Set<string>;
}

async function enrichClone(slug: string, ctx: RunCtx): Promise<{ report: EntityReport; backups: BackupEntry[] }> {
  const t0 = Date.now();
  const report: EntityReport = {
    slug, kind: "clone", status: "skipped", attempts: 0, fields_written: [],
    gate_before: null, gate_after: null, timings_ms: {}, cost_usd: 0, errors: [],
  };
  const dir = findDir(cloneDirs(), slug, "MANIFEST.yaml");
  if (!dir) { report.errors.push("clone dir not found"); return { report, backups: [] }; }
  const manifestPath = path.join(dir, "MANIFEST.yaml");
  const originalText = fs.readFileSync(manifestPath, "utf8");
  let originalDoc: any;
  try { originalDoc = YAML.parse(originalText) || {}; } catch (e) { report.errors.push(`MANIFEST unparseable: ${e}`); return { report, backups: [] }; }

  // Neighbors by THEME via the live clone search (contract rule 4).
  const { findCloneForTask } = await import("../lib/clone-search.ts");
  const man = originalDoc.manifest || originalDoc;
  const query = [man.display_name, ...(Array.isArray(man.tags) ? man.tags : []), man.category].filter(Boolean).join(" ");
  const neighbors = (findCloneForTask(query, { limit: 10 }) || [])
    .filter((h: any) => h.slug !== slug)
    .slice(0, 8)
    .map((h: any) => ({ slug: h.slug, one_liner: h.one_liner }));

  const backup = backupFile(ctx.backupRoot, manifestPath);
  let retryFeedback: string | null = null;

  for (let attempt = 1; attempt <= ctx.attempts; attempt++) {
    report.attempts = attempt;
    const tGen = Date.now();
    const prompt = buildClonePrompt(slug, dir, retryFeedback, neighbors);
    let gen = generateJson(prompt, ctx.gen);
    report.cost_usd += gen.costUsd || 0;

    // One in-attempt shape repair: feed validation errors back once.
    let validation = validateCloneBlock(gen.json, { knownSlugs: ctx.knownCloneSlugs, selfSlug: slug });
    if (gen.ok && !validation.ok) {
      const repairPrompt = prompt + "\n\nYOUR PREVIOUS ANSWER FAILED SHAPE VALIDATION:\n- " + validation.errors.join("\n- ") + "\n\nAnswer again with a corrected JSON object only.";
      gen = generateJson(repairPrompt, ctx.gen);
      report.cost_usd += gen.costUsd || 0;
      validation = validateCloneBlock(gen.json, { knownSlugs: ctx.knownCloneSlugs, selfSlug: slug });
    }
    report.timings_ms[`generate_attempt_${attempt}`] = Date.now() - tGen;

    if (!gen.ok || !validation.ok) {
      report.errors.push(...(gen.error ? [gen.error] : []), ...validation.errors);
      continue; // next attempt regenerates from scratch
    }

    const merged = mergeCloneRouting(originalDoc.routing, validation.cleaned!);
    const { text: newText, mode } = upsertCloneRoutingBlock(originalText, merged);
    const integrity = verifyYamlSurgical(originalText, newText, ["routing"], { routing: merged as any });
    if (!integrity.ok) {
      report.errors.push(...integrity.errors.map((e) => `integrity: ${e}`));
      continue;
    }

    fs.writeFileSync(manifestPath, newText, "utf8");
    report.fields_written = [`routing (${mode})`];

    const tGate = Date.now();
    const gate = await runGate(slug, { kind: "clone" });
    report.timings_ms[`gate_attempt_${attempt}`] = Date.now() - tGate;
    report.gate_after = gateSummary(gate);

    if (gate.passed) {
      report.status = "enriched";
      report.timings_ms.total = Date.now() - t0;
      return { report, backups: [backup] };
    }

    // Gate failed: revert before the next attempt so each attempt starts clean.
    restoreBackup(backup);
    reindexAll();
    retryFeedback = `The self-retrieval gate FAILED: the one_liner did not retrieve "${slug}" top-1 over the clone corpus.\n${gateSummary(gate)}\nWrite a MORE DISTINCTIVE one_liner: lead with the clone's unique signature (person name is already indexed — differentiate by method, framework names, credential) and make domains carry the vocabulary of that territory.`;
    report.errors.push(`attempt ${attempt}: gate failed`);
  }

  report.status = report.fields_written.length ? "gate_failed_reverted" : "skipped";
  report.timings_ms.total = Date.now() - t0;
  return { report, backups: [backup] };
}

async function enrichBusiness(slug: string, ctx: RunCtx): Promise<{ report: EntityReport; backups: BackupEntry[] }> {
  const t0 = Date.now();
  const report: EntityReport = {
    slug, kind: "business", status: "skipped", attempts: 0, fields_written: [],
    gate_before: null, gate_after: null, timings_ms: {}, cost_usd: 0, errors: [],
  };
  const dir = findDir(businessDirs(), slug, "business.yaml");
  if (!dir) { report.errors.push("business dir not found"); return { report, backups: [] }; }
  const bizPath = path.join(dir, "business.yaml");
  const originalBiz = fs.readFileSync(bizPath, "utf8");
  let manifest: any;
  try { manifest = YAML.parse(originalBiz) || {}; } catch (e) { report.errors.push(`business.yaml unparseable: ${e}`); return { report, backups: [] }; }

  const routing = readRoutingYaml(dir);
  const plan = buildBusinessPlan(manifest, routing.autoRoutes);
  if (!plan.needDescription && !plan.needCapabilities && !plan.needKeywords && !plan.needExampleBriefs && !plan.needAutoRoutes) {
    report.errors.push("nothing missing — all fields present and healthy");
    return { report, backups: [] };
  }

  // Pre-write gate state, for honest reporting (a pre-existing miss is not
  // caused by this write, but the strict gate still reverts on it).
  const gateBefore = await runGate(slug, { kind: "business", reindex: false });
  report.gate_before = gateSummary(gateBefore);

  const bizBackup = backupFile(ctx.backupRoot, bizPath);
  const routingBackup = backupFile(ctx.backupRoot, routing.path);
  const backups = [bizBackup, routingBackup];
  const emps = employeeSlugs(dir);
  let retryFeedback: string | null = null;

  for (let attempt = 1; attempt <= ctx.attempts; attempt++) {
    report.attempts = attempt;
    const tGen = Date.now();
    const prompt = buildBusinessPrompt(slug, dir, plan, retryFeedback);
    let gen = generateJson(prompt, ctx.gen);
    report.cost_usd += gen.costUsd || 0;

    const existingBriefs: string[] = Array.isArray(manifest.example_briefs) ? manifest.example_briefs : [];
    const vctx = {
      slug,
      employeeSlugs: emps,
      allBriefs: [...existingBriefs, ...(Array.isArray(gen.json?.example_briefs) ? gen.json.example_briefs : [])],
    };
    let validation = validateBusinessGenerated(gen.json, plan, vctx);
    if (gen.ok && !validation.ok) {
      const repairPrompt = prompt + "\n\nYOUR PREVIOUS ANSWER FAILED SHAPE VALIDATION:\n- " + validation.errors.join("\n- ") + "\n\nAnswer again with a corrected JSON object only.";
      gen = generateJson(repairPrompt, ctx.gen);
      report.cost_usd += gen.costUsd || 0;
      validation = validateBusinessGenerated(gen.json, plan, {
        ...vctx,
        allBriefs: [...existingBriefs, ...(Array.isArray(gen.json?.example_briefs) ? gen.json.example_briefs : [])],
      });
    }
    report.timings_ms[`generate_attempt_${attempt}`] = Date.now() - tGen;

    if (!gen.ok || !validation.ok) {
      report.errors.push(...(gen.error ? [gen.error] : []), ...validation.errors);
      continue;
    }
    const cleaned = validation.cleaned!;

    // ── surgical merge into business.yaml ──────────────────────────────────
    let newBiz = originalBiz;
    const touched: string[] = [];
    const intended: Record<string, unknown> = {};
    if (cleaned.description) { newBiz = replaceTopLevelScalar(newBiz, "description", cleaned.description); touched.push("description"); intended.description = cleaned.description; }
    if (cleaned.capabilities) { newBiz = appendTopLevelList(newBiz, "capabilities", cleaned.capabilities); touched.push("capabilities"); intended.capabilities = cleaned.capabilities; }
    if (cleaned.keywords) { newBiz = appendTopLevelList(newBiz, "keywords", cleaned.keywords); touched.push("keywords"); intended.keywords = cleaned.keywords; }
    if (cleaned.example_briefs) { newBiz = appendTopLevelList(newBiz, "example_briefs", cleaned.example_briefs); touched.push("example_briefs"); intended.example_briefs = cleaned.example_briefs; }

    const integrity = verifyYamlSurgical(originalBiz, newBiz, touched, intended);
    if (!integrity.ok) { report.errors.push(...integrity.errors.map((e) => `integrity: ${e}`)); continue; }

    fs.writeFileSync(bizPath, newBiz, "utf8");
    const written = [...touched];

    if (cleaned.auto_routes) {
      // Guard: a routing.yaml that declares routes ONLY under a nested
      // `routing.auto_routes` key would have them shadowed by a new top-level
      // key (registry.ts reads top-level first) — skip rather than lose routes.
      let nestedOnly = false;
      if (routing.text) {
        try {
          const data = YAML.parse(routing.text) || {};
          nestedOnly = data.auto_routes === undefined && Array.isArray(data.routing?.auto_routes);
        } catch { /* unparseable — treated below by the loadBusiness check */ }
      }
      if (nestedOnly) {
        report.errors.push("auto_routes: routing.yaml uses nested routing.auto_routes — skipped to avoid shadowing (non-fatal)");
      } else {
        const newRouting = appendAutoRoutesBlock(routing.text, cleaned.auto_routes);
        fs.writeFileSync(routing.path, newRouting, "utf8");
        written.push(`auto_routes (+${cleaned.auto_routes.length} in routing.yaml)`);
      }
    }
    report.fields_written = written;

    // The real validator the indexer runs — a write it rejects is reverted here.
    try {
      const { loadBusiness } = await import("../../businesses/lib/loader.ts");
      loadBusiness(dir);
    } catch (e) {
      report.errors.push(`loadBusiness rejected the write: ${e}`);
      for (const b of backups) restoreBackup(b);
      continue;
    }

    const tGate = Date.now();
    const gate = await runGate(slug, { kind: "business" });
    report.timings_ms[`gate_attempt_${attempt}`] = Date.now() - tGate;
    report.gate_after = gateSummary(gate);

    if (gate.passed) {
      report.status = "enriched";
      report.timings_ms.total = Date.now() - t0;
      return { report, backups };
    }
    // Causal acceptance: every remaining miss already missed BEFORE the write
    // and the hit count did not drop — the write fixed what it fixed and owns
    // no new defect. Reverting would only re-ship the broken fields. The
    // pre-existing miss stays on record (gate_before / gate_after) for the
    // wave that will own that brief's territory fight.
    if (!gateRegressed(gateBefore, gate)) {
      report.status = "enriched";
      report.errors.push("gate not fully green, but every miss pre-exists the write (no regression) — accepted");
      report.timings_ms.total = Date.now() - t0;
      return { report, backups };
    }

    for (const b of backups) restoreBackup(b);
    reindexAll();
    retryFeedback = `The self-retrieval gate FAILED after the write — these example_briefs no longer (or still do not) route to "${slug}" top-1:\n${gateSummary(gate)}\nStrengthen the fields for THOSE briefs' vocabulary (concrete nouns of the missed briefs) without stealing generic territory from other businesses.`;
    report.errors.push(`attempt ${attempt}: gate failed`);
  }

  report.status = report.fields_written.length ? "gate_failed_reverted" : "skipped";
  report.timings_ms.total = Date.now() - t0;
  return { report, backups };
}

// ═══════════════════════════════════════════════════════════════════════════
// Batch-level watermark eval + hard revert
// ═══════════════════════════════════════════════════════════════════════════

interface FinalEval {
  routing: any;
  clone: any;
  /** Axes the BATCH pushed below floor (below floor AND worse than before). */
  violations: string[];
  /** Axes below floor that were ALREADY at-or-below the same value before the
   *  batch — caused by concurrent library changes, not by this batch. Reported,
   *  never grounds for reverting work that did not cause them. */
  pre_existing_violations: string[];
}

async function measureEvals(): Promise<{ routing: any; clone: any }> {
  const gb = spawnSync(process.execPath, [BUILD_GOLDEN, "--quiet"], { encoding: "utf8", cwd: REPO_ROOT });
  if (gb.status !== 0) throw new Error(`build-golden-set failed: ${gb.stderr}`);
  const { runEval: runRoutingEval } = await import("../../harness/scripts/eval-routing.ts");
  const routing = await runRoutingEval({ quiet: true });
  const { runEval: runCloneEval } = await import("./eval-clone-routing.ts");
  const clone = runCloneEval();
  return { routing, clone };
}

/** The live library is shared: another session can move an axis while a batch
 *  runs (measured 2026-08-05: concurrent business edits flipped a negatives
 *  case and the absolute-floor check reverted 9 innocent clone blocks). The
 *  hard rule is therefore causal: revert only what the batch made worse. */
async function runFinalEvals(before: { routing: any; clone: any } | null): Promise<FinalEval> {
  const { routing, clone } = await measureEvals();

  const violations: string[] = [];
  const preExisting: string[] = [];
  const judge = (label: string, after: number, floor: number, beforeVal: number | null, fmt: (v: number) => string) => {
    if (after >= floor) return;
    const msg = `${label} ${fmt(after)} < floor ${fmt(floor)}`;
    if (beforeVal !== null && after >= beforeVal) preExisting.push(`${msg} (already ${fmt(beforeVal)} before the batch)`);
    else violations.push(msg + (beforeVal !== null ? ` (was ${fmt(beforeVal)} before)` : ""));
  };
  const pct = (v: number) => `${(v * 100).toFixed(2)}%`;
  const raw = (v: number) => v.toFixed(4);

  const o = routing.golden.overall;
  const bk = routing.golden.by_kind || {};
  const bo = before?.routing?.golden?.overall || null;
  const bbk = before?.routing?.golden?.by_kind || {};
  judge("top-1 overall", o.top1, EVAL_FLOORS.top1_overall, bo ? bo.top1 : null, pct);
  judge("top-3 overall", o.top3, EVAL_FLOORS.top3_overall, bo ? bo.top3 : null, pct);
  judge("MRR overall", o.mrr, EVAL_FLOORS.mrr_overall, bo ? bo.mrr : null, raw);
  judge("squad_capability top-1", bk.squad_capability?.top1 ?? 1, EVAL_FLOORS.top1_squad_capability, bbk.squad_capability?.top1 ?? null, pct);
  judge("business top-1", bk.business?.top1 ?? 1, EVAL_FLOORS.top1_business, bbk.business?.top1 ?? null, pct);
  // fabric@1 is the axis that maps to delivered work (business OR a squad it
  // dispatches) — enrichment moves it, so a batch must not push it down.
  judge("business fabric@1", bk.business?.fabric_top1 ?? 1, EVAL_FLOORS.fabric_business, bbk.business?.fabric_top1 ?? null, pct);
  judge("negatives NO_MATCH", routing.negatives.no_match.no_match_rate, EVAL_FLOORS.negatives_no_match,
    before ? before.routing.negatives.no_match.no_match_rate : null, pct);

  // Clone axes. Self-retrieval is the universal invariant: a batch may never
  // ADD a failing clone (pre-existing failures are reported, not ours to own).
  const beforeSelfFail = new Set<string>((before?.clone?.selfFail || []).map((s: string) => s.split(" ->")[0]));
  const newSelfFails = (clone.selfFail as string[]).filter((s) => !beforeSelfFail.has(s.split(" ->")[0]));
  if (newSelfFails.length) violations.push(`clone self-retrieval: batch introduced failures: ${newSelfFails.slice(0, 5).join("; ")}`);
  else if (clone.selfOk !== clone.selfN) preExisting.push(`clone self-retrieval ${clone.selfOk}/${clone.selfN} failing (pre-existing): ${clone.selfFail.slice(0, 3).join("; ")}`);
  const one = (v: number) => String(v);
  judge("clone enriched count", clone.selfN, CLONE_EVAL_FLOORS.self_min, before ? before.clone.selfN : null, one);
  if (before && clone.selfN < before.clone.selfN) violations.push(`clone enriched count shrank: ${clone.selfN} < ${before.clone.selfN} (before)`);
  judge("clone need-pairs", clone.needOk, CLONE_EVAL_FLOORS.need_min, before ? before.clone.needOk : null, one);
  judge("clone scaffold", clone.scaffoldOk, CLONE_EVAL_FLOORS.scaffold_min, before ? before.clone.scaffoldOk : null, one);

  return { routing, clone, violations, pre_existing_violations: preExisting };
}

function evalAxes(routing: any, clone: any) {
  const o = routing?.golden?.overall || {};
  const bk = routing?.golden?.by_kind || {};
  return {
    routing: {
      n: routing?.golden?.total,
      top1_overall: o.top1,
      top3_overall: o.top3,
      mrr_overall: o.mrr,
      top1_squad_capability: bk.squad_capability?.top1,
      top1_business: bk.business?.top1,
      fabric_business: bk.business?.fabric_top1,
      negatives_no_match: routing?.negatives?.no_match?.no_match_rate,
      negatives_false_dispatch: routing?.negatives?.no_match?.false_dispatch_rate,
    },
    clone: clone ? {
      enriched: clone.selfN, self_ok: clone.selfOk,
      need: `${clone.needOk}/${clone.needTotal}`,
      scaffold: `${clone.scaffoldOk}/${clone.scaffoldTotal}`,
      avg_doc_len: clone.avgDocLen,
    } : null,
  };
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

  const kind = flag("kind");
  if (kind !== "clone" && kind !== "business") {
    console.error("usage: bun enrich-routing-metadata.ts --kind=clone|business (--slugs=a,b,c | --missing [--limit=N]) [--dry] [--attempts=N] [--runtime=R] [--model=M] [--scratch=DIR] [--timeout-min=N] [--budget-usd=N] [--skip-final-eval]");
    process.exit(2);
  }
  const dry = has("dry");
  const limit = Number(flag("limit") || 10);
  const attempts = Math.max(1, Number(flag("attempts") || 2));
  const runtime = (flag("runtime") || "claude-code") as Runtime;
  const model = flag("model") || undefined;
  const scratch = flag("scratch") || path.join(os.tmpdir(), "nirvana-enrich-routing");
  const timeoutMs = Math.max(1, Number(flag("timeout-min") || 12)) * 60 * 1000;
  const budgetUsd = Number(flag("budget-usd") || 3);
  const skipFinalEval = has("skip-final-eval");

  let slugs: string[];
  if (flag("slugs")) {
    slugs = flag("slugs")!.split(",").map((s) => s.trim()).filter(Boolean);
  } else if (has("missing")) {
    slugs = kind === "clone" ? listMissingClones(limit) : listMissingBusinesses(limit);
  } else {
    console.error("enrich: pass --slugs=a,b,c or --missing [--limit=N]");
    process.exit(2);
  }
  if (!slugs.length) { console.error("enrich: no entities selected"); process.exit(2); }

  console.log(`[enrich] kind=${kind} entities=${slugs.length} attempts=${attempts} dry=${dry}`);

  if (dry) {
    for (const slug of slugs) {
      if (kind === "clone") {
        const dir = findDir(cloneDirs(), slug, "MANIFEST.yaml");
        console.log(`  ${slug}: ${dir ? "would generate routing block" : "NOT FOUND"}`);
      } else {
        const dir = findDir(businessDirs(), slug, "business.yaml");
        if (!dir) { console.log(`  ${slug}: NOT FOUND`); continue; }
        const m = YAML.parse(fs.readFileSync(path.join(dir, "business.yaml"), "utf8")) || {};
        const plan = buildBusinessPlan(m, readRoutingYaml(dir).autoRoutes);
        const need = Object.entries(plan).filter(([, v]) => v).map(([k]) => k.replace(/^need/, "").toLowerCase());
        console.log(`  ${slug}: ${need.length ? "would generate " + need.join(", ") : "nothing missing"}`);
      }
    }
    process.exit(0);
  }

  if (!runtimeAvailable(runtime)) { console.error(`enrich: runtime '${runtime}' not on PATH`); process.exit(2); }

  const startedAt = new Date().toISOString();
  const stamp = startedAt.replace(/[:.]/g, "-");
  const backupRoot = path.join(scratch, `backups-${stamp}`);
  fs.mkdirSync(backupRoot, { recursive: true });

  // BEFORE measurement of BOTH evals, taken at batch start. The final check is
  // causal (revert only what the batch worsened), so the anchor must be the
  // library state this batch actually started from — not an older snapshot.
  let before: { routing: any; clone: any } | null = null;
  if (!skipFinalEval) {
    console.log("[enrich] measuring before-batch watermarks…");
    before = await measureEvals();
  } else {
    const { runEval: runCloneEvalBefore } = await import("./eval-clone-routing.ts");
    before = { routing: null, clone: runCloneEvalBefore() };
  }
  const cloneBefore = before.clone;

  const { loadCloneRegistry } = await import("../lib/clone-resolver.ts");
  const knownCloneSlugs = new Set(Object.keys(loadCloneRegistry() || {}));

  const ctx: RunCtx = { gen: { runtime, model, timeoutMs, budgetUsd }, attempts, backupRoot, knownCloneSlugs };
  const reports: EntityReport[] = [];
  const allBackups: BackupEntry[] = [];

  for (const slug of slugs) {
    console.log(`[enrich] → ${kind}:${slug}`);
    const { report, backups } = kind === "clone" ? await enrichClone(slug, ctx) : await enrichBusiness(slug, ctx);
    reports.push(report);
    if (report.status === "enriched") allBackups.push(...backups);
    console.log(`[enrich]   ${report.status}${report.errors.length ? ` — ${report.errors[report.errors.length - 1]}` : ""}`);
  }

  reindexAll();

  let batchReverted = false;
  let finalEval: FinalEval | null = null;
  if (!skipFinalEval) {
    console.log("[enrich] batch watermark eval (golden set + negatives + clone eval)…");
    finalEval = await runFinalEvals(before.routing ? before : null);
    for (const v of finalEval.pre_existing_violations) {
      console.error(`[enrich] PRE-EXISTING floor violation (not caused by this batch, NOT reverting): ${v}`);
    }
    if (finalEval.violations.length) {
      console.error("[enrich] WATERMARK FLOOR VIOLATION caused by this batch — reverting the ENTIRE batch:");
      for (const v of finalEval.violations) console.error(`  ! ${v}`);
      for (const b of allBackups) restoreBackup(b);
      reindexAll();
      for (const r of reports) if (r.status === "enriched") r.status = "reverted_by_batch";
      batchReverted = true;
    }
  }
  reindexGlobalScope();

  const reportPath = path.join(scratch, `enrich-report-${stamp}.json`);
  const batchReport = {
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    kind, slugs, attempts, runtime, model: model || null,
    batch_reverted: batchReverted,
    total_cost_usd: reports.reduce((n, r) => n + r.cost_usd, 0),
    eval_before: before.routing ? evalAxes(before.routing, before.clone) : { routing: null, clone: { enriched: cloneBefore.selfN, need: `${cloneBefore.needOk}/${cloneBefore.needTotal}`, scaffold: `${cloneBefore.scaffoldOk}/${cloneBefore.scaffoldTotal}` } },
    final_eval: finalEval ? { ...evalAxes(finalEval.routing, finalEval.clone), violations: finalEval.violations, pre_existing_violations: finalEval.pre_existing_violations } : null,
    entities: reports,
    backup_root: backupRoot,
  };
  fs.writeFileSync(reportPath, JSON.stringify(batchReport, null, 2), "utf8");

  console.log(`[enrich] report → ${reportPath}`);
  const counts: Record<string, number> = {};
  for (const r of reports) counts[r.status] = (counts[r.status] || 0) + 1;
  console.log(`[enrich] ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(" · ")} · cost=$${batchReport.total_cost_usd.toFixed(2)}`);
  if (finalEval) {
    const ax = evalAxes(finalEval.routing, finalEval.clone);
    console.log(`[enrich] eval: top1=${(ax.routing.top1_overall * 100).toFixed(1)}% top3=${(ax.routing.top3_overall * 100).toFixed(1)}% mrr=${ax.routing.mrr_overall.toFixed(3)} biz=${(ax.routing.top1_business * 100).toFixed(1)}% fabric=${((ax.routing.fabric_business ?? 0) * 100).toFixed(1)}% neg=${(ax.routing.negatives_no_match * 100).toFixed(1)}% · clones: ${ax.clone?.enriched} enriched, need ${ax.clone?.need}, scaffold ${ax.clone?.scaffold}`);
  }
  process.exit(batchReverted ? 1 : 0);
}
