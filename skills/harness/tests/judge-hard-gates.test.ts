// judge-hard-gates.test.ts — declared hard gates outrank an LLM's score.
//
// The failure this catches is a judge returning verdict=pass and a high total
// score while a non-negotiable visual invariant failed. The engine, not the
// model, owns the final gate decision.
import { describe, expect, test } from "bun:test";
import { judge } from "../lib/judge.ts";
import { getRubric } from "../lib/rubric-selector.ts";

const runtimeRules = {
  loadRuntimeRules: () => [],
  detectCurrentHost: () => null,
  decideRuntime: () => { throw new Error("no runtime signal"); },
};

function driverReturning(output: Record<string, unknown>) {
  return {
    runtimeAvailable: () => true,
    callHostAgentAsync: async () => ({
      text: JSON.stringify(output),
      host: "test-host",
      exit_code: 0,
    }),
  };
}

function answer(hardGateResults: Array<Record<string, unknown>>) {
  return {
    verdict: "pass",
    total_score: 96,
    criteria_scores: [],
    critique: [],
    hard_gate_results: hardGateResults,
  };
}

function declaredResults(names: string[], failed?: string) {
  return names.map((name) => ({
    name,
    passed: name !== failed,
    rationale: name === failed ? "final rendered artifact violates the invariant" : "verified on final render",
  }));
}

describe("judge — machine-enforced hard gates", () => {
  test("failed final-composite contrast overrides an LLM pass", async () => {
    const rubric = getRubric("design")!;
    expect(rubric.hard_gates).toContain("final_composite_contrast");
    const out = await judge(
      { rubric, artifact: "rendered design" },
      {
        __testDriver: driverReturning(answer(declaredResults(rubric.hard_gates, "final_composite_contrast"))),
        __testRuntimeRules: runtimeRules,
      },
    );

    expect(out.verdict).toBe("fail");
    expect(out.critique.some((item) => item.id === "hard_gate:final_composite_contrast" && item.severity === "high")).toBe(true);
  });

  test("failed rendered-text containment overrides an LLM pass", async () => {
    const rubric = getRubric("image")!;
    expect(rubric.hard_gates).toContain("rendered_text_containment");
    const out = await judge(
      { rubric, artifact: "rendered image" },
      {
        __testDriver: driverReturning(answer(declaredResults(rubric.hard_gates, "rendered_text_containment"))),
        __testRuntimeRules: runtimeRules,
      },
    );

    expect(out.verdict).toBe("fail");
    expect(out.critique.some((item) => item.id === "hard_gate:rendered_text_containment" && item.severity === "high")).toBe(true);
  });

  test("an artifact can pass when every declared hard gate passes", async () => {
    const rubric = getRubric("image")!;
    const out = await judge(
      { rubric, artifact: "rendered image" },
      {
        __testDriver: driverReturning(answer(declaredResults(rubric.hard_gates))),
        __testRuntimeRules: runtimeRules,
      },
    );

    expect(out.verdict).toBe("pass");
    expect(out.schema_valid).toBe(true);
    expect(out.hard_gate_results.every((gate) => gate.passed)).toBe(true);
  });

  test("a missing declared result fails closed", async () => {
    const rubric = getRubric("design")!;
    const incomplete = declaredResults(rubric.hard_gates).filter((gate) => gate.name !== "rendered_text_containment");
    const out = await judge(
      { rubric, artifact: "rendered design" },
      {
        __testDriver: driverReturning(answer(incomplete)),
        __testRuntimeRules: runtimeRules,
      },
    );

    expect(out.verdict).toBe("fail");
    expect(out.schema_valid).toBe(false);
    expect(out.schema_errors).toContain("hard_gate_result_missing:rendered_text_containment");
  });

  const malformedCases: Array<{
    label: string;
    expectedError: string;
    mutate: (results: Array<Record<string, unknown>>) => void;
  }> = [
    {
      label: "missing rationale",
      expectedError: "hard_gate_result_rationale_invalid:final_composite_contrast",
      mutate: (results) => { delete results[0].rationale; },
    },
    {
      label: "empty rationale",
      expectedError: "hard_gate_result_rationale_invalid:final_composite_contrast",
      mutate: (results) => { results[0].rationale = ""; },
    },
    {
      label: "whitespace-only rationale",
      expectedError: "hard_gate_result_rationale_invalid:final_composite_contrast",
      mutate: (results) => { results[0].rationale = "   \t"; },
    },
    {
      label: "non-string rationale",
      expectedError: "hard_gate_result_rationale_invalid:final_composite_contrast",
      mutate: (results) => { results[0].rationale = 42; },
    },
    {
      label: "unknown gate name",
      expectedError: "hard_gate_result_unknown:final_composite_contrst",
      mutate: (results) => {
        results.push({ name: "final_composite_contrst", passed: true, rationale: "typo must not be ignored" });
      },
    },
    {
      label: "padded gate name",
      expectedError: "hard_gate_result_name_invalid:0",
      mutate: (results) => { results[0].name = " final_composite_contrast "; },
    },
    {
      label: "duplicate gate name",
      expectedError: "hard_gate_result_duplicate:final_composite_contrast",
      mutate: (results) => { results.push({ ...results[0] }); },
    },
  ];

  for (const malformed of malformedCases) {
    test(`${malformed.label} fails closed`, async () => {
      const rubric = getRubric("design")!;
      const results: Array<Record<string, unknown>> = declaredResults(rubric.hard_gates).map((gate) => ({ ...gate }));
      malformed.mutate(results);

      const out = await judge(
        { rubric, artifact: "rendered design" },
        {
          __testDriver: driverReturning(answer(results)),
          __testRuntimeRules: runtimeRules,
        },
      );

      expect(out.verdict).toBe("fail");
      expect(out.schema_valid).toBe(false);
      expect(out.schema_errors).toContain(malformed.expectedError);
    });
  }

  test("rubrics without hard gates keep the legacy response contract", async () => {
    const rubric = getRubric("prose_shortform")!;
    expect(rubric.hard_gates).toEqual([]);
    const out = await judge(
      { rubric, artifact: "plain prose" },
      {
        __testDriver: driverReturning({
          verdict: "pass",
          total_score: 90,
          criteria_scores: [],
          critique: [],
        }),
        __testRuntimeRules: runtimeRules,
      },
    );

    expect(out.verdict).toBe("pass");
    expect(out.schema_valid).toBe(true);
    expect(out.hard_gate_results).toEqual([]);
  });
});
