/* run-event-labels.js — single source of truth for the Glance run timeline.
 *
 * Pure ES module with no dependencies. `bun test` imports it directly; the
 * page loads it through a `<script type="module">` adapter in index.html that
 * exposes the exports as `window.NirvanaRunEventLabels`, because glance.js is
 * a classic script. Canonical Run Kernel events resolve by `ev.type`; legacy
 * audit events resolve by `ev.event`. UI strings are English.
 */

const usd = (value) => (value != null && Number.isFinite(Number(value)) ? `$${Number(value).toFixed(2)}` : '');
const join = (...parts) => parts.filter(Boolean).join(' · ');
const shortDigest = (digest) => (digest ? String(digest).slice(0, 8) : '');
const label = (map, value, fallback = '') => (value == null || value === '' ? fallback : (map[value] || String(value)));
const targetName = (target) => (target ? (target.slug || target.id || target.kind || '') : '');

const RUN_STATE_LABELS = {
  prepared: 'prepared', running: 'running', waiting: 'waiting', verifying: 'verifying', revising: 'revising',
  cancelling: 'cancelling', rolled_back: 'rolled back', completed: 'completed', withheld: 'withheld',
  delivered_with_reservations: 'delivered with reservations', cancelled: 'cancelled', failed: 'failed', abandoned: 'abandoned',
};
const RUN_STATE_TONES = {
  completed: 'ok', delivered_with_reservations: 'ok', running: 'active', verifying: 'active', revising: 'active',
  withheld: 'fail', cancelled: 'fail', failed: 'fail', rolled_back: 'fail', abandoned: 'fail',
};
const GAUNTLET_DECISION_LABELS = { delivered: 'deliver', withheld: 'withhold', reservations: 'deliver with reservations' };
const GAUNTLET_DECISION_TONES = { delivered: 'ok', withheld: 'fail', reservations: 'active' };
const GAUNTLET_STOP_REASON_LABELS = {
  success: 'success', max_rounds: 'round limit', max_cost: 'cost limit', max_duration: 'duration limit',
  no_progress: 'no progress', critical_regression: 'critical regression', judge_disagreement: 'judges disagreed',
  human_required: 'human required', execution_failure: 'execution failure',
};
// judge.ts's own verdict is the narrower {pass, fail} — shares this map with
// the canonical Gauntlet evaluation verdict (superset), which never emits 'fail'.
const VERDICT_LABELS = { pass: 'approved', revise: 'revise', reject: 'rejected', indeterminate: 'indeterminate', fail: 'failed' };
const VERDICT_TONES = { pass: 'ok', revise: 'active', reject: 'fail', fail: 'fail' };
const PLAN_STATE_LABELS = { ready: 'ready', running: 'running', delivered: 'delivered', withheld: 'withheld', failed: 'failed' };
const PLAN_STATE_TONES = { delivered: 'ok', running: 'active', withheld: 'fail', failed: 'fail' };
// How the target of a Run was decided (`payload.route` of `run.prepared`, or of
// `x_run_route_resolved` when the queue routed the Message after preparing the Run).
const ROUTE_SOURCE_LABELS = { explicit: 'target named in the Message', router: 'chosen by the router', fallback: 'agent-x by fallback' };
export const routeSourceLabel = (route) => (route ? label(ROUTE_SOURCE_LABELS, route.source) : '');
const routeInfo = (route) => (route ? join(routeSourceLabel(route), route.rationale) : '');

// Legacy run ledger (x_ledger_* audit events). A withheld row keeps the
// supervisor's reason in last_error when it got there through a stall, and
// carries none when the gate withheld it — the subtitle tells the two apart.
const LEDGER_STATE_LABELS = {
  dispatched: 'dispatched', running: 'running', verifying: 'verifying', gated: 'at the gate', delivered: 'delivered',
  withheld: 'withheld', stalled: 'stalled', failed: 'failed', abandoned: 'abandoned',
};
const LEDGER_STATE_ICONS = { delivered: 'check-circle-2', withheld: 'pause-circle', stalled: 'alert-triangle', failed: 'x-circle' };
const LEDGER_STATE_TONES = { delivered: 'ok', withheld: 'fail', stalled: 'fail', failed: 'fail' };
const LIVENESS_SOURCE_LABELS = {
  heartbeat: 'explicit heartbeat', child_run: 'squad or employee dispatched', child_delivered: 'child delivery just completed',
  hook_activity: 'trace hook activity', file_activity: 'file activity',
};
function ledgerReason(ev) {
  const reason = ev.error || ev.last_error;
  if (reason) return String(reason);
  return ev.to === 'withheld' ? 'withheld by the gate' : '';
}

