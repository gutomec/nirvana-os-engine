/**
 * dispatch.ts — Phase A of the dispatch-quality plan.
 *
 * Implements two harness invariants that prevent the W3 incident class
 * (declarations diverging from execution):
 *
 *  1. injectMindClones(traceId, slugs) — given a list of mind-clone identifiers,
 *     resolve each to its canonical content (AGENT.md + SOUL.md + MANIFEST.yaml),
 *     emit one `mind_clone_injected` audit event per slug with sha256 fingerprint,
 *     and return the concatenated DNA ready to embed in the agent's system prompt.
 *
 *     If any slug can't be resolved → emits `dispatch_blocked` and throws.
 *     The caller (maestro) cannot proceed without explicit injection.
 *
 *  2. validateTrace(traceId) — given a trace_id from the audit log, assert that
 *     every mind-clone declared in `target_plan_committed` has a matching
 *     `mind_clone_injected` event (correct trace_id, correct slug, content sha
 *     non-empty). Returns a structured report ready for `nrv validate-trace` CLI.
 *
 * No LLM here — these are deterministic invariants. The LLM auditor (Layer 2)
 * lives in a separate module.
 *
 * See: docs/plans/dispatch-quality-gate-and-mind-clone-injection.md
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";

const audit = require("./audit.js");
import { getMindClone } from "./glance/data-loader.ts";
import { harnessLogsDir } from "../../_shared/lib/log-paths.ts";

// ───────────────────── types ─────────────────────

export interface InjectedMindClone {
  slug: string;            // input slug (may be "category/slug" or bare "slug")
  resolved_category: string;
  resolved_slug: string;
  path: string;            // primary file path
  bytes: number;           // total content bytes
  sha256: string;          // fingerprint (first 16 chars)
  format: "canonical" | "flat";
}

export interface InjectionResult {
  trace_id: string;
  injections: InjectedMindClone[];
  combined_prompt: string;  // ready to embed under a fenced block in the agent system prompt
  total_bytes: number;
}

export interface ValidationReport {
  trace_id: string;
  ok: boolean;
  declared: string[];           // slugs declared in target_plan_committed
  injected: string[];           // slugs that emitted mind_clone_injected
  missing: string[];            // declared but never injected
  unknown_injections: string[]; // injected but never declared (also a smell)
  events_seen: number;
  details: string[];
}

// ───────────────────── helpers ─────────────────────

function sha256(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
}

function parseSlug(input: string): { category: string; slug: string } {
  // Accept "category/slug" or just "slug" (top-level personas use _root).
  const trimmed = input.trim();
  if (trimmed.includes("/")) {
    const [category, ...rest] = trimmed.split("/");
    return { category, slug: rest.join("/") };
  }
  return { category: "_root", slug: trimmed };
}

// ───────────────────── injectMindClones ─────────────────────

/**
 * Read the canonical DNA for each mind-clone, emit audit events, and return
 * the concatenated content ready to drop into an agent's system prompt.
 *
 * @throws if any slug cannot be resolved — emits `dispatch_blocked` first.
 */
