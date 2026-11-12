// jev-router.ts — TypeSafe's Jev as the first step of `nrv dispatch --auto`.
//
// Layered, because code does what is deterministic and the classifier only
// answers what it answers well (measured on 48 labeled requests, 2026-10-13:
// 42/48 exact, 6/6 multi-business requests, 0 wrong decisions at or above the
// gate; a single Choice over 15 mixed destinations got 32/48 and let errors
// through at 0.93):
//
//   0. code, no network: a target the request names by slug (the router's
//      Stage 0.5, detectTargetMention) and the clones it names (scanNames);
//   1. local recall: businesses and squads ranked apart (lib/shortlist.ts) and
//      voice candidates: up to 8 from the library search, plus the voices the
//      seats of the business carry (the named one, else the best ranked), so a
//      person the request only describes is among them;
//   2. one Jev call, every question over the same request:
//        business   Choice among the shortlisted businesses + none
//        squad      Choice among the shortlisted squads + none
//        shape      one business / one squad / several targets / nothing fits
//        partb<i>   per clause (split by code), which business delivers it
//        parts<i>   per clause, which squad delivers it
//        voice      Choice among the voice candidates + none, only when the
//                   request names nobody
//   3. code: compose the decision in the contract every router returns
//      (AgenticRouteDecision), a rationale built from the probabilities (the
//      Jev writes none), and the confidence the gate reads.
//
// The caller acts on the decision at or above GATE and escalates to the LLM
// router below it, or on any error. Nothing here dispatches.

import * as path from "node:path";
import { createRequire } from "node:module";
import { jevCall, choiceOf, type ChoiceAnswer, type Criterion, type JevQuestion, type JevResult, type KeyLookup } from "../../_shared/lib/typesafe-client.ts";
import { loadCloneRegistry } from "../../_shared/lib/clone-resolver.ts";
import { findCloneForTask } from "../../_shared/lib/clone-search.ts";
import { resolveEntityDir } from "../../_shared/lib/entity-resource-map.ts";
import { shortlist, type Shortlist } from "./shortlist.ts";
import { readSeats } from "./business-solo.ts";
import { clip, readVoice, voiceQuestion, NONE } from "./jev-voice.ts";
import type { AgenticRouteDecision, RoutedPart } from "./agentic-router.ts";

const require_ = createRequire(import.meta.url);
const loader = require_(path.join(import.meta.dir, "registry-loader.js"));

/** The thresholds, all fixed by the 2026-10-13 measurement. */
export const GATE = 0.8;       // act on the decision at or above it; escalate below
export const PART = 0.5;       // a clause's owner needs this much confidence
export const MAX_PARTS = 3;
export { VOICE } from "./jev-voice.ts";
/** Voice candidates from the library search, and from the business's seats. */
const SEARCH_VOICES = 8;
const SEAT_VOICES = 8;

const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String).filter(Boolean) : []);
const flat = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim();

/**
 * The request split where a second deliverable usually starts: sentences, and
 * connectors like "ao mesmo tempo", "também", "depois disso", "and also", or a
 * comma or "e" before a delivery verb. The Jev classifies a text well and does
 * not segment one, so code segments. Clauses under four words are dropped; at
 * most four are kept.
 */
export function clauses(brief: string): string[] {
  // A deliverable usually opens with a verb: "monte um curso", "montar o PGR", "e ter um calendário".
  const VERB = "(?:monte|montar|crie|criar|fa[cç]a|fazer|escreva|escrever|implante|implantar|lance|lan[cç]ar|prepare|preparar|ter|quero|preciso|build|create|write|launch|set up)"; // i18n-user-facing: PT delivery verbs matched against user input
  const parts = brief
    .split(new RegExp([
      "(?<=[.!?;])\\s+",
      "\\s*(?:,\\s*)?\\b(?:ao mesmo tempo|em paralelo|al[eé]m disso|depois disso|tamb[eé]m|e,? junto,?|in parallel|and also|after that)\\b[,:]?\\s*", // i18n-user-facing: PT connectors matched against user input
      `\\s*,?\\s+e\\s*,\\s*a partir d\\w+,\\s*(?=${VERB}\\b)`,
      `\\s*,\\s*(?:e\\s+)?(?=${VERB}\\b)`,
      `\\s+e\\s+(?=${VERB}\\b)`,
    ].join("|"), "i"))
    .map((x) => x.trim()).filter((x) => x.split(/\s+/).length >= 4);
  return parts.slice(0, 4);
}

