// tree-digest.ts — content snapshot of directory trees and the diff between
// two snapshots.
//
// scripts/check-organizational-non-regression.ts snapshots the installed
// businesses, squads and mind-clone roots before and after the entity test
// suites run, so a suite that touches an installed file shows up as a listed
// path instead of a hunch. Symlinks are recorded by their target and never
// followed: a business's dna/ links count as entries of their own, and a link
// pointing outside a root does not pull that tree in. Entries are keyed by
// absolute path in a fixed walk order (roots sorted, names sorted, depth
// first), so two snapshots of an untouched tree compare equal entry by entry.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join, resolve, sep } from "node:path";

export interface TreeEntry {
  /** sha256 of the file content; for a symlink, of the link target. */
  sha256: string;
  /** Byte length of the file content; for a symlink, of the link target. */
  size: number;
  /** The raw link target, present only for symlinks. */
  link?: string;
}

export type TreeSnapshot = Map<string, TreeEntry>;

export interface TreeDiff {
  added: string[];
  removed: string[];
  changed: string[];
}

export interface SnapshotOptions {
  /** Directory names pruned wherever they appear under a root. */
  skipDirs?: ReadonlySet<string>;
}

const sha256 = (data: Uint8Array | string): string => createHash("sha256").update(data).digest("hex");

function walk(dir: string, snapshot: TreeSnapshot, skipDirs: ReadonlySet<string>): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // a root that does not exist, or a directory we cannot read
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      const link = readlinkSync(abs);
      snapshot.set(abs, { sha256: sha256(link), size: Buffer.byteLength(link), link });
    } else if (entry.isDirectory()) {
      if (!skipDirs.has(entry.name)) walk(abs, snapshot, skipDirs);
    } else if (entry.isFile()) {
      const data = readFileSync(abs);
      snapshot.set(abs, { sha256: sha256(data), size: data.byteLength });
    }
  }
}

/** Snapshot of every file and symlink under the roots. A root nested inside
 *  another root is covered by the outer walk and not walked twice. */
export function snapshotTree(roots: string[], options: SnapshotOptions = {}): TreeSnapshot {
  const skipDirs = options.skipDirs ?? new Set<string>();
  const resolved = [...new Set(roots.map((root) => resolve(root)))].sort();
  const snapshot: TreeSnapshot = new Map();
  for (const root of resolved) {
    if (resolved.some((outer) => outer !== root && root.startsWith(outer + sep))) continue;
    walk(root, snapshot, skipDirs);
  }
  return snapshot;
}

export function diffTreeSnapshots(before: TreeSnapshot, after: TreeSnapshot): TreeDiff {
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const [file, entry] of after) {
    const previous = before.get(file);
    if (!previous) added.push(file);
    else if (previous.sha256 !== entry.sha256 || previous.size !== entry.size || previous.link !== entry.link) changed.push(file);
  }
  for (const file of before.keys()) if (!after.has(file)) removed.push(file);
  return { added: added.sort(), removed: removed.sort(), changed: changed.sort() };
}
