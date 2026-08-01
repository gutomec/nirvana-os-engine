// quality-gate.test.ts — rubric selection contract (lib/rubric-selector.ts).
// The quality gate is what makes "done" honest. These guard that the right
// rubric is picked per deliverable and that selection is fail-closed / model-
// agnostic (target_model inherits the runtime, never a hardcoded slug).
// Runs with: bun test skills/harness/tests
import { describe, expect, test } from "bun:test";
import {
  selectRubricsForProduces,
  listRubrics,
  getRubric,
} from "../lib/rubric-selector.ts";

describe("selectRubricsForProduces", () => {
  test("empty produces → single prose_shortform fallback (fail-safe, flagged)", () => {
    const r = selectRubricsForProduces([]);
    expect(r.fallback_used).toBe(true);
    expect(r.rubrics.length).toBe(1);
    expect(r.rubrics[0]?.name).toBe("prose_shortform");
  });

  test("unknown produces → fallback, never an empty silent pass", () => {
    const r = selectRubricsForProduces(["totally-unknown-artifact-xyz"]);
    expect(r.fallback_used).toBe(true);
    expect(r.rubrics.length).toBeGreaterThan(0); // fail-closed: always yields a rubric
  });

  test("code-shaped unknown produces falls back to the code rubric, not prose", () => {
    const r = selectRubricsForProduces(["some-python-module"]);
    expect(r.fallback_used).toBe(true);
    expect(r.rubrics[0]?.name).toBe("code");
  });

  test("a mind-clone hint adds the voice-fidelity rubric to a real match", () => {
    // Find a produces slug that some rubric actually declares, so this stays
    // valid as the rubric set evolves.
    const withProduces = listRubrics().find((r) => r.applies_to_produces.length > 0);
    expect(withProduces).toBeTruthy();
    const slug = withProduces!.applies_to_produces[0];
    const r = selectRubricsForProduces([slug], { had_mind_clone: true });
    expect(r.fallback_used).toBe(false);
    expect(r.rubrics.some((x) => x.name === "mind_clone_voice_fidelity")).toBe(true);
  });
});

describe("rubric model-agnosticism (engine never prescribes a model)", () => {
  test("no rubric pins a concrete model slug — target_model is inherit/alias only", () => {
    for (const r of listRubrics()) {
      // The engine must not hardcode gpt-*/gemini-*/claude-*-N.N model versions.
      expect(r.target_model).not.toMatch(/gpt-|gemini-|claude-|-4-|-5|latest/);
    }
  });

  test("every rubric loads with a target_model (default inherit)", () => {
    const rubrics = listRubrics();
    expect(rubrics.length).toBeGreaterThan(0);
    for (const r of rubrics) {
      expect(typeof r.target_model).toBe("string");
      expect(r.target_model.length).toBeGreaterThan(0);
    }
  });
});