/** What an entity is, in the object form the Jev reads best: what, not_for, examples. */
function entityCriterion(registries: any, kind: "business" | "squad", slug: string): { what: string; not_for?: string; examples?: string[] } {
  const e = kind === "business" ? registries.businesses?.businesses?.[slug] : registries.squads?.squads?.[slug];
  if (!e) return { what: `${slug}: not in the registry` };
  let notFor = list(e.not_for);
  if (kind === "squad") {
    const seen = new Set<string>();
    const caps: Record<string, any[]> = registries.squads?.capabilities ?? {};
    for (const cap of list(e.capabilities)) for (const p of caps[cap] ?? []) if (p?.squad === slug) for (const nf of list(p.not_for)) seen.add(nf);
    notFor = [...seen];
  }
  const produces = list(e.produces).slice(0, 8).join(", ");
  const domains = list(e.domains).slice(0, 6).join(", ");
  return {
    what: clip(`[${kind}] ${flat(e.description)}${produces ? ` Produces: ${produces}.` : ""}${domains ? ` Domains: ${domains}.` : ""}`, 900),
    ...(notFor.length ? { not_for: clip(notFor.slice(0, 5).map(flat).join("; "), 400) } : {}),
    ...(list(e.example_briefs).length ? { examples: list(e.example_briefs).slice(0, 3).map((b) => clip(flat(b), 160)) } : {}),
  };
}

/** The short form the per-clause questions carry: they repeat the list per clause, and latency grows with input. */
function shortCriterion(registries: any, kind: "business" | "squad", slug: string): Criterion {
  const e = kind === "business" ? registries.businesses?.businesses?.[slug] : registries.squads?.squads?.[slug];
  const c = entityCriterion(registries, kind, slug);
  return { what: clip(`${flat(e?.description)} Produces: ${list(e?.produces).slice(0, 6).join(", ")}.`, 260), ...(c.not_for ? { not_for: clip(c.not_for, 160) } : {}) };
}

/** The harness's staffing rule, as the shape question's criteria. */
const SHAPE_CRITERIA: Record<string, string> = {
  one_business: "One deliverable, or several of the same specialty, that needs judgment across specialties or a review of the result: one business owns it. This is the default.",
  one_squad: "Exactly one artifact of one specialty that a single specialist team delivers whole, with nothing that needs judgment across specialties; or the request names that team.",
  several: "Two or more separate deliverables that belong to different specialties or organizations (for example a game launch and a regulated token). Circumstances of the request, such as an audit next month or the platform used, are not deliverables.",
  nothing: "Nothing that a professional services organization delivers: a recipe, trivia, a personal favor, a fact lookup, small talk.",
};

/** The voices the seats of a business carry, most relevant to the request first. */
function seatVoices(business: string, brief: string, cwd: string, registry: Record<string, any>): string[] {
  try {
    const seats = readSeats(resolveEntityDir("businesses", business, cwd), () => null);
    const all = [...new Set(seats.flatMap((s) => s.voices.map((v) => v.slug)))].filter((s) => registry[s]);
    if (all.length <= SEAT_VOICES) return all;
    const ranked = findCloneForTask(brief, { limit: all.length, cwd, only: all }).map((h) => h.slug);
    return [...new Set([...ranked, ...all])].slice(0, SEAT_VOICES);
  } catch { return []; }
}

export interface JevRouteArgs extends KeyLookup {
  brief: string;
  /** The dispatch's cwd: the project whose library is read. */
  cwd?: string;
  /** Injected (tests); loaded from the machine when absent. */
  registries?: any;
  cloneRegistry?: Record<string, any>;
  timeoutMs?: number;
  /** Test seam for the HTTP call. */
  fetchImpl?: typeof fetch;
}

export interface JevRouteResult {
  /** The decision in the routers' contract; `ok` is the Jev call's transport. */
  decision: AgenticRouteDecision;
  /** True when the caller should not act on it: below GATE, or the call failed. */
  escalate: boolean;
  gate: number;
  confidence: number;
  shape: string;
  named: Shortlist["named"];
  /** Whether a request went out at all (a named target with no voice question sends none). */
  called: boolean;
  call: Pick<JevResult, "ok" | "latency_ms" | "input_tokens" | "cost_usd" | "attempts" | "error">;
  recall_ms: number;
}

/** "polymath-press 0.91 (next ars-libri 0.05)" */
function describe(a: ChoiceAnswer | null): string {
  if (!a) return "no answer";
  const next = Object.entries(a.probabilities ?? {}).filter(([k]) => k !== a.choice).sort((x, y) => Number(y[1]) - Number(x[1]))[0];
  return `${a.choice} ${a.confidence.toFixed(2)}${next ? ` (next ${next[0]} ${Number(next[1]).toFixed(2)})` : ""}`;
}

