/**
 * rrf.js — Reciprocal Rank Fusion (Cormack et al. 2009), zero-dependency.
 *
 * Funde N listas ranqueadas (ex.: BM25 esparso + denso semântico) sem depender
 * das escalas de score de cada uma — só das POSIÇÕES. Cada lista contribui
 * `weight / (k + rank)` por documento (rank 0-based); os aportes se somam por id.
 * Isto resolve o problema de escala incompatível (BM25 0–15 × cosseno 0–1) que
 * quebra qualquer fusão por soma ponderada de scores crus. k=60 é a constante
 * canônica da literatura (amortece o peso do topo).
 *
 * A via densa é opcional no Nirvana: quando o arm denso está ausente, o router
 * usa só o BM25 e nunca chama isto. Quando presente, `fuse` recombina os dois.
 */

'use strict';

const DEFAULT_K = 60;

/**
 * @param {Array<{id: string, items: Array<{id: string}>, weight?: number}>} rankings
 *        Uma entrada por lista ranqueada. `items` já em ordem decrescente de
 *        relevância. `weight` default 1.
 * @param {{k?: number}} [opts]
 * @returns {Array<{id: string, rrf: number, ranks: Record<string, number>}>}
 *          Ids únicos ordenados por score RRF decrescente, com os ranks de origem.
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
