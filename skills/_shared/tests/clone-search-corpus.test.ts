// Regressão do corpus de busca de clones.
//
// Dois defeitos medidos em 2026-07-27 numa biblioteca de 542 clones:
//
// 1. O tokenizer partia acento (`[^a-z0-9_]+` sobre texto não normalizado), então
//    `perícia` virava `per`+`cia` e `hábito` virava `h`+`bito`. Numa biblioteca
//    escrita em português isso colidia palavras sem relação (`perícia`/`farmácia`
//    compartilham `cia`), quebrava singular contra plural, e inflava o
//    comprimento do documento — o que, com b=0.75, penalizava justamente o clone
//    que declarasse seus domínios em português contra o que declarasse em inglês.
//
// 2. O texto de recusa entrava no índice. BM25 pontua sobreposição de termo e não
//    tem noção de negação, então "não use para resposta direta" contava como voto
//    A FAVOR de resposta direta. Dois blocos escritos por autores independentes
//    apareceram em primeiro lugar nas consultas que a própria prosa queria
//    repelir. A correção é estrutural: o texto negativo mora em campos que o
//    corpus não lê.

import { test, expect } from "bun:test";
import * as path from "node:path";

const bm25 = require(path.join(import.meta.dir, "..", "..", "harness", "lib", "bm25.js"));

test("o tokenizer dobra acento em vez de partir a palavra", () => {
  expect(bm25.tokenize("perícia contábil")).toEqual(["pericia", "contabil"]);
  expect(bm25.tokenize("mudança de hábito")).toEqual(["mudanca", "habito"]); // "de" é stopword
  // Grafia acentuada e não acentuada da mesma palavra têm que casar.
  expect(bm25.tokenize("liderança")).toEqual(bm25.tokenize("lideranca"));
});

test("palavra acentuada não vira fragmento de IDF nulo", () => {
  // O defeito antigo quebrava cada palavra acentuada em duas, e a segunda metade
  // costumava ser uma letra solta: `visualização` -> `visualiza`+`o`,
  // `liderança` -> `lideran`+`a`. Uma palavra tem que render UM token.
  expect(bm25.tokenize("visualização")).toEqual(["visualizacao"]);
  expect(bm25.tokenize("liderança")).toEqual(["lideranca"]);
  expect(bm25.tokenize("visualização e liderança")).toHaveLength(2); // a conjunção sai como stopword
});

test("singular e plural acentuados compartilham a raiz", () => {
  const [sing] = bm25.tokenize("hábito");
  const [plur] = bm25.tokenize("hábitos");
  expect(plur.startsWith(sing)).toBe(true); // antes: `bito` vs `bitos` já divergiam no corte
});

// ── corpus: o texto negativo não pode ser indexado ──────────────────────────

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
  // O que o clone recusa não pode virar sinal de que ele serve para aquilo.
  expect(doc.text).not.toContain("resposta direta");
  expect(doc.text).not.toContain("conversão");
  expect(doc.text).not.toContain("gary-halbert");
});

test("os campos negativos seguem disponíveis para quem chama", () => {
  // Fora do índice, mas não perdidos: o filtro pós-recuperação depende deles.
  const doc = buildCloneDocForTest(CLONE);
  expect(doc.refuses).toEqual(["resposta direta", "copy de conversão"]);
  expect(doc.delegates_to).toEqual(["gary-halbert"]);
  expect(doc.not_for).toContain("resposta direta");
});

test("bloco legado sem `serves` continua indexando `when_to_use`", () => {
  // 171 blocos foram escritos antes da separação e misturam as duas vozes num
  // campo só. Descartá-los de uma vez perderia o sinal positivo que carregam.
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
  // As tags são anteriores ao bloco de roteamento e às vezes o contradizem.
  // `nicholas-felton` traz a tag `hábitos` e declara recusar mudança de hábito;
  // sem este filtro a tag sozinha bastava para ele disputar consultas de quem
  // tem método de hábito. A recusa manda sobre tudo que entra no corpus.
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
  expect(doc.text).toContain("dataviz");   // tag sem conflito sobrevive
  expect(doc.text).toContain("registro");
  expect(doc.text).not.toContain("hábitos"); // a que contradiz a recusa, não
});

test("o filtro de tag ignora acento e caixa", () => {
  const clone = {
    slug: "fixture-acento", display_name: "F", tags: ["Hábitos"],
    match: { one_liner: "x", domains: ["y"], refuses: ["habitos"] },
  };
  expect(buildCloneDocForTest(clone).text.toLowerCase()).not.toContain("bitos");
});

test("palavra funcional não pontua como palavra de conteúdo", () => {
  // IDF premia raridade. Num acervo majoritariamente em português as palavras
  // funcionais INGLESAS são raras, então pontuavam como se carregassem sentido:
  // medido sobre 542 clones, `and` (df 40) pesava 2.60 e `the` (df 53) pesava
  // 2.32, contra 2.18 de `marca`. Uma consulta perdeu seu dono legítimo para um
  // documento curto que só repetia "The Making of a Manager", casando `the`,
  // `of` e `a` — nenhum termo de conteúdo em comum.
  expect(bm25.tokenize("the making of a manager")).toEqual(["making", "manager"]);
  expect(bm25.tokenize("para o time de criação")).toEqual(["time", "criacao"]);
  // Palavra de conteúdo com grafia curta continua entrando.
  expect(bm25.tokenize("uso de dados")).toContain("uso");
});
