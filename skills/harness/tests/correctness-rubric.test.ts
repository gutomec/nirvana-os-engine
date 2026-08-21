// correctness-rubric.test.ts — the correctness heuristic must not fail
// Portuguese prose.
//
// The failure this prevents (VPS field report, 2026-08-21): the placeholder
// regex carried /i, so the marker TODO matched the Portuguese word "todo"
// ("todo o tráfego") — any dense PT-BR text scored as placeholder-ridden.
// Combined with a heading penalty that ignored pseudo-headings and lists
// (and punished briefs that forbid headings), real deliverables failed the
// gate and only passed via an audited x_correctness_override. The gate must
// be right on its own, not right-after-override.

import { describe, expect, test } from "bun:test";
import { evaluate } from "../rubrics/correctness.ts";

const PT_SENTENCE = "Todo o tráfego pago passa por revisão, e todo criativo novo herda o histórico de todo o funil antes de subir. ";
const PT_PROSE = (PT_SENTENCE + "A operação segue o plano acordado com o cliente em todo detalhe relevante. ").repeat(12);

describe("correctness rubric — language sensitivity", () => {
  test("dense PT-BR prose full of the word 'todo' passes clean", async () => {
    const r = await evaluate({ artifact: "nota.md", content: `**Plano de mídia**\n\n${PT_PROSE}` });
    expect(r.passed).toBe(true);
    expect(r.fix_list.find((f) => f.includes("placeholders"))).toBeUndefined();
  });

  test("real uppercase markers still count", async () => {
    const marked = ("TODO: escrever esta seção. TBD. FIXME agora. ").repeat(30);
    const r = await evaluate({ artifact: "nota.md", content: marked });
    expect(r.fix_list.some((f) => f.includes("placeholders"))).toBe(true);
  });

  test("bracketed placeholders are markers at any casing", async () => {
    const marked = ("O relatório de [insert client name] mostra [fill metric] em toda análise. ").repeat(30);
    const r = await evaluate({ artifact: "nota.md", content: marked });
    expect(r.fix_list.some((f) => f.includes("placeholders"))).toBe(true);
  });
});

describe("correctness rubric — structure is more than headings", () => {
  test("bold pseudo-headings count as structure", async () => {
    const r = await evaluate({ artifact: "nota.md", content: `**Identidade**\n\n${PT_PROSE}` });
    expect(r.fix_list.some((f) => f.includes("structure"))).toBe(false);
  });

  test("lists count as structure", async () => {
    const r = await evaluate({ artifact: "nota.md", content: `${PT_PROSE}\n- primeiro ponto detalhado da entrega\n- segundo ponto detalhado da entrega\n` });
    expect(r.fix_list.some((f) => f.includes("structure"))).toBe(false);
  });

  test("a genuinely structureless long wall is still flagged, without failing alone", async () => {
    const r = await evaluate({ artifact: "nota.md", content: PT_PROSE });
    expect(r.fix_list.some((f) => f.includes("structure"))).toBe(true);
    expect(r.passed).toBe(true); // -0.2 alone must not fail an otherwise-real artifact
  });
});
