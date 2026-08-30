/**
 * panel-layout.js — pure layout-decision helpers for the Runs+Chat page
 * layout redesign (trace glance-page-layout-20260830124732 /
 * glance-page-layout-impl-20260830141256). Kept out of glance.js (a classic
 * script, not a module — see run-event-labels.js/trajectory-card.js for the
 * same reason) so bun:test can exercise the decision logic directly instead
 * of only through a live Alpine app. glance.js reads these through
 * window.NirvanaPanelLayout, the same adapter pattern as the other pure
 * modules in this directory (index.html wires the <script type="module">).
 */

/** Chat panel resize bounds from the approved redesign
 * (page-layout-redesign.md §2.2): 460px compact floor, 920px wide ceiling.
 * Both the mouse-drag handler and the ArrowLeft/ArrowRight keyboard step
 * clamp through clampChatWidth() so neither path can push past them. */
export const CHAT_WIDTH_MIN = 460;
export const CHAT_WIDTH_MAX = 920;

export function clampChatWidth(width) {
  return Math.min(CHAT_WIDTH_MAX, Math.max(CHAT_WIDTH_MIN, width));
}

/** The sidebar collapses to the 64px icon rail exactly when a run is open in
 * detail AND the operator has not pinned the full-width version — never
 * based on which `kind` tab happens to be active (page-layout-redesign.md
 * §1.3: "a lista de 9 ícones... ainda precisa existir"). */
export function shouldCollapseSidebar({ pinnedFull, hasSelectedRun }) {
  return !pinnedFull && !!hasSelectedRun;
}

/** Runs-list rail filter: matches the free-text query against the same
 * fields already shown on the card (brief, business, squad), case-
 * insensitively. An empty/whitespace query returns the list unchanged. */
export function filterRunsByQuery(runs, query) {
  const q = (query || '').trim().toLowerCase();
  if (!q) return runs || [];
  return (runs || []).filter((r) =>
    `${r.brief || ''} ${r.business_slug || ''} ${r.squad_name || ''}`.toLowerCase().includes(q)
  );
}

/** "Atividade relacionada" strip inside run-detail: activity events scoped
 * to the open run's business_slug/project_id, excluding events already on
 * this run's own trace (those are already the Trajectory Card above it). */
export function filterRelatedActivity(events, run) {
  if (!run) return [];
  return (events || []).filter((e) => {
    if (e.trace_id === run.trace_id) return false;
    if (run.business_slug && e.business_slug === run.business_slug) return true;
    if (run.project_id && e.project_id === run.project_id) return true;
    return false;
  });
}
