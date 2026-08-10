#!/usr/bin/env bun
// agentic-router.ts — agentic routing over the compact routing digest.
//
// Spawns a headless host agent that reads ONE file — the routing digest built
// by scripts/build-routing-digest.ts (every business, squad, capability
// collision and mind-clone, one line each, <50k tokens) — instead of the raw
// registries (2MB+ ≈ 600k tokens). The digest header carries the registry
// paths, so the agent can escalate to a full manifest for finalists only.
//
// Why agentic: BM25 fails on prose briefs (the Dr. Paulo case picked
// holding-saude-ai because the brief had heavy medical vocabulary even though
// the JOB was landing-page work, and it ignored the user's explicit request to
// dispatch awwwards-singularity-studio). The agent reads the user's actual
// intent and the actual catalog, not word frequencies. It is the PRIMARY,
// language-agnostic matcher; BM25 is the deterministic fallback.
//
// Structured contract (routing-360 Phase 3.1):
//   ok    — transport: the call + parse + slug validation succeeded.
//   kind  — semantics: "decision" | "ambiguous" | "no_match".
// The two are strictly separate: a confident "nothing in the catalog fits" is
// ok:true + kind:"no_match", never an error. Legacy consumers (dispatch.ts)
// keep reading {ok, primary_business, mandatory_squads, optional_squads}.
//
// Test seams: parseAndValidate() is exported and pure; agenticRoute() accepts
// runHeadlessImpl + registry/digest path overrides so tests run zero-token.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { runHeadless, type Runtime, type RunHeadlessResult, type RunHeadlessOpts } from "./host-agent-driver.ts";
import { harnessLogsDir } from "../../_shared/lib/log-paths.ts";
import { BUN_BIN } from "../../_shared/lib/bun-helpers.ts";
import { resolveRoutingArtifactPaths } from "../scripts/build-routing-digest.ts";
import { formatRulesForRouterPrompt, type RuntimeRule } from "./runtime-rules.ts";

const EXEC_RUNTIMES: ReadonlyArray<string> = ["claude-code", "codex", "gemini-cli", "antigravity-cli", "kimi-cli", "grok-cli", "pi"];

export type RouteKind = "decision" | "ambiguous" | "no_match";

export interface RouteCandidate {
  target: string;
  type: "business" | "squad" | "mind_clone";
  reason: string;
}

export interface AgenticRouteDecision {
  /** Transport: the router call + JSON parse + slug validation succeeded. */
  ok: boolean;
  /** Semantics: what the router concluded. Never inferred from `ok`. */
  kind: RouteKind;
  primary_business: string | null;
  mandatory_squads: string[];
  optional_squads: string[];
  /** 0-3 clone slugs, only when the brief implies a voice/persona. */
  suggested_mind_clones: string[];
  /** Populated only when kind === "ambiguous". */
  candidates: RouteCandidate[];
  rationale: string;
  /** Runtime suggested by the user's USE_* rules (null = no match). */
  runtime: Runtime | null;
  /** Non-fatal validation notes (unknown slugs filtered, etc.). */
  warnings: string[];
  cost_usd: number | null;
  duration_ms: number;
  error?: string;
}

function emitAudit(payload: Record<string, any>, cwd?: string): void {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const dir = path.join(harnessLogsDir({ cwd }), today);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "audit.jsonl"), JSON.stringify({ ts: new Date().toISOString(), ...payload }) + "\n");
  } catch { /* non-fatal */ }
}

// ─────────────────────────────────────────────────────────────────────
// Digest staleness guard
// ─────────────────────────────────────────────────────────────────────

export interface RouterPaths {
  businessesRegistry: string;
  squadsRegistry: string;
  mindClonesRegistry: string;
  digest: string;
}

