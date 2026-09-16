// brief-altitude.test.ts — the brief states the result, not the method (2026 doctrine).
//
// `briefing.altitude` decides the shape of the enriched brief and of the
// dispatch instruction; `outcome` is the default. The scorer stops asking for
// examples and in/out scope, the amplification templates stop carrying those
// questions, and the dispatch template no longer tells the executor to run the
// quality gate before handing back. This test pins each of those surfaces.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SETTINGS } from "../../_shared/lib/settings-schema.ts";
import { scoreBrief } from "../lib/brief-scorer.ts";

const HARNESS = join(import.meta.dir, "..");

describe("briefing.altitude", () => {
  test("defaults to outcome and is settable from the environment", () => {
    const s = SETTINGS["briefing.altitude"] as any;
    expect(s.default).toBe("outcome");
    expect(s.options).toEqual(["outcome", "guided", "prescriptive"]);
    expect(s.env).toBe("NIRVANA_BRIEF_ALTITUDE");
  });

  test("mind-clone DNA travels by reference unless asked otherwise", () => {
    const s = SETTINGS["execution.dna_injection"] as any;
    expect(s.default).toBe("reference");
    expect(s.options).toEqual(["reference", "fragments", "full"]);
  });

  test("the brief format is written down with its eight sections", () => {
    const spec = readFileSync(join(HARNESS, "references", "05-brief.md"), "utf8");
    for (const h of ["## Pedido (verbatim)", "## Intenção e porquê", "## Referências", "## Guarda-corpos", "## Pronto quando", "## Verificação", "## Parar quando", "## Autonomia"]) {
      expect(spec).toContain(`\`${h}\``);
    }
    const skill = readFileSync(join(HARNESS, "SKILL.md"), "utf8");
    expect(skill).toContain("references/05-brief.md");
    expect(skill).not.toContain("BEFORE handing back");
  });
});

describe("the scorer no longer demands examples or in/out scope", () => {
  test("a clear brief with neither is not amplified for them", () => {
    const brief = "Quero um relatório de 10 páginas sobre o mercado de nutrologia em Recife para a diretoria da clínica decidir se abre uma unidade. Pronto quando responder as três perguntas do briefing com fontes datadas. Prazo: sexta-feira, PT-BR.";
    const s = scoreBrief(brief);
    expect(s.missing_dimensions).not.toContain("examples");
    expect(s.missing_dimensions).not.toContain("scope");
    expect(s.reasons.join("\n")).not.toMatch(/example|scope boundaries/i);
  });

  test("the amplification templates carry only the four questions that matter", () => {
    const dir = join(HARNESS, "templates", "amplification");
    for (const f of readdirSync(dir)) {
      const src = readFileSync(join(dir, f), "utf8");
      expect(src).not.toMatch(/^## (examples|scope)\b/m);
      expect(src).toMatch(/^## objective\b/m);
      expect(src).toMatch(/^## success_criteria\b/m);
    }
  });
});

describe("the dispatch instruction states done, not method", () => {
  test("no verification scaffold and no building manual", () => {
    const tpl = readFileSync(join(HARNESS, "templates", "DISPATCH-INSTRUCTION.template.md"), "utf8");
    expect(tpl).toMatch(/^## 8\. Done/m);
    expect(tpl).toMatch(/^## 9\. Guardrails that travel with you/m);
    expect(tpl).not.toMatch(/^## 9\. How to build/m);
    expect(tpl).not.toMatch(/re-run until it does/i);
    expect(tpl).toContain("## Premissas assumidas");
    expect(Buffer.byteLength(tpl)).toBeLessThan(9000);
    expect(existsSync(join(HARNESS, "templates", "DISPATCH-INSTRUCTION.template.md"))).toBe(true);
  });
});

describe("the autonomous directive is a page of guardrails, not a manual", () => {
  test("under 3.2K bytes, keeps the markers the gates read, drops the library table and the hyphen rule", async () => {
    const { AUTONOMOUS_DIRECTIVE } = await import("../lib/host-agent-driver.ts");
    expect(Buffer.byteLength(AUTONOMOUS_DIRECTIVE)).toBeLessThanOrEqual(3200);
    for (const kept of ["FUNDAMENTAL PREMISE", "AUTONOMOUS MODE", "HEADLESS SESSION LIFETIME", "CONTINUOUS FLOW", "MESSAGE INTERRUPTION", "## Premissas assumidas", "Finish the whole task"]) {
      expect(AUTONOMOUS_DIRECTIVE).toContain(kept);
    }
    for (const gone of ["Leaflet", "Next.js", "HYPHEN", "AVAILABLE SQUADS section"]) expect(AUTONOMOUS_DIRECTIVE).not.toContain(gone);
  });
});
