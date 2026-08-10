/**
 * rrf.js — Reciprocal Rank Fusion (Cormack et al. 2009), zero-dependency.
 *
 * Fuses N ranked lists (e.g. sparse BM25 + semantic dense) without depending on
 * each one's score scale — only on the POSITIONS. Each list contributes
 * `weight / (k + rank)` per document (rank 0-based); contributions add up by id.
 * This solves the incompatible-scale problem (BM25 0–15 × cosine 0–1) that
 * breaks any fusion by weighted sum of raw scores. k=60 is the canonical
 * constant from the literature (dampens the weight of the top).
 *
 * The dense path is optional in Nirvana: when the dense arm is absent, the router
 * uses BM25 only and never calls this. When present, `fuse` recombines the two.
 */

'use strict';

const DEFAULT_K = 60;

/**
 * @param {Array<{id: string, items: Array<{id: string}>, weight?: number}>} rankings
 *        One entry per ranked list. `items` already in decreasing order of
 *        relevance. `weight` defaults to 1.
 * @param {{k?: number}} [opts]
 * @returns {Array<{id: string, rrf: number, ranks: Record<string, number>}>}
 *          Unique ids sorted by decreasing RRF score, with the source ranks.
 */
function fuse(rankings, opts) {
  const k = (opts && typeof opts.k === 'number') ? opts.k : DEFAULT_K;
  const acc = new Map(); // id -> { rrf, ranks }
  for (const ranking of rankings || []) {
    if (!ranking || !Array.isArray(ranking.items)) continue;
    const weight = typeof ranking.weight === 'number' ? ranking.weight : 1;
    const label = ranking.id || 'list';
    for (let rank = 0; rank < ranking.items.length; rank++) {
      const item = ranking.items[rank];
      if (!item || item.id == null) continue;
      const id = item.id;
      let entry = acc.get(id);
      if (!entry) { entry = { id, rrf: 0, ranks: {} }; acc.set(id, entry); }
      entry.rrf += weight * (1 / (k + rank));
      entry.ranks[label] = rank;
    }
  }
  return [...acc.values()].sort((a, b) => b.rrf - a.rrf);
}

module.exports = { fuse, DEFAULT_K };
