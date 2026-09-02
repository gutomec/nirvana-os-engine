/**
 * enrich-employee-method.test.ts — the announced enricher exists and repairs
 * without corrupting.
 *
 * check-seat-sufficiency.ts printed `Enrich with: bun …/enrich-employee-method.ts`
 * for weeks while no such file existed — a thin seat's `autofix: "agentic"`
 * pointed at nothing. These cases pin the contract of the script that now
 * answers the pointer: shape validation, the deterministic sufficiency gate
 * asked BEFORE any write, byte-identical preservation of frontmatter and
 * existing body, retry-with-feedback, and the whole-business loader revert.
 *
 * All fixtures are synthetic — no LLM (the generator is injected, the same
 * seam style verify/agentic.ts uses via runHeadlessImpl), no live library.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import {
  assembleSeat,
  buildSeatPrompt,
  enrichSeat,
  existingHeadings,
  expectedLang,
  listSeats,
  MAX_GENERATED_CHARS,
  sufficiencyFeedback,
  validateSections,
  type GenResult,
  type RunCtx,
  type SeatFile,
} from "../scripts/enrich-employee-method.ts";

const require_ = createRequire(import.meta.url);
const { sufficiencyOfFile } = require_("../lib/seat-sufficiency.js");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "nrv-enrich-seat-"));

/** A real-shaped thin seat: rich frontmatter, 2-line body — the exact profile
 *  measured in the live library (ceo.md of atlas-eleitoral-brasil: h=0 d=1). */
const THIN_SEAT = `---
name: ceo
role: electoral_data_director
description: "Integra dados eleitorais preservando códigos, anos e linhagem."
reports_to: null
squads_authorized: [data-pipeline, data-quality-guardian]
self_score_contract:
  criteria:
    - {id: lineage_complete, description: "Todo indicador resolve até a origem.", threshold: 0.95}
---

# Diretor de dados eleitorais

Você integra dados eleitorais brasileiros. Acione os squads autorizados e entregue lineage e fontes.
`;

/** Sections that make the assembled seat pass the sufficiency measure:
 *  2 headings + >=5 decision lines (thresholds, DO/DON'Ts, substantive items). */
const GOOD_SECTIONS = {
  sections: [
    {
      heading: "Critérios de rejeição",
      body: [
        "- Nunca faço join territorial apenas por nome do município — sempre pelo código IBGE de 7 dígitos.",
        "- Reprovado qualquer indicador cuja linhagem não resolva até a fonte primária com ano explícito.",
        "- Nunca trato dado agregado como individual; escala menor que 95% de cobertura exige nota metodológica.",
      ].join("\n"),
    },
    {
      heading: "Handoff e escalonamento",
      body: [
        "- Pipeline com mais de 3 fontes vai para o squad data-pipeline; validação de qualidade sempre passa pelo data-quality-guardian.",
        "- Divergência acima de 2% entre fontes oficiais interrompe a entrega e abre revisão.",
        "- Antes do handoff, o self-score de lineage_complete precisa estar em 0.95 ou mais.",
      ].join("\n"),
    },
  ],
};

function seatFixture(dir: string, content: string = THIN_SEAT): SeatFile {
  const empDir = path.join(dir, "employees");
  fs.mkdirSync(empDir, { recursive: true });
  const file = path.join(empDir, "ceo.md");
  fs.writeFileSync(file, content, "utf8");
  const s = sufficiencyOfFile(content);
  return { slug: "ceo", file, content, verdict: s.verdict, signals: s.signals };
}

function ctxWith(dir: string, answers: GenResult[]): { ctx: RunCtx; calls: string[] } {
  const calls: string[] = [];
  let i = 0;
  return {
    calls,
    ctx: {
      attempts: 3,
      backupRoot: path.join(dir, "backups"),
      generate: (prompt) => { calls.push(prompt); return answers[Math.min(i++, answers.length - 1)]; },
    },
  };
}

const ok = (json: unknown): GenResult => ({ ok: true, json, costUsd: 0.01 });

describe("the fixtures agree with the measure", () => {
  test("the thin fixture is thin and the good sections flip it to sufficient", () => {
    expect(sufficiencyOfFile(THIN_SEAT).verdict).toBe("thin");
    const assembled = assembleSeat(THIN_SEAT, GOOD_SECTIONS.sections);
    expect(sufficiencyOfFile(assembled).verdict).toBe("sufficient");
  });
});

