import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { compileGauntletPlan } from "../lib/gauntlet/compiler.ts";
import {
  BRIEF_CONFORMANCE_ID, REQUIREMENTS_MAX, acceptanceCriteriaOf, briefConformance, profileScore, requirementsFor,
} from "../lib/gauntlet/success-requirements.ts";

const roots: string[] = [];
afterEach(() => { while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true }); });

function squad(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-success-req-")); roots.push(root);
  for (const [rel, body] of Object.entries(files)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body, "utf8");
  }
  return root;
}

describe("requirementsFor — the judge's contract", () => {
  test("without a capability it is exactly today's single requirement", () => {
    const result = requirementsFor({ intensity: "light" });
    expect(result).toEqual({ requirements: [briefConformance("light")], origin: "brief-conformance", truncated: 0 });
    // The same object the compiler builds on its own: same id, same threshold, same capability.
    expect(compileGauntletPlan({ brief: "Build", intensity: "light" }).successContract.requirements).toEqual(result.requirements);
  });

  test("a squad without acceptance, workflow or task receives exactly brief-conformance", () => {
    const dir = squad({ "squad.yaml": "name: empty\n" });
    expect(requirementsFor({ squadDir: dir, capability: { id: "x.y", invoke: { type: "workflow", ref: "workflows/ghost" } } }))
      .toMatchObject({ origin: "brief-conformance", requirements: [{ id: BRIEF_CONFORMANCE_ID }] });
  });

  test("declared acceptance blocks by default, is namespaced and inherits the fidelity threshold", () => {
    const result = requirementsFor({
      intensity: "balanced",
      capability: {
        fidelity: { threshold: 0.7 },
        acceptance: [
          { id: "offer_stated", description: "The offer is stated in the first screen" },
          { id: "brief-conformance", description: "A criterion that would shadow the brief", blocking: false, minimumScore: 0.99 },
        ],
      },
    });
    expect(result.origin).toBe("acceptance");
    expect(result.requirements.map(item => item.id)).toEqual([BRIEF_CONFORMANCE_ID, "acceptance.offer_stated", "acceptance.brief-conformance"]);
    expect(result.requirements[0].minimumScore).toBe(profileScore("balanced"));
    expect(result.requirements[1]).toMatchObject({ blocking: true, minimumScore: 0.7 });
    expect(result.requirements[2]).toMatchObject({ blocking: false, minimumScore: 0.99 });
  });

  test("the ceiling keeps twelve requirements and reports what it dropped", () => {
    const acceptance = Array.from({ length: 12 }, (_, index) => ({ id: `c_${index}`, description: `criterion ${index}` }));
    const result = requirementsFor({ capability: { acceptance } });
    expect(result.requirements).toHaveLength(REQUIREMENTS_MAX);
    expect(result.truncated).toBe(1);
  });

  test("falls back to the invoked workflow's success_indicators, non-blocking", () => {
    const dir = squad({
      "workflows/build.md": "---\nname: build\nsteps:\n  - id: write\n    agent: writer\nsuccess_indicators:\n  - O relatório cita as fontes\n  - Cada seção tem um número\n---\n\n## write\nEscreva.\n",
    });
    const result = requirementsFor({ squadDir: dir, intensity: "light", capability: { invoke: { type: "workflow", ref: "build" } } });
    expect(result.origin).toBe("success_indicators");
    expect(result.requirements.map(item => item.id)).toEqual([BRIEF_CONFORMANCE_ID, "indicator.1", "indicator.2"]);
    expect(result.requirements[1]).toMatchObject({ blocking: false, description: "O relatório cita as fontes", minimumScore: profileScore("light") });
  });

  test("reads the legacy dialect through the v6 reader (success_criteria in a .yaml workflow)", () => {
    const dir = squad({ "workflows/build.yaml": "name: build\nsteps:\n  - id: write\n    agent: writer\nsuccess_criteria:\n  - Um indicador legado\n" });
    const result = requirementsFor({ squadDir: dir, capability: { invoke: { type: "workflow", ref: "workflows/build" } } });
    expect(result.origin).toBe("success_indicators");
    expect(result.requirements[1].description).toBe("Um indicador legado");
  });

  test("falls back to the invoked task's ## Acceptance Criteria", () => {
    const dir = squad({ "tasks/render.md": "# Render\n\n## Steps\n1. Do it\n\n## Acceptance Criteria\n- O PDF abre sem erro\n- A capa tem o logo\n\n## Output Schema\nnone\n" });
    const result = requirementsFor({ squadDir: dir, capability: { invoke: { type: "task", ref: "render" } } });
    expect(result.origin).toBe("task_acceptance_criteria");
    expect(result.requirements.map(item => item.description).slice(1)).toEqual(["O PDF abre sem erro", "A capa tem o logo"]);
    expect(result.requirements.slice(1).every(item => item.blocking === false)).toBeTrue();
  });

  test("acceptance wins over the workflow's indicators", () => {
    const dir = squad({ "workflows/build.md": "---\nname: build\nsteps: []\nsuccess_indicators:\n  - ignorado\n---\n" });
    expect(requirementsFor({ squadDir: dir, capability: { acceptance: [{ id: "declared", description: "vence" }], invoke: { type: "workflow", ref: "build" } } }).origin)
      .toBe("acceptance");
  });

  test("acceptanceCriteriaOf reads only the section's bullets", () => {
    expect(acceptanceCriteriaOf("## Acceptance Criteria\n- um\n* dois\n\n## Output\n- não\n")).toEqual(["um", "dois"]);
    expect(acceptanceCriteriaOf("# Task\nsem seção\n")).toEqual([]);
  });
});

describe("compileGauntletPlan with a real contract", () => {
  test("three requirements compile three gauntlets, chained and holdout-aware", () => {
    const requirements = requirementsFor({ intensity: "balanced", capability: { acceptance: [
      { id: "a", description: "primeiro" }, { id: "b", description: "segundo", blocking: false },
    ] } }).requirements;
    const plan = compileGauntletPlan({ brief: "Produza o relatório", intensity: "balanced", requirements });
    expect(plan.gauntlets).toHaveLength(3);
    expect(plan.gauntlets.map(item => item.id)).toEqual(["brief-conformance", "acceptance.a", "acceptance.b"]);
    expect(plan.gauntlets.map(item => item.dependsOn)).toEqual([[], ["brief-conformance"], ["acceptance.a"]]);
    expect(plan.gauntlets.map(item => item.holdout.enabled)).toEqual([true, true, false]);
    expect(plan.successContract.requirements).toEqual(requirements);
  });

  test("the brief-only contract compiles the plan id it compiles today, bit for bit", () => {
    const today = compileGauntletPlan({ brief: "Produza o relatório", intensity: "balanced" });
    // What `gauntlet.requirements_source=brief` (the default) hands the compiler.
    const passed = compileGauntletPlan({ brief: "Produza o relatório", intensity: "balanced", requirements: [briefConformance("balanced")] });
    expect(passed).toEqual(today);
    expect(compileGauntletPlan({ brief: "Produza o relatório", intensity: "balanced", requirements: undefined }).planId).toBe(today.planId);
    // And a real contract is a different plan — the id is not insensitive to the requirements.
    expect(compileGauntletPlan({ brief: "Produza o relatório", intensity: "balanced",
      requirements: requirementsFor({ capability: { acceptance: [{ id: "a", description: "primeiro" }] } }).requirements }).planId)
      .not.toBe(today.planId);
  });
});
