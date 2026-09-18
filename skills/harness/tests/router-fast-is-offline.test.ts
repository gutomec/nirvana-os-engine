// router-fast-is-offline.test.ts — the `fast` mode spends nothing and answers
// the same way twice.
//
// The amplifier is an LLM call at both of its trigger points (Stage -1.5 on a
// WEAK brief, and the Stage 2.7 coverage bridge), and it has no deterministic
// arm: `builtin` and `maestro` name the persona, not an offline path. It used to
// run in every mode, which made the cheap reproducible path neither. Measured
// 2026-09-18 on the live corpus: ten real briefs routed twice inside one
// process, same registries, returned different signals; with the amplifier off
// the two passes were identical.
//
// These tests use the `context.amplifier` seam the router already exposes for
// stubbing the LLM arm, over a fixture corpus, so nothing here touches disk,
// the network, or a runtime.
import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const router = require_("../lib/router.js");

const REG = {
  squads: {
    domains: { publishing: {} },
    capabilities: {
      "book.ebook.write": [{
        squad: "ebook-squad",
        description: "Escreve ebooks e livros digitais completos",
        examples: ["escreva um ebook sobre produtividade"],
        domains: ["publishing"],
        keywords: ["ebook", "livro", "escrita"],
        example_briefs: ["Escreva um ebook completo sobre produtividade"],
      }],
    },
    squads: { "ebook-squad": { description: "Squad de livros digitais", domains: ["publishing"], capabilities: ["book.ebook.write"] } },
  },
  businesses: { businesses: {}, _business_routing: {} },
};

/** A brief classifyBriefStrength calls WEAK, which is the amplifier's trigger. */
const WEAK_BRIEF = "faz aí";

function spyAmplifier() {
  const calls: string[] = [];
  return {
    calls,
    fn: async (brief: string) => { calls.push(brief); return { ok: true, amplified: "Escreva um ebook completo sobre produtividade com capítulos e sumário", via: "builtin" }; },
  };
}

describe("the amplifier's trigger is real", () => {
  test("the fixture brief is WEAK, so a mode that allows the LLM arm reaches it", async () => {
    expect(router.classifyBriefStrength(WEAK_BRIEF).strength).toBe("WEAK");
    const spy = spyAmplifier();
    await router.route(WEAK_BRIEF, { registries: REG, mode: "agentic", amplifier: spy.fn });
    expect(spy.calls).toEqual([WEAK_BRIEF]);
  });
});

describe("fast mode never calls the LLM arm", () => {
  test("a WEAK brief in fast mode does not reach the amplifier", async () => {
    const spy = spyAmplifier();
    const r = await router.route(WEAK_BRIEF, { registries: REG, mode: "fast", amplifier: spy.fn });
    expect(spy.calls).toEqual([]);
    expect(r.stage_minus_2?.amplifier_used).toBe("skipped");
  });

  test("the result says WHY it was skipped, naming the mode", async () => {
    const r = await router.route(WEAK_BRIEF, { registries: REG, mode: "fast", amplifier: spyAmplifier().fn });
    expect(r.stage_minus_2?.reason).toBe("amplify_disabled_by_mode_fast");
  });

  test("routing the same brief twice in fast mode gives the same signal", async () => {
    const once = await router.route(WEAK_BRIEF, { registries: REG, mode: "fast", amplifier: spyAmplifier().fn });
    const twice = await router.route(WEAK_BRIEF, { registries: REG, mode: "fast", amplifier: spyAmplifier().fn });
    expect(twice.stage3.signal).toBe(once.stage3.signal);
  });
});

describe("the mode is the default, never an override", () => {
  test("an explicit amplify:true wins over fast", async () => {
    const spy = spyAmplifier();
    await router.route(WEAK_BRIEF, { registries: REG, mode: "fast", amplify: true, amplifier: spy.fn });
    expect(spy.calls).toEqual([WEAK_BRIEF]);
  });

  test("an explicit amplify:false wins over agentic, and keeps its own reason", async () => {
    const spy = spyAmplifier();
    const r = await router.route(WEAK_BRIEF, { registries: REG, mode: "agentic", amplify: false, amplifier: spy.fn });
    expect(spy.calls).toEqual([]);
    expect(r.stage_minus_2?.reason).toBe("amplify_disabled");
  });

  test("an unknown mode is treated as permissive, like the agentic default", async () => {
    const spy = spyAmplifier();
    await router.route(WEAK_BRIEF, { registries: REG, mode: "something-else", amplifier: spy.fn });
    expect(spy.calls).toEqual([WEAK_BRIEF]);
  });
});

describe("retrieval depth", () => {
  test("stage 2 retrieves 30 slots, the measured peak for a 15-destination window", () => {
    expect(router.STAGE2_TOPK).toBe(30);
    expect(router.STAGE2_TOPK).toBeGreaterThan(router.EXPOSED_ALTERNATIVES_MAX);
  });

  test("the depth is a default a caller can still override", () => {
    const intent = router.stage1IntentClassify("ebook", { registries: REG });
    expect(router.stage2Match(intent, REG, { brief: "ebook", topK: 1 }).length).toBeLessThanOrEqual(1);
  });
});
