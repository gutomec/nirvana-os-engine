/**
 * installer.ts — core install/uninstall logic for businesses, squads, mind-clones, packs.
 *
 * Tiers (see plan-of-record at docs/nirvana-evolution/decisions/):
 *   Tier 0 — `nrv install <source>` (auto-detect, validate, atomic move, reindex, register)
 *   Tier 1 — pack.yaml (multi-asset install with dependency check)
 *   Tier 2 — manifest-driven uninstall (`nrv uninstall <name>`, `nrv installed`)
 *   Tier 3 — versioning + checksum + backup on --force
 *
 * Reuses: canonical paths, validate-business.ts, validate-mind-clones.ts, indexers.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  renameSync,
  statSync,
  lstatSync,
  cpSync,
  writeFileSync,
  realpathSync,
} from "node:fs";
import { join, dirname, basename, relative, resolve, sep, isAbsolute } from "node:path";
import { homedir, tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";

import { InstallManifest, type AssetKind, type InstallEvent, type InstalledItem } from "./install-manifest.ts";
import { resolveScope } from "./scope.ts";
import {
  buildExternalAppPlan,
  confirmationRequiredExternalAppPlan,
  deferOptionalExternalAppPlan,
  declineExternalAppPlan,
  discoverExternalApps,
  executeExternalAppPlan,
  type ExternalActionResult,
  type ExternalAppResult,
  type SquadDependencySource,
} from "./external-app-dependencies.ts";

// Lazy path resolution — picks up env changes (useful for tests + project scope).
function nirvanaHome(): string { return process.env.NIRVANA_HOME ?? homedir(); }
function businessesDir(): string { return process.env.BUSINESSES_DIR ?? join(nirvanaHome(), "businesses"); }
function squadsDir(): string { return process.env.SQUADS_DIR ?? join(nirvanaHome(), "squads"); }
function dnaLibrary(): string { return process.env.DNA_LIBRARY ?? join(businessesDir(), "_library", "dna"); }
function claudeSkills(): string {
  return process.env.NIRVANA_SKILLS_DIR ?? process.env.CLAUDE_SKILLS_DIR
    ?? (existsSync(join(homedir(), ".nirvana", "skills")) ? join(homedir(), ".nirvana", "skills") : join(homedir(), ".claude", "skills"));
}

export interface InstallOptions {
  source: string;
  type?: "business" | "squad" | "mind-clone" | "pack" | "auto";
  scope?: "global" | "project";
  projectRoot?: string;
  force?: boolean;
  dryRun?: boolean;
  skipReindex?: boolean;
  skipValidate?: boolean;
  quiet?: boolean;
  acceptExternalAppsDigest?: string;
  declineExternalApps?: boolean;
}

export interface InstallResult {
  ok: boolean;
  install_id: string;
  kind: AssetKind;
  name: string;
  version: string;
  path: string;
  checksum: string;
  items?: InstalledItem[];
  warnings: string[];
  errors: string[];
  prev_version?: string;
  backup_path?: string;
  dry_run?: boolean;
  readiness?: "ready" | "degraded" | "blocked" | "confirmation_required";
  external_dependencies?: ExternalAppResult[];
  degraded_capabilities?: string[];
  external_plan_digest?: string;
  external_actions?: ExternalActionResult[];
  changed_external_apps?: string[];
  confirmation_required?: boolean;
  exit_code?: 1 | 2;
}

export interface UninstallOptions {
  name: string;
  kind?: AssetKind;
  scope?: "global" | "project";
  projectRoot?: string;
  reason?: string;
  dryRun?: boolean;
  skipReindex?: boolean;
  quiet?: boolean;
}

export interface UninstallResult {
  ok: boolean;
  removed_paths: string[];
  install_id: string | null;
  errors: string[];
  dry_run?: boolean;
}

// ─────────────────────────────────────────────────────────────
// Source resolution: local dir / tarball / git URL → tmp dir
// ─────────────────────────────────────────────────────────────

function uuid(): string {
  return randomBytes(8).toString("hex") + "-" + Date.now().toString(36);
}

function isGitUrl(s: string): boolean {
  return /^git\+https?:\/\//.test(s) || /^https?:\/\/.*\.git$/.test(s) || /^git@[^:]+:/.test(s);
}

function isTarball(s: string): boolean {
  return /\.tar(\.gz|\.bz2|\.xz)?$/.test(s) || s.endsWith(".tgz");
}

function isHttpUrl(s: string): boolean {
  return /^https?:\/\//.test(s);
}

function runCmd(cmd: string, args: string[], opts: { cwd?: string; timeoutMs?: number } = {}): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync(cmd, args, { cwd: opts.cwd, encoding: "utf8", timeout: opts.timeoutMs ?? 120_000 });
  return { ok: r.status === 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

// Tarball extraction with cwd + RELATIVE paths using "/": an absolute Windows
// path (C:\...) has ":" and Git Bash's GNU tar treats it as a remote host.
// A relative path has no ":" and works with GNU tar and bsdtar, on any OS.
function tarExtract(archive: string, dest: string): { ok: boolean; stdout: string; stderr: string } {
  const cwd = dirname(archive);
  const rel = (p: string) => {
    const r = relative(cwd, p);
    return (r === "" ? "." : r.includes(":") ? p : r).split(sep).join("/");
  };
  return runCmd("tar", ["-xf", rel(archive), "-C", rel(dest)], { cwd });
}

export interface ResolvedSource {
  workdir: string;
  cleanup: () => void;
  origin_kind: "local-dir" | "local-tarball" | "http-tarball" | "git";
  origin_uri: string;
}

export function resolveSource(source: string): ResolvedSource {
  const abs = resolve(source);
  // 1. Local directory
  if (existsSync(abs) && statSync(abs).isDirectory()) {
    return { workdir: abs, cleanup: () => {}, origin_kind: "local-dir", origin_uri: abs };
  }
  // 2. Local tarball
  if (existsSync(abs) && statSync(abs).isFile() && isTarball(abs)) {
    const work = join(tmpdir(), `nrv-install-${uuid()}`);
    mkdirSync(work, { recursive: true });
    const r = tarExtract(abs, work);
    if (!r.ok) throw new Error(`tar extract failed: ${r.stderr}`);
    return { workdir: collapseSingleChild(work), cleanup: () => safeRm(work), origin_kind: "local-tarball", origin_uri: abs };
  }
  // 3. Git URL
  if (isGitUrl(source)) {
    const work = join(tmpdir(), `nrv-install-${uuid()}`);
    const cleanUrl = source.replace(/^git\+/, "");
    const r = runCmd("git", ["clone", "--depth=1", cleanUrl, work]);
    if (!r.ok) throw new Error(`git clone failed: ${r.stderr}`);
    return { workdir: work, cleanup: () => safeRm(work), origin_kind: "git", origin_uri: cleanUrl };
  }
  // 4. HTTP tarball
  if (isHttpUrl(source) && isTarball(source)) {
    const work = join(tmpdir(), `nrv-install-${uuid()}`);
    mkdirSync(work, { recursive: true });
    const tarPath = join(work, "archive.tar");
    const dl = runCmd("curl", ["-fsSL", "-o", tarPath, source], { timeoutMs: 120_000 });
    if (!dl.ok) throw new Error(`download failed: ${dl.stderr}`);
    const r = tarExtract(tarPath, work);
    if (!r.ok) throw new Error(`tar extract failed: ${r.stderr}`);
    safeRm(tarPath);
    return { workdir: collapseSingleChild(work), cleanup: () => safeRm(work), origin_kind: "http-tarball", origin_uri: source };
  }
  throw new Error(`unresolvable source: ${source}. Expected local dir/tarball, git URL, or http tarball.`);
}

function collapseSingleChild(dir: string): string {
  const entries = readdirSync(dir);
  if (entries.length === 1) {
    const child = join(dir, entries[0]);
    if (statSync(child).isDirectory()) return child;
  }
  return dir;
}

function safeRm(p: string): void {
  try { rmSync(p, { recursive: true, force: true }); } catch {}
}

// ─────────────────────────────────────────────────────────────
// Type detection
// ─────────────────────────────────────────────────────────────

export function detectKind(dir: string): { kind: AssetKind | null; reason: string } {
  if (existsSync(join(dir, "pack.yaml"))) return { kind: "pack", reason: "pack.yaml present" };
  if (existsSync(join(dir, "business.yaml"))) return { kind: "business", reason: "business.yaml present" };
  if (existsSync(join(dir, "squad.yaml"))) return { kind: "squad", reason: "squad.yaml present" };
  if (existsSync(join(dir, "MANIFEST.yaml")) && existsSync(join(dir, "agent", "AGENT.md"))) return { kind: "mind-clone", reason: "MANIFEST.yaml + agent/AGENT.md present" };
  // Looser mind-clone heuristic
  if (existsSync(join(dir, "agent", "AGENT.md")) && existsSync(join(dir, "agent", "SOUL.md"))) return { kind: "mind-clone", reason: "agent/{AGENT,SOUL}.md present" };
  return { kind: null, reason: "no business.yaml, squad.yaml, pack.yaml, or mind-clone agent dir found at root" };
}

// ─────────────────────────────────────────────────────────────
// Manifest readers (lightweight YAML parsing for top-level fields)
// ─────────────────────────────────────────────────────────────

function parseYamlSimple(text: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("#") || !line.trim()) { i++; continue; }
    const m = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (!m) { i++; continue; }
    const key = m[1];
    const val = m[2].trim();
    if (val === "" || val === ">" || val === "|") {
      // multi-line scalar or list
      const list: string[] = [];
      let j = i + 1;
      while (j < lines.length && /^\s+-\s+/.test(lines[j])) {
        list.push(lines[j].replace(/^\s+-\s+/, "").trim().replace(/^["']|["']$/g, ""));
        j++;
      }
      if (list.length > 0) {
        out[key] = list;
        i = j;
        continue;
      }
      i++;
      continue;
    }
    out[key] = val.replace(/^["']|["']$/g, "");
    i++;
  }
  return out;
}

export interface AssetMeta {
  name: string;
  version: string;
  description?: string;
  author?: string;
}

export function readAssetMeta(dir: string, kind: AssetKind): AssetMeta {
  const manifestFile =
    kind === "pack" ? "pack.yaml" :
    kind === "business" ? "business.yaml" :
    kind === "squad" ? "squad.yaml" :
    "MANIFEST.yaml";
  const p = join(dir, manifestFile);
  if (!existsSync(p)) throw new Error(`${manifestFile} not found in ${dir}`);
  const meta = parseYamlSimple(readFileSync(p, "utf8"));
  // mind-clone MANIFEST.yaml nests under `manifest:` — handle that case
  let name = meta.name as string | undefined;
  let version = meta.version as string | undefined;
  if (kind === "mind-clone" && (!name || !version)) {
    // Re-parse looking for `name:` and `version:` nested in `manifest:` block
    const raw = readFileSync(p, "utf8");
    const mName = /^\s*name:\s*(.+)$/m.exec(raw);
    const mVersion = /^\s*version:\s*(.+)$/m.exec(raw);
    name = name ?? (mName?.[1]?.trim().replace(/^["']|["']$/g, ""));
    version = version ?? (mVersion?.[1]?.trim().replace(/^["']|["']$/g, ""));
  }
  if (!name) throw new Error(`${manifestFile} missing required 'name'`);
  return {
    name,
    version: version ?? "0.0.0",
    description: (meta.description as string) ?? "",
    author: (meta.author as string) ?? "",
  };
}

// ─────────────────────────────────────────────────────────────
// Validators (lightweight — deep validation is opt-in)
// ─────────────────────────────────────────────────────────────

export function validateLight(dir: string, kind: AssetKind): { ok: boolean; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  try {
    readAssetMeta(dir, kind);
  } catch (e) {
    errors.push((e as Error).message);
    return { ok: false, errors, warnings };
  }
  if (kind === "business") {
    if (!existsSync(join(dir, "employees"))) warnings.push("no employees/ directory found");
  }
  if (kind === "squad") {
    if (!existsSync(join(dir, "agents"))) warnings.push("no agents/ directory found");
    if (!existsSync(join(dir, "workflows"))) warnings.push("no workflows/ directory found");
  }
  if (kind === "mind-clone") {
    if (!existsSync(join(dir, "agent", "AGENT.md"))) errors.push("missing agent/AGENT.md");
    if (!existsSync(join(dir, "agent", "SOUL.md"))) warnings.push("missing agent/SOUL.md");
  }
  return { ok: errors.length === 0, errors, warnings };
}

// ─────────────────────────────────────────────────────────────
// Checksum — SHA-256 of directory contents (sorted, deterministic)
// ─────────────────────────────────────────────────────────────

function walkFiles(dir: string, base: string = dir): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith(".git")) continue;
    if (name === ".DS_Store") continue;
    const full = join(dir, name);
    const st = lstatSync(full);
    if (st.isSymbolicLink()) throw new Error(`checksum source contains a symbolic link: ${relative(base, full)}`);
    if (st.isDirectory()) out.push(...walkFiles(full, base));
    else out.push(full.slice(base.length + 1));
  }
  return out;
}

export function checksumDir(dir: string): string {
  const h = createHash("sha256");
  const files = walkFiles(dir);
  for (const rel of files) {
    h.update(rel + "\n");
    h.update(readFileSync(join(dir, rel)));
    h.update("\n");
  }
  return "sha256:" + h.digest("hex");
}

// ─────────────────────────────────────────────────────────────
// Target path resolution
// ─────────────────────────────────────────────────────────────

function projectScopeRoot(opts: InstallOptions): string {
  // Installing --scope=project from a SUBDIR must target the canonical
  // <projectRoot>/.nirvana, not <cwd>/.nirvana. Walk up to find the real root.
  // resolveScope throws in "project" mode with no root, so call it with
  // explicitMode:"merge" — that still returns the walked-up projectRoot
  // without the project-mode throw.
  const root = opts.projectRoot ?? resolveScope({ explicitMode: "merge" }).projectRoot ?? process.cwd();
  return join(root, ".nirvana");
}

/**
 * Mind-clone library directory in the requested scope. Clones sit FLAT inside
 * it (one dir per slug) — the category is metadata in
 * `.pack-categories.json`, never a path. It is the contract `index-clones.ts`
 * (which scans a single level) and `install-content.ts` already follow.
 */
