/**
 * Coverage-based NO_MATCH gate (Stage 3) — 2026-07-27 census, Part 2 of
 * ROUTER-INVESTIGACAO.md: a real brief matches ≥3 content tokens of the winner
 * (fraction ≥0,80); out-of-domain matches ≤2 (fraction ≤0,50). Empty band.
 * Cut by count AND fraction; a legitimate short brief is protected.
 */
import { describe, expect, test } from "bun:test";
const router = require("../lib/router.js");

const m = (over: any = {}) => ({
  id: over.id ?? "squad_capability:x:cap.a",
  normalized: over.normalized ?? 1.0,
  score: 10,
  score_adjusted: over.normalized ?? 1.0,
  coverage: over.coverage,
  meta: over.meta ?? { type: "squad_capability", squad: over.squad ?? "x" },
});

describe("stage3Decide — gate de cobertura", () => {
  test("fora de domínio: vencedor casa ≤1 de ≥3 tokens → NO_MATCH mesmo com normalized 1.0", () => {
    const d = router.stage3Decide(
      [m({ coverage: { matched: 1, total: 4 } }), m({ id: "b", normalized: 0.4, coverage: { matched: 1, total: 4 } })],
      { brief: "receita de bolo de fubá" },
    );
    expect(d.signal).toBe("NO_MATCH");
    expect(d.reason).toContain("coverage");
  });

  test("cobertura rasa: 2 de ≥4 tokens (fração ≤0,5) → rebaixa a AMBIGUOUS", () => {
    const d = router.stage3Decide(
      [m({ coverage: { matched: 2, total: 6 } }), m({ id: "b", normalized: 0.3, coverage: { matched: 1, total: 6 } })],
      { brief: "consertar a máquina de lavar que vaza água" },
    );
    expect(d.signal).toBe("AMBIGUOUS");
    expect(d.reason).toContain("coverage");
  });

  test("brief de 2 tokens com vencedor casando só 1 → AMBIGUOUS, nunca HIGH (routing-360 Phase 2)", () => {
    // "what is two plus two" -> {two, plus}; the winner matches only "plus".
    // Before, total=2 escaped the gate and a same-squad shadow doc collapsed
    // the cluster to HIGH — confident dispatch on an out-of-domain brief.
    const d = router.stage3Decide(
      [
        m({ coverage: { matched: 1, total: 2 } }),
        m({ id: "squad:x", normalized: 0.97, coverage: { matched: 1, total: 2 }, meta: { type: "squad", squad: "x" } }),
      ],
      { brief: "what is two plus two" },
    );
    expect(d.signal).toBe("AMBIGUOUS");
    expect(d.reason).toContain("coverage");
  });

  test("brief curto legítimo: 2 de 2 tokens (fração 1,0) NÃO é punido — segue HIGH", () => {
    const d = router.stage3Decide(
      [m({ coverage: { matched: 2, total: 2 } }), m({ id: "b", normalized: 0.3, coverage: { matched: 0, total: 2 } })],
      { brief: "escreva o ebook" },
    );
    expect(d.signal).toBe("HIGH");
  });

  test("brief real: ≥3 tokens casados passa direto pelo gate", () => {
    const d = router.stage3Decide(
      [m({ coverage: { matched: 5, total: 6 } }), m({ id: "b", normalized: 0.2, coverage: { matched: 1, total: 6 } })],
      { brief: "auditoria de funil de conversão do checkout da loja" },
    );
    expect(d.signal).toBe("HIGH");
  });

  test("sem campo coverage (caminhos legados/sintéticos): gate se abstém, decisão clássica vale", () => {
    const d = router.stage3Decide([m({}), m({ id: "b", normalized: 0.2 })], { brief: "qualquer" });
    expect(d.signal).toBe("HIGH");
  });
});

describe("stage2Match — resultados carregam cobertura", () => {
  test("cada resultado expõe coverage {matched, total} calculado do brief", () => {
    const registries = {
      squads: {
        schema_version: "1.0.0",
        squads: { alpha: { name: "alpha" } },
        capabilities: {
          "video.editing.execute": [
            {
              squad: "alpha",
              description: "edição de vídeo curto para redes sociais com cortes e legenda",
              domains: ["vídeo", "edição de vídeo"],
              example_briefs: ["editar vídeo curto com legendas para instagram"],
            },
          ],
        },
        domains: {},
        _v4_inferred_capabilities: {},
      },
      businesses: { schema_version: "1.0.0", businesses: {}, _business_routing: {} },
    };
    const intent = router.stage1IntentClassify("editar um vídeo curto com legenda", { knownDomains: [] });
    const res = router.stage2Match(intent, registries, { brief: "editar um vídeo curto com legenda", topK: 3 });
    expect(res.length).toBeGreaterThan(0);
    expect(res[0].coverage).toBeDefined();
    expect(typeof res[0].coverage.matched).toBe("number");
    expect(res[0].coverage.matched).toBeGreaterThanOrEqual(3);
  });
});
