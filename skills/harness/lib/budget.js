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

// settings.ts is the single resolver for every setting (see its own header:
// "never a second resolver beside it") and there is no CJS sibling to give it
// the brief-excerpt.js/.ts treatment without forking its YAML/zod-layered
// resolution logic. A synchronous `require()` of it from this `.js` crashed
// on Windows at module-load time — the worst shape, since it took down every
// caller of router.js, not just a budget check — with the same
// `TypeError: require() async module` PR #158 round 1 hit. Bun's dynamic
// `import()` has no such restriction: it is always safe for an ESM module
// regardless of what its dependency chain carries, on every platform. Loaded
// once, lazily, and cached — every caller of this module (router.js's Stage 4,
// already `async function route()`) already awaits its own call chain.
let _settingsPromise = null;
function loadSettings() {
  if (!_settingsPromise) _settingsPromise = import(path.join(__dirname, '..', '..', '_shared', 'lib', 'settings.ts'));
  return _settingsPromise;
}

/** `{ budget.x: v }` → `{ x: v }` for one section prefix. */
function section(prefix, values) {
  const out = {};
  for (const [key, value] of Object.entries(values)) {
    if (key.startsWith(prefix)) out[key.slice(prefix.length)] = value;
  }
  return out;
}

// Mirrors the `default:` values settings-schema.ts declares for the
// `budget.*` / `baselines.*` keys. Copied rather than read from
// SETTINGS_SCHEMA at module load: DEFAULTS must stay a synchronous constant
// (settings-readers.test.ts reads it with no await, and it is meant to be
// cheap to print — `nrv config`, docs), while resolving the schema itself
// now goes through loadSettings()'s dynamic import (see above). Keep these
// two literal in step with settings-schema.ts's SETTINGS table if either changes.
const DEFAULTS = Object.freeze({
  budget: Object.freeze({
    default_max_cost_usd: 0,
    default_max_tokens: 0,
    default_max_handoffs: 0,
    default_max_duration_seconds: 0,
    on_budget_exceeded: 'warn',
    auto_invoke_budget_usd: 0,
  }),
  baselines: Object.freeze({
    squad_capability_usd: 0.3,
    business_usd: 0.8,
    per_handoff_usd: 0.05,
  }),
});

/**
 * The effective budget and baselines (settings.ts resolution).
 * @returns {Promise<{budget: object, baselines: object}>}
 */
async function getEffectiveConfig() {
  const settings = await loadSettings();
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
 * @returns {Promise<{estimated_usd: number, breakdown: object}>}
 */
async function estimate(target, ctx) {
  const cfg = await getEffectiveConfig();
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
 * @returns {Promise<{
 *   ok: boolean,
 *   estimated_usd: number,
 *   max_cost_usd: number,
 *   max_handoffs: number,
 *   max_duration_seconds: number,
 *   on_exceeded: string,
 *   breakdown: object,
 *   reason?: string,
 * }>}
 */
async function check(target, ctx) {
  const cfg = await getEffectiveConfig();
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
  const est = await estimate(target, ctx);
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
