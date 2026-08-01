/**
 * BM25 in-process index (zero dependencies).
 *
 * Implements classical BM25 (Robertson/Sparck Jones) with k1=1.5, b=0.75 defaults.
 * Tokens are lowercase, split on [^a-z0-9_]+, preserving snake_case identifiers.
 *
 * API:
 *   buildIndex(docs)         -> Index
 *   query(index, q, opts?)   -> [{doc, score, normalized}]
 *
 * Where:
 *   docs = [{id, text, meta?}]
 *   opts = {topK?: 10, minScore?: 0, k1?: 1.5, b?: 0.75}
 *
 * Score normalization: max-score normalization (score / max_score). When the
 * top score is 0 (no overlap), normalized scores are 0. Compare normalized
 * scores against thresholds 0.80 / 0.60 / 0.15.
 */

'use strict';

const DEFAULT_K1 = 1.5;
const DEFAULT_B = 0.75;
const TOKEN_SPLIT = /[^a-z0-9_]+/;
const COMBINING_MARKS = /[̀-ͯ]/g;

/**
 * Function words dropped before scoring, Portuguese and English together.
 *
 * Not cosmetic tidying — in a mixed-language corpus BM25 actively rewards them.
 * IDF rewards rarity, and in a mostly-Portuguese corpus the English function
 * words are rare, so they score as if they carried meaning. Measured over 542
 * mind-clones: `and` (df 40) weighed 2.60 and `the` (df 53) weighed 2.32, while
 * `marca` (df 61) weighed 2.18. A query lost its rightful winner to a short
 * document that merely repeated "The Making of a Manager" — matching only `the`,
 * `of` and `a`, with no content term in common.
 *
 * Kept deliberately short: unambiguous function words only. Anything that could
 * carry meaning in either language stays in.
 *
 * The intent verbs are the same defect one layer up, and they arrived by way of
 * a rule meant to help. The routing contract asks each clone to declare the
 * symptom in the owner's own voice, and the owner's voice opens with "quero" or
 * "preciso" — so the scaffolding of the sentence entered the index. It is rare
 * there, and IDF pays for rarity: measured over 542 clones, `quero` (df 7) weighed
 * 4.28 against 1.40 for `marca` (df 134). Three times the weight of the noun that
 * names the domain. A clone of search experimentation took second place on "quero
 * uma segunda opinião sobre uma escolha" — it owns none of those words except the
 * verb, and vanishes from the top four once the verb is dropped.
 *
 * These are scaffolding in a query and never the subject of one. Ambiguous forms
 * stay in on purpose: `precisa` and `preciso` also read as adjectives ("uma
 * medição precisa"), `ajuda` and `help` are nouns in their own right.
 */
const STOPWORDS = new Set([
  // pt
  'a', 'o', 'as', 'os', 'um', 'uma', 'uns', 'umas', 'de', 'do', 'da', 'dos', 'das',
  'em', 'no', 'na', 'nos', 'nas', 'ao', 'aos', 'e', 'ou', 'que', 'com', 'por',
  'para', 'se', 'ser', 'sao', 'foi', 'era', 'como', 'mas', 'ja', 'nao', 'sem',
  'sobre', 'entre', 'ate', 'quando', 'onde', 'isso', 'este', 'esta', 'esse', 'essa',
  'seu', 'sua', 'meu', 'minha', 'pelo', 'pela', 'tem', 'mais', 'muito',
  // pt — verbos de intenção: andaime da consulta, nunca o assunto dela
  'quero', 'queria', 'queremos', 'quer', 'querem', 'gostaria', 'gostariamos',
  // en
  'the', 'of', 'and', 'or', 'to', 'in', 'on', 'at', 'for', 'with', 'from', 'by',
  'is', 'are', 'was', 'were', 'be', 'been', 'it', 'its', 'this', 'that', 'these',
  'those', 'an', 'as', 'but', 'not', 'no', 'my', 'our', 'your', 'their', 'we',
  'you', 'they', 'i', 'me', 'us', 'do', 'does', 'did', 'can', 'will', 'would',
  'how', 'what', 'when', 'where', 'who', 'which', 'about', 'into', 'than', 'then',
  // en — same scaffolding
  'want', 'wants', 'wanted', 'need', 'needs', 'needed',
]);

/**
 * Tokenize a string. Fold diacritics, lowercase, then split on non-alphanumeric
 * characters (preserving underscores so snake_case stays intact).
 *
 * The diacritic fold is not cosmetic. Without it `[^a-z0-9_]` treats every
 * accent as a separator, so a Portuguese corpus shatters: `perícia` -> `per`+`cia`,
 * `hábito` -> `h`+`bito`, `liderança` -> `lideran`+`a`. Three real costs:
 * fragments collide across unrelated words (`perícia`/`farmácia` share `cia`),
 * singular stops matching plural (`bito` vs `bitos`), and the junk fragments
 * inflate document length so BM25's length norm (b=0.75) penalises any clone
 * that declares its domains in Portuguese against one that declares them in
 * English. Folding applies to query and document alike, so accented and
 * unaccented spellings of the same word now match.
 *
 * @param {string} text
 * @returns {string[]} tokens (no empty strings)
 */
