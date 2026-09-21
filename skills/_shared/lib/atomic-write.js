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
// short and bounded; a real permission error still surfaces, because the last
// attempt rethrows.
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
const RETRIES = 12;
const BACKOFF_MS = 15;

/** A staging path no other process can be holding. */
function stagingPathFor(target) {
  return `${target}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
}

function renameWithRetry(from, to) {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (e) {
      const code = (e && e.code) || '';
      if (attempt >= RETRIES || !SHARING_VIOLATION.has(code)) throw e;
      // Busy-wait: this runs inside synchronous indexer code with no event loop
      // to yield to, and the window a reader holds a registry open is brief.
      const until = Date.now() + BACKOFF_MS;
      while (Date.now() < until) { /* spin */ }
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

module.exports = { writeFileAtomic, stagingPathFor };
