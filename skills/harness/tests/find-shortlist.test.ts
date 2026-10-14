// find-shortlist.test.ts — what `nrv find` hands the orchestrator.
//
// Measured on 48 labeled requests (2026-10-13): one mixed list of five put the
// right business in front of the orchestrator for 78% of the parts; businesses
// and squads ranked apart, five each, for 95%. These tests lock the shape that
// produced the second number. The rates themselves need a library; CI has none.
import { describe, expect, test } from "bun:test";
import { parseFindArgs, rankShortlist, renderJev, renderShortlist, SHORTLIST_SIZE } from "../scripts/find.ts";

const cap = (squad: string, capability_id: string) => ({ id: `squad_capability:${squad}:${capability_id}`, meta: { type: "squad_capability", squad, capability_id }, coverage: { matched: 3, total: 4 } });
const biz = (slug: string) => ({ id: `business:${slug}`, meta: { type: "business", slug }, coverage: { matched: 2, total: 4 } });
const route = (slug: string, route_to: string) => ({ id: `business_route:${slug}:${route_to}`, meta: { type: "business_route", slug, route_to, pattern: "x" } });

const registries = {
  businesses: { businesses: {
    "launch-house": { description: "Launches finished games.", produces: ["steam-store-page-kit"], not_for: ["building the game"] },
    "game-studio": { description: "Builds games.", produces: ["game-design-document"] },
  } },
  squads: {
    squads: {
      "launch-marketing": { description: "Store pages and wishlists.", produces: ["steam-store-page-kit"], capabilities: ["gaming.launch.plan"] },
      "token-forge": { description: "Solana tokens.", produces: ["tokenomics"], capabilities: ["crypto.token.design"] },
    },
    capabilities: { "gaming.launch.plan": [{ squad: "launch-marketing", not_for: ["game design"] }] },
  },
};

describe("the shortlist", () => {
  test("businesses and squads are ranked apart, each destination once", () => {
    const s = rankShortlist([cap("launch-marketing", "gaming.launch.plan"), biz("game-studio"), cap("launch-marketing", "gaming.launch.plan"), cap("token-forge", "crypto.token.design"), biz("launch-house")], registries);
    expect(s.businesses.map((b) => b.slug)).toEqual(["game-studio", "launch-house"]);
    expect(s.squads.map((q) => [q.slug, q.capability])).toEqual([["launch-marketing", "gaming.launch.plan"], ["token-forge", "crypto.token.design"]]);
  });

  test("a business route lists its business, never the seat it routes to", () => {
    const s = rankShortlist([route("launch-house", "lh-marketing-director"), biz("launch-house")], registries);
    expect(s.businesses.map((b) => b.slug)).toEqual(["launch-house"]);
    expect(s.squads).toEqual([]);
  });

  test("each line is the entity's card: what it produces, what it is, what it refuses", () => {
    const s = rankShortlist([biz("launch-house"), cap("launch-marketing", "gaming.launch.plan")], registries);
    expect(s.businesses[0].card).toBe("business:launch-house | produces: steam-store-page-kit | Launches finished games. | not: building the game");
    expect(s.squads[0].card).toContain("not: game design");
  });

  test("an entity the registry no longer has is left out, and each list stops at its size", () => {
    expect(rankShortlist([biz("ghost")], registries).businesses).toEqual([]);
    const many = { businesses: { businesses: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`b${i}`, {}])) }, squads: { squads: {}, capabilities: {} } };
    expect(rankShortlist(Array.from({ length: 20 }, (_, i) => biz(`b${i}`)), many).businesses).toHaveLength(SHORTLIST_SIZE);
  });

  test("the rendering names the target the request named, and the clones it names", () => {
    const text = renderShortlist("x", {
      named: { kind: "squad", slug: "launch-marketing" },
      businesses: [], squads: [],
      clones: { named: ["alex-hormozi"], ambiguous: [{ name: "sobral", candidates: ["pedro-sobral", "ruy-sobral"] }], missing: ["Simon Sinek"] },
    });
    expect(text).toContain("named in the request: squad launch-marketing — it is the target");
    expect(text).toContain("- alex-hormozi");
    expect(text).toContain('"sobral" is more than one clone: pedro-sobral, ruy-sobral (ask which)');
    expect(text).toContain('"Simon Sinek" is not in the library');
  });
});

describe("the command line", () => {
  test("the router flags the old `nrv find` forwarded are read, never searched for", () => {
    const a = parseFindArgs(["--no-amplify", "--prefer", "squad", "launch", "my", "game", "--no-stage-minus-1", "--json"]);
    expect(a.brief).toBe("launch my game");
    expect(a.json).toBe(true);
    expect(a.route).toEqual({ amplify: false, forceAmplify: false, prefer: "squad", disableStageMinus1: true });
  });
  test("no amplification unless asked", () => {
    expect(parseFindArgs(["a request"]).route.amplify).toBe(false);
    expect(parseFindArgs(["a request", "--amplify"]).route.amplify).toBe(true);
    expect(parseFindArgs(["--prefer-amplifier", "maestro", "a", "request"])).toMatchObject({ brief: "a request", route: { preferAmplifier: "maestro" } });
  });
});

describe("--jev", () => {
  test("off by default, read as a flag and never searched for", () => {
    expect(parseFindArgs(["a", "request"]).jev).toBe(false);
    const a = parseFindArgs(["a", "request", "--jev"]);
    expect(a.jev).toBe(true);
    expect(a.brief).toBe("a request");
  });

  test("the suggestion prints above the list with its confidence against the gate", () => {
    const base = { escalate: false, gate: 0.8, shape: "one_business", named: null, called: true, recall_ms: 1, call: { ok: true, latency_ms: 600, input_tokens: 1, cost_usd: 0, attempts: 1 } };
    const decision = { ok: true, kind: "decision", primary_business: "launch-house", mandatory_squads: [], optional_squads: [], suggested_mind_clones: ["vitalik-buterin"], parts: [], candidates: [], rationale: "", runtime: null, warnings: [], cost_usd: 0, duration_ms: 1 };
    const sure = renderJev({ ...base, confidence: 0.91, decision } as any);
    expect(sure).toContain("Jev (a classifier, not a decision) suggests: business launch-house");
    expect(sure).toContain("confidence 0.91: at or above 0.8");
    expect(sure).toContain("voice: vitalik-buterin");
    const parts = renderJev({ ...base, confidence: 0.6, decision: { ...decision, parts: [{ kind: "business", slug: "a", part: "x", after: [] }, { kind: "squad", slug: "b", part: "y", after: [] }] } } as any);
    expect(parts).toContain("business a + squad b (2 parts)");
    expect(parts).toContain("below 0.8, a guess");
  });
});
