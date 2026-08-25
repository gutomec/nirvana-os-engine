import { describe, expect, test } from "bun:test";
import { EvaluatorRegistry, compileGauntletPlan, parseExecutionOptions, resolveExecutionMode } from "../lib/gauntlet/index.ts";

describe("gauntlet compiler", () => {
  test("keeps standard as the default and makes auto policy explicit", () => {
    expect(resolveExecutionMode()).toEqual({ mode: "standard", reason: "standard is the backward-compatible default" });
    expect(resolveExecutionMode({ mode: "auto" }, { verifiable: true, risk: "high" }).mode).toBe("standard");
    expect(resolveExecutionMode({ mode: "auto", allowAutoGauntlet: true }, { verifiable: true, risk: "high" }).mode).toBe("gauntlet");
  });

  test.each([
    ["light", 1, 2, false],
    ["balanced", 3, 4, true],
    ["exhaustive", 5, 6, true],
  ] as const)("compiles %s into explicit finite limits", (intensity, candidates, rounds, holdout) => {
    const plan = compileGauntletPlan({ brief: "Build a tested service", intensity });
    expect(plan.intensity).toBe(intensity);
    expect(plan.candidateStrategy.count).toBe(candidates);
    expect(plan.stop.maxRounds).toBe(rounds);
    expect(plan.gauntlets[0].holdout.enabled).toBe(holdout);
    expect(plan.selection.independentJudge).toBe("required");
  });

  test("is deterministic and blocks ambiguous critical briefs", () => {
    const input = { brief: "Choose the deployment region", ambiguities: ["Region requires owner approval"] };
    expect(compileGauntletPlan(input)).toEqual(compileGauntletPlan(input));
    expect(compileGauntletPlan(input).successContract.humanRequired).toBeTrue();
  });

  test("parses opt-in CLI flags without changing legacy defaults", () => {
    expect(parseExecutionOptions([], {})).toMatchObject({ requestedMode: "standard", resolvedMode: "standard", intensity: "balanced" });
    expect(parseExecutionOptions(["--execution-mode=gauntlet", "--gauntlet-intensity", "exhaustive"], {}))
      .toMatchObject({ requestedMode: "gauntlet", resolvedMode: "gauntlet", intensity: "exhaustive" });
    expect(() => parseExecutionOptions(["--execution-mode=forever"], {})).toThrow(/invalid execution mode/);
  });
});

describe("evaluator registry", () => {
  test("selects by capability without hardcoded squads and rejects self-evaluation", () => {
    const registry = new EvaluatorRegistry();
    registry.register({ id: "same", target: { kind: "squad", slug: "builder", capabilityId: "quality.check" }, capabilities: ["quality.check"], priority: 10 });
    registry.register({ id: "independent", target: { kind: "agent-x", slug: "agent-x" }, capabilities: ["quality.check"] });
    expect(registry.select("quality.check", { kind: "squad", slug: "builder", capabilityId: "quality.check" }).id).toBe("independent");
    expect(() => registry.select("security.check", { kind: "business", slug: "builder" })).toThrow(/no independent evaluator/);
  });
});
