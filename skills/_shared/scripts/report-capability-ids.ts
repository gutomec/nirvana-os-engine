#!/usr/bin/env bun
/**
 * report-capability-ids.ts — REPORT-ONLY rename proposals for capability ids
 * using non-canonical namespaces (prefix not in CAPABILITY_CATALOG_V1.yaml).
 *
 * The 2026-08-05 routing-360 audit found 58% of registry ids outside the
 * v1.0.0 catalog. The v1.1.0 catalog expansion legalized the legitimate
 * namespaces; what remains is mostly `general.*` (130 ids), which
 * discriminates nothing in discovery. This script proposes a canonical
 * namespace per id — best-guess from the capability's declared domains,
 * then from its description — as a migration worksheet for humans.
 *
 * It never modifies any file. Actual renames are a separate, deliberate
 * migration (ids are public contract: businesses reference them).
 *
 * Usage:
 *   bun report-capability-ids.ts             human-readable table
 *   bun report-capability-ids.ts --json      machine-readable JSON
 *   bun report-capability-ids.ts -h|--help   this message
 *
 * Reads the scope-aware live registry (paths.SQUADS_REGISTRY_PATH).
 * Exit 0 always (4 on missing registry / bad usage).
 */

import * as path from "node:path";
import { parseArgs, paths, exists, readJson, log, EXIT } from "../lib/bun-helpers.ts";
import { loadCatalog, namespaceOf, type CatalogData } from "../lib/catalog-checks.ts";

interface RenameRow {
  current_id: string;
  suggested_id: string | null;
  squad: string;
  reason: string;
}

/** Bilingual (PT-BR/EN) description stems → canonical namespace prefix. */
const KEYWORD_TO_PREFIX: Array<[RegExp, string]> = [
  [/whatsapp/i, "whatsapp"],
  [/podcast/i, "podcasting"],
  [/v[íi]deo|reel\b|filmagem|footage/i, "video"],
  [/imagem|image|foto|ilustra/i, "image"],
  [/[áa]udio|sound design|masteriza/i, "audio"],
  [/\bvoz\b|voice|narra[çc]/i, "voice"],
  [/copywrit|\bcopy\b/i, "copy"],
  [/design|layout|diagrama[çc]|identidade visual/i, "design"],
  [/\bmarca\b|brand/i, "branding"],
  [/tr[áa]fego pago|an[úu]ncio|\bads\b/i, "ads"],
  [/instagram|tiktok|linkedin|rede[s]? socia/i, "social_media"],
  [/marketing|campanha|campaign/i, "marketing"],
  [/venda|sales|funil|funnel|oferta/i, "sales"],
  [/conte[úu]do|content|editorial/i, "content"],
  [/jur[íi]dic|legal|contrat/i, "legal"],
  [/fiscal|tribut|imposto|\btax\b/i, "fiscal"],
  [/compliance|lgpd|gdpr|regulat/i, "compliance"],
  [/seguran[çc]a|security/i, "security"],
  [/sa[úu]de|cl[íi]nic|health|m[ée]dic|paciente|odonto/i, "healthcare"],
  [/educa|curso|aula|ensino|treinamento/i, "education"],
  [/im[óo]ve|imobili|real estate/i, "real_estate"],
  [/\bjogo\b|game|gaming/i, "gaming"],
  [/e-?commerce|loja virtual/i, "ecommerce"],
  [/dashboard|analytics|relat[óo]rio|report/i, "analytics"],
  [/estrat[ée]g|strategy|posicionamento/i, "strategy"],
  [/crescimento|growth|reten[çc][ãa]o/i, "growth"],
  [/pesquisa|research|investiga/i, "research"],
  [/pipeline|\betl\b|\bdados\b|\bdata\b/i, "data_engineering"],
  [/c[óo]digo|refactor|software|\bapi\b/i, "software_engineering"],
  [/automa[çc]|automat/i, "automation"],
  [/\bagente?s?\b|\bllm\b|prompt|\bia\b|\bai\b/i, "ai_engineering"],
  [/financ|or[çc]amento|budget/i, "finance"],
  [/documento|document|\bocr\b|markdown/i, "document_processing"],
];

/** Map a canonical domain to a catalog namespace prefix (identity preferred). */
function buildDomainToPrefix(catalogPath: string): Map<string, string> {
  const YAML = require("yaml");
  const fs = require("node:fs");
  const parsed = YAML.parse(fs.readFileSync(catalogPath, "utf8"));
  const map = new Map<string, string>();
  for (const ns of parsed?.namespaces || []) {
    if (typeof ns?.prefix !== "string" || typeof ns?.parent_domain !== "string") continue;
    const existing = map.get(ns.parent_domain);
    // Identity mapping (prefix === domain) always wins; else first declared.
    if (ns.prefix === ns.parent_domain || !existing) map.set(ns.parent_domain, ns.prefix);
  }
  return map;
}

