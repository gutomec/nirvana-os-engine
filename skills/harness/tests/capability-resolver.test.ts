// capability-resolver.test.ts — which capability of a squad a dispatch actually runs.
//
// Before this resolver every squad dispatch stamped the literal `squad.execute`
// on the Run, on every artifact ref and on the Glance target: false provenance
// for a library where 204 squads declare 657 capabilities. The resolver picks
// one by a fixed ladder — explicit → the squad's only capability → BM25 inside
// the squad → `squad.execute` for a v4 squad that declares none — and says which
// rung answered. Zero-token: the registry is a literal, BM25 is deterministic.
// Runs with: bun test skills/harness/tests
import { describe, expect, test } from "bun:test";
import {
  LEGACY_CAPABILITY_ID, parseSquadTarget, resolveSquadCapability,
  type SquadsCapabilityRegistry,
} from "../lib/capability-resolver.ts";

/** A registry shaped like the one `nrv index` writes: per-squad capability ids
 *  and, per capability id, the provider entries BM25 indexes. */
function registry(): SquadsCapabilityRegistry {
  return {
    squads: {
      brandcraft: { capabilities: ["branding.pdf_document.create", "branding.pptx_deck.create", "branding.brand.audit"] },
      "solo-shop": { capabilities: ["commerce.storefront.build"] },
      "v4-legacy": {},
    },
    capabilities: {
      "branding.pdf_document.create": [{
        squad: "brandcraft", description: "Produce a branded PDF document from a manifesto.",
        keywords: ["pdf", "documento"], examples: ["brand book in PDF"], produces: ["pdf"], domains: ["branding"],
      }],
      "branding.pptx_deck.create": [{
        squad: "brandcraft", description: "Produce a branded PowerPoint deck for a pitch.",
        keywords: ["pptx", "deck", "apresentacao"], examples: ["investor deck"], produces: ["pptx"], domains: ["branding"],
      }],
      "branding.brand.audit": [{
        squad: "brandcraft", description: "Audit an existing brand against its own guidelines.",
        keywords: ["auditoria"], examples: ["audit the brand"], produces: ["report"], domains: ["branding"],
      }],
      "commerce.storefront.build": [{
        squad: "solo-shop", description: "Build a storefront for a single-owner shop.",
        keywords: ["loja"], examples: ["open a store"], produces: ["site"], domains: ["commerce"],
      }],
    },
  };
}

function sink() {
  const events: Array<{ event: string; payload: Record<string, unknown> }> = [];
  return { events, audit: (event: string, payload: Record<string, unknown>) => { events.push({ event, payload }); } };
}

describe("parseSquadTarget — the `<slug>[:<capabilityId>]` grammar", () => {
  test("mirrors evaluator-selection's squad spec: slug alone, slug plus capability", () => {
    expect(parseSquadTarget("brandcraft")).toEqual({ slug: "brandcraft", capabilityId: null });
    expect(parseSquadTarget("brandcraft:branding.pdf_document.create")).toEqual({ slug: "brandcraft", capabilityId: "branding.pdf_document.create" });
    expect(parseSquadTarget("  brandcraft:branding.brand.audit  ")).toEqual({ slug: "brandcraft", capabilityId: "branding.brand.audit" });
  });

  test("a slug is lowercased; a value with no slug is not a target", () => {
    expect(parseSquadTarget("Doc-Factory:Docs.Report.Create")).toEqual({ slug: "doc-factory", capabilityId: "docs.report.create" });
    expect(parseSquadTarget(":branding.pdf_document.create")).toBeNull();
    expect(parseSquadTarget("")).toBeNull();
    expect(parseSquadTarget("brandcraft:")).toBeNull();
  });
});

