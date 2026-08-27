// common.ts — what every kind module shares: entity resolution, the surface
// criteria, and comment-preserving YAML edits for the mechanical fixers.

import * as fs from "node:fs";
import * as path from "node:path";
import { parseDocument } from "yaml";
import { paths } from "../bun-helpers.ts";
import { enumerate, resolveScope } from "../scope.ts";
import { SURFACE_FILE, detectKind, extractSurface, readSurface, writeSurface } from "../surface.ts";
import type { EntityRef, Finding, FixResult, Fixer, Kind } from "./types.ts";

export const MANIFEST_FILE: Record<Kind, string> = {
  squad: "squad.yaml",
  business: "business.yaml",
  "mind-clone": "MANIFEST.yaml",
};

const SCOPE_KIND: Record<Kind, "squads" | "businesses" | "mind-clones"> = {
  squad: "squads", business: "businesses", "mind-clone": "mind-clones",
};

export function installedRoots(kind: Kind): string[] {
  const p = paths as Record<string, string>;
  if (kind === "squad") return [p.SQUADS_DIR];
  if (kind === "business") return [p.BUSINESSES_DIR];
  return [p.DNA_LIBRARY];
}

function isEntityDir(dir: string, kind: Kind): boolean {
  return fs.existsSync(path.join(dir, MANIFEST_FILE[kind]));
}

/**
 * Slug or path → directory. A path wins when it exists and holds the kind's
 * manifest; a slug is looked up in the resolved scope, then under the
 * installed root. Mind-clones also accept the legacy nested layout
 * (`dna/<category>/<slug>/`, installs ≤ 0.1.61).
 */
export function resolveEntityDir(kind: Kind, target: string): string | null {
  if (!target) return null;
  const asPath = path.resolve(target);
  if (fs.existsSync(asPath) && fs.statSync(asPath).isDirectory()) {
    return isEntityDir(asPath, kind) ? asPath : null;
  }
  if (target.includes("/") || target.includes(path.sep)) return null;
  try {
    const hit = enumerate(resolveScope(), SCOPE_KIND[kind]).find((e) => e.slug === target && !e.overridden);
    if (hit && isEntityDir(hit.dir, kind)) return hit.dir;
  } catch { /* scope resolution failed: fall through to the installed root */ }
  for (const root of installedRoots(kind)) {
    if (!root) continue;
    const flat = path.join(root, target);
    if (isEntityDir(flat, kind)) return flat;
    if (kind === "mind-clone" && fs.existsSync(root)) {
      for (const cat of safeReaddir(root)) {
        const nested = path.join(root, cat, target);
        if (isEntityDir(nested, kind)) return nested;
      }
    }
  }
  return null;
}

function safeReaddir(dir: string): string[] {
  try { return fs.readdirSync(dir).filter((n) => !n.startsWith(".")); } catch { return []; }
}

/** Every entity of a kind under explicit roots, or under the installed scope. */
export function listEntities(kind: Kind, roots?: string[]): EntityRef[] {
  const out = new Map<string, EntityRef>();
  if (!roots) {
    try {
      for (const e of enumerate(resolveScope(), SCOPE_KIND[kind])) {
        if (!e.overridden && isEntityDir(e.dir, kind) && !out.has(e.slug)) out.set(e.slug, { slug: e.slug, dir: e.dir });
      }
    } catch { /* fall through to the installed roots */ }
    if (out.size === 0) roots = installedRoots(kind);
    else return [...out.values()];
  }
  for (const root of roots ?? []) {
    if (!root || !fs.existsSync(root)) continue;
    for (const name of safeReaddir(root)) {
      if (name.startsWith("_")) continue;
      const dir = path.join(root, name);
      let st; try { st = fs.statSync(dir); } catch { continue; }
      if (!st.isDirectory()) continue;
      if (isEntityDir(dir, kind)) { if (!out.has(name)) out.set(name, { slug: name, dir }); continue; }
      if (kind !== "mind-clone") continue;
      // legacy nested layout
      for (const sub of safeReaddir(dir)) {
        const nested = path.join(dir, sub);
        if (isEntityDir(nested, kind) && !out.has(sub)) out.set(sub, { slug: sub, dir: nested });
      }
    }
  }
  return [...out.values()].sort((a, b) => a.slug.localeCompare(b.slug));
}

// ── surface ─────────────────────────────────────────────────────────────────

export function surfaceFindings(dir: string, kind: Kind, mk: (id: string, message: string, evidence: string) => Finding): Finding[] {
  const file = path.join(dir, SURFACE_FILE);
  if (!fs.existsSync(file)) {
    return [mk("surface_missing", `no ${SURFACE_FILE} — outside the changes/drift mechanism`, `expected ${SURFACE_FILE}`)];
  }
  const onDisk = readSurface(dir);
  if (!onDisk) return [mk("surface_stale", `${SURFACE_FILE} does not parse as a surface`, file)];
  let fresh;
  try { fresh = extractSurface(dir, detectKind(dir) ?? kind); }
  catch (e: any) { return [mk("surface_stale", `surface cannot be extracted: ${e.message}`, file)]; }
  const same = onDisk.surface_hash === fresh.surface_hash
    && JSON.stringify(onDisk.entries) === JSON.stringify(fresh.entries)
    && onDisk.prose_hash === fresh.prose_hash;
  if (same) return [];
  const before = Object.keys(onDisk.entries).length, after = Object.keys(fresh.entries).length;
  return [mk("surface_stale", `${SURFACE_FILE} no longer matches the files on disk (${before} → ${after} entries)`, `surface_hash ${onDisk.surface_hash.slice(0, 12)} vs ${fresh.surface_hash.slice(0, 12)}`)];
}

export function surfaceRegenFixer(kind: Kind): Fixer {
  return ({ dir, finding }) => {
    const before = fs.existsSync(path.join(dir, SURFACE_FILE)) ? fs.readFileSync(path.join(dir, SURFACE_FILE), "utf8") : null;
    const s = extractSurface(dir, detectKind(dir) ?? kind);
    writeSurface(dir, s);
    const after = fs.readFileSync(path.join(dir, SURFACE_FILE), "utf8");
    const changed = before !== after;
    return { fixer: "surface_regen", finding: finding.id, applied: changed, changed_files: changed ? [SURFACE_FILE] : [] };
  };
}

// ── YAML edits ──────────────────────────────────────────────────────────────

/**
 * Edits a YAML file through the `yaml` Document API so comments, key order
 * and the formatting of untouched nodes survive. `mutate` returns true when
 * it changed something; nothing is written otherwise (idempotence).
 */
export function editYaml(file: string, mutate: (doc: ReturnType<typeof parseDocument>) => boolean): boolean {
  const text = fs.readFileSync(file, "utf8");
  const doc = parseDocument(text);
  if (doc.errors.length) throw new Error(`${path.basename(file)} does not parse: ${doc.errors[0].message}`);
  if (!mutate(doc)) return false;
  let out = doc.toString();
  if (text.endsWith("\n") && !out.endsWith("\n")) out += "\n";
  if (out === text) return false;
  fs.writeFileSync(file, out, "utf8");
  return true;
}

export function fixResult(fixer: string, finding: Finding, changed: boolean, files: string[], note?: string): FixResult {
  return { fixer, finding: finding.where ? `${finding.id}:${finding.where}` : finding.id, applied: changed, changed_files: changed ? files : [], ...(note ? { note } : {}) };
}
