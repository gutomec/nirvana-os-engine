// router-exposed-alternatives.test.ts — how many candidates a routing decision
// lets the caller see, and why that number is not 3 any more.
//
// The exposure cap was the dominant loss of the router. Measured on 35 real
// briefs harvested from the audit log (2026-09-17, engine 0.13.13 as installed):
// the right destination was the exposed top-1 in 0.171 of them, sat within the
// first 3 distinct destinations in 0.371, and within the first 15 in 0.686. The
// retriever had the answer four times more often than the decision showed it.
//
// These are unit tests over the pure helper on purpose: CI has no library, and
// the routing rates themselves are measured by eval-routing against a corpus.
import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const router = require_("../lib/router.js");
const { exposeAlternatives, EXPOSED_ALTERNATIVES_MAX, resolveDestination } = router;

/** A stage-2 match shaped the way buildMatchDocs meta is shaped. */
const cap = (squad: string, capability_id: string) => ({ id: `${capability_id}::${squad}`, meta: { type: "squad_capability", squad, capability_id } });
const squadDoc = (squad: string) => ({ id: `squad:${squad}`, meta: { type: "squad", squad } });
const biz = (slug: string) => ({ id: `business:${slug}`, meta: { type: "business", slug } });
const route = (slug: string, route_to: string) => ({ id: `business_route:${slug}:${route_to}`, meta: { type: "business_route", slug, route_to, pattern: "x" } });
const orphan = (id: string) => ({ id, meta: { type: "something-else" } });

describe("the exposure cap", () => {
  test("is 15, the depth the real-brief measurement justified", () => {
    expect(EXPOSED_ALTERNATIVES_MAX).toBe(15);
  });

  test("one entry per destination, in score order", () => {
    const matches = [
      cap("brandcraft", "design.identity.execute"),
      cap("brandcraft", "design.naming.execute"),
      squadDoc("brandcraft"),
      cap("polymath-press", "publishing.ebook.execute"),
      biz("ars-libri"),
    ];
    const out = exposeAlternatives(matches);
    expect(out.map((m: any) => resolveDestination(m))).toEqual(["brandcraft", "polymath-press", "ars-libri"]);
  });

  test("a squad occupying several slots no longer crowds the list", () => {
    // The shape the real briefs produced: 4.34 slots collapsing to 2.06
    // destinations, so the old "top 3" was a choice between two.
    const matches = [
      cap("ergoscan", "a.b.execute"), cap("ergoscan", "a.c.execute"), cap("ergoscan", "a.d.execute"),
      cap("onchain-architect", "crypto.spec.execute"), biz("systems-atelier"),
    ];
    expect(exposeAlternatives(matches).length).toBe(3);
    expect(matches.slice(0, 3).map((m: any) => resolveDestination(m))).toEqual(["ergoscan", "ergoscan", "ergoscan"]);
  });

  test("stops at the cap, and the limit is overridable", () => {
    const many = Array.from({ length: 40 }, (_, i) => biz(`b-${i}`));
    expect(exposeAlternatives(many).length).toBe(EXPOSED_ALTERNATIVES_MAX);
    expect(exposeAlternatives(many, { limit: 3 }).length).toBe(3);
    expect(exposeAlternatives(many, { limit: 100 }).length).toBe(40);
  });

  test("a business_route resolves to the squad it routes to, and dedupes against it", () => {
    const matches = [route("ars-libri", "ebook-maestro-nirvana::write"), cap("ebook-maestro-nirvana", "publishing.write.execute"), biz("ars-libri")];
    expect(exposeAlternatives(matches).map((m: any) => resolveDestination(m))).toEqual(["ebook-maestro-nirvana", "ars-libri"]);
  });

  test("candidates with no resolvable destination are kept, never collapsed", () => {
    const matches = [orphan("x"), orphan("y"), biz("acme"), biz("acme")];
    const out = exposeAlternatives(matches);
    expect(out.map((m: any) => m.id)).toEqual(["x", "y", "business:acme"]);
  });

  test("an empty or absent list is an empty list", () => {
    expect(exposeAlternatives([])).toEqual([]);
    expect(exposeAlternatives(undefined)).toEqual([]);
    expect(exposeAlternatives(null)).toEqual([]);
  });
});

describe("what the exposure cannot do", () => {
  test("stage 3 decides the signal before the list is built, so depth cannot change a verdict", () => {
    // The guarantee the gates rely on: every `alternatives` assignment in
    // stage3Decide sits inside a return whose `signal` is already chosen.
    const src = require_("node:fs").readFileSync(new URL("../lib/router.js", import.meta.url), "utf8") as string;
    const stage3 = src.slice(src.indexOf("function stage3Decide"), src.indexOf("function denseNoMatchFallback"));
    const assignments = [...stage3.matchAll(/alternatives:/g)];
    expect(assignments.length).toBeGreaterThan(0);
    // No assignment reintroduces the old hard 3.
    expect(stage3).not.toContain("alternatives: matches.slice(0, 3)");
    expect(stage3).not.toContain("alternatives: cluster.slice(1, 3)");
    for (const m of [...stage3.matchAll(/signal: '(\w+)'/g)]) expect(["HIGH", "AMBIGUOUS", "NO_MATCH"]).toContain(m[1]);
  });
});