export function injectMindClones(opts: {
  trace_id: string;
  slugs: string[];                // ["alex-hormozi", "01-marketing/david-ogilvy", ...]
  project_id?: string;
  business_slug?: string;         // for audit context
  squad_name?: string;
}): InjectionResult {
  const ctx: any = { trace_id: opts.trace_id };
  if (opts.project_id) ctx.project_id = opts.project_id;
  if (opts.business_slug) ctx.business_slug = opts.business_slug;
  if (opts.squad_name) ctx.squad_name = opts.squad_name;

  const injections: InjectedMindClone[] = [];
  const blocks: string[] = [];
  const missing: { input: string; tried: string }[] = [];

  for (const input of opts.slugs) {
    const { category, slug } = parseSlug(input);
    const mc = getMindClone(category, slug);
    if (!mc || !mc.content) {
      missing.push({ input, tried: `${category}/${slug}` });
      continue;
    }
    const bytes = Buffer.byteLength(mc.content, "utf8");
    const fp = sha256(mc.content);
    const injection: InjectedMindClone = {
      slug: input,
      resolved_category: mc.category,
      resolved_slug: mc.slug,
      path: mc.path,
      bytes,
      sha256: fp,
      format: mc.format || "canonical",
    };
    injections.push(injection);
    audit.emit("mind_clone_injected", {
      slug: mc.slug,
      category: mc.category,
      path: mc.path,
      bytes,
      sha256: fp,
      format: mc.format || "canonical",
    }, ctx);
    blocks.push(
      `\n<!-- mind-clone: ${mc.category}/${mc.slug} | sha256:${fp} | ${bytes}B -->\n` +
      `# ${mc.slug}\n\n` +
      mc.content
    );
  }

  if (missing.length) {
    for (const m of missing) {
      audit.emit("dispatch_blocked", {
        reason: "mind_clone_not_found",
        slug_requested: m.input,
        slug_resolved: m.tried,
      }, ctx);
    }
    throw new Error(
      `dispatch blocked: ${missing.length} mind-clone(s) could not be resolved — ` +
      missing.map(m => m.input).join(", ") +
      `. See dispatch_blocked audit events for details.`
    );
  }

  const combined_prompt = blocks.join("\n\n---\n");
  const total_bytes = injections.reduce((s, i) => s + i.bytes, 0);
  return { trace_id: opts.trace_id, injections, combined_prompt, total_bytes };
}

// ───────────────────── validateTrace ─────────────────────

function readAuditEvents(traceId: string): any[] {
  // Walk every dated dir under ~/.harness-logs/ and return events for traceId.
  const root = process.env.HARNESS_LOGS_DIR
    ? path.resolve(process.env.HARNESS_LOGS_DIR)
    : harnessLogsDir();
  if (!fs.existsSync(root)) return [];
  const dates = fs.readdirSync(root)
    .filter(n => /^\d{4}-\d{2}-\d{2}$/.test(n))
    .sort();
  const out: any[] = [];
  for (const d of dates) {
    const f = path.join(root, d, "audit.jsonl");
    if (!fs.existsSync(f)) continue;
    const lines = fs.readFileSync(f, "utf8").split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const ev = JSON.parse(line);
        if (ev.trace_id === traceId) out.push(ev);
      } catch { /* skip malformed */ }
    }
  }
  return out.sort((a, b) => (a.ts || "").localeCompare(b.ts || ""));
}

/**
 * Assert dispatch integrity for a trace_id:
 *   For every mind-clone declared in `target_plan_committed`, there must be
 *   at least one `mind_clone_injected` event for the same trace with non-empty
 *   sha256 and bytes > 0.
 *
 * Returns a structured report. `ok` is true only when every declared
 * mind-clone is accounted for AND no `dispatch_blocked` events occurred.
 */
