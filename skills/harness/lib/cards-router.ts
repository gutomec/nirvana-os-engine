#!/usr/bin/env bun
// cards-router.ts — the `cards` routing mode: one call, no tools, compiled cards.
//
// The agentic router is an agent with Read/Glob/Grep/Bash that surveys the
// routing digest and opens the finalists' files. This mode asks one question
// instead: the brief, the compiled cards (lib/routing-cards.ts: one line per
// business and squad, what it produces first) and the mind-clones the lexical
// clone search ranks for the brief go in; a JSON decision comes out. The call
// runs in an empty temporary directory with the runtime's tools switched off
// where the CLI can do that, so there is nothing to survey and no work to
// report on, only an answer to give.
//
// The answer maps onto the same AgenticRouteDecision the dispatch already
// consumes, so the fallback ladder, the plan and every target path downstream
// are the agentic ones:
//   business:<slug> → decision, primary_business, support squads as mandatory
//   squad:<slug>    → decision, the squad alone
//   solo            → no_match, which the cascade sends to agent-x
// It adds `done`: the observable states the router says mean the brief is met,
// which the dispatch carries into the brief as a "Done when" section.
//
// A target that is not installed gets ONE more call that names the error.
// Voices and support squads that are not installed are dropped, never fatal,
// and what was dropped is reported (console + audit).

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { runHeadless, type Runtime, type RunHeadlessOpts, type RunHeadlessResult } from "./host-agent-driver.ts";
import {
  digestIsStale, extractJsonBlock, loadRegistrySlugs,
  type AgenticRouteDecision, type RegistrySlugs, type RouterPaths,
} from "./agentic-router.ts";
import { resolveRoutingArtifactPaths } from "../scripts/build-routing-digest.ts";
import { clip } from "./routing-cards.ts";
import { findCloneForTask } from "../../_shared/lib/clone-search.ts";
import { harnessLogsDir } from "../../_shared/lib/log-paths.ts";
import { stamp } from "../../_shared/lib/audit-provenance.ts";
import { BUN_BIN } from "../../_shared/lib/bun-helpers.ts";
import { resolveSetting } from "../../_shared/lib/settings.ts";

export const CLONE_CANDIDATES = 15;
const MAX_VOICES = 2;
const MAX_SUPPORT_SQUADS = 2;
const MAX_DONE = 5;

export interface CardsRouterPaths extends RouterPaths {
  cards: string;
}

export interface CardsRouteDecision extends AgenticRouteDecision {
  /** Observable states that mean the brief is met (3-5 asked for). */
  done: string[];
  /** Voices and squads the answer named that were not kept, with the prefix
   *  that says which kind (`clone:<slug>`, `squad:<slug>`). */
  dropped: string[];
  /** Runtime calls this decision took (1, or 2 after a correction). */
  attempts: number;
}

function defaultPaths(): CardsRouterPaths {
  const p = resolveRoutingArtifactPaths();
  return {
    businessesRegistry: p.businessesRegistry,
    squadsRegistry: p.squadsRegistry,
    mindClonesRegistry: p.mindClonesRegistry,
    digest: p.digest,
    cards: p.cards,
  };
}

function emitAudit(payload: Record<string, any>, cwd?: string): void {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const dir = path.join(harnessLogsDir({ cwd }), today);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "audit.jsonl"), JSON.stringify(stamp({ ts: new Date().toISOString(), ...payload })) + "\n");
  } catch { /* non-fatal */ }
}

const DEFAULT_BUILDER_SCRIPT = path.join(import.meta.dir, "..", "scripts", "build-routing-digest.ts");

/** Rebuild the cards (and the digest beside them) when they are missing or
 *  older than any registry — the digest's own staleness rule. */
export function ensureFreshCards(
  p: CardsRouterPaths,
  opts: { cwd?: string; projectId?: string | null; builderScript?: string } = {},
): boolean {
  if (!digestIsStale({ ...p, digest: p.cards })) return false;
  const started = Date.now();
  const r = spawnSync(BUN_BIN, [
    opts.builderScript ?? DEFAULT_BUILDER_SCRIPT,
    "--businesses", p.businessesRegistry,
    "--squads", p.squadsRegistry,
    "--clones", p.mindClonesRegistry,
    "--out", p.digest,
    "--cards-out", p.cards,
    "--quiet",
  ], { windowsHide: true, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 });
  emitAudit({
    event: "x_digest_regenerated",
    project_id: opts.projectId ?? null,
    digest_path: p.digest,
    cards_path: p.cards,
    ok: r.status === 0,
    duration_ms: Date.now() - started,
    ...(r.status !== 0 ? { error: (r.stderr || "").trim().slice(0, 400) } : {}),
  }, opts.cwd);
  return true;
}

