// Clone search corpus regression.
//
// Two defects measured on 2026-07-27 in a 542-clone library:
//
// 1. The tokenizer split on accents (`[^a-z0-9_]+` over non-normalized text), so
//    `perícia` became `per`+`cia` and `hábito` became `h`+`bito`. In a library
//    written in Portuguese this collided unrelated words (`perícia`/`farmácia`
//    share `cia`), broke singular against plural, and inflated the document
//    length — which, with b=0.75, penalized precisely the clone declaring its
//    domains in Portuguese against the one declaring them in English.
//
// 2. Refusal text entered the index. BM25 scores term overlap and has no notion
//    of negation, so "não use para resposta direta" counted as a vote IN FAVOR
//    of direct response. Two blocks written by independent authors ranked first
//    on the very queries their own prose meant to repel. The fix is structural:
//    the negative text lives in fields the corpus does not read.

import { test, expect } from "bun:test";
import * as path from "node:path";

const bm25 = require(path.join(import.meta.dir, "..", "..", "harness", "lib", "bm25.js"));

test("o tokenizer dobra acento em vez de partir a palavra", () => {
  expect(bm25.tokenize("perícia contábil")).toEqual(["pericia", "contabil"]);
  expect(bm25.tokenize("mudança de hábito")).toEqual(["mudanca", "habito"]); // "de" is a stopword
  // Accented and unaccented spellings of the same word have to match.
  expect(bm25.tokenize("liderança")).toEqual(bm25.tokenize("lideranca"));
});

test("palavra acentuada não vira fragmento de IDF nulo", () => {
  // The old defect broke every accented word in two, and the second half was
  // usually a lone letter: `visualização` -> `visualiza`+`o`,
  // `liderança` -> `lideran`+`a`. One word has to yield ONE token.
  expect(bm25.tokenize("visualização")).toEqual(["visualizacao"]);
  expect(bm25.tokenize("liderança")).toEqual(["lideranca"]);
  expect(bm25.tokenize("visualização e liderança")).toHaveLength(2); // the conjunction drops out as a stopword
});

test("singular e plural acentuados compartilham a raiz", () => {
  const [sing] = bm25.tokenize("hábito");
  const [plur] = bm25.tokenize("hábitos");
  expect(plur.startsWith(sing)).toBe(true); // before: `bito` vs `bitos` already diverged at the cut
});

// ── corpus: negative text must never be indexed ─────────────────────────────

const { buildCloneDocForTest } = await import("../lib/clone-search.ts");

const CLONE = {
  slug: "fixture-copy",
  display_name: "Fixture",
  tags: [],
  match: {
    one_liner: "Escreve identidade verbal de marca.",
    domains: ["tom de voz de marca", "brand tone of voice"],
    serves: "Escolha para manifesto e tom de voz.",
    not_for: "Não faz resposta direta nem copy de conversão para funil de venda.",
    refuses: ["resposta direta", "copy de conversão"],
    delegates_to: ["gary-halbert"],
  },
};

test("o corpus indexa o positivo e ignora recusa, delegação e refuses", () => {
  const doc = buildCloneDocForTest(CLONE);
  expect(doc.text).toContain("tom de voz");
  expect(doc.text).toContain("manifesto");
  // What the clone refuses cannot become a signal that it serves for that.
  expect(doc.text).not.toContain("resposta direta");
  expect(doc.text).not.toContain("conversão");
  expect(doc.text).not.toContain("gary-halbert");
});

test("os campos negativos seguem disponíveis para quem chama", () => {
  // Out of the index, but not lost: the post-retrieval filter depends on them.
  const doc = buildCloneDocForTest(CLONE);
  expect(doc.refuses).toEqual(["resposta direta", "copy de conversão"]);
  expect(doc.delegates_to).toEqual(["gary-halbert"]);
  expect(doc.not_for).toContain("resposta direta");
});

test("bloco legado sem `serves` continua indexando `when_to_use`", () => {
  // 171 blocks were written before the split and mix the two voices in a single
  // field. Discarding them outright would lose the positive signal they carry.
  const legado = { ...CLONE, match: { ...CLONE.match, serves: null, when_to_use: "Escolha para naming e tagline." } };
  expect(buildCloneDocForTest(legado).text).toContain("naming");
});

test("`serves` tem precedência sobre `when_to_use` quando ambos existem", () => {
  const ambos = { ...CLONE, match: { ...CLONE.match, when_to_use: "texto legado que nao deve entrar" } };
  const doc = buildCloneDocForTest(ambos);
  expect(doc.text).toContain("manifesto");
  expect(doc.text).not.toContain("legado");
});

test("tag do manifesto que contradiz `refuses` não é indexada", () => {
  // Tags predate the routing block and sometimes contradict it.
  // `nicholas-felton` carries the tag `hábitos` and declares refusing habit
  // change; without this filter the tag alone let it contest queries from
  // whoever has a habit method. Refusal rules over all that enters the corpus.
  const clone = {
    slug: "fixture-tags",
    display_name: "Fixture",
    tags: ["hábitos", "dataviz", "registro"],
    match: {
      one_liner: "Registra a própria vida em números.",
      domains: ["relatório anual pessoal"],
      refuses: ["hábitos", "mudança de hábito"],
    },
  };
  const doc = buildCloneDocForTest(clone);
  expect(doc.text).toContain("dataviz");   // conflict-free tag survives
  expect(doc.text).toContain("registro");
  expect(doc.text).not.toContain("hábitos"); // the one contradicting the refusal does not
});

test("o filtro de tag ignora acento e caixa", () => {
  const clone = {
    slug: "fixture-acento", display_name: "F", tags: ["Hábitos"],
    match: { one_liner: "x", domains: ["y"], refuses: ["habitos"] },
  };
  expect(buildCloneDocForTest(clone).text.toLowerCase()).not.toContain("bitos");
});

test("palavra funcional não pontua como palavra de conteúdo", () => {
  // IDF rewards rarity. In a mostly Portuguese collection the ENGLISH function
  // words are rare, so they scored as if they carried meaning: measured over
  // 542 clones, `and` (df 40) weighed 2.60 and `the` (df 53) weighed 2.32,
  // against 2.18 for `marca`. One query lost its rightful owner to a short
  // document that just repeated "The Making of a Manager", matching `the`,
  // `of` and `a` — no content term in common.
  expect(bm25.tokenize("the making of a manager")).toEqual(["making", "manager"]);
  expect(bm25.tokenize("para o time de criação")).toEqual(["time", "criacao"]);
  // A content word with a short spelling still gets in.
  expect(bm25.tokenize("uso de dados")).toContain("uso");
});
