// file-lock.ts — cross-process mutual exclusion for read-modify-write cycles
// on small JSON state files (spend-tracker, cooldown-registry).
//
// Mechanism: `mkdir` of a sibling `<file>.lock` directory. mkdir is atomic on
// POSIX and Windows (NTFS) — exactly one contender succeeds; everyone else
// gets EEXIST and polls. No O_EXCL files, no advisory flock (unsupported on
// some filesystems), no async: the callers (spend-tracker, cooldown-registry)
// are synchronous APIs and must stay so.
//
// Stale-lock detection: the winner writes `owner.json` ({ pid, acquired_iso })
// inside the lock dir. A lock is STALE when its owner pid is no longer alive
// (same-host check via `process.kill(pid, 0)`), or when the lock dir's mtime
// is older than `staleMs` (guards against a live-but-hung holder, and against
// an unreadable/partial owner.json). Stale locks are removed and re-contended.
//
// Critical sections here are millisecond-scale (JSON read + write), so the
// defaults (10s acquire timeout, 30s staleness) are generous by 3-4 orders of
// magnitude.

import * as fs from "node:fs";
import * as path from "node:path";

export interface FileLockOpts {
  /** Max ms to wait for acquisition before throwing. Default 10_000. */
  timeoutMs?: number;
  /** Lock dirs older than this (mtime) are treated as stale even if the owner
   * pid looks alive. Default 30_000. */
  staleMs?: number;
  /** Poll interval while contending, in ms. Default 25. */
  pollMs?: number;
}

export interface FileLock {
  /** The lock directory that materializes the lock. */
  dir: string;
  /** Idempotent release. */
  release(): void;
}

function sleepSync(ms: number): void {
  // Bun-native fast path; Atomics.wait fallback keeps the module loadable
  // anywhere without a busy-loop.
  if (typeof Bun !== "undefined" && typeof Bun.sleepSync === "function") {
    Bun.sleepSync(ms);
    return;
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function pidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM = alive but owned by another user; only ESRCH means gone.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function isStale(lockDir: string, staleMs: number): boolean {
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(lockDir).mtimeMs;
  } catch {
    return false; // dir vanished — not stale, just gone; caller re-contends
  }
  if (Date.now() - mtimeMs > staleMs) return true;
  try {
    const owner = JSON.parse(fs.readFileSync(path.join(lockDir, "owner.json"), "utf8")) as { pid?: number };
    return !pidAlive(Number(owner.pid));
  } catch {
    // owner.json missing/partial (winner between mkdir and write, or corrupt):
    // fall back to mtime alone — fresh dir, assume held.
    return false;
  }
}

export function lockDirFor(targetPath: string): string {
  return path.resolve(targetPath) + ".lock";
}

/** Acquire the lock for `targetPath` (blocking, sync). Throws after
 * `timeoutMs` of contention against a live holder. */
export function acquireLockSync(targetPath: string, opts: FileLockOpts = {}): FileLock {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const staleMs = opts.staleMs ?? 30_000;
  const pollMs = opts.pollMs ?? 25;
  const dir = lockDirFor(targetPath);
  fs.mkdirSync(path.dirname(dir), { recursive: true });

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      fs.mkdirSync(dir); // atomic: exactly one contender wins
      try {
        fs.writeFileSync(path.join(dir, "owner.json"), JSON.stringify({ pid: process.pid, acquired_iso: new Date().toISOString() }));
      } catch { /* owner metadata is best-effort; mtime staleness still covers us */ }
      let released = false;
      return {
        dir,
        release() {
          if (released) return;
          released = true;
          try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* already gone */ }
        },
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    if (isStale(dir, staleMs)) {
      // Takeover: remove and re-contend. The rm/mkdir race between multiple
      // takers is safe — the loop re-enters mkdir, one wins, the rest poll.
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* another taker got it */ }
      continue;
    }
    if (Date.now() >= deadline) {
      throw new Error(`file-lock: timed out after ${timeoutMs}ms waiting for ${dir} (held by a live process)`);
    }
    sleepSync(pollMs);
  }
}

/** Run `fn` under the lock for `targetPath`. Always releases, even on throw. */
export function withLock<T>(targetPath: string, fn: () => T, opts: FileLockOpts = {}): T {
  const lock = acquireLockSync(targetPath, opts);
  try {
    return fn();
  } finally {
    lock.release();
  }
}
