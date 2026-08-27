#!/usr/bin/env bun
/**
 * build-golden-set.ts — build the routing eval golden set from the LIVE registries.
 *
 * Extracts (expected_target, brief) pairs from every `example_briefs[]` entry:
 *   - squad capability providers  -> {kind:"squad_capability", squad, capability_id, brief}
 *   - v4 inferred capabilities    -> same kind (squad = squad name)
 *   - businesses                  -> {kind:"business", slug, brief}
 *
 * Each case is tagged with a language guess: "pt" (PT diacritics / stopword
 * heuristic), "en" (default Latin), "other" (non-Latin script).
 *
 * Registries load via the scope-aware chain (registry-loader.js — same paths
 * router.js uses at runtime). Overrides for tests:
 *   --squads-registry <path> --businesses-registry <path>
 *
 * Output: skills/harness/baselines/golden-routing.json
 * PRIVACY: the output derives from the user's private library and is
 * gitignored — only golden-negatives.json (hand-written, neutral) is committed.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";

const registryLoader = require(path.join(import.meta.dir, "..", "lib", "registry-loader.js"));

const OUTPUT_PATH = path.join(import.meta.dir, "..", "baselines", "golden-routing.json");

/**
 * Fingerprint of the two registries AS THEIR READERS SEE THEM.
 *
 * registry-loader projects each file onto the fields this script and router.js
 * read, and the projection leaves `generated_at` behind — so re-indexing an
 * unchanged library yields the same fingerprint. mtime does not have that
 * property, and the staleness check used to key on mtime: every `nrv index`
 * declared the golden set stale and forced a rebuild of a file whose content
 * was identical, followed by a ~30s eval.
 *
 * Lives here, not in eval-routing.ts, so the staleness check can be made
 * without loading the router.
 */
export function registryFingerprint(registries: any): { squads: string; businesses: string } {
  const sha = (v: any) => createHash("sha256").update(JSON.stringify(v ?? null)).digest("hex");
  return { squads: sha(registries?.squads), businesses: sha(registries?.businesses) };
}

// ── language guess ──────────────────────────────────────────────────────────

const NON_LATIN_RE =
  /[Ѐ-ӿͰ-Ͽ֐-׿؀-ۿऀ-ॿ一-鿿぀-ヿ가-힯]/;
const PT_DIACRITICS_RE = /[ãõçáéíóúâêôàÃÕÇÁÉÍÓÚÂÊÔÀ]/;
const PT_STOPWORDS = new Set([
  "para", "uma", "não", "nao", "meu", "minha", "seu", "sua", "você", "voce",
  "preciso", "quero", "crie", "criar", "escreva", "escrever", "gere", "gerar",
  "faça", "faca", "fazer", "sobre", "isso", "essa", "esse", "pra", "dos", "das",
  "que", "com", "por", "mais", "até", "ate", "hoje", "novo", "nova",
]);

export function guessLanguage(brief: string): "pt" | "en" | "other" {
  if (NON_LATIN_RE.test(brief)) return "other";
  if (PT_DIACRITICS_RE.test(brief)) return "pt";
  const words = brief.toLowerCase().split(/[^a-zà-ÿ]+/).filter(Boolean);
  let hits = 0;
  for (const w of words) if (PT_STOPWORDS.has(w)) hits++;
  return hits >= 2 ? "pt" : "en";
}

// ── registry loading (scope-aware + overrides) ──────────────────────────────

function parseFlags(argv: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--squads-registry" && argv[i + 1]) flags["squads-registry"] = argv[++i];
    else if (argv[i] === "--businesses-registry" && argv[i + 1]) flags["businesses-registry"] = argv[++i];
  }
  return flags;
}

function readRegistryFile(p: string): any {
  const abs = path.resolve(p);
  return { data: JSON.parse(fs.readFileSync(abs, "utf8")), source_path: abs };
}

// ── case extraction ─────────────────────────────────────────────────────────

export interface GoldenCase {
  kind: "squad_capability" | "business";
  squad?: string;
  capability_id?: string;
  slug?: string;
  brief: string;
  language: "pt" | "en" | "other";
}

