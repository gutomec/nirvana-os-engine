#!/usr/bin/env bun
/**
 * list-clones.ts — list mind-clones in ~/businesses/_library/dna/
 *
 * Discovery is category-aware: top-level entries can be either:
 *   1. canonical clones (subdir with MANIFEST.yaml)
 *   2. categories (subdir without MANIFEST but containing clone subdirs OR `<name>.md` files)
 *
 * Recognizes 3 formats:
 *   - canonical (FdG): {slug}/MANIFEST.yaml + agent/* + dna/*
 *   - simplified-legacy: <category>/<slug>.md (single .md file, frontmatter)
 *   - canonical-in-category: <category>/<slug>/MANIFEST.yaml (Phase A converted)
 *
 * Usage:
 *   bun list-clones.ts                  # compact, grouped by category
 *   bun list-clones.ts --format=table
 *   bun list-clones.ts --format=json
 *   bun list-clones.ts --category=marketing
 *   bun list-clones.ts --canonical-only # exclude simplified-legacy
 *   bun list-clones.ts --duplicates     # show only clones existing in multiple locations
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";

const HOME = homedir();
const DNA_DIR = join(HOME, "businesses/_library/dna");

const args = process.argv.slice(2);
const format = args.find((a) => a.startsWith("--format="))?.split("=")[1] ?? "compact";
const filterCategory = args.find((a) => a.startsWith("--category="))?.split("=")[1];
const canonicalOnly = args.includes("--canonical-only");
const dupesOnly = args.includes("--duplicates");

type FormatType = "canonical" | "canonical-in-category" | "simplified-legacy";

interface CloneInfo {
  slug: string;
  display_name: string;
  category: string;        // semantic category from MANIFEST or parent dir
  parent_dir: string;      // top-level dir name (e.g., "01-marketing-copy-vendas" or slug itself)
  tags: string[];
  compilation_method: string;
  validation_verdict: string;
  dna_total: number;
  source_coverage: number;
  path: string;
  format: FormatType;
}

function safeIsDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function safeExists(p: string): boolean {
  try {
    return existsSync(p);
  } catch {
    return false;
  }
}

function parseManifest(manifestPath: string): Partial<CloneInfo> | null {
  if (!safeExists(manifestPath)) return null;
  try {
    const text = readFileSync(manifestPath, "utf8");
    const data = (Bun as unknown as { YAML: { parse(s: string): unknown } }).YAML.parse(text) as Record<string, unknown>;
    const m = (data.manifest ?? data.mind_clone ?? {}) as Record<string, unknown>;
    const scores = (data.scores ?? (data.quality as Record<string, unknown>) ?? {}) as Record<string, unknown>;
    const dna = (data.dna_layers ?? {}) as Record<string, number>;
    const dnaTotal = Object.values(dna).reduce((s: number, v) => s + (typeof v === "number" ? v : 0), 0);

    let coverage = scores.source_coverage as number | undefined;
    if (coverage === undefined && typeof scores.source_coverage_pct === "number") {
      coverage = (scores.source_coverage_pct as number) / 100;
    }

    return {
      display_name: (m.display_name as string) ?? (m.name as string) ?? "?",
      category: (m.category as string) ?? "uncategorized",
      tags: (m.tags as string[]) ?? [],
      compilation_method: (m.compilation_method as string) ?? "unknown",
      validation_verdict: (data.validation_verdict as string) ?? ((data.quality as Record<string, unknown>)?.validation_verdict as string) ?? "unknown",
      dna_total: dnaTotal,
      source_coverage: coverage ?? 0,
    };
  } catch {
    return null;
  }
}

function parseSimplifiedFrontmatter(mdPath: string): { display_name: string; tags: string[] } | null {
  if (!safeExists(mdPath)) return null;
  try {
    const text = readFileSync(mdPath, "utf8");
    const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!m) return null;
    const fm: Record<string, string> = {};
    for (const line of m[1].split("\n")) {
      const kv = line.match(/^([a-z_]+):\s*(.*)$/);
      if (kv) fm[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, "");
    }
    // Try to extract display_name from first H1
    const h1 = text.match(/^#\s+(?:🧬\s+)?([^—\n]+?)(?:\s+—|\s*$)/m);
    return {
      display_name: h1 ? h1[1].trim() : (fm.name ?? basename(mdPath, ".md")),
      tags: [],
    };
  } catch {
    return null;
  }
}

function categorySlugFromDir(dirName: string): string {
  // "01-marketing-copy-vendas" -> "marketing"
  // strip leading number-prefix and take first meaningful segment
  const stripped = dirName.replace(/^\d+-/, "");
  const first = stripped.split("-")[0];
  return first || stripped;
}

function listClones(): CloneInfo[] {
  if (!safeExists(DNA_DIR)) return [];
  const topEntries = readdirSync(DNA_DIR).filter((e) => {
    if (e.startsWith(".")) return false;
    if (e === "INDEX.json") return false;
    return safeIsDir(join(DNA_DIR, e));
  });

  const clones: CloneInfo[] = [];

  for (const topName of topEntries) {
    const topDir = join(DNA_DIR, topName);
    const topManifest = join(topDir, "MANIFEST.yaml");

    // Case 1: top-level is a canonical clone (has MANIFEST.yaml)
    if (safeExists(topManifest)) {
      const parsed = parseManifest(topManifest);
      if (parsed) {
        clones.push({
          slug: topName,
          display_name: parsed.display_name ?? topName,
          category: parsed.category ?? "uncategorized",
          parent_dir: topName,
          tags: parsed.tags ?? [],
          compilation_method: parsed.compilation_method ?? "unknown",
          validation_verdict: parsed.validation_verdict ?? "unknown",
          dna_total: parsed.dna_total ?? 0,
          source_coverage: parsed.source_coverage ?? 0,
          path: topDir,
          format: "canonical",
        });
        continue;
      }
    }

    // Case 2: top-level is a category (no MANIFEST). Scan its contents.
    const inferredCategory = categorySlugFromDir(topName);
    let subEntries: string[] = [];
    try {
      subEntries = readdirSync(topDir).filter((e) => !e.startsWith("."));
    } catch {
      continue;
    }

    for (const sub of subEntries) {
      const subPath = join(topDir, sub);

      // 2a. canonical-in-category: subdir with MANIFEST.yaml
      if (safeIsDir(subPath)) {
        const subManifest = join(subPath, "MANIFEST.yaml");
        if (safeExists(subManifest)) {
          const parsed = parseManifest(subManifest);
          if (parsed) {
            clones.push({
              slug: sub,
              display_name: parsed.display_name ?? sub,
              category: parsed.category ?? inferredCategory,
              parent_dir: topName,
              tags: parsed.tags ?? [],
              compilation_method: parsed.compilation_method ?? "unknown",
              validation_verdict: parsed.validation_verdict ?? "unknown",
              dna_total: parsed.dna_total ?? 0,
              source_coverage: parsed.source_coverage ?? 0,
              path: subPath,
              format: "canonical-in-category",
            });
          }
        }
        continue;
      }

      // 2b. simplified-legacy: <slug>.md in category (skip .en.md and other variants)
      if (sub.endsWith(".md") && !sub.endsWith(".en.md") && !sub.startsWith("LEGACY-")) {
        if (canonicalOnly) continue;
        const slug = basename(sub, ".md");
        const fm = parseSimplifiedFrontmatter(subPath);
        clones.push({
          slug,
          display_name: fm?.display_name ?? slug,
          category: inferredCategory,
          parent_dir: topName,
          tags: fm?.tags ?? [],
          compilation_method: "simplified-legacy",
          validation_verdict: "simplified-format",
          dna_total: 0, // unknown without parsing body
          source_coverage: 0,
          path: subPath,
          format: "simplified-legacy",
        });
      }
    }
  }

  return clones.sort((a, b) => {
    if (a.parent_dir !== b.parent_dir) return a.parent_dir.localeCompare(b.parent_dir);
    return a.slug.localeCompare(b.slug);
  });
}

function findDuplicates(clones: CloneInfo[]): Map<string, CloneInfo[]> {
  const bySlug = new Map<string, CloneInfo[]>();
  for (const c of clones) {
    if (!bySlug.has(c.slug)) bySlug.set(c.slug, []);
    bySlug.get(c.slug)!.push(c);
  }
  const dupes = new Map<string, CloneInfo[]>();
  for (const [slug, items] of bySlug.entries()) {
    if (items.length > 1) dupes.set(slug, items);
  }
  return dupes;
}

const all = listClones();
let filtered = filterCategory ? all.filter((c) => c.category === filterCategory) : all;

if (dupesOnly) {
  const dupes = findDuplicates(filtered);
  const dupeSlugs = new Set(dupes.keys());
  filtered = filtered.filter((c) => dupeSlugs.has(c.slug));
}

if (format === "json") {
  console.log(JSON.stringify(filtered, null, 2));
} else if (format === "table") {
  if (filtered.length === 0) {
    console.log("No mind-clones found in ~/businesses/_library/dna/");
    process.exit(0);
  }
  const w = Math.max(...filtered.map((c) => c.slug.length), 8);
  const wd = Math.max(...filtered.map((c) => c.display_name.length), 12);
  const wp = Math.max(...filtered.map((c) => c.parent_dir.length), 8);
  console.log(`${"slug".padEnd(w)}  ${"display".padEnd(wd)}  ${"parent".padEnd(wp)}  category       cov%  DNA  format`);
  for (const c of filtered) {
    const cov = `${Math.round((c.source_coverage ?? 0) * 100)}`;
    console.log(`${c.slug.padEnd(w)}  ${c.display_name.padEnd(wd)}  ${c.parent_dir.padEnd(wp)}  ${c.category.padEnd(14)} ${cov.padStart(3)}%  ${String(c.dna_total).padStart(3)}  ${c.format}`);
  }
  console.log("");
  // Summary
  const byFormat = new Map<string, number>();
  for (const c of filtered) byFormat.set(c.format, (byFormat.get(c.format) ?? 0) + 1);
  const summary = [...byFormat.entries()].map(([k, v]) => `${k}=${v}`).join(", ");
  console.log(`  total: ${filtered.length} mind-clones (${summary})${filterCategory ? ` [category=${filterCategory}]` : ""}`);

  const dupes = findDuplicates(filtered);
  if (dupes.size > 0) {
    console.log(`  ⚠ ${dupes.size} slug(s) appear in multiple locations: ${[...dupes.keys()].slice(0, 5).join(", ")}${dupes.size > 5 ? ", ..." : ""}`);
    console.log(`    run with --duplicates to see all`);
  }
} else {
  // compact (default), grouped by parent_dir
  if (filtered.length === 0) {
    console.log("No mind-clones found in ~/businesses/_library/dna/");
    console.log("Install starter pack via: bun ~/nirvana-os/scripts/install.ts --starter");
    process.exit(0);
  }
  const byParent = new Map<string, CloneInfo[]>();
  for (const c of filtered) {
    if (!byParent.has(c.parent_dir)) byParent.set(c.parent_dir, []);
    byParent.get(c.parent_dir)!.push(c);
  }
  for (const [parent, clones] of [...byParent.entries()].sort()) {
    const isCategory = clones[0].format !== "canonical";
    const label = isCategory ? `${parent}/  [category]` : `${parent}/  [top-level canonical]`;
    console.log(`\n${label}`);
    for (const c of clones) {
      const cov = `${Math.round((c.source_coverage ?? 0) * 100)}%`;
      const verdict = c.format === "simplified-legacy" ? "simplified" : c.validation_verdict;
      console.log(`  ${c.display_name.padEnd(28)} (${c.slug.padEnd(22)}) — DNA=${String(c.dna_total).padStart(3)}, cov=${cov.padStart(4)}, ${verdict}`);
    }
  }
  console.log("");
  // Summary
  const byFormat = new Map<string, number>();
  for (const c of filtered) byFormat.set(c.format, (byFormat.get(c.format) ?? 0) + 1);
  const summary = [...byFormat.entries()].map(([k, v]) => `${k}=${v}`).join(", ");
  console.log(`  total: ${filtered.length} mind-clones (${summary})${filterCategory ? ` [category=${filterCategory}]` : ""}`);

  const dupes = findDuplicates(filtered);
  if (dupes.size > 0) {
    console.log(`  ⚠ ${dupes.size} slug(s) appear in multiple locations (run --duplicates to see)`);
  }
}
process.exit(0);