describe("validateSections — shape before spend", () => {
  const ctx = { seatContent: THIN_SEAT, lang: "pt" as const };

  test("good sections pass whole", () => {
    const v = validateSections(GOOD_SECTIONS, ctx);
    expect(v.ok).toBe(true);
    expect(v.cleaned!.length).toBe(2);
  });

  test("a heading that duplicates an existing section is rejected", () => {
    const v = validateSections({ sections: [
      { heading: "Diretor de dados eleitorais", body: "- Nunca aceito fonte sem ano explícito no metadado da entrega." },
      ...GOOD_SECTIONS.sections,
    ] }, ctx);
    expect(v.errors.join("\n")).toContain("duplicates an existing section");
  });

  test("a --- line inside a body is frontmatter-fence injection", () => {
    const v = validateSections({ sections: [
      { heading: "Separador", body: "antes\n---\ndepois" },
      GOOD_SECTIONS.sections[0],
    ] }, ctx);
    expect(v.ok).toBe(false);
    expect(v.errors.join("\n")).toContain("frontmatter-fence");
  });

  test("placeholders are not method", () => {
    const v = validateSections({ sections: [
      { heading: "Método", body: "TODO: preencher com as regras reais" },
      GOOD_SECTIONS.sections[0],
    ] }, ctx);
    expect(v.errors.join("\n")).toContain("placeholder");
  });

  test("Portuguese 'todo' is NOT a placeholder — the marker is uppercase-only", () => {
    // The first live run burned $5.86 rejecting three honest generations
    // because \bTODO\b/i matched "Todo indicador…". Pin the fix.
    const v = validateSections({ sections: [
      {
        heading: "Cobertura e linhagem",
        body: [
          "- Todo indicador entregue resolve até a fonte primária, com ano e órgão explícitos.",
          "- Nunca aprovo painel em que todo o filtro territorial dependa de nome de município.",
          "- Cobertura mínima de 95% dos municípios; abaixo disso a entrega sai com nota metodológica.",
        ].join("\n"),
      },
      GOOD_SECTIONS.sections[0],
    ] }, ctx);
    expect(v.ok).toBe(true);
  });

  test("an English method on a PT seat is a language mismatch", () => {
    const v = validateSections({ sections: [
      { heading: "Rejection criteria", body: "- Never accept a source without an explicit year attached to the record." },
      { heading: "Handoff rules", body: "- Always send multi-source pipelines to the data-pipeline squad for review first." },
    ] }, { seatContent: THIN_SEAT, lang: "pt" });
    expect(v.errors.join("\n")).toContain("language mismatch");
  });

  test("sections that stay thin after assembly fail the gate BEFORE any write", () => {
    const v = validateSections({ sections: [
      { heading: "Uma seção", body: "Prosa vaga sobre a importância do trabalho bem feito." },
      { heading: "Outra seção", body: "Mais prosa sem uma única regra concreta de decisão." },
    ] }, ctx);
    expect(v.ok).toBe(false);
    expect(v.errors.join("\n")).toContain("still thin after assembly");
  });

  test("the generated-size cap holds — a seat is a method, not a book", () => {
    const huge = "x".repeat(MAX_GENERATED_CHARS);
    const v = validateSections({ sections: [
      { heading: "Enciclopédia", body: huge },
      GOOD_SECTIONS.sections[0],
    ] }, ctx);
    expect(v.errors.join("\n")).toContain("cap is");
  });
});

describe("assembleSeat — surgical by construction", () => {
  test("the original file survives byte-identical as a prefix", () => {
    const assembled = assembleSeat(THIN_SEAT, GOOD_SECTIONS.sections);
    expect(assembled.startsWith(THIN_SEAT.replace(/\s+$/, ""))).toBe(true);
    expect(assembled.endsWith("\n")).toBe(true);
    // Frontmatter parsers still see exactly one fence pair at the top.
    expect(assembled.match(/^---$/gm)!.length).toBe(2);
  });
});

describe("expectedLang and existingHeadings", () => {
  test("a PT body asks for PT; an EN body asks for EN; empty falls back to description then pt", () => {
    expect(expectedLang(THIN_SEAT)).toBe("pt");
    expect(expectedLang('---\nname: x\n---\n\nAlways verify the source of the data before publishing anything.\n')).toBe("en");
    expect(expectedLang('---\nname: x\ndescription: "Não aprova nada sem fonte."\n---\n')).toBe("pt");
  });

  test("H1-H3 and bold pseudo-headings are all reserved, accent-folded", () => {
    const h = existingHeadings('---\nname: x\n---\n\n# Título Principal\n\n## Critérios de Rejeição\n\n**Identidade**\n');
    expect(h.has("titulo principal")).toBe(true);
    expect(h.has("criterios de rejeicao")).toBe(true);
    expect(h.has("identidade")).toBe(true);
  });
});

