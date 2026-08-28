// router-route-pattern-keywords.test.ts — the BM25 document of a business
// auto_route must carry the pattern's LITERALS, not its regex source.
//
// The defect this locks: `router.js` built the route document from
// `pattern.replace(/^type:/,'').replace(/[-_:]/g,' ')`, written when patterns
// were `type:X-Y_Z`. Every business route in the library is a regex instead,
// and the canonical tokenizer shreds one: `seguran[çc]a` becomes
// ["seguran","cc"] — neither is the brief's "seguranca" — while `\bLCP\b`
// becomes "blcp" and `.{0,24}` contributes "0" and "24". The route could not
// win a natural-language brief, so `routeFires` at stage3Decide (correct, and
// deliberately untouched here) never had a route leader to filter for.
import { describe, expect, test, afterAll } from "bun:test";
import { createRequire } from "node:module";

const EMBEDDER_BEFORE = process.env.NIRVANA_EMBEDDER;
process.env.NIRVANA_EMBEDDER = "off";
afterAll(() => {
  if (EMBEDDER_BEFORE === undefined) delete process.env.NIRVANA_EMBEDDER;
  else process.env.NIRVANA_EMBEDDER = EMBEDDER_BEFORE;
});

const require = createRequire(import.meta.url);
const router = require("../lib/router.js");
const bm25 = require("../lib/bm25.js");

const EMPTY_SQUADS = { schema_version: "1.0.0", capabilities: {}, squads: {} };

/** Tokens of the single business_route doc built for `pattern`. */
function routeTokens(pattern: string): Set<string> {
  const docs = router.buildMatchDocs(EMPTY_SQUADS, {
    schema_version: "1.0.0",
    businesses: { "software-forge": { domains: ["software"], manifest_path: "/x/business.yaml" } },
    _business_routing: { "software-forge": [{ pattern, route_to: "sf-security-engineer" }] },
  });
  const doc = docs.find((d: any) => d.meta?.type === "business_route");
  expect(doc).toBeTruthy();
  return new Set<string>(bm25.tokenize(doc.text));
}

describe("business_route documents index pattern literals", () => {
  test("a character class yields the folded word, not a prefix plus a garbage pair", () => {
    const t = routeTokens("(?i)(seguran[çc]a|security\\s+(review|audit)|threat\\s*model)");
    // What a brief actually says.
    expect(t.has("seguranca")).toBe(true);
    // What the class used to leave behind.
    expect(t.has("cc")).toBe(false);
    expect(t.has("seguran")).toBe(false);
  });

  test("alternation literals survive, escapes and quantifiers do not", () => {
    const t = routeTokens("(?i)(seguran[çc]a|security\\s+(review|audit)|threat\\s*model)");
    for (const w of ["security", "review", "audit", "threat", "model"]) {
      expect(t.has(w)).toBe(true);
    }
    for (const junk of ["s", "w", "b", "i"]) expect(t.has(junk)).toBe(false);
  });

  test("word-boundary escapes do not glue onto the acronym they guard", () => {
    const t = routeTokens("(?i)(core\\s+web\\s+vitals|\\bLCP\\b|\\bINP\\b|lighthouse)");
    expect(t.has("lcp")).toBe(true);
    expect(t.has("inp")).toBe(true);
    expect(t.has("blcp")).toBe(false);
    expect(t.has("binp")).toBe(false);
  });

  test("a bounded gap contributes no tokens of its own", () => {
    const t = routeTokens("(?i)(audite|revise)\\w*\\s+.{0,24}?(rascunho|cap[ií]tulo)");
    expect(t.has("audite")).toBe(true);
    expect(t.has("capitulo")).toBe(true);
    expect(t.has("0")).toBe(false);
    expect(t.has("24")).toBe(false);
    expect(t.has("ii")).toBe(false);
  });

  test("a `type:X-Y_Z` pattern keeps the behaviour it already had", () => {
    const t = routeTokens("type:meta-ads-campaign");
    for (const w of ["meta", "ads", "campaign"]) expect(t.has(w)).toBe(true);
    expect(t.has("type")).toBe(false);
  });

  test("a dot between two word characters is a joiner, not a gap", () => {
    // `stress.?test` and `stress-test` mean the same thing to the author. Only
    // the hyphen earns the joined token the tokenizer emits, and a brief that
    // writes "Stress-test" queries exactly that.
    const t = routeTokens("stress.?test\\w*|robustness|red.?team");
    expect(t.has("stresstest")).toBe(true);
    expect(t.has("stress")).toBe(true);
    expect(t.has("test")).toBe(true);
    expect(t.has("redteam")).toBe(true);
  });

  test("a bounded gap next to a dot is still a gap", () => {
    const t = routeTokens("(?i)(cruz\\w*|cross.?check\\w*)\\s+.{0,25}(depoiment\\w*|log)");
    expect(t.has("crosscheck")).toBe(true);
    // `.{0,25}` sits between `+` and `(` — not between two word characters.
    expect(t.has("25")).toBe(false);
    expect([...t].some((x) => x.includes("depoimentlog"))).toBe(false);
  });

  test("`type:` in front of an alternation is stripped and `_` separates", () => {
    // 139 live routes are this hybrid: the old shape's prefix, a regex body.
    // The tokenizer does not split `efd_icms_ipi`, so the underscore has to.
    const t = routeTokens("type:conciliacao_bancaria|bank_reconciliation|ofx");
    for (const w of ["conciliacao", "bancaria", "bank", "reconciliation", "ofx"]) {
      expect(t.has(w)).toBe(true);
    }
    expect(t.has("type")).toBe(false);
    expect(t.has("conciliacao_bancaria")).toBe(false);
  });

  test("a range, a negation and a lookaround contribute nothing rather than a guess", () => {
    const t = routeTokens("(?i)(series\\s+[a-d]|nr[\\s-]?15|deck)");
    expect(t.has("series")).toBe(true);
    expect(t.has("deck")).toBe(true);
    expect(t.has("nr")).toBe(true);
    expect(t.has("15")).toBe(true);
    for (const junk of ["a", "b", "c", "d", "ad"]) expect(t.has(junk)).toBe(false);
  });

  test("the route beats a squad doc that only shares the generic words", () => {
    const docs = router.buildMatchDocs(
      {
        schema_version: "1.0.0",
        squads: { "generic-writer": { description: "Escreve textos e revisões para o meu time", domains: ["writing"] } },
        capabilities: {},
      },
      {
        schema_version: "1.0.0",
        businesses: { "software-forge": { domains: ["software engineering"], manifest_path: "/x/business.yaml" } },
        _business_routing: {
          "software-forge": [{ pattern: "(?i)(seguran[çc]a|security\\s+(review|audit))", route_to: "sf-security-engineer" }],
        },
      },
    );
    const index = bm25.buildIndex(docs);
    const ranked = bm25.query(index, "preciso de uma revisão de segurança no meu monorepo", { topK: 5 });
    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked[0].doc?.meta?.type).toBe("business_route");
    expect(ranked[0].doc?.meta?.route_to).toBe("sf-security-engineer");
  });
});
