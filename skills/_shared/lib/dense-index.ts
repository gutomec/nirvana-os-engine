/**
 * dense-index.ts — braço DENSO opcional do roteador híbrido.
 *
 * Embute cada capability/business doc uma vez (cacheado em disco, invalidado por
 * hash do conteúdo + modelo) e ranqueia um brief por similaridade de cosseno.
 * Só opera quando o backend neural está ativo (NIRVANA_EMBEDDER=transformers +
 * pacote instalado); caso contrário `denseRank` devolve null e o router usa BM25
 * puro. Não fundimos o hash_tfidf com o BM25 porque ambos são lexicais — o ganho
 * da via densa vem do modelo neural (sinônimos/paráfrase que o BM25 não pega).
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

let _mem: DenseIndex | null = null; // cache em processo (evita reler o disco a cada find)

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
    } catch { /* cache corrompido → recomputa */ }
  }

  const vecs = new Map<string, Float32Array>();
  for (const d of docs) vecs.set(d.id, await embedder.embed(d.text));
  _mem = { hash, model, vecs };
  try {
    fs.mkdirSync(cacheDir(), { recursive: true });
    const serial: Record<string, number[]> = {};
    for (const [id, v] of vecs) serial[id] = Array.from(v);
    fs.writeFileSync(file, JSON.stringify({ model, vecs: serial }));
  } catch { /* cache é otimização; falha não é fatal */ }
  return _mem;
}

/**
 * Ranqueia os docs por similaridade densa ao brief. Devolve `null` quando o
 * backend neural não está ativo — sinal para o router pular a fusão e usar BM25.
 */
export async function denseRank(
  brief: string,
  docs: Doc[],
): Promise<Array<{ id: string; score: number }> | null> {
  const embedder = await resolveEmbedder();
  if (embedder.name.startsWith("hash_tfidf")) return null; // neural inativo → sem braço denso
  const index = await buildDenseIndex(docs, embedder);
  const q = await embedder.embed(brief);
  const scored = docs.map((d) => ({
    id: d.id,
    score: cosine(q, index.vecs.get(d.id) ?? new Float32Array(embedder.dim)),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored;
}