// Node events carry the full node projection in `payload.node`; the target kind
// (business, squad, agent-x, synthesis, support) follows the wave when present.
function nodeView(ev, icon, verb, tone, detail) {
  const node = ev.payload?.node || {};
  const wave = node.waveIndex != null ? `wave ${node.waveIndex + 1}` : '';
  return { icon, title: `Node ${node.nodeId || ev.payload?.nodeId || '?'} ${verb}`, sub: join(wave, node.targetKind, ...detail(node)), tone };
}
function leaseView(ev, icon, verb, tone = '') {
  const p = ev.payload || {};
  return { icon, title: `Lease of ${p.nodeId || '?'} ${verb}`, sub: join(p.ownerId, p.version != null ? `v${p.version}` : '', p.reason), tone };
}
// Child-process events carry the pid and the attempt number of that child.
function childInfo(p) {
  const payload = p || {};
  return join(payload.pid != null ? `pid ${payload.pid}` : '', payload.attempt != null ? `attempt ${payload.attempt}` : '');
}
function candidateView(ev, icon, verb) {
  const p = ev.payload || {};
  return { icon, title: `Candidate ${p.candidateId || '?'} ${verb}`, sub: join(p.revision != null ? `r${p.revision}` : '', targetName(p.producer), p.artifactRefs?.length ? `${p.artifactRefs.length} artifacts` : ''), tone: 'active' };
}

