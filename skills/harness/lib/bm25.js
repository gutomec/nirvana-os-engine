/**
 * BM25 in-process index (zero dependencies).
 *
 * Implements classical BM25 (Robertson/Sparck Jones) with k1=1.5, b=0.75 defaults.
 *
 * This module also owns THE canonical tokenizer for the whole routing stack
 * (router.js, clone-search.ts, search.ts, self-retrieval-gate.ts). Index time
 * and query time MUST use the same function — that invariant is why the
 * tokenizer lives here and everything else imports it.
 *
 * Tokenizer pipeline (routing-360 Phase 3.2):
 *   1. NFKC normalize (full-width forms, ligatures) → lowercase.
 *   2. Hyphen/acronym repair BEFORE any splitting:
 *        - single-letter hyphen chains collapse: E-E-A-T → eeat (the old
 *          splitter shattered it into stopwords plus a lone "t");
 *        - hyphenated compounds emit joined + parts: e-book → ebook, book
 *          (accented/PT spellings of either form now meet in the middle).
 *   3. Script detection: when the string contains non-Latin word characters
 *      (CJK, Kana, Hangul, Arabic, Hebrew, Cyrillic, Greek, Indic, Thai — a
 *      cheap regex class), segment with Intl.Segmenter('und', word) keeping
 *      isWordLike segments. Latin-only text keeps the fast path (NFD fold →
 *      split → stopwords). Feature-detected: without Segmenter/ICU the
 *      non-Latin path degrades to the historical Latin behavior — never crash.
 *   4. Single-char Latin/digit tokens are discarded (kills acronym residue);
 *      single-char CJK segments are kept — they are words.
 *
 * API:
 *   buildIndex(docs)         -> Index
 *   query(index, q, opts?)   -> [{doc, score, normalized}]
 *   tokenize(text)           -> string[]           (the ONE canonical tokenizer)
 *   coverage(qToks, docSet)  -> {matched, total}   (shared content-token gate)
 *   coverageBelowGate(cov)   -> boolean            (census bands, see router.js)
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

// Non-Latin WORD characters (script detection only — deliberately cheap, may
// include a few in-range punctuation codepoints; false positives just route a
// string through the Segmenter, which handles Latin fine). Ranges: Greek,
// Cyrillic, Armenian, Hebrew, Arabic/Syriac/Thaana, Indic, Thai/Lao/Tibetan/
// Myanmar, Hangul Jamo, CJK radicals, Kana, Hangul compat, CJK ideographs,
// Hangul syllables, CJK compat, halfwidth Kana. Latin Extended (incl.
// Vietnamese, Ḁ-ỿ) is intentionally NOT here — the NFD fold on the
// fast path already handles it, and the fast path is cheaper.
const NON_LATIN_WORD_CHARS = new RegExp(
  '[' +
  '\u0370-\u07bf' + // Greek, Cyrillic, Armenian, Hebrew, Arabic, Syriac, Thaana
  '\u0900-\u109f' + // Indic scripts, Thai, Lao, Tibetan, Myanmar
  '\u1100-\u11ff' + // Hangul Jamo
  '\u2e80-\u2fdf' + // CJK radicals
  '\u3040-\u30ff' + // Hiragana, Katakana
  '\u3130-\u318f' + // Hangul compatibility Jamo
  '\u3400-\u4dbf' + // CJK ideographs extension A
  '\u4e00-\u9fff' + // CJK unified ideographs
  '\uac00-\ud7af' + // Hangul syllables
  '\uf900-\ufaff' + // CJK compatibility ideographs
  '\uff66-\uff9f' + // halfwidth Katakana
  ']',
);

// Intl.Segmenter is feature-detected once. Bun/Node ship it with full ICU, but
// small-ICU builds or exotic runtimes may lack it or stub it — in that case the
// tokenizer degrades to the historical Latin path instead of crashing.
let _segmenter;
let _segmenterProbed = false;
function getSegmenter() {
  if (_segmenterProbed) return _segmenter;
  _segmenterProbed = true;
  _segmenter = null;
  try {
    if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
      const seg = new Intl.Segmenter('und', { granularity: 'word' });
      // Sanity probe: a stubbed ICU can construct but not segment CJK into
      // word-like pieces. Require at least one isWordLike segment.
      let ok = false;
      for (const part of seg.segment('机器学习 test')) {
        if (part.isWordLike) { ok = true; break; }
      }
      if (ok) _segmenter = seg;
    }
  } catch {
    _segmenter = null;
  }
  return _segmenter;
}

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
  // pt — intent verbs: query scaffolding, never its subject
  'quero', 'queria', 'queremos', 'quer', 'querem', 'gostaria', 'gostariamos',
  // en
  'the', 'of', 'and', 'or', 'to', 'in', 'on', 'at', 'for', 'with', 'from', 'by',
  'is', 'are', 'was', 'were', 'be', 'been', 'it', 'its', 'this', 'that', 'these',
  'those', 'an', 'as', 'but', 'not', 'no', 'my', 'our', 'your', 'their', 'we',
  'you', 'they', 'i', 'me', 'us', 'do', 'does', 'did', 'can', 'will', 'would',
  'how', 'what', 'when', 'where', 'who', 'which', 'about', 'into', 'than', 'then',
  // en — same scaffolding
  'want', 'wants', 'wanted', 'need', 'needs', 'needed',
  // es — minimal, unambiguous function words (folded forms; routing-360 Phase
  // 3.2). Same admission rule as pt/en: nothing that can carry meaning in
  // another indexed language. Deliberate EXCLUSIONS, each a measured collision:
  // 'la' (LA the city, pt 'lá' folds into it), 'son' (en noun), 'sin' (en
  // noun — quoted tokens below are stopword data: i18n-user-facing),
  // 'para'/'por'/'que'/'como'/'mas'/'cuando' (already covered by the
  // pt set post-fold). Single-char forms ('y', 'o', 'a', 'e') never reach
  // the filter — single-char Latin tokens are discarded by the tokenizer.
  'el', 'los', 'las', 'una', 'unos', 'unas', 'del', 'al', 'es', 'en', 'lo',
  'su', 'sus', 'mi', 'mis', 'muy', 'pero', 'tambien', 'donde', 'hasta',
  'desde', 'esto', 'eso', 'con', 'ya',
  // es — intent-verb scaffolding, same class as pt 'quero'/'preciso' above
  'quiero', 'necesito',
]);

/**
 * Hyphen/acronym repair — runs on the NFKC-lowercased string BEFORE any
 * splitting, so the splitter never sees the hyphens it used to shatter.
 *
 *   - Single-letter chains collapse: `e-e-a-t` → `eeat`. The old splitter
 *     produced `e`,`e`,`a`,`t` — three stopwords and a lone `t` that then
 *     matched every "t" residue in the corpus.
 *   - Hyphenated compounds emit joined + parts: `e-book` → `ebook e book`
 *     (the lone `e` is later discarded as a single-char token). Docs that
 *     write `ebook` and briefs that write `e-book` now meet, and the parts
 *     keep matching docs that write `book`.
 *
 * Lookarounds keep both rules off word-internal hyphens of longer chains
 * (`e-e-a-team` falls through to the compound rule as a whole).
 */