function defaultRouterPaths(): RouterPaths {
  const p = resolveRoutingArtifactPaths();
  return {
    businessesRegistry: p.businessesRegistry,
    squadsRegistry: p.squadsRegistry,
    mindClonesRegistry: p.mindClonesRegistry,
    digest: p.digest,
  };
}

const mtimeOf = (p: string): number => {
  try { return fs.statSync(p).mtimeMs; } catch { return -1; }
};

/** Stale = digest missing, or older than any registry that exists. */
export function digestIsStale(p: RouterPaths): boolean {
  const digestMtime = mtimeOf(p.digest);
  if (digestMtime < 0) return true;
  for (const reg of [p.businessesRegistry, p.squadsRegistry, p.mindClonesRegistry]) {
    const m = mtimeOf(reg);
    if (m >= 0 && m > digestMtime) return true;
  }
  return false;
}

const DEFAULT_BUILDER_SCRIPT = path.join(import.meta.dir, "..", "scripts", "build-routing-digest.ts");

/**
 * Regenerate the digest when stale. Returns true when a rebuild was spawned.
 * Emits an `x_digest_regenerated` audit event (open namespace).
 */
export function ensureFreshDigest(
  p: RouterPaths,
  opts: { cwd?: string; projectId?: string | null; builderScript?: string } = {},
): boolean {
  if (!digestIsStale(p)) return false;
  const script = opts.builderScript ?? DEFAULT_BUILDER_SCRIPT;
  const started = Date.now();
  const r = spawnSync(BUN_BIN, [
    script,
    "--businesses", p.businessesRegistry,
    "--squads", p.squadsRegistry,
    "--clones", p.mindClonesRegistry,
    "--out", p.digest,
    "--quiet",
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 });
  emitAudit({
    event: "x_digest_regenerated",
    project_id: opts.projectId ?? null,
    digest_path: p.digest,
    ok: r.status === 0,
    duration_ms: Date.now() - started,
    ...(r.status !== 0 ? { error: (r.stderr || "").trim().slice(0, 400) } : {}),
  }, opts.cwd);
  return true;
}

// ─────────────────────────────────────────────────────────────────────
// Parse + validate (pure — the zero-token test seam)
// ─────────────────────────────────────────────────────────────────────

export interface RegistrySlugs {
  businesses: Set<string>;
  squads: Set<string>;
  mindClones: Set<string>;
}

export function loadRegistrySlugs(p: RouterPaths): RegistrySlugs {
  const readKeys = (file: string, key: string): Set<string> => {
    try { return new Set(Object.keys(JSON.parse(fs.readFileSync(file, "utf8"))[key] || {})); }
    catch { return new Set(); }
  };
  return {
    businesses: readKeys(p.businessesRegistry, "businesses"),
    squads: readKeys(p.squadsRegistry, "squads"),
    mindClones: readKeys(p.mindClonesRegistry, "mind_clones"),
  };
}

/** Extract the first balanced top-level {...} block (handles fenced JSON and
 * surrounding prose — the model sometimes wraps or comments its output). */
export function extractJsonBlock(txt: string): string | null {
  const start = txt.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < txt.length; i++) {
    const ch = txt[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) return txt.slice(start, i + 1); }
  }
  return null;
}

export type ParsedDecision = Pick<AgenticRouteDecision,
  "kind" | "primary_business" | "mandatory_squads" | "optional_squads" |
  "suggested_mind_clones" | "candidates" | "rationale" | "runtime" | "warnings">;

/**
 * Parse the router's raw stdout and validate every slug against the real
 * registries. Unknown slugs are FILTERED (never passed through) with a warning
 * listed in the decision. Returns ok:false only for transport-level defects
 * (no JSON, invalid JSON) — a semantic no_match parses as ok:true.
 */