// Canonical Run Kernel events, keyed by `ev.type`. Every type emitted by the
// engine must be listed here; the test suite enforces the list.
const CANONICAL = {
  'run.prepared': (ev) => { const t = ev.payload?.target; return { icon: 'inbox', title: `Run prepared → ${targetName(t) || 'target'}`, sub: join(t?.kind, t?.capabilityId, routeInfo(ev.payload?.route)), tone: '' }; },
  'x_run_route_resolved': (ev) => { const t = ev.payload?.target; return { icon: 'compass', title: `Target resolved → ${targetName(t) || 'target'}`, sub: join(t?.kind, t?.capabilityId, routeInfo(ev.payload?.route)), tone: 'active' }; },
  'run.transitioned': (ev) => { const p = ev.payload || {}; return { icon: p.to === 'completed' ? 'party-popper' : 'arrow-right-circle', title: `Run ${label(RUN_STATE_LABELS, p.to, 'transitioned')}`, sub: p.from && p.to ? `${p.from} → ${p.to}` : '', tone: RUN_STATE_TONES[p.to] || '' }; },
  'runtime.selection_snapshot': (ev) => { const s = ev.payload?.snapshot || {}; return { icon: 'cpu', title: `Runtime: ${s.runtime?.id || 'unknown'}`, sub: join(s.provider?.id, s.model?.id), tone: '' }; },
  'gauntlet.plan_compiled': (ev) => { const p = ev.payload || {}; return { icon: 'clipboard-list', title: p.plan?.intensity ? `Gauntlet plan ${p.plan.intensity}` : 'Gauntlet plan', sub: join(p.state, label(GAUNTLET_STOP_REASON_LABELS, p.stopReason)), tone: '' }; },
  'gauntlet.candidate_created': (ev) => candidateView(ev, 'file-plus-2', 'created'),
  'gauntlet.candidate_revised': (ev) => candidateView(ev, 'file-diff', 'revised'),
  'gauntlet.evaluation_recorded': (ev) => { const p = ev.payload || {}; return { icon: 'clipboard-check', title: `Evaluation: ${label(VERDICT_LABELS, p.verdict, 'recorded')}`, sub: join(p.gauntletId, targetName(p.evaluator), usd(p.costUsd)), tone: VERDICT_TONES[p.verdict] || '' }; },
  'gauntlet.round_started': (ev) => { const p = ev.payload || {}; const reserved = p.costReservedUsd ?? p.expectedCostUsd; return { icon: 'play-circle', title: `Round ${p.round ?? '?'} started`, sub: reserved != null ? `reserved ${usd(reserved)}` : '', tone: 'active' }; },
  'gauntlet.round_evaluated': (ev) => { const p = ev.payload || {}; return { icon: 'activity', title: `Round ${p.round ?? '?'} evaluated`, sub: join(p.score != null ? `score ${p.score}` : '', p.improved ? 'improved' : '', p.regressions?.length ? `${p.regressions.length} regressions` : '', p.blockingFailure ? 'blocking failure' : ''), tone: p.blockingFailure ? 'fail' : 'ok' }; },
  'gauntlet.revision_requested': (ev) => { const n = ev.payload?.revisionRequests?.length || 0; return { icon: 'rotate-ccw', title: 'Revision requested', sub: n ? `${n} requests` : '', tone: 'active' }; },
  'gauntlet.regression_started': () => ({ icon: 'flask-conical', title: 'Regression started', sub: '', tone: 'active' }),
  'gauntlet.stopped': (ev) => { const p = ev.payload || {}; return { icon: 'flag', title: `Gauntlet stopped: ${label(GAUNTLET_DECISION_LABELS, p.decision, 'no decision')}`, sub: join(label(GAUNTLET_STOP_REASON_LABELS, p.reason), p.reservations?.length ? `${p.reservations.length} reservations` : '', p.finalQualityGateRequired ? 'final gate pending' : ''), tone: GAUNTLET_DECISION_TONES[p.decision] || '' }; },
  'canary.recovery_enqueued': (ev) => ({ icon: 'refresh-cw', title: 'Recovery enqueued', sub: ev.payload?.reason || '', tone: 'active' }),
  'canary.recovery_skipped': (ev) => ({ icon: 'skip-forward', title: 'Recovery skipped', sub: ev.payload?.reason || '', tone: '' }),
  'canary.recovery_reattached': (ev) => ({ icon: 'link', title: 'Recovery reattached to the process', sub: childInfo(ev.payload), tone: 'active' }),
  'canary.recovery_redispatched': (ev) => ({ icon: 'refresh-cw', title: 'Recovery redispatched', sub: join(childInfo(ev.payload), ev.payload?.reason), tone: 'active' }),
  'glance.child_started': (ev) => ({ icon: 'terminal-square', title: 'Child process started', sub: childInfo(ev.payload), tone: 'active' }),
  'glance.child_exited': (ev) => { const p = ev.payload || {}; const code = p.exitCode; return { icon: code === 0 ? 'check-circle-2' : 'x-circle', title: 'Child process exited', sub: join(childInfo(p), code == null ? 'no exit code' : `exit ${code}`), tone: code === 0 ? 'ok' : (code == null ? '' : 'fail') }; },
  'glance.child_killed': (ev) => ({ icon: 'ban', title: 'Child process killed', sub: join(childInfo(ev.payload), ev.payload?.signal), tone: 'fail' }),
  'multi_target.snapshots_bound': (ev) => ({ icon: 'link', title: 'Multi-target plan bound', sub: join(shortDigest(ev.payload?.planDigest), shortDigest(ev.payload?.reservationDigest)), tone: '' }),
  'multi_target.snapshot_saved': (ev) => { const s = ev.payload?.snapshot || {}; return { icon: 'save', title: `Snapshot v${s.version ?? '?'} saved`, sub: join(label(PLAN_STATE_LABELS, s.state), s.currentWave >= 0 ? `wave ${s.currentWave + 1}` : ''), tone: '' }; },
  'multi_target.node_started': (ev) => nodeView(ev, 'play', 'started', 'active', (n) => [n.mode, n.grantedCostUsd ? `granted ${usd(n.grantedCostUsd)}` : '']),
  'multi_target.node_delivered': (ev) => nodeView(ev, 'check-circle-2', 'delivered', 'ok', (n) => [usd(n.reportedCostUsd) ? `reported ${usd(n.reportedCostUsd)}` : '']),
  'multi_target.node_withheld': (ev) => nodeView(ev, 'pause-circle', 'withheld', 'fail', (n) => [n.reason]),
  'multi_target.node_failed': (ev) => nodeView(ev, 'x-circle', 'failed', 'fail', (n) => [n.reason]),
  'multi_target.node_skipped': (ev) => nodeView(ev, 'skip-forward', 'skipped', 'fail', (n) => [n.blockedBy?.length ? `blocked by ${n.blockedBy.join(', ')}` : n.reason]),
  'multi_target.node_stalled': (ev) => nodeView(ev, 'alert-triangle', 'stalled', 'fail', (n) => [n.reason]),
  'multi_target.support_completed': (ev) => nodeView(ev, 'check', 'support completed', 'ok', () => []),
  'multi_target.budget_exceeded': (ev) => nodeView(ev, 'ban', 'exceeded the budget', 'fail', (n) => [n.reason]),
  'multi_target.lease_claimed': (ev) => leaseView(ev, 'lock', 'claimed'),
  'multi_target.lease_renewed': (ev) => leaseView(ev, 'timer-reset', 'renewed'),
  'multi_target.lease_released': (ev) => leaseView(ev, 'unlock', 'released'),
  'multi_target.lease_lost': (ev) => leaseView(ev, 'alert-triangle', 'lost', 'fail'),
  'multi_target.plan_terminal': (ev) => { const p = ev.payload || {}; return { icon: 'flag-triangle-right', title: `Multi-target plan ${label(PLAN_STATE_LABELS, p.state, 'ended')}`, sub: p.reason || '', tone: PLAN_STATE_TONES[p.state] || '' }; },
};