export function extractCases(squadsRegistry: any, businessesRegistry: any): GoldenCase[] {
  const cases: GoldenCase[] = [];

  for (const [capId, providers] of Object.entries(squadsRegistry.capabilities || {})) {
    for (const p of (Array.isArray(providers) ? providers : []) as any[]) {
      if (!p || typeof p.squad !== "string") continue;
      for (const brief of Array.isArray(p.example_briefs) ? p.example_briefs : []) {
        if (typeof brief !== "string" || !brief.trim()) continue;
        cases.push({
          kind: "squad_capability",
          squad: p.squad,
          capability_id: capId,
          brief: brief.trim(),
          language: guessLanguage(brief),
        });
      }
    }
  }

  // v4 inferred capabilities (squads without explicit capabilities[]).
  for (const [squadName, caps] of Object.entries(squadsRegistry._v4_inferred_capabilities || {})) {
    for (const cap of (Array.isArray(caps) ? caps : []) as any[]) {
      if (!cap || typeof cap.capability_id !== "string") continue;
      for (const brief of Array.isArray(cap.example_briefs) ? cap.example_briefs : []) {
        if (typeof brief !== "string" || !brief.trim()) continue;
        cases.push({
          kind: "squad_capability",
          squad: squadName,
          capability_id: cap.capability_id,
          brief: brief.trim(),
          language: guessLanguage(brief),
        });
      }
    }
  }

  for (const [slug, b] of Object.entries(businessesRegistry.businesses || {})) {
    for (const brief of Array.isArray((b as any).example_briefs) ? (b as any).example_briefs : []) {
      if (typeof brief !== "string" || !brief.trim()) continue;
      cases.push({ kind: "business", slug, brief: brief.trim(), language: guessLanguage(brief) });
    }
  }

  return cases;
}

// ── main ────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const flags = parseFlags(process.argv.slice(2));

  let squads: any;
  let businesses: any;
  if (flags["squads-registry"] || flags["businesses-registry"]) {
    if (flags["squads-registry"]) {
      const r = readRegistryFile(flags["squads-registry"]);
      squads = {
        squads: r.data.squads || {},
        capabilities: r.data.capabilities || {},
        _v4_inferred_capabilities: r.data._v4_inferred_capabilities || {},
        source_path: r.source_path,
      };
    }
    if (flags["businesses-registry"]) {
      const r = readRegistryFile(flags["businesses-registry"]);
      businesses = {
        businesses: r.data.businesses || {},
        _business_routing: r.data._business_routing || {},
        source_path: r.source_path,
      };
    }
  }
  if (!squads || !businesses) {
    const all = registryLoader.loadAll();
    if (!squads) squads = all.squads;
    if (!businesses) businesses = all.businesses;
  }

  if (!squads.source_path || !businesses.source_path) {
    console.error(
      "build-golden-set: no non-empty registries found (clean install?). " +
      "Run `nrv index` first or pass --squads-registry / --businesses-registry."
    );
    process.exit(1);
  }

  const cases = extractCases(squads, businesses);

  const byLanguage: Record<string, number> = { pt: 0, en: 0, other: 0 };
  const byKind: Record<string, number> = { squad_capability: 0, business: 0 };
  for (const c of cases) {
    byLanguage[c.language] = (byLanguage[c.language] || 0) + 1;
    byKind[c.kind] = (byKind[c.kind] || 0) + 1;
  }

  const fingerprint = registryFingerprint({ squads, businesses });

  const golden = {
    generated_at: new Date().toISOString(),
    source_registries: {
      squads_path: squads.source_path,
      businesses_path: businesses.source_path,
      // Content, not mtime: `nrv index` rewrites both files on every run and
      // stamps a fresh `generated_at`, so an mtime key called the golden set
      // stale after a re-index that changed nothing. The fingerprint covers
      // the loader's projection — exactly what this script reads and what
      // router.js indexes — and that projection carries no timestamp.
      squads_sha256: fingerprint.squads,
      businesses_sha256: fingerprint.businesses,
      squads_mtime: fs.statSync(squads.source_path).mtime.toISOString(),
      businesses_mtime: fs.statSync(businesses.source_path).mtime.toISOString(),
    },
    counts: { total: cases.length, by_language: byLanguage, by_kind: byKind },
    cases,
  };

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(golden, null, 2) + "\n", "utf8");

  console.log(`golden set written: ${OUTPUT_PATH}`);
  console.log(`  total cases ....... ${golden.counts.total}`);
  console.log(`  by kind ........... squad_capability=${byKind.squad_capability} business=${byKind.business}`);
  console.log(`  by language ....... pt=${byLanguage.pt} en=${byLanguage.en} other=${byLanguage.other}`);
  console.log(`  squads registry ... ${squads.source_path}`);
  console.log(`  businesses reg .... ${businesses.source_path}`);
}