export function validateTrace(traceId: string): ValidationReport {
  const events = readAuditEvents(traceId);
  const report: ValidationReport = {
    trace_id: traceId,
    ok: false,
    declared: [],
    injected: [],
    missing: [],
    unknown_injections: [],
    events_seen: events.length,
    details: [],
  };

  if (events.length === 0) {
    report.details.push(`no audit events found for trace_id ${traceId}`);
    return report;
  }

  // Collect declared mind-clones from target_plan_committed events
  const declaredSet = new Set<string>();
  for (const ev of events) {
    if (ev.event !== "target_plan_committed") continue;
    const list: any[] =
      ev.mind_clones || ev.payload?.mind_clones ||
      ev.target_plan?.mind_clones || ev.payload?.target_plan?.mind_clones || [];
    for (const m of list) {
      const slug = typeof m === "string" ? m : (m.slug || m.id || "");
      if (slug) declaredSet.add(slug);
    }
  }

  // Collect injection events
  const injectedSet = new Set<string>();
  for (const ev of events) {
    if (ev.event !== "mind_clone_injected") continue;
    const slug = ev.slug || ev.payload?.slug;
    const bytes = ev.bytes ?? ev.payload?.bytes ?? 0;
    const fp = ev.sha256 || ev.payload?.sha256 || "";
    if (!slug) {
      report.details.push(`mind_clone_injected event with no slug at ${ev.ts}`);
      continue;
    }
    if (bytes <= 0 || !fp) {
      report.details.push(`mind_clone_injected for "${slug}" has bytes=${bytes} sha256="${fp}" — invalid`);
      continue;
    }
    injectedSet.add(slug);
  }

  // Look for any dispatch_blocked
  const blocked = events.filter(e => e.event === "dispatch_blocked");

  report.declared = [...declaredSet].sort();
  report.injected = [...injectedSet].sort();

  // Comparison is by `slug` (last segment), not the full input form, so
  // declared "alex-hormozi" matches injected "alex-hormozi" even when
  // category prefixes differ.
  const lastSeg = (s: string) => s.split("/").pop() || s;
  const declaredLast = new Set([...declaredSet].map(lastSeg));
  const injectedLast = new Set([...injectedSet].map(lastSeg));

  report.missing = [...declaredLast].filter(s => !injectedLast.has(s)).sort();
  report.unknown_injections = [...injectedLast].filter(s => !declaredLast.has(s)).sort();

  if (blocked.length) {
    report.details.push(`${blocked.length} dispatch_blocked event(s) — dispatch was refused`);
    for (const b of blocked) {
      report.details.push(`  · ${b.reason || b.payload?.reason || "(no reason)"} for "${b.slug_requested || b.payload?.slug_requested || '?'}"`);
    }
  }

  if (report.missing.length === 0 && blocked.length === 0 && declaredSet.size > 0) {
    report.ok = true;
    report.details.push(`all ${declaredSet.size} declared mind-clone(s) have matching injection events`);
  } else if (declaredSet.size === 0) {
    report.details.push(`no target_plan_committed event with mind_clones — cannot validate`);
  }

  return report;
}

// ───────────────────── runDispatchAudit (Layer 2) ─────────────────────

export interface AuditFinding {
  severity: "critical" | "warning" | "info";
  type: string;
  message: string;
  fix: string;
}

export interface DispatchAuditResult {
  verdict: "pass" | "needs_revision" | "block";
  findings: AuditFinding[];
  summary: string;
}

/**
 * Build the input bundle the dispatch-auditor agent expects, plus a
 * deterministic pre-pass that catches the cheap wins without an LLM call.
 *
 * The deterministic pre-pass alone is enough to block the W3 incident:
 * for every declared mind-clone, we substring-search every system prompt
 * for the persona's name. If it's missing → critical block.
 *
 * The LLM auditor runs ONLY when the deterministic pre-pass passes.
 */