function repairHyphens(s) {
  if (!s.includes('-')) return s;
  // 1. all-single-char chains → joined acronym
  s = s.replace(
    /(?<![\p{L}\p{N}-])[\p{L}\p{N}](?:-[\p{L}\p{N}])+(?![\p{L}\p{N}-])/gu,
    (m) => m.replace(/-/g, ''),
  );
  // 2. remaining hyphenated compounds → joined form + split parts
  s = s.replace(
    /(?<![\p{L}\p{N}-])[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)+(?![\p{L}\p{N}-])/gu,
    (m) => m.replace(/-/g, '') + ' ' + m.replace(/-/g, ' '),
  );
  return s;
}

/**
 * Plural-folding stemmer — OFF by default, opt-in via NIRVANA_TOKENIZER_STEM=1
 * for measurement only. Cheap pt/en/es plural rules applied post-fold; run the
 * routing + clone evals with the env set to quantify before ever enabling.
 */
function stemPlural(t) {
  if (t.length < 4 || t.charCodeAt(t.length - 1) !== 115 /* 's' */) return t;
  if (t.endsWith('oes') || t.endsWith('aes')) return t.slice(0, -3) + 'ao'; // ações→acao
  if (t.endsWith('ais')) return t.slice(0, -3) + 'al'; // animais→animal
  if (t.endsWith('eis')) return t.slice(0, -3) + 'el'; // papeis→papel
  if (t.endsWith('ies') && t.length > 4) return t.slice(0, -3) + 'y'; // stories→story
  if (!t.endsWith('ss')) return t.slice(0, -1); // habitos→habito, books→book
  return t;
}

/**
 * Latin fast path: NFD fold, split, drop stopwords and single-char tokens.
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
 * Single-char LETTER tokens are discarded: in Latin script a lone letter is
 * never a content word, and acronym shatter used to leak residue like the `t`
 * of E-E-A-T into the index. Single-char DIGITS are kept — they are content
 * ("9 mentes", "9:16", "nota 5"; measured: dropping them flipped two live
 * golden briefs whose only distinctive anchor was the digit). CJK single-char
 * words never reach this path — the Segmenter branch keeps them.
 *
 * Expects text already NFKC-normalized, lowercased and hyphen-repaired.
 */