export const CANONICAL_EVENT_TYPES = Object.freeze(Object.keys(CANONICAL));

// High-frequency infrastructure events: kept in the stream, hidden from the
// timeline until the user toggles them (see runTimeline).
export const INFRA_EVENT_TYPES = Object.freeze(['multi_target.snapshot_saved', 'multi_target.lease_renewed']);

// Legacy audit events (`ev.event`): the golden 5 + the rest.
const LEGACY_SHORT_LABELS = {
  agentic_route_decision: 'Routed', dispatch_business: 'Dispatched business', dispatch_squad: 'Dispatched squad',
  mind_clone_injected: 'Injected mind-clone', agent_executed: 'Executed', gate_passed: 'Passed the gate',
  gate_failed: 'Failed the gate', delivered: 'Delivered', routing_rule_applied: 'Runtime rule',
  team_chain_selected: 'Assembled the team', research_completed: 'Researched', brief_received: 'Received the brief',
};

export function chatEventLabel(ev) {
  const event = ev || {};
  return LEGACY_SHORT_LABELS[event.event] || event.event || event.type || 'event';
}

function legacyRunEventView(ev) {
  const biz = ev.business_slug, sq = ev.squad_slug || ev.squad_name;
  const cost = ev.cost_usd != null ? `$${Number(ev.cost_usd).toFixed(2)}` : '';
  const dur = ev.duration_ms != null ? `${(ev.duration_ms / 1000).toFixed(0)}s` : '';
  const rt = ev.runtime ? String(ev.runtime).replace('claude-code', 'claude') : '';
  const step = (ev.step && ev.total) ? `step ${ev.step}/${ev.total}` : '';
  const sub = (...xs) => xs.filter(Boolean).join(' · ');
  const M = {
    brief_received:       { icon: 'inbox', title: 'Brief received', tone: '' },
    brief_amplified:      { icon: 'sparkles', title: 'Brief amplified', tone: '' },
    agentic_route_decision:{ icon: 'compass', title: `Routed → ${biz || ev.primary_business || '?'}`, sub: ev.rationale || ev.method || '', tone: 'active' },
    auto_route_selected:  { icon: 'compass', title: `Routed → ${biz || '?'}`, sub: ev.method || '', tone: 'active' },
    routing_rule_applied: { icon: 'settings-2', title: `Runtime rule → ${ev.runtime || ''}`, tone: '' },
    dispatch_business:    { icon: 'building-2', title: `${biz || 'business'} took over`, tone: 'active' },
    dispatch_squad:       { icon: 'users', title: `squad ${sq || ''}`, tone: 'active' },
    mind_clone_injected:  { icon: 'brain', title: `Mind-clone: ${ev.clone || ev.dna || ev.slug || ev.file || 'persona'}`, tone: '' },
    team_chain_selected:  { icon: 'link', title: 'Team assembled', sub: sub(biz), tone: '' },
    agent_executed:       { icon: 'bot', title: ev.employee || 'agent', sub: sub(step, rt, cost, dur), tone: 'ok' },
    agent_exec_failed:    { icon: 'alert-triangle', title: `${ev.employee || 'agent'} failed`, tone: 'fail' },
    tool_invoked:         { icon: 'wrench', title: ev.tool || 'tool', tone: '' },
    bash_completed:       { icon: 'terminal-square', title: 'command', tone: '' },
    ask_invoked:          { icon: 'message-circle-question', title: `consulted ${ev.clone || 'mind-clone'}`, tone: '' },
    verify_passed:        { icon: 'check-circle-2', title: 'Verification passed', tone: 'ok' },
    verify_failed:        { icon: 'x-circle', title: 'Verification failed', tone: 'fail' },
    gate_passed:          { icon: 'shield-check', title: 'Gate passed', sub: (ev.rubrics || []).join(', '), tone: 'ok' },
    report_html_generated:{ icon: 'file-text', title: 'HTML generated', tone: '' },
    report_pdf_generated: { icon: 'file-text', title: 'PDF generated', tone: '' },
    delivered:            { icon: 'party-popper', title: 'Delivered', tone: 'ok' },
    // Judgement strip: judge_invoked → critique_generated → revision_* (0..N) → gate_*/revision_loop_exhausted.
    judge_invoked:        { icon: 'gavel', title: `Judging: ${ev.rubric_name || 'rubric'}`, sub: sub(ev.target_model, ev.pass_threshold != null ? `floor ${ev.pass_threshold}` : ''), tone: 'active' },
    critique_generated:   { icon: 'gavel', title: `Verdict: ${ev.schema_valid === false ? 'invalid schema' : label(VERDICT_LABELS, ev.verdict, 'generated')}`, sub: sub(ev.total_score != null ? `score ${ev.total_score}` : '', ev.critique_count != null ? `${ev.critique_count} findings` : ''), tone: ev.schema_valid === false ? 'fail' : (VERDICT_TONES[ev.verdict] || 'active') },
    revision_dispatched:  { icon: 'rotate-ccw', title: `Revision dispatched · attempt ${ev.attempt_index ?? '?'}`, sub: sub(ev.previous_score != null ? `previous score ${ev.previous_score}` : '', ev.priority_items ? `${ev.priority_items} priority items` : ''), tone: 'active' },
    revision_auto:        { icon: 'refresh-cw', title: `Auto-revision${ev.attempt != null ? ' ' + ev.attempt : ''}`, sub: ev.ok === false ? 'failed' : '', tone: ev.ok === false ? 'fail' : 'active' },
    revision_loop_exhausted: { icon: 'flag', title: 'Revision loop exhausted', sub: sub(ev.total_revisions != null ? `${ev.total_revisions} revisions` : '', ev.final_score != null ? `final score ${ev.final_score}` : '', ev.reason), tone: 'fail' },
    // Runtime cascade: unavailable/error/transient are why the system handed off (runtime_handoff already labelled).
    runtime_handoff:      { icon: 'refresh-cw', title: `Switched runtime → ${ev.to || ev.runtime || ''}`, tone: '' },
    runtime_quota_exhausted: { icon: 'ban', title: 'Quota exhausted', tone: 'fail' },
    runtime_auth_failed:  { icon: 'key-round', title: `Authentication failed: ${ev.runtime || ''}`, sub: ev.hint || '', tone: 'fail' },
    runtime_unavailable:  { icon: 'power-off', title: `Runtime unavailable: ${ev.runtime || ''}`, tone: 'fail' },
    runtime_error:        { icon: 'alert-triangle', title: `Runtime error: ${ev.runtime || ''}`, sub: ev.hint || '', tone: 'fail' },
    runtime_transient_retry: { icon: 'refresh-cw', title: `Retrying: ${ev.runtime || ''}`, sub: sub(ev.sleep_ms != null ? `${Math.round(ev.sleep_ms / 1000)}s` : '', ev.hint), tone: 'active' },
    cascade_exhausted:    { icon: 'ban', title: 'Cascade exhausted', tone: 'fail' },
    x_router_failure_retry:       { icon: 'refresh-cw', title: 'Router: retrying', sub: ev.error || '', tone: 'active' },
    x_router_failure_fail_policy: { icon: 'ban', title: 'Router: failure policy triggered', sub: ev.error || '', tone: 'fail' },
    x_router_failure_cascade:     { icon: 'alert-triangle', title: `Router fell back to ${ev.stage || '?'}`, sub: sub(ev.picked, ev.error), tone: 'fail' },
    // Delivery nuance: withheld/reservations carry the WHY that a plain `delivered` badge hides.
    x_delivery_withheld:  { icon: 'pause-circle', title: 'Delivery withheld', sub: sub(ev.ceiling === 'completeness' ? ev.ceiling_reason : `gate: ${ev.gate || ''}`, ev.gated_files != null ? `${ev.gated_files} file(s) at the gate` : ''), tone: 'fail' },
    x_delivered_with_reservations: { icon: 'shield-alert', title: 'Delivered with reservations', sub: sub(ev.revisions != null ? `${ev.revisions} revisions` : '', ev.ceiling != null ? `ceiling ${ev.ceiling}` : ''), tone: 'active' },
    // Ledger terminal/live states not already covered by x_ledger_state_changed.
    x_ledger_abandoned:   { icon: 'x-octagon', title: 'Ledger: run abandoned', sub: sub(ev.from, ev.reason), tone: 'fail' },
    x_ledger_stall_observed: { icon: 'alert-triangle', title: 'Run stalled (heartbeat)', sub: ev.gap_ms != null ? `no activity for ${Math.round(ev.gap_ms / 1000)}s` : '', tone: 'fail' },
    x_ledger_state_changed: { icon: LEDGER_STATE_ICONS[ev.to] || 'arrow-right-circle', title: `Ledger: ${label(LEDGER_STATE_LABELS, ev.to, 'transitioned')}`, sub: ledgerReason(ev), tone: LEDGER_STATE_TONES[ev.to] || '' },
    x_ledger_grace_extended: { icon: 'activity', title: `Proof of life: ${label(LIVENESS_SOURCE_LABELS, ev.liveness_source, 'lease renewed')}`, sub: sub(ev.child_run_id), tone: 'active' },
    // Team-mode orchestration.
    team_director_called: { icon: 'users', title: 'Team: director called', sub: ev.employees_available != null ? `${ev.employees_available} employees available` : '', tone: '' },
    team_director_failed: { icon: 'alert-triangle', title: 'Team: director failed', sub: ev.error || '', tone: 'fail' },
    team_step_failed:     { icon: 'x-circle', title: `Team: ${ev.employee || 'step'} failed`, sub: sub(ev.reason, ev.error), tone: 'fail' },
    team_completed:       { icon: 'flag', title: `Team completed · ${ev.steps ?? '?'} step(s)`, sub: sub(usd(ev.total_cost_usd), ev.total_duration_ms != null ? `${Math.round(ev.total_duration_ms / 1000)}s` : ''), tone: 'ok' },
    session_resume_failed:{ icon: 'unplug', title: `Session did not resume: ${ev.entity || ev.runtime || ''}`, sub: 'restarting cold', tone: 'fail' },
  };
  return M[ev.event] || { icon: 'circle', title: chatEventLabel(ev), sub: '', tone: '' };
}

