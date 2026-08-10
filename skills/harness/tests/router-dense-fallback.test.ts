// router-dense-fallback.test.ts — Stage 3.5 dense NO_MATCH fallback (Phase 3.4).
//
// Pins the slot's contract over a fixture corpus with a stubbed dense arm
// (ctx.denseRank / ctx.denseMode test hooks — no neural backend, no disk):
//   - consulted ONLY when the final signal is NO_MATCH;
//   - a clearing candidate comes back as AMBIGUOUS, NEVER HIGH;
//   - DENSE_FALLBACK_MIN_COSINE respected (below → NO_MATCH stands);
//   - absent model (denseRank → null) → clean no-op;
//   - default mode is OFF: without opt-in the stub must never be consulted —
//     this is the Phase 3.4 DECISION (measured: correct-target cosines overlap
//     the out-of-domain negatives band; no safe threshold recovers the
//     majority of the multilingual regime).
// Runs with: bun test skills/harness/tests
import { afterEach, describe, expect, test } from "bun:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const router = require("../lib/router.js");

const THRESHOLD: number = router.DENSE_FALLBACK_MIN_COSINE;

// ── Fixture: mini-registry shaped like loadAll() ──────────────────────────
const REG = {
  squads: {
    domains: { publishing: {}, branding: {} },
    capabilities: {
      "book.ebook.write": [{
        squad: "ebook-squad",
        description: "Escreve ebooks e livros digitais completos",
        examples: ["escreva um ebook sobre produtividade"],
        domains: ["publishing"],
        keywords: ["ebook", "livro", "escrita"],
        example_briefs: ["Escreva um ebook completo sobre produtividade"],
      }],
      "brand.identity.create": [{
        squad: "brand-squad",
        description: "Cria identidade visual e sistema de marca",
        examples: ["crie a identidade visual da marca"],
        domains: ["branding"],
        keywords: ["logo", "marca", "identidade visual"],
        example_briefs: ["Desenvolva a identidade visual da minha startup"],
      }],
    },
    // Per-squad doc (id `squad:ebook-squad`) — exercises the same-destination
    // dedupe of the fallback suggestions.
    squads: {
      "ebook-squad": {
        description: "Squad de livros digitais",
        domains: ["publishing"],
        capabilities: ["book.ebook.write"],
      },
    },
  },
  businesses: { businesses: {}, _business_routing: {} },
};

// Out-of-corpus brief — deterministic NO_MATCH on this fixture (zero overlap).
const NO_MATCH_BRIEF = "schreibe ein digitales Buch über gesunde Ernährung";
// In-corpus brief — dispatches HIGH; the fallback must never be consulted.
const HIGH_BRIEF = "escreva um ebook sobre produtividade";

const baseCtx = { registries: REG, amplify: false };

function stub(scores: Array<{ id: string; score: number }>) {
  const calls: string[] = [];
  const denseRank = async (brief: string) => { calls.push(brief); return scores; };
  return { denseRank, calls };
}

const savedEnv = process.env.NIRVANA_ROUTER_DENSE;
afterEach(() => {
  if (savedEnv === undefined) delete process.env.NIRVANA_ROUTER_DENSE;
  else process.env.NIRVANA_ROUTER_DENSE = savedEnv;
});

