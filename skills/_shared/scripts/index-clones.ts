#!/usr/bin/env bun
/**
 * index-clones.ts — build the mind-clone registry (.mind-clones-registry.json).
 *
 * Parallel to index-squads / index-businesses, which `nrv index` lacked for
 * clones. Walks the scope-resolved mind-clone library (scope.mindCloneDirs),
 * parses each canonical clone's MANIFEST.yaml, detects its persona files, and
 * writes a registry the unified resolver + task→clone search consume. Flat
 * layout: one dir per slug; the drive category lives in .pack-categories.json
 * (metadata, not path). The `match` block (one_liner / domains / when_to_use)
 * is left enrichable — populated from MANIFEST `routing:` if present, empty
 * otherwise, so the personal enrichment pass fills it incrementally.
 *
 * Scope: global → ~/.nirvana/.mind-clones-registry.json; project/merge →
 * <projectRoot>/.nirvana/.mind-clones-registry.json (project clones override).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { paths, parseArgs, EXIT } from "../lib/bun-helpers.ts";
import { resolveScope } from "../lib/scope.ts";

const YAML = require("yaml");

const { flags } = parseArgs();
const quiet = !!flags.quiet || !!flags.q;

const scope = resolveScope();
const roots = scope.mindCloneDirs.length ? scope.mindCloneDirs : [paths.DNA_LIBRARY];

const registryDir = scope.projectRoot
  ? path.join(scope.projectRoot, ".nirvana")
  : path.join(os.homedir(), ".nirvana");
const registryPath = path.join(registryDir, ".mind-clones-registry.json");

/** slug → drive category map, written at consolidation time alongside the library. */
function loadCatMap(): Record<string, string> {
  const p = path.join(paths.DNA_LIBRARY, ".pack-categories.json");
  if (fs.existsSync(p)) {
    try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { /* ignore */ }
  }
  return {};
}

function readManifest(dir: string): any | null {
  for (const n of ["MANIFEST.yaml", "manifest.yaml"]) {
    const p = path.join(dir, n);
    if (fs.existsSync(p)) {
      try { return YAML.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
    }
  }
  return null;
}

function firstExisting(dir: string, rels: string[]): string | null {
  for (const r of rels) {
    const p = path.join(dir, r);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const catMap = loadCatMap();
const clones: Record<string, any> = {};
let scanned = 0;

for (const root of roots) {
  if (!fs.existsSync(root)) continue;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const dir = path.join(root, entry.name);
    const m = readManifest(dir);
    if (!m) continue; // not a canonical clone dir
    scanned++;
    const slug = entry.name;
    if (clones[slug]) continue; // first root wins (project overrides global on slug clash)
    const man = m.manifest || m;
    const persona = {
      agent: firstExisting(dir, ["agent/AGENT.md", "AGENT.md"]),
      soul: firstExisting(dir, ["agent/SOUL.md", "SOUL.md"]),
      dna_schema: firstExisting(dir, ["dna/dna-schema.md"]),
      manifest: firstExisting(dir, ["MANIFEST.yaml", "manifest.yaml"]),
    };
    const routing = m.routing || {}; // enrichment pass writes one_liner/domains/when_to_use here
    clones[slug] = {
      slug,
      display_name: man.display_name || slug,
      pack_category: catMap[slug] || null,
      manifest_category: man.category || null,
      tags: Array.isArray(man.tags) ? man.tags : [],
      validation_verdict: m.validation_verdict || man.validation_verdict || null,
      scores: m.scores || null,
      dir,
      has_full_dna: !!(persona.agent && persona.soul),
      persona_files: persona,
      match: {
        one_liner: routing.one_liner || null,
        domains: Array.isArray(routing.domains) ? routing.domains : [],
        when_to_use: routing.when_to_use || null,
      },
    };
  }
}

// EEXIST tolerado: no Windows o Bun pode lançar mesmo com recursive:true.
try { fs.mkdirSync(registryDir, { recursive: true }); }
catch (e) { if ((e as NodeJS.ErrnoException)?.code !== "EEXIST") throw e; }
const out = {
  schema_version: "1.0",
  generated_at: new Date().toISOString(),
  scope_mode: scope.mode,
  mind_clone_roots: roots,
  count: Object.keys(clones).length,
  mind_clones: clones,
};
fs.writeFileSync(registryPath, JSON.stringify(out, null, 1));

if (!quiet) {
  console.error(`[index-clones] scope=${scope.mode} → scanning: ${roots.join(", ")}`);
  console.error(`[index-clones] registry → ${registryPath}`);
  const enriched = Object.values(clones).filter((c: any) => c.match.one_liner).length;
  console.error(`[index-clones] ✓ ${out.count} mind-clones indexed (${scanned} scanned, ${enriched} enriched)`);
}
process.exit(EXIT.OK);
