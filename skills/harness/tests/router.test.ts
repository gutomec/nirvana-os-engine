// router.test.ts — regression suite for the fast/BM25 router (lib/router.js).
// Run with: bun test skills/harness/tests
//
// Covers the deterministic stages (stage1IntentClassify, buildMatchDocs,
// stage2Match, stage3Decide) over an in-memory registry, plus the sentinel cases
// of findings E2/E6/E7. Sentinels depending on the calibration fixes are marked
// `test.todo` — they become `test` when the fix lands (see plan, Phase 2).
import { describe, expect, test, afterAll } from "bun:test";
import { createRequire } from "node:module";

// Router tests are deterministic and zero-token: force the dense arm OFF,
// regardless of whether the neural backend is installed/active on the machine.
// The fallback (pure BM25) is what these assertions cover.
// Process-wide and never restored would leak into every file that runs after
// this one in the same bun process (they would all get the null embedder).
const EMBEDDER_BEFORE = process.env.NIRVANA_EMBEDDER;
process.env.NIRVANA_EMBEDDER = "off";
afterAll(() => {
  if (EMBEDDER_BEFORE === undefined) delete process.env.NIRVANA_EMBEDDER;
  else process.env.NIRVANA_EMBEDDER = EMBEDDER_BEFORE;
});

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const router = require("../lib/router.js");

// ── Fixture: mini-registry shaped like loadAll() ──────────────────────────
// instagram has broad examples + score_boost 1.5 (the E6 "magnet"); the
// specialists (crypto, sherlock, brandcraft) have narrow examples but rich
// keywords/example_briefs — today ignored by the BM25 indexer.
const REG = {
  squads: {
    domains: {
      social_media: {}, marketing: {}, crypto: {}, fintech: {},
      osint: {}, branding: {}, design: {},
    },
    capabilities: {
      "media.instagram_content.analyze": [{
        squad: "instagram-intelligence-nirvana",
        description: "Análise profunda de conteúdo, perfis, concorrentes e tendências no Instagram e redes sociais",
        examples: [
          "analise o perfil do instagram do meu concorrente",
          "quais tendências de conteúdo estão bombando",
          "faça um relatório de engajamento das redes sociais",
          "análise competitiva de social media e marketing digital",
          "auditoria de conteúdo e estratégia de posts",
        ],
        domains: ["social_media", "marketing"],
        score_boost: 1.5,
        keywords: ["instagram", "redes sociais", "engajamento", "concorrente", "conteúdo"],
        example_briefs: ["Analise os últimos 30 posts do meu perfil e diga o que melhorar"],
      }],
      "trading.crypto_ta.execute": [{
        squad: "nirvana-crypto-trading",
        description: "Análise técnica de criptomoedas para swing trade",
        examples: ["análise técnica de bitcoin"],
        domains: ["crypto", "fintech"],
        score_boost: 1.0,
        keywords: ["bitcoin", "swing trade", "análise técnica", "cripto", "ethereum", "candlestick"],
        example_briefs: ["Faça a análise técnica do BTC para swing trade nas próximas semanas"],
      }],
      "osint.supplier_investigation.execute": [{
        squad: "sherlock-holmes-nirvana",
        description: "Investigação OSINT e due diligence de fornecedores e pessoas",
        examples: ["investigue este fornecedor"],
        domains: ["osint"],
        score_boost: 1.0,
        keywords: ["osint", "investigação", "due diligence", "background check", "fornecedor"],
        example_briefs: ["Faça uma investigação OSINT completa deste CNPJ de fornecedor"],
      }],
      "brand.visual_identity.execute": [{
        squad: "brandcraft",
        description: "Criação de identidade visual, logo e sistema de marca",
        examples: ["crie a identidade visual da marca"],
        domains: ["branding", "design"],
        score_boost: 1.0,
        keywords: ["identidade visual", "logo", "marca", "branding", "design de marca"],
        example_briefs: ["Desenvolva a identidade visual completa da minha startup"],
      }],
    },
  },
  businesses: { businesses: {}, _business_routing: {} },
};

const KNOWN_DOMAINS = Object.keys(REG.squads.domains);

