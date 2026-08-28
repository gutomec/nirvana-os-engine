/* subsystem-row.js — the engine row: which subsystems are standing.
 *
 * Turns /api/subsystems into cells. It decides nothing about health; the server
 * measured that. What it decides is how the three possible readings look, and
 * the third one is the point: a subsystem whose health could not be determined
 * shows `—`, never a green dot. Inventing a light is the same defect as
 * reporting an absent directory as zero projects (see absence.js).
 *
 * Pure ES module with no dependencies, loaded through the module adapter in
 * index.html as window.NirvanaSubsystemRow, like run-event-labels.js.
 */

import { UNKNOWN_LABEL, isUnknown, listItems } from './absence.js';

/** The dot's modifier class per reading. `unknown` is styled as absence, not as a state. */
export function statusClass(status) {
  if (status === 'up') return 'subsystem-dot-up';
  if (status === 'down') return 'subsystem-dot-down';
  return 'subsystem-dot-unknown';
}

/** The glyph beside the label: a dot for a measured reading, an em dash for none. */
export function statusGlyph(status) {
  return isUnknown(status) ? UNKNOWN_LABEL : '●';
}

/** One line of words for the reading, for the screen reader and the tooltip. */
export function statusWord(status) {
  if (status === 'up') return 'de pé';
  if (status === 'down') return 'fora';
  return 'não determinado';
}

/** The tooltip: what was read, and where it was read from. */
export function cellTitle(subsystem) {
  const parts = [`${subsystem.label}: ${statusWord(subsystem.status)}`];
  if (subsystem.detail) parts.push(subsystem.detail);
  if (subsystem.source) parts.push(subsystem.source);
  return parts.join(' · ');
}

/** The payload as cells, plus the tally the header shows. */
export function buildSubsystemRow(payload) {
  const cells = listItems(payload && payload.subsystems).map((subsystem) => ({
    ...subsystem,
    statusClass: statusClass(subsystem.status),
    glyph: statusGlyph(subsystem.status),
    word: statusWord(subsystem.status),
    title: cellTitle(subsystem),
  }));
  return {
    cells,
    up: cells.filter((c) => c.status === 'up').length,
    down: cells.filter((c) => c.status === 'down').length,
    unknown: cells.filter((c) => isUnknown(c.status)).length,
  };
}

/** `5/8 de pé` — and it never counts an undetermined cell as either side. */
export function rowSummary(row) {
  if (!row.cells.length) return UNKNOWN_LABEL;
  const summary = `${row.up}/${row.cells.length} de pé`;
  return row.unknown ? `${summary} · ${row.unknown} sem sinal` : summary;
}