function latinTokens(s) {
  const stem = process.env.NIRVANA_TOKENIZER_STEM === '1';
  const out = s
    .normalize('NFD')
    .replace(COMBINING_MARKS, '')
    .split(TOKEN_SPLIT)
    .filter((t) => (t.length > 1 || (t.length === 1 && t >= '0' && t <= '9')) && !STOPWORDS.has(t));
  return stem ? out.map(stemPlural) : out;
}

/**
 * THE canonical tokenizer (see module header for the full pipeline). Used at
 * index time and query time by every consumer — router.js, clone-search.ts,
 * search.ts, self-retrieval-gate.ts. Never fork this logic.
 *
 * @param {string} text
 * @returns {string[]} tokens (no empty strings)
 */
function tokenize(text) {
  if (!text || typeof text !== 'string') return [];
  let s;
  try { s = text.normalize('NFKC'); } catch { s = text; }
  s = repairHyphens(s.toLowerCase());

  if (NON_LATIN_WORD_CHARS.test(s)) {
    const seg = getSegmenter();
    if (seg) {
      const out = [];
      for (const part of seg.segment(s)) {
        if (!part.isWordLike) continue;
        const w = part.segment;
        if (NON_LATIN_WORD_CHARS.test(w)) {
          // Non-Latin word (Segmenter already found the word boundary — for
          // CJK that is a dictionary-segmented word). Single-char CJK segments
          // are words and are kept.
          out.push(w);
        } else {
          // Latin/digit segment inside mixed-script text: run it through the
          // SAME Latin pipeline as pure-Latin strings, so a doc indexed via
          // this branch and a query tokenized via the fast path still meet.
          for (const t of latinTokens(w)) out.push(t);
        }
      }
      return out;
    }
    // Segmenter/ICU unavailable: degrade to the historical Latin behavior
    // (non-Latin runs become separators). Lossy but never a crash.
  }

  return latinTokens(s);
}

/**
 * Content-token coverage: how many of the query's unique content tokens the
 * document's token set contains. THE shared implementation behind the router's
 * NO_MATCH-by-coverage gate (router.js stage3Decide) and the clone-search
 * usefulness gate — extracted here (routing-360 Phase 3.2) so both consult one
 * function instead of two drifting copies.
 *
 * `aliases` (optional): Map<token, Set<token>> of cross-language alias groups.
 * A query token counts as matched when the doc contains it OR any sibling from
 * its group — the amplification bridge uses this so "livro"-declared docs can
 * cover an "ebook" brief without either side rewriting its vocabulary.
 *
 * @param {string[]|Set<string>} queryTokens content tokens of the brief
 * @param {Set<string>} docTokenSet          content tokens of the document
 * @param {Map<string, Set<string>>} [aliases]
 * @returns {{matched: number|null, total: number}}
 */
function coverage(queryTokens, docTokenSet, aliases) {
  const uniq = queryTokens instanceof Set ? queryTokens : new Set(queryTokens || []);
  if (uniq.size === 0) return { matched: null, total: 0 };
  let matched = 0;
  for (const t of uniq) {
    if (docTokenSet.has(t)) { matched++; continue; }
    if (aliases) {
      const group = aliases.get(t);
      if (group) {
        for (const sibling of group) {
          if (docTokenSet.has(sibling)) { matched++; break; }
        }
      }
    }
  }
  return { matched, total: uniq.size };
}

/**
 * True when a winner's coverage sits in the out-of-domain / confirm bands of
 * the 2026-07-27 census (real briefs match ≥3 winner tokens; out-of-domain
 * match ≤2 — see router.js stage3Decide for the per-band signals). Shared by
 * the router's amplification bridge and the clone-search gate: "below gate"
 * here means stage3 would abstain (NO_MATCH) or ask to confirm (AMBIGUOUS)
 * on coverage grounds.
 */
function coverageBelowGate(cov) {
  if (!cov || typeof cov.matched !== 'number' || typeof cov.total !== 'number' || cov.total <= 0) {
    return false;
  }
  if (cov.matched <= 1 && cov.total >= 3) return true; // out-of-domain count band
  if (cov.matched === 2 && cov.total >= 4 && cov.matched / cov.total <= 0.5) return true; // confirm band
  if (cov.matched <= 1 && cov.total === 2) return true; // short-brief mixed signals
  return false;
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

module.exports = { buildIndex, query, tokenize, coverage, coverageBelowGate };
