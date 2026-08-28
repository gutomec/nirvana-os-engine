/**
 * cloudevents.js — the CloudEvents 1.0 envelope for the audit log, and the
 * dual-read that keeps ~187k existing events readable.
 *
 * Spec: https://github.com/cloudevents/spec/blob/main/cloudevents/spec.md
 * (CNCF-graduated January 2024.) The property that earned it the job here:
 * context attributes serialize independently of `data`, so a consumer filters
 * on type / source / subject without deserializing the payload. At the volume
 * this log runs — 186,990 lines measured across both roots on 2026-08-28 —
 * that is the difference between a filter and a full parse.
 *
 * ── On-disk form: structured mode, one JSON object per line ────────────────
 *
 *   {"specversion":"1.0","id":"<32 hex>","source":"/squad/seo-geo-aeo",
 *    "type":"sh.squads.nirvana.dispatch.dispatch_squad","subject":"<trace_id>",
 *    "time":"2026-08-28T10:01:00.000Z","datacontenttype":"application/json",
 *    "projectid":"<project_id>","data":{ ...the flat payload... }}
 *
 * Structured mode, not a flat merge of envelope keys into the legacy object,
 * because the two vocabularies collide for real and the collision is measured:
 * `source` already exists as a PAYLOAD key on 713 lines, carrying things like
 * "user", "work/assets" and an agent file path — nothing a CloudEvents `source`
 * could mean. Merging would have overwritten it. Nesting the payload under
 * `data` gives each vocabulary its own namespace and costs nothing to undo.
 *
 * ── The discriminator, and why it is `specversion` ─────────────────────────
 *
 * `isEnvelope()` is one property lookup on an already-parsed object, and it
 * runs once per line over the whole history. `specversion` is REQUIRED by the
 * spec, so every envelope has it, and it is present on 0 of the 186,990
 * existing lines — measured, not assumed. The other candidates all appear in
 * legacy payloads (`source` 713×) or would need a string compare.
 *
 * ── Dual-read ──────────────────────────────────────────────────────────────
 *
 * `toLegacyEvent()` projects an envelope back to the flat shape every current
 * reader already understands, and returns a legacy object untouched, by
 * identity. No history is rewritten and no reader has to learn the envelope to
 * keep working. Readers that want the new attributes find them on `_ce`.
 *
 * ── Schema evolution: additive only ────────────────────────────────────────
 *
 * New fields arrive OPTIONAL with a default. Old fields are DEPRECATED in a
 * comment, never renamed and never removed. A `type` never changes meaning; a
 * new meaning gets a new `type`. This is what lets a consumer we do not control
 * lag a version behind without breaking — the normal condition once the log is
 * served over `nrv serve`. Concretely: the legacy attribution keys
 * (`business_slug`, `squad_name`, `squad`, `business`, …) all stay inside
 * `data` verbatim even though `source` now carries the same fact, because
 * removing them would break every reader that reads them today.
 */

'use strict';

const crypto = require('crypto');

/** CloudEvents spec version this writer emits. */
const SPEC_VERSION = '1.0';

/** Reverse-DNS root of every `type` we emit. The domain is squads.sh. */
const TYPE_PREFIX = 'sh.squads.nirvana';

/**
 * Domain for an event that is not in the closed core: squad and business
 * events, and anything the open `x_` namespace carries. The local name is kept
 * VERBATIM, `x_` prefix included — renaming the 286 invented names is cut 4's
 * job, and a lossless `type` here is what lets that cut be a pure rename.
 */
const EXTENSION_DOMAIN = 'ext';

/**
 * The closed core, grouped into the domains a `type` names. Owned by the
 * platform: a break here is a breaking change.
 *
 * The map is exhaustive over `audit.js` ALLOWED_EVENTS and a test asserts it,
 * so an event added to the enum without a domain fails before it reaches a
 * log. That is the same discipline the generated event table already uses —
 * the two lists cannot drift apart quietly.
 */