// ─────────────────────────────────────────────────────────────────────
// Prompt
// ─────────────────────────────────────────────────────────────────────

export interface CloneCandidate { slug: string; display_name?: string | null; one_liner?: string | null }

export function cloneCandidateLine(c: CloneCandidate): string {
  const name = String(c.display_name || c.slug).replace(/\s+/g, " ").trim();
  const oneLiner = clip(String(c.one_liner || "").replace(/\|/g, "/").replace(/\s+/g, " ").trim(), 180);
  return [`clone:${c.slug}`, name, oneLiner].filter(Boolean).join(" | ");
}

export function buildCardsPrompt(brief: string, cards: string, clones: string[], correction?: string): string {
  return [
    "You choose who executes a request. Do not execute the request and do not use tools: answer with one JSON object and nothing else.",
    "# Request",
    brief.trim(),
    cards.trim(),
    "# Mind-clone candidates",
    "The closest to the request in a lexical search. Use only the ones that truly serve it.",
    clones.join("\n") || "(none)",
    "# How to choose",
    [
      "- Choose by what must be produced, not by the theme of the request.",
      "- A business or squad the request names explicitly is the target.",
      "- With no target named, a business is the default and a squad the exception: go straight to a squad only when the request is one artifact of one specialty, that squad delivers the whole of it, and nothing needs judgment across specialties. \"solo\" when nothing in the catalog can deliver it.",
      "- Voices: 0 to 2 mind-clones whose method improves the delivery. None beats a forced one.",
      "- Support squads: only when the target is a business, 0 to 2 squads for parts of the request that no role of the business covers. A squad that would repeat the roles' work slows the delivery; then, none.",
      "- Done when: 3 to 5 observable states that are true once the request is met. States, not steps.",
      "- Write the done states and the reason in the language of the request.",
    ].join("\n"),
    ...(correction ? ["# Correction", correction] : []),
    "# Answer",
    '{"target": "business:<slug> | squad:<slug> | solo", "voices": ["<slug>"], "squads": ["<slug>"], "done": ["<state>"], "reason": "<one sentence>"}',
  ].join("\n\n");
}

// ─────────────────────────────────────────────────────────────────────
// Parse + validate (pure — the zero-token test seam)
// ─────────────────────────────────────────────────────────────────────

export interface CardsAnswer {
  target: string;
  voices: string[];
  squads: string[];
  done: string[];
  reason: string;
}

/** The answer text of a runtime result. gemini hands back its whole JSON
 *  envelope, with the model's text in `response`; the others the text itself. */
function answerText(result: string): string {
  const txt = (result || "").trim();
  try {
    const j = JSON.parse(txt);
    if (j && typeof j === "object" && typeof j.response === "string") return j.response;
  } catch { /* the text itself */ }
  return txt;
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim()) : [];

/** The cards show ids as `clone:<slug>` and `squad:<slug>`, and models echo them. */
const unprefix = (items: string[], prefix: string): string[] =>
  [...new Set(items.map((x) => (x.startsWith(prefix) ? x.slice(prefix.length) : x).trim()).filter(Boolean))];

export function parseCardsAnswer(raw: string): { ok: true; answer: CardsAnswer } | { ok: false; error: string } {
  const txt = answerText(raw);
  const block = extractJsonBlock(txt);
  if (!block) return { ok: false, error: `the answer had no JSON object (head: ${txt.slice(0, 200)})` };
  let parsed: any;
  try { parsed = JSON.parse(block); }
  catch (e: any) { return { ok: false, error: `the answer's JSON is invalid: ${e.message}` }; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, error: "the answer's JSON is not an object" };
  return {
    ok: true,
    answer: {
      target: typeof parsed.target === "string" ? parsed.target.trim() : "",
      voices: unprefix(strings(parsed.voices), "clone:"),
      squads: unprefix(strings(parsed.squads), "squad:"),
      done: strings(parsed.done).slice(0, MAX_DONE),
      reason: typeof parsed.reason === "string" ? parsed.reason.trim() : "",
    },
  };
}

export type CardsTarget = { kind: "business" | "squad"; slug: string } | { kind: "solo" };

/** `business:<slug>`, `squad:<slug>` or `solo`. A bare slug is accepted when it
 *  names exactly one installed business or squad. */
