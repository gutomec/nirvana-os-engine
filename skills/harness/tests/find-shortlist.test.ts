// find-shortlist.test.ts — what `nrv find` hands the orchestrator.
//
// Measured on 48 labeled requests (2026-10-13): one mixed list of five put the
// right business in front of the orchestrator for 78% of the parts; businesses
// and squads ranked apart, five each, for 95%. These tests lock the shape that
// produced the second number. The rates themselves need a library; CI has none.
import { describe, expect, test } from "bun:test";
import { parseFindArgs, rankShortlist, renderShortlist, SHORTLIST_SIZE } from "../scripts/find.ts";

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