export function mindCloneLibraryDir(opts: { scope: "global" | "project"; projectRoot?: string }): string {
  if (opts.scope === "project") {
    return join(projectScopeRoot({ source: "", scope: "project", projectRoot: opts.projectRoot }), "mind-clones");
  }
  return dnaLibrary();
}

export function targetPathFor(kind: AssetKind, name: string, opts: { scope: "global" | "project"; projectRoot?: string }): string {
  if (kind === "mind-clone") return join(mindCloneLibraryDir(opts), name);
  if (opts.scope === "project") {
    const base = projectScopeRoot({ source: "", scope: "project", projectRoot: opts.projectRoot });
    if (kind === "business") return join(base, "businesses", name);
    if (kind === "squad") return join(base, "squads", name);
    throw new Error("pack has no single target");
  }
  if (kind === "business") return join(businessesDir(), name);
  if (kind === "squad") return join(squadsDir(), name);
  throw new Error("pack has no single target");
}

export interface AtomicFileOperations {
  writeFile?: (path: string, content: string) => void;
  renameFile?: (source: string, destination: string) => void;
  removeFile?: (path: string) => void;
  fileExists?: (path: string) => boolean;
}

export function writeFileAtomically(file: string, content: string, operations: AtomicFileOperations = {}): void {
  const write = operations.writeFile ?? ((path, value) => writeFileSync(path, value));
  const rename = operations.renameFile ?? renameSync;
  const remove = operations.removeFile ?? ((path) => rmSync(path, { force: true }));
  const exists = operations.fileExists ?? existsSync;
  const nonce = randomBytes(8).toString("hex");
  const temporary = `${file}.tmp.${nonce}`;
  const backup = `${file}.bak.${nonce}`;
  const hadOriginal = exists(file);
  let previousMoved = false;
  let promotionAttempted = false;
  const restoreErrors: string[] = [];

  try {
    write(temporary, content);
    if (hadOriginal) {
      rename(file, backup);
      previousMoved = true;
    }
    promotionAttempted = true;
    rename(temporary, file);
    if (previousMoved) remove(backup);
  } catch (error) {
    const mayContainReplacement = previousMoved || (!hadOriginal && promotionAttempted);
    for (const candidate of [temporary, ...(mayContainReplacement ? [file] : [])]) {
      if (!exists(candidate)) continue;
      try { remove(candidate); } catch (restoreError) {
        restoreErrors.push(`failed to remove ${candidate}: ${(restoreError as Error).message}`);
      }
    }
    if (previousMoved) {
      if (!exists(backup)) {
        restoreErrors.push(`atomic backup missing: ${backup}`);
      } else {
        try { rename(backup, file); } catch (restoreError) {
          restoreErrors.push(`failed to restore ${file}: ${(restoreError as Error).message}`);
        }
      }
    }
    const suffix = restoreErrors.length > 0 ? `; metadata rollback incomplete: ${restoreErrors.join("; ")}` : "";
    throw new Error(`${(error as Error).message}${suffix}`);
  }
}