function tokenize(text) {
  if (!text || typeof text !== 'string') return [];
  return text
    .normalize('NFD')
    .replace(COMBINING_MARKS, '')
    .toLowerCase()
    .split(TOKEN_SPLIT)
    .filter((t) => t.length > 0 && !STOPWORDS.has(t));
}

/**
 * Build a BM25 index from an array of {id, text, meta?} documents.
 * Returns a frozen object with the structures needed for query().
 *
 * @param {Array<{id: string, text: string, meta?: any}>} docs
 * @returns {{
 *   docs: Array,
 *   docFreq: Map<string, number>,
 *   docLen: number[],
 *   docTokens: Array<Map<string, number>>,
 *   avgDocLen: number,
 *   N: number,
 *   k1: number,
 *   b: number
 * }}
 */
function buildIndex(docs, opts = {}) {
  const k1 = opts.k1 != null ? opts.k1 : DEFAULT_K1;
  const b = opts.b != null ? opts.b : DEFAULT_B;

  if (!Array.isArray(docs)) docs = [];

  const N = docs.length;
  const docTokens = new Array(N);
  const docLen = new Array(N);
  const docFreq = new Map();
  let totalLen = 0;

  for (let i = 0; i < N; i++) {
    const d = docs[i] || {};
    const tokens = tokenize(d.text || '');
    const tf = new Map();
    for (const t of tokens) {
      tf.set(t, (tf.get(t) || 0) + 1);
    }
    docTokens[i] = tf;
    docLen[i] = tokens.length;
    totalLen += tokens.length;
    // doc-frequency: count each unique term once per doc
    for (const t of tf.keys()) {
      docFreq.set(t, (docFreq.get(t) || 0) + 1);
    }
  }

  const avgDocLen = N > 0 ? totalLen / N : 0;

  return Object.freeze({
    docs: docs.slice(),
    docFreq,
    docLen,
    docTokens,
    avgDocLen,
    N,
    k1,
    b,
  });
}

/**
 * Compute BM25 IDF. Uses the "robust" formulation that clamps to a tiny
 * positive floor to avoid negative weights on very common terms.
 * @param {number} N total docs
 * @param {number} df doc frequency
 * @returns {number}
 */
function idf(N, df) {
  // Robust IDF: log( (N - df + 0.5) / (df + 0.5) + 1 )
  return Math.log(((N - df + 0.5) / (df + 0.5)) + 1);
}

/**
 * Query the index. Returns top-K matches with raw score and normalized score.
 * Normalized score = score / topScore (max-score normalization).
 *
 * @param {Object} index built via buildIndex
 * @param {string} q query string
 * @param {{topK?: number, minScore?: number}} opts
 * @returns {Array<{doc: any, score: number, normalized: number}>}
 */
function query(index, q, opts = {}) {
  if (!index || index.N === 0) return [];
  if (!q || typeof q !== 'string') return [];

  const topK = opts.topK != null ? opts.topK : 10;
  const minScore = opts.minScore != null ? opts.minScore : 0;

  const queryTokens = tokenize(q);
  if (queryTokens.length === 0) return [];

  // Dedup query tokens for IDF calc but preserve count? Classical BM25 sums
  // contributions per query term occurrence. Most BM25 impls treat the query
  // as a set; we follow that convention (idempotent on repeats).
  const seen = new Set();
  const queryUnique = [];
  for (const t of queryTokens) {
    if (!seen.has(t)) {
      seen.add(t);
      queryUnique.push(t);
    }
  }

  const scores = new Array(index.N).fill(0);
  const { k1, b, avgDocLen, docFreq, docLen, docTokens, N } = index;

  for (const t of queryUnique) {
    const df = docFreq.get(t) || 0;
    if (df === 0) continue;
    const w = idf(N, df);

    for (let i = 0; i < N; i++) {
      const tf = docTokens[i].get(t);
      if (!tf) continue;
      const dl = docLen[i] || 0;
      const denom = tf + k1 * (1 - b + b * (dl / (avgDocLen || 1)));
      const num = tf * (k1 + 1);
      scores[i] += w * (num / (denom || 1));
    }
  }

  // Build top-K
  const results = [];
  for (let i = 0; i < N; i++) {
    if (scores[i] > minScore) {
      results.push({ doc: index.docs[i], score: scores[i], normalized: 0 });
    }
  }

  results.sort((a, b) => b.score - a.score);
  const cut = results.slice(0, topK);

  const top = cut.length > 0 ? cut[0].score : 0;
  for (const r of cut) {
    r.normalized = top > 0 ? r.score / top : 0;
  }

  return cut;
}

module.exports = { buildIndex, query, tokenize };
