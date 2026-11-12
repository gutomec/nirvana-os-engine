// jev-voice.ts — the Jev's voice question: which of these people, if any, the
// request points to.
//
// The lexical search finds a clone by the words it declares, so a request that
// describes a person ("o autor de Rápido e Devagar", "o criador da Ethereum")
// or that never names one reaches the wrong clone or none. The Jev reads the
// candidates' one_liner, domains and refusals and answers with a probability;
// measured on 48 requests (2026-10-13): Vitalik at 0.99 for "o criador da
// Ethereum", "none" at 0.97 and 1.0 for two people the library does not have,
// and one voice offered in 40 requests that asked for none.
//
// Used by the --auto decider (jev-router.ts) and, as `rerank`, by the voice
// selection of a business or squad run (clone-voices.ts). Only when the Jev is
// enabled (typesafe-client.ts jevEnabled): a TypeSafe key and routing.jev on.

import { choiceOf, jevCallSync, type Criterion, type JevQuestion, type KeyLookup } from "../../_shared/lib/typesafe-client.ts";
import type { VoiceRerank } from "./clone-voices.ts";

/** A voice nobody named needs this much confidence. Fixed by the 2026-10-13 measurement. */
export const VOICE = 0.5;
/** Candidates one voice question carries at most: the Jev's latency grows with its input. */
export const MAX_VOICE_CANDIDATES = 16;
export const NONE = "none";

const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String).filter(Boolean) : typeof v === "string" && v.trim() ? [v] : []);
const flat = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim();
export const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);

/** What a clone is, in the object form the Jev reads best: what, not_for. */
export function cloneCriterion(slug: string, registry: Record<string, any>): Criterion {
  const c = registry[slug] ?? {};
  const m = c.match ?? {};
  const notFor = [...list(m.not_for), ...list(m.refuses)].slice(0, 4).map(flat).join("; ");
  return {
    what: clip(`${flat(c.display_name || slug)}: ${flat(m.one_liner)} Domains: ${list(m.domains).slice(0, 8).join(", ")}.`, 600),
    ...(notFor ? { not_for: clip(notFor, 300) } : {}),
  };
}

export function voiceQuestion(candidates: string[], registry: Record<string, any>): JevQuestion {
  return {
    type: "choice",
    instructions: "Does the request ask for, or clearly imply, the method or voice of one of these specific people (named, described, or as the obvious authority the request points to)? Choose none unless one of them is clearly implied.",
    criteria: { ...Object.fromEntries(candidates.map((x) => [x, cloneCriterion(x, registry)])), [NONE]: "The request does not point to any of these people." },
  };
}

/** The voice the answer gives: a candidate at or above VOICE, else none. */
export function readVoice(answers: Record<string, any> | undefined, candidates: string[], key = "voice"): { slug: string | null; confidence: number } | null {
  const a = choiceOf(answers, key);
  if (!a) return null;
  if (a.choice === NONE || !candidates.includes(a.choice) || a.confidence < VOICE) return { slug: null, confidence: a.confidence };
  return { slug: a.choice, confidence: a.confidence };
}

/**
 * The rerank a business or squad run hands selectVoices: one synchronous Jev
 * call over the candidates. `ok: false` (no answer, an error) lets the lexical
 * search decide as before.
 */
export function jevVoiceRerank(registry: Record<string, any>, opts: KeyLookup & { timeoutMs?: number; call?: typeof jevCallSync } = {}): VoiceRerank {
  return (candidates, request) => {
    const cands = candidates.filter((s) => registry[s]).slice(0, MAX_VOICE_CANDIDATES);
    if (!cands.length) return { ok: false, slug: null };
    const call = (opts.call ?? jevCallSync)(request, { voice: voiceQuestion(cands, registry) }, opts);
    if (!call.ok) return { ok: false, slug: null, error: call.error };
    const v = readVoice(call.answers, cands);
    if (!v) return { ok: false, slug: null, error: "the answer has no voice choice" };
    return { ok: true, slug: v.slug, confidence: v.confidence };
  };
}
