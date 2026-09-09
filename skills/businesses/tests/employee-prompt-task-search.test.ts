// employee-prompt-task-search.test.ts — the clone search runs on the step's
// task, not on the whole chain brief.
//
// A chain brief carries the vocabulary of every seat. Fed with it, the search
// ranked the marketing and press voices for a seat whose job was closing the
// production macro. `nrv team step` now hands the seat its own task, and the
// search reads that. Same fixture shape as employee-clone-choice.test.ts.
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnBudgetMs } from "../../harness/tests/helpers/test-budgets.ts";

const R = mkdtempSync(join(tmpdir(), "seat-task-"));
afterAll(() => rmSync(R, { recursive: true, force: true }));
writeFileSync(join(R, ".env"), "NIRVANA_SCOPE=project\n", "utf8");
const biz = join(R, ".nirvana", "businesses", "studio-co");
mkdirSync(join(biz, "employees"), { recursive: true });
writeFileSync(join(biz, "business.yaml"), "name: studio-co\ndescription: a film studio\n", "utf8");
writeFileSync(join(biz, "employees", "producer.md"), "---\nrole: producer\n---\n# Producer\n\nRuns the schedule.\n", "utf8");

const clone = (slug: string, oneLiner: string, serves: string) => {
  const d = join(R, "dna", slug, "agent");
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "AGENT.md"), `# ${slug}\n\nMethod of ${slug}.\n`, "utf8");
  return { slug, display_name: slug, tags: [], dir: join(R, "dna", slug), persona_files: { agent: join(d, "AGENT.md") },
    match: { one_liner: oneLiner, domains: [], serves, when_to_use: null, not_for: null, delegates_to: [], refuses: [] } };
};
writeFileSync(join(R, ".nirvana", ".mind-clones-registry.json"), JSON.stringify({ mind_clones: {
  "akira-master": clone("akira-master", "the samurai epic director", "compor um épico de samurai na chuva com múltiplas câmeras e movimento de elenco"),
  "clinton-scheduler": clone("clinton-scheduler", "the production scheduler", "fechar o cronograma de produção com sprints, marcos e a planilha de macro"),
} }), "utf8");

// The chain brief is unmistakably the director's; the step's task is the scheduler's.
const briefFile = join(R, "brief.txt");
writeFileSync(briefFile, "compor um épico de samurai na chuva com múltiplas câmeras e movimento de elenco", "utf8");
const taskFile = join(R, "task.txt");
writeFileSync(taskFile, "fechar o cronograma de produção com sprints, marcos e a planilha de macro", "utf8");

const run = (extra: string[]) => `${spawnSync(process.execPath, [join(import.meta.dir, "..", "lib", "employee-prompt.ts"), "studio-co", "producer", R, briefFile, ...extra],
  { cwd: R, encoding: "utf8", env: { ...process.env, HARNESS_LOGS_DIR: join(R, ".nirvana", "logs", "harness") } }).stdout ?? ""}`;

describe("the clone search reads the step's task", () => {
  test("without a task, the brief's vocabulary picks the director", () => {
    expect(run([])).toContain("--- MIND-CLONE: akira-master");
  }, spawnBudgetMs(1));
  test("with --task-file, the seat's own job picks the scheduler", () => {
    const p = run(["--task-file", taskFile]);
    expect(p).toContain("--- MIND-CLONE: clinton-scheduler");
    expect(p).not.toContain("--- MIND-CLONE: akira-master");
  }, spawnBudgetMs(1));
});
