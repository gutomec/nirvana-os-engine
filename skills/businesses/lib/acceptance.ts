// acceptance.ts — the acceptance contract a business declares, per role.
//
// Business Protocol 2.0 §11 lets an employee declare `acceptance[]`: the criteria
// its output has to meet, each one blocking unless the author says otherwise, and
// each one optionally naming the `path` it promises on disk. The validator has
// accepted the block since the v2 cut; nothing read it. Two readers do now:
//
//   the Gauntlet   `readAcceptance(bizDir, employees)` becomes `SuccessRequirement[]`,
//                  so a business Gauntlet judges the role's own criteria instead of
//                  the single `brief-conformance` line every Gauntlet shared.
//   completeness   an entry with `path` is a promise the disk can be checked against
//                  (`verify-deliverable.ts`, `manifest_source: "acceptance"`) — the
//                  one completeness proof the system has, for a business that never
//                  wrote a `deliverables.json`.
//
// Ids are deduped: two roles that declare the same criterion (a shared house rule
// copied across employees) contribute one requirement, the first one read, so the
// judge is never asked to score the same dimension twice.

import * as fs from "node:fs";
import * as path from "node:path";
import * as YAML from "yaml";
import { paths } from "../../_shared/lib/bun-helpers.ts";
import type { SuccessRequirement } from "../../harness/lib/gauntlet/types.ts";

/** The capability that judges an acceptance criterion when the author names none. */
export const CONFORMANCE_CAPABILITY = "quality.specification_conformance";

/** Ceiling of the judge's contract (Squad Protocol v6 §29), `brief-conformance` included. */
export const ACCEPTANCE_MAX = 11;

export interface AcceptanceEntry {
  id: string;
  description: string;
  blocking: boolean;
  minimum_score?: number;
  capability?: string;
  /** A file the role promises; relative paths resolve against the outputs root. */
  path?: string;
  min_bytes?: number;
  /** The employee that declared it. */
  employee: string;
}

export interface BusinessAcceptance {
  requirements: SuccessRequirement[];
  entries: AcceptanceEntry[];
  /** The subset that promises a file — what a completeness check can verify. */
  paths: Array<{ path: string; minBytes: number | null }>;
}

const FRONTMATTER = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

function frontmatterOf(file: string): Record<string, unknown> | null {
  try {
    const match = FRONTMATTER.exec(fs.readFileSync(file, "utf8"));
    if (!match) return null;
    const doc = YAML.parse(match[1], { uniqueKeys: false });
    return doc && typeof doc === "object" && !Array.isArray(doc) ? doc as Record<string, unknown> : null;
  } catch { return null; }
}

function employeeFiles(bizDir: string, employees?: string[] | null): string[] {
  const dir = path.join(bizDir, "employees");
  let names: string[];
  try { names = fs.readdirSync(dir).filter(name => name.endsWith(".md")).sort(); }
  catch { return []; }
  if (!employees?.length) return names.map(name => path.join(dir, name));
  const wanted = new Set(employees.map(name => name.replace(/\.md$/i, "").toLowerCase()));
  return names.filter(name => wanted.has(name.slice(0, -3).toLowerCase())).map(name => path.join(dir, name));
}

/**
 * The acceptance contract of a business, read from the roles named in `employees`
 * (every role when the list is empty). `minimumScore` falls back to `opts.minimumScore`,
 * which the caller takes from the Gauntlet's intensity profile.
 */
export function readAcceptance(bizDir: string, employees?: string[] | null,
  opts: { minimumScore?: number } = {}): BusinessAcceptance {
  const floor = opts.minimumScore ?? 0.92;
  const entries: AcceptanceEntry[] = [];
  const seen = new Set<string>();
  for (const file of employeeFiles(bizDir, employees)) {
    const front = frontmatterOf(file);
    const declared = Array.isArray(front?.acceptance) ? front!.acceptance as Array<Record<string, unknown>> : [];
    const employee = typeof front?.name === "string" ? front.name : path.basename(file, ".md");
    for (const raw of declared) {
      if (!raw || typeof raw !== "object") continue;
      const id = typeof raw.id === "string" ? raw.id.trim() : "";
      const description = typeof raw.description === "string" ? raw.description.trim() : "";
      if (!id || !description || seen.has(id)) continue;
      seen.add(id);
      entries.push({
        id, description, employee,
        blocking: typeof raw.blocking === "boolean" ? raw.blocking : true,
        ...(typeof raw.minimum_score === "number" ? { minimum_score: raw.minimum_score } : {}),
        ...(typeof raw.capability === "string" ? { capability: raw.capability } : {}),
        ...(typeof raw.path === "string" && raw.path.trim() ? { path: raw.path.trim() } : {}),
        ...(typeof raw.min_bytes === "number" ? { min_bytes: raw.min_bytes } : {}),
      });
    }
  }
  const kept = entries.slice(0, ACCEPTANCE_MAX);
  return {
    entries,
    requirements: kept.map(entry => ({
      id: `acceptance.${entry.id}`,
      description: entry.description,
      capability: entry.capability ?? CONFORMANCE_CAPABILITY,
      blocking: entry.blocking,
      minimumScore: entry.minimum_score ?? floor,
    })),
    paths: entries.filter(entry => entry.path)
      .map(entry => ({ path: entry.path as string, minBytes: entry.min_bytes ?? null })),
  };
}

/**
 * The directory of an installed business: the registry `nrv index` writes (which
 * knows the extra roots), else `<BUSINESSES_DIR>/<slug>`. Null when neither holds it.
 */
export function businessDirFor(slug: string, opts: { registryPath?: string; businessesDir?: string } = {}): string | null {
  const registryPath = opts.registryPath ?? (paths.BUSINESSES_REGISTRY_PATH as string);
  try {
    const registry = JSON.parse(fs.readFileSync(registryPath, "utf8")) as { businesses?: Record<string, { manifest_path?: unknown }> };
    const manifestPath = registry?.businesses?.[slug]?.manifest_path;
    if (typeof manifestPath === "string" && manifestPath) {
      const dir = path.dirname(manifestPath);
      if (fs.existsSync(path.join(dir, "business.yaml"))) return dir;
    }
  } catch { /* no registry, or an unreadable one */ }
  const fallback = path.join(opts.businessesDir ?? (paths.BUSINESSES_DIR as string), slug);
  return fs.existsSync(path.join(fallback, "business.yaml")) ? fallback : null;
}