describe("Stage 3.5 — dense NO_MATCH fallback", () => {
  test("fixture sanity: the probe brief is NO_MATCH with the slot off", async () => {
    const r = await router.route(NO_MATCH_BRIEF, { ...baseCtx, denseMode: "off" });
    expect(r.stage3.signal).toBe("NO_MATCH");
  });

  test("NO_MATCH + clearing candidate → AMBIGUOUS suggestion with dense metadata", async () => {
    const s = stub([
      { id: "squad_capability:ebook-squad:book.ebook.write", score: THRESHOLD + 0.1 },
      { id: "squad_capability:brand-squad:brand.identity.create", score: 0.1 },
    ]);
    const r = await router.route(NO_MATCH_BRIEF, { ...baseCtx, denseMode: "fallback", denseRank: s.denseRank });
    expect(s.calls.length).toBe(1);
    expect(r.stage3.signal).toBe("AMBIGUOUS");
    expect(r.stage3.via_dense_fallback).toBe(true);
    expect(r.stage3.route_tier).toBe("dense_fallback");
    const alt = r.stage3.alternatives[0];
    expect(alt.meta.squad).toBe("ebook-squad");
    expect(alt.via_dense_fallback).toBe(true);
    expect(alt.dense_cosine).toBeCloseTo(THRESHOLD + 0.1, 5);
    // Only the clearing candidate survives — the 0.1 one is below threshold.
    expect(r.stage3.alternatives.length).toBe(1);
  });

  test("NEVER HIGH — even a near-perfect cosine stays a suggestion", async () => {
    const s = stub([{ id: "squad_capability:ebook-squad:book.ebook.write", score: 0.99 }]);
    const r = await router.route(NO_MATCH_BRIEF, { ...baseCtx, denseMode: "fallback", denseRank: s.denseRank });
    expect(r.stage3.signal).toBe("AMBIGUOUS");
    expect(r.stage3.signal).not.toBe("HIGH");
    expect(r.stage5).toBeNull(); // no invocation plan for a suggestion
  });

  test("threshold respected: top just below the line → NO_MATCH stands", async () => {
    const s = stub([{ id: "squad_capability:ebook-squad:book.ebook.write", score: THRESHOLD - 0.01 }]);
    const r = await router.route(NO_MATCH_BRIEF, { ...baseCtx, denseMode: "fallback", denseRank: s.denseRank });
    expect(s.calls.length).toBe(1);
    expect(r.stage3.signal).toBe("NO_MATCH");
    expect(r.stage3.via_dense_fallback).toBeUndefined();
  });

  test("absent model (denseRank → null) → clean no-op, NO_MATCH stands", async () => {
    const denseRank = async () => null;
    const r = await router.route(NO_MATCH_BRIEF, { ...baseCtx, denseMode: "fallback", denseRank });
    expect(r.stage3.signal).toBe("NO_MATCH");
    expect(r.stage3.via_dense_fallback).toBeUndefined();
  });

  test("a throwing dense arm never breaks routing", async () => {
    const denseRank = async () => { throw new Error("model exploded"); };
    const r = await router.route(NO_MATCH_BRIEF, { ...baseCtx, denseMode: "fallback", denseRank });
    expect(r.stage3.signal).toBe("NO_MATCH");
  });

  test("not consulted when the signal is not NO_MATCH", async () => {
    const s = stub([{ id: "squad_capability:brand-squad:brand.identity.create", score: 0.99 }]);
    const r = await router.route(HIGH_BRIEF, { ...baseCtx, denseMode: "fallback", denseRank: s.denseRank });
    expect(r.stage3.signal).toBe("HIGH");
    expect(s.calls.length).toBe(0);
  });

  test("DECISION PIN — default mode is off: stub never consulted without opt-in", async () => {
    delete process.env.NIRVANA_ROUTER_DENSE; // no env override; config default is "off"
    const s = stub([{ id: "squad_capability:ebook-squad:book.ebook.write", score: 0.99 }]);
    const r = await router.route(NO_MATCH_BRIEF, { ...baseCtx, denseRank: s.denseRank });
    expect(r.stage3.signal).toBe("NO_MATCH");
    expect(s.calls.length).toBe(0);
  });

  test("env override: NIRVANA_ROUTER_DENSE=0 forces off even with denseMode absent", async () => {
    process.env.NIRVANA_ROUTER_DENSE = "0";
    const s = stub([{ id: "squad_capability:ebook-squad:book.ebook.write", score: 0.99 }]);
    const r = await router.route(NO_MATCH_BRIEF, { ...baseCtx, denseRank: s.denseRank });
    expect(r.stage3.signal).toBe("NO_MATCH");
    expect(s.calls.length).toBe(0);
  });

  test("env override: NIRVANA_ROUTER_DENSE=1 enables the fallback slot", async () => {
    process.env.NIRVANA_ROUTER_DENSE = "1";
    const s = stub([{ id: "squad_capability:ebook-squad:book.ebook.write", score: THRESHOLD + 0.05 }]);
    const r = await router.route(NO_MATCH_BRIEF, { ...baseCtx, denseRank: s.denseRank });
    expect(r.stage3.signal).toBe("AMBIGUOUS");
    expect(r.stage3.via_dense_fallback).toBe(true);
  });

  test("suggestions dedupe by destination and cap at 3", async () => {
    const s = stub([
      { id: "squad_capability:ebook-squad:book.ebook.write", score: THRESHOLD + 0.2 },
      { id: "squad:ebook-squad", score: THRESHOLD + 0.15 }, // same destination → deduped
      { id: "squad_capability:brand-squad:brand.identity.create", score: THRESHOLD + 0.1 },
    ]);
    const r = await router.route(NO_MATCH_BRIEF, { ...baseCtx, denseMode: "fallback", denseRank: s.denseRank });
    expect(r.stage3.signal).toBe("AMBIGUOUS");
    const squads = r.stage3.alternatives.map((a: any) => a.meta.squad);
    expect(squads).toEqual(["ebook-squad", "brand-squad"]);
  });
});
