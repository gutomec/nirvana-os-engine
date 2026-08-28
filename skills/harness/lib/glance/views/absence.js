/* absence.js — the one place that decides how the cockpit shows "I could not
 * determine this".
 *
 * The defect this module exists to prevent: the cockpit read an absent source of
 * truth and rendered "Projects 0". Zero is a measurement. A reader acts on it —
 * cleans up, re-dispatches, concludes the run never started — and the panel had
 * measured nothing at all. Saying nothing is honest; saying zero is not.
 *
 * The contract, both directions:
 *   · the API answers `null`  ⇒ undetermined ⇒ the view renders `—`
 *   · the API answers `[]`/`0` ⇒ a real, measured absence ⇒ the view renders the number
 *
 * Pure ES module with no dependencies. `bun test` imports it directly; the page
 * loads it through a `<script type="module">` adapter in index.html that exposes
 * the exports as `window.NirvanaAbsence`, because glance.js is a classic script
 * (the same pattern as run-event-labels.js and settings-panel.js).
 */

/** What the view shows where a number cannot be shown. */
export const UNKNOWN_LABEL = '—';

/** `null`/`undefined` mean undetermined. Everything else, including 0 and [], is a measurement. */
export function isUnknown(value) {
  return value === null || value === undefined;
}

/** A count for the eye: the number when it was measured, `—` when it was not. */
export function countLabel(value) {
  return isUnknown(value) ? UNKNOWN_LABEL : String(value);
}

/**
 * The length of a list the API may not have been able to determine.
 *
 * `(list || []).length` is how `null` became `0` in the panel: the fallback
 * invents an empty measurement out of a missing one. This keeps the distinction
 * alive so countLabel can render it.
 */
export function listLength(list) {
  return isUnknown(list) ? null : list.length;
}

/** A list to iterate over. Undetermined and empty both render no rows; only the count differs. */
export function listItems(list) {
  return isUnknown(list) ? [] : list;
}
