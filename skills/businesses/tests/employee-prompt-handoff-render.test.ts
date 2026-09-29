// employee-prompt-handoff-render.test.ts — the brief reaches a seat's prompt once.
//
// HANDOFF.json carries a copy of the brief (brief_original, and amplified_brief
// when the intake amplified it) and the prompt rendered the file whole beside the
// brief's own section, so the same text arrived two or three times.
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnBudgetMs } from "../../harness/tests/helpers/test-budgets.ts";

const R = mkdtempSync(join(tmpdir(), "seat-handoff-"));
afterAll(() => rmSync(R, { recursive: true, force: true }));

writeFileSync(join(R, ".env"), "NIRVANA_SCOPE=project\n", "utf8");
const biz = join(R, ".nirvana", "businesses", "atelier");
mkdirSync(join(biz, "employees"), { recursive: true });
writeFileSync(join(biz, "business.yaml"), "name: atelier\ndescription: a fixture atelier\n", "utf8");
writeFileSync(join(biz, "employees", "writer.md"), "---\nrole: writer\n---\n# writer\n\nWrites the report.\n", "utf8");

const BRIEF = "Monte o relatório trimestral BRIEF-MARKER com as vendas por região.";
const briefFile = join(R, "brief.txt");
writeFileSync(briefFile, BRIEF, "utf8");

function prompt(handoff: Record<string, unknown>): string {
  const projectDir = mkdtempSync(join(R, "proj-"));
  writeFileSync(join(projectDir, "HANDOFF.json"), JSON.stringify(handoff, null, 2), "utf8");
  const r = spawnSync(process.execPath, [join(import.meta.dir, "..", "lib", "employee-prompt.ts"), "atelier", "writer", projectDir, briefFile], {
    cwd: R, encoding: "utf8",
    env: { ...process.env, NIRVANA_STATE_DB: join(R, "state.db"), HARNESS_LOGS_DIR: join(R, "logs") },
  });
  expect(r.status, r.stderr).toBe(0);
  return `${r.stdout ?? ""}`;
}

const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

describe("the HANDOFF render does not repeat the brief", () => {
  test("a copy the brief section already holds is left out of the render", () => {
    const p = prompt({ phase: "plan", brief_original: BRIEF, amplified_brief: BRIEF, decisions: [] });
    expect(count(p, "BRIEF-MARKER")).toBe(1);
    expect(p).toContain('"phase": "plan"');
  }, spawnBudgetMs(1));

  test("an amplified brief the seat has not seen stays in the render", () => {
    const amplified = "AMPLIFIED-MARKER: include a regional forecast for the next quarter.";
    const p = prompt({ phase: "plan", brief_original: BRIEF, amplified_brief: amplified });
    expect(p).toContain("AMPLIFIED-MARKER");
    expect(count(p, "BRIEF-MARKER")).toBe(1);
  }, spawnBudgetMs(1));
});