export function deterministicAudit(input: {
  brief: string;
  target_plan: {
    primary_business?: { slug: string | null } | null;
    supporting_squads?: Array<{ slug: string; capability_id?: string }>;
    mind_clones?: Array<{ slug: string; category?: string }>;
  };
  system_prompts: Record<string, string>;
  registries?: {
    squads_available?: string[];
    businesses_available?: string[];
    mind_clones_available?: string[];
  };
}): DispatchAuditResult {
  const findings: AuditFinding[] = [];
  const promptsCombined = Object.values(input.system_prompts || {}).join("\n");
  const promptLower = promptsCombined.toLowerCase();

  // Rule 1 — every declared mind-clone must be substring-present in the prompt.
  // We accept the slug, the slug with hyphens replaced by spaces, or the last
  // segment (so "_root/david-ogilvy" matches "david ogilvy" or "ogilvy").
  for (const mc of input.target_plan?.mind_clones || []) {
    const slug = mc.slug || "";
    if (!slug) continue;
    const lastSeg = slug.split("/").pop() || slug;
    const variants = [
      slug.toLowerCase(),
      lastSeg.toLowerCase(),
      lastSeg.replace(/-/g, " ").toLowerCase(),
      // Match the canonical injection comment that injectMindClones() emits
      `mind-clone: ${slug.toLowerCase()}`,
      `mind-clone: ${lastSeg.toLowerCase()}`,
    ];
    if (!variants.some(v => promptLower.includes(v))) {
      findings.push({
        severity: "critical",
        type: "mind_clone_not_in_prompt",
        message: `Mind-clone "${slug}" declared in target_plan but its name/DNA does not appear in any system prompt.`,
        fix: `Call injectMindClones({ trace_id, slugs: ["${slug}"] }) and concatenate combined_prompt into the agent system prompt before dispatching.`,
      });
    }
  }

  // Rule 2 — unresolvable targets (squads / mind-clones not in registry)
  const squadsAvail = new Set((input.registries?.squads_available || []).map(s => s.toLowerCase()));
  if (squadsAvail.size > 0) {
    for (const sq of input.target_plan?.supporting_squads || []) {
      if (!squadsAvail.has(sq.slug.toLowerCase())) {
        findings.push({
          severity: "critical",
          type: "unresolvable_target",
          message: `Squad "${sq.slug}" is not in the available registry.`,
          fix: `Pick a registered squad or emit no_match.`,
        });
      }
    }
  }
  const mcAvail = new Set((input.registries?.mind_clones_available || []).map(s => s.toLowerCase()));
  if (mcAvail.size > 0) {
    for (const mc of input.target_plan?.mind_clones || []) {
      const slug = mc.slug || "";
      const lastSeg = slug.split("/").pop() || slug;
      const variants = [
        slug.toLowerCase(),
        `${(mc.category || "_root").toLowerCase()}/${lastSeg.toLowerCase()}`,
        `_root/${lastSeg.toLowerCase()}`,
      ];
      if (!variants.some(v => mcAvail.has(v))) {
        findings.push({
          severity: "critical",
          type: "unresolvable_target",
          message: `Mind-clone "${slug}" is not in the available registry.`,
          fix: `Pick a registered mind-clone or remove the entry.`,
        });
      }
    }
  }

  // Rule 3 — empty plan when brief asks for production work
  if ((input.target_plan?.mind_clones || []).length === 0
      && (input.target_plan?.supporting_squads || []).length === 0
      && !input.target_plan?.primary_business?.slug
      && (input.brief || "").trim().length > 50) {
    findings.push({
      severity: "warning",
      type: "empty_plan",
      message: "Brief is non-trivial but plan declares no business / squads / mind-clones.",
      fix: "Re-survey the registries; if nothing matches, emit no_match before dispatching.",
    });
  }

  const critical = findings.filter(f => f.severity === "critical").length;
  const warning  = findings.filter(f => f.severity === "warning").length;
  const verdict: DispatchAuditResult["verdict"] =
    critical > 0 ? "block" :
    warning > 0  ? "needs_revision" :
    "pass";

  const summary = critical > 0
    ? `${critical} critical issue(s) — dispatch BLOCKED. Fix before retrying.`
    : warning > 0
      ? `${warning} warning(s) — review and retry.`
      : `Deterministic pre-pass clean. (LLM auditor recommended for semantic gaps.)`;

  return { verdict, findings, summary };
}

/**
 * Emit a dispatch_audit audit event from a result. Use after deterministicAudit
 * (and optionally after an LLM auditor merges its findings into the same
 * structure).
 */
export function emitDispatchAudit(opts: {
  trace_id: string;
  result: DispatchAuditResult;
  project_id?: string;
  business_slug?: string;
}): void {
  const ctx: any = { trace_id: opts.trace_id };
  if (opts.project_id) ctx.project_id = opts.project_id;
  if (opts.business_slug) ctx.business_slug = opts.business_slug;
  audit.emit("dispatch_audit", {
    verdict: opts.result.verdict,
    findings: opts.result.findings,
    summary: opts.result.summary,
  }, ctx);
}

// ───────────────────── Phase C: voice fidelity ─────────────────────

