/* run-event-labels.js — single source of truth for the Glance run timeline.
 *
 * Pure ES module with no dependencies. `bun test` imports it directly; the
 * page loads it through a `<script type="module">` adapter in index.html that
 * exposes the exports as `window.NirvanaRunEventLabels`, because glance.js is
 * a classic script. Canonical Run Kernel events resolve by `ev.type`; legacy
 * audit events resolve by `ev.event`. UI strings are PT-BR by design.
 */

const usd = (value) => (value != null && Number.isFinite(Number(value)) ? `$${Number(value).toFixed(2)}` : '');
const join = (...parts) => parts.filter(Boolean).join(' · ');
const shortDigest = (digest) => (digest ? String(digest).slice(0, 8) : '');
const label = (map, value, fallback = '') => (value == null || value === '' ? fallback : (map[value] || String(value)));
const targetName = (target) => (target ? (target.slug || target.id || target.kind || '') : '');

const RUN_STATE_LABELS = {
  prepared: 'preparado', running: 'em execução', waiting: 'aguardando', verifying: 'verificando', revising: 'revisando',
  cancelling: 'cancelando', rolled_back: 'revertido', completed: 'concluído', withheld: 'retido',
  delivered_with_reservations: 'entregue com ressalvas', cancelled: 'cancelado', failed: 'falhou', abandoned: 'abandonado',
};
const RUN_STATE_TONES = {
  completed: 'ok', delivered_with_reservations: 'ok', running: 'active', verifying: 'active', revising: 'active',
  withheld: 'fail', cancelled: 'fail', failed: 'fail', rolled_back: 'fail', abandoned: 'fail',
};
const GAUNTLET_DECISION_LABELS = { delivered: 'entregar', withheld: 'reter', reservations: 'entregar com ressalvas' };
const GAUNTLET_DECISION_TONES = { delivered: 'ok', withheld: 'fail', reservations: 'active' };
const GAUNTLET_STOP_REASON_LABELS = {
  success: 'sucesso', max_rounds: 'limite de rodadas', max_cost: 'limite de custo', max_duration: 'limite de duração',
  no_progress: 'sem progresso', critical_regression: 'regressão crítica', judge_disagreement: 'juízes divergiram',
  human_required: 'humano necessário', execution_failure: 'falha de execução',
};
const VERDICT_LABELS = { pass: 'aprovado', revise: 'revisar', reject: 'rejeitado', indeterminate: 'indeterminado' };
const VERDICT_TONES = { pass: 'ok', revise: 'active', reject: 'fail' };
const PLAN_STATE_LABELS = { ready: 'pronto', running: 'em execução', delivered: 'entregue', withheld: 'retido', failed: 'falhou' };
const PLAN_STATE_TONES = { delivered: 'ok', running: 'active', withheld: 'fail', failed: 'fail' };

// Node events carry the full node projection in `payload.node`.
function nodeView(ev, icon, verb, tone, detail) {
  const node = ev.payload?.node || {};
  const wave = node.waveIndex != null ? `onda ${node.waveIndex + 1}` : '';
  return { icon, title: `Nó ${node.nodeId || ev.payload?.nodeId || '?'} ${verb}`, sub: join(wave, ...detail(node)), tone };
}
function leaseView(ev, icon, verb, tone = '') {
  const p = ev.payload || {};
  return { icon, title: `Lease de ${p.nodeId || '?'} ${verb}`, sub: join(p.ownerId, p.version != null ? `v${p.version}` : '', p.reason), tone };
}
function candidateView(ev, icon, verb) {
  const p = ev.payload || {};
  return { icon, title: `Candidate ${p.candidateId || '?'} ${verb}`, sub: join(p.revision != null ? `r${p.revision}` : '', targetName(p.producer), p.artifactRefs?.length ? `${p.artifactRefs.length} artifacts` : ''), tone: 'active' };
}

