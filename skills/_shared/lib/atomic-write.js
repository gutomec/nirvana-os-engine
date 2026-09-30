// atomic-write.js — replace a file whole, from several processes at once.
//
// Three registries staged their writes three different ways, and two were
// wrong in a different direction:
//
//   · the squads registry used `<target>.tmp` — ONE path shared by every
//     process, so the first rename moved it and the rest threw
//     `ENOENT ... rename '<target>.tmp' -> '<target>'`. Measured at 9 of 10
//     concurrent writers dying on a cold start, which is exactly when sibling
//     children each reindex.
//   · the businesses registry wrote straight onto the target, leaving a reader
//     free to parse a half-written file.
//   · the clones registry got it right and kept its own private copy of the
//     logic, which is how the other two stayed wrong.
//
// So it lives here once. Two properties, and the second is the one that is easy
// to get wrong:
//
// UNIQUE STAGING. The temp name carries the pid AND a random suffix. The pid
// alone is not enough: containers recycle pids, and two runs can hold the same
// one.
//
// RENAME RETRY. `rename(2)` replaces atomically on POSIX. On Windows it fails
// outright when another process has the target open — a sharing violation,
// surfacing as EPERM, EACCES or EBUSY — and a registry that several indexers
// read while one writes hits exactly that. With unique staging names and no
// retry, 5 of 10 concurrent writers still died on windows-latest. The retry is
// bounded by time, not by count: twelve fixed 15 ms spins (180 ms) still lost a
// writer on windows-latest, and ten processes spinning on a two-core runner
// starve the very reader that holds the file. So the wait sleeps, backs off
// exponentially with jitter, and gives up after RETRY_BUDGET_MS; a real
// permission error still surfaces, because the last attempt rethrows.
//
// CommonJS, and a `.js` on purpose: the squads registry is `.js`, and
// `require()` of a `.ts` file from a `.js` file throws
// `TypeError: require() async module` on Windows. scripts/check-no-ts-require-in-js.ts
// gates that shape, and it caught this module's first draft.
'use strict';

const fs = require('fs');
const path = require('path');

/** Transient on Windows when a reader holds the target; permanent elsewhere. */
const SHARING_VIOLATION = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RETRY_BUDGET_MS = 2000;
const BACKOFF_MS = 15;
const BACKOFF_CAP_MS = 250;

/** A synchronous sleep that yields the CPU, unlike a spin. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** A staging path no other process can be holding. */
function stagingPathFor(target) {
  return `${target}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
}

function renameWithRetry(from, to) {
  const deadline = Date.now() + RETRY_BUDGET_MS;
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (e) {
      const code = (e && e.code) || '';
      const left = deadline - Date.now();
      if (left <= 0 || !SHARING_VIOLATION.has(code)) throw e;
      // Synchronous indexer code has no event loop to yield to, so it sleeps
      // the thread. The jitter keeps the writers from retrying in lockstep.
      const backoff = Math.min(BACKOFF_MS * 2 ** attempt, BACKOFF_CAP_MS);
      sleepSync(Math.min(left, backoff / 2 + Math.random() * backoff / 2));
    }
  }
}

/**
 * Writes `contents` to `target` so a concurrent reader sees the whole old file
 * or the whole new one, never a partial. Creates the parent directory.
 * The staging file is removed if anything throws.
 */
function writeFileAtomic(target, contents) {
  const staging = stagingPathFor(target);
  // EEXIST tolerated: on Windows Bun may throw it even with recursive:true.
  try { fs.mkdirSync(path.dirname(target), { recursive: true }); }
  catch (e) { if (e && e.code !== 'EEXIST') throw e; }
  try {
    fs.writeFileSync(staging, contents);
    renameWithRetry(staging, target);
  } catch (e) {
    try { fs.rmSync(staging, { force: true }); } catch { /* best effort */ }
    throw e;
  }
}

module.exports = { writeFileAtomic, stagingPathFor, renameWithRetry };
