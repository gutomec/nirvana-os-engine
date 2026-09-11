// ensure-dir.js — mkdir -p that survives Bun on Windows.
//
// `fs.mkdirSync(dir, { recursive: true })` is documented to succeed when the
// directory already exists. Under Bun on Windows it can throw EEXIST anyway,
// and four places in this engine had already learned that the hard way and
// wrapped it by hand (session-store.ts, squads/lib/registry.js,
// init-project.ts, doctor-system.ts). The per-event paths had not: the audit
// emitter, the hook bridge and the run ledger all called it bare.
//
// Measured on a client's machine, 2026-09-11: two `EEXIST` warnings from the
// ledger while it tried to create the day's audit directory. The ledger catches
// and warns, so the run continued — and the two audit events it was trying to
// write were lost in silence. Losing evidence is the one failure an audit log
// cannot afford.
//
// CommonJS so `harness/lib/audit.js` — the canonical emitter, and CJS — can
// require() it without crossing the ESM boundary Windows enforces as a hard
// error. ensure-dir.ts is the typed face.
'use strict';

const fs = require('fs');

/**
 * Create `dir` and its parents. Returns the directory. An EEXIST from a
 * recursive mkdir is the success case wearing an error's clothes; anything
 * else is a real failure and is rethrown.
 */
function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    if (!isAlreadyExists(e)) throw e;
    // EEXIST also fires when the path is a FILE, and swallowing that would
    // report success for something no caller can write into — the caller would
    // then fail later, somewhere else, with an error about the wrong thing.
    // Tolerating the platform's false alarm must not tolerate a real collision.
    if (!fs.statSync(dir).isDirectory()) throw e;
  }
  return dir;
}

/** The one decision this module makes, exported so it can be tested without
 *  monkeypatching `fs` (Bun makes its exports read-only) and without a Windows
 *  runner: EEXIST from a recursive mkdir means the directory is there, which is
 *  what the caller asked for. Every other error is real. */
function isAlreadyExists(e) {
  return Boolean(e) && e.code === 'EEXIST';
}

module.exports = { ensureDir, isAlreadyExists };