export function resolveCardsTarget(target: string, slugs: RegistrySlugs): CardsTarget | { error: string } {
  const t = target.trim();
  if (!t) return { error: "the answer named no target" };
  if (t.toLowerCase() === "solo") return { kind: "solo" };
  const m = /^(business|squad):(.+)$/.exec(t);
  if (m) {
    const kind = m[1] as "business" | "squad";
    const slug = m[2].trim();
    const known = kind === "business" ? slugs.businesses : slugs.squads;
    return known.has(slug) ? { kind, slug } : { error: `"${t}" is not installed` };
  }
  const asBusiness = slugs.businesses.has(t);
  const asSquad = slugs.squads.has(t);
  if (asBusiness && !asSquad) return { kind: "business", slug: t };
  if (asSquad && !asBusiness) return { kind: "squad", slug: t };
  if (asBusiness && asSquad) return { error: `"${t}" is both a business and a squad; say which with a business: or squad: prefix` };
  return { error: `"${t}" is not installed` };
}

/** Map a valid answer onto the decision contract. Pure. */
export function toCardsDecision(
  answer: CardsAnswer,
  target: CardsTarget,
  slugs: RegistrySlugs,
): Pick<CardsRouteDecision, "kind" | "primary_business" | "mandatory_squads" | "optional_squads" | "suggested_mind_clones"
  | "candidates" | "rationale" | "runtime" | "warnings" | "done" | "dropped"> {
  const dropped: string[] = [];
  const warnings: string[] = [];
  const voices: string[] = [];
  for (const slug of answer.voices) {
    if (slugs.mindClones.has(slug) && voices.length < MAX_VOICES) voices.push(slug);
    else {
      dropped.push(`clone:${slug}`);
      warnings.push(slugs.mindClones.has(slug) ? `voice dropped past the limit of ${MAX_VOICES}: ${slug}` : `unknown mind-clone dropped: ${slug}`);
    }
  }
  const support: string[] = [];
  for (const slug of answer.squads) {
    if (target.kind !== "business") {
      dropped.push(`squad:${slug}`);
      warnings.push(`support squad dropped (support squads go only with a business target): ${slug}`);
    } else if (!slugs.squads.has(slug)) {
      dropped.push(`squad:${slug}`);
      warnings.push(`unknown squad dropped: ${slug}`);
    } else if (support.length >= MAX_SUPPORT_SQUADS) {
      dropped.push(`squad:${slug}`);
      warnings.push(`support squad dropped past the limit of ${MAX_SUPPORT_SQUADS}: ${slug}`);
    } else support.push(slug);
  }
  const base = {
    optional_squads: [] as string[], suggested_mind_clones: voices, candidates: [],
    rationale: answer.reason, runtime: null, warnings, done: answer.done, dropped,
  };
  if (target.kind === "business") return { kind: "decision", primary_business: target.slug, mandatory_squads: support, ...base };
  if (target.kind === "squad") return { kind: "decision", primary_business: null, mandatory_squads: [target.slug], ...base };
  return { kind: "no_match", primary_business: null, mandatory_squads: [], ...base };
}

/** The router's done states, as the section the executor checks itself against. */
export function withDoneWhen(brief: string, done: string[]): string {
  if (!done.length) return brief;
  return [
    brief.trimEnd(),
    "",
    "## Done when",
    "",
    "Check each of these yourself before you finish:",
    ...done.map((d) => `- ${d.replace(/\s+/g, " ").trim()}`),
    "",
  ].join("\n");
}

// ─────────────────────────────────────────────────────────────────────
// cardsRoute
// ─────────────────────────────────────────────────────────────────────

export interface CardsRouteArgs {
  brief: string;
  runtime: Runtime;
  /** The dispatch's cwd: where the audit lands. The call itself runs elsewhere. */
  cwd: string;
  projectId?: string | null;
  maxBudgetUsd?: number;
  /** Ceiling of one routing call; default `routing.timeout_ms`. */
  timeoutMs?: number;
  /** Test seam: canned headless runner (zero-token tests). */
  runHeadlessImpl?: (opts: RunHeadlessOpts) => RunHeadlessResult;
  /** Test seam: registry/digest/cards path overrides (fixture registries). */
  paths?: Partial<CardsRouterPaths>;
  /** Test seam: digest builder script override. */
  digestBuilderScript?: string;
  /** Test seam: the lexical clone search. */
  cloneSearchImpl?: (brief: string, limit: number) => CloneCandidate[];
}

function failed(error: string, costUsd: number | null, durationMs: number, attempts: number, timedOut = false): CardsRouteDecision {
  return {
    ok: false, kind: "no_match", primary_business: null, mandatory_squads: [],
    optional_squads: [], suggested_mind_clones: [], candidates: [], rationale: "",
    runtime: null, warnings: [], cost_usd: costUsd, duration_ms: durationMs, error,
    done: [], dropped: [], attempts,
    ...(timedOut ? { timed_out: true } : {}),
  };
}

const addCost = (a: number | null, b: number | null | undefined): number | null =>
  typeof b === "number" ? (a ?? 0) + b : a;

