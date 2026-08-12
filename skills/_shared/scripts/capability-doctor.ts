#!/usr/bin/env bun
/**
 * capability-doctor.ts — Coverage audit for the agentic-discovery metadata
 * (`produces`, `example_briefs`, `keywords`) across all squads + businesses,
 * plus catalog-compliance checks against CAPABILITY_CATALOG_V1.yaml:
 *
 *   - reserved_prefix_check   (violation)  id uses a protocol-reserved prefix
 *   - unknown_namespace_check (warning)    id prefix not in the catalog
 *   - unknown_domain_check    (warning)    declared domain not in the catalog
 *   - collision report        (info)       ids provided by 2+ squads
 *   - score_boost report      (warning)    declared boost outside the runtime
 *                                          clamp range [1.0, 1.3]
 *
 * The unknown-namespace/domain warnings honor the squad-level escape hatch
 * `experimental_domains: true` (catalog governance §experimental_track).
 * All checks are report-level: exit code stays 0 unless --strict is given.
 *
 * The harness Pass 1 (semantic shortlist) leans on these fields; coverage
 * directly impacts routing quality. This script tells you which squads /
 * businesses still need population, prioritized by production weight
 * (capability count — most-used first).
 *
 * Usage:
 *   bun capability-doctor.ts                show full table + summary + catalog report
 *   bun capability-doctor.ts --quiet        only summaries
 *   bun capability-doctor.ts --json         machine-readable JSON output
 *   bun capability-doctor.ts --strict       exit 1 on any catalog finding (CI)
 *   bun capability-doctor.ts -h | --help    this message
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs, paths, log, EXIT } from "../lib/bun-helpers.ts";
import {
  loadCatalog,
  checkUnknownNamespaces,
  checkUnknownDomains,
  checkReservedPrefixes,
  findCollisions,
  checkScoreBoost,
  SCORE_BOOST_EFFECTIVE_RANGE,
  type CatalogData,
  type CapabilityRecord,
  type DomainRow,
} from "../lib/catalog-checks.ts";

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
  // Uses the `yaml` package (v2) — the engine standard (registry, loaders). The
  // legacy js-yaml was removed because of the GHSA-h67p-54hq-rp68 DoS.
  try {
    const YAML = require("yaml");
    return YAML.parse(fs.readFileSync(p, "utf8"));
  } catch {
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

/** Accumulator for catalog-compliance records, filled during the audit pass. */
interface CatalogCollect {
  caps: CapabilityRecord[];
  domains: DomainRow[];
}

