// brief-excerpt.js — CommonJS home of the one bounded form of a brief that
// is allowed onto an audit event.
//
// Lives here, not in brief-excerpt.ts, so a CJS module can `require()` it
// without crossing into ESM: Bun classifies a required `.ts`/ESM module as
// async, and only the Windows runner enforces that classification as a hard
// error (see cloudevents.js, the first caller this broke). brief-excerpt.ts
// re-exports these two values for the many ESM importers that already
// reference it — that direction (ESM `import` of a CJS module) never crosses
// the broken boundary, on any platform.
//
// Two defects meet here. The audit log is appended thousands of times a day
// (measured 2026-08-28: 5250 events / 2.05 MB in ~/.harness-logs alone, 390
// bytes per event on average), so a field carrying a whole brief — sometimes
// thousands of characters — grows the file without a ceiling. The answer used
// on most emitters was to send `brief_chars` instead, a number, and the run
// card that reads it has nothing to show. Neither is right: the card needs
// text, the log needs a bound.
//
// The cap is measured, not guessed. Across both audit roots over 2026-08-22..28,
// 163 `brief_received` events: p50 83 chars, p90 176, p99 221, max 357. At 300
// the excerpt carries better than 99% of real briefs whole, bounds the worst
// case at roughly 0.8× the average event, and still overflows one card line —
// which truncates in CSS anyway.
//
// `brief_chars` stays beside it and keeps carrying the TRUE length, so a reader
// can always tell an excerpt from a whole brief.

'use strict';

/** Hard ceiling, in characters, for any brief text on an audit event. */
const BRIEF_EXCERPT_MAX = 300;

/**
 * The bounded, single-line form of a brief.
 *
 * Returns `null` when there is nothing to show — absence, which a reader renders
 * as `—`, is not the same as an empty string it would render as blank.
 */
function briefExcerpt(brief, max) {
  if (max === undefined) max = BRIEF_EXCERPT_MAX;
  if (typeof brief !== 'string') return null;
  // A brief is markdown: newlines, indentation, run-on spacing. The card shows
  // one line, so collapse here rather than in every reader.
  const flat = brief.replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  if (flat.length <= max) return flat;
  // The ellipsis counts against the cap: the field is never longer than `max`.
  return flat.slice(0, max - 1) + '…';
}

module.exports = { BRIEF_EXCERPT_MAX, briefExcerpt };
