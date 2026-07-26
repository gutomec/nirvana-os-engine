/**
 * host-agent-retry.js — caller-side retry wrapper for stalled host calls.
 *
 * The host-agent-driver classifies stalls (no bytes for N seconds) but does
 * not retry. This wrapper provides:
 *   - Automatic retry when `error === 'stall'`
 *   - Optional `retryReducer(originalUserMsg, attempt)` to shrink the prompt
 *     for the retry (split task, drop context, etc).
 *   - Audit emission of `stall_detected` and `stall_retry` events.
 *
 * Host-agnostic: delegates to `callHostAgentAsync` which already handles
 * Claude Code, Codex, Gemini CLI, Qwen, OpenCode, etc.
 *
 * Usage:
 *   const r = await callWithRetryOnStall(persona, userMsg, {
 *     heartbeatMs: 60_000,
 *     timeoutMs: 240_000,
 *     maxRetries: 1,                // default 1; 0 disables retry
 *     retryReducer: (msg, attempt) => msg.slice(0, msg.length / 2),
 *     onStall: (info) => console.error('[stall]', info),
 *   });
 *
 * Returns the same `HostCall | HostError` shape as the driver.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const SKILLS_ROOT = process.env.NIRVANA_SKILLS_DIR
  || (fs.existsSync(path.join(os.homedir(), ".nirvana", "skills")) ? path.join(os.homedir(), ".nirvana", "skills") : path.join(os.homedir(), ".claude", "skills"));

let _audit = null;
function loadAudit() {
  if (_audit) return _audit;
  try {
    _audit = require(path.join(SKILLS_ROOT, 'harness', 'lib', 'audit.js'));
  } catch { _audit = null; }
  return _audit;
}

let _driver = null;
function loadDriver() {
  if (_driver) return _driver;
  try { _driver = require(path.join(__dirname, 'host-agent-driver.js')); }
  catch {
    try { _driver = require(path.join(__dirname, 'host-agent-driver.ts')); }
    catch { _driver = null; }
  }
  return _driver;
}

function emitSafe(event, payload) {
  const a = loadAudit();
  if (!a || !a.emit) return;
  try { a.emit(event, payload); } catch { /* non-fatal */ }
}

async function callWithRetryOnStall(persona, userMessage, opts = {}) {
  const driver = loadDriver();
  if (!driver || !driver.callHostAgentAsync) {
    return { error: 'host-agent-driver-not-loadable' };
  }
  const maxRetries = Number.isFinite(opts.maxRetries) ? opts.maxRetries : 1;
  const retryReducer = typeof opts.retryReducer === 'function' ? opts.retryReducer : null;
  const onStall = typeof opts.onStall === 'function' ? opts.onStall : null;
  const driverOpts = {
    heartbeatMs: opts.heartbeatMs,
    minBytesPerHeartbeat: opts.minBytesPerHeartbeat,
    heartbeatMode: opts.heartbeatMode,
    timeoutMs: opts.timeoutMs,
  };

  let attempt = 0;
  let currentMsg = userMessage;
  while (true) {
    const r = await driver.callHostAgentAsync(persona, currentMsg, driverOpts);
    const stalled = r && (r.error === 'stall' || r.error === 'stall_warning');
    if (!stalled) return r;
    emitSafe('stall_detected', {
      attempt,
      stalled_after_ms: r.stalled_after_ms,
      bytes_before: r.bytes_received_before_stall,
      host: r.host,
    });
    if (onStall) {
      try { onStall({ attempt, ...r }); } catch { /* non-fatal */ }
    }
    if (attempt >= maxRetries) return r;
    attempt += 1;
    if (retryReducer) {
      try { currentMsg = retryReducer(currentMsg, attempt) || currentMsg; }
      catch { /* keep msg unchanged */ }
    }
    emitSafe('stall_retry', { attempt, host: r.host, msg_chars: currentMsg.length });
  }
}

module.exports = { callWithRetryOnStall };