// Legacy audit events wrapped by the compatibility facade arrive as
// `delivery.<legacy_event>` with the legacy fields inside `payload`.
function unwrapDelivery(ev) {
  const p = ev.payload || {};
  return { ...p, event: p.legacyEvent || ev.type.slice('delivery.'.length) };
}

// Semantic block {icon, title, sub, tone} for one timeline event. Canonical
// events resolve by `ev.type`, legacy ones by `ev.event`. Never returns an
// undefined title: unknown types fall back to the type itself.
export function runEventView(ev) {
  const event = ev || {};
  const type = typeof event.type === 'string' ? event.type : '';
  let view;
  if (type && CANONICAL[type]) view = CANONICAL[type](event);
  else if (type.startsWith('delivery.')) view = legacyRunEventView(unwrapDelivery(event));
  else if (type) view = { icon: 'circle', title: type, sub: '', tone: '' };
  else view = legacyRunEventView(event);
  return { icon: view.icon || 'circle', title: view.title || type || 'event', sub: view.sub || '', tone: view.tone || '' };
}

export function isInfraEvent(ev) {
  return INFRA_EVENT_TYPES.includes(ev?.type);
}

// Timeline rows: infrastructure events are hidden by default and counted so
// the UI can offer a toggle. Nothing is removed from the underlying stream.
//
// Stable per-event identity: `_seq` is assigned ONCE per event, from its
// position in this full (unfiltered) stream, and kept on the object from
// then on — it is never recomputed from the FILTERED `.visible` list, whose
// membership (and therefore array index) shifts the instant the infra
// toggle flips. `:key` bindings must use `ev._seq`, never the loop index.
export function runTimeline(events, showInfra = false) {
  const all = Array.isArray(events) ? events : [];
  all.forEach((ev, i) => { if (ev && ev._seq == null) ev._seq = i; });
  if (showInfra) return { visible: all, hidden: 0 };
  const visible = all.filter((ev) => !isInfraEvent(ev));
  return { visible, hidden: all.length - visible.length };
}

