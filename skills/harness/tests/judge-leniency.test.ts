// judge-leniency.test.ts — the judge fails a deliverable for a material defect,
// never for style alone, and it can be turned off.
import { describe, expect, test } from "bun:test";
import { ruleVerdict } from "../lib/judge.ts";
import { revisionFixes } from "../scripts/quality-gate.ts";
import { getSettingSpec, validateSettingValue } from "../../_shared/lib/settings-schema.ts";

const item = (severity: "high" | "medium" | "low", fix: string) =>
  ({ severity, issue: fix, suggested_fix: fix, location: "", criterion: "c" }) as any;

describe("ruleVerdict", () => {
  test("a score at the threshold passes", () => {
    expect(ruleVerdict({ total_score: 70, critique: [] }, 70)).toBe("pass");
  });
  test("style and polish alone never fail a deliverable", () => {
    expect(ruleVerdict({ total_score: 82, critique: [item("low", "tone"), item("medium", "order")] }, 70)).toBe("pass");
  });
  test("a material defect fails even with a good score", () => {
    expect(ruleVerdict({ total_score: 90, critique: [item("high", "missing part")] }, 70)).toBe("fail");
  });
  test("a score below the threshold fails", () => {
    expect(ruleVerdict({ total_score: 69, critique: [] }, 70)).toBe("fail");
  });
});

describe("revisionFixes", () => {
  test("a revision works on material and medium items, not on style", () => {
    expect(revisionFixes([item("low", "tone"), item("medium", "order"), item("high", "missing")])).toEqual(["missing", "order"]);
  });
  test("when only low items explain a low score, they are the work", () => {
    expect(revisionFixes([item("low", "tone")])).toEqual(["tone"]);
  });
});

describe("turning the judge off", () => {
  test("`off` is a spelling of `false`", () => {
    const spec = getSettingSpec("quality_gate.judge_enabled")!;
    expect(validateSettingValue(spec, "off")).toEqual({ ok: true, value: "false" });
    expect(validateSettingValue(spec, false)).toEqual({ ok: true, value: "false" });
  });
});