// Canonical Run Kernel events, keyed by `ev.type`. Every type emitted by the
// engine must be listed here; the test suite enforces the list.
const CANONICAL = {
  'run.prepared': (ev) => { const t = ev.payload?.target; return { icon: 'inbox', title: `Run preparado → ${targetName(t) || 'alvo'}`, sub: join(t?.kind, t?.capabilityId), tone: '' }; },
  'run.transitioned': (ev) => { const p = ev.payload || {}; return { icon: p.to === 'completed' ? 'party-popper' : 'arrow-right-circle', title: `Run ${label(RUN_STATE_LABELS, p.to, 'transicionou')}`, sub: p.from && p.to ? `${p.from} → ${p.to}` : '', tone: RUN_STATE_TONES[p.to] || '' }; },
  'runtime.selection_snapshot': (ev) => { const s = ev.payload?.snapshot || {}; return { icon: 'cpu', title: `Runtime: ${s.runtime?.id || 'indefinido'}`, sub: join(s.provider?.id, s.model?.id), tone: '' }; },
  'gauntlet.plan_compiled': (ev) => { const p = ev.payload || {}; return { icon: 'clipboard-list', title: p.plan?.intensity ? `Plano Gauntlet ${p.plan.intensity}` : 'Plano Gauntlet', sub: join(p.state, label(GAUNTLET_STOP_REASON_LABELS, p.stopReason)), tone: '' }; },
  'gauntlet.candidate_created': (ev) => candidateView(ev, 'file-plus-2', 'criado'),
  'gauntlet.candidate_revised': (ev) => candidateView(ev, 'file-diff', 'revisado'),
  'gauntlet.evaluation_recorded': (ev) => { const p = ev.payload || {}; return { icon: 'clipboard-check', title: `Avaliação: ${label(VERDICT_LABELS, p.verdict, 'registrada')}`, sub: join(p.gauntletId, targetName(p.evaluator), usd(p.costUsd)), tone: VERDICT_TONES[p.verdict] || '' }; },
  'gauntlet.round_started': (ev) => { const p = ev.payload || {}; const reserved = p.costReservedUsd ?? p.expectedCostUsd; return { icon: 'play-circle', title: `Rodada ${p.round ?? '?'} iniciada`, sub: reserved != null ? `reservado ${usd(reserved)}` : '', tone: 'active' }; },
  'gauntlet.round_evaluated': (ev) => { const p = ev.payload || {}; return { icon: 'activity', title: `Rodada ${p.round ?? '?'} avaliada`, sub: join(p.score != null ? `score ${p.score}` : '', p.improved ? 'melhorou' : '', p.regressions?.length ? `${p.regressions.length} regressões` : '', p.blockingFailure ? 'falha bloqueante' : ''), tone: p.blockingFailure ? 'fail' : 'ok' }; },
  'gauntlet.revision_requested': (ev) => { const n = ev.payload?.revisionRequests?.length || 0; return { icon: 'rotate-ccw', title: 'Revisão solicitada', sub: n ? `${n} pedidos` : '', tone: 'active' }; },
  'gauntlet.regression_started': () => ({ icon: 'flask-conical', title: 'Regressão iniciada', sub: '', tone: 'active' }),
  'gauntlet.stopped': (ev) => { const p = ev.payload || {}; return { icon: 'flag', title: `Gauntlet parou: ${label(GAUNTLET_DECISION_LABELS, p.decision, 'sem decisão')}`, sub: join(label(GAUNTLET_STOP_REASON_LABELS, p.reason), p.reservations?.length ? `${p.reservations.length} ressalvas` : '', p.finalQualityGateRequired ? 'gate final pendente' : ''), tone: GAUNTLET_DECISION_TONES[p.decision] || '' }; },
  'canary.recovery_enqueued': (ev) => ({ icon: 'refresh-cw', title: 'Recuperação enfileirada', sub: ev.payload?.reason || '', tone: 'active' }),
  'canary.recovery_skipped': (ev) => ({ icon: 'skip-forward', title: 'Recuperação ignorada', sub: ev.payload?.reason || '', tone: '' }),
  'multi_target.snapshots_bound': (ev) => ({ icon: 'link', title: 'Plano multi-target vinculado', sub: join(shortDigest(ev.payload?.planDigest), shortDigest(ev.payload?.reservationDigest)), tone: '' }),
  'multi_target.snapshot_saved': (ev) => { const s = ev.payload?.snapshot || {}; return { icon: 'save', title: `Snapshot v${s.version ?? '?'} salvo`, sub: join(label(PLAN_STATE_LABELS, s.state), s.currentWave >= 0 ? `onda ${s.currentWave + 1}` : ''), tone: '' }; },
  'multi_target.node_started': (ev) => nodeView(ev, 'play', 'iniciado', 'active', (n) => [n.mode, n.grantedCostUsd ? `concedido ${usd(n.grantedCostUsd)}` : '']),
  'multi_target.node_delivered': (ev) => nodeView(ev, 'check-circle-2', 'entregue', 'ok', (n) => [usd(n.reportedCostUsd) ? `reportado ${usd(n.reportedCostUsd)}` : '']),
  'multi_target.node_withheld': (ev) => nodeView(ev, 'pause-circle', 'retido', 'fail', (n) => [n.reason]),
  'multi_target.node_failed': (ev) => nodeView(ev, 'x-circle', 'falhou', 'fail', (n) => [n.reason]),
  'multi_target.node_skipped': (ev) => nodeView(ev, 'skip-forward', 'pulado', 'fail', (n) => [n.blockedBy?.length ? `bloqueado por ${n.blockedBy.join(', ')}` : n.reason]),
  'multi_target.node_stalled': (ev) => nodeView(ev, 'alert-triangle', 'travado', 'fail', (n) => [n.reason]),
  'multi_target.support_completed': (ev) => nodeView(ev, 'check', 'de suporte concluído', 'ok', () => []),
  'multi_target.budget_exceeded': (ev) => nodeView(ev, 'ban', 'excedeu o orçamento', 'fail', (n) => [n.reason]),
  'multi_target.lease_claimed': (ev) => leaseView(ev, 'lock', 'obtida'),
  'multi_target.lease_renewed': (ev) => leaseView(ev, 'timer-reset', 'renovada'),
  'multi_target.lease_released': (ev) => leaseView(ev, 'unlock', 'liberada'),
  'multi_target.lease_lost': (ev) => leaseView(ev, 'alert-triangle', 'perdida', 'fail'),
  'multi_target.plan_terminal': (ev) => { const p = ev.payload || {}; return { icon: 'flag-triangle-right', title: `Plano multi-target ${label(PLAN_STATE_LABELS, p.state, 'encerrado')}`, sub: p.reason || '', tone: PLAN_STATE_TONES[p.state] || '' }; },
};