export interface VoiceFidelitySignals {
  markers_found_per_clone: Record<string, number>;
  overall_marker_density: number;     // 0-100
  total_markers_searched: number;
  total_markers_found: number;
}

export interface VoiceFidelityGradingPack {
  artifact: string;
  artifact_kind: string;
  mind_clones: Array<{
    slug: string;
    category: string;
    soul: string;
    agent: string;
  }>;
  deterministic_signals: VoiceFidelitySignals;
  threshold: number;
  rubric_path: string;
}

/**
 * Pull a list of distinctive markers from a SOUL.md / AGENT.md pair.
 * Heuristic-based: look for quoted phrases, italicized phrases, framework
 * names (anything in **bold** or `code-spans`), and signature lexicon
 * declared with explicit headers like "## Signature phrases".
 *
 * Not perfect — but cheap and good enough to detect "did the agent even
 * touch the canon?".
 */
function extractMarkers(soul: string, agent: string): string[] {
  const text = (soul || "") + "\n\n" + (agent || "");
  const markers = new Set<string>();

  // Quoted phrases (≥3 words inside straight or curly quotes)
  const quoted = text.match(/[“"]([^“”"]{8,160})[”"]/g) || [];
  for (const q of quoted) {
    const inner = q.replace(/[“”"]/g, "").trim();
    if (inner.split(/\s+/).length >= 3) markers.add(inner);
  }

  // Bolded phrases (markdown **...**) of 2-12 words
  const bolded = text.match(/\*\*([^*]{6,120})\*\*/g) || [];
  for (const b of bolded) {
    const inner = b.replace(/\*\*/g, "").trim();
    const words = inner.split(/\s+/).length;
    if (words >= 2 && words <= 12) markers.add(inner);
  }

  // Code-span phrases (single backticks): typically framework names / commands
  const code = text.match(/`([^`]{3,60})`/g) || [];
  for (const c of code) {
    const inner = c.replace(/`/g, "").trim();
    if (inner.length >= 3) markers.add(inner);
  }

  // Strip overly generic markers (single words, common stopwords, slugs)
  const STOP = new Set([
    "the", "and", "or", "but", "for", "with", "you", "agent", "soul",
    "command", "tool", "yes", "no", "true", "false",
  ]);
  return [...markers].filter(m => {
    const lower = m.toLowerCase();
    if (STOP.has(lower)) return false;
    if (lower.length < 4) return false;
    return true;
  });
}

/**
 * Deterministic precheck: count how many distinctive markers from each
 * declared mind-clone's canon appear (substring match, case-insensitive)
 * in the produced artifact.
 *
 * Returns 0-100 per clone + an overall density score. <30 strongly
 * suggests the agent ignored the DNA entirely.
 */
export function voiceFidelityDeterministicSignals(opts: {
  artifact: string;
  mind_clones: Array<{ slug: string; soul?: string; agent?: string }>;
}): VoiceFidelitySignals {
  const lower = (opts.artifact || "").toLowerCase();
  const perClone: Record<string, number> = {};
  let totalSearched = 0;
  let totalFound = 0;

  for (const mc of opts.mind_clones) {
    const markers = extractMarkers(mc.soul || "", mc.agent || "");
    if (markers.length === 0) {
      perClone[mc.slug] = 0;
      continue;
    }
    let found = 0;
    for (const m of markers) {
      if (lower.includes(m.toLowerCase())) found++;
    }
    totalSearched += markers.length;
    totalFound += found;
    perClone[mc.slug] = Math.round((found / markers.length) * 100);
  }

  const density = totalSearched > 0
    ? Math.round((totalFound / totalSearched) * 100)
    : 0;

  return {
    markers_found_per_clone: perClone,
    overall_marker_density: density,
    total_markers_searched: totalSearched,
    total_markers_found: totalFound,
  };
}

/**
 * Build the input payload for the voice-fidelity LLM grader.
 * Reads each declared mind-clone's SOUL.md + AGENT.md from the canonical
 * library via getMindClone() (already used by injectMindClones).
 *
 * Returns the pack PLUS the deterministic signals — caller can short-
 * circuit on density < 30 without an LLM call.
 */
