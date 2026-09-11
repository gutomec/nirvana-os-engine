// model-json.js — pull a JSON object out of whatever a runtime printed around it.
//
// Every decision point in this engine that asks a model for JSON used the same
// line: `text.match(/\{[\s\S]*\}/)`. That regex is greedy — it spans from the
// FIRST `{` in the whole output to the LAST `}`. It works on a runtime that
// prints the answer and nothing else, and it fails on every runtime that wraps
// the final message in an event stream: the span opens inside the telemetry and
// closes inside the answer, so it never parses.
//
// Measured 2026-09-11 on a client's machine: with Codex as the session runtime,
// the business director answered correctly and the run died with "invalid
// director JSON", which the maestro then read as "this business does not work"
// and replaced with `agent-x`. The same line appears in the reviewer's verdict,
// the quality gate's judge, the squad audit consensus and the squad audit
// verifier — so the whole decision surface of the engine degraded on one
// runtime and nobody could see why.
//
// CommonJS on purpose: `skills/squads/lib/*.js` are CJS and must `require()`
// this directly, which is the boundary Windows enforces as a hard error for a
// `.ts`. model-json.ts is the typed face. Same shape as log-paths.js/.ts.
'use strict';

/**
 * Every balanced `{...}` in `text` that parses as JSON, in the order they
 * appear. Braces inside strings do not count, and an object that does not
 * parse is skipped rather than aborting the scan.
 */
function jsonObjectsIn(text) {
  const out = [];
  const s = typeof text === 'string' ? text : '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '{') continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let j = i; j < s.length; j++) {
      const ch = s[j];
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { if (inString) escaped = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{') { depth++; continue; }
      if (ch !== '}') continue;
      if (--depth > 0) continue;
      try { out.push(JSON.parse(s.slice(i, j + 1))); } catch (_) { /* not readable — keep scanning */ }
      i = j;    // resume AFTER this object, never inside it
      break;
    }
  }
  return out;
}

/**
 * The object a model meant to return.
 *
 * `accept` decides which candidates count (e.g. "has a `chain` array", "has a
 * `verdict`"). The LAST accepted object wins: a model's answer comes after its
 * telemetry and after any thinking it printed, and when it corrects itself the
 * correction is the later one. Returns null when nothing qualifies — which the
 * caller must treat as "no answer", never as an empty answer.
 */
function extractJsonObject(text, accept) {
  const ok = typeof accept === 'function' ? accept : () => true;
  const found = jsonObjectsIn(text);
  for (let i = found.length - 1; i >= 0; i--) {
    if (ok(found[i])) return found[i];
  }
  return null;
}

/** `extractJsonObject` restricted to objects carrying every named key. */
function extractJsonWithKeys(text, keys) {
  const want = Array.isArray(keys) ? keys : [keys];
  return extractJsonObject(text, (v) => v && typeof v === 'object' && want.every((k) => v[k] !== undefined));
}

module.exports = { jsonObjectsIn, extractJsonObject, extractJsonWithKeys };