/** Run the cards router. Writes the same `agentic_route_*` audit events as the
 *  agentic router, marked `mode: "cards"`. */
export async function cardsRoute(args: CardsRouteArgs): Promise<CardsRouteDecision> {
  const paths: CardsRouterPaths = { ...defaultPaths(), ...(args.paths || {}) };
  ensureFreshCards(paths, { cwd: args.cwd, projectId: args.projectId ?? null, builderScript: args.digestBuilderScript });
  let cards: string;
  try { cards = fs.readFileSync(paths.cards, "utf8"); }
  catch {
    const error = `routing cards missing and rebuild failed: ${paths.cards}`;
    emitAudit({ event: "agentic_route_failed", mode: "cards", project_id: args.projectId ?? null, error, duration_ms: 0, cost_usd: null }, args.cwd);
    return failed(error, null, 0, 0);
  }

  const search = args.cloneSearchImpl
    ?? ((brief: string, limit: number) => findCloneForTask(brief, { limit, cwd: args.cwd }));
  let clones: string[] = [];
  try { clones = search(args.brief, CLONE_CANDIDATES).map(cloneCandidateLine); } catch { clones = []; }
  const slugs = loadRegistrySlugs(paths);

  emitAudit({
    event: "agentic_route_called", mode: "cards", project_id: args.projectId ?? null,
    brief_chars: args.brief.length, cards_path: paths.cards, clone_candidates: clones.length,
  }, args.cwd);

  const runner = args.runHeadlessImpl ?? runHeadless;
  const started = Date.now();
  let costUsd: number | null = null;
  let correction: string | undefined;
  let lastError = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    // An empty folder: the router has nothing to read and nowhere to write.
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-cards-route-"));
    let res: RunHeadlessResult;
    try {
      res = runner({
        runtime: args.runtime,
        prompt: buildCardsPrompt(args.brief, cards, clones, correction),
        cwd: scratch,
        noTools: true,
        maxBudgetUsd: args.maxBudgetUsd,
        timeoutMs: args.timeoutMs ?? resolveSetting("routing.timeout_ms").value,
        // A decision step answers with a verdict and opens nothing.
        dispatchRole: "planner",
      });
    } finally {
      try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    costUsd = addCost(costUsd, res.costUsd);
    const durationMs = Date.now() - started;

    if (!res.ok) {
      const error = res.error || res.stderr || "router run failed";
      emitAudit({ event: "agentic_route_failed", mode: "cards", project_id: args.projectId ?? null, error, duration_ms: durationMs, cost_usd: costUsd, attempt }, args.cwd);
      // A child killed at the ceiling exits 124 (the driver's code for a signal).
      return failed(error, costUsd, durationMs, attempt, res.exitCode === 124);
    }

    const parsed = parseCardsAnswer(res.result || "");
    const target = parsed.ok ? resolveCardsTarget(parsed.answer.target, slugs) : { error: parsed.error };
    if (!parsed.ok || "error" in target) {
      lastError = "error" in target ? target.error : "router answer invalid";
      if (attempt === 2) break;
      correction = parsed.ok
        ? `The previous answer chose "${parsed.answer.target}": ${lastError}. Choose an id from the catalog above, or "solo".`
        : `The previous answer could not be read: ${lastError}. Answer with the JSON object only.`;
      emitAudit({ event: "x_cards_route_retry", project_id: args.projectId ?? null, error: lastError }, args.cwd);
      console.error(`[cards-router] ${lastError} — asking once more`);
      continue;
    }

    const d = toCardsDecision(parsed.answer, target, slugs);
    for (const w of d.warnings) console.error(`[cards-router] ${w}`);
    emitAudit({
      event: "agentic_route_decision", mode: "cards", project_id: args.projectId ?? null,
      kind: d.kind, primary_business: d.primary_business, mandatory_squads: d.mandatory_squads,
      optional_squads: d.optional_squads, suggested_mind_clones: d.suggested_mind_clones,
      done: d.done, dropped: d.dropped, rationale: d.rationale, warnings: d.warnings,
      attempts: attempt, cost_usd: costUsd, duration_ms: durationMs,
    }, args.cwd);
    return { ok: true, ...d, cost_usd: costUsd, duration_ms: durationMs, attempts: attempt };
  }

  const durationMs = Date.now() - started;
  const error = `the cards router named no installed target twice (${lastError})`;
  emitAudit({ event: "agentic_route_failed", mode: "cards", project_id: args.projectId ?? null, error, duration_ms: durationMs, cost_usd: costUsd, attempt: 2 }, args.cwd);
  return failed(error, costUsd, durationMs, 2);
}
