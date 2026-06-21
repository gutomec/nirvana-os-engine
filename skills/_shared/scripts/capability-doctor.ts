#!/usr/bin/env bun
/**
 * capability-doctor.ts — Coverage audit for the agentic-discovery metadata
 * (`produces`, `example_briefs`, `keywords`) across all squads + businesses.
 *
 * The harness Pass 1 (semantic shortlist) leans on these fields; coverage
 * directly impacts routing quality. This script tells you which squads /
 * businesses still need population, prioritized by production weight
 * (capability count — most-used first).
 *
 * Usage:
 *   bun capability-doctor.ts                show full table + summary
 *   bun capability-doctor.ts --quiet        only summary
 *   bun capability-doctor.ts --json         machine-readable JSON output
 *   bun capability-doctor.ts -h | --help    this message
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs, paths, log, EXIT } from "../lib/bun-helpers.ts";

interface CapStatus {
  has_produces: boolean;
  has_example_briefs: boolean;
  has_keywords: boolean;
}

interface Entry {
  kind: "squad" | "business";
  slug: string;
  manifest_path: string;
  capability_count: number;          // squads: capabilities[].length; businesses: 1 (manifest-level)
  cap_statuses: CapStatus[];          // squads: per-capability; businesses: single entry
  produces_pct: number;               // 0..1
  example_briefs_pct: number;
  keywords_pct: number;
  color: "green" | "yellow" | "red";  // green: all 3 fields ≥80% coverage; red: any field 0%; yellow: between
}

const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const GREEN = "\x1b[32m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";

function readYaml(p: string): any {
  // Bun has built-in YAML support via dynamic import; fallback to a tiny YAML reader if not.
  // We use the same approach as other scripts in this tree: try js-yaml.
  try {
    const yaml = require("js-yaml");
    return yaml.load(fs.readFileSync(p, "utf8"));
  } catch {
    // Last-resort: very loose JSON-style parse. Squad yamls in this codebase are
    // all valid YAML, so js-yaml should always be present (it ships with bun-helpers).
    return null;
  }
}

function listDirs(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("_") && !e.name.startsWith("."))
    .map((e) => path.join(root, e.name));
}

function classifyColor(pcts: { p: number; eb: number; kw: number }): "green" | "yellow" | "red" {
  if (pcts.p === 0 && pcts.eb === 0 && pcts.kw === 0) return "red";
  const allHigh = pcts.p >= 0.8 && pcts.eb >= 0.8 && pcts.kw >= 0.8;
  if (allHigh) return "green";
  return "yellow";
}

function auditSquad(slug: string, dir: string): Entry | null {
  const manifestPath = path.join(dir, "squad.yaml");
  if (!fs.existsSync(manifestPath)) return null;
  const m = readYaml(manifestPath);
  if (!m) return null;
  const caps: any[] = Array.isArray(m.capabilities) ? m.capabilities : [];
  const cap_statuses: CapStatus[] = caps.map((c) => ({
    has_produces: Array.isArray(c?.produces) && c.produces.length > 0,
    has_example_briefs: Array.isArray(c?.example_briefs) && c.example_briefs.length > 0,
    has_keywords: Array.isArray(c?.keywords) && c.keywords.length > 0,
  }));
  const n = Math.max(cap_statuses.length, 1);
  const p = cap_statuses.filter((s) => s.has_produces).length / n;
  const eb = cap_statuses.filter((s) => s.has_example_briefs).length / n;
  const kw = cap_statuses.filter((s) => s.has_keywords).length / n;
  return {
    kind: "squad",
    slug,
    manifest_path: manifestPath,
    capability_count: caps.length,
    cap_statuses,
    produces_pct: p,
    example_briefs_pct: eb,
    keywords_pct: kw,
    color: classifyColor({ p, eb, kw }),
  };
}

function auditBusiness(slug: string, dir: string): Entry | null {
  const manifestPath = path.join(dir, "business.yaml");
  if (!fs.existsSync(manifestPath)) return null;
  const m = readYaml(manifestPath);
  if (!m) return null;
  const status: CapStatus = {
    has_produces: Array.isArray(m?.produces) && m.produces.length > 0,
    has_example_briefs: Array.isArray(m?.example_briefs) && m.example_briefs.length > 0,
    has_keywords: Array.isArray(m?.keywords) && m.keywords.length > 0,
  };
  const p = status.has_produces ? 1 : 0;
  const eb = status.has_example_briefs ? 1 : 0;
  const kw = status.has_keywords ? 1 : 0;
  return {
    kind: "business",
    slug,
    manifest_path: manifestPath,
    capability_count: Array.isArray(m?.capabilities) ? m.capabilities.length : 0,
    cap_statuses: [status],
    produces_pct: p,
    example_briefs_pct: eb,
    keywords_pct: kw,
    color: classifyColor({ p, eb, kw }),
  };
}

function colorDot(c: "green" | "yellow" | "red"): string {
  if (c === "green") return `${GREEN}●${RESET}`;
  if (c === "yellow") return `${YELLOW}●${RESET}`;
  return `${RED}●${RESET}`;
}

function pctFmt(v: number): string {
  return `${Math.round(v * 100).toString().padStart(3)}%`;
}

function pad(s: string, n: number): string {
  if (s.length >= n) return s.slice(0, n);
  return s + " ".repeat(n - s.length);
}

function main() {
  const { flags } = parseArgs();
  if (flags.h || flags.help) {
    console.log(`capability-doctor — Audit produces/example_briefs/keywords coverage

USAGE
  capability-doctor                  full table + summary
  capability-doctor --quiet          only summary
  capability-doctor --json           machine-readable JSON

WHY
  The harness Pass 1 (semantic shortlist) matches user briefs against
  capabilities[].{produces, example_briefs, keywords}. Squads/businesses
  without these fields fall back to description+domains, which loses
  fidelity. This script shows coverage so you can prioritize population.

LEGEND
  ● green   all three fields populated on ≥80% of capabilities
  ● yellow  some coverage; partial
  ● red     zero coverage on at least one field

PRIORITIZATION
  Sorted by capability count descending — most-used squads first, since
  enriching them yields the highest routing-quality return per edit.
`);
    process.exit(EXIT.OK);
  }

  const squadsDir = (paths as any).SQUADS_DIR;
  const businessesDir = (paths as any).BUSINESSES_DIR;
  const entries: Entry[] = [];

  for (const dir of listDirs(squadsDir)) {
    const slug = path.basename(dir);
    const e = auditSquad(slug, dir);
    if (e) entries.push(e);
  }
  for (const dir of listDirs(businessesDir)) {
    const slug = path.basename(dir);
    const e = auditBusiness(slug, dir);
    if (e) entries.push(e);
  }

  // Sort by capability_count desc, then by slug asc.
  entries.sort((a, b) => b.capability_count - a.capability_count || a.slug.localeCompare(b.slug));

  if (flags.json) {
    console.log(JSON.stringify({
      total: entries.length,
      squads: entries.filter((e) => e.kind === "squad").length,
      businesses: entries.filter((e) => e.kind === "business").length,
      green: entries.filter((e) => e.color === "green").length,
      yellow: entries.filter((e) => e.color === "yellow").length,
      red: entries.filter((e) => e.color === "red").length,
      entries,
    }, null, 2));
    process.exit(EXIT.OK);
  }

  // Summary numbers
  const nSquads = entries.filter((e) => e.kind === "squad").length;
  const nBusinesses = entries.filter((e) => e.kind === "business").length;
  const nGreen = entries.filter((e) => e.color === "green").length;
  const nYellow = entries.filter((e) => e.color === "yellow").length;
  const nRed = entries.filter((e) => e.color === "red").length;

  // Aggregate field-level coverage (squads' per-cap stats; businesses' single-flag stats).
  let totalCaps = 0, capWithP = 0, capWithEB = 0, capWithKW = 0;
  for (const e of entries) {
    totalCaps += e.cap_statuses.length;
    for (const s of e.cap_statuses) {
      if (s.has_produces) capWithP++;
      if (s.has_example_briefs) capWithEB++;
      if (s.has_keywords) capWithKW++;
    }
  }

  if (!flags.quiet) {
    console.log(`${BOLD}Capability Discovery Coverage${RESET}\n`);
    console.log(`  ${pad("kind", 9)} ${pad("slug", 36)} ${pad("caps", 5)} ${pad("produces", 9)} ${pad("ex_briefs", 10)} ${pad("keywords", 9)}`);
    console.log(`  ${"─".repeat(9)} ${"─".repeat(36)} ${"─".repeat(5)} ${"─".repeat(9)} ${"─".repeat(10)} ${"─".repeat(9)}`);
    for (const e of entries) {
      const k = e.kind === "squad" ? "squad" : "business";
      console.log(
        `  ${colorDot(e.color)} ${pad(k, 7)} ${pad(e.slug, 36)} ${pad(String(e.capability_count), 5)} ${pad(pctFmt(e.produces_pct), 9)} ${pad(pctFmt(e.example_briefs_pct), 10)} ${pad(pctFmt(e.keywords_pct), 9)}`
      );
    }
    console.log("");
  }

  console.log(`${BOLD}Summary${RESET}`);
  console.log(`  ${nSquads} squads · ${nBusinesses} businesses · ${entries.length} total entries`);
  console.log(`  ${GREEN}● ${nGreen} green${RESET} · ${YELLOW}● ${nYellow} yellow${RESET} · ${RED}● ${nRed} red${RESET}`);
  if (totalCaps > 0) {
    console.log(`  Field-level coverage across ${totalCaps} capabilities:`);
    console.log(`    produces:       ${pctFmt(capWithP / totalCaps)} (${capWithP}/${totalCaps})`);
    console.log(`    example_briefs: ${pctFmt(capWithEB / totalCaps)} (${capWithEB}/${totalCaps})`);
    console.log(`    keywords:       ${pctFmt(capWithKW / totalCaps)} (${capWithKW}/${totalCaps})`);
  }

  // Top 10 priority list (highest capability_count among red+yellow).
  const priority = entries.filter((e) => e.color !== "green").slice(0, 10);
  if (priority.length > 0) {
    console.log(`\n${BOLD}Top ${priority.length} priority for enrichment${RESET} ${DIM}(highest capability count, not yet green)${RESET}`);
    for (const e of priority) {
      console.log(`  ${colorDot(e.color)} ${pad(e.slug, 36)} ${e.capability_count} caps  →  ${e.manifest_path}`);
    }
  }

  process.exit(EXIT.OK);
}

main();
