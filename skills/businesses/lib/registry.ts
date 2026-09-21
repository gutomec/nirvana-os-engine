#!/usr/bin/env bun
/**
 * businesses skill · registry (Bun/TypeScript)
 *
 * Indexer that scans ~/businesses/ (and extra roots) and writes
 * ~/.businesses-registry.json. Schema: RegistryBusinessesSchema.
 *
 * Bun replacement for registry.py — no Python on the host.
 *
 *   bun registry.ts rebuild
 *   bun registry.ts rebuild --roots ~/businesses ~/work-businesses --output <path>
 *   bun registry.ts scan --roots ~/businesses
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import * as YAML from "yaml";
import { loadBusiness, ValidationError } from "./loader.ts";
import { RegistryBusinessesSchema } from "../../_shared/validators/validators.ts";
import { LIMITS } from "../../_shared/validators/limits.ts";
import { paths, ensureDir } from "../../_shared/lib/bun-helpers.ts";
import { writeFileAtomic } from "../../_shared/lib/atomic-write.js";

const DEFAULT_REGISTRY_PATH = paths.BUSINESSES_REGISTRY_PATH;
const DEFAULT_ROOTS = [paths.BUSINESSES_DIR];
const YAML_OPTS = { uniqueKeys: false } as const;

function expand(p: string): string {
  let out = p;
  if (out.startsWith("~")) out = path.join(os.homedir(), out.slice(1));
  out = out.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, n) => process.env[n] ?? "");
  return path.resolve(out);
}

function sha256File(p: string): string {
  return "sha256:" + createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

function isBusinessDir(dir: string): boolean {
  const base = path.basename(dir);
  if (base.startsWith(".") || base.startsWith("_")) return false;
  return fs.existsSync(path.join(dir, "business.yaml")) && fs.statSync(path.join(dir, "business.yaml")).isFile();
}

interface AutoRoute {
  pattern: string;
  route_to: string;
  requires_escalation_to?: string;
  confidence_threshold?: number;
}

function normalizeAutoRoutes(routes: unknown): AutoRoute[] {
  if (!Array.isArray(routes)) return [];
  const out: AutoRoute[] = [];
  for (const r of routes) {
    if (r === null || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const pattern = o.pattern;
    const routeTo = o.route_to ?? o.employee ?? o.capability ?? o.to;
    if (typeof pattern !== "string" || typeof routeTo !== "string") continue;
    const entry: AutoRoute = { pattern, route_to: routeTo };
    if (typeof o.requires_escalation_to === "string") entry.requires_escalation_to = o.requires_escalation_to;
    let ct = o.confidence_threshold;
    if (ct === undefined || ct === null) ct = o.confidence;
    if (typeof ct === "number") entry.confidence_threshold = ct;
    out.push(entry);
  }
  return out;
}

function readYamlSafe(file: string): Record<string, unknown> {
  try {
    const data = YAML.parse(fs.readFileSync(file, "utf8"), YAML_OPTS);
    return data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function readRouting(child: string): AutoRoute[] {
  const collected: AutoRoute[] = [];

  // Source 1: business.yaml auto_routes (canonical)
  const bizPath = path.join(child, "business.yaml");
  if (fs.existsSync(bizPath)) collected.push(...normalizeAutoRoutes(readYamlSafe(bizPath).auto_routes));

  // Source 2: routing.yaml (top-level auto_routes OR routing.auto_routes)
  const routingPath = path.join(child, "routing.yaml");
  if (fs.existsSync(routingPath)) {
    const data = readYamlSafe(routingPath);
    let routes = data.auto_routes;
    if (routes === undefined && data.routing && typeof data.routing === "object") {
      routes = (data.routing as Record<string, unknown>).auto_routes;
    }
    collected.push(...normalizeAutoRoutes(routes));
  }

  // Dedupe by (pattern, route_to), preserving order
  const seen = new Set<string>();
  const out: AutoRoute[] = [];
  for (const e of collected) {
    const key = `${e.pattern}\u0000${e.route_to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

interface ScanItem {
  slug: string;
  path: string;
  invalid: boolean;
  error?: string;
  manifest_path?: string;
  manifest_hash?: string;
  version?: string;
  protocol?: string;
  name?: string;
  description?: string;
  domains?: string[];
  capabilities?: string[];
  employee_count?: number;
  operation_mode?: string;
  authority_level?: string;
  legacy_paperclip_id?: string | null;
  auto_routes?: AutoRoute[];
  produces?: string[];
  example_briefs?: string[];
  keywords?: string[];
  not_for?: string[];
}

function scanRoots(roots: string[]): ScanItem[] {
  const items: ScanItem[] = [];
  const seenSlugs = new Set<string>();
  for (const root of roots) {
    const rootPath = expand(root);
    if (!fs.existsSync(rootPath) || !fs.statSync(rootPath).isDirectory()) continue;
    for (const name of fs.readdirSync(rootPath).sort()) {
      const child = path.join(rootPath, name);
      if (!fs.statSync(child).isDirectory() || !isBusinessDir(child)) continue;
      let biz;
      try {
        biz = loadBusiness(child);
      } catch (exc) {
        items.push({ slug: name, path: child, invalid: true, error: (exc as Error).message });
        continue;
      }
      const slug = biz.manifest.name;
      if (seenSlugs.has(slug)) {
        items.push({ slug, path: child, invalid: true, error: "Slug collision com entrada anterior do registry" });
        continue;
      }
      seenSlugs.add(slug);
      const m = biz.manifest as Record<string, any>;
      const manifestPath = path.join(child, "business.yaml");
      items.push({
        slug,
        path: child,
        invalid: false,
        manifest_path: manifestPath,
        manifest_hash: sha256File(manifestPath),
        version: m.version,
        protocol: m.protocol,
        name: typeof m.name === "string" ? m.name : undefined,
        // Routing signal (routing-360 Phase 2.1): the manifest description is the
        // business's strongest natural-language doc text. Truncated at the same
        // limit the manifest validator enforces, as registry payload discipline.
        description: typeof m.description === "string"
          ? m.description.slice(0, LIMITS.business_description_max ?? 2000)
          : undefined,
        domains: [...(m.domains ?? [])],
        capabilities: [...(m.capabilities ?? [])],
        employee_count: biz.employees.length,
        operation_mode: m.operation_mode,
        authority_level: m.authority_level,
        legacy_paperclip_id: m.legacy?.paperclip_company_id ?? null,
        auto_routes: readRouting(child),
        produces: [...(m.produces ?? [])],
        example_briefs: [...(m.example_briefs ?? [])],
        keywords: [...(m.keywords ?? [])],
        // Business Protocol 2.0 §6.9: the exclusion fence. Five live businesses
        // declared it and the router never saw one, because it stopped here.
        not_for: [...(m.not_for ?? [])],
      });
    }
  }
  return items;
}

function buildRegistry(roots: string[]): Record<string, any> {
  const items = scanRoots(roots);
  const validItems = items.filter((i) => !i.invalid);
  const invalidItems = items.filter((i) => i.invalid);

  const businessesMap: Record<string, any> = {};
  const businessRouting: Record<string, AutoRoute[]> = {};
  for (const it of validItems) {
    const entry: Record<string, any> = {
      version: it.version,
      protocol: it.protocol,
      manifest_path: it.manifest_path,
      manifest_hash: it.manifest_hash,
      domains: it.domains,
      capabilities: it.capabilities,
      employee_count: it.employee_count,
      operation_mode: it.operation_mode,
      authority_level: it.authority_level,
    };
    // Routing signal (routing-360 Phase 2.1): without these, router.js's
    // `b.description || ''` always read empty for every business.
    if (it.name) entry.name = it.name;
    if (it.description) entry.description = it.description;
    if (it.legacy_paperclip_id) entry.legacy_paperclip_id = it.legacy_paperclip_id;
    if (it.produces && it.produces.length) entry.produces = it.produces;
    if (it.example_briefs && it.example_briefs.length) entry.example_briefs = it.example_briefs;
    if (it.keywords && it.keywords.length) entry.keywords = it.keywords;
    if (it.not_for && it.not_for.length) entry.not_for = it.not_for;
    businessesMap[it.slug] = entry;

    if (it.auto_routes && it.auto_routes.length) businessRouting[it.slug] = it.auto_routes;
  }

  const registry: Record<string, any> = {
    schema_version: "1.0.0",
    generated_at: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    businesses_root_dirs: roots.map((r) => expand(r)),
    businesses: businessesMap,
  };
  if (invalidItems.length) registry._invalid_entries = invalidItems;
  if (Object.keys(businessRouting).length) registry._business_routing = businessRouting;
  return registry;
}

function writeRegistry(registry: Record<string, any>, outPath: string): string {
  const out = expand(outPath);
  // ensureDir (not raw mkdirSync): on Windows Bun throws EEXIST even with
  // recursive:true when the dir already exists — which broke `nrv index` in
  // project scope, where <project>/.nirvana exists ever since `nrv init`.
  ensureDir(path.dirname(out));
  // Validate against schema (without our extra _-prefixed fields)
  const toValidate: Record<string, any> = {};
  for (const [k, v] of Object.entries(registry)) if (!k.startsWith("_")) toValidate[k] = v;
  const parsed = RegistryBusinessesSchema.safeParse(toValidate);
  if (!parsed.success) {
    throw new ValidationError(
      "Registry resultante inválido: " + parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    );
  }
  // Shared with the squads and clones registries. This wrote straight onto
  // the target, so a reader could parse a half-written registry.
  writeFileAtomic(out, JSON.stringify(registry, null, 2));
  return out;
}

function rebuild(roots: string[], output: string): { path: string; registry: Record<string, any> } {
  const registry = buildRegistry(roots.length ? roots : DEFAULT_ROOTS);
  const p = writeRegistry(registry, output);
  return { path: p, registry };
}

function parseRootsAndOutput(argv: string[]): { roots: string[]; output: string; quiet: boolean } {
  let roots: string[] = [];
  let output = DEFAULT_REGISTRY_PATH;
  let quiet = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--quiet") quiet = true;
    else if (a === "--output") output = argv[++i];
    else if (a === "--roots") {
      while (i + 1 < argv.length && !argv[i + 1].startsWith("--")) roots.push(argv[++i]);
    }
  }
  if (roots.length === 0) roots = DEFAULT_ROOTS;
  return { roots, output, quiet };
}

function main(argv: string[]): number {
  const cmd = argv[0];
  const rest = argv.slice(1);

  if (cmd === "rebuild") {
    const { roots, output, quiet } = parseRootsAndOutput(rest);
    let result;
    try {
      result = rebuild(roots, output);
    } catch (exc) {
      process.stderr.write(`FAIL: ${(exc as Error).message}\n`);
      return 1;
    }
    const { path: p, registry } = result;
    const valid = Object.keys(registry.businesses).length;
    const invalid = (registry._invalid_entries ?? []).length;
    if (!quiet) {
      console.log(`OK: registry written to ${p}`);
      console.log(`   ${valid} valid businesses indexed, ${invalid} invalid`);
      for (const slug of Object.keys(registry.businesses).sort()) {
        const e = registry.businesses[slug];
        console.log(`   - ${slug} v${e.version} (protocol ${e.protocol}, employees ${e.employee_count}, mode ${e.operation_mode})`);
      }
      for (const inv of registry._invalid_entries ?? []) {
        console.log(`   ! INVALID: ${inv.slug} (${inv.path}): ${String(inv.error).slice(0, 120)}`);
      }
    }
    return 0;
  }

  if (cmd === "scan") {
    const { roots } = parseRootsAndOutput(rest);
    for (const it of scanRoots(roots)) console.log(JSON.stringify(it));
    return 0;
  }

  process.stderr.write("usage: registry.ts <rebuild|scan> [--roots ...] [--output <path>] [--quiet]\n");
  return 2;
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
