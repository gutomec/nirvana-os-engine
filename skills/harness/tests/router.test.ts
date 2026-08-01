// router.test.ts — suíte de regressão do roteador fast/BM25 (lib/router.js).
// Roda com: bun test skills/harness/tests
//
// Cobre as stages determinísticas (stage1IntentClassify, buildMatchDocs,
// stage2Match, stage3Decide) sobre um registry in-memory, mais os casos-sentinela
// dos achados E2/E6/E7. Os sentinelas que dependem dos fixes de calibração estão
// marcados `test.todo` — viram `test` quando o fix aterrissa (ver plano, Fase 2).
import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";

// Testes de router são determinísticos e zero-token: força o braço denso OFF,
// independentemente de o backend neural estar instalado/ativo na máquina. O
// fallback (BM25 puro) é o que estas asserções cobrem.
process.env.NIRVANA_EMBEDDER = "off";

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const router = require("../lib/router.js");

// ── Fixture: mini-registry moldado como loadAll() ─────────────────────────
// instagram tem examples largos + score_boost 1.5 (o "ímã" do E6); os
// especialistas (crypto, sherlock, brandcraft) têm examples estreitos mas
// keywords/example_briefs ricos — hoje ignorados pelo indexador BM25.
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

  // Sentinelas E2 — substantivo de contexto do cliente NÃO deve virar RUN_ORG.
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

// ── Stage 2/3 — matching + decisão ─────────────────────────────────────────
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

  // Sentinela E6 — o ímã (instagram, boost 1.5) hoje rouba brief de OSINT.
  // Pós-fix (indexar keywords + domar boost) o especialista deve vencer.
  test("E6: brief de OSINT vai para o sherlock, não para o ímã instagram", () => {
    expect(topSquad("faça um background check do meu fornecedor")).toBe("sherlock-holmes-nirvana");
  });
  test("E6: brief de branding vai para o brandcraft", () => {
    expect(topSquad("preciso da identidade visual e do logo da marca")).toBe("brandcraft");
  });
});

// ── buildMatchDocs — corpus de indexação ──────────────────────────────────
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

  // Sentinela E6 — keywords/example_briefs estão carregados no registry mas
  // hoje não entram no texto indexado.
  test("E6: keywords entram no corpus indexado", () => {
    expect(docFor("nirvana-crypto-trading").text.toLowerCase()).toContain("bitcoin");
  });
  test("E6: example_briefs entram no corpus indexado", () => {
    expect(docFor("sherlock-holmes-nirvana").text.toLowerCase()).toContain("cnpj");
  });
});

// ── route() end-to-end (mode fast, determinístico, sem LLM/disco) ─────────
describe("route() — pipeline fast", () => {
  const ctx = { registries: REG, amplify: false, disableStageMinus1: true };

  test("brief forte roteia sem amplificação", async () => {
    const r = await router.route("analise o engajamento do meu instagram", ctx);
    expect(r.stage_minus_2.amplifier_used).toBe("skipped");
    expect(r.stage3.signal).not.toBe(undefined);
  });

  // Sentinela E7 — alternatives devem sair ordenadas por score, e o target não
  // pode ser um item de score menor promovido só por tipo (business-first cego).
  test("E7: alternatives ordenadas por score decrescente", async () => {
    const r = await router.route("análise técnica do bitcoin para swing trade", ctx);
    const alts = r.stage3.alternatives || [];
    for (let i = 1; i < alts.length; i++) {
      expect((alts[i - 1].score ?? 0)).toBeGreaterThanOrEqual(alts[i].score ?? 0);
    }
  });
});

// ── Fase 3 — stage2MatchHybrid: fallback gracioso sem o braço neural ──────
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
