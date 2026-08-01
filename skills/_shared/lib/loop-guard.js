/**
 * loop-guard.js — stuck-loop detector for agentic iteration.
 *
 * Pattern (Agent Patterns 2026): detect when an agent is repeating itself
 * without producing new information. Three orthogonal signals:
 *
 *   1. max_steps      — hard ceiling. If we go past it, stop unconditionally.
 *   2. max_repeat     — same action signature N times = treadmill. Stop.
 *   3. max_flat_steps — N consecutive steps without progress marker change. Stop.
 *
 * Caller responsibilities:
 *   - On every iteration, call .record(action_signature, progress_marker?)
 *   - Then call .check(); if .stop is true, halt and surface the reason.
 *   - progress_marker is OPTIONAL but strongly recommended — without it,
 *     max_flat_steps is never tripped. Use a hash of the latest produced
 *     artifact (e.g. patches.length, slugs_promoted, dag_nodes_completed).
 *
 * Zero deps, pure JS, framework-agnostic.
 */

'use strict';

const crypto = require('crypto');

function stableSig(action, args) {
  if (args === undefined || args === null) return String(action);
  // Stable JSON: sort keys recursively so semantically equal args hash equal.
  const normalize = (v) => {
    if (Array.isArray(v)) return v.map(normalize);
    if (v && typeof v === 'object') {
      return Object.keys(v).sort().reduce((acc, k) => { acc[k] = normalize(v[k]); return acc; }, {});
    }
    return v;
  };
  let s;
  try { s = JSON.stringify(normalize(args)); } catch { s = String(args); }
  return `${action}::${crypto.createHash('sha1').update(s).digest('hex').slice(0, 12)}`;
}

function createLoopGuard(opts) {
  const cfg = Object.assign({}, {
    max_steps: 12,
    max_repeat: 3,
    max_flat_steps: 4,
  }, opts || {});

  const state = {
    step_count: 0,
    seen_signatures: new Map(),
    last_progress_step: 0,
    progress_marker: null,
    history: [],  // [{ step, signature, progress_marker, ts }]
  };

  return {
    cfg,
    state,
    /**
     * Record one iteration.
     * @param {string} action — identifier (e.g. 'consensus_round', 'improve_squad')
     * @param {*} args — args object. Stably hashed so {a:1,b:2}==={b:2,a:1}.
     * @param {*} [progress_marker] — anything; if changed since last call,
     *                                 resets last_progress_step. Use a hash
     *                                 of produced artifacts (patches count,
     *                                 promoted_squads count, etc.).
     */
    record(action, args, progress_marker) {
      state.step_count++;
      const sig = stableSig(action, args);
      state.seen_signatures.set(sig, (state.seen_signatures.get(sig) || 0) + 1);
      if (progress_marker !== undefined && progress_marker !== state.progress_marker) {
        state.last_progress_step = state.step_count;
        state.progress_marker = progress_marker;
      }
      state.history.push({
        step: state.step_count,
        signature: sig,
        progress_marker: progress_marker ?? null,
        ts: new Date().toISOString(),
      });
    },
    /**
     * Check guards. Returns:
     *   { stop: false }  — keep going
     *   { stop: true, reason, ...details }  — halt the loop
     *
     * Reasons: 'max_steps_reached' | 'repeated_action' | 'no_progress'
     */
    check() {
      if (state.step_count >= cfg.max_steps) {
        return {
          stop: true,
          reason: 'max_steps_reached',
          step_count: state.step_count,
          max_steps: cfg.max_steps,
        };
      }
      for (const [sig, count] of state.seen_signatures) {
        if (count >= cfg.max_repeat) {
          return {
            stop: true,
            reason: 'repeated_action',
            signature: sig,
            count,
            max_repeat: cfg.max_repeat,
          };
        }
      }
      const flat = state.step_count - state.last_progress_step;
      if (flat >= cfg.max_flat_steps && state.step_count > 0) {
        return {
          stop: true,
          reason: 'no_progress',
          flat_steps: flat,
          max_flat_steps: cfg.max_flat_steps,
          last_progress_step: state.last_progress_step,
        };
      }
      return { stop: false, step_count: state.step_count };
    },
    /**
     * Snapshot — for HANDOFF.json or audit log.
     */
    snapshot() {
      return {
        cfg: { ...cfg },
        step_count: state.step_count,
        last_progress_step: state.last_progress_step,
        progress_marker: state.progress_marker,
        seen_signatures: Object.fromEntries(state.seen_signatures),
        history_tail: state.history.slice(-5),
      };
    },
  };
}

module.exports = { createLoopGuard, stableSig };