/**
 * Merges `{slug: category}` into the library's `.pack-categories.json`. It is
 * the map `index-clones.ts` reads to fill `pack_category` — with nobody
 * writing it, the field never left null in any install flow.
 */
function mergePackCategories(libraryDir: string, entries: Record<string, string>): void {
  if (Object.keys(entries).length === 0) return;
  const file = join(libraryDir, ".pack-categories.json");
  let current: Record<string, string> = {};
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) current = parsed;
    } catch { /* corrupted/unreadable → rewrite from scratch */ }
  }
  // EEXIST tolerated: on Windows Bun throws even with recursive:true.
  try { mkdirSync(libraryDir, { recursive: true }); }
  catch (e) { if ((e as NodeJS.ErrnoException)?.code !== "EEXIST") throw e; }
  writeFileAtomically(file, JSON.stringify({ ...current, ...entries }, null, 1) + "\n");
}

// ─────────────────────────────────────────────────────────────
// Atomic move with backup
// ─────────────────────────────────────────────────────────────

function backupExisting(target: string, prevVersion: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = `${target}.${prevVersion}.bak.${stamp}`;
  renameSync(target, backup);
  return backup;
}

export interface PackAssetCopyOperation {
  srcDir: string;
  targetDir: string;
  previousVersion?: string;
}