function fastMatch(brief: string) {
  const intent = router.stage1IntentClassify(brief, { knownDomains: KNOWN_DOMAINS });
  const matches = router.stage2Match(intent, REG, { brief, topK: 10 });
  const decision = router.stage3Decide(matches, {});
  return { intent, matches, decision };
}
const topSquad = (brief: string) => fastMatch(brief).matches[0]?.meta?.squad ?? null;

// ── Stage 1 — intent classification ───────────────────────────────────────
describe("stage1IntentClassify — WORK vs RUN_ORG", () => {
  test("verbo de trabalho puro → WORK", () => {
    expect(router.stage1IntentClassify("crie um relatório de vendas", {}).intent).toBe("WORK");
  });
  test("verbo de gestão + recorrência → RUN_ORG (caso legítimo, não pode regredir)", () => {
    expect(router.stage1IntentClassify("gerencie minha empresa mensalmente", {}).intent).toBe("RUN_ORG");
  });
  test("orquestrar continuamente → RUN_ORG", () => {
    expect(router.stage1IntentClassify("orquestrar a operação de forma recorrente", {}).intent).toBe("RUN_ORG");
  });

  // E2 sentinels — a client-context noun must NOT turn into RUN_ORG.
  test("E2: 'empresa ... do meu cliente' sem verbo de gestão → WORK", () => {
    expect(
      router.stage1IntentClassify("faça uma landing page para a empresa de turismo do meu cliente", {}).intent,
    ).toBe("WORK");
  });
  test("E2: 'cliente' sozinho não dispara RUN_ORG (gatilho silencioso)", () => {
    expect(
      router.stage1IntentClassify("monte o funil de vendas do infoproduto do meu cliente", {}).intent,
    ).toBe("WORK");
  });
});

// ── Stage 2/3 — matching + decision ────────────────────────────────────────
describe("stage2Match + stage3Decide — BM25", () => {
  test("especialista vence no próprio domínio (instagram ↔ engajamento)", () => {
    expect(topSquad("analise o engajamento do meu instagram")).toBe("instagram-intelligence-nirvana");
  });
  test("matches vêm ordenados por score_adjusted (não crescente)", () => {
    const { matches } = fastMatch("análise técnica do bitcoin para swing trade");
    for (let i = 1; i < matches.length; i++) {
      expect(matches[i - 1].score_adjusted).toBeGreaterThanOrEqual(matches[i].score_adjusted);
    }
  });
  test("stage3 NO_MATCH quando não há candidatos", () => {
    expect(router.stage3Decide([], {}).signal).toBe("NO_MATCH");
  });
  test("stage3 HIGH exige top>=0.8 e lead>=0.15", () => {
    const d = router.stage3Decide(
      [{ normalized: 1.0, meta: { squad: "a" } }, { normalized: 0.5, meta: { squad: "b" } }], {},
    );
    expect(d.signal).toBe("HIGH");
  });

  // E6 sentinel — the magnet (instagram, boost 1.5) today steals OSINT briefs.
  // Post-fix (index keywords + tame the boost) the specialist must win.
  test("E6: brief de OSINT vai para o sherlock, não para o ímã instagram", () => {
    expect(topSquad("faça um background check do meu fornecedor")).toBe("sherlock-holmes-nirvana");
  });
  test("E6: brief de branding vai para o brandcraft", () => {
    expect(topSquad("preciso da identidade visual e do logo da marca")).toBe("brandcraft");
  });
});

// ── buildMatchDocs — indexing corpus ──────────────────────────────────────
describe("buildMatchDocs — o que entra no índice", () => {
  const docFor = (squad: string) => {
    const docs = router.buildMatchDocs(REG.squads, REG.businesses);
    return docs.find((d: any) => d.meta?.squad === squad);
  };

  test("indexa capId, description, examples e domains", () => {
    const doc = docFor("nirvana-crypto-trading");
    expect(doc.text).toContain("criptomoedas"); // description
    expect(doc.text).toContain("crypto");        // domain
  });

  // E6 sentinel — keywords/example_briefs are loaded in the registry but
  // today they do not enter the indexed text.
  test("E6: keywords entram no corpus indexado", () => {
    expect(docFor("nirvana-crypto-trading").text.toLowerCase()).toContain("bitcoin");
  });
  test("E6: example_briefs entram no corpus indexado", () => {
    expect(docFor("sherlock-holmes-nirvana").text.toLowerCase()).toContain("cnpj");
  });
});

