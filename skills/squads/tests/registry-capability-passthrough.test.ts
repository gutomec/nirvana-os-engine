// registry-capability-passthrough.test.ts — the squads registry stops dropping
// what the protocol lets a capability declare.
//
// `registry.js` used to project a capability down to
// {description, domains, examples, not_for, fidelity_status, invoke, score_boost}
// (+ produces, example_briefs, keywords, body_text). Everything else declared in
// squad.yaml died at index time, which left ready consumers on the other side
// reading nothing: budget.js estimates from `estimated_cost_usd`, the DAG
// planner and the race detector from `parallel_safe` / `writes_paths`, and the
// v6 fields (acceptance, evaluator, requires, consumes) had no carrier at all.
//
// Two rules are asserted here. Everything declared travels, and only what is
// declared travels — an absent field emits no key, so the registry of a library
// that declares none of this is byte-for-byte what it was.
//
// Runs with: bun test skills/squads/tests
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const registry = require("../lib/registry.js");

let tmp: string;
let root: string;

const RICH_SQUAD = `name: rich-squad
version: 1.0.0
protocol: "6.0"
description: A fixture squad whose capability declares every optional field the protocol allows.
capabilities:
  - id: fixture.rich.execute
    description: Builds the fixture artifact end to end, from the brief to the rendered file.
    domains: [testing]
    examples: ["build the fixture artifact"]
    produces: [fixture-artifact]
    inputs:
      - name: brief_path
        type: file
        formats: [md]
        required: true
    outputs:
      - name: artifact
        type: file
        format: html
    tools_required: [Read, Write]
    model_hint: opus
    estimated_cost_usd: 4.25
    parallel_safe: true
    writes_paths: ["outputs/fixture/**"]
    contributions:
      - into: squad
        at: execute:pre
        fragment:
          inline: Prefer the shortest path that satisfies the brief.
    acceptance:
      - id: renders-clean
        description: The artifact renders with no console error.
        blocking: true
        minimumScore: 0.9
    evaluator:
      scorecard: fixture-scorecard
      rubric: fixture-rubric
      dimensions: [fidelity]
      max_cost_usd: 1.5
    requires: [other-squad:fixture.dep.execute]
    consumes: [upstream-artifact]
    fidelity:
      status: validated
      threshold: 0.92
      ground_truth_dir: ground-truth/
      eval_results: evals/results.json
    invoke:
      type: workflow
      ref: workflows/build
`;

const BARE_SQUAD = `name: bare-squad
version: 1.0.0
protocol: "5.0"
description: A fixture squad whose capability declares only the required fields.
capabilities:
  - id: fixture.bare.execute
    description: Does the one thing it declares, with nothing optional attached.
    domains: [testing]
    examples: ["do the bare thing"]
    invoke:
      type: task
      ref: tasks/bare
`;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-sq-passthrough-"));
  root = path.join(tmp, "squads");
  fs.mkdirSync(path.join(root, "rich-squad"), { recursive: true });
  fs.writeFileSync(path.join(root, "rich-squad", "squad.yaml"), RICH_SQUAD);
  fs.mkdirSync(path.join(root, "bare-squad"), { recursive: true });
  fs.writeFileSync(path.join(root, "bare-squad", "squad.yaml"), BARE_SQUAD);
});

afterAll(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
});

const richEntry = () => registry.build([root]).capabilities["fixture.rich.execute"][0];
const bareEntry = () => registry.build([root]).capabilities["fixture.bare.execute"][0];

describe("squads registry — declared capability fields reach the index", () => {
  test("the cost the manifest declares is the cost the registry carries", () => {
    expect(richEntry().estimated_cost_usd).toBe(4.25);
  });

  test("scheduling fields travel: parallel_safe and writes_paths", () => {
    const e = richEntry();
    expect(e.parallel_safe).toBe(true);
    expect(e.writes_paths).toEqual(["outputs/fixture/**"]);
  });

  test("contract fields travel: inputs, outputs, tools_required, model_hint", () => {
    const e = richEntry();
    expect(e.inputs).toEqual([{ name: "brief_path", type: "file", formats: ["md"], required: true }]);
    expect(e.outputs).toEqual([{ name: "artifact", type: "file", format: "html" }]);
    expect(e.tools_required).toEqual(["Read", "Write"]);
    expect(e.model_hint).toBe("opus");
  });

  test("behavior overlays travel: contributions", () => {
    expect(richEntry().contributions).toEqual([{
      into: "squad",
      at: "execute:pre",
      fragment: { inline: "Prefer the shortest path that satisfies the brief." },
    }]);
  });

  test("v6 fields travel: acceptance, evaluator, requires, consumes", () => {
    const e = richEntry();
    expect(e.acceptance).toEqual([{
      id: "renders-clean",
      description: "The artifact renders with no console error.",
      blocking: true,
      minimumScore: 0.9,
    }]);
    expect(e.evaluator).toEqual({
      scorecard: "fixture-scorecard",
      rubric: "fixture-rubric",
      dimensions: ["fidelity"],
      max_cost_usd: 1.5,
    });
    expect(e.requires).toEqual(["other-squad:fixture.dep.execute"]);
    expect(e.consumes).toEqual(["upstream-artifact"]);
  });

  test("the whole fidelity block travels, and fidelity_status stays for its readers", () => {
    const e = richEntry();
    expect(e.fidelity).toEqual({
      status: "validated",
      threshold: 0.92,
      ground_truth_dir: "ground-truth/",
      eval_results: "evals/results.json",
    });
    expect(e.fidelity_status).toBe("validated");
  });
});

describe("squads registry — an undeclared field emits no key", () => {
  const OPTIONAL_KEYS = [
    "fidelity", "inputs", "outputs", "tools_required", "model_hint",
    "estimated_cost_usd", "parallel_safe", "writes_paths", "contributions",
    "acceptance", "evaluator", "requires", "consumes",
  ];

  test("a capability that declares nothing optional carries none of the new keys", () => {
    const e = bareEntry();
    for (const key of OPTIONAL_KEYS) expect(e).not.toHaveProperty(key);
  });

  test("the entry a bare capability produces is exactly the pre-existing shape", () => {
    expect(Object.keys(bareEntry()).sort()).toEqual([
      "description", "domains", "examples", "fidelity_status", "invoke", "not_for", "score_boost", "squad",
    ]);
  });

  test("an empty array is treated as undeclared, not as an empty key", () => {
    const dir = path.join(root, "empty-arrays-squad");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "squad.yaml"), `name: empty-arrays-squad
version: 1.0.0
protocol: "5.0"
description: A fixture squad whose capability declares the optional arrays as empty.
capabilities:
  - id: fixture.empty.execute
    description: Declares the optional arrays and leaves every one of them empty.
    domains: [testing]
    examples: ["do the empty thing"]
    tools_required: []
    writes_paths: []
    requires: []
    consumes: []
    acceptance: []
    invoke:
      type: task
      ref: tasks/empty
`);
    const e = registry.build([root]).capabilities["fixture.empty.execute"][0];
    for (const key of ["tools_required", "writes_paths", "requires", "consumes", "acceptance"]) {
      expect(e).not.toHaveProperty(key);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