function auditSquad(slug: string, dir: string, collect: CatalogCollect): Entry | null {
  const manifestPath = path.join(dir, "squad.yaml");
  if (!fs.existsSync(manifestPath)) return null;
  const m = readYaml(manifestPath);
  if (!m) return null;
  const caps: any[] = Array.isArray(m.capabilities) ? m.capabilities : [];
  const experimental = m.experimental_domains === true;
  for (const c of caps) {
    if (!c || typeof c.id !== "string") continue;
    const capDomains: string[] = Array.isArray(c.domains)
      ? c.domains.filter((d: any) => typeof d === "string")
      : [];
    collect.caps.push({
      id: c.id,
      provider: slug,
      provider_kind: "squad",
      domains: capDomains,
      score_boost: typeof c.score_boost === "number" ? c.score_boost : undefined,
      experimental,
    });
    for (const d of capDomains) {
      collect.domains.push({ provider: slug, provider_kind: "squad", domain: d, capability_id: c.id, experimental });
    }
  }
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

function auditBusiness(slug: string, dir: string, collect: CatalogCollect): Entry | null {
  const manifestPath = path.join(dir, "business.yaml");
  if (!fs.existsSync(manifestPath)) return null;
  const m = readYaml(manifestPath);
  if (!m) return null;
  const experimental = m.experimental_domains === true;
  // Business capabilities are flat id strings (references, not providers).
  if (Array.isArray(m.capabilities)) {
    for (const c of m.capabilities) {
      if (typeof c !== "string") continue;
      collect.caps.push({ id: c, provider: slug, provider_kind: "business", domains: [], experimental });
    }
  }
  if (Array.isArray(m.domains)) {
    for (const d of m.domains) {
      if (typeof d !== "string") continue;
      collect.domains.push({ provider: slug, provider_kind: "business", domain: d, experimental });
    }
  }
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
    console.log(`capability-doctor — Audit discovery-metadata coverage + catalog compliance

USAGE
  capability-doctor                  full table + summary + catalog report
  capability-doctor --quiet          only summaries
  capability-doctor --json           machine-readable JSON
  capability-doctor --strict         exit 1 on any catalog finding (future CI)

WHY
  The harness Pass 1 (semantic shortlist) matches user briefs against
  capabilities[].{produces, example_briefs, keywords}. Squads/businesses
  without these fields fall back to description+domains, which loses
  fidelity. This script shows coverage so you can prioritize population.

CATALOG CHECKS (against CAPABILITY_CATALOG_V1.yaml — report-level)
  reserved_prefix_check    violation  id uses a protocol-reserved prefix
  unknown_namespace_check  warning    id prefix not in the catalog
  unknown_domain_check     warning    declared domain not in the catalog
  collisions               info       capability ids provided by 2+ squads
  score_boost              warning    declared boost outside runtime clamp [1.0, 1.3]

  unknown_namespace/domain honor 'experimental_domains: true' on the squad.
  Exit code stays 0; --strict exits 1 when any violation/warning exists
  (collisions are informational and never fail --strict).

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
  const collect: CatalogCollect = { caps: [], domains: [] };

  for (const dir of listDirs(squadsDir)) {
    const slug = path.basename(dir);
    const e = auditSquad(slug, dir, collect);
    if (e) entries.push(e);
  }
  for (const dir of listDirs(businessesDir)) {
    const slug = path.basename(dir);
    const e = auditBusiness(slug, dir, collect);
    if (e) entries.push(e);
  }

  // Sort by capability_count desc, then by slug asc.
  entries.sort((a, b) => b.capability_count - a.capability_count || a.slug.localeCompare(b.slug));

  // ── Catalog compliance ──
  const catalogPath = path.resolve(import.meta.dir, "..", "catalogs", "CAPABILITY_CATALOG_V1.yaml");
  let catalog: CatalogData | null = null;
  try { catalog = loadCatalog(catalogPath); } catch { /* no catalog → checks skipped */ }

  const reserved = catalog ? checkReservedPrefixes(collect.caps, catalog) : [];
  const unknownNs = catalog ? checkUnknownNamespaces(collect.caps, catalog) : [];
  const unknownDom = catalog ? checkUnknownDomains(collect.domains, catalog) : [];
  const collisions = findCollisions(collect.caps);
  const boostFindings = checkScoreBoost(collect.caps);
  const squadCapRecords = collect.caps.filter((c) => c.provider_kind === "squad");
  const strictFindings = reserved.length + unknownNs.length + unknownDom.length + boostFindings.length;

  const catalogReport = {
    catalog_path: catalog ? catalogPath : null,
    catalog_version: catalog ? catalog.version : null,
    capability_records: collect.caps.length,
    squad_capability_records: squadCapRecords.length,
    reserved_prefix_violations: reserved,
    unknown_namespaces: unknownNs,
    unknown_domains: unknownDom,
    collisions,
    score_boost_out_of_range: boostFindings.map((f) => ({
      ...f,
      note: `declared ${f.declared}, runtime clamps to ${f.clamped}`,
    })),
    summary: {
      reserved_violations: reserved.length,
      unknown_namespace_warnings: unknownNs.length,
      unknown_domain_warnings: unknownDom.length,
      distinct_unknown_prefixes: new Set(unknownNs.map((f) => f.prefix)).size,
      distinct_unknown_domains: new Set(unknownDom.map((f) => f.domain)).size,
      collisions: collisions.length,
      score_boost_warnings: boostFindings.length,
      strict_findings: strictFindings,
    },
  };

  const exitCode = flags.strict && strictFindings > 0 ? EXIT.FAILURES : EXIT.OK;

  if (flags.json) {
    console.log(JSON.stringify({
      total: entries.length,
      squads: entries.filter((e) => e.kind === "squad").length,
      businesses: entries.filter((e) => e.kind === "business").length,
      green: entries.filter((e) => e.color === "green").length,
      yellow: entries.filter((e) => e.color === "yellow").length,
      red: entries.filter((e) => e.color === "red").length,
      entries,
      catalog_report: catalogReport,
    }, null, 2));
    process.exit(exitCode);
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

  // ── Catalog compliance section ──
  if (!catalog) {
    console.log(`\n${BOLD}Catalog compliance${RESET}: ${YELLOW}skipped${RESET} — catalog not found at ${catalogPath}`);
  } else {
    const s = catalogReport.summary;
    console.log(`\n${BOLD}Catalog compliance${RESET} ${DIM}(CAPABILITY_CATALOG_V1.yaml v${catalog.version})${RESET}`);
    console.log(`  ${collect.caps.length} capability records (${squadCapRecords.length} squad, ${collect.caps.length - squadCapRecords.length} business)`);
    console.log(`  reserved-prefix violations: ${s.reserved_violations === 0 ? GREEN + "0" + RESET : RED + String(s.reserved_violations) + RESET}`);
    console.log(`  unknown namespaces: ${s.unknown_namespace_warnings} records across ${s.distinct_unknown_prefixes} prefixes`);
    console.log(`  unknown domains: ${s.unknown_domain_warnings} uses across ${s.distinct_unknown_domains} domains`);
    console.log(`  collisions (2+ squad providers): ${s.collisions} ids`);
    console.log(`  score_boost outside [${SCORE_BOOST_EFFECTIVE_RANGE.min.toFixed(1)}, ${SCORE_BOOST_EFFECTIVE_RANGE.max}]: ${s.score_boost_warnings} declarations`);

    if (!flags.quiet) {
      if (reserved.length > 0) {
        console.log(`\n  ${RED}Reserved-prefix violations${RESET}`);
        for (const f of reserved) {
          console.log(`    ${pad(f.id, 44)} ${f.provider} (${f.provider_kind})`);
        }
      }
      if (unknownNs.length > 0) {
        const byPrefix = new Map<string, { records: number; providers: Set<string> }>();
        for (const f of unknownNs) {
          let agg = byPrefix.get(f.prefix);
          if (!agg) byPrefix.set(f.prefix, (agg = { records: 0, providers: new Set() }));
          agg.records++;
          agg.providers.add(f.provider);
        }
        console.log(`\n  ${YELLOW}Unknown namespaces${RESET} ${DIM}(warning; suppressed by experimental_domains: true)${RESET}`);
        for (const [prefix, agg] of [...byPrefix].sort((a, b) => b[1].records - a[1].records)) {
          console.log(`    ${pad(prefix, 28)} ${String(agg.records).padStart(4)} records  ${String(agg.providers.size).padStart(3)} providers`);
        }
      }
      if (unknownDom.length > 0) {
        const byDomain = new Map<string, { uses: number; providers: Set<string> }>();
        for (const f of unknownDom) {
          let agg = byDomain.get(f.domain);
          if (!agg) byDomain.set(f.domain, (agg = { uses: 0, providers: new Set() }));
          agg.uses++;
          agg.providers.add(f.provider);
        }
        const rows = [...byDomain].sort((a, b) => b[1].uses - a[1].uses);
        console.log(`\n  ${YELLOW}Unknown domains${RESET} ${DIM}(warning; top 20)${RESET}`);
        for (const [domain, agg] of rows.slice(0, 20)) {
          console.log(`    ${pad(domain, 28)} ${String(agg.uses).padStart(4)} uses     ${String(agg.providers.size).padStart(3)} providers`);
        }
        if (rows.length > 20) console.log(`    ${DIM}… and ${rows.length - 20} more domains${RESET}`);
      }
      if (collisions.length > 0) {
        console.log(`\n  ${BOLD}Capability-id collisions${RESET} ${DIM}(info; router disambiguates, heavy collisions blur discovery)${RESET}`);
        for (const c of collisions) {
          console.log(`    ${pad(c.id, 44)} x${c.providers.length}  [${c.providers.join(", ")}]`);
        }
      }
      if (boostFindings.length > 0) {
        const byValue = new Map<number, number>();
        for (const f of boostFindings) byValue.set(f.declared, (byValue.get(f.declared) || 0) + 1);
        console.log(`\n  ${YELLOW}score_boost outside effective range${RESET} ${DIM}(runtime clamps to [${SCORE_BOOST_EFFECTIVE_RANGE.min.toFixed(1)}, ${SCORE_BOOST_EFFECTIVE_RANGE.max}])${RESET}`);
        for (const [declared, count] of [...byValue].sort((a, b) => b[1] - a[1])) {
          const clamped = Math.min(SCORE_BOOST_EFFECTIVE_RANGE.max, Math.max(SCORE_BOOST_EFFECTIVE_RANGE.min, declared));
          console.log(`    declared ${String(declared).padEnd(5)} → runtime clamps to ${clamped}   ${count} capabilities`);
        }
      }
    }
    if (flags.strict && strictFindings > 0) {
      log.fail(`--strict: ${strictFindings} catalog findings (violations + warnings)`);
    }
  }

  process.exit(exitCode);
}

main();
