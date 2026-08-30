/* trajectory-card.js — the Trajectory Card ("Cartão de Trajetória" in the
 * product briefing): the single organism that renders a run's event stream,
 * used both in the Chat panel (mode "live", streaming) and the Runs tab
 * (mode "historical", a finished/in-progress run's full timeline). Wave 2
 * redesign briefing §3.3 / §4.2.
 *
 * Before this module, the two surfaces had two independent implementations
 * of "what happened in this run" — the Runs tab checked event names against
 * a 10-name `x-show` chain, the Chat panel used the full `runEventView()`
 * coverage. This module is the fix: both surfaces call `buildTrajectoryRows()`
 * and render the SAME row shape. All labelling still comes from
 * `runEventView()`/`runTimeline()` in run-event-labels.js — this module only
 * groups adjacent events and classifies rows for the three new molecules; it
 * never invents an icon/title/tone of its own.
 *
 * The three molecules this module produces rows for (briefing §3.2; PT-BR
 * names are what the UI actually shows, kept here for traceability):
 *   - Judgement strip ("Faixa de julgamento"): judge_invoked →
 *     critique_generated → revision_dispatched/revision_auto (0..N) →
 *     gate_passed/gate_failed/revision_loop_exhausted, nested as one
 *     collapsible `kind: "judgement"` row.
 *   - Delivery-nuance badge ("Selo de nuance de entrega"): `delivered` /
 *     `x_delivered_with_reservations` / `x_delivery_withheld` rows carry a
 *     `nuance` field (variant + text label, never color alone — WCAG 2.2 AA
 *     1.4.1).
 *   - Runtime-health chip ("Chip de saúde de runtime"): `runtime_auth_failed`
 *     / `runtime_error` / `x_router_failure_cascade` rows carry a
 *     `runtimeChip` field with the hint visible inline, no extra click.
 *
 * Stable identity: every row carries `_seq`, taken from the underlying
 * event's `_seq` (see runTimeline() in run-event-labels.js) — a judgement
 * group's `_seq` is its first atom's, so expand/collapse state keyed by
 * `_seq` survives the infra-events toggle and re-renders.
 *
 * Loaded the same way as run-event-labels.js: a <script type="module">
 * adapter in index.html exposes these exports as window.NirvanaTrajectoryCard,
 * because glance.js is a classic script.
 *
 * Known debt, named rather than fixed here (briefing §3.3 item 2, step 10 of
 * the implementation brief — out of scope for this change): the row list
 * returned here is not virtualized. Fine for the common short run; a
 * multi-hour run with thousands of events will render every row to the DOM.
 */

import { runEventView, runTimeline } from './run-event-labels.js';

const JUDGEMENT_ATOM_EVENTS = new Set(['judge_invoked', 'critique_generated', 'revision_dispatched', 'revision_auto']);
const JUDGEMENT_TERMINAL_EVENTS = new Set(['gate_passed', 'gate_failed', 'revision_loop_exhausted']);
const DELIVERY_NUANCE_EVENTS = new Set(['delivered', 'x_delivered_with_reservations', 'x_delivery_withheld']);
const RUNTIME_HEALTH_EVENTS = new Set(['runtime_auth_failed', 'runtime_error', 'x_router_failure_cascade']);

function eventName(ev) {
  if (!ev) return '';
  if (typeof ev.type === 'string' && ev.type.startsWith('delivery.')) {
    return ev.payload?.legacyEvent || ev.type.slice('delivery.'.length);
  }
  return typeof ev.type === 'string' ? ev.type : (ev.event || '');
}

// The delivery-nuance badge ("Selo de nuance de entrega"): three tones, each
// with its OWN text label — never color alone (WCAG 2.2 AA 1.4.1), matching
// the existing badge pattern
// at index.html's chat badge (tone + x-text side by side).
function deliveryNuance(ev, name) {
  if (name === 'x_delivery_withheld') {
    return {
      variant: 'fail-reversible', label: 'Retido',
      detail: { ceiling: ev.ceiling ?? null, ceiling_reason: ev.ceiling_reason ?? null, gate: ev.gate ?? null, gated_files: ev.gated_files ?? null, revisions: ev.revisions ?? null },
    };
  }
  if (name === 'x_delivered_with_reservations') {
    return {
      variant: 'warn-detail', label: 'Com ressalvas',
      detail: { ceiling: ev.ceiling ?? null, gated_files: ev.gated_files ?? null, revisions: ev.revisions ?? null },
    };
  }
  // Plain `delivered`: gate:"fail-accepted" is the SAME reservations path
  // (x_delivered_with_reservations fires first) — do not show it as a clean
  // pass twice; a bare pass shows the ok variant.
  if (ev.gate === 'fail-accepted') {
    return { variant: 'warn-detail', label: 'Com ressalvas', detail: { gate: ev.gate, files: ev.files ?? null } };
  }
  return { variant: 'ok', label: 'Entregue', detail: { gate: ev.gate ?? null, files: ev.files ?? null } };
}

function toEventRow(ev) {
  const name = eventName(ev);
  const row = { kind: 'event', _seq: ev._seq, view: runEventView(ev) };
  if (DELIVERY_NUANCE_EVENTS.has(name)) row.nuance = deliveryNuance(ev, name);
  if (RUNTIME_HEALTH_EVENTS.has(name)) row.runtimeChip = { runtime: ev.runtime || '', hint: ev.hint || ev.error || '' };
  return row;
}

// Builds the row list for one Trajectory Card. `opts.showInfra` mirrors
// the existing infra-events toggle (infraEventsVisible in glance.js).
export function buildTrajectoryRows(events, opts = {}) {
  const { visible, hidden } = runTimeline(events, !!opts.showInfra);
  const rows = [];
  let i = 0;
  while (i < visible.length) {
    const ev = visible[i];
    if (JUDGEMENT_ATOM_EVENTS.has(eventName(ev))) {
      const items = [ev];
      let j = i + 1;
      while (j < visible.length && JUDGEMENT_ATOM_EVENTS.has(eventName(visible[j]))) { items.push(visible[j]); j++; }
      let terminal = null;
      if (j < visible.length && JUDGEMENT_TERMINAL_EVENTS.has(eventName(visible[j]))) { terminal = visible[j]; j++; }
      rows.push({
        kind: 'judgement', _seq: ev._seq,
        items: items.map(toEventRow),
        terminal: terminal ? toEventRow(terminal) : null,
      });
      i = j;
      continue;
    }
    rows.push(toEventRow(ev));
    i++;
  }
  return { rows, hidden };
}
