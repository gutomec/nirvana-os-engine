import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join, relative, sep } from "node:path";

export type ManagedOwnership = "engine-managed" | "pack-managed" | "user-owned";
export type UpdateRiskReason = "managed-drift" | "user-owned-collision" | "legacy-baseline";

export interface ManagedUpdateRisk {
  ownership: ManagedOwnership;
  reason: UpdateRiskReason;
  owner_id: string;
  kind: string;
  slug: string;
  target_path: string;
  base_version?: string | null;
  incoming_version?: string | null;
  base_hash?: string | null;
  installed_hash: string;
  incoming_hash?: string | null;
  snapshot_excludes?: string[];
}

export interface ManagedCollectionSpec {
  ownership: Exclude<ManagedOwnership, "user-owned">;
  ownerId: string;
  kind: string;
  sourceRoot: string;
  targetRoot: string;
  incomingSlugs: string[];
  installedHashes: Record<string, string>;
  excludes?: string[];
  baseVersion?: string | null;
  incomingVersion?: string | null;
}

function isExcluded(rel: string, excludes: string[]): boolean {
  return excludes.some((entry) => rel === entry || rel.startsWith(`${entry}/`));
}

function listFiles(root: string, excludes: string[]): string[] {
  const files: string[] = [];
  const walk = (dir: string, base: string): void => {
    for (const entry of readdirSync(dir)) {
      const absolute = join(dir, entry);
      const relative = base ? `${base}/${entry}` : entry;
      // Skip excluded directories before stat/recurse. Installed skill trees
      // contain node_modules junctions; traversing one just to filter its files
      // later turns a millisecond preflight into minutes on Windows.
      if (isExcluded(relative, excludes)) continue;
      let stat;
      try { stat = statSync(absolute); } catch { continue; }
      if (stat.isDirectory()) walk(absolute, relative);
      else files.push(relative);
    }
  };
  if (existsSync(root)) walk(root, "");
  return files;
}

/** Stable content hash for the files an owner is allowed to replace. */
export function hashManagedTree(root: string, excludes: string[] = []): string {
  const hash = createHash("sha256");
  for (const relative of listFiles(root, excludes).sort()) {
    hash.update(relative);
    hash.update("\0");
    try { hash.update(readFileSync(join(root, relative))); } catch { /* unreadable files do not become overwrite permission */ }
  }
  return hash.digest("hex");
}

/**
 * Classify update risks without writing anything. The previous manifest hash is
 * the ownership boundary: matching content is managed; a mismatch is local
 * drift. A target with no manifest entry is user-owned unless it already equals
 * the incoming component byte-for-byte, in which case adopting it is harmless.
 */
export function collectManagedUpdateRisks(spec: ManagedCollectionSpec): ManagedUpdateRisk[] {
  const risks: ManagedUpdateRisk[] = [];
  const excludes = spec.excludes ?? [];
  const incoming = new Set(spec.incomingSlugs);

  for (const slug of spec.incomingSlugs) {
    const source = join(spec.sourceRoot, slug);
    const target = join(spec.targetRoot, slug);
    if (!existsSync(target)) continue;

    const installedHash = hashManagedTree(target, excludes);
    const incomingHash = hashManagedTree(source, excludes);
    const baseHash = spec.installedHashes[slug];

    if (!baseHash) {
      if (installedHash === incomingHash) continue;
      risks.push({
        ownership: "user-owned",
        reason: "user-owned-collision",
        owner_id: spec.ownerId,
        kind: spec.kind,
        slug,
        target_path: target,
        base_version: spec.baseVersion,
        incoming_version: spec.incomingVersion,
        base_hash: null,
        installed_hash: installedHash,
        incoming_hash: incomingHash,
        snapshot_excludes: excludes,
      });
      continue;
    }

    if (installedHash !== baseHash && installedHash !== incomingHash) {
      risks.push({
        ownership: spec.ownership,
        reason: "managed-drift",
        owner_id: spec.ownerId,
        kind: spec.kind,
        slug,
        target_path: target,
        base_version: spec.baseVersion,
        incoming_version: spec.incomingVersion,
        base_hash: baseHash,
        installed_hash: installedHash,
        incoming_hash: incomingHash,
        snapshot_excludes: excludes,
      });
    }
  }

  // A component removed by its owner is safe to remove only when the installed
  // files still equal the last owner-provided version.
  for (const [slug, baseHash] of Object.entries(spec.installedHashes)) {
    if (incoming.has(slug)) continue;
    const target = join(spec.targetRoot, slug);
    if (!existsSync(target)) continue;
    const installedHash = hashManagedTree(target, excludes);
    if (installedHash === baseHash) continue;
    risks.push({
      ownership: spec.ownership,
      reason: "managed-drift",
      owner_id: spec.ownerId,
      kind: spec.kind,
      slug,
      target_path: target,
      base_version: spec.baseVersion,
      incoming_version: spec.incomingVersion,
      base_hash: baseHash,
      installed_hash: installedHash,
      incoming_hash: null,
      snapshot_excludes: excludes,
    });
  }

  return risks;
}

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

/** Full-copy snapshot plus the hashes needed to understand and reapply a customization. */
export function createCustomizationSnapshot(
  risks: ManagedUpdateRisk[],
  snapshotRoot: string,
): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = join(snapshotRoot, stamp);
  mkdirSync(runDir, { recursive: true });

  const items = risks.map((risk) => {
    const snapshotPath = join(runDir, safeSegment(risk.kind), safeSegment(risk.slug));
    const excludes = risk.snapshot_excludes ?? [];
    cpSync(risk.target_path, snapshotPath, {
      recursive: true,
      dereference: false,
      filter: (source) => {
        const rel = relative(risk.target_path, source).split(sep).join("/");
        return rel === "" || !isExcluded(rel, excludes);
      },
    });
    return { ...risk, snapshot_path: snapshotPath };
  });

  writeFileSync(join(runDir, "metadata.json"), JSON.stringify({
    schema_version: "1.0",
    created_at: new Date().toISOString(),
    recovery: "Keep managed files immutable. Reapply the saved customization as a user-owned overlay, a new component slug, or a fork, then rerun the update.",
    items,
  }, null, 2) + "\n");
  return runDir;
}

export function reportBlockedUpdate(risks: ManagedUpdateRisk[], snapshotDir?: string): void {
  console.error("");
  console.error(`UPDATE BLOCKED: ${risks.length} customization risk(s) must be resolved before managed content can be replaced.`);
  for (const risk of risks) {
    const label = risk.reason === "user-owned-collision" ? "user-owned collision" : `${risk.ownership} drift`;
    console.error(`  ! ${risk.kind}/${risk.slug}: ${label}`);
  }
  if (snapshotDir) console.error(`  Recoverable snapshot: ${snapshotDir}`);
  console.error("  Keep engine/pack-managed files immutable. Move changes to a user-owned overlay, a new slug, or a fork, then rerun the update.");
}