const EVENT_DOMAINS = Object.freeze({
  // What the caller asked for, and what we made of it.
  brief_received: 'brief', brief_amplified: 'brief', brief_scored: 'brief',
  brief_proxy_enriched: 'brief',
  clarification_emitted: 'brief', clarification_received: 'brief',

  // Choosing a target.
  routing_decision: 'routing', auto_route_selected: 'routing',
  routing_rule_applied: 'routing', routing_rule_vetoed: 'routing',
  agentic_route_called: 'routing', agentic_route_decision: 'routing',
  agentic_route_failed: 'routing', cascade_exhausted: 'routing',
  cascade_no_entry_available: 'routing', target_plan_committed: 'routing',

  // Handing work to a target.
  dispatch_business: 'dispatch', dispatch_squad: 'dispatch', dispatch_agent_x: 'dispatch',
  dispatch_blocked: 'dispatch', dispatch_audit: 'dispatch', dispatch_audit_revision: 'dispatch',
  invocation_start: 'dispatch', invocation_end: 'dispatch',

  // Who did the work.
  agent_executed: 'agent', agent_exec_failed: 'agent', squad_run_failed: 'agent',
  mind_clone_injected: 'agent', mind_clone_missing_degraded: 'agent',
  team_director_called: 'agent', team_director_failed: 'agent', team_chain_selected: 'agent',
  team_step_failed: 'agent', team_completed: 'agent',

  // Judging it.
  gate_passed: 'gate', gate_failed: 'gate', judge_invoked: 'gate', critique_generated: 'gate',
  revision_dispatched: 'gate', revision_requested: 'gate', revision_failed: 'gate',
  revision_auto: 'gate', revision_loop_exhausted: 'gate',
  validation_failed: 'gate', verify_passed: 'gate', verify_failed: 'gate',
  chunk_gate_passed: 'gate', chunk_gate_failed: 'gate',
  humanization_applied: 'gate', humanization_skipped: 'gate',

  // Giving it back.
  delivered: 'delivery', deliverable_manifest_registered: 'delivery', chunk_emitted: 'delivery',
  report_pdf_generated: 'delivery', report_html_generated: 'delivery',
  report_publisher_ran: 'delivery', report_skipped_fast: 'delivery',

  // The run's own life.
  session_started: 'run', session_resumed: 'run', session_resume_failed: 'run', resume: 'run',
  handoff: 'run', handoff_phase_advanced: 'run',
  watch_started: 'run', watch_stopped: 'run',
  stall_detected: 'run', stall_retry: 'run', loop_detected: 'run',
  context_budget_warning: 'run',

  // The runtime under it.
  runtime_unavailable: 'runtime', runtime_auth_failed: 'runtime',
  runtime_quota_exhausted: 'runtime', runtime_transient_retry: 'runtime',
  runtime_error: 'runtime', runtime_handoff: 'runtime',

  // What it cost.
  cost_emission: 'cost', dispatch_cost_recorded: 'cost', budget_violation: 'cost',

  // Where a person is needed.
  ticket_opened: 'human', ticket_resolved: 'human', escalation_trigger_fired: 'human',
  human_notification_required: 'human', human_response_received: 'human',
  approval_checkpoint: 'human', approval_granted: 'human', approval_rejected: 'human',
  ask_invoked: 'human',

  // What the agent touched, as the hooks see it.
  tool_invoked: 'tool', bash_completed: 'tool', artifact_touched: 'tool',

  // The engine operating on itself.
  memory_write: 'system', isolation_violation: 'system',
  nirvana_updated: 'system', pack_created: 'system',
  project_exported: 'system', project_purged: 'system',
});

/** The domain a legacy event name belongs to. Unknown names are extensions. */
function domainOf(eventName) {
  return EVENT_DOMAINS[eventName] || EXTENSION_DOMAIN;
}

/**
 * `type` for a legacy event name: `sh.squads.nirvana.<domain>.<name>`.
 *
 * The local part is the legacy name verbatim, which makes the mapping
 * reversible for every name in the log — 373 distinct ones on this machine,
 * none of which contains a dot.
 */
function typeFor(eventName) {
  return `${TYPE_PREFIX}.${domainOf(eventName)}.${eventName}`;
}

/**
 * The legacy event name inside a `type`, or null when the type is not ours.
 * Splits past the domain rather than on the last dot, so a future name with a
 * dot in it still round-trips.
 */
function eventNameFor(type) {
  if (typeof type !== 'string') return null;
  const parts = type.split('.');
  if (parts.length < 5) return null;
  if (`${parts[0]}.${parts[1]}.${parts[2]}` !== TYPE_PREFIX) return null;
  return parts.slice(4).join('.');
}

/**
 * The attribution keys, in the precedence `source` reads them.
 *
 * Measured over all 186,926 parseable events on 2026-08-28, not over the rogue
 * subset: `business_slug` 1,395 · `business` 390 · `squad` 358 · `squad_name`
 * 76 · `squad_slug` 59. So the canonical spelling won for businesses and LOST
 * for squads, and cut 1's finding (`squad_name` 0, `business_slug` 0) holds
 * for the events that arrive outside the rules, which is where it was measured.
 *
 * The answer is to read all of them and rename none. `source` is DERIVED, so
 * an author keeps writing whichever key their squad already writes and still
 * gets attributed; the legacy keys stay in `data` untouched, which is the
 * additive-only rule applied to the very first case that tests it.
 */
