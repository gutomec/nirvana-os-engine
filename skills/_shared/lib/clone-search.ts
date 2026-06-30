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
  one_liner: string | null;
  pack_category: string | null;
};

/** Build the searchable text for one clone. Enriched fields (one_liner /
 *  domains / when_to_use) weigh in once the personal enrichment pass fills them;
 *  until then tags + categories carry the match. */
function cloneDoc(c: any) {
  const text = [
    c.slug,
    c.display_name,
    Array.isArray(c.tags) ? c.tags.join(" ") : "",
    c.pack_category || "",
    c.manifest_category || "",
    c.match?.one_liner || "",
    Array.isArray(c.match?.domains) ? c.match.domains.join(" ") : "",
    c.match?.when_to_use || "",
  ].filter(Boolean).join(" ");
  return {
    text,
    slug: c.slug,
    display_name: c.display_name || c.slug,
    one_liner: c.match?.one_liner || null,
    pack_category: c.pack_category || null,
  };
}

/** Rank clones by usefulness for a brief. Returns up to `limit` hits with a
 *  max-normalized score in [0,1]; filter by `minNormalized` to gate "useful
 *  enough to channel". Empty array when the registry is empty or nothing
 *  clears the gate. */
export function findCloneForTask(
  brief: string,
  opts: { limit?: number; minNormalized?: number } = {},
): CloneHit[] {
  const reg = loadCloneRegistry();
  const docs = Object.values(reg).map(cloneDoc);
  if (!docs.length || !brief) return [];

  const idx = bm25.buildIndex(docs);
  const hits = bm25.query(idx, brief, { topK: opts.limit || 8 });
  const minNorm = opts.minNormalized != null ? opts.minNormalized : 0;

  return hits
    .filter((h: any) => h.normalized >= minNorm)
    .map((h: any) => ({
      slug: h.doc.slug,
      display_name: h.doc.display_name,
      score: h.score,
      normalized: h.normalized,
      one_liner: h.doc.one_liner,
      pack_category: h.doc.pack_category,
    }));
}