export class PackAssetCopyFailure extends Error {
  constructor(
    message: string,
    public readonly rolledBack: number,
    public readonly rollbackErrors: string[] = [],
  ) {
    super(message);
    this.name = "PackAssetCopyFailure";
  }
}

export function applyPackAssetCopies(
  operations: PackAssetCopyOperation[],
  copyDirectory: ((source: string, destination: string) => void) | undefined = undefined,
  finalize: () => void = () => {},
): void {
  const started: { target: string; backup?: string }[] = [];
  const copy = copyDirectory ?? ((source: string, destination: string) => cpSync(source, destination, { recursive: true }));
  try {
    for (const operation of operations) {
      let backup: string | undefined;
      if (existsSync(operation.targetDir)) {
        if (!operation.previousVersion) throw new Error(`pack item conflicts with existing: ${operation.targetDir} — use --force`);
        backup = backupExisting(operation.targetDir, operation.previousVersion);
      }
      started.push({ target: operation.targetDir, ...(backup ? { backup } : {}) });
      copy(operation.srcDir, operation.targetDir);
    }
    finalize();
  } catch (error) {
    let rolledBack = 0;
    const rollbackErrors: string[] = [];
    for (const record of [...started].reverse()) {
      let restored = true;
      try {
        rmSync(record.target, { recursive: true, force: true });
      } catch (rollbackError) {
        restored = false;
        rollbackErrors.push(`failed to remove partial target ${record.target}: ${(rollbackError as Error).message}`);
      }
      if (record.backup) {
        if (!existsSync(record.backup)) {
          restored = false;
          rollbackErrors.push(`backup missing for ${record.target}: ${record.backup}`);
        } else {
          try {
            renameSync(record.backup, record.target);
          } catch (rollbackError) {
            restored = false;
            rollbackErrors.push(`failed to restore backup for ${record.target}: ${(rollbackError as Error).message}`);
          }
        }
      }
      if (restored) rolledBack++;
    }
    throw new PackAssetCopyFailure((error as Error).message, rolledBack, rollbackErrors);
  }
}

function atomicMove(srcDir: string, target: string): void {
  mkdirSync(dirname(target), { recursive: true });
  // Try rename first (fast, atomic on same FS); fall back to cp -R + rm
  try {
    renameSync(srcDir, target);
  } catch {
    cpSync(srcDir, target, { recursive: true });
    safeRm(srcDir);
  }
}

// ─────────────────────────────────────────────────────────────
// Reindex
// ─────────────────────────────────────────────────────────────

export function reindex(opts: { quiet?: boolean; kind?: AssetKind } = {}): { ok: boolean; stderr: string } {
  const indexScript = join(claudeSkills(), "harness", "scripts", "index.ts");
  if (!existsSync(indexScript)) {
    return { ok: false, stderr: `index.ts not found at ${indexScript}` };
  }
  const r = runCmd("bun", [indexScript, ...(opts.quiet ? ["--quiet"] : [])]);
  if (!opts.quiet && r.stderr) process.stderr.write(r.stderr);
  return { ok: r.ok, stderr: r.stderr };
}

// ─────────────────────────────────────────────────────────────
// Mind-clone category extraction
// ─────────────────────────────────────────────────────────────

/** Container directories that are NOT a category (pack/library packaging only). */
const NON_CATEGORY_DIRS = new Set(["mind-clones", "mind_clones", "clones", "dna", "_library", "_root", ".", "/", ""]);

/**
 * The clone's drive category — METADATA for `.pack-categories.json`, never a
 * path (the clone is installed flat). `null` = no known category.
 */