const SQUAD_KEYS = Object.freeze(['squad_name', 'squad_slug', 'squad']);
const BUSINESS_KEYS = Object.freeze(['business_slug', 'business']);

function firstString(obj, keys) {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

/**
 * `source` for a flat event: `/squad/<slug>`, `/business/<slug>` or
 * `/engine/<component>`. A URI-reference, as the spec requires.
 *
 * 26,975 of 186,926 events (14.4%) name no squad, business or host at all.
 * They are not guessed at: they attribute to the engine component that wrote
 * them, which is true, instead of to nobody.
 */
function sourceFor(flat, ctx) {
  const from = ctx || {};
  if (typeof from.source === 'string' && from.source.trim()) return from.source.trim();
  const squad = firstString(from, SQUAD_KEYS) || firstString(flat, SQUAD_KEYS);
  if (squad) return `/squad/${encodeURIComponent(squad)}`;
  const business = firstString(from, BUSINESS_KEYS) || firstString(flat, BUSINESS_KEYS);
  if (business) return `/business/${encodeURIComponent(business)}`;
  const component = firstString(from, ['component']) || firstString(flat, ['host']) || 'harness';
  return `/engine/${encodeURIComponent(component)}`;
}

const { BRIEF_EXCERPT_MAX, briefExcerpt } = require('./brief-excerpt.js');

/**
 * Ceiling for the serialized `data`, in bytes.
 *
 * Measured over the 186,892 events with a payload on 2026-08-28: p50 328 B,
 * p90 348, p99 432, p99.9 682, max 10,940. 4 KiB sits about six times above
 * p99.9 and is crossed by 5 lines in 186,892 (0.0027%) — every one of them a
 * whole brief pasted onto the event, the exact defect `brief_excerpt` exists
 * to prevent. So the ceiling is not a guess about future payloads; it is the
 * line above which the only measured cause is content that should have
 * travelled by reference.
 */
const MAX_DATA_BYTES = 4096;

/**
 * Bring `data` under the ceiling, and say so on the event.
 *
 * Longest string first, cut to the same excerpt bound a brief already gets, so
 * the log carries a readable trace of what was there instead of a hole. The
 * key keeps its name and its type, which is what keeps a reader that reads
 * `data.brief` working. `_truncated` lists what was cut and `_bytes` the size
 * it was cut from, so a consumer can go fetch the real thing.
 */
function boundData(data) {
  let text = JSON.stringify(data);
  if (text === undefined) return { data, bytes: 0 };
  if (Buffer.byteLength(text, 'utf8') <= MAX_DATA_BYTES) return { data, bytes: Buffer.byteLength(text, 'utf8') };

  const out = Object.assign({}, data);
  const truncated = [];
  const bytes = {};
  for (;;) {
    let widest = null;
    let widestLen = BRIEF_EXCERPT_MAX;
    for (const [k, v] of Object.entries(out)) {
      if (typeof v !== 'string' || v.length <= widestLen) continue;
      widest = k; widestLen = v.length;
    }
    if (widest === null) break;
    bytes[widest] = Buffer.byteLength(out[widest], 'utf8');
    out[widest] = briefExcerpt(out[widest]);
    truncated.push(widest);
    text = JSON.stringify(Object.assign({}, out, { _truncated: truncated, _bytes: bytes }));
    if (Buffer.byteLength(text, 'utf8') <= MAX_DATA_BYTES) break;
  }
  out._truncated = truncated;
  out._bytes = bytes;
  const finalBytes = Buffer.byteLength(JSON.stringify(out), 'utf8');
  // A payload that is still over after every string was cut is not silently
  // dropped — losing an event says less than an oversized one. It is marked,
  // so the ceiling stays a fact a reader can check rather than a promise.
  if (finalBytes > MAX_DATA_BYTES) out._oversize = true;
  return { data: out, bytes: finalBytes };
}

/**
 * The idempotency key: sha256 over exactly the bytes that go on the line,
 * hex, first 32 characters.
 *
 * Deterministic rather than random, because the duplicate this log actually
 * produces is a REPLAY — `dispatch.ts` copies pre-project events into the
 * project root carrying the original `ts` — and a random id would hand an
 * external consumer two events it has no way to tell apart. 252 of 186,990
 * lines (0.135%) are byte-identical to another line today, and every reader
 * that dedupes already collapses them by content. Hashing the content makes
 * that collapse mechanical instead of each reader's private convention.
 *
 * The cost is stated: two genuinely distinct events with the same time, type,
 * source, subject and payload get one id. They are already indistinguishable
 * on disk, so nothing that was previously separable becomes merged.
 */
function eventId(parts) {
  const h = crypto.createHash('sha256');
  h.update(`${parts.time || ''}\n${parts.type}\n${parts.source}\n${parts.subject || ''}\n${parts.dataText}`);
  return h.digest('hex').slice(0, 32);
}

/** True when a parsed line is a CloudEvents envelope. One property lookup. */
function isEnvelope(obj) {
  return typeof obj === 'object' && obj !== null && typeof obj.specversion === 'string';
}

/** The flat keys that become context attributes instead of payload. */
const ATTRIBUTE_KEYS = Object.freeze(['ts', 'event', 'trace_id', 'project_id']);

/**
 * Wrap a flat legacy event in the envelope. `ctx` may carry `source`,
 * `component` or `dataschema`; everything else is derived from the event.
 */
function toEnvelope(flat, ctx) {
  const data = {};
  for (const [k, v] of Object.entries(flat)) {
    if (ATTRIBUTE_KEYS.includes(k)) continue;
    data[k] = v;
  }
  const bounded = boundData(data);
  const dataText = JSON.stringify(bounded.data);
  const type = typeFor(String(flat.event));
  const source = sourceFor(flat, ctx);
  const subject = typeof flat.trace_id === 'string' ? flat.trace_id : undefined;
  const time = typeof flat.ts === 'string' ? flat.ts : undefined;
  const envelope = {
    specversion: SPEC_VERSION,
    id: eventId({ time, type, source, subject, dataText }),
    source,
    type,
  };
  if (subject !== undefined) envelope.subject = subject;
  if (time !== undefined) envelope.time = time;
  envelope.datacontenttype = 'application/json';
  const dataschema = ctx && typeof ctx.dataschema === 'string' ? ctx.dataschema.trim() : '';
  // Emitted only when one genuinely exists. An invented URI is worse than an
  // absent optional attribute: a consumer would fetch it and get a 404.
  if (dataschema) envelope.dataschema = dataschema;
  if (typeof flat.project_id === 'string' && flat.project_id) envelope.projectid = flat.project_id;
  envelope.data = bounded.data;
  return envelope;
}

/**
 * The dual-read. An envelope comes back as the flat shape every current reader
 * already understands; anything else is returned BY IDENTITY, untouched.
 *
 * The identity return is the reason this is affordable: the ~187k events
 * already on disk pay one `typeof` and nothing else.
 */
function toLegacyEvent(obj) {
  if (!isEnvelope(obj)) return obj;
  const data = obj.data && typeof obj.data === 'object' && !Array.isArray(obj.data) ? obj.data : {};
  const flat = {};
  if (typeof obj.time === 'string') flat.ts = obj.time;
  // A `type` outside our namespace keeps its full name rather than becoming
  // undefined — a reader that skips nameless events would otherwise drop it.
  flat.event = eventNameFor(obj.type) || obj.type;
  if (typeof obj.subject === 'string') flat.trace_id = obj.subject;
  if (typeof obj.projectid === 'string') flat.project_id = obj.projectid;
  Object.assign(flat, data);
  // The context attributes a flat reader cannot otherwise see. `source` is the
  // one that matters: the legacy shape has no place for it, because `source`
  // is already taken as a payload key on 713 existing lines.
  flat._ce = { specversion: obj.specversion, id: obj.id, source: obj.source, type: obj.type };
  if (typeof obj.dataschema === 'string') flat._ce.dataschema = obj.dataschema;
  return flat;
}

/**
 * Parse one audit line into the flat shape, whichever form it was written in.
 * Throws on malformed JSON exactly like `JSON.parse`, so a caller counting
 * unreadable lines keeps counting them.
 */
function parseAuditLine(line) {
  return toLegacyEvent(JSON.parse(line));
}

module.exports = {
  SPEC_VERSION, TYPE_PREFIX, EXTENSION_DOMAIN, EVENT_DOMAINS, MAX_DATA_BYTES,
  SQUAD_KEYS, BUSINESS_KEYS,
  domainOf, typeFor, eventNameFor, sourceFor, boundData, eventId,
  isEnvelope, toEnvelope, toLegacyEvent, parseAuditLine,
};