function suggestFor(
  id: string,
  provider: { squad: string; domains?: string[]; description?: string },
  catalog: CatalogData,
  domainToPrefix: Map<string, string>,
): RenameRow {
  const prefix = namespaceOf(id);
  const rest = id.slice(prefix.length); // keeps the leading dot

  // 1. Domain-based: first declared canonical domain that maps to a namespace.
  for (const d of provider.domains || []) {
    if (d === "general") continue;
    const target = domainToPrefix.get(d);
    if (target && target !== prefix) {
      return {
        current_id: id,
        suggested_id: target + rest,
        squad: provider.squad,
        reason: `domain '${d}' → namespace '${target}'`,
      };
    }
  }

  // 2. Description keywords (PT-BR/EN stems).
  const desc = String(provider.description || "");
  for (const [re, target] of KEYWORD_TO_PREFIX) {
    if (catalog.namespaces.has(target) && re.test(desc)) {
      return {
        current_id: id,
        suggested_id: target + rest,
        squad: provider.squad,
        reason: `description matches /${re.source}/ → namespace '${target}'`,
      };
    }
  }

  return {
    current_id: id,
    suggested_id: null,
    squad: provider.squad,
    reason: "no canonical signal in domains or description; needs human review",
  };
}

function main() {
  const { flags } = parseArgs();
  if (flags.h || flags.help) {
    console.log(`report-capability-ids — Propose canonical renames for non-catalog capability ids

USAGE
  report-capability-ids                  human-readable table
  report-capability-ids --json           machine-readable JSON

WHAT IT DOES
  Reads the live squads registry (scope-aware) and, for every capability id
  whose namespace prefix is NOT in CAPABILITY_CATALOG_V1.yaml (e.g. the
  general.* ids), proposes a canonical rename: best-guess namespace from the
  capability's declared domains first, then from its description (PT-BR/EN
  keyword stems). REPORT-ONLY: no file is ever modified.
`);
    process.exit(EXIT.OK);
  }

  const registryPath = (paths as any).SQUADS_REGISTRY_PATH;
  if (!exists(registryPath)) {
    log.fail(`squads registry not found: ${registryPath} — run \`nrv index\` first`);
    process.exit(EXIT.INVALID_ARGS);
  }
  const catalogPath = path.resolve(import.meta.dir, "..", "catalogs", "CAPABILITY_CATALOG_V1.yaml");
  const catalog = loadCatalog(catalogPath);
  const domainToPrefix = buildDomainToPrefix(catalogPath);
  const registry = readJson<any>(registryPath);
  const capabilities: Record<string, any[]> = registry?.capabilities || {};

  const rows: RenameRow[] = [];
  for (const [id, providers] of Object.entries(capabilities)) {
    const prefix = namespaceOf(id);
    if (catalog.namespaces.has(prefix)) continue;
    if (catalog.reserved_prefixes.has(prefix)) continue; // violation, not a rename candidate
    for (const p of providers) {
      rows.push(suggestFor(id, { squad: p?.squad || "(unknown)", domains: p?.domains, description: p?.description }, catalog, domainToPrefix));
    }
  }
  rows.sort((a, b) => a.current_id.localeCompare(b.current_id) || a.squad.localeCompare(b.squad));

  const distinctIds = new Set(rows.map((r) => r.current_id));
  const byPrefix = new Map<string, number>();
  for (const id of distinctIds) {
    const p = namespaceOf(id);
    byPrefix.set(p, (byPrefix.get(p) || 0) + 1);
  }
  const suggested = rows.filter((r) => r.suggested_id !== null);
  const summary = {
    registry_path: registryPath,
    catalog_version: catalog.version,
    non_canonical_ids: distinctIds.size,
    provider_rows: rows.length,
    with_suggestion: suggested.length,
    needs_human_review: rows.length - suggested.length,
    by_prefix: Object.fromEntries([...byPrefix].sort((a, b) => b[1] - a[1])),
  };

  if (flags.json) {
    console.log(JSON.stringify({ summary, rows }, null, 2));
    process.exit(EXIT.OK);
  }

  const BOLD = "\x1b[1m", DIM = "\x1b[2m", RESET = "\x1b[0m";
  const pad = (s: string, n: number) => (s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length));
  console.log(`${BOLD}Capability-id rename proposals${RESET} ${DIM}(report-only — nothing is modified)${RESET}\n`);
  console.log(`  ${pad("current id", 46)} ${pad("suggested id", 46)} ${pad("squad", 30)} reason`);
  console.log(`  ${"─".repeat(46)} ${"─".repeat(46)} ${"─".repeat(30)} ${"─".repeat(40)}`);
  for (const r of rows) {
    console.log(`  ${pad(r.current_id, 46)} ${pad(r.suggested_id || "(needs human)", 46)} ${pad(r.squad, 30)} ${r.reason}`);
  }
  console.log(`\n${BOLD}Summary${RESET}`);
  console.log(`  ${summary.non_canonical_ids} non-canonical ids (${summary.provider_rows} provider rows) against catalog v${summary.catalog_version}`);
  console.log(`  ${summary.with_suggestion} with a suggested rename · ${summary.needs_human_review} need human review`);
  console.log(`  by prefix: ${[...byPrefix].sort((a, b) => b[1] - a[1]).map(([p, n]) => `${p} (${n})`).join(", ")}`);
  process.exit(EXIT.OK);
}

main();