export function parseAndValidate(raw: string, slugs: RegistrySlugs): { ok: boolean; error?: string; decision?: ParsedDecision } {
  const txt = (raw || "").trim();
  const jsonStr = extractJsonBlock(txt);
  if (!jsonStr) return { ok: false, error: `router did not return JSON (output head: ${txt.slice(0, 200)})` };

  let parsed: any;
  try { parsed = JSON.parse(jsonStr); }
  catch (e: any) { return { ok: false, error: `router JSON invalid: ${e.message}` }; }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: "router JSON is not an object" };
  }

  const warnings: string[] = [];

  const filterSlugs = (arr: unknown, known: Set<string>, label: string): string[] => {
    if (!Array.isArray(arr)) return [];
    const out: string[] = [];
    for (const s of arr) {
      if (typeof s !== "string" || !s.trim()) continue;
      if (known.has(s)) { if (!out.includes(s)) out.push(s); }
      else warnings.push(`unknown ${label} slug filtered: ${s}`);
    }
    return out;
  };

  let primary: string | null = null;
  if (typeof parsed.primary_business === "string" && parsed.primary_business.trim()) {
    if (slugs.businesses.has(parsed.primary_business)) primary = parsed.primary_business;
    else warnings.push(`unknown business slug filtered: ${parsed.primary_business}`);
  }
  const mandatory = filterSlugs(parsed.mandatory_squads, slugs.squads, "squad");
  const optional = filterSlugs(parsed.optional_squads, slugs.squads, "squad")
    .filter((s) => !mandatory.includes(s));
  const suggestedClones = filterSlugs(parsed.suggested_mind_clones, slugs.mindClones, "mind-clone").slice(0, 3);

  const candidates: RouteCandidate[] = [];
  if (Array.isArray(parsed.candidates)) {
    for (const c of parsed.candidates) {
      if (!c || typeof c.target !== "string" || !c.target.trim()) continue;
      const type: RouteCandidate["type"] =
        c.type === "squad" ? "squad" : c.type === "mind_clone" ? "mind_clone" : "business";
      const known = type === "squad" ? slugs.squads : type === "mind_clone" ? slugs.mindClones : slugs.businesses;
      if (!known.has(c.target)) { warnings.push(`unknown ${type} candidate filtered: ${c.target}`); continue; }
      candidates.push({ target: c.target, type, reason: typeof c.reason === "string" ? c.reason : "" });
    }
  }

  // kind: trust a valid declared kind; infer for legacy-shaped outputs.
  let kind: RouteKind;
  if (parsed.kind === "decision" || parsed.kind === "ambiguous" || parsed.kind === "no_match") kind = parsed.kind;
  else kind = (primary || mandatory.length) ? "decision" : candidates.length ? "ambiguous" : "no_match";

  // Consistency after filtering: a "decision" whose every slug was unknown has
  // no actionable target left — downgrade honestly instead of shipping an
  // empty decision.
  if (kind === "decision" && !primary && mandatory.length === 0) {
    kind = candidates.length ? "ambiguous" : "no_match";
    warnings.push(`kind downgraded to ${kind}: no valid primary_business or mandatory_squads after validation`);
  }
  if (kind === "ambiguous" && candidates.length === 0) {
    kind = "no_match";
    warnings.push("kind downgraded to no_match: no valid candidates after validation");
  }

  // Runtime suggested by the user's USE_* rules: canonical exec values only —
  // hermes and unknowns become null (hermes is delegation, never head exec).
  let ruleRuntime: Runtime | null = null;
  if (typeof parsed.runtime === "string" && parsed.runtime.trim()) {
    const v = parsed.runtime.trim().toLowerCase();
    if (EXEC_RUNTIMES.includes(v)) ruleRuntime = v as Runtime;
    else warnings.push(`invalid runtime '${parsed.runtime}' in router JSON — ignored`);
  }

  return {
    ok: true,
    decision: {
      kind,
      primary_business: primary,
      mandatory_squads: mandatory,
      optional_squads: optional,
      suggested_mind_clones: suggestedClones,
      candidates: kind === "ambiguous" ? candidates : [],
      rationale: typeof parsed.rationale === "string" ? parsed.rationale : "",
      runtime: ruleRuntime,
      warnings,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────
// Prompt
// ─────────────────────────────────────────────────────────────────────

export function buildRouterPrompt(briefFile: string, digestPath: string, runtimeRules?: RuntimeRule[]): string {
  return `You are the agentic router of Nirvana-OS. You decide WHICH BUSINESS orchestrates, WHICH SQUADS execute, and WHICH MIND-CLONES (personas) are suggested — by reading the routing digest for real and honoring the user's literal orders.

## MOTHER RULE: SEPARATE OBJECT FROM THEME

Every brief has 2 dimensions. DO NOT MIX THEM:
- **OBJECT** = the concrete ARTIFACT to deliver (landing page, book, app, legal opinion, report, brand, social media content, video, etc.). It is WHAT to build.
- **THEME** = the SUBJECT MATTER (healthcare, agro, finance, labor law, beauty, etc.). It is WHAT IT IS ABOUT.

**The OBJECT drives ~80% of the routing.** THEME is a secondary filter.

Examples:
- "Premium landing page for a nutrology clinic" → OBJECT=landing page, THEME=healthcare. Primary business = whoever ORCHESTRATES landing/web delivery (design/frontend), NOT a medical business. THEME enters as an optional squad (e.g. a medical-compliance squad), never as primary.
- "Legal opinion on a workplace accident" → OBJECT=legal opinion, THEME=occupational safety/medicine. Primary = the labor-law business.
- "Strategic branding PDF for a clinic" → OBJECT=brand strategy + PDF, THEME=healthcare. Primary = the brand business.

If a candidate business cannot deliver the OBJECT (e.g. a medical business does not build HTML/CSS/JS), it is WRONG even when the THEME matches.

## HARD RULES
1. **An explicit target wins — and narrowly.** If the user names ONLY ONE SQUAD and no business (e.g. "use brandcraft", "create a PDF with brandcraft"): run ONLY that squad — put it in mandatory_squads, leave \`primary_business: null\`, and do NOT escalate to a business, UNLESS the OBJECT genuinely requires a multi-phase pipeline the squad alone cannot deliver (if so, justify it explicitly in the rationale). If the user names a BUSINESS, use that business. If NO target is named, survey the whole digest (businesses AND squads) and pick the best set — never force a business just because the slot exists.
2. **The user is in command.** If the brief says "use squad X" or "use business Y", they go into mandatory_squads / primary_business WITHOUT negotiation. If the user names an OBJECT squad (e.g. awwwards-singularity-studio for a landing page), it must be in the chain.
3. **For software/web OBJECTS** (landing page, app, site, dashboard, SaaS): if a business is the primary, it must have design+frontend+backend capabilities/employees. Specialist OBJECT squads (e.g. landing-page specialists) go into mandatory_squads when applicable.
4. **For deep textual OBJECTS** (book, legal opinion, technical report): primary is the business whose intake+synthesizer provide the authority — except when a single named squad already delivers the object (rule 1).
5. **For visual OBJECTS** (logo, identity, illustration): primary is a brand/design business + an image-generation skill is assumed.
6. **optional_squads**: 0-3 complementary squads (usually THEME squads). This is not spray-and-pray.
7. **suggested_mind_clones**: 0-3 mind-clone slugs, ONLY when the brief implies a specific voice, persona, or named expert judgment (e.g. "in the style of X", "as a veteran casting director would"). They are suggestions for persona injection, not executors. Pick from the mind-clones section of the digest; respect each clone's territory (a clone is never picked for what it refuses). No voice implied → empty list.

## SURVEY
- \`Read ${briefFile}\` — the full brief.
- \`Read ${digestPath}\` — the routing digest: EVERY business, squad, capability collision and mind-clone, one line each. This single file IS your survey of all three registries — do NOT read the raw registries to survey.
- Escalation (finalists only): the digest header lists the three registry paths; each registry entry carries \`manifest_path\` (businesses/squads) or persona file paths (mind-clones). Read a full manifest ONLY to confirm or rule out a finalist you are genuinely unsure about — never to survey.

## METHOD
1. Read the brief. **State OBJECT and THEME to yourself** (they go into the rationale).
2. Extract the user's explicit mentions (phrases like "use squad X").
3. Read the digest. Filter first by OBJECT (capabilities that deliver the artifact). Then validate against THEME (optional THEME squads).
4. primary_business: the one whose capabilities/employees align with the OBJECT. A THEME business that cannot deliver the OBJECT can NEVER be primary.
5. mandatory_squads: the user's literal asks + OBJECT squads when there is a clear specialist.
6. optional_squads: up to 3, usually THEME squads for validation. suggested_mind_clones: rule 7.
7. If two or more genuinely different routes fit and the brief does not disambiguate, return kind "ambiguous" with the candidates instead of guessing. If nothing in the catalog can deliver the OBJECT, return kind "no_match" — an honest no_match beats a forced dispatch.
8. Rationale (3-5 sentences): start with "OBJECT=<x>, THEME=<y>." then justify.

${runtimeRules?.length ? formatRulesForRouterPrompt(runtimeRules) + "\n\n" : ""}## OUTPUT
Exactly one JSON object, no markdown fences, no prose before or after. Never invent slugs — only slugs present in the digest.

Decision (the normal case):
\`\`\`
{"kind":"decision","primary_business":"<slug or null>","mandatory_squads":["<slug>",...],"optional_squads":["<slug>",...],"suggested_mind_clones":["<slug>",...],"rationale":"OBJECT=<x>, THEME=<y>. <justification>"${runtimeRules?.length ? ',"runtime":"<canonical runtime if a USE_* rule matches, else omit>"' : ""}}
\`\`\`
\`primary_business\` may be \`null\` when the user named only a squad and it delivers the object alone (rule 1):
\`\`\`
{"kind":"decision","primary_business":null,"mandatory_squads":["brandcraft"],"optional_squads":[],"suggested_mind_clones":[],"rationale":"OBJECT=branding PDF, THEME=none. The user named the brandcraft squad explicitly and it delivers the PDF alone; no escalation to a business is needed."}
\`\`\`
Ambiguous (2+ genuinely different routes fit, brief does not disambiguate — max 4 candidates):
\`\`\`
{"kind":"ambiguous","candidates":[{"target":"<slug>","type":"business|squad","reason":"<one line>"},...],"rationale":"OBJECT=<x>, THEME=<y>. <why the brief cannot disambiguate>"}
\`\`\`
No match (nothing in the catalog delivers the OBJECT):
\`\`\`
{"kind":"no_match","rationale":"OBJECT=<x>, THEME=<y>. <what is missing from the catalog>"}
\`\`\``;
}

// ─────────────────────────────────────────────────────────────────────
// agenticRoute
// ─────────────────────────────────────────────────────────────────────

export interface AgenticRouteArgs {
  brief: string;
  runtime: Runtime;
  cwd: string;
  projectId?: string | null;
  maxBudgetUsd?: number;
  timeoutMs?: number;
  /** User USE_* rules — injected verbatim into the router prompt. */
  runtimeRules?: RuntimeRule[];
  /** Test seam: canned headless runner (zero-token tests). */
  runHeadlessImpl?: (opts: RunHeadlessOpts) => RunHeadlessResult;
  /** Test seam: registry/digest path overrides (fixture registries). */
  paths?: Partial<RouterPaths>;
  /** Test seam: digest builder script override. */
  digestBuilderScript?: string;
}

function failed(error: string, costUsd: number | null, durationMs: number): AgenticRouteDecision {
  return {
    ok: false, kind: "no_match", primary_business: null, mandatory_squads: [],
    optional_squads: [], suggested_mind_clones: [], candidates: [], rationale: "",
    runtime: null, warnings: [], cost_usd: costUsd, duration_ms: durationMs, error,
  };
}

/** Run the router. Writes one `agentic_route_decision` audit event. */
export async function agenticRoute(args: AgenticRouteArgs): Promise<AgenticRouteDecision> {
  const routerPaths: RouterPaths = { ...defaultRouterPaths(), ...(args.paths || {}) };

  // Staleness guard: never let the subagent survey a digest older than the
  // registries (or none at all).
  ensureFreshDigest(routerPaths, {
    cwd: args.cwd,
    projectId: args.projectId ?? null,
    builderScript: args.digestBuilderScript,
  });
  if (!fs.existsSync(routerPaths.digest)) {
    emitAudit({
      event: "agentic_route_failed", project_id: args.projectId ?? null,
      error: `routing digest missing and rebuild failed: ${routerPaths.digest}`,
      duration_ms: 0, cost_usd: null,
    }, args.cwd);
    return failed(`routing digest missing and rebuild failed: ${routerPaths.digest}`, null, 0);
  }

  // Write the brief to a temp file the agent can `Read` (avoids quoting hell
  // for big prose briefs) and reference by absolute path.
  const briefFile = path.join(os.tmpdir(), `agentic-router-brief-${Date.now()}.md`);
  fs.writeFileSync(briefFile, args.brief, "utf8");

  const prompt = buildRouterPrompt(briefFile, routerPaths.digest, args.runtimeRules);

  const started = Date.now();
  emitAudit({
    event: "agentic_route_called",
    project_id: args.projectId ?? null,
    brief_chars: args.brief.length,
    digest_path: routerPaths.digest,
  }, args.cwd);

  const runner = args.runHeadlessImpl ?? runHeadless;
  const res = runner({
    runtime: args.runtime,
    prompt,
    cwd: args.cwd,
    allowedTools: ["Read", "Glob", "Grep", "Bash"],
    permissionMode: "acceptEdits",
    maxBudgetUsd: args.maxBudgetUsd,
    timeoutMs: args.timeoutMs ?? 5 * 60 * 1000,
  });
  const durationMs = Date.now() - started;

  try { fs.rmSync(briefFile, { force: true }); } catch { /* ignore */ }

  if (!res.ok) {
    emitAudit({
      event: "agentic_route_failed",
      project_id: args.projectId ?? null,
      error: res.error || res.stderr,
      duration_ms: durationMs,
      cost_usd: res.costUsd,
    }, args.cwd);
    return failed(res.error || res.stderr || "router run failed", res.costUsd, durationMs);
  }

  const slugs = loadRegistrySlugs(routerPaths);
  const parsed = parseAndValidate(res.result || "", slugs);
  if (!parsed.ok || !parsed.decision) {
    emitAudit({
      event: "agentic_route_failed",
      project_id: args.projectId ?? null,
      error: parsed.error,
      duration_ms: durationMs,
      cost_usd: res.costUsd,
    }, args.cwd);
    return failed(parsed.error || "router output unparsable", res.costUsd, durationMs);
  }

  const d = parsed.decision;
  for (const w of d.warnings) console.error(`[agentic-router] ${w}`);

  emitAudit({
    event: "agentic_route_decision",
    project_id: args.projectId ?? null,
    kind: d.kind,
    primary_business: d.primary_business,
    mandatory_squads: d.mandatory_squads,
    optional_squads: d.optional_squads,
    suggested_mind_clones: d.suggested_mind_clones,
    candidates: d.candidates,
    rationale: d.rationale,
    runtime: d.runtime,
    warnings: d.warnings,
    cost_usd: res.costUsd,
    duration_ms: durationMs,
  }, args.cwd);

  return { ok: true, ...d, cost_usd: res.costUsd, duration_ms: durationMs };
}
