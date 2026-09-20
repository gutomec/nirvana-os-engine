// survey-is-complete.test.ts — the orchestrator reads the catalog, not a ranking.
//
// Phase 3 Pass 1 used to be a keyword shortlist: "semantic shortlist (cheap,
// ~5k tokens)", pick 5 to 10 candidates, then deep-read those. Pass 2 can only
// judge what Pass 1 put on the table, so the narrowing decided the outcome
// before any reading happened.
//
// Measured against 123 briefs that were dispatched, executed and PASSED THE
// GATE (2026-09-20): the entity that actually delivered was absent from a
// 15-deep keyword shortlist in 47.9% of them, 62.5% for businesses. Absent, not
// misranked. The cause is structural — a real brief says what the work is ABOUT
// and almost never names what must be BUILT:
//
//   "Monitor judicial diário operacional: DataJud real + agendamento"
//     by keyword → compliance-citadel, juridical-singularity, ux-atelier…
//     software-forge, which built it, was nowhere. It declares 50 keywords and
//     12 example briefs; it was not under-declared, it was out-ranked by theme.
//
// And the narrowing was never buying anything. The full catalog — 68 businesses
// and 224 squads with their FULL descriptions — costs ~45k tokens, and it is a
// sorted byte-stable FILE so a prompt cache holds it across sessions instead of
// re-costing every run. Mind-clones are the one exception:
// 617 of them cost ~23k to list, so they stay searched by need.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const SKILL = fs.readFileSync(path.join(import.meta.dir, "..", "SKILL.md"), "utf8");
const phase3 = SKILL.slice(SKILL.indexOf("### Phase 3"), SKILL.indexOf("### Phase 4"));

describe("Pass 1 surveys everything", () => {
  test("it names the full listings, not a search", () => {
    expect(phase3).toContain(".catalog.md");
    expect(phase3).toContain("slug + full description");
    expect(phase3).toContain("READ THE WHOLE CATALOG");
  });

  test("the old shortlist framing is gone from the pass and its heading", () => {
    expect(phase3).not.toContain("semantic shortlist (cheap");
    expect(SKILL).not.toContain("Phase 3 — Registry consult (two-pass: shortlist → deep confirm)");
  });

  test("and it says why, with the number that settles it", () => {
    // A rule without its measurement gets reverted by the next person who
    // thinks a search would be cheaper. It would not be.
    expect(phase3).toMatch(/~45k tokens/);
    expect(phase3).toMatch(/47\.9%/);
  });
});

describe("mind-clones are the one exception, and it is justified", () => {
  test("they are searched by need, because the catalog does not fit", () => {
    expect(phase3).toContain("nrv find-clone");
    expect(phase3).toMatch(/617 of them/);
  });

  test("a clone whose `refuses` covers the task is wrong at any score", () => {
    expect(phase3).toContain("a wrong pick at any score");
  });
});

describe("Pass 2 still opens what Pass 1 surfaced", () => {
  test("it reads the content, not the manifest alone", () => {
    for (const needle of ["org-chart.yaml", "employees/<name>.md", "agents/", "workflows/", "dna/"]) {
      expect(phase3).toContain(needle);
    }
  });
});
