// config-backup.ts — one copy of a user's config before we touch it, and a
// bounded number of them afterwards.
//
// Every writer that edits a file the USER owns — Codex's config.toml, Hermes's
// config.yaml and allowlist, an agent's settings.json — takes a backup first.
// Each one was inventing its own name with a fresh nonce, and nothing ever
// removed one. A machine that reinstalls monthly accumulates a backup per write
// per file, forever, in the user's own config directory. The engine has a
// doctor check for exactly this shape of litter elsewhere; it should not be the
// one producing it.
//
// A cap rather than a single fixed name: the point of the backup is to recover
// from a bad write, and a fixed name is overwritten by the next write — which,
// if two runs go wrong in a row, is the copy you needed. Keeping the newest few
// costs kilobytes and survives that.
import * as fs from "node:fs";
import * as path from "node:path";

/** How many backups of one file survive. The newest are kept. */
export const BACKUP_KEEP = 3;

const SUFFIX = ".nirvana-backup.";

/**
 * Copies `file` to `<file>.nirvana-backup.<nonce>` and prunes the older ones
 * down to `keep`. Returns the backup path.
 *
 * `COPYFILE_EXCL` so a nonce collision fails loudly instead of overwriting a
 * backup someone may be about to need. Pruning is best-effort: a backup that
 * cannot be removed is litter, and failing the write over it would turn a
 * housekeeping problem into a lost configuration edit.
 */
export function backupConfig(file: string, nonce: string, keep = BACKUP_KEEP): string {
  const target = `${file}${SUFFIX}${nonce}`;
  fs.copyFileSync(file, target, fs.constants.COPYFILE_EXCL);
  // The copy just made is protected by name, not by timestamp. Several backups
  // written inside the same millisecond carry the same mtime — routine on a
  // fast filesystem — and the sort between them is arbitrary, so pruning by
  // time alone can delete the one that was just taken. Which is the only one
  // the caller is about to need.
  pruneBackups(file, keep, target);
  return target;
}

/** Removes all but the newest `keep` backups of `file`. `protect` always survives. */
export function pruneBackups(file: string, keep = BACKUP_KEEP, protect?: string): number {
  const dir = path.dirname(file);
  const prefix = `${path.basename(file)}${SUFFIX}`;
  let names: string[];
  try { names = fs.readdirSync(dir).filter((n) => n.startsWith(prefix)); } catch { return 0; }
  if (names.length <= keep) return 0;
  // By mtime, because the nonce carries a timestamp in some writers and not in
  // others — sorting the name would order them differently per writer.
  const dated = names.map((n) => {
    const full = path.join(dir, n);
    let mtime = 0;
    try { mtime = fs.statSync(full).mtimeMs; } catch { /* unreadable sorts oldest */ }
    return { full, mtime };
    // Name as the tiebreak, so the same directory prunes the same way twice.
  }).sort((a, b) => b.mtime - a.mtime || (a.full < b.full ? 1 : a.full > b.full ? -1 : 0));
  const kept = protect ? [protect, ...dated.map((d) => d.full).filter((p) => p !== protect)] : dated.map((d) => d.full);
  let removed = 0;
  for (const old of kept.slice(keep).map((full) => ({ full }))) {
    try { fs.rmSync(old.full); removed++; } catch { /* litter beats a failed write */ }
  }
  return removed;
}
