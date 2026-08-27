// backup.ts — backup and rollback around the `--fix` loop.
//
// `fs.cpSync`, never rsync: the CI matrix runs Windows, where rsync does not
// exist (improve-squad.ts:104 was the precedent to avoid). Backups go to
// `$NIRVANA_HOME/.nirvana/verify-backups/<kind>/<slug>.<ts>/`; the last five
// per entity are kept, newest by filesystem mtime. Restore is rm + cpSync, so a rolled-back entity is
// byte-identical to the moment before the fixers ran.

import * as fs from "node:fs";
import * as path from "node:path";
import { paths } from "../bun-helpers.ts";
import type { Kind } from "./types.ts";

export const BACKUP_KEEP = 5;
const SKIP = new Set(["node_modules", ".git", "output", "outputs", ".DS_Store"]);

export function defaultBackupRoot(): string {
  const home = (paths as Record<string, string>).NIRVANA_HOME ?? ".";
  return path.join(home, ".nirvana", "verify-backups");
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function copyTree(src: string, dst: string): void {
  fs.cpSync(src, dst, {
    recursive: true,
    // Symlinks are copied as links (a business `dna/` dir points at clones the
    // backup must not duplicate). On Windows a link copy may fail without
    // Developer Mode; that is the one case where cpSync is allowed to throw.
    verbatimSymlinks: true,
    filter: (p) => !SKIP.has(path.basename(p)),
  });
}

export function createBackup(dir: string, kind: Kind, slug: string, root: string = defaultBackupRoot()): string {
  const parent = path.join(root, kind);
  fs.mkdirSync(parent, { recursive: true });
  // One stamp per call. Re-stamping inside the loop below produced names whose
  // lexicographic order was not their creation order (`<t>-1` minted at t+1ms
  // sorts after `<t>` minted later). Retention no longer reads chronology off
  // the names (see `listBackups`), so that alone can no longer delete the newest
  // backup; the fixed stamp stays because `<t>`, `<t>-1`, `<t>-2` is the tie
  // order the filesystem falls back on when it cannot separate them in time.
  const at = stamp();
  let dst = path.join(parent, `${slug}.${at}`);
  let n = 0;
  while (fs.existsSync(dst)) dst = path.join(parent, `${slug}.${at}-${++n}`);
  copyTree(dir, dst);
  prune(kind, slug, root);
  return dst;
}

export function restoreBackup(backupDir: string, dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  copyTree(backupDir, dir);
}

/** mtime in ms; 0 for a directory that vanished under us (a parallel prune). */
function mtimeOf(p: string): number {
  try { return fs.statSync(p).mtimeMs; } catch { return 0; }
}

/**
 * The backups of one entity, **oldest first**. `prune` deletes off the front of
 * this list, so the order is the retention rule and has to be real time.
 *
 * It used to be `.sort()` on the names — which reads chronology out of a string
 * and so assumes every writer stamps the way `stamp()` does. The assumption has
 * broken twice. First from inside: a re-stamp in the collision loop of
 * `createBackup` minted `<t>-1` at t+1ms, sorting it after a later `<t>`. Then
 * from outside, on 2026-08-27: an agent wrote its own backup of
 * `nirvana-crypto-trading` beside the engine's, stamping local time in basic ISO
 * (`.20260827T152722`) against the engine's UTC extended ISO
 * (`.2026-08-27T18-27-22-440Z`). Same second, opposite sort — `-` (0x2D) < `0`
 * (0x30) at the fourth character — so the engine's newer copy read as the oldest
 * and was first in line to be deleted.
 *
 * mtime is the only clock every writer sets, including writers whose stamp
 * format does not exist yet; parsing the name can only ever cover the formats we
 * already know, which is the shape of both failures. Names break ties, so
 * backups the filesystem cannot separate in time still list in a stable,
 * reproducible order — never as a claim about which is newer.
 *
 * What this does not cover: mtime is writable. A `touch`, or a copy that does
 * not preserve times, can make an old backup look new and buy it a slot the
 * newest backup then loses. Restores are unaffected — they take the path
 * `createBackup` returned, never a path this order picked.
 */
export function listBackups(kind: Kind, slug: string, root: string = defaultBackupRoot()): string[] {
  const parent = path.join(root, kind);
  if (!fs.existsSync(parent)) return [];
  return fs.readdirSync(parent)
    .filter((n) => n.startsWith(`${slug}.`))
    .map((n) => path.join(parent, n))
    .map((p) => ({ p, at: mtimeOf(p) }))
    .sort((a, b) => a.at - b.at || (a.p < b.p ? -1 : a.p > b.p ? 1 : 0))
    .map((e) => e.p);
}

/** Keeps the newest BACKUP_KEEP backups of an entity, removes the rest. */
export function prune(kind: Kind, slug: string, root: string = defaultBackupRoot()): string[] {
  const all = listBackups(kind, slug, root);
  const drop = all.slice(0, Math.max(0, all.length - BACKUP_KEEP));
  for (const d of drop) fs.rmSync(d, { recursive: true, force: true });
  return drop;
}

/**
 * Runs `fn` after taking a backup. The caller decides whether to roll back
 * (fixer threw, loader broke, a new error appeared) by calling `restore()`.
 */
export function withBackup<T>(
  dir: string, kind: Kind, slug: string, root: string | undefined,
  fn: (restore: () => void, backupDir: string) => T,
): { result: T; backup: string } {
  const backup = createBackup(dir, kind, slug, root);
  const restore = () => restoreBackup(backup, dir);
  const result = fn(restore, backup);
  return { result, backup };
}
