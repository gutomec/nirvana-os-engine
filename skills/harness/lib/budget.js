/**
 * Pre-flight cost estimator for harness invocations (Stage 4).
 *
 * Reads optional ~/.nirvana/skills/harness/config.yaml and merges defaults from
 * Harness Protocol v1 §5.1. Parses with the `yaml` package (Bun-native); a tiny
 * inline parser is the final fallback if the package can't be resolved.
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
const CONFIG_PATH = path.join(HARNESS_ROOT, 'config.yaml');

// Defaults sized so Nirvana stays out of the way. A cap of 0 (or any value <= 0)
// means UNLIMITED: the pre-flight is a no-op. Set a positive value to enforce a
// hard cap; tighten on a per-business basis if needed.
const DEFAULTS = Object.freeze({
  budget: {
    default_max_cost_usd: 0,               // 0 = unlimited
    default_max_tokens: 0,                  // 0 = unlimited
    default_max_handoffs: 0,                // 0 = unlimited
    default_max_duration_seconds: 0,        // 0 = unlimited
    on_budget_exceeded: 'warn',
    auto_invoke_budget_usd: 0,              // 0 = unlimited
  },
  baselines: {
    squad_capability_usd: 0.30,
    business_usd: 0.80,
    per_handoff_usd: 0.05,
  },
});

/**
 * Read the harness YAML config (if present). Tries python3 first; falls back
 * to a tiny inline parser supporting top-level mappings (one level of nesting,
 * scalars, and lists of strings). Returns {} on missing file.
 */
function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) return {};
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  try {
    const YAML = require('yaml');
    return YAML.parse(raw) || {};
  } catch (_) {
    return inlineYamlParse(raw);
  }
}

/**
 * Tiny YAML parser — only enough for our config.yaml shape:
 *   key: value
 *   nested:
 *     key: value
 *     key: value
 * Strings/numbers/booleans only. Comments (#) supported.
 */
function inlineYamlParse(src) {
  const out = {};
  const lines = src.split('\n').map((l) => l.replace(/#.*$/, ''));
  let cur = out;
  let stack = [{ indent: -1, ref: out }];

  for (const raw of lines) {
    if (!raw.trim()) continue;
    const indent = raw.length - raw.trimStart().length;
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    cur = stack[stack.length - 1].ref;

    const m = raw.trim().match(/^([A-Za-z0-9_]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const [, key, val] = m;

    if (val === '' || val === '~') {
      cur[key] = {};
      stack.push({ indent, ref: cur[key] });
    } else if (/^(true|false)$/.test(val)) {
      cur[key] = val === 'true';
    } else if (/^-?\d+(\.\d+)?$/.test(val)) {
      cur[key] = Number(val);
    } else {
      cur[key] = val.replace(/^["']|["']$/g, '');
    }
  }
  return out;
}

/**
 * Merge user config over defaults (shallow per top-level key).
 */
function getEffectiveConfig() {
  const user = loadConfig();
  return {
    budget: Object.assign({}, DEFAULTS.budget, (user && user.budget) || {}),
    baselines: Object.assign({}, DEFAULTS.baselines, (user && user.baselines) || {}),
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