type Owner = { kind: "business" | "squad" | "agent-x"; slug: string | null; part?: string; c?: number };

export async function jevRoute(args: JevRouteArgs): Promise<JevRouteResult> {
  const t0 = performance.now();
  const cwd = args.cwd ?? process.cwd();
  const registries = args.registries ?? loader.loadAll();
  const cloneRegistry = args.cloneRegistry ?? (loadCloneRegistry({ cwd }) as Record<string, any>);
  const brief = args.brief;

  // 0-1. Code and local recall.
  const s = await shortlist(brief, registries, { cloneRegistry });
  const named = s.named;
  const biz = s.businesses.map((b) => b.slug);
  const sq = s.squads.map((q) => q.slug);
  const namesVoice = s.clones.named.length > 0;
  let voiceCands: string[] = [];
  if (!namesVoice) {
    let search: string[] = [];
    try { search = findCloneForTask(brief, { limit: SEARCH_VOICES, cwd }).map((h) => h.slug); } catch { search = []; }
    const seatOf = named?.kind === "business" ? named.slug : (!named ? biz[0] : undefined);
    const seat = seatOf ? seatVoices(seatOf, brief, cwd, cloneRegistry) : [];
    voiceCands = [...new Set([...search, ...seat])].filter((x) => cloneRegistry[x]);
  }
  const recall_ms = Math.round(performance.now() - t0);

  // 2. The questions. A named target is a command: the Jev is never asked about the target.
  const questions: Record<string, JevQuestion> = {};
  const segs = named ? [] : clauses(brief);
  if (!named) {
    if (biz.length) questions.business = {
      type: "choice",
      instructions: "Which business (an organization with several specialist seats and one that answers for the whole) should own this request? Read not_for as a hard exclusion. Choose none when no business here delivers what is asked.",
      criteria: { ...Object.fromEntries(biz.map((b) => [b, entityCriterion(registries, "business", b)])), [NONE]: "No business in this list delivers what the request asks for." },
    };
    if (sq.length) questions.squad = {
      type: "choice",
      instructions: "Which squad (one specialist team running one workflow) delivers this request? Read not_for as a hard exclusion. Choose none when no squad here delivers it.",
      criteria: { ...Object.fromEntries(sq.map((q) => [q, entityCriterion(registries, "squad", q)])), [NONE]: "No squad in this list delivers what the request asks for." },
    };
    questions.shape = { type: "choice", instructions: "How should this request be staffed?", criteria: SHAPE_CRITERIA };
    // Asked always, read only when the shape is "several": unused answers cost tokens, not time.
    if (segs.length >= 2) {
      const bizShort = { ...Object.fromEntries(biz.map((b) => [b, shortCriterion(registries, "business", b)])), [NONE]: "No business here delivers this part." };
      const sqShort = { ...Object.fromEntries(sq.map((q) => [q, shortCriterion(registries, "squad", q)])), [NONE]: "No squad here delivers this part." };
      segs.forEach((seg, i) => {
        if (biz.length) questions[`partb${i}`] = { type: "choice", instructions: `One part of a larger request: "${seg}". Which business delivers this part? not_for is a hard exclusion.`, criteria: bizShort };
        if (sq.length) questions[`parts${i}`] = { type: "choice", instructions: `One part of a larger request: "${seg}". Which squad delivers this part? not_for is a hard exclusion.`, criteria: sqShort };
      });
    }
  }
  if (voiceCands.length) questions.voice = voiceQuestion(voiceCands, cloneRegistry);

  const called = Object.keys(questions).length > 0;
  const call: JevResult = called
    ? await jevCall(brief, questions, { cwd, ...(args.env ? { env: args.env } : {}), ...(args.home ? { home: args.home } : {}), ...(args.timeoutMs ? { timeoutMs: args.timeoutMs } : {}), ...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}) })
    : { ok: true, latency_ms: 0, answers: {}, input_tokens: 0, cost_usd: 0, attempts: 0 };
  const a = call.answers ?? {};
  const bizA = choiceOf(a, "business"), sqA = choiceOf(a, "squad"), shapeA = choiceOf(a, "shape");
  const real = (x: ChoiceAnswer | null) => !!x && x.choice !== NONE;

  // 3. Compose.
  const shape = named ? (named.kind === "squad" ? "one_squad" : "one_business") : (shapeA?.choice ?? "one_business");
  let owners: Owner[] = [];
  let confidence = 0;
  if (named) {
    owners = [{ kind: named.kind, slug: named.slug }];
    confidence = 1;
  } else if (shape === "nothing" || (bizA?.choice === NONE && sqA?.choice === NONE)) {
    owners = [{ kind: "agent-x", slug: null }];
    confidence = shapeA?.confidence ?? 0;
  } else if (shape === "several" && segs.length >= 2) {
    // Each clause to its owner: the business when the Jev is sure enough, else the squad.
    const found: Owner[] = [];
    segs.forEach((seg, i) => {
      const b = choiceOf(a, `partb${i}`), q = choiceOf(a, `parts${i}`);
      if (real(b) && b!.confidence >= PART && biz.includes(b!.choice)) found.push({ kind: "business", slug: b!.choice, part: seg, c: b!.confidence });
      else if (real(q) && q!.confidence >= PART && sq.includes(q!.choice)) found.push({ kind: "squad", slug: q!.choice, part: seg, c: q!.confidence });
    });
    const distinct = found.filter((o, i) => found.findIndex((x) => x.slug === o.slug) === i).slice(0, MAX_PARTS);
    if (distinct.length >= 2) {
      owners = distinct;
      confidence = Math.min(shapeA?.confidence ?? 0, ...distinct.map((o) => o.c ?? 0));
    } else {
      owners = real(bizA) ? [{ kind: "business", slug: bizA!.choice }] : real(sqA) ? [{ kind: "squad", slug: sqA!.choice }] : [{ kind: "agent-x", slug: null }];
      confidence = Math.min(shapeA?.confidence ?? 0, (real(bizA) ? bizA : sqA)?.confidence ?? 0);
    }
  } else if (shape === "one_squad" && real(sqA)) {
    owners = [{ kind: "squad", slug: sqA!.choice }];
    confidence = Math.min(shapeA?.confidence ?? 0, sqA!.confidence);
  } else if (real(bizA)) {
    owners = [{ kind: "business", slug: bizA!.choice }];
    confidence = Math.min(shapeA?.confidence ?? 1, bizA!.confidence);
  } else if (real(sqA)) {
    owners = [{ kind: "squad", slug: sqA!.choice }];
    confidence = sqA!.confidence;
  } else {
    owners = [{ kind: "agent-x", slug: null }];
    confidence = 0;
  }
  // A choice outside the lists cannot be dispatched.
  if (owners.some((o) => o.kind !== "agent-x" && !(o.kind === "business" ? registries.businesses?.businesses?.[o.slug!] : registries.squads?.squads?.[o.slug!]))) confidence = 0;
  // A failed call leaves a named target standing (it never depended on the Jev); anything else escalates.
  if (!call.ok && !named) confidence = 0;

  const voice = readVoice(a, voiceCands);
  const clones = namesVoice ? s.clones.named : voice?.slug ? [voice.slug] : [];

  const first = owners[0];
  const parts: RoutedPart[] = owners.length > 1
    ? owners.filter((o) => o.kind !== "agent-x").map((o) => ({ kind: o.kind as "business" | "squad", slug: o.slug!, part: o.part ?? brief, after: [] }))
    : [];
  const rationale = [
    named ? `named in the request: ${named.kind} ${named.slug}` : `business ${describe(bizA)}; squad ${describe(sqA)}; shape ${describe(shapeA)}`,
    owners.length > 1 ? `parts: ${owners.map((o) => `${o.kind} ${o.slug} ${(o.c ?? 0).toFixed(2)}`).join(", ")}` : `target: ${first.kind === "agent-x" ? "nothing in the library" : `${first.kind} ${first.slug}`}`,
    ...(voice ? [`voice ${voice.slug ?? "none"} ${voice.confidence.toFixed(2)}`] : []),
    `confidence ${confidence.toFixed(2)} ${confidence >= GATE ? ">=" : "<"} gate ${GATE}`,
  ].join("; ");

  const kind = first.kind === "agent-x" ? "no_match" as const : "decision" as const;
  const decision: AgenticRouteDecision = {
    ok: call.ok || !!named,
    kind,
    primary_business: first.kind === "business" ? first.slug : null,
    mandatory_squads: first.kind === "squad" ? [first.slug!] : [],
    optional_squads: [],
    suggested_mind_clones: clones,
    parts,
    candidates: [],
    rationale: `jev: ${rationale}`,
    runtime: null,
    warnings: [],
    cost_usd: call.cost_usd,
    duration_ms: Math.round(performance.now() - t0),
    ...(call.ok || named ? {} : { error: call.error ?? "the Jev call failed" }),
  };
  return {
    decision, escalate: (!call.ok && !named) || confidence < GATE, gate: GATE, confidence, shape, named, called,
    call: { ok: call.ok, latency_ms: call.latency_ms, input_tokens: call.input_tokens, cost_usd: call.cost_usd, attempts: call.attempts, ...(call.error ? { error: call.error } : {}) },
    recall_ms,
  };
}