describe("enrichSeat — the loop", () => {
  test("a good first answer enriches: file sufficient, prefix preserved, cost recorded", () => {
    const dir = tmp();
    const seat = seatFixture(dir);
    const { ctx } = ctxWith(dir, [ok(GOOD_SECTIONS)]);
    const { report } = enrichSeat("fixture-biz", dir, seat, [seat], ctx);

    expect(report.status).toBe("enriched");
    expect(report.attempts).toBe(1);
    expect(report.cost_usd).toBeCloseTo(0.01);
    const onDisk = fs.readFileSync(seat.file, "utf8");
    expect(sufficiencyOfFile(onDisk).verdict).toBe("sufficient");
    expect(onDisk.startsWith(THIN_SEAT.replace(/\s+$/, ""))).toBe(true);
    expect(report.signals_after!.decisionLines).toBeGreaterThanOrEqual(5);
  });

  test("a thin answer gets the signals as feedback and the retry succeeds", () => {
    const dir = tmp();
    const seat = seatFixture(dir);
    const thinAnswer = ok({ sections: [
      { heading: "Prosa", body: "Texto vago sem regras concretas de nenhum tipo aqui." },
      { heading: "Mais prosa", body: "Outra seção igualmente vaga sem números nem limites." },
    ] });
    const { ctx, calls } = ctxWith(dir, [thinAnswer, thinAnswer, ok(GOOD_SECTIONS)]);
    const { report } = enrichSeat("fixture-biz", dir, seat, [seat], ctx);

    expect(report.status).toBe("enriched");
    // attempt 1 = generate + one in-attempt repair (both thin), attempt 2 = good.
    expect(report.attempts).toBe(2);
    // The repair/retry prompts carry the measure's own vocabulary.
    expect(calls.slice(1).some((p) => p.includes("still thin after assembly"))).toBe(true);
    expect(sufficiencyOfFile(fs.readFileSync(seat.file, "utf8")).verdict).toBe("sufficient");
  });

  test("when every attempt fails the file is byte-identical to the original", () => {
    const dir = tmp();
    const seat = seatFixture(dir);
    const bad = ok({ sections: [{ heading: "Só uma", body: "vaga" }] });
    const { ctx } = ctxWith(dir, [bad]);
    const { report } = enrichSeat("fixture-biz", dir, seat, [seat], ctx);

    expect(report.status).toBe("gate_failed");
    expect(fs.readFileSync(seat.file, "utf8")).toBe(THIN_SEAT);
  });

  test("a generation failure is reported, never written", () => {
    const dir = tmp();
    const seat = seatFixture(dir);
    const { ctx } = ctxWith(dir, [{ ok: false, json: null, costUsd: null, error: "runtime timed out" }]);
    const { report } = enrichSeat("fixture-biz", dir, seat, [seat], ctx);

    expect(report.status).toBe("gate_failed");
    expect(report.errors.join("\n")).toContain("runtime timed out");
    expect(fs.readFileSync(seat.file, "utf8")).toBe(THIN_SEAT);
  });
});

describe("listSeats and the prompt", () => {
  test("listSeats measures every seat with the admission measure", () => {
    const dir = tmp();
    seatFixture(dir);
    const rich = assembleSeat(THIN_SEAT, GOOD_SECTIONS.sections).replace("name: ceo", "name: rich");
    fs.writeFileSync(path.join(dir, "employees", "rich.md"), rich, "utf8");
    const seats = listSeats(dir);
    expect(seats.map((s) => `${s.slug}:${s.verdict}`).sort()).toEqual(["ceo:thin", "rich:sufficient"]);
  });

  test("the prompt grounds the model in the seat, the business and the language", () => {
    const dir = tmp();
    const seat = seatFixture(dir);
    fs.writeFileSync(path.join(dir, "business.yaml"), "name: fixture-biz\ndescription: Electoral data integration.\n", "utf8");
    const prompt = buildSeatPrompt("fixture-biz", dir, seat, [seat], "pt", null);
    expect(prompt).toContain("self_score_contract");        // the seat travels whole
    expect(prompt).toContain("Electoral data integration"); // business.yaml travels
    expect(prompt).toContain("Brazilian Portuguese");       // language is explicit
    expect(prompt).toContain("sections");                   // output contract
    const withFeedback = buildSeatPrompt("fixture-biz", dir, seat, [seat], "pt", sufficiencyFeedback({ headings: 1, decisionLines: 2, bodyChars: 100, nonEmptyLines: 4 }));
    expect(withFeedback).toContain("headings=1 decisionLines=2");
  });
});
