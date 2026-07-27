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
// Peso do braço esparso na fusão. Calibrado em varredura (ver avaliar-fusao):
// 1.0 perde casamento exato para vizinhança semântica; 3.0 anula o braço denso.
const DEFAULT_SPARSE_WEIGHT = 2;

const bm25 = require(path.join(import.meta.dir, "..", "..", "harness", "lib", "bm25.js"));

export type CloneHit = {
  slug: string;
  display_name: string;
  score: number;
  normalized: number;
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

  // `refuses` manda sobre tudo que é indexado, venha o termo de onde vier. As
  // tags do manifesto são anteriores ao bloco de roteamento e às vezes o
  // contradizem: `nicholas-felton` traz a tag `hábitos` enquanto declara recusar
  // mudança de hábito — e a tag sozinha bastava para ele disputar consultas que
  // pertencem a quem tem método de hábito. Editar 542 manifestos à mão para isso
  // seria trabalho manual recorrente; aplicar a recusa como filtro resolve de uma
  // vez e mantém uma regra só.
  const norm = (s: string) => String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
  const recusados = new Set(refuses.map(norm));
  const tags = (Array.isArray(c.tags) ? c.tags : []).filter((t: string) => !recusados.has(norm(t)));

  // DÍVIDA CONHECIDA — nome de pessoa no corpus de necessidade.
  //
  // `slug` e `display_name` são indexados, e sobrenome colide com substantivo
  // comum em português. Medido: "meu filho desiste na primeira dificuldade" cai
  // em `mario-filho-data`, "o porto e a logística portuária" em `camila-porto`,
  // "a rocha da estratégia" em `melina-rocha`. São 8 colisões atingindo 15
  // clones (ramos, rocha, filho, monteiro, porto, silva, lobo, couto).
  //
  // O conserto é tirar o nome daqui: busca POR NOME tem caminho próprio e roda
  // ANTES do BM25 (o passo SOLICITADO do team-orchestrator), então neste corpus,
  // que existe para descoberta por NECESSIDADE, o nome é ruído.
  //
  // Não dá para fazer isso ainda: enquanto houver clone sem bloco `routing:`, o
  // nome é a única âncora que ele tem — `billy-wilder` não tem nem tags. Tirar
  // agora o tornaria inencontrável. Fazer quando o enriquecimento fechar.
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
  // Text for the dense arm. Deliberately NOT the sparse `text`: one vector per
  // document averages everything in it, so slug, tags, category and a long
  // when_to_use paragraph drown the specific claim. `greg-verdino-consulting`
  // declares "prontidão para IA" and still lost an AI-readiness query to noise
  // for exactly that reason. Embedding only what the clone is and what it does
  // keeps the vector pointed at the need it answers.
  const denseText = [m.one_liner || c.display_name || c.slug, (Array.isArray(m.domains) ? m.domains : []).join(". ")]
    .filter(Boolean).join(". ");
  return {
    text,
    denseText,
    slug: c.slug,
    display_name: c.display_name || c.slug,
    one_liner: m.one_liner || null,
    pack_category: c.pack_category || null,
    not_for: m.not_for || null,
    refuses: Array.isArray(m.refuses) ? m.refuses : [],
    delegates_to: Array.isArray(m.delegates_to) ? m.delegates_to : [],
  };
}

/** Exposto só para o teste de corpus: garante que a exclusão do texto negativo
 *  seja verificável sem montar um registry inteiro em disco. */
export const buildCloneDocForTest = cloneDoc;