function inferMindCloneCategory(dir: string): string | null {
  // Heuristic 1: MANIFEST.yaml has `category: <cat>`
  const manifest = join(dir, "MANIFEST.yaml");
  if (existsSync(manifest)) {
    const raw = readFileSync(manifest, "utf8");
    const m = /^\s*category:\s*(.+)$/m.exec(raw);
    if (m) {
      const cat = m[1].trim().replace(/^["']|["']$/g, "");
      if (cat && !NON_CATEGORY_DIRS.has(cat)) return cat;
    }
  }
  // Heuristic 2: parent dir name (when source is .../<category>/<slug>/).
  // Real packs are flat (`<pack>/mind-clones/<slug>/`), so the parent is
  // usually just packaging — returning it would record "mind-clones" as the
  // category.
  const parent = basename(dirname(dir));
  if (parent && !NON_CATEGORY_DIRS.has(parent)) return parent;
  return null;
}

// ─────────────────────────────────────────────────────────────
// Top-level install
// ─────────────────────────────────────────────────────────────

export async function install(opts: InstallOptions): Promise<InstallResult> {
  const manifest = new InstallManifest();
  const installId = uuid();
  const warnings: string[] = [];
  const errors: string[] = [];

  const resolved = resolveSource(opts.source);
  try {
    let kind = opts.type;
    if (!kind || kind === "auto") {
      const detected = detectKind(resolved.workdir);
      if (!detected.kind) {
        errors.push(`type detection failed: ${detected.reason}`);
        return failed();
      }
      kind = detected.kind;
    }

    // Pack path
    if (kind === "pack") {
      return await installPack(resolved.workdir, opts, manifest, installId, resolved.origin_uri);
    }

    const meta = readAssetMeta(resolved.workdir, kind);
    if (!opts.skipValidate) {
      const v = validateLight(resolved.workdir, kind);
      if (!v.ok) {
        errors.push(...v.errors);
        return failed();
      }
      warnings.push(...v.warnings);
    }

    const checksum = checksumDir(resolved.workdir);
    // Category is METADATA (goes to .pack-categories.json), not a path: the
    // clone is installed flat, the only layout index-clones can see.
    const cloneCategory = kind === "mind-clone" ? inferMindCloneCategory(resolved.workdir) : null;
    const target = targetPathFor(kind, meta.name, {
      scope: opts.scope ?? "global",
      projectRoot: opts.projectRoot,
    });

    let prevVersion: string | undefined;
    let backupPath: string | undefined;
    if (existsSync(target)) {
      if (!opts.force) {
        errors.push(`target already exists: ${target}. Use --force to replace (creates backup).`);
        return failed();
      }
      // Read previous version for the backup naming
      try {
        const prev = readAssetMeta(target, kind);
        prevVersion = prev.version;
      } catch {
        prevVersion = "unknown";
      }
    }

    if (opts.dryRun) {
      return {
        ok: true,
        install_id: installId,
        kind,
        name: meta.name,
        version: meta.version,
        path: target,
        checksum,
        warnings,
        errors,
        prev_version: prevVersion,
        dry_run: true,
      };
    }

    // Backup if needed
    if (existsSync(target)) {
      backupPath = backupExisting(target, prevVersion ?? "old");
    }

    // Move source to target (clone the dir; resolved.workdir we still want to clean)
    cpSync(resolved.workdir, target, { recursive: true });

    if (cloneCategory) {
      mergePackCategories(mindCloneLibraryDir({ scope: opts.scope ?? "global", projectRoot: opts.projectRoot }), {
        [meta.name]: cloneCategory,
      });
    }

    // Reindex
    if (!opts.skipReindex) {
      const r = reindex({ quiet: opts.quiet, kind });
      if (!r.ok) warnings.push(`reindex returned non-zero: ${r.stderr.slice(0, 200)}`);
    }

    // Record manifest event
    const event: InstallEvent = {
      ts: new Date().toISOString(),
      action: prevVersion ? "update" : "install",
      install_id: installId,
      kind,
      name: meta.name,
      version: meta.version,
      source: resolved.origin_uri,
      path: target,
      checksum,
      scope: opts.scope ?? "global",
      prev_version: prevVersion,
      backup_path: backupPath,
    };
    manifest.append(event);

    return {
      ok: true,
      install_id: installId,
      kind,
      name: meta.name,
      version: meta.version,
      path: target,
      checksum,
      warnings,
      errors,
      prev_version: prevVersion,
      backup_path: backupPath,
    };
  } finally {
    resolved.cleanup();
  }

  function failed(): InstallResult {
    return {
      ok: false,
      install_id: installId,
      kind: (opts.type ?? "business") as AssetKind,
      name: "",
      version: "",
      path: "",
      checksum: "",
      warnings,
      errors,
    };
  }
}

// ─────────────────────────────────────────────────────────────
// Pack install (Tier 1)
// ─────────────────────────────────────────────────────────────

interface PackManifest {
  name: string;
  version: string;
  description: string;
  author?: string;
  license?: string;
  contents: {
    businesses?: { path: string; rename_to?: string }[];
    squads?: { path: string; rename_to?: string }[];
    "mind-clones"?: { path: string; rename_to?: string }[];
  };
  dependencies?: {
    required_mind_clones?: string[];
    required_squads?: string[];
    required_businesses?: string[];
    min_nirvana_version?: string;
  };
}

function readPackYaml(dir: string): PackManifest {
  const raw = readFileSync(join(dir, "pack.yaml"), "utf8");
  // Simple parser for the pack schema. For robustness, prefer to install a YAML
  // dep later; meanwhile this works for the documented shape.
  const meta: any = {
    contents: { businesses: [], squads: [], "mind-clones": [] },
    dependencies: {},
  };
  const lines = raw.split("\n");
  let section: string | null = null;
  let subsection: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const topMatch = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (topMatch && !line.startsWith("  ")) {
      section = topMatch[1];
      subsection = null;
      const v = topMatch[2].trim();
      if (v && v !== "" && v !== ">" && v !== "|") meta[section] = v.replace(/^["']|["']$/g, "");
      continue;
    }
    const subMatch = /^  ([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (subMatch && (section === "contents" || section === "dependencies")) {
      subsection = subMatch[1];
      if (!meta[section][subsection]) meta[section][subsection] = [];
      continue;
    }
    const itemMatch = /^    - (.+)$/.exec(line) ?? /^    -\s*$/.exec(line);
    if (section === "contents" && subsection && itemMatch) {
      const inline = (itemMatch[1] ?? "").trim();
      if (inline.startsWith("path:")) {
        const path = inline.slice(5).trim().replace(/^["']|["']$/g, "");
        meta.contents[subsection].push({ path });
      } else if (inline) {
        meta.contents[subsection].push({ path: inline.replace(/^["']|["']$/g, "") });
      } else {
        meta.contents[subsection].push({});
      }
      continue;
    }
    const kvSubMatch = /^      ([A-Za-z_][A-Za-z0-9_-]*):\s*(.+)$/.exec(line);
    if (kvSubMatch && section === "contents" && subsection) {
      const last = meta.contents[subsection][meta.contents[subsection].length - 1];
      if (last) last[kvSubMatch[1]] = kvSubMatch[2].trim().replace(/^["']|["']$/g, "");
      continue;
    }
    const depItemMatch = /^    - (.+)$/.exec(line);
    if (section === "dependencies" && subsection && depItemMatch) {
      meta.dependencies[subsection].push(depItemMatch[1].trim().replace(/^["']|["']$/g, ""));
      continue;
    }
  }
  if (!meta.name || !meta.version) throw new Error("pack.yaml missing name or version");
  return meta as PackManifest;
}

const STRICT_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function isContained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function resolvePackItemPath(packDir: string, itemPath: unknown): string {
  if (typeof itemPath !== "string" || itemPath.trim() === "") throw new Error("unsafe pack item path: expected a non-empty relative path");
  const value = itemPath.trim();
  const segments = value.split(/[\\/]+/);
  if (isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || /^[/\\]{2}/.test(value) || segments.includes("..")) {
    throw new Error(`unsafe pack item path: ${value}`);
  }
  const root = realpathSync(packDir);
  const lexical = resolve(root, value);
  if (!isContained(root, lexical)) throw new Error(`unsafe pack item path: ${value}`);
  if (!existsSync(lexical)) return lexical;
  const actual = realpathSync(lexical);
  if (!isContained(root, actual)) throw new Error(`pack item path escapes pack root: ${value}`);
  return actual;
}

function rejectNestedPackItemLinks(root: string, current: string = root): void {
  for (const name of readdirSync(current)) {
    const entry = join(current, name);
    const stat = lstatSync(entry);
    if (stat.isSymbolicLink()) throw new Error(`pack item contains a symbolic link: ${relative(root, entry)}`);
    if (stat.isDirectory()) rejectNestedPackItemLinks(root, entry);
  }
}

function containedInstalledSquad(base: string, name: string): string | null {
  if (!existsSync(base)) return null;
  const candidate = join(base, name);
  if (!existsSync(candidate)) return null;
  const baseReal = realpathSync(base);
  const candidateReal = realpathSync(candidate);
  if (!isContained(baseReal, candidateReal)) throw new Error(`required squad path escapes registry root: ${name}`);
  return candidateReal;
}

function installedSquadPath(name: string, opts: InstallOptions): string | null {
  if (!STRICT_SLUG.test(name)) throw new Error(`invalid required squad slug: ${name}`);
  const bases: string[] = [];
  if (opts.scope === "project") {
    const projectTarget = targetPathFor("squad", name, { scope: "project", projectRoot: opts.projectRoot });
    bases.push(dirname(projectTarget));
  }
  bases.push(squadsDir());
  for (const base of bases) {
    const found = containedInstalledSquad(base, name);
    if (found) return found;
  }
  return null;
}

async function installPack(packDir: string, opts: InstallOptions, manifest: InstallManifest, installId: string, originUri: string): Promise<InstallResult> {
  const warnings: string[] = [];
  const errors: string[] = [];
  const items: InstalledItem[] = [];

  const pack = readPackYaml(packDir);

  // Dependency pre-flight
  if (pack.dependencies?.required_mind_clones) {
    for (const dep of pack.dependencies.required_mind_clones) {
      const [cat, slug] = dep.split("/");
      const path = join(dnaLibrary(), cat, slug);
      if (!existsSync(path)) errors.push(`required mind-clone missing: ${dep}`);
    }
  }
  if (pack.dependencies?.required_squads) {
    for (const dep of pack.dependencies.required_squads) {
      try {
        if (!installedSquadPath(dep, opts)) errors.push(`required squad missing: ${dep}`);
      } catch (error) {
        errors.push((error as Error).message);
      }
    }
  }
  if (pack.dependencies?.required_businesses) {
    for (const dep of pack.dependencies.required_businesses) {
      if (!existsSync(join(businessesDir(), dep))) errors.push(`required business missing: ${dep}`);
    }
  }
  if (errors.length > 0) {
    return { ok: false, install_id: installId, kind: "pack", name: pack.name, version: pack.version, path: "", checksum: "", warnings, errors };
  }

  // Pre-flight: validate every asset path
  const planItems: { kind: AssetKind; srcDir: string; meta: AssetMeta; targetDir: string; cloneCategory?: string; previousVersion?: string }[] = [];
  const claimedTargets = new Map<string, string>(); // targetDir → item.path that claimed it
  for (const k of ["businesses", "squads", "mind-clones"] as const) {
    const list = (pack.contents as any)[k] ?? [];
    for (const item of list) {
      let srcDir: string;
      try {
        srcDir = resolvePackItemPath(packDir, item.path);
      } catch (error) {
        errors.push((error as Error).message);
        continue;
      }
      if (!existsSync(srcDir)) {
        errors.push(`pack item missing: ${item.path}`);
        continue;
      }
      const kind: AssetKind = k === "businesses" ? "business" : k === "squads" ? "squad" : "mind-clone";
      try {
        rejectNestedPackItemLinks(srcDir);
        const meta = readAssetMeta(srcDir, kind);
        const name = item.rename_to ?? meta.name;
        if (!STRICT_SLUG.test(name)) throw new Error(`invalid pack item slug: ${name}`);
        // Flat layout: the category becomes metadata, not a subdirectory.
        const cloneCategory = kind === "mind-clone" ? (inferMindCloneCategory(srcDir) ?? undefined) : undefined;
        const targetDir = targetPathFor(kind, name, { scope: opts.scope ?? "global", projectRoot: opts.projectRoot });
        // Flat exposes slug collisions inside the pack itself (previously
        // masked by different categories). Explicit failure > overwrite.
        const claimedBy = claimedTargets.get(targetDir);
        if (claimedBy) {
          errors.push(`pack item ${item.path} collides with ${claimedBy}: both install as "${name}" in ${dirname(targetDir)}`);
          continue;
        }
        claimedTargets.set(targetDir, item.path);
        let previousVersion: string | undefined;
        if (existsSync(targetDir)) {
          if (!opts.force) {
            errors.push(`pack item conflicts with existing: ${targetDir} — use --force`);
          } else {
            try { previousVersion = readAssetMeta(targetDir, kind).version; } catch { previousVersion = "old"; }
          }
        }
        planItems.push({ kind, srcDir, meta: { ...meta, name }, targetDir, cloneCategory, ...(previousVersion ? { previousVersion } : {}) });
      } catch (e) {
        errors.push(`pack item ${item.path} invalid: ${(e as Error).message}`);
      }
    }
  }
  if (errors.length > 0) {
    return { ok: false, install_id: installId, kind: "pack", name: pack.name, version: pack.version, path: "", checksum: "", warnings, errors };
  }

  let checksum: string;
  try {
    checksum = checksumDir(packDir);
  } catch (error) {
    errors.push(`pack checksum failed: ${(error as Error).message}`);
    return { ok: false, install_id: installId, kind: "pack", name: pack.name, version: pack.version, path: "", checksum: "", warnings, errors };
  }

  const squadSources: SquadDependencySource[] = planItems
    .filter((item) => item.kind === "squad")
    .map((item) => ({ slug: item.meta.name, path: item.srcDir }));
  for (const slug of pack.dependencies?.required_squads ?? []) {
    const path = installedSquadPath(slug, opts);
    if (path) squadSources.push({ slug, path });
  }

  let externalPlan: ReturnType<typeof buildExternalAppPlan> | undefined;
  let externalExecution: ReturnType<typeof executeExternalAppPlan> | undefined;
  try {
    const externalApps = discoverExternalApps(squadSources);
    if (externalApps.length > 0) {
      externalPlan = buildExternalAppPlan(externalApps);
      if (opts.dryRun) {
        externalExecution = confirmationRequiredExternalAppPlan(externalPlan);
      } else if (opts.acceptExternalAppsDigest && opts.declineExternalApps) {
        externalExecution = confirmationRequiredExternalAppPlan(externalPlan, "choose either acceptance or decline, not both");
      } else if (opts.declineExternalApps) {
        externalExecution = declineExternalAppPlan(externalPlan);
      } else if (opts.acceptExternalAppsDigest) {
        externalExecution = executeExternalAppPlan(externalPlan, opts.acceptExternalAppsDigest);
      } else {
        externalExecution = deferOptionalExternalAppPlan(externalPlan);
      }
    }
  } catch (error) {
    errors.push(`external app dependency plan failed: ${(error as Error).message}`);
    return { ok: false, install_id: installId, kind: "pack", name: pack.name, version: pack.version, path: "", checksum, warnings, errors };
  }

  const externalFields = externalPlan && externalExecution ? {
    readiness: externalExecution.readiness,
    external_dependencies: externalExecution.results,
    degraded_capabilities: externalExecution.degradedCapabilities,
    external_plan_digest: externalPlan.digest,
    external_actions: externalExecution.actions,
    changed_external_apps: externalExecution.changedApps,
    confirmation_required: externalExecution.confirmationRequired,
  } : {};

  if (externalExecution?.warnings.length) warnings.push(...externalExecution.warnings);

  if (externalExecution?.readiness === "confirmation_required" && !opts.dryRun) {
    errors.push(...(externalExecution.blockingErrors.length > 0
      ? externalExecution.blockingErrors
      : [`external app confirmation required: use --accept-external-apps=${externalPlan!.digest} or --decline-external-apps`]));
    return {
      ok: false, install_id: installId, kind: "pack", name: pack.name, version: pack.version,
      path: "", checksum, warnings, errors, exit_code: 2, ...externalFields,
    };
  }

  if (externalExecution?.readiness === "blocked" && !opts.dryRun) {
    errors.push(...externalExecution.blockingErrors);
    return {
      ok: false, install_id: installId, kind: "pack", name: pack.name, version: pack.version,
      path: "", checksum, warnings, errors, exit_code: 1, ...externalFields,
    };
  }

  if (opts.dryRun) {
    return {
      ok: true,
      install_id: installId,
      kind: "pack",
      name: pack.name,
      version: pack.version,
      path: packDir,
      checksum,
      items: planItems.map((p) => ({ kind: p.kind, name: p.meta.name, path: p.targetDir, slug: p.meta.name })),
      warnings,
      errors,
      dry_run: true,
      ...externalFields,
    };
  }

  // Apply pack assets with rollback on failure. Accepted external changes are
  // deliberately reported but cannot be rolled back by the pack installer.
  const cloneCategories: Record<string, string> = {};
  for (const p of planItems) if (p.kind === "mind-clone" && p.cloneCategory) cloneCategories[p.meta.name] = p.cloneCategory;
  try {
    applyPackAssetCopies(
      planItems.map((p) => ({ srcDir: p.srcDir, targetDir: p.targetDir, previousVersion: p.previousVersion })),
      undefined,
      () => mergePackCategories(
        mindCloneLibraryDir({ scope: opts.scope ?? "global", projectRoot: opts.projectRoot }),
        cloneCategories,
      ),
    );
    for (const p of planItems) {
      items.push({ kind: p.kind, name: p.meta.name, path: p.targetDir, slug: p.meta.name });
    }
  } catch (e) {
    const rolledBack = e instanceof PackAssetCopyFailure ? e.rolledBack : 0;
    errors.push(`pack install failed: ${(e as Error).message} — rolled back ${rolledBack} pack items`);
    if (e instanceof PackAssetCopyFailure) {
      for (const rollbackError of e.rollbackErrors) errors.push(`pack rollback incomplete: ${rollbackError}`);
    }
    if (externalExecution?.actions.some((action) => action.phase === "install")) {
      warnings.push("Pack asset installation failed after external installers ran; external changes were not rolled back.");
    }
    return {
      ok: false, install_id: installId, kind: "pack", name: pack.name, version: pack.version,
      path: "", checksum, warnings, errors, exit_code: 1, ...externalFields,
    };
  }

  if (!opts.skipReindex) {
    const r = reindex({ quiet: opts.quiet });
    if (!r.ok) warnings.push(`reindex returned non-zero: ${r.stderr.slice(0, 200)}`);
  }

  // Emit one pack event + one per-item event linked by pack_install_id.
  // Pack `path` is intentionally empty: a pack is metadata, not a single
  // canonical directory. Uninstall walks `items` to remove children.
  manifest.append({
    ts: new Date().toISOString(),
    action: "install",
    install_id: installId,
    kind: "pack",
    name: pack.name,
    version: pack.version,
    source: originUri,
    path: "",
    checksum,
    scope: opts.scope ?? "global",
    items,
  });
  for (const item of items) {
    manifest.append({
      ts: new Date().toISOString(),
      action: "install",
      install_id: uuid(),
      kind: item.kind,
      name: item.name,
      version: planItems.find((p) => p.meta.name === item.name)?.meta.version ?? "0.0.0",
      source: `pack:${pack.name}@${pack.version}`,
      path: item.path,
      checksum,
      scope: opts.scope ?? "global",
      pack_install_id: installId,
    });
  }

  return {
    ok: true,
    install_id: installId,
    kind: "pack",
    name: pack.name,
    version: pack.version,
    path: packDir,
    checksum,
    items,
    warnings,
    errors,
    ...externalFields,
  };
}

// ─────────────────────────────────────────────────────────────
// Uninstall (Tier 2)
// ─────────────────────────────────────────────────────────────

export async function uninstall(opts: UninstallOptions): Promise<UninstallResult> {
  const manifest = new InstallManifest();
  const errors: string[] = [];
  const removedPaths: string[] = [];

  const active = manifest.list({ active_only: true, scope: opts.scope ?? "global", projectRoot: opts.projectRoot ?? resolveScope({ explicitMode: "merge" }).projectRoot ?? undefined }).filter((x) =>
    x.name === opts.name && (!opts.kind || x.kind === opts.kind),
  );
  if (active.length === 0) {
    errors.push(`no active installation named '${opts.name}'${opts.kind ? ` of kind ${opts.kind}` : ""}`);
    return { ok: false, removed_paths: [], install_id: null, errors };
  }
  if (active.length > 1) {
    errors.push(`multiple active installations match '${opts.name}': ${active.map((a) => `${a.kind}:${a.name}`).join(", ")}. Specify --kind.`);
    return { ok: false, removed_paths: [], install_id: null, errors };
  }
  const target = active[0];

  // If it's a pack, the pack itself has no canonical path; the children do.
  // Walk through items linked by pack_install_id and remove those.
  const targets: { path: string; install_id: string; kind: AssetKind; name: string }[] = [];
  if (target.kind === "pack") {
    const linked = manifest.list({ active_only: true, projectRoot: opts.projectRoot ?? resolveScope({ explicitMode: "merge" }).projectRoot ?? undefined }).filter((x) =>
      x.history.some((h) => h.pack_install_id === target.install_id),
    );
    for (const l of linked) targets.push({ path: l.path, install_id: l.install_id, kind: l.kind, name: l.name });
  } else {
    targets.push({ path: target.path, install_id: target.install_id, kind: target.kind, name: target.name });
  }

  if (opts.dryRun) {
    return {
      ok: true,
      removed_paths: targets.map((t) => t.path),
      install_id: target.install_id,
      errors: [],
      dry_run: true,
    };
  }

  for (const t of targets) {
    if (existsSync(t.path)) {
      try {
        rmSync(t.path, { recursive: true, force: true });
        removedPaths.push(t.path);
      } catch (e) {
        errors.push(`failed to remove ${t.path}: ${(e as Error).message}`);
      }
    }
    manifest.append({
      ts: new Date().toISOString(),
      action: "uninstall",
      install_id: t.install_id,
      kind: t.kind,
      name: t.name,
      version: target.version,
      source: target.source,
      path: t.path,
      checksum: target.checksum,
      scope: target.scope,
      reason: opts.reason,
    });
  }

  if (!opts.skipReindex) {
    const r = reindex({ quiet: opts.quiet });
    if (!r.ok && errors.length === 0) errors.push(`reindex returned non-zero: ${r.stderr.slice(0, 200)}`);
  }

  return {
    ok: errors.length === 0,
    removed_paths: removedPaths,
    install_id: target.install_id,
    errors,
  };
}