// Live header derived from the stream. Canonical Runs contribute state
// (`run.transitioned`), target (`run.prepared`, re-targeted by
// `x_run_route_resolved` once the queue routed the Message), runtime and model
// (`runtime.selection_snapshot`), Gauntlet decision (`gauntlet.stopped`) and
// cost: reported per node when multi-target events exist, otherwise the
// amount reserved by `gauntlet.round_started`. Legacy fields are unchanged.
export function summarizeRunEvents(events) {
  const evs = Array.isArray(events) ? events : [];
  let business = null, squad = null, mindClone = null, runtime = null, model = null, gate = null, artifacts = 0, lastAgent = null, agents = 0, cost = 0;
  let state = null, decision = null, stopReason = null, target = null, route = null, reservedCost = 0;
  const nodeCosts = new Map();
  const legacy = (ev) => {
    if (ev.business_slug || ev.business) business = ev.business_slug || ev.business;
    if (ev.squad_slug || ev.squad_name || ev.squad) squad = ev.squad_slug || ev.squad_name || ev.squad;
    if (ev.event === 'mind_clone_injected') mindClone = ev.clone || ev.dna || ev.slug || ev.file;
    if (ev.runtime) runtime = ev.runtime;
    if (ev.model || ev.model_id) model = ev.model || ev.model_id;
    if (ev.event === 'gate_passed' || ev.event === 'gate_failed') gate = ev.event === 'gate_passed' ? 'passed' : 'failed';
    if (ev.event === 'artifact_published' || ev.event === 'report_html_generated' || ev.event === 'report_pdf_generated') artifacts++;
    if (ev.event === 'agent_executed') { agents++; lastAgent = ev.employee || lastAgent; }
    if (ev.cost_usd != null) cost += Number(ev.cost_usd) || 0;
  };
  for (const ev of evs) {
    const type = typeof ev?.type === 'string' ? ev.type : '';
    if (!type) { legacy(ev || {}); continue; }
    const p = ev.payload || {};
    if (type.startsWith('delivery.')) { legacy(unwrapDelivery(ev)); continue; }
    if ((type === 'run.prepared' || type === 'x_run_route_resolved') && p.target) {
      target = p.target;
      route = p.route || null;
      if (p.target.kind === 'business') business = p.target.slug;
      else if (p.target.kind === 'squad') squad = p.target.slug;
      else lastAgent = p.target.slug || lastAgent;
    }
    if (type === 'run.transitioned' && p.to) state = p.to;
    if (type === 'runtime.selection_snapshot') { runtime = p.snapshot?.runtime?.id || runtime; model = p.snapshot?.model?.id || model; }
    if (type === 'gauntlet.round_started') reservedCost += Number(p.costReservedUsd ?? p.expectedCostUsd) || 0;
    if (type === 'gauntlet.candidate_created' || type === 'gauntlet.candidate_revised') artifacts += (p.artifactRefs || []).length;
    if (type === 'gauntlet.stopped') { decision = p.decision || null; stopReason = p.reason || null; }
    if (type.startsWith('multi_target.') && p.node?.nodeId) nodeCosts.set(p.node.nodeId, Number(p.node.reportedCostUsd) || 0);
  }
  cost += nodeCosts.size ? [...nodeCosts.values()].reduce((sum, value) => sum + value, 0) : reservedCost;
  return { business, squad, mindClone, runtime, model, gate, artifacts, lastAgent, agents, cost, count: evs.length, state, decision, stopReason, target, route };
}
