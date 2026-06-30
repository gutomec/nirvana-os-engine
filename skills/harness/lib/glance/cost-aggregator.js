/**
 * cost-aggregator.js — pure aggregator for cost & token metrics.
 *
 * Reads `cost_emission` events from the SQLite audit_events table and
 * computes daily token buckets, USD estimates, cache hit ratios, and
 * top-N expensive squads/businesses.
 *
 * Pricing assumptions (USD per million tokens, conservative defaults):
 *   input          $3.00
 *   cache_creation $3.75
 *   cache_read     $0.30
 *   output         $15.00
 * Override via NIRVANA_PRICING_USD env var (JSON map).
 *
 * Pure JS, no deps. Caller passes events array or DB handle.
 */

'use strict';

const path = require('path');
const os = require('os');

const DEFAULT_PRICING = {
  input: 3.00,
  cache_creation: 3.75,
  cache_read: 0.30,
  output: 15.00,
};

function getPricing() {
  if (process.env.NIRVANA_PRICING_USD) {
    try { return Object.assign({}, DEFAULT_PRICING, JSON.parse(process.env.NIRVANA_PRICING_USD)); }
    catch { /* fall back */ }
  }
  return DEFAULT_PRICING;
}

function dayBucket(iso) {
  return (iso || '').slice(0, 10) || 'unknown';
}

function tokensFromPayload(payload) {
  if (!payload) return { input: 0, cache_creation: 0, cache_read: 0, output: 0, total: 0 };
  // Audit events use 4 known shapes; try each explicitly so we don't silently
  // extract zeros when the schema is one of the variants.
  let u = null;
  if (payload.usage) u = payload.usage;                                  // {payload: {usage: {...}}}
  else if (payload.message?.usage) u = payload.message.usage;            // {payload: {message: {usage: {...}}}}
  else if (payload.input_tokens || payload.output_tokens) u = payload;   // claude-code transcript shape (flat)
  else if (payload.input || payload.output) u = payload;                 // already-normalized shape
  else u = payload;                                                      // fallback (legacy)
  const input = Number(u.input_tokens || u.input || 0) || 0;
  const cache_creation = Number(u.cache_creation_input_tokens || u.cache_creation || 0) || 0;
  const cache_read = Number(u.cache_read_input_tokens || u.cache_read || 0) || 0;
  const output = Number(u.output_tokens || u.output || 0) || 0;
  return { input, cache_creation, cache_read, output, total: input + cache_creation + cache_read + output };
}

function usdFor(tokens, pricing) {
  return (
    (tokens.input * pricing.input) +
    (tokens.cache_creation * pricing.cache_creation) +
    (tokens.cache_read * pricing.cache_read) +
    (tokens.output * pricing.output)
  ) / 1_000_000;
}

function aggregate(events, opts = {}) {
  const pricing = opts.pricing || getPricing();
  const buckets = new Map();   // day -> { input, cache_creation, cache_read, output, total, ops, usd }
  const bySquad = new Map();   // squad slug -> { ops, tokens, usd }
  const byBiz = new Map();
  const byHost = new Map();
  let opsTotal = 0;
  let totals = { input: 0, cache_creation: 0, cache_read: 0, output: 0, total: 0, usd: 0 };

  const filteredEvents = (events || []).filter(e => e.event === 'cost_emission' || (e.payload && e.payload.event === 'cost_emission'));

  for (const e of filteredEvents) {
    // Try every observed payload shape:
    //   - state.db row: { payload: { usage: ... } }
    //   - nested: { payload: { payload: { usage: ... } } }
    //   - JSONL flat: { usage: ..., total_cost_usd: ..., host: ... }   ← realtime / transcript hooks
    const payload = e.payload?.usage ? e.payload
                  : e.payload?.payload?.usage ? e.payload.payload
                  : e.usage ? e
                  : (e.payload || {});
    const tk = tokensFromPayload(payload);
    if (tk.total === 0) continue;
    const day = dayBucket(e.ts);
    const usd = usdFor(tk, pricing);
    opsTotal += 1;

    if (!buckets.has(day)) buckets.set(day, { day, input: 0, cache_creation: 0, cache_read: 0, output: 0, total: 0, ops: 0, usd: 0 });
    const b = buckets.get(day);
    b.input += tk.input; b.cache_creation += tk.cache_creation; b.cache_read += tk.cache_read; b.output += tk.output;
    b.total += tk.total; b.ops += 1; b.usd += usd;

    totals.input += tk.input; totals.cache_creation += tk.cache_creation;
    totals.cache_read += tk.cache_read; totals.output += tk.output;
    totals.total += tk.total; totals.usd += usd;

    const squadSlug = payload.squad || payload.squad_slug || (payload.target?.squad);
    if (squadSlug) {
      if (!bySquad.has(squadSlug)) bySquad.set(squadSlug, { slug: squadSlug, ops: 0, tokens: 0, usd: 0 });
      const r = bySquad.get(squadSlug); r.ops++; r.tokens += tk.total; r.usd += usd;
    }
    const bizSlug = payload.business_slug || payload.business;
    if (bizSlug) {
      if (!byBiz.has(bizSlug)) byBiz.set(bizSlug, { slug: bizSlug, ops: 0, tokens: 0, usd: 0 });
      const r = byBiz.get(bizSlug); r.ops++; r.tokens += tk.total; r.usd += usd;
    }
    const host = payload.host || e.payload?.host;
    if (host) {
      if (!byHost.has(host)) byHost.set(host, { host, ops: 0, input: 0, cache_creation: 0, cache_read: 0, output: 0 });
      const h = byHost.get(host);
      h.ops++; h.input += tk.input; h.cache_creation += tk.cache_creation;
      h.cache_read += tk.cache_read; h.output += tk.output;
    }
  }

  const cache_input_tokens = totals.cache_creation + totals.cache_read;
  const total_input_likes = totals.input + cache_input_tokens;
  const cache_hit_ratio = total_input_likes > 0 ? cache_input_tokens / total_input_likes : 0;

  const dailyArr = Array.from(buckets.values()).sort((a, b) => a.day.localeCompare(b.day));
  const top_expensive_squads = Array.from(bySquad.values())
    .sort((a, b) => b.usd - a.usd).slice(0, 10);
  const top_expensive_businesses = Array.from(byBiz.values())
    .sort((a, b) => b.usd - a.usd).slice(0, 10);

  return {
    totals: {
      total_tokens: totals.total,
      input_tokens: totals.input,
      cache_creation_tokens: totals.cache_creation,
      cache_read_tokens: totals.cache_read,
      output_tokens: totals.output,
      usd: totals.usd,
      ops: opsTotal,
      cache_hit_ratio,
    },
    daily: dailyArr,
    top_expensive_squads,
    top_expensive_businesses,
    by_host: Array.from(byHost.values()),
    pricing_used: pricing,
    period_events: filteredEvents.length,
  };
}

module.exports = { aggregate, tokensFromPayload, usdFor, dayBucket, getPricing, DEFAULT_PRICING };
