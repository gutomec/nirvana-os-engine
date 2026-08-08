#!/usr/bin/env bun
// search.ts — real BM25 search across your Nirvana assets (routing-360 Phase 3).
//
// Ranks businesses, squads and mind-clones with the SAME engine and corpus the
// router uses: squad/business docs via router.buildMatchDocs over the
// scope-aware registries (registry-loader.js), clone docs via the corpus
// builder in clone-search.ts, scoring via bm25.js (the one canonical
// tokenizer). The previous scorer was a substring heuristic with its own
// broken tokenizer (`[^a-z0-9çãáéíóúâêôüà]+` — no NFD fold, no NFKC, no
// stopwords), so `nrv search` ranked assets differently from the router that
// dispatches them. Now a hit here is a hit there.
//
// Output details that changed with the rewrite (and why):
//   - `matched_fields` → `matched_tokens`: BM25 scores the whole registry doc,
//     not per-display-field heuristics; the honest diagnostic is WHICH query
//     tokens the winning doc contains.
//   - `score` is the raw BM25 score of the best doc for that asset (multiple
//     capability docs aggregate to their squad; business_route docs to their
//     business); `normalized` (0-1, max-normalized) is also emitted.
//   - mind-clones come from the live clone REGISTRY (the same corpus
//     find-clone and the injection gates use), not a manifest re-scan.
//
// Usage:
//   nrv search "<query>"                      # all kinds
//   nrv search "<query>" --kind=business
//   nrv search "<query>" --kind=squad
//   nrv search "<query>" --kind=mind-clone
//   nrv search "<query>" --json
//   nrv search "<query>" --limit=10

import * as path from "node:path";
import { buildCloneCorpus } from "../../_shared/lib/clone-search.ts";

const bm25 = require(path.join(import.meta.dir, "..", "lib", "bm25.js"));
const router = require(path.join(import.meta.dir, "..", "lib", "router.js"));
const registryLoader = require(path.join(import.meta.dir, "..", "lib", "registry-loader.js"));

const ANSI = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  green: "\x1b[32m", cyan: "\x1b[36m", lime: "\x1b[38;5;154m",
  magenta: "\x1b[35m", yellow: "\x1b[33m",
};
const noColor = process.argv.includes("--no-color") || !process.stdout.isTTY;
function c(color: keyof typeof ANSI, s: string): string {
  return noColor ? s : `${ANSI[color]}${s}${ANSI.reset}`;
}

const args = process.argv.slice(2);
const query = args.filter(a => !a.startsWith("--")).join(" ");
const kindArg = args.find(a => a.startsWith("--kind="))?.split("=")[1];
const limit = parseInt(args.find(a => a.startsWith("--limit="))?.split("=")[1] || "15");
const jsonOut = args.includes("--json");

if (!query) {
  console.error("Uso: nrv search \"<query>\" [--kind=business|squad|mind-clone] [--limit=N]");
  console.error("");
  console.error("Exemplos:");
  console.error("  nrv search \"copy direct response\"");
  console.error("  nrv search \"image generation\" --kind=squad");
  console.error("  nrv search \"brand strategy\" --kind=mind-clone --limit=5");
  process.exit(2);
}

type Hit = {
  kind: "business" | "squad" | "mind-clone";
  slug: string;
  name: string;
  description: string;
  category?: string;
  score: number;
  normalized: number;
  matched_tokens: string[];
};

// ── corpus (scope-aware: registry-loader honors SQUADS_REGISTRY_PATH /
//    BUSINESSES_REGISTRY_PATH / NIRVANA_HOME env overrides via paths.js, and
//    falls back project → legacy → global — the Phase 0 scope chain) ─────────

const all = registryLoader.loadAll();
for (const w of all.warnings || []) {
  // Keep the loader's failure visibility on stderr (the old inline readers
  // printed their own "warn: <kind> registry …" lines; the loader's warnings
  // carry the same text after this prefix).
  console.error(`warn: ${w}`);
}

type Doc = { id: string; text: string; kind: Hit["kind"]; slug: string };

const docs: Doc[] = [];