function toHit(h: any): CloneHit {
  return {
    slug: h.doc.slug,
    display_name: h.doc.display_name,
    score: h.score,
    normalized: h.normalized,
    one_liner: h.doc.one_liner,
    pack_category: h.doc.pack_category,
    not_for: h.doc.not_for,
    refuses: h.doc.refuses,
    delegates_to: h.doc.delegates_to,
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

  return hits.filter((h: any) => h.normalized >= minNorm).map(toHit);
}

/** Same ranking, plus a dense (embedding) arm fused with BM25 via RRF.
 *
 *  OPT-IN, AND NOT THE DEFAULT — it measured WORSE than plain BM25 here. Swept
 *  against 542 clones (2026-07-27, sparse weight 1/1.5/2/3), best hybrid vs
 *  sparse-only:
 *
 *      self-retrieval  167/171  vs  171/171
 *      need-phrased      6/12   vs   10/12
 *      PT/EN agreement    2/6   vs     3/6
 *
 *  The reason is worth keeping: a general-purpose paraphrase embedder scores
 *  topical closeness, but the question here is "who DECLARES this capability".
 *  Asked who owns a brand's verbal voice it returns a voice-acting director —
 *  `voz` is polysemous and the vector cannot tell the senses apart, while BM25
 *  gets it right off `verbal` + `marca` in the declared domains. Asked about AI
 *  readiness it returns famous AI people instead of the clone whose block states
 *  AI readiness outright.
 *
 *  Where it does win is when BM25 has almost no term overlap and returns pure
 *  noise (a colourist for an AI-readiness query). Gating on that regime needs a
 *  confidence signal, and six observations are not enough to set a threshold
 *  without inventing a magic number — so it stays opt-in until someone measures
 *  it properly on an unbiased query set.
 *
 *  Async because embedding is. `denseRank` returns null when the neural backend
 *  is not active (NIRVANA_EMBEDDER), and then this degrades to exactly the BM25
 *  result — never worse than the sync path, never a hard dependency. */
export async function findCloneForTaskHybrid(
  brief: string,
  opts: { limit?: number; minNormalized?: number; sparseWeight?: number } = {},
): Promise<CloneHit[]> {
  const reg = loadCloneRegistry();
  const docs = Object.values(reg).map(cloneDoc);
  if (!docs.length || !brief) return [];

  const limit = opts.limit || 8;
  const minNorm = opts.minNormalized != null ? opts.minNormalized : 0;

  const idx = bm25.buildIndex(docs);
  // Fuse over a deep BM25 slice, not the final top-N: a doc the dense arm loves
  // has to be present in the sparse list to survive fusion at all.
  const sparse = bm25.query(idx, brief, { topK: Math.max(limit * 5, 50) });

  let dense: Array<{ id: string; score: number }> | null = null;
  try {
    const { denseRank } = await import("./dense-index.ts");
    dense = await denseRank(brief, docs.map((d) => ({ id: d.slug, text: d.denseText })));
  } catch {
    dense = null; // neural backend absent or failed — sparse-only is a valid answer
  }
  if (!dense) return sparse.slice(0, limit).filter((h: any) => h.normalized >= minNorm).map(toHit);

  const { fuse } = require(path.join(import.meta.dir, "..", "..", "harness", "lib", "rrf.js"));
  // The sparse arm carries more weight than the dense one. RRF is rank-only and
  // throws away magnitude, so a clone that literally declares the queried domain
  // gets fused as just "rank 1" and can lose to something merely adjacent in both
  // lists. Since every enriched clone states its domains outright, exact term
  // overlap is high-precision evidence here and should not be outvoted by
  // semantic neighbourhood. The dense arm still decides whenever the sparse one
  // has nothing — which is the case it was added for.
  const wSparse = opts.sparseWeight != null ? opts.sparseWeight : DEFAULT_SPARSE_WEIGHT;
  const fused = fuse([
    { id: "sparse", weight: wSparse, items: sparse.map((h: any) => ({ id: h.doc.slug })) },
    { id: "dense", weight: 1, items: dense.slice(0, Math.max(limit * 5, 50)).map((d) => ({ id: d.id })) },
  ]);

  const bySlug = new Map(docs.map((d) => [d.slug, d]));
  const sparseScore = new Map(sparse.map((h: any) => [h.doc.slug, h.score]));
  const top = fused.length ? fused[0].rrf : 0;

  return fused
    .slice(0, limit)
    .map((f: any) => ({ doc: bySlug.get(f.id), score: sparseScore.get(f.id) || 0, normalized: top > 0 ? f.rrf / top : 0 }))
    .filter((h: any) => h.doc && h.normalized >= minNorm)
    .map(toHit);
}
