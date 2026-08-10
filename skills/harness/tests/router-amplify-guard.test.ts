/**
 * Post-amplify guard (routing-360 Phase 4) — "amplification is a lens, not a
 * replacement".
 *
 * Defect reproduced here: with amplification ON, the Stage 2.7 coverage-probe
 * bridge (arm c) hands a borderline brief to the LLM amplifier and re-runs the
 * match on the REWRITE. When the rewrite drifts, the re-run winner can match
 * ZERO tokens of the user's ORIGINAL brief — producing NO_MATCH (or a wrong
 * winner) where the pre-amplify pass already had a reasonable candidate.
 * Evals run amplify-off, so this path had no regression coverage.
 *
 * The amplifier is stubbed through the `context.amplifier` seam (same contract
 * as amplifyBrief: async (brief, opts) => {ok, amplified, via} | {ok, reason})
 * so no host-agent CLI is ever spawned from tests.
 */
import { describe, expect, test } from "bun:test";

const router = require("../lib/router.js");

/** Minimal in-memory registries (same shape router-coverage.test.ts uses). */
function makeRegistries(capabilities: Record<string, any[]>) {
  return {
    squads: {
      schema_version: "1.0.0",
      squads: {},
      capabilities,
      domains: {},
      _v4_inferred_capabilities: {},
    },
    businesses: { schema_version: "1.0.0", businesses: {}, _business_routing: {} },
  };
}

function destinationOf(m: any): string | null {
  return router.resolveDestination(m);
}

// ── Fixture A — borderline ebook brief ──────────────────────────────────────
// Brief content tokens: {escreva, ebook, produtividade, empreendedores}.
// The ebook capability covers 2 of 4 (confirm band) → the bridge engages and,
// with no alias file, falls through to arm (c) — the LLM amplifier.
const BRIEF_A = "escreva um ebook sobre produtividade para empreendedores";
const registriesA = () =>
  makeRegistries({
    "book.epub.write": [
      {
        squad: "ebook-squad",
        description: "produção de ebook digital sobre produtividade",
        domains: ["ebook"],
      },
    ],
    "social.content.plan": [
      {
        squad: "social-squad",
        description:
          "estratégia de conteúdo para redes sociais posts engajamento marketing",
        domains: ["social"],
      },
    ],
    "mentoring.growth.accelerate": [
      {
        squad: "mentor-squad",
        description:
          "mentoria e consultoria de negócios para aceleração de empreendedores",
        domains: ["mentoria"],
      },
    ],
  });