if (!kindArg || kindArg === "squad" || kindArg === "business") {
  // Same doc set the router matches over (capabilities, per-squad docs,
  // businesses, business_routes). Aggregated per asset below.
  for (const d of router.buildMatchDocs(all.squads, all.businesses)) {
    const t = d.meta?.type;
    if (t === "squad_capability" || t === "squad") {
      if (!kindArg || kindArg === "squad") docs.push({ id: d.id, text: d.text, kind: "squad", slug: d.meta.squad });
    } else if (t === "business" || t === "business_route") {
      if (!kindArg || kindArg === "business") docs.push({ id: d.id, text: d.text, kind: "business", slug: d.meta.slug });
    }
  }
}

const cloneMeta = new Map<string, { display_name: string; one_liner: string | null; pack_category: string | null }>();
if (!kindArg || kindArg === "mind-clone") {
  for (const cd of buildCloneCorpus()) {
    docs.push({ id: `mind-clone:${cd.slug}`, text: cd.text, kind: "mind-clone", slug: cd.slug });
    cloneMeta.set(cd.slug, { display_name: cd.display_name, one_liner: cd.one_liner, pack_category: cd.pack_category });
  }
}

// ── BM25 over the whole included corpus (shared IDF), aggregate per asset ───

const hits: Hit[] = [];
if (docs.length > 0) {
  const idx = bm25.buildIndex(docs);
  const ranked = bm25.query(idx, query, { topK: docs.length });
  const qTokens: string[] = bm25.tokenize(query);

  const bestPerAsset = new Map<string, { doc: Doc; score: number; normalized: number }>();
  for (const r of ranked) {
    const doc = r.doc as Doc;
    const key = `${doc.kind}:${doc.slug}`;
    const prev = bestPerAsset.get(key);
    if (!prev || r.score > prev.score) bestPerAsset.set(key, { doc, score: r.score, normalized: r.normalized });
  }

  for (const { doc, score, normalized } of bestPerAsset.values()) {
    const docTokens = new Set(bm25.tokenize(doc.text));
    const matched = qTokens.filter((t, i) => qTokens.indexOf(t) === i && docTokens.has(t));
    if (doc.kind === "mind-clone") {
      const m = cloneMeta.get(doc.slug);
      hits.push({
        kind: "mind-clone", slug: doc.slug,
        name: m?.display_name || doc.slug,
        description: (m?.one_liner || "").slice(0, 120),
        category: m?.pack_category || undefined,
        score, normalized, matched_tokens: matched,
      });
    } else if (doc.kind === "squad") {
      const sq = (all.squads.squads || {})[doc.slug] || {};
      hits.push({
        kind: "squad", slug: doc.slug,
        name: sq.name || doc.slug,
        description: (sq.description || "").slice(0, 120),
        score, normalized, matched_tokens: matched,
      });
    } else {
      const bz = (all.businesses.businesses || {})[doc.slug] || {};
      hits.push({
        kind: "business", slug: doc.slug,
        name: bz.name || doc.slug,
        description: (bz.description || "").slice(0, 120),
        score, normalized, matched_tokens: matched,
      });
    }
  }
}

hits.sort((a, b) => b.score - a.score);
const top = hits.slice(0, limit);

if (jsonOut) {
  console.log(JSON.stringify({ query, results: top, total: hits.length }, null, 2));
  process.exit(0);
}

console.log("");
console.log(c("bold", `Search: "${query}"`) + c("dim", `  ·  ${hits.length} matches, showing top ${top.length}`));
console.log("");
for (const h of top) {
  const kindColor: keyof typeof ANSI = h.kind === "squad" ? "lime" : h.kind === "business" ? "magenta" : "cyan";
  const scoreBar = "█".repeat(Math.max(1, Math.min(15, Math.round(h.normalized * 15))));
  console.log(`  ${c(kindColor, h.kind.padEnd(11))} ${c("bold", h.slug.padEnd(40))} ${c("yellow", h.score.toFixed(2))} ${c("dim", scoreBar)}`);
  if (h.category) console.log(`    ${c("dim", "category:")} ${h.category}`);
  if (h.description) console.log(`    ${c("dim", h.description)}`);
  console.log(`    ${c("dim", "matched: " + (h.matched_tokens.join(", ") || "(none)"))}`);
  console.log("");
}

if (hits.length === 0) {
  console.log(c("yellow", "  Nenhum match. Tente termos mais genéricos ou verifique:"));
  console.log("    " + c("yellow", "nrv index") + c("dim", "  # rebuild registries"));
  console.log("    " + c("yellow", "nrv doctor") + c("dim", "  # check library counts"));
}

process.exit(0);
