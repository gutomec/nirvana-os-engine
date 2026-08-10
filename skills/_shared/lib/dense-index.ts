/**
 * dense-index.ts — optional DENSE arm of the hybrid router.
 *
 * Embeds each capability/business doc once (cached on disk, invalidated by
 * content hash + model) and ranks a brief by cosine similarity. Only operates
 * when the neural backend is active (NIRVANA_EMBEDDER=transformers + package
 * installed); otherwise `denseRank` returns null and the router uses plain
 * BM25. We do not fuse hash_tfidf with BM25 because both are lexical — the
 * dense arm's gain comes from the neural model (synonyms/paraphrase that BM25
 * misses).
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { resolveEmbedder, cosine, type Embedder } from "./embedder.ts";

interface Doc { id: string; text: string; }
interface DenseIndex { hash: string; model: string; vecs: Map<string, Float32Array>; }

function cacheDir(): string {
  const base = process.env.NIRVANA_HOME || path.join(os.homedir(), ".nirvana");
  return path.join(base, "cache");
}

function docsHash(docs: Doc[], model: string): string {
  const h = createHash("sha1");
  h.update(model);
  for (const d of docs) { h.update("\0"); h.update(d.id); h.update("\0"); h.update(d.text); }
  return h.digest("hex").slice(0, 16);
}

let _mem: DenseIndex | null = null; // in-process cache (avoids re-reading disk on every find)

async function buildDenseIndex(docs: Doc[], embedder: Embedder): Promise<DenseIndex> {
  const model = embedder.name;
  const hash = docsHash(docs, model);
  if (_mem && _mem.hash === hash) return _mem;

  const file = path.join(cacheDir(), `dense-${hash}.json`);
  if (fs.existsSync(file)) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      const vecs = new Map<string, Float32Array>();
      for (const [id, arr] of Object.entries(raw.vecs as Record<string, number[]>)) {
        vecs.set(id, Float32Array.from(arr));
      }
      _mem = { hash, model, vecs };
      return _mem;
    } catch { /* corrupted cache → recompute */ }
  }

  const vecs = new Map<string, Float32Array>();
  for (const d of docs) vecs.set(d.id, await embedder.embed(d.text));
  _mem = { hash, model, vecs };
  try {
    fs.mkdirSync(cacheDir(), { recursive: true });
    const serial: Record<string, number[]> = {};
    for (const [id, v] of vecs) serial[id] = Array.from(v);
    fs.writeFileSync(file, JSON.stringify({ model, vecs: serial }));
  } catch { /* cache is an optimization; failure is not fatal */ }
  return _mem;
}

/**
 * Ranks the docs by dense similarity to the brief. Returns `null` when the
 * neural backend is not active — a signal for the router to skip fusion and
 * use BM25.
 */
export async function denseRank(
  brief: string,
  docs: Doc[],
): Promise<Array<{ id: string; score: number }> | null> {
  const embedder = await resolveEmbedder();
  if (embedder.name.startsWith("hash_tfidf")) return null; // neural inactive → no dense arm
  const index = await buildDenseIndex(docs, embedder);
  const q = await embedder.embed(brief);
  const scored = docs.map((d) => ({
    id: d.id,
    score: cosine(q, index.vecs.get(d.id) ?? new Float32Array(embedder.dim)),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored;
}