// ── route() end-to-end (fast mode, deterministic, no LLM/disk) ────────────
describe("route() — pipeline fast", () => {
  const ctx = { registries: REG, amplify: false, disableStageMinus1: true };

  test("brief forte roteia sem amplificação", async () => {
    const r = await router.route("analise o engajamento do meu instagram", ctx);
    expect(r.stage_minus_2.amplifier_used).toBe("skipped");
    expect(r.stage3.signal).not.toBe(undefined);
  });

  // E7 sentinel — alternatives must come out sorted by score, and the target
  // cannot be a lower-score item promoted by type alone (blind business-first).
  test("E7: alternatives ordenadas por score decrescente", async () => {
    const r = await router.route("análise técnica do bitcoin para swing trade", ctx);
    const alts = r.stage3.alternatives || [];
    for (let i = 1; i < alts.length; i++) {
      expect((alts[i - 1].score ?? 0)).toBeGreaterThanOrEqual(alts[i].score ?? 0);
    }
  });
});

// ── Per-squad doc (routing-360 Phase 2) ───────────────────────────────────
// The registry emits a squad-level description (Phase 2.1) that no doc
// consumed. buildMatchDocs now emits one `squad` doc per squads-record entry:
// name + description + domains + capability ids + keywords — deliberately
// WITHOUT example_briefs/produces (those already power the capability docs;
// duplicating them inflates squad docs and dilutes business matches).
describe("buildMatchDocs — per-squad doc", () => {
  const SQUADS_REG = {
    domains: {},
    squads: {
      "nirvana-societario-sucessao": {
        version: "5.1.0",
        protocol: "5.0",
        manifest_path: "/x/squad.yaml",
        description: "Squad societário e de sucessão para escritório contábil",
        domains: ["legal"],
        capabilities: ["legal.holding_setup.execute"],
        keywords: ["holding-patrimonial", "itcmd"],
        produces: ["holding-structure-design"],
        example_briefs: ["Estruture uma holding familiar para a família Silva"],
      },
    },
    capabilities: {
      "legal.holding_setup.execute": [{
        squad: "nirvana-societario-sucessao",
        description: "Desenho de holding patrimonial e familiar",
        domains: ["legal"],
      }],
    },
  };
  const EMPTY_BIZ = { businesses: {}, _business_routing: {} };
  const squadDoc = () => router
    .buildMatchDocs(SQUADS_REG, EMPTY_BIZ)
    .find((d: any) => d.meta?.type === "squad");

  test("emits one `squad` doc with name + description + domains + cap ids + keywords", () => {
    const doc = squadDoc();
    expect(doc).toBeDefined();
    expect(doc.id).toBe("squad:nirvana-societario-sucessao");
    expect(doc.text).toContain("nirvana societario sucessao"); // de-hyphenated name
    expect(doc.text).toContain("escritório contábil");          // squad-level description
    expect(doc.text).toContain("legal");                        // domain
    expect(doc.text).toContain("holding setup execute");        // de-dotted capability id
    expect(doc.text).toContain("holding-patrimonial");          // squad-level keyword
  });

  test("excludes example_briefs and produces from the squad doc", () => {
    const doc = squadDoc();
    expect(doc.text).not.toContain("família Silva");            // example_briefs excluded
    expect(doc.text).not.toContain("holding-structure-design"); // produces excluded
  });

  test("meta carries enough for dispatch: type squad, squad slug, no invoke", () => {
    const doc = squadDoc();
    expect(doc.meta.type).toBe("squad");
    expect(doc.meta.squad).toBe("nirvana-societario-sucessao");
    expect(doc.meta.manifest_path).toBe("/x/squad.yaml");
    expect(doc.meta.invoke).toBeUndefined();
  });

  test("stage5Invoke on a squad doc: target_id is the squad slug, loader is squad-level", () => {
    const doc = squadDoc();
    const plan = router.stage5Invoke({ id: doc.id, meta: doc.meta }, "monte a holding", {});
    expect(plan.target_type).toBe("squad");
    expect(plan.target_id).toBe("nirvana-societario-sucessao");
    expect(plan.squad).toBe("nirvana-societario-sucessao");
    expect(plan.capability_id).toBeNull();
    expect(plan.loader).toContain("squads skill");
    expect(plan.loader).toContain("nirvana-societario-sucessao");
  });

  test("registry without a squads record emits no squad docs (legacy shape)", () => {
    const docs = router.buildMatchDocs({ capabilities: {}, domains: {} }, EMPTY_BIZ);
    expect(docs.filter((d: any) => d.meta?.type === "squad").length).toBe(0);
  });
});

