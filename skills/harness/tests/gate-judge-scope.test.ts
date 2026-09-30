// gate-judge-scope.test.ts — where the LLM judge runs, by quality_gate.judge_enabled.
//
// "reports" (the default) sends the text deliverables (.md, .txt) to the judge
// and keeps the heuristic rubrics for code, images and data; "true" judges every
// gateable file; "false" none. And a report whose target produces research is
// judged by the research rubric, whose source check is a hard gate.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { REPORT_EXTS, runDelivery, type DeliveryArgs } from "../lib/delivery-pipeline.ts";
import { loadHarnessConfig, type HarnessConfig } from "../lib/harness-config.ts";
import { writeFakeCli } from "./helpers/fake-cli.ts";
import { spawnBudgetMs } from "./helpers/test-budgets.ts";

const R = fs.mkdtempSync(path.join(os.tmpdir(), "gate-scope-"));
const BIN = path.join(R, "bin");
const GATE_LOG = path.join(R, "gate-calls.jsonl");
const FAKE_GATE = path.join(R, "fake-gate.ts");
const REAL_PATH = process.env.PATH;

// A gate that records how it was called and passes: the unit here is the choice
// of judge or heuristics per file, not either rubric set.
fs.writeFileSync(FAKE_GATE, `
import * as fs from "node:fs";
const argv = Bun.argv.slice(2);
fs.appendFileSync(${JSON.stringify(GATE_LOG)}, JSON.stringify({ file: argv[0], judged: argv.includes("--with-revisions") }) + "\\n");
console.log(JSON.stringify({ status: "PASS", mode: "fake", results: [] }));
`, "utf8");
// A runtime on PATH, so the judge counts as available.
writeFakeCli(BIN, "claude", `console.log(JSON.stringify({ type: "result", result: "{}" }));`);

beforeAll(() => { process.env.PATH = `${BIN}${path.delimiter}${REAL_PATH}`; });
afterAll(() => { process.env.PATH = REAL_PATH; fs.rmSync(R, { recursive: true, force: true }); });
afterEach(() => { fs.rmSync(GATE_LOG, { force: true }); });

function outputs(name: string): string {
  const dir = path.join(R, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "report.md"), "# Relatório\n\n" + "Conteúdo do relatório com corpo suficiente para contar como entrega. ".repeat(8), "utf8");
  fs.writeFileSync(path.join(dir, "notes.txt"), "Notas da entrega com corpo suficiente para o gate. ".repeat(8), "utf8");
  fs.writeFileSync(path.join(dir, "app.ts"), "export const answer = 42;\n".repeat(20), "utf8");
  fs.writeFileSync(path.join(dir, "cover.png"), Buffer.alloc(4096, 1));
  return dir;
}

function judgedByFile(judgeEnabled: HarnessConfig["quality_gate"]["judge_enabled"], name: string): Record<string, boolean> {
  const oroot = outputs(name);
  const base = loadHarnessConfig(path.join(R, "no-config.yaml"));
  const args: DeliveryArgs = {
    brief: "Entregue o relatório.", outputsRoot: oroot, pid: `proj-${name}`, slug: "fixture-biz", targetKind: "business",
    runtime: "claude-code", projectDir: oroot, projectRoot: R, workingDir: R, maxRevisions: 0,
    config: { ...base, quality_gate: { ...base.quality_gate, judge_enabled: judgeEnabled } },
    audit: () => {}, gateScript: FAKE_GATE, log: () => {}, warn: () => {},
    runHeadlessImpl: (() => { throw new Error("no revision in this test"); }) as any,
  };
  runDelivery(args);
  const calls = fs.readFileSync(GATE_LOG, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  return Object.fromEntries(calls.map((c) => [path.basename(c.file), c.judged]));
}

describe("quality_gate.judge_enabled decides which files the judge takes", () => {
  test("reports: the text deliverables go to the judge, code and images keep their heuristics", () => {
    expect(judgedByFile("reports", "reports")).toEqual({ "report.md": true, "notes.txt": true, "app.ts": false, "cover.png": false });
    expect([...REPORT_EXTS].sort()).toEqual([".md", ".txt"]);
  }, spawnBudgetMs(4));

  test("true: every gateable file goes to the judge (the old `true`)", () => {
    expect(judgedByFile("true", "all")).toEqual({ "report.md": true, "notes.txt": true, "app.ts": true, "cover.png": true });
  }, spawnBudgetMs(4));

  test("false: heuristics only (the old `false`)", () => {
    expect(judgedByFile("false", "off")).toEqual({ "report.md": false, "notes.txt": false, "app.ts": false, "cover.png": false });
  }, spawnBudgetMs(4));
});

describe("a research report is judged by the research rubric", () => {
  const artifact = path.join(R, "market.md");
  const argvLog = path.join(R, "judge-argv.json");
  beforeAll(() => {
    fs.writeFileSync(artifact, "# Pesquisa de mercado\n\nO mercado cresceu no último ano.\n", "utf8");
    // The judge's persona (the rubric) rides the argv of `claude -p`.
    writeFakeCli(BIN, "claude", `
import * as fs from "node:fs";
fs.writeFileSync(${JSON.stringify(argvLog)}, JSON.stringify(Bun.argv.slice(2)));
await Bun.stdin.text();
console.log(JSON.stringify({ type: "result", result: JSON.stringify({ verdict: "fail", total_score: 10, criteria_scores: [], critique: [] }) }));
`);
  });

  function rubricSeen(produces: string | null): string {
    fs.rmSync(argvLog, { force: true });
    const argv = [path.join(import.meta.dir, "..", "scripts", "quality-gate.ts"), artifact, "--auto", "--with-revisions", ...(produces ? [`--produces=${produces}`] : [])];
    spawnSync(process.execPath, argv, { cwd: R, encoding: "utf8", env: { ...process.env, NIRVANA_HOST_RUNTIME: "claude-code" } });
    return fs.readFileSync(argvLog, "utf8");
  }

  test("produces market-research selects Data / Research, with its hard source gate", () => {
    const seen = rubricSeen("market-research");
    expect(seen).toContain("Data / Research");
    expect(seen).toContain("HARD GATE");
  }, spawnBudgetMs(2));

  test("no produces falls back to the rubric the extension implies", () => {
    expect(rubricSeen(null)).toContain("Prose — Longform");
  }, spawnBudgetMs(2));
});
