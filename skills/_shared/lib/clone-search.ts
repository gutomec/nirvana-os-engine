// clone-search.ts — task→clone ranking via the shared BM25 engine.
//
// Closes the gap where the router indexed squads + businesses but NEVER clones,
// so an employee/squad agent had no way to find which mind-clone fits a brief.
// Builds a BM25 corpus from the clone registry (one doc per clone: slug +
// display_name + tags + categories + the enrichable match block) and ranks the
// brief against it. Drives the "if not requested, search for a useful clone"
// step of the resolution order.

import * as path from "node:path";
import { loadCloneRegistry } from "./clone-resolver.ts";

// Reuse the canonical BM25 engine the router uses (same tokenizer + scoring).
const bm25 = require(path.join(import.meta.dir, "..", "..", "harness", "lib", "bm25.js"));

export type CloneHit = {
  slug: string;
  display_name: string;
  score: number;
  normalized: number;
  /** Content-token coverage of the brief against this clone's doc — the same
   *  {matched, total} the router's Stage 3 gate uses (bm25.coverage). */
  coverage: { matched: number | null; total: number };
  /** True when coverage sits in the router's out-of-domain / confirm bands
   *  (bm25.coverageBelowGate). Consumers MUST NOT inject a below-gate clone:
   *  BM25's max-normalization makes `normalized` vacuous as a usefulness gate
   *  (the top hit is 1.0 by construction even on "consertar a bomba hidráulica
   *  do trator"), while coverage separates with an empty band — measured
   *  2026-08-05: 10/10 legit need-queries clear it, 0/3 out-of-domain do. */
  below_gate: boolean;
  one_liner: string | null;
  pack_category: string | null;
  /** What the clone refuses. Never indexed — carried through so the caller can
   *  drop a candidate the query is actually asking to be refused. */
  not_for: string | null;
  refuses: string[];
  delegates_to: string[];
};

/** Build the searchable text for one clone.
 *
 *  Only POSITIVE statements go in. `not_for` / `refuses` / `delegates_to` are
 *  deliberately absent: BM25 scores term overlap and has no notion of negation,
 *  so "not for direct-response copy" reads to the index as a vote FOR
 *  direct-response copy. That is not hypothetical — two independently authored
 *  blocks ranked first on the very queries their prose meant to repel, and both
 *  authors had to launder the wording to get out of it. Excluding the negative
 *  text removes the trap instead of asking every author to write around it.
 *
 *  `when_to_use` is legacy: blocks written before the split mixed both voices in
 *  it, so it stays indexed only while `serves` is absent. */
function cloneDoc(c: any) {
  const m = c.match || {};
  const refuses: string[] = Array.isArray(m.refuses) ? m.refuses : [];

  // `refuses` overrides everything indexed, wherever the term comes from. The
  // manifest tags predate the routing block and sometimes contradict it:
  // `nicholas-felton` carries the tag "hábitos" while declaring it refuses
  // habit change — and the tag alone was enough for it to contest queries that
  // belong to clones with a habit method. Hand-editing 542 manifests for this
  // would be recurring manual work; applying the refusal as a filter solves it
  // once and keeps a single rule.
  const norm = (s: string) => String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
  const recusados = new Set(refuses.map(norm));
  const tags = (Array.isArray(c.tags) ? c.tags : []).filter((t: string) => !recusados.has(norm(t)));

  // KNOWN DEBT — person names in the need corpus.
  //
  // `slug` and `display_name` are indexed, and surnames collide with common
  // Portuguese nouns. Measured: "meu filho desiste na primeira dificuldade"
  // lands on `mario-filho-data`, "o porto e a logística portuária" on
  // `camila-porto`, "a rocha da estratégia" on `melina-rocha`. That is 8
  // collisions hitting 15 clones (ramos, rocha, filho, monteiro, porto, silva,
  // lobo, couto).
  //
  // The fix is removing the name from here: BY-NAME search has its own path
  // and runs BEFORE BM25 (the team-orchestrator's REQUESTED step), so in this
  // corpus, which exists for discovery by NEED, the name is noise.
  //
  // It cannot be done yet: as long as a clone lacks a `routing:` block, the
  // name is the only anchor it has — `billy-wilder` has no tags at all.
  // Removing it now would make it unfindable. Do it when enrichment is done.
  const text = [
    c.slug,
    c.display_name,
    tags.join(" "),
    c.pack_category || "",
    c.manifest_category || "",
    m.one_liner || "",
    Array.isArray(m.domains) ? m.domains.join(" ") : "",
    m.serves || m.when_to_use || "",
  ].filter(Boolean).join(" ");
  return {
    text,
    slug: c.slug,
    display_name: c.display_name || c.slug,
    one_liner: m.one_liner || null,
    pack_category: c.pack_category || null,
    not_for: m.not_for || null,
    refuses: Array.isArray(m.refuses) ? m.refuses : [],
    delegates_to: Array.isArray(m.delegates_to) ? m.delegates_to : [],
  };
}

