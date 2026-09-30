// seat-attribution.ts — which seat of a business a runtime subagent was working as.
//
// A business session (execution.business_mode: session) runs the seats as the
// runtime's own subagents. The engine does not spawn them, so it cannot stamp a
// dispatch per seat the way the chain does. What it can see, on a runtime with
// hooks, is each subagent call: the hook hands over the call's input, and the
// session brief tells the business to start every seat's prompt with that
// seat's file. This module turns that input into a seat, or into "unknown" when
// the input does not say which seat it was. A wrong seat would credit work to
// someone who did not do it, so an ambiguous call stays unattributed.
//
// Kept free of heavy imports: the hook loads it on every subagent call.

export interface SeatRef {
  slug: string;
  /** Absolute path of the seat's file (`<business>/employees/<seat>.md`). */
  file: string;
}

export interface SeatAttribution {
  seat: string | null;
  /** How the seat was recognized: its file path, the subagent type, or its slug. */
  by: "file" | "type" | "slug" | null;
  /** Seats the input named when it named more than one and none by file. */
  candidates?: string[];
}

function posix(p: string): string { return (p || "").replace(/\\/g, "/"); }

function escapeRegExp(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

/**
 * The seat a subagent call worked as, read from the call's own input.
 *
 * In order: a seat file path in the text (the earliest one, since the brief puts
 * the seat's own file first), a subagent type equal to a seat slug, and a slug
 * named on its own. More than one slug and no file leaves the call unattributed.
 */
export function attributeSeat(input: Record<string, unknown> | null | undefined, seats: SeatRef[]): SeatAttribution {
  const text = posix([input?.subagent_type, input?.description, input?.prompt, input?.message, input?.task_name]
    .filter((v): v is string => typeof v === "string").join("\n"));
  if (!text || !seats.length) return { seat: null, by: null };

  let first: { slug: string; at: number } | null = null;
  for (const s of seats) {
    const file = posix(s.file);
    // The full path, or the part a model is likely to keep when it shortens one.
    const tail = file.split("/").slice(-2).join("/");
    const at = [text.indexOf(file), tail ? text.indexOf(tail) : -1].filter((i) => i >= 0).sort((a, b) => a - b)[0];
    if (at !== undefined && (!first || at < first.at)) first = { slug: s.slug, at };
  }
  if (first) return { seat: first.slug, by: "file" };

  const type = typeof input?.subagent_type === "string" ? input.subagent_type.trim() : "";
  const byType = seats.find((s) => s.slug === type);
  if (byType) return { seat: byType.slug, by: "type" };

  const named = seats.filter((s) => new RegExp(`(^|[^A-Za-z0-9_-])${escapeRegExp(s.slug)}([^A-Za-z0-9_-]|$)`).test(text));
  if (named.length === 1) return { seat: named[0].slug, by: "slug" };
  return named.length ? { seat: null, by: null, candidates: named.map((s) => s.slug) } : { seat: null, by: null };
}
