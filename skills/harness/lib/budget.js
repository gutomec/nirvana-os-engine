/**
 * Pre-flight cost estimator for harness invocations (Stage 4).
 *
 * Budget and baseline keys are settings (`budget.*` and `baselines.*` in
 * _shared/lib/settings-schema.ts), resolved by _shared/lib/settings.ts with
 * the engine's one precedence: env > project config > global config >
 * skills/harness/config.yaml > default. Defaults follow Harness Protocol v1
 * §5.1 and are sized so Nirvana stays out of the way: a cap of 0 (or any
 * value <= 0) means UNLIMITED and the pre-flight is a no-op. Set a positive
 * value to enforce a hard cap; tighten per business in
 * business.yaml.run_budget_usd if needed.
 *
 * Estimation strategy:
 *  - Look up target.estimated_cost_usd if registry entry provides it.
 *  - Fallback: per-target-type baseline (squad_capability=$0.30, business=$0.80).
 *  - Add a small overhead per expected handoff (~$0.05).
 *  - Compare against effective cap; emit ok=true|false + breakdown.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const SKILLS_ROOT = process.env.NIRVANA_SKILLS_DIR
  || (fs.existsSync(path.join(os.homedir(), '.nirvana', 'skills')) ? path.join(os.homedir(), '.nirvana', 'skills') : path.join(os.homedir(), '.claude', 'skills'));

const HARNESS_ROOT = path.join(SKILLS_ROOT, 'harness');
/** The engine-default layer; kept for callers that print where defaults live. */
const CONFIG_PATH = path.join(HARNESS_ROOT, 'config.yaml');

// Requiring the .ts works under Bun (same pattern as router.js → harness-config.ts).
const settings = require(path.join(__dirname, '..', '..', '_shared', 'lib', 'settings.ts'));

/** `{ budget.x: v }` → `{ x: v }` for one section prefix. */
function section(prefix, values) {
  const out = {};
  for (const [key, value] of Object.entries(values)) {
    if (key.startsWith(prefix)) out[key.slice(prefix.length)] = value;
  }
  return out;
}

const SCHEMA_DEFAULTS = Object.fromEntries(settings.SETTINGS_SCHEMA.map((spec) => [spec.key, spec.default]));

const DEFAULTS = Object.freeze({
  budget: Object.freeze(section('budget.', SCHEMA_DEFAULTS)),
  baselines: Object.freeze(section('baselines.', SCHEMA_DEFAULTS)),
});

/**
 * The effective budget and baselines (settings.ts resolution).
 */
function getEffectiveConfig() {
  const values = settings.resolveSettingsMap();
  return {
    budget: section('budget.', values),
    baselines: section('baselines.', values),
  };
}

/**
 * Estimate cost for invoking a routing target.
 *
 * @param {{type: string, id?: string, target?: object, expected_handoffs?: number, estimated_cost_usd?: number}} target
 * @param {object} ctx optional invocation context
 * @returns {{estimated_usd: number, breakdown: object}}
 */
function estimate(target, ctx) {
  const cfg = getEffectiveConfig();
  const baselines = cfg.baselines;

  if (!target || typeof target !== 'object') {
    return {
      estimated_usd: baselines.squad_capability_usd,
      breakdown: { reason: 'no_target_provided', baseline: baselines.squad_capability_usd },
    };
  }

  // 1) explicit estimate on the target
  if (typeof target.estimated_cost_usd === 'number') {
    return {
      estimated_usd: target.estimated_cost_usd,
      breakdown: { source: 'target.estimated_cost_usd', value: target.estimated_cost_usd },
    };
  }

  // 2) baseline by type
  const type = target.type || (ctx && ctx.target_type) || 'squad_capability';
  const base = type === 'business' ? baselines.business_usd : baselines.squad_capability_usd;

  // 3) overhead per handoff
  const handoffs = Number.isFinite(target.expected_handoffs) ? target.expected_handoffs : 0;
  const handoffCost = handoffs * baselines.per_handoff_usd;

  return {
    estimated_usd: +(base + handoffCost).toFixed(4),
    breakdown: {
      type,
      base_usd: base,
      handoffs,
      handoff_overhead_usd: handoffCost,
    },
  };
}

/**
 * Pre-flight check: estimate the cost and compare against effective cap.
 *
 * @param {object} target same shape as estimate()
 * @param {{max_cost_usd?: number, max_tokens?: number, max_handoffs?: number, max_duration_seconds?: number}} ctx
 * @returns {{
 *   ok: boolean,
 *   estimated_usd: number,
 *   max_cost_usd: number,
 *   max_handoffs: number,
 *   max_duration_seconds: number,
 *   on_exceeded: string,
 *   breakdown: object,
 *   reason?: string,
 * }}
 */
function check(target, ctx) {
  const cfg = getEffectiveConfig();
  const cap = (ctx && Number.isFinite(ctx.max_cost_usd))
    ? ctx.max_cost_usd
    : cfg.budget.default_max_cost_usd;

  const handoffsCap = (ctx && Number.isFinite(ctx.max_handoffs))
    ? ctx.max_handoffs
    : cfg.budget.default_max_handoffs;

  const durationCap = (ctx && Number.isFinite(ctx.max_duration_seconds))
    ? ctx.max_duration_seconds
    : cfg.budget.default_max_duration_seconds;

  // A cap of 0 (or any value <= 0) means unlimited — the pre-flight is a no-op.
  const unlimited = !(cap > 0);
  const est = estimate(target, ctx);
  const ok = unlimited || est.estimated_usd <= cap;

  return {
    ok,
    unlimited,
    estimated_usd: est.estimated_usd,
    max_cost_usd: cap,
    max_handoffs: handoffsCap,
    max_duration_seconds: durationCap,
    on_exceeded: cfg.budget.on_budget_exceeded,
    auto_invoke_budget_usd: cfg.budget.auto_invoke_budget_usd,
    breakdown: est.breakdown,
    reason: ok ? null : `estimated ${est.estimated_usd} USD exceeds cap ${cap} USD`,
  };
}

module.exports = { estimate, check, getEffectiveConfig, DEFAULTS, CONFIG_PATH };