describe("resolveSquadCapability — the ladder", () => {
  test("explicit: the user's capability wins over every other rung", () => {
    const { events, audit } = sink();
    const r = resolveSquadCapability({ slug: "brandcraft", brief: "faça uma auditoria de marca", explicit: "branding.pptx_deck.create", registry: registry(), audit });
    expect(r.capabilityId).toBe("branding.pptx_deck.create");
    expect(r.source).toBe("explicit");
    expect(r.warning).toBeUndefined();
    expect(events[0].event).toBe("x_capability_resolved");
    expect(events[0].payload).toMatchObject({ squad_slug: "brandcraft", capability_id: "branding.pptx_deck.create", source: "explicit", declared_count: 3 });
  });

  test("explicit: an id the squad does not declare is honoured and named", () => {
    const r = resolveSquadCapability({ slug: "brandcraft", explicit: "branding.nothing.here", registry: registry() });
    expect(r.capabilityId).toBe("branding.nothing.here");
    expect(r.source).toBe("explicit");
    expect(r.warning).toContain("branding.nothing.here");
  });

  test("single: a squad with one capability needs no brief and no scoring", () => {
    const { events, audit } = sink();
    const r = resolveSquadCapability({ slug: "solo-shop", brief: "", registry: registry(), audit });
    expect(r).toMatchObject({ capabilityId: "commerce.storefront.build", source: "single" });
    expect(r.score).toBeUndefined();
    expect(events[0].payload).toMatchObject({ source: "single", declared_count: 1 });
  });

  test("bm25: the brief picks among the squad's own capabilities, and only its own", () => {
    const { events, audit } = sink();
    const deck = resolveSquadCapability({ slug: "brandcraft", brief: "monte o deck pptx da apresentação para investidores", registry: registry(), audit });
    expect(deck).toMatchObject({ capabilityId: "branding.pptx_deck.create", source: "bm25" });
    expect(deck.score).toBeGreaterThan(0);
    expect(events[0].payload).toMatchObject({ source: "bm25", capability_id: "branding.pptx_deck.create" });

    const audited = resolveSquadCapability({ slug: "brandcraft", brief: "quero uma auditoria da marca", registry: registry() });
    expect(audited.capabilityId).toBe("branding.brand.audit");

    // A brief that would win another squad's capability never leaves this squad.
    const foreign = resolveSquadCapability({ slug: "brandcraft", brief: "abrir uma loja online", registry: registry() });
    expect(registry().squads!.brandcraft.capabilities).toContain(foreign.capabilityId);
  });

  test("bm25: a brief with no overlap still resolves — the first declared id, score 0", () => {
    const r = resolveSquadCapability({ slug: "brandcraft", brief: "zzzz qqqq", registry: registry() });
    expect(r).toMatchObject({ capabilityId: "branding.pdf_document.create", source: "bm25", score: 0 });
  });

  test("legacy: a v4 squad that declares no capabilities keeps squad.execute", () => {
    const { events, audit } = sink();
    const r = resolveSquadCapability({ slug: "v4-legacy", brief: "qualquer coisa", registry: registry(), audit });
    expect(r).toMatchObject({ capabilityId: LEGACY_CAPABILITY_ID, source: "legacy", declared: [] });
    expect(events[0].payload).toMatchObject({ source: "legacy", capability_id: "squad.execute", declared_count: 0 });
  });

  test("legacy: a squad absent from the registry is a v4 squad as far as the ladder can tell", () => {
    const r = resolveSquadCapability({ slug: "never-indexed", brief: "b", registry: registry() });
    expect(r).toMatchObject({ capabilityId: LEGACY_CAPABILITY_ID, source: "legacy" });
  });

  test("the audit event is optional: no sink, no throw", () => {
    expect(() => resolveSquadCapability({ slug: "solo-shop", registry: registry() })).not.toThrow();
  });

  test("an empty registry never throws and never invents a capability", () => {
    const r = resolveSquadCapability({ slug: "brandcraft", brief: "b", registry: {} });
    expect(r).toMatchObject({ capabilityId: LEGACY_CAPABILITY_ID, source: "legacy" });
  });
});
