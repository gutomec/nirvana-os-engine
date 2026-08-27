// backup.ts — backup and rollback around the `--fix` loop.
//
// `fs.cpSync`, never rsync: the CI matrix runs Windows, where rsync does not
// exist (improve-squad.ts:104 was the precedent to avoid). Backups go to
// `$NIRVANA_HOME/.nirvana/verify-backups/<kind>/<slug>.<ts>/`; the last five
// per entity are kept. Restore is rm + cpSync, so a rolled-back entity is
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
  // sorts after `<t>` minted later), and `prune` keeps the newest by that very
  // order — so a collision could delete the newest backup and keep an older one.
  // With the stamp fixed, `<t>`, `<t>-1`, `<t>-2` sort exactly as they were made.
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

export function listBackups(kind: Kind, slug: string, root: string = defaultBackupRoot()): string[] {
  const parent = path.join(root, kind);
  if (!fs.existsSync(parent)) return [];
  return fs.readdirSync(parent)
    .filter((n) => n.startsWith(`${slug}.`))
    .sort()
    .map((n) => path.join(parent, n));
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