describe("Stage 2.7 post-amplify guard (drift protection)", () => {
  test("guard (a): rewrite drifts to zero original coverage → amplified result discarded, pre-amplify preserved", async () => {
    // Drifted rewrite: pure social-media vocabulary, zero tokens of the
    // original brief survive. Pre-guard, the re-run winner was social-squad
    // with coverage 0/4 vs the original brief → Stage 3 NO_MATCH.
    let calls = 0;
    const driftingAmplifier = async () => {
      calls++;
      return {
        ok: true,
        via: "stub",
        amplified:
          "planeje a estratégia de conteúdo para redes sociais com posts de engajamento e marketing",
      };
    };

    const r = await router.route(BRIEF_A, {
      registries: registriesA(),
      amplifier: driftingAmplifier,
    });

    expect(calls).toBe(1);
    expect(r.stage_bridge?.engaged).toBe(true);
    expect(r.stage_bridge?.amplifier_ran).toBe(true);
    expect(r.stage_bridge?.amplified_discarded).toBe("winner_zero_original_coverage");
    // Pre-amplify outcome preserved: confirm-band AMBIGUOUS with the ebook
    // candidate on top — never NO_MATCH, never the drifted social winner.
    expect(r.stage3?.signal).toBe("AMBIGUOUS");
    expect(destinationOf(r.stage3.alternatives[0])).toBe("ebook-squad");
    // The decision belongs to the original brief, so the working brief reverts.
    expect(r.brief).toBe(BRIEF_A);
  });

  test("guard (b): amplified pass ends NO_MATCH (nonzero coverage) → pre-amplify result returned", async () => {
    // Rewrite keeps ONE original token ("empreendedores") so guard (a) stays
    // silent, but the re-run winner (mentor-squad) covers 1/4 of the original
    // brief → Stage 3 NO_MATCH on the amplified pass. The pre-amplify pass had
    // the ebook candidate (2/4, confirm band) — that result must win.
    const amplifier = async () => ({
      ok: true,
      via: "stub",
      amplified:
        "estruture mentoria e consultoria de negócios com aceleração para empreendedores",
    });

    const r = await router.route(BRIEF_A, {
      registries: registriesA(),
      amplifier,
    });

    expect(r.stage_bridge?.amplifier_ran).toBe(true);
    expect(r.stage_bridge?.amplified_discarded).toBe("no_match_after_amplify");
    expect(r.stage3?.signal).toBe("AMBIGUOUS");
    expect(destinationOf(r.stage3.alternatives[0])).toBe("ebook-squad");
    expect(r.brief).toBe(BRIEF_A);
  });

  test("good amplification still improves the result (NO_MATCH → HIGH)", async () => {
    // Corpus where the specialist's vocabulary tokens are IDF-depressed by
    // filler docs, so pre-amplify the top is a generic kit doc covering 1/4
    // (NO_MATCH band). A faithful rewrite that KEEPS the user's words and adds
    // the specialist's editorial vocabulary lifts the specialist to the top —
    // its coverage vs the ORIGINAL brief is 3/4, clearing the gate → HIGH.
    const brief = "escreva um ebook digital sobre produtividade";
    const filler = (junk: string) => [
      { squad: `filler-${junk}`, description: `escreva ebook produtividade ${junk}` },
    ];
    const registries = makeRegistries({
      "assets.kit.make": [
        { squad: "kit-squad", description: "kit digital de templates" },
      ],
      "book.epub.write": [
        {
          squad: "ebook-squad",
          description:
            "escreva seu ebook sobre produtividade: produção editorial de livro, escrita de capítulos, publicação",
        },
      ],
      "filler.one.x": filler("curso aula"),
      "filler.two.x": filler("workshop apostila"),
      "filler.three.x": filler("resumo esquema"),
      "filler.four.x": filler("planilha modelo"),
      "filler.five.x": filler("roteiro slides"),
      "filler.six.x": filler("checklist guia"),
    });

    // Pre-amplify sanity: the bridge must engage (top below the coverage gate)
    // and the amplify-off outcome is NO_MATCH.
    const rOff = await router.route(brief, { registries, amplify: false });
    expect(rOff.stage_bridge?.engaged).toBe(true);
    expect(rOff.stage3?.signal).toBe("NO_MATCH");

    const goodAmplifier = async () => ({
      ok: true,
      via: "stub",
      amplified:
        "escreva um ebook sobre produtividade: produção editorial de livro com escrita de capítulos e publicação",
    });
    const r = await router.route(brief, { registries, amplifier: goodAmplifier });

    expect(r.stage_bridge?.amplifier_ran).toBe(true);
    expect(r.stage_bridge?.amplified_discarded).toBeUndefined();
    expect(r.stage3?.signal).toBe("HIGH");
    expect(destinationOf(r.stage3.target)).toBe("ebook-squad");
    // The amplified brief carries the dispatch (working brief kept).
    expect(r.brief).not.toBe(brief);
  });

  test("amplify-off path is byte-identical and never consults the amplifier seam", async () => {
    let calls = 0;
    const bomb = async () => {
      calls++;
      throw new Error("amplifier must not be called when amplify is off");
    };

    const plain = await router.route(BRIEF_A, { registries: registriesA(), amplify: false });
    const seamed = await router.route(BRIEF_A, {
      registries: registriesA(),
      amplify: false,
      amplifier: bomb,
    });

    expect(calls).toBe(0);
    const strip = (r: any) => {
      const c = JSON.parse(JSON.stringify(r));
      delete c.timestamp;
      return c;
    };
    expect(JSON.stringify(strip(seamed))).toBe(JSON.stringify(strip(plain)));
    // No guard artifacts on the amplify-off path.
    expect(seamed.stage_bridge).toEqual({
      engaged: true,
      alias_adopted: false,
      amplifier_ran: false,
    });
  });

  test("Stage -1.5 (WEAK upfront amplification) honors the same seam", async () => {
    let calls = 0;
    const amplifier = async () => {
      calls++;
      return { ok: true, via: "stub", amplified: BRIEF_A + " com plano de capítulos" };
    };
    // 3 tokens + vague marker → WEAK → upfront amplification fires.
    const r = await router.route("faz aquilo la", {
      registries: registriesA(),
      amplifier,
    });
    expect(calls).toBe(1);
    expect(r.stage_minus_2?.amplifier_used).toBe("stub");
  });
});