export const CANONICAL_EVENT_TYPES = Object.freeze(Object.keys(CANONICAL));

// High-frequency infrastructure events: kept in the stream, hidden from the
// timeline until the user toggles them (see runTimeline).
export const INFRA_EVENT_TYPES = Object.freeze(['multi_target.snapshot_saved', 'multi_target.lease_renewed']);

// Legacy audit events (`ev.event`): the golden 5 + the rest.
const LEGACY_SHORT_LABELS = {
  agentic_route_decision: 'Roteou', dispatch_business: 'Despachou empresa', dispatch_squad: 'Despachou squad',
  mind_clone_injected: 'Injetou mind-clone', agent_executed: 'Executou', gate_passed: 'Passou no gate',
  gate_failed: 'Falhou no gate', delivered: 'Entregou', routing_rule_applied: 'Regra de runtime',
  team_chain_selected: 'Montou o time', research_completed: 'Pesquisou', brief_received: 'Recebeu o brief',
};

export function chatEventLabel(ev) {
  const event = ev || {};
  return LEGACY_SHORT_LABELS[event.event] || event.event || event.type || 'evento';
}

function legacyRunEventView(ev) {
  const biz = ev.business_slug, sq = ev.squad_slug || ev.squad_name;
  const cost = ev.cost_usd != null ? `$${Number(ev.cost_usd).toFixed(2)}` : '';
  const dur = ev.duration_ms != null ? `${(ev.duration_ms / 1000).toFixed(0)}s` : '';
  const rt = ev.runtime ? String(ev.runtime).replace('claude-code', 'claude') : '';
  const step = (ev.step && ev.total) ? `passo ${ev.step}/${ev.total}` : '';
  const sub = (...xs) => xs.filter(Boolean).join(' · ');
  const M = {
    brief_received:       { icon: 'inbox', title: 'Brief recebido', tone: '' },
    brief_amplified:      { icon: 'sparkles', title: 'Brief enriquecido', tone: '' },
    agentic_route_decision:{ icon: 'compass', title: `Roteou → ${biz || ev.primary_business || '?'}`, sub: ev.rationale || ev.method || '', tone: 'active' },
    auto_route_selected:  { icon: 'compass', title: `Roteou → ${biz || '?'}`, sub: ev.method || '', tone: 'active' },
    routing_rule_applied: { icon: 'settings-2', title: `Regra de runtime → ${ev.runtime || ''}`, tone: '' },
    dispatch_business:    { icon: 'building-2', title: `${biz || 'empresa'} assumiu`, tone: 'active' },
    dispatch_squad:       { icon: 'users', title: `squad ${sq || ''}`, tone: 'active' },
    mind_clone_injected:  { icon: 'brain', title: `Mind-clone: ${ev.clone || ev.dna || ev.slug || ev.file || 'persona'}`, tone: '' },
    team_chain_selected:  { icon: 'link', title: 'Time montado', sub: sub(biz), tone: '' },
    agent_executed:       { icon: 'bot', title: ev.employee || 'agente', sub: sub(step, rt, cost, dur), tone: 'ok' },
    agent_exec_failed:    { icon: 'alert-triangle', title: `${ev.employee || 'agente'} falhou`, tone: 'fail' },
    tool_invoked:         { icon: 'wrench', title: ev.tool || 'ferramenta', tone: '' },
    bash_completed:       { icon: 'terminal-square', title: 'comando', tone: '' },
    ask_invoked:          { icon: 'message-circle-question', title: `consultou ${ev.clone || 'mind-clone'}`, tone: '' },
    verify_passed:        { icon: 'check-circle-2', title: 'Verificação passou', tone: 'ok' },
    verify_failed:        { icon: 'x-circle', title: 'Verificação falhou', tone: 'fail' },
    gate_passed:          { icon: 'shield-check', title: 'Gate passou', sub: (ev.rubrics || []).join(', '), tone: 'ok' },
    report_html_generated:{ icon: 'file-text', title: 'HTML gerado', tone: '' },
    report_pdf_generated: { icon: 'file-text', title: 'PDF gerado', tone: '' },
    artifact_published:    { icon: 'package-check', title: `Artifact: ${ev.artifact_id || ev.path || 'publicado'}`, sub: ev.media_type || '', tone: 'ok' },
    model_selected:        { icon: 'cpu', title: `Modelo: ${ev.model || ev.model_id || 'selecionado'}`, sub: rt, tone: '' },
    approval_required:     { icon: 'badge-help', title: 'Aprovação necessária', sub: ev.reason || '', tone: 'active' },
    delivered:            { icon: 'party-popper', title: 'Entregue', tone: 'ok' },
    runtime_handoff:      { icon: 'refresh-cw', title: `Trocou runtime → ${ev.to || ev.runtime || ''}`, tone: '' },
    runtime_quota_exhausted: { icon: 'ban', title: 'Cota esgotada', tone: 'fail' },
    cascade_exhausted:    { icon: 'ban', title: 'Cascata esgotada', tone: 'fail' },
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
  return { icon: view.icon || 'circle', title: view.title || type || 'evento', sub: view.sub || '', tone: view.tone || '' };
}

export function isInfraEvent(ev) {
  return INFRA_EVENT_TYPES.includes(ev?.type);
}

// Timeline rows: infrastructure events are hidden by default and counted so
// the UI can offer a toggle. Nothing is removed from the underlying stream.
export function runTimeline(events, showInfra = false) {
  const all = Array.isArray(events) ? events : [];
  if (showInfra) return { visible: all, hidden: 0 };
  const visible = all.filter((ev) => !isInfraEvent(ev));
  return { visible, hidden: all.length - visible.length };
}

// Live header derived from the stream. Canonical Runs contribute state
// (`run.transitioned`), target (`run.prepared`), runtime and model
// (`runtime.selection_snapshot`), Gauntlet decision (`gauntlet.stopped`) and
// cost: reported per node when multi-target events exist, otherwise the
// amount reserved by `gauntlet.round_started`. Legacy fields are unchanged.
export function summarizeRunEvents(events) {
  const evs = Array.isArray(events) ? events : [];
  let business = null, squad = null, mindClone = null, runtime = null, model = null, gate = null, artifacts = 0, lastAgent = null, agents = 0, cost = 0;
  let state = null, decision = null, stopReason = null, target = null, reservedCost = 0;
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
    if (type === 'run.prepared' && p.target) {
      target = p.target;
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
  return { business, squad, mindClone, runtime, model, gate, artifacts, lastAgent, agents, cost, count: evs.length, state, decision, stopReason, target };
}