export function buildVoiceFidelityPack(opts: {
  artifact: string;
  artifact_kind?: string;
  slugs: string[];                  // declared mind-clones to grade against
  threshold?: number;               // pass threshold (default 70)
}): VoiceFidelityGradingPack | null {
  const mindClones: VoiceFidelityGradingPack["mind_clones"] = [];
  for (const input of opts.slugs) {
    const { category, slug } = parseSlug(input);
    const mc = getMindClone(category, slug);
    if (!mc?.files) continue;
    const soulFile = mc.files.find((f: any) => f.path === "agent/SOUL.md");
    const agentFile = mc.files.find((f: any) => f.path === "agent/AGENT.md" || f.path === "AGENT.md");
    mindClones.push({
      slug: input,
      category: mc.category,
      soul: soulFile?.content || "",
      agent: agentFile?.content || "",
    });
  }
  if (mindClones.length === 0) return null;

  const signals = voiceFidelityDeterministicSignals({
    artifact: opts.artifact,
    mind_clones: mindClones,
  });

  return {
    artifact: opts.artifact,
    artifact_kind: opts.artifact_kind || "doc",
    mind_clones: mindClones,
    deterministic_signals: signals,
    threshold: opts.threshold ?? (Number(process.env.NIRVANA_VOICE_FIDELITY_THRESHOLD) || 70),
    rubric_path: path.join(
      path.dirname(import.meta.path),
      "..", "rubrics", "mind-clone-voice-fidelity.md"
    ),
  };
}

export interface VoiceFidelityResult {
  overall_score: number;
  verdict: "pass" | "fail";
  per_clone: Array<{
    slug: string;
    score: number;
    voice_match: number;
    framework_use: number;
    vocabulary_match: number;
    evidence: Array<{ quote: string; supports?: string; violates?: string }>;
  }>;
  summary: string;
  fix_list: string[];
}

/**
 * Emit gate_passed/gate_failed for the voice-fidelity rubric, with the
 * grader's structured findings stapled to the event payload.
 */
export function emitVoiceFidelityGate(opts: {
  trace_id: string;
  result: VoiceFidelityResult;
  threshold?: number;
  project_id?: string;
  business_slug?: string;
}): void {
  const ctx: any = { trace_id: opts.trace_id };
  if (opts.project_id) ctx.project_id = opts.project_id;
  if (opts.business_slug) ctx.business_slug = opts.business_slug;
  const event = opts.result.verdict === "pass" ? "gate_passed" : "gate_failed";
  audit.emit(event, {
    rubric: "mind_clone_voice_fidelity",
    score: opts.result.overall_score,
    threshold: opts.threshold ?? 70,
    per_clone: opts.result.per_clone,
    summary: opts.result.summary,
    fix_list: opts.result.fix_list,
  }, ctx);
}

/**
 * Print a human-readable summary of a ValidationReport (for the CLI).
 */
export function formatReport(r: ValidationReport): string {
  const lines: string[] = [];
  const status = r.ok ? "✓ PASS" : "✗ FAIL";
  lines.push(`${status} · trace ${r.trace_id} · ${r.events_seen} events`);
  if (r.declared.length) lines.push(`  declared (${r.declared.length}): ${r.declared.join(", ")}`);
  else lines.push(`  declared: (none — no target_plan_committed event found)`);
  if (r.injected.length) lines.push(`  injected (${r.injected.length}): ${r.injected.join(", ")}`);
  else lines.push(`  injected: (none)`);
  if (r.missing.length) lines.push(`  ⚠ missing injections: ${r.missing.join(", ")}`);
  if (r.unknown_injections.length) lines.push(`  ⚠ unknown injections (not declared): ${r.unknown_injections.join(", ")}`);
  for (const d of r.details) lines.push(`  · ${d}`);
  return lines.join("\n");
}
