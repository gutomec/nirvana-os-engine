// Stage 3 regression — false ambiguity between routes of the same business.
//
// A `business_route` declares an activation regex. BM25 indexes the TEXT of that
// regex, and the patterns of a single business share almost every token
// (`ebook|livro|manual|guia`), so routes the brief does not trigger scored
// ~0.94 against the right route's 1.00. Three fabricated near-ties filled the
// ambiguity window and dropped HIGH to AMBIGUOUS — the router abstained
// between alternatives the declared contract itself already excluded.
//
// The rule is narrow on purpose: it only filters when the LEADER is a route that
// fires. The broad version was measured and rejected — on a domain-free brief
// ("quanto é dois mais dois") it removed the false competitor, the leader gained
// clearance and the signal turned HIGH pointing at a video squad. It traded safe
// abstention for confident error. An absolute score floor would compensate, but
// none exists: measured over real example_briefs against out-of-domain briefs,
// the distributions overlap (real reaches 5.5, out-of-domain reaches 12.2).

import { test, expect } from "bun:test";
import * as path from "node:path";

const { stage3Decide } = require(path.join(import.meta.dir, "..", "lib", "router.js"));

const rota = (slug: string, pattern: string, normalized: number) => ({
  id: `business_route:ars-libri:${slug}`,
  normalized,
  meta: { type: "business_route", slug: "ars-libri", route_to: slug, pattern },
});

const ESCREVER = "(escreva|crie|produza)\\s+(o|um|a)?\\s*(ebook|livro|manual)";
const FORMATAR = "(formate|exporte)\\s+(o|um)?\\s*(epub|pdf|kindle)";
const REVISAR = "(audite|revise)\\s+(o|um|meu)?\\s*(rascunho|manuscrito)";

test("rota que não dispara não conta como concorrente quando o líder dispara", () => {
  const brief = "escreva o ebook sobre renda passiva";
  const matches = [
    rota("write-bestseller", ESCREVER, 1.0),
    rota("format-only", FORMATAR, 0.94),
    rota("audit-and-revise", REVISAR, 0.93),
  ];
  const d = stage3Decide(matches, { brief });
  expect(d.signal).toBe("HIGH");
  expect(d.target.meta.route_to).toBe("write-bestseller");
});

test("sem o brief, o comportamento antigo é preservado", () => {
  // A caller that does not pass `brief` cannot be penalized: without text to
  // test the regex against, there is no way to know what fires.
  const matches = [
    rota("write-bestseller", ESCREVER, 1.0),
    rota("format-only", FORMATAR, 0.94),
  ];
  expect(stage3Decide(matches, {}).signal).toBe("AMBIGUOUS");
});

test("líder que NÃO dispara preserva a abstenção — o caso do brief sem domínio", () => {
  // This is the test that rejected the broad version of the filter. The brief
  // triggers no route at all; without a trusted leader, abstaining is right.
  const brief = "quanto é dois mais dois";
  const matches = [
    rota("write-bestseller", ESCREVER, 1.0),
    { id: "squad_capability:veo-motion-studio:video.image_to_video", normalized: 0.86, meta: { type: "squad_capability", squad: "veo-motion-studio" } },
  ];
  expect(stage3Decide(matches, { brief }).signal).toBe("AMBIGUOUS");
});

test("candidato que não é rota nunca é filtrado", () => {
  // Only `business_route` declares an activation contract. A squad capability
  // has no regex, so nothing in it can be discarded through this path.
  const brief = "escreva o ebook sobre renda passiva";
  const matches = [
    rota("write-bestseller", ESCREVER, 1.0),
    { id: "squad_capability:ebook-maestro-nirvana:content.book.write_bestseller", normalized: 0.9, meta: { type: "squad_capability", squad: "ebook-maestro-nirvana" } },
  ];
  const d = stage3Decide(matches, { brief });
  expect(d.signal).toBe("AMBIGUOUS");
  expect(d.alternatives.some((a: any) => a.meta.type === "squad_capability")).toBe(true);
});