/** Exposed only for the corpus test: guarantees the exclusion of negative
 *  text is verifiable without assembling a whole registry on disk. */
export const buildCloneDocForTest = cloneDoc;

/** THE clone corpus builder — one BM25 doc per clone from the live registry.
 *  Shared by findCloneForTask and `nrv search` so both rank over the same
 *  text (same positive-only fields, same refuses-filtered tags). */
export function buildCloneCorpus(opts: { cwd?: string } = {}): Array<ReturnType<typeof cloneDoc>> {
  return Object.values(loadCloneRegistry(opts)).map(cloneDoc);
}

function toHit(h: any, briefTokens: string[]): CloneHit {
  // Same coverage implementation as the router's Stage 3 gate — extracted to
  // bm25.coverage precisely so this file and router.js cannot drift.
  const cov = bm25.coverage(briefTokens, new Set(bm25.tokenize(h.doc.text)));
  return {
    slug: h.doc.slug,
    display_name: h.doc.display_name,
    score: h.score,
    normalized: h.normalized,
    coverage: cov,
    below_gate: bm25.coverageBelowGate(cov),
    one_liner: h.doc.one_liner,
    pack_category: h.doc.pack_category,
    not_for: h.doc.not_for,
    refuses: h.doc.refuses,
    delegates_to: h.doc.delegates_to,
  };
}

/** Rank clones by usefulness for a brief. Returns up to `limit` hits, each
 *  annotated with the router-mirroring coverage gate (`coverage` +
 *  `below_gate`) — injection consumers (team-orchestrator, employee-prompt)
 *  must skip `below_gate` hits, so an out-of-domain brief injects NOTHING.
 *  The ranked list itself still surfaces below-gate hits (agentic-override /
 *  diagnostic display); `minNormalized` is kept for callers that filter by
 *  normalized score. Empty array when registry is empty or brief is blank. */
export function findCloneForTask(
  brief: string,
  opts: { limit?: number; minNormalized?: number; cwd?: string } = {},
): CloneHit[] {
  const reg = loadCloneRegistry({ cwd: opts.cwd });
  const docs = Object.values(reg).map(cloneDoc);
  if (!docs.length || !brief) return [];

  const idx = bm25.buildIndex(docs);
  const hits = bm25.query(idx, brief, { topK: opts.limit || 8 });
  const minNorm = opts.minNormalized != null ? opts.minNormalized : 0;
  const briefTokens = bm25.tokenize(brief);

  return hits.filter((h: any) => h.normalized >= minNorm).map((h: any) => toHit(h, briefTokens));
}

// NO dense arm here — deliberately (routing-360 Phase 3.4).
//
// Two shapes were measured and both lost to plain BM25:
//   - RRF fusion (2026-07-27, 542 clones, sparse-weight sweep 1/1.5/2/3):
//     self-retrieval 167/171 vs 171/171, need-phrased 6/12 vs 10/12.
//   - NO_MATCH fallback slot (2026-08-05, neural backend active, 549 clones):
//     in the below-gate regime — the only slot a fallback would own — dense
//     top-1 hit 0/9 multilingual need-queries (it suggested a UX designer for
//     a first-time-design-manager query, a paid-media clone for a Google-update
//     traffic loss), and the top-1 cosines of legit need-queries (0.306-0.614)
//     fully overlap the out-of-domain briefs (0.207-0.410): no threshold
//     separates suggestion from noise.
// The structural reason survives both measurements: a paraphrase embedder
// scores topical closeness, and the question here is who DECLARES the
// competence. The former findCloneForTaskHybrid was deleted with this note —
// re-adding a dense arm requires new data, not a new hunch.
