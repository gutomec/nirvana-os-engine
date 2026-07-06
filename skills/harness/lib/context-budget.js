/**
 * context-budget.js — heuristic estimator of context window utilization.
 *
 * The harness does not directly observe the host runtime's context window
 * (Claude Code, Codex, etc. own that). What we CAN do is estimate the
 * footprint of audit events emitted during a session and surface a
 * warning when the rough total approaches the configured threshold.
 *
 * Heuristic: 1 token ≈ 4 characters of serialized JSON event. Off by
 * ±20% in practice — good enough for a SIGNAL, never a controller.
 *
 * Recommendation when warning fires: emit a `context_budget_warning`
 * audit event so callers (Glance, harness telemetry) can prompt the user
 * to /clear and resume via HANDOFF.json.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const SKILLS_ROOT = process.env.NIRVANA_SKILLS_DIR
  || (fs.existsSync(path.join(os.homedir(), '.nirvana', 'skills')) ? path.join(os.homedir(), '.nirvana', 'skills') : path.join(os.homedir(), '.claude', 'skills'));

function loadConfig() {
  const candidates = [
    path.join(__dirname, '..', 'config.yaml'),
  ];
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    try {
      const raw = fs.readFileSync(p, 'utf8');
      const out = {};
      let inBlock = false;
      for (const line of raw.split('\n')) {
        if (/^context_budget:\s*$/.test(line)) { inBlock = true; continue; }
        if (inBlock) {
          if (/^\S/.test(line)) { inBlock = false; continue; }
          const m = line.match(/^\s+([a-z_]+):\s*([0-9.]+)/);
          if (m) out[m[1]] = parseFloat(m[2]);
        }
      }
      return out;
    } catch { /* fall through */ }
  }
  return {};
}

const DEFAULTS = {
  threshold_warning_pct: 0.70,
  threshold_critical_pct: 0.85,
  default_window_tokens: 200000,
  chars_per_token: 4,
};

function getConfig() {
  return Object.assign({}, DEFAULTS, loadConfig());
}

function estimateContextBudget(opts) {
  const cfg = getConfig();
  const charsPerToken = cfg.chars_per_token || DEFAULTS.chars_per_token;
  const window_tokens = (opts && opts.window_tokens) || cfg.default_window_tokens;
  const threshold_warning_pct = cfg.threshold_warning_pct;
  const threshold_critical_pct = cfg.threshold_critical_pct;

  let logPath = opts && opts.audit_log_path;
  if (!logPath) {
    const today = new Date().toISOString().slice(0, 10);
    const root = process.env.HARNESS_LOGS_DIR || require(path.join(SKILLS_ROOT, '_shared', 'lib', 'log-paths.ts')).harnessLogsDir();
    logPath = path.join(root, today, 'audit.jsonl');
  }
  if (!fs.existsSync(logPath)) {
    return {
      estimated_tokens: 0,
      window_tokens,
      threshold_pct: 0,
      threshold_warning_pct,
      threshold_critical_pct,
      warning: false,
      critical: false,
      recommendation: null,
      event_count: 0,
      log_path: logPath,
      log_present: false,
    };
  }

  let totalChars = 0;
  let count = 0;
  const filterTrace = opts && opts.trace_id;
  try {
    const lines = fs.readFileSync(logPath, 'utf8').split('\n');
    for (const line of lines) {
      if (!line) continue;
      if (filterTrace) {
        let parsed; try { parsed = JSON.parse(line); } catch { continue; }
        if (parsed.trace_id !== filterTrace) continue;
      }
      totalChars += line.length;
      count++;
    }
  } catch { /* zeros */ }

  const estimated_tokens = Math.round(totalChars / charsPerToken);
  return buildSignal(estimated_tokens, window_tokens, count, {
    threshold_warning_pct, threshold_critical_pct, log_path: logPath, log_present: true,
  });
}

function buildSignal(estimated_tokens, window_tokens, event_count, extra) {
  const threshold_pct = window_tokens > 0 ? estimated_tokens / window_tokens : 0;
  const threshold_warning_pct = (extra && extra.threshold_warning_pct) || DEFAULTS.threshold_warning_pct;
  const threshold_critical_pct = (extra && extra.threshold_critical_pct) || DEFAULTS.threshold_critical_pct;
  const warning = threshold_pct >= threshold_warning_pct;
  const critical = threshold_pct >= threshold_critical_pct;
  let recommendation = null;
  if (critical) recommendation = 'clear-and-resume';
  else if (warning) recommendation = 'consider-clear-soon';
  return {
    estimated_tokens,
    window_tokens,
    threshold_pct: Number(threshold_pct.toFixed(3)),
    threshold_warning_pct,
    threshold_critical_pct,
    warning,
    critical,
    recommendation,
    event_count,
    log_path: extra && extra.log_path,
    log_present: !!(extra && extra.log_present),
  };
}

module.exports = { estimateContextBudget, buildContextBudgetSignal: buildSignal, getConfig };