test("flag inline (?i) não derruba o teste do regex", () => {
  // `(?i)` is Python/Go syntax; `new RegExp` throws on it. 9 of the library's
  // 498 routes use it. We compile with 'i', so stripping the prefix preserves
  // the meaning — without this, those routes would never be evaluated.
  const brief = "escreva o ebook sobre renda passiva";
  const matches = [
    rota("write-bestseller", `(?i)${ESCREVER}`, 1.0),
    rota("format-only", `(?i)${FORMATAR}`, 0.94),
  ];
  expect(stage3Decide(matches, { brief }).signal).toBe("HIGH");
});

test("regex inválido mantém o candidato em vez de descartá-lo", () => {
  const brief = "escreva o ebook sobre renda passiva";
  const matches = [
    rota("write-bestseller", ESCREVER, 1.0),
    rota("quebrado", "([sem fechar", 0.94),
  ];
  // A candidate with an invalid pattern cannot vanish over a data defect; when
  // in doubt it stays, and the decision comes out as before.
  expect(stage3Decide(matches, { brief }).signal).toBe("AMBIGUOUS");
});

test("cluster que resolve para o mesmo squad não é ambiguidade", () => {
  // `escreva o ebook` brings the squad's capability in 1st and the business
  // route to that SAME squad in 2nd, with a 0.076 lead — below what HIGH needs.
  // But the work lands in the same place, and choosing between "direto" and
  // "pela empresa" is not a question the owner answers better than the router.
  // This was case H4a/H4b of the external validation report.
  const matches = [
    { id: "squad_capability:ebook-maestro-nirvana:content.book.write_bestseller", normalized: 1.0, meta: { type: "squad_capability", squad: "ebook-maestro-nirvana" } },
    { id: "business_route:ars-libri:x", normalized: 0.924, meta: { type: "business_route", route_to: "ebook-maestro-nirvana::write-bestseller", pattern: "(escreva)\\s+(o)?\\s*(ebook)" } },
  ];
  const d = stage3Decide(matches, { brief: "escreva o ebook sobre renda passiva" });
  expect(d.signal).toBe("HIGH");
  expect(d.target.meta.squad).toBe("ebook-maestro-nirvana");
});

test("cluster capability + doc de squad do MESMO squad colapsa para HIGH", () => {
  // routing-360 Phase 2: buildMatchDocs emits one doc per squad (type 'squad').
  // It resolves to the same destination as the squad's capabilities — a near-
  // tie capability × squad-doc is not ambiguity, it is the same delivery place.
  const matches = [
    { id: "squad_capability:ebook-maestro-nirvana:content.book.write_bestseller", normalized: 1.0, meta: { type: "squad_capability", squad: "ebook-maestro-nirvana" } },
    { id: "squad:ebook-maestro-nirvana", normalized: 0.93, meta: { type: "squad", squad: "ebook-maestro-nirvana" } },
  ];
  const d = stage3Decide(matches, { brief: "escreva o ebook sobre renda passiva" });
  expect(d.signal).toBe("HIGH");
  expect(d.target.meta.type).toBe("squad_capability");
  expect(d.target.meta.squad).toBe("ebook-maestro-nirvana");
});

test("destinos diferentes continuam ambíguos", () => {
  // The protection cannot become a shortcut: two distinct squads tied is
  // exactly the case where abstaining is the right answer.
  const matches = [
    { id: "squad_capability:a:cap", normalized: 1.0, meta: { type: "squad_capability", squad: "squad-a" } },
    { id: "squad_capability:b:cap", normalized: 0.95, meta: { type: "squad_capability", squad: "squad-b" } },
  ];
  expect(stage3Decide(matches, { brief: "qualquer coisa" }).signal).toBe("AMBIGUOUS");
});

test("destino desconhecido não é colapsado", () => {
  // Without a `meta` identifying the squad, we cannot claim the destination is
  // the same — and claiming by omission would be worse than abstaining.
  const matches = [
    { id: "x:1", normalized: 1.0, meta: { type: "outro" } },
    { id: "x:2", normalized: 0.95, meta: { type: "outro" } },
  ];
  expect(stage3Decide(matches, { brief: "qualquer coisa" }).signal).toBe("AMBIGUOUS");
});
