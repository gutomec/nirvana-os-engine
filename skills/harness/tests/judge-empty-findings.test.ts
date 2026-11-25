// judge-empty-findings.test.ts — a critique item with a severity and no text is
// not a finding. On 2026-11-25 a judge on codex graded a LinkedIn post by
// prose-shortform, whose body only said "Same as prose-longform", and named the
// critique fields its own way: the gate showed "[high] ; [medium] ; [low]",
// two corrections ran with nothing to correct and the delivery was withheld.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-judge-empty-"));
process.env.HARNESS_LOGS_DIR = path.join(TMP, "harness-logs");

import { judge, judgeBatch, __internal__ } from "../lib/judge.ts";
import { getRubric } from "../lib/rubric-selector.ts";
import type { RubricMeta } from "../lib/rubric-selector.ts";

const RUBRIC = { name: "r", display_name: "R", pass_threshold: 70, target_model: "any", body: "## Criteria\n- fine\n\n## Output schema\nDefault.\n" } as RubricMeta;

/** The answer as codex gave it: its own names for the critique fields. */
const TEXTLESS = {
  verdict: "fail", total_score: 73.5,
  criteria_scores: [{ criterion: "brief_fidelity", score: 12, max_score: 20 }],
  critique: [
    { criterion: "brief_fidelity", severity: "high", description: "the path is not informed", suggestion: "inform it" },
    { criterion: "cta_quality", severity: "medium", description: "no call to action", suggestion: "add one" },
    { criterion: "specificity", severity: "low", description: "abstract", suggestion: "an example" },
  ],
};
const WITH_TEXT = {
  verdict: "fail", total_score: 73.5, criteria_scores: [],
  critique: [{ id: "c1", severity: "high", issue: "the post has 140 words, the brief asked for 80", suggested_fix: "cut it to 80" }],
};

const driver = (text: string) => ({
  runtimeAvailable: () => true,
  callHostAgentAsync: async () => ({ text, host: "codex", exit_code: 0 }),
});
const noRules = { loadRuntimeRules: () => [], detectCurrentHost: () => null, decideRuntime: () => ({ runtime: null, source: "none" }) };
const opts = (answer: unknown) => ({ __testDriver: driver(JSON.stringify(answer)), __testRuntimeRules: noRules });

describe("a critique item without text", () => {
  test("one file: the answer is no verdict, so the gate falls back instead of failing the file", async () => {
    const out = await judge({ rubric: RUBRIC, artifact: "a" }, opts(TEXTLESS));
    expect(out.schema_valid).toBe(false);
    expect(out.schema_errors).toEqual(["critique_item_without_issue"]);
    expect(out.critique.every((c) => c.issue.trim().length > 0)).toBe(true);
  });

  test("an empty or blank `issue` counts as no text", () => {
    for (const issue of ["", "   ", null, undefined]) {
      const v = __internal__.validateJudgeOutput({ ...WITH_TEXT, critique: [{ severity: "low", issue }] }, RUBRIC);
      expect(v.ok).toBe(false);
    }
  });

  test("a batch: the entry is dropped, so its file is judged on its own", async () => {
    const items = [{ id: "F1", label: "a.txt", artifact: "a", rubrics: [RUBRIC] }, { id: "F2", label: "b.txt", artifact: "b", rubrics: [RUBRIC] }];
    const res = await judgeBatch({ items }, opts({ verdicts: [{ file: "F1", rubric: "r", ...TEXTLESS }, { file: "F2", rubric: "r", ...WITH_TEXT }] }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.verdicts.has("F1")).toBe(false);
    expect(res.verdicts.get("F2")?.get("r")?.critique[0].issue).toContain("140 words");
  });

  test("a finding with its text still fails the file", async () => {
    const out = await judge({ rubric: RUBRIC, artifact: "a" }, opts(WITH_TEXT));
    expect(out.schema_valid).toBe(true);
    expect(out.verdict).toBe("fail");
  });
});

describe("the judge is told the field names", () => {
  test("a rubric that only says `Same as prose-longform` still gets the schema", () => {
    const shortform = getRubric("prose_shortform")!;
    expect(shortform.body).not.toContain('"issue"');
    const persona = __internal__.buildPersona(shortform);
    expect(persona).toContain('"issue"');
    expect(persona).toContain('"suggested_fix"');
  });

  test("a batch gets it too", () => {
    const persona = __internal__.buildBatchPersona([RUBRIC]);
    expect(persona).toContain('"issue"');
    expect(persona).toContain('"suggested_fix"');
  });
});
