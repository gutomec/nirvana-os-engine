import {
  closeSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  rmSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

export type ManagedOwnership = "engine-managed" | "pack-managed" | "user-owned";
export type UpdateRiskReason =
  | "managed-drift"
  | "user-owned-collision"
  | "legacy-baseline"
  | "runtime-mirror-drift"
  | "unsafe-link"
  | "concurrent-change";

export interface UnsafeManagedLink {
  relative_path: string;
  link_target?: string;
  resolved_target?: string;
  outside_root?: boolean;
}

export interface ManagedTreeInspection {
  hash: string;
  managed_file_count: number;
  unsafe_links: UnsafeManagedLink[];
}

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
  unsafe_links?: UnsafeManagedLink[];
  lock_path?: string;
  lock_status?: string;
  recovery?: string;
}

export interface ManagedTargetObservation extends Omit<ManagedUpdateRisk, "reason"> {
  target_exists: boolean;
  managed_file_count: number;
}

export interface ObserveManagedTargetSpec {
  ownership: Exclude<ManagedOwnership, "user-owned">;
  ownerId: string;
  kind: string;
  slug: string;
  targetPath: string;
  baseHash?: string | null;
  incomingHash?: string | null;
  excludes?: string[];
  baseVersion?: string | null;
  incomingVersion?: string | null;
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

export interface ManagedUpdatePlan {
  risks: ManagedUpdateRisk[];
  observations: ManagedTargetObservation[];
}

function isExcluded(rel: string, excludes: string[]): boolean {
  return excludes.some((entry) => rel === entry || rel.startsWith(`${entry}/`));
}

function isAncestorOfExcluded(rel: string, excludes: string[]): boolean {
  return excludes.some((entry) => entry.startsWith(`${rel}/`));
}

function existsWithoutFollowing(path: string): boolean {
  try { lstatSync(path); return true; } catch { return false; }
}

function portableRelative(root: string, path: string): string {
  return relative(root, path).split(sep).join("/") || ".";
}

function isContained(root: string, candidate: string): boolean {
  const normalizedRoot = resolve(root).toLowerCase();
  const normalizedCandidate = resolve(candidate).toLowerCase();
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}${sep}`);
}

/** Hash regular managed files. Describe links/junctions but never follow them. */
export function inspectManagedTree(root: string, excludes: string[] = []): ManagedTreeInspection {
  const files: string[] = [];
  const unsafeLinks: UnsafeManagedLink[] = [];
  let rootReal = resolve(root);

  try {
    const rootStat = lstatSync(root);
    if (rootStat.isSymbolicLink()) {
      let linkTarget: string | undefined;
      let resolvedTarget: string | undefined;
      try { linkTarget = readlinkSync(root); } catch {}
      try { resolvedTarget = realpathSync(root); } catch {}
      unsafeLinks.push({ relative_path: ".", link_target: linkTarget, resolved_target: resolvedTarget, outside_root: true });
      return { hash: createHash("sha256").digest("hex"), managed_file_count: 0, unsafe_links: unsafeLinks };
    }
    rootReal = realpathSync(root);
  } catch {
    return { hash: createHash("sha256").digest("hex"), managed_file_count: 0, unsafe_links: [] };
  }

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const absolute = join(dir, entry);
      const rel = portableRelative(root, absolute);
      if (isExcluded(rel, excludes)) continue;
      let stat;
      try { stat = lstatSync(absolute); } catch { continue; }
      if (stat.isSymbolicLink()) {
        let linkTarget: string | undefined;
        let resolvedTarget: string | undefined;
        try { linkTarget = readlinkSync(absolute); } catch {}
        try { resolvedTarget = realpathSync(absolute); } catch {}
        unsafeLinks.push({
          relative_path: rel,
          link_target: linkTarget,
          resolved_target: resolvedTarget,
          outside_root: resolvedTarget ? !isContained(rootReal, resolvedTarget) : undefined,
        });
        continue;
      }
      if (stat.isDirectory()) {
        let directoryReal: string;
        try { directoryReal = realpathSync(absolute); } catch { continue; }
        if (!isContained(rootReal, directoryReal)) {
          unsafeLinks.push({ relative_path: rel, resolved_target: directoryReal, outside_root: true });
          continue;
        }
        walk(absolute);
      } else if (stat.isFile()) {
        files.push(rel);
      }
    }
  };
  walk(root);

  const hash = createHash("sha256");
  for (const rel of files.sort()) {
    hash.update(rel);
    hash.update("\0");
    try { hash.update(readFileSync(join(root, rel))); } catch { /* unreadable content never grants overwrite permission */ }
  }
  return { hash: hash.digest("hex"), managed_file_count: files.length, unsafe_links: unsafeLinks };
}

export function hashManagedTree(root: string, excludes: string[] = []): string {
  return inspectManagedTree(root, excludes).hash;
}

export function observeManagedTarget(spec: ObserveManagedTargetSpec): ManagedTargetObservation {
  const excludes = spec.excludes ?? [];
  const targetExists = existsWithoutFollowing(spec.targetPath);
  const inspected = inspectManagedTree(spec.targetPath, excludes);
  return {
    ownership: spec.ownership,
    owner_id: spec.ownerId,
    kind: spec.kind,
    slug: spec.slug,
    target_path: spec.targetPath,
    base_version: spec.baseVersion,
    incoming_version: spec.incomingVersion,
    base_hash: spec.baseHash,
    installed_hash: inspected.hash,
    incoming_hash: spec.incomingHash,
    snapshot_excludes: excludes,
    unsafe_links: inspected.unsafe_links,
    target_exists: targetExists,
    managed_file_count: inspected.managed_file_count,
  };
}

function riskFromObservation(observation: ManagedTargetObservation, reason: UpdateRiskReason): ManagedUpdateRisk {
  const { target_exists: _targetExists, managed_file_count: _managedFileCount, ...risk } = observation;
  return { ...risk, reason };
}

export function collectManagedUpdatePlan(spec: ManagedCollectionSpec): ManagedUpdatePlan {
  const risks: ManagedUpdateRisk[] = [];
  const observations: ManagedTargetObservation[] = [];
  const excludes = spec.excludes ?? [];
  const incoming = new Set(spec.incomingSlugs);

  for (const slug of spec.incomingSlugs) {
    const source = join(spec.sourceRoot, slug);
    const target = join(spec.targetRoot, slug);
    const incomingInspection = inspectManagedTree(source, excludes);
    const incomingHash = incomingInspection.hash;
    const baseHash = spec.installedHashes[slug];
    const observation = observeManagedTarget({
      ownership: spec.ownership, ownerId: spec.ownerId, kind: spec.kind, slug,
      targetPath: target, baseHash, incomingHash, excludes,
      baseVersion: spec.baseVersion, incomingVersion: spec.incomingVersion,
    });
    observations.push(observation);
    if (incomingInspection.unsafe_links.length > 0) {
      risks.push({
        ...riskFromObservation(observation, "unsafe-link"),
        target_path: source,
        incoming_hash: incomingHash,
        unsafe_links: incomingInspection.unsafe_links,
      });
      continue;
    }
    if (!observation.target_exists) continue;
    if ((observation.unsafe_links?.length ?? 0) > 0) {
      risks.push(riskFromObservation(observation, "unsafe-link"));
    } else if (!baseHash) {
      if (observation.managed_file_count > 0 && observation.installed_hash !== incomingHash) {
        risks.push({ ...riskFromObservation(observation, "user-owned-collision"), ownership: "user-owned" });
      }
    } else if (observation.installed_hash !== baseHash && observation.installed_hash !== incomingHash) {
      risks.push(riskFromObservation(observation, "managed-drift"));
    }
  }

  for (const [slug, baseHash] of Object.entries(spec.installedHashes)) {
    if (incoming.has(slug)) continue;
    const target = join(spec.targetRoot, slug);
    if (!existsWithoutFollowing(target)) continue;
    const observation = observeManagedTarget({
      ownership: spec.ownership, ownerId: spec.ownerId, kind: spec.kind, slug,
      targetPath: target, baseHash, incomingHash: null, excludes,
      baseVersion: spec.baseVersion, incomingVersion: spec.incomingVersion,
    });
    observations.push(observation);
    if ((observation.unsafe_links?.length ?? 0) > 0) risks.push(riskFromObservation(observation, "unsafe-link"));
    else if (observation.installed_hash !== baseHash) risks.push(riskFromObservation(observation, "managed-drift"));
  }
  return { risks, observations };
}

export function collectManagedUpdateRisks(spec: ManagedCollectionSpec): ManagedUpdateRisk[] {
  return collectManagedUpdatePlan(spec).risks;
}

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

function copySnapshotTree(sourceRoot: string, snapshotRoot: string, excludes: string[]): void {
  let rootStat;
  try { rootStat = lstatSync(sourceRoot); } catch { return; }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return;
  mkdirSync(snapshotRoot, { recursive: true });
  const walk = (sourceDir: string, snapshotDir: string): void => {
    for (const entry of readdirSync(sourceDir)) {
      const source = join(sourceDir, entry);
      const rel = portableRelative(sourceRoot, source);
      if (isExcluded(rel, excludes)) continue;
      let stat;
      try { stat = lstatSync(source); } catch { continue; }
      if (stat.isSymbolicLink()) continue;
      const destination = join(snapshotDir, entry);
      if (stat.isDirectory()) {
        mkdirSync(destination, { recursive: true });
        walk(source, destination);
      } else if (stat.isFile()) {
        mkdirSync(dirname(destination), { recursive: true });
        copyFileSync(source, destination);
      }
    }
  };
  walk(sourceRoot, snapshotRoot);
}

export function createCustomizationSnapshot(risks: ManagedUpdateRisk[], snapshotRoot: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = join(snapshotRoot, stamp);
  mkdirSync(runDir, { recursive: true });
  const items = risks.map((risk) => {
    const snapshotPath = join(runDir, safeSegment(risk.kind), safeSegment(risk.slug));
    copySnapshotTree(risk.target_path, snapshotPath, risk.snapshot_excludes ?? []);
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

export function removeManagedTree(root: string, excludes: string[] = []): void {
  if (!existsWithoutFollowing(root)) return;
  if (excludes.length === 0) {
    rmSync(root, { recursive: true, force: true });
    return;
  }
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const absolute = join(dir, entry);
      const rel = portableRelative(root, absolute);
      if (isExcluded(rel, excludes)) continue;
      let stat;
      try { stat = lstatSync(absolute); } catch { continue; }
      if (stat.isDirectory() && !stat.isSymbolicLink() && isAncestorOfExcluded(rel, excludes)) {
        walk(absolute);
        try { rmdirSync(absolute); } catch { /* excluded descendants keep their ancestors */ }
      } else {
        rmSync(absolute, { recursive: stat.isDirectory() && !stat.isSymbolicLink(), force: true });
      }
    }
  };
  const rootStat = lstatSync(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    rmSync(root, { force: true });
    return;
  }
  walk(root);
  try { rmdirSync(root); } catch { /* retained run-state keeps the component shell */ }
}

export interface GuardedMutationResult {
  ok: boolean;
  risk?: ManagedUpdateRisk;
  snapshot_dir?: string;
  lock_status?: "active" | "orphan-too-young" | "invalid" | "owner-changed";
  lock_path?: string;
  recovery?: string;
}

export class ManagedMutationCommandError extends Error {
  constructor(public readonly command: string, public readonly exitCode: number | null) {
    super(`${command} failed with exit code ${exitCode ?? "unknown"}`);
    this.name = "ManagedMutationCommandError";
  }
}

interface ManagedLockOwner {
  pid: number;
  created_at: string;
  token: string;
  owner_id: string;
  target: string;
}

export const ORPHAN_LOCK_MIN_AGE_MS = 5 * 60_000;

function readLockOwner(lockPath: string): ManagedLockOwner | null {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, "utf8"));
    if (
      !Number.isInteger(parsed?.pid) || parsed.pid <= 0 ||
      typeof parsed?.created_at !== "string" || !Number.isFinite(Date.parse(parsed.created_at)) ||
      typeof parsed?.token !== "string" || parsed.token.length < 8
    ) return null;
    return parsed as ManagedLockOwner;
  } catch { return null; }
}

function processIsActive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

function removeLockOwnedBy(lockPath: string, token: string): boolean {
  const current = readLockOwner(lockPath);
  if (!current || current.token !== token) return false;
  try { unlinkSync(lockPath); return true; } catch { return false; }
}

export function guardManagedMutation(
  observation: ManagedTargetObservation,
  snapshotRoot: string,
  mutate: () => void,
): GuardedMutationResult {
  mkdirSync(dirname(observation.target_path), { recursive: true });
  const lockPath = join(dirname(observation.target_path), `.${basename(observation.target_path)}.nirvana-update.lock`);
  const token = randomUUID();
  const owner: ManagedLockOwner = {
    pid: process.pid,
    created_at: new Date().toISOString(),
    token,
    owner_id: `${observation.owner_id}/${observation.kind}/${observation.slug}`,
    target: observation.target_path,
  };
  let lock: number | undefined;
  const acquire = (): number => {
    const descriptor = openSync(lockPath, "wx");
    writeFileSync(descriptor, JSON.stringify(owner) + "\n");
    return descriptor;
  };
  try { lock = acquire(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = readLockOwner(lockPath);
    let lockStatus: GuardedMutationResult["lock_status"] = "invalid";
    let recovery = `Inspect ${lockPath}. It has no valid Nirvana owner metadata, so it was not removed automatically.`;
    if (existing) {
      const age = Date.now() - Date.parse(existing.created_at);
      if (processIsActive(existing.pid)) {
        lockStatus = "active";
        recovery = `Nirvana update PID ${existing.pid} still owns ${lockPath}; wait for it to finish.`;
      } else if (age < ORPHAN_LOCK_MIN_AGE_MS) {
        lockStatus = "orphan-too-young";
        recovery = `PID ${existing.pid} is unavailable, but the lock is younger than ${ORPHAN_LOCK_MIN_AGE_MS / 60_000} minutes; retry later.`;
      } else if (removeLockOwnedBy(lockPath, existing.token)) {
        try { lock = acquire(); }
        catch (acquireError) {
          if ((acquireError as NodeJS.ErrnoException).code !== "EEXIST") throw acquireError;
          lockStatus = "owner-changed";
          recovery = `The owner of ${lockPath} changed during orphan recovery; the replacement lock was preserved.`;
        }
      } else {
        lockStatus = "owner-changed";
        recovery = `The owner token of ${lockPath} changed during orphan recovery; the replacement lock was preserved.`;
      }
    }
    if (lock === undefined) {
      const current = inspectManagedTree(observation.target_path, observation.snapshot_excludes ?? []);
      const changed: ManagedTargetObservation = {
        ...observation,
        target_exists: existsWithoutFollowing(observation.target_path),
        installed_hash: current.hash,
        managed_file_count: current.managed_file_count,
        unsafe_links: current.unsafe_links,
      };
      const risk: ManagedUpdateRisk = {
        ...riskFromObservation(changed, "concurrent-change"),
        lock_path: lockPath,
        lock_status: lockStatus,
        recovery,
      };
      const snapshotDir = createCustomizationSnapshot([risk], snapshotRoot);
      return { ok: false, risk, snapshot_dir: snapshotDir, lock_status: lockStatus, lock_path: lockPath, recovery };
    }
  }
  try {
    const current = inspectManagedTree(observation.target_path, observation.snapshot_excludes ?? []);
    const targetExists = existsWithoutFollowing(observation.target_path);
    const linksChanged = JSON.stringify(current.unsafe_links) !== JSON.stringify(observation.unsafe_links ?? []);
    if (targetExists !== observation.target_exists || current.hash !== observation.installed_hash || linksChanged || current.unsafe_links.length > 0) {
      const changed: ManagedTargetObservation = {
        ...observation,
        target_exists: targetExists,
        installed_hash: current.hash,
        managed_file_count: current.managed_file_count,
        unsafe_links: current.unsafe_links,
      };
      const risk = riskFromObservation(changed, current.unsafe_links.length > 0 ? "unsafe-link" : "concurrent-change");
      const snapshotDir = createCustomizationSnapshot([risk], snapshotRoot);
      return { ok: false, risk, snapshot_dir: snapshotDir };
    }
    mutate();
    return { ok: true };
  } finally {
    closeSync(lock);
    removeLockOwnedBy(lockPath, token);
  }
}

export function reportBlockedUpdate(risks: ManagedUpdateRisk[], snapshotDir?: string): void {
  console.error("");
  console.error(`UPDATE BLOCKED: ${risks.length} customization risk(s) must be resolved before managed content can be replaced.`);
  for (const risk of risks) {
    const label = risk.reason === "user-owned-collision"
      ? "user-owned collision"
      : risk.reason === "runtime-mirror-drift"
        ? "runtime mirror drift"
        : risk.reason === "unsafe-link"
          ? "link/junction inside managed content"
          : risk.reason === "concurrent-change"
            ? "target changed after preflight"
            : `${risk.ownership} drift`;
    console.error(`  ! ${risk.kind}/${risk.slug}: ${label}`);
    if (risk.recovery) console.error(`    ${risk.recovery}`);
  }
  if (snapshotDir) console.error(`  Recoverable snapshot: ${snapshotDir}`);
  console.error("  Keep engine/pack-managed files immutable. Move changes to a user-owned overlay, a new slug, or a fork, then rerun the update.");
}
