// gate-judge-sees-brief.test.ts — the LLM judge grades the artifact against the brief.
//
// JudgeInput.brief existed and judge() rendered it above the artifact, but the
// gate never passed it: the judge graded every deliverable against its rubric
// alone, so a report the brief asked to cite dated sources could pass with none.
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writeFakeCli } from "./helpers/fake-cli.ts";
import { spawnBudgetMs } from "./helpers/test-budgets.ts";

const R = fs.mkdtempSync(path.join(os.tmpdir(), "gate-brief-"));
afterAll(() => fs.rmSync(R, { recursive: true, force: true }));

const BIN = path.join(R, "bin");
const PROMPT_LOG = path.join(R, "judge-prompt.txt");
const VERDICT = JSON.stringify({ verdict: "pass", total_score: 90, criteria_scores: [], critique: [] });
writeFakeCli(BIN, "claude", `
import * as fs from "node:fs";
const input = await Bun.stdin.text();
fs.appendFileSync(${JSON.stringify(PROMPT_LOG)}, input + "\\n---END---\\n");
console.log(JSON.stringify({ type: "result", result: ${JSON.stringify(VERDICT)}, total_cost_usd: 0 }));
`);

const ARTIFACT = path.join(R, "report.md");
fs.writeFileSync(ARTIFACT, "# Market report\n\nThe market grew last year.\n", "utf8");
const BRIEF = path.join(R, "brief.md");
const BRIEF_TEXT = "Every claim cites a dated source (URL and date).";
fs.writeFileSync(BRIEF, BRIEF_TEXT, "utf8");

function gate(extra: string[]): { status: number | null; prompt: string } {
  fs.rmSync(PROMPT_LOG, { force: true });
  const r = spawnSync(process.execPath, [path.join(import.meta.dir, "..", "scripts", "quality-gate.ts"), ARTIFACT, "--auto", "--with-revisions", ...extra], {
    encoding: "utf8", cwd: R,
    env: { ...process.env, PATH: `${BIN}${path.delimiter}${process.env.PATH}`, NIRVANA_HOST_RUNTIME: "claude-code", NIRVANA_EXECUTION_DEFAULT_RUNTIME: "claude-code" },
  });
  let prompt = "";
  try { prompt = fs.readFileSync(PROMPT_LOG, "utf8"); } catch { /* the judge never ran */ }
  return { status: r.status, prompt };
}

describe("the gate hands the brief to the judge", () => {
  test("--brief-file reaches the judge's prompt", () => {
    const { prompt } = gate([`--brief-file=${BRIEF}`]);
    expect(prompt.length).toBeGreaterThan(0);
    expect(prompt).toContain(BRIEF_TEXT);
  }, spawnBudgetMs(2));

  test("without it the judge sees no brief (the old behaviour, still valid for callers with none)", () => {
    const { prompt } = gate([]);
    expect(prompt.length).toBeGreaterThan(0);
    expect(prompt).not.toContain(BRIEF_TEXT);
  }, spawnBudgetMs(2));
});
