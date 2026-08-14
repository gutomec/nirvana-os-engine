/**
 * corpusGate — one place where a test says "I need the paid library, and here is
 * what I found instead".
 *
 * Five suites route real briefs through the installed content library and skip
 * themselves when it is absent. That is the right call: the engine ships no
 * content, so CI has nothing to route against. What was wrong is that they
 * skipped in silence. Bun prints a skipped test without failing, so in the CI
 * log a suite that never ran looks exactly like a suite that passed — and one of
 * them held a stale expectation for four days while every run was green.
 *
 * This makes the skip say so, once per file, with the numbers that decided it.
 * It also stamps NIRVANA_CORPUS_SKIPPED so a workflow step can tell the
 * difference between "the corpus tests passed" and "there was no corpus".
 */
export function corpusGate(
  label: string,
  ok: boolean,
  found: Record<string, number | string | boolean | null>,
): typeof describe | typeof describe.skip {
  if (!ok) {
    const detail = Object.entries(found).map(([k, v]) => `${k}=${v}`).join(" ");
    console.warn(`[corpus-gate] SKIPPED ${label} — no full content library (${detail})`);
    const prev = process.env.NIRVANA_CORPUS_SKIPPED;
    process.env.NIRVANA_CORPUS_SKIPPED = prev ? `${prev},${label}` : label;
  }
  return ok ? describe : describe.skip;
}

// Imported lazily so the helper works under `bun test` without the caller having
// to thread `describe` in. bun:test is always present in that context.
import { describe } from "bun:test";