// ── not_for de-inerting (routing-360 Phase 2) ─────────────────────────────
// The old rule was whole-string substring — inert: 98.9% of the 974 live
// not_for entries are >40 chars (median 77) and no real brief contains them
// verbatim. Long entries now fire on token overlap (≥60% of the entry's
// content tokens present in the brief, ≥2 content tokens); short entries
// (≤25 chars) keep the substring fast-path.
describe("applyAdjustments — not_for token overlap", () => {
  // shortform-squad is a deliberate keyword magnet: pre-penalty it outranks the
  // institutional specialist even on institutional briefs — only a not_for that
  // actually FIRES flips the winner. That is what each test asserts.
  const NF_REG = {
    squads: {
      domains: {},
      capabilities: {
        "video.shortform.execute": [{
          squad: "shortform-squad",
          description: "Edição de vídeo curto para redes sociais",
          domains: ["video"],
          keywords: ["vídeo", "edição", "institucional", "tv", "corporativa", "longo"],
          not_for: ["edição de vídeo institucional longo para tv corporativa"],
        }],
        "video.institutional.execute": [{
          squad: "corporate-video-squad",
          description: "Produção de vídeo institucional longo para tv corporativa",
          domains: ["video"],
        }],
      },
    },
    businesses: { businesses: {}, _business_routing: {} },
  };
  const intent = { intent: "WORK", domains: [], verbs: [] };
  const top = (brief: string) =>
    router.stage2Match(intent, NF_REG, { brief, topK: 5 })[0]?.meta?.squad ?? null;

  test("long not_for fires on a brief carrying its key tokens (no verbatim substring)", () => {
    // Word order and filler differ from the not_for entry, so the old substring
    // path can NOT fire — only token overlap penalizes the shortform squad.
    expect(top("preciso da edição de um vídeo longo institucional para a tv corporativa da empresa"))
      .toBe("corporate-video-squad");
  });

  test("unrelated brief with partial overlap (<60%) does not fire", () => {
    // "edição" + "vídeo" are 2 of the entry's 6 content tokens (~33%) — the
    // shortform specialist keeps its own domain.
    expect(top("edição de vídeo curto com cortes rápidos para redes sociais"))
      .toBe("shortform-squad");
  });

  test("short token-list entry (≤25 chars) still fires via the substring fast-path", () => {
    const reg = JSON.parse(JSON.stringify(NF_REG));
    reg.squads.capabilities["video.shortform.execute"][0].not_for = ["vídeo institucional"];
    const t = router.stage2Match(intent, reg, {
      brief: "crie um vídeo institucional para a tv corporativa", topK: 5,
    })[0]?.meta?.squad;
    expect(t).toBe("corporate-video-squad");
  });
});

// ── Phase 3 — stage2MatchHybrid: graceful fallback without the neural arm ─
describe("stage2MatchHybrid — fallback sem neural", () => {
  const intent = { intent: "WORK", domains: [], verbs: [] };

  test("sem NIRVANA_EMBEDDER, o híbrido casa o BM25 puro (produto base zero-dep)", async () => {
    const hybrid = await router.stage2MatchHybrid(intent, REG, { brief: "engajamento do instagram", topK: 5 });
    const pure = router.stage2Match(intent, REG, { brief: "engajamento do instagram", topK: 5 });
    expect(hybrid.map((m: any) => m.meta.squad)).toEqual(pure.map((m: any) => m.meta.squad));
  });

  test("mesmo topo que o BM25 quando o denso está inativo", async () => {
    const hybrid = await router.stage2MatchHybrid(intent, REG, { brief: "background check do fornecedor", topK: 5 });
    expect(hybrid[0].meta.squad).toBe("sherlock-holmes-nirvana");
  });
});
