// writing-contract-travels.test.ts — the rule a prose deliverable is judged by
// must travel with the dispatch.
//
// The writing contract lives in a project's CLAUDE.md/AGENTS.md, which only
// exists when the project was created with `nrv init` — and most are not. The
// gate judges .md/.txt with wiki-lint regardless, so a subagent could be failed
// on a rule it was never given. Observed live: a report came back with 38
// em-dashes against a budget of 12 and had to be rewritten after the fact.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..", "..", "..");
const tpl = fs.readFileSync(path.join(ROOT, "skills/harness/templates/DISPATCH-INSTRUCTION.template.md"), "utf8");
const harness = fs.readFileSync(path.join(ROOT, "skills/harness/SKILL.md"), "utf8");
const lint = fs.readFileSync(path.join(ROOT, "skills/harness/rubrics/wiki-lint.ts"), "utf8");

describe("the dispatch instruction carries the contract", () => {
  test("it states the dash budget the gate enforces", () => {
    expect(tpl).toMatch(/one per 200 words/i);
  });

  test("it names why it is carried, not assumed", () => {
    expect(tpl).toMatch(/nrv init/);
  });

  test("it lists the tells wiki-lint actually flags", () => {
    for (const tell of [/filler opener/i, /vague attribution/i, /negative parallelism/i]) {
      expect(tpl).toMatch(tell);
    }
  });

  test("it names the check the gate runs, without ordering a pre-run (2026: the gate is Phase 6's job)", () => {
    expect(tpl).toContain("quality-gate.ts");
    expect(tpl).toMatch(/--auto/);
    expect(tpl).not.toMatch(/re-run until it does/i);
    expect(tpl).toMatch(/the quality gate runs after you hand back/i);
  });
});

describe("the budget in the template matches the one in code", () => {
  test("wiki-lint's threshold and the template's budget are the same rule", () => {
    // Template says one per 200 words; wiki-lint flags above ~5 per 1000 words.
    // 1000/200 = 5. If either side moves, this test is the tripwire.
    expect(lint).toMatch(/5 per 1000 words|per 1000 words/);
    expect(tpl).toMatch(/one per 200 words/i);
  });
});

describe("the protocol reinforces it where the entity self-verifies", () => {
  test("Phase 5 leaves the gate to Phase 6; the rule reaches the entity through the dispatch instruction", () => {
    const start = harness.indexOf("### Phase 5");
    const end = harness.indexOf("### Memory levels");
    const p5 = harness.slice(start, end);
    expect(p5).not.toMatch(/quality-gate\.ts/);
    expect(p5).toMatch(/does not run the quality gate itself/i);
  });
});
