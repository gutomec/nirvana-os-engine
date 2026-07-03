/**
 * embedder.ts — text → vector. Default impl is hash-based TF-IDF (no
 * external dependencies, offline). Optional backends can be wired later
 * (Voyage, OpenAI, Ollama) but the default path always works.
 *
 * Phase 6 da nirvana-evolution. The choice of embedder is per-business
 * via business.yaml `memory.embedding.model` (when we wire that into the
 * loader). Until then, default is `hash_tfidf`.
 */

const DEFAULT_DIM = 256;

const STOPWORDS_PT_EN = new Set([
  // PT-BR
  "a", "o", "as", "os", "um", "uma", "uns", "umas",
  "de", "da", "do", "das", "dos", "para", "por", "com", "sem", "em",
  "no", "na", "nos", "nas", "ao", "aos", "à", "às", "que", "se", "é",
  "e", "ou", "mas", "como", "também", "mais", "menos",
  // EN
  "the", "a", "an", "of", "for", "to", "in", "on", "at", "by", "with",
  "is", "are", "and", "or", "but", "as", "be", "this", "that",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")        // strip accents for matching
    .replace(/[^\w\s]/g, " ")               // strip punct
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !STOPWORDS_PT_EN.has(t));
}

// Stable string hash → integer (djb2 variant)
function hashTo(token: string, mod: number): number {
  let h = 5381;
  for (let i = 0; i < token.length; i++) h = ((h << 5) + h + token.charCodeAt(i)) | 0;
  return Math.abs(h) % mod;
}

/**
 * Hash-based TF-IDF embedder. Deterministic, offline, fast. Quality is
 * lower than learned embeddings but sufficient for keyword-overlap-style
 * retrieval which is the dominant memory use case in Nirvana today.
 */
export function embed_hash_tfidf(text: string, dim = DEFAULT_DIM): Float32Array {
  const tokens = tokenize(text);
  const v = new Float32Array(dim);
  if (tokens.length === 0) return v;
  const tf = new Map<number, number>();
  for (const t of tokens) {
    const i = hashTo(t, dim);
    tf.set(i, (tf.get(i) ?? 0) + 1);
  }
  // Simple log-normalized TF (no IDF without a corpus); good enough as a
  // cheap baseline.
  let norm = 0;
  for (const [i, c] of tf.entries()) {
    const val = 1 + Math.log(c);
    v[i] = val;
    norm += val * val;
  }
  // L2-normalize so cosine = dot
  const n = Math.sqrt(norm) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

export interface Embedder {
  name: string;
  dim: number;
  embed(text: string): Promise<Float32Array> | Float32Array;
}

export const DEFAULT_EMBEDDER: Embedder = {
  name: "hash_tfidf_v1",
  dim: DEFAULT_DIM,
  embed: (text) => embed_hash_tfidf(text),
};

/**
 * Cosine similarity for L2-normalized vectors (equivalent to dot product).
 */
export function cosine(a: Float32Array | number[], b: Float32Array | number[]): number {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += (a[i] as number) * (b[i] as number);
  return s;
}

export const __internal__ = { tokenize, hashTo };
