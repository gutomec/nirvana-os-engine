// auto-parts-plan.test.ts — a request split into parts becomes a plan the
// multi-target engine accepts and runs in the right order. Zero-token: the
// plan is checked by the engine's own validator and compiler.
import { describe, expect, test } from "bun:test";
import { partBrief, partsToPlan } from "../lib/auto-parts-plan.ts";
import { compilePlanFile, validatePlanFile } from "../scripts/multi-target.ts";
import { parseWorkBrief } from "../lib/work-brief.ts";

const REQUEST = "Lance meu jogo indie na Steam e crie o token de recompensas com tokenomics e parecer regulatório.";
const input = {
  request: REQUEST,
  projectId: "20261013-1200-auto-parts",
  primary: "crypto-foundry",
  supportSquads: ["crypto-token-forge"],
  suggestedClones: ["vitalik-buterin"],
  parts: [
    { kind: "business" as const, slug: "crypto-foundry", part: "O token, a tokenomics e o parecer regulatório.", after: [] },
    { kind: "business" as const, slug: "arcadia-launch-house", part: "O lançamento na Steam.", after: ["crypto-foundry"] },
    { kind: "squad" as const, slug: "game-launch-marketing", part: "O press kit.", after: [] },
  ],
};

describe("the parts plan", () => {
  test("the multi-target engine accepts it and orders the waves by the parts' dependencies", () => {
    const { plan, issues } = validatePlanFile(partsToPlan(input));
    expect(issues).toEqual([]);
    const { loaded, issues: compileIssues } = compilePlanFile(plan!);
    expect(compileIssues).toEqual([]);
    const waves = loaded!.compiled.manifest.parallel_waves;
    const waveOf = (id: string) => waves.findIndex((w: string[]) => w.includes(id));
    expect(waveOf("crypto-foundry")).toBeLessThan(waveOf("arcadia-launch-house"));
    expect(waveOf("game-launch-marketing")).toBe(waveOf("crypto-foundry"));
  });

  test("one node per target, a company for a business and a squad for a squad", () => {
    const p = partsToPlan(input);
    expect(p.graph.nodes).toEqual([
      { id: "brief-main", type: "brief" },
      { id: "crypto-foundry", type: "company" },
      { id: "arcadia-launch-house", type: "company" },
      { id: "game-launch-marketing", type: "squad" },
    ]);
    expect(Object.keys(p.briefs)).toEqual(["crypto-foundry", "arcadia-launch-house", "game-launch-marketing"]);
  });

  test("each brief carries the request whole, its own part, and who delivers the rest", () => {
    const s = parseWorkBrief(partBrief(input, input.parts[1])).sections;
    expect(s["Request (verbatim)"]).toBe(REQUEST);
    expect(s["Your part"]).toContain("O lançamento na Steam.");
    expect(s["Your part"]).toContain("You start after crypto-foundry");
    expect(s["Your part"]).toContain("- business crypto-foundry: O token, a tokenomics e o parecer regulatório.");
  });

  test("the router's support squads and voices ride on the primary part only", () => {
    const primary = parseWorkBrief(partBrief(input, input.parts[0])).sections["Decisions"];
    const other = parseWorkBrief(partBrief(input, input.parts[1])).sections["Decisions"];
    expect(primary).toContain("- squad crypto-token-forge");
    expect(primary).toContain("- clone vitalik-buterin");
    expect(other).toBe("- None.");
  });

  test("a dependency on a target outside the plan is ignored, never a dangling edge", () => {
    const p = partsToPlan({ ...input, parts: [{ ...input.parts[0], after: ["ghost"] }, input.parts[1]] });
    expect(p.graph.edges.some((e) => e.target === "ghost")).toBe(false);
    expect(validatePlanFile(p).issues).toEqual([]);
  });
});
