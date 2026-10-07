// gate-judge-batch.test.ts — the text deliverables of a round share ONE judge session.
//
// `judge_enabled: reports` used to spawn a full runtime session per .md/.txt/.html
// file: a software delivery with ten markdown documents paid ten sessions per
// gate round, and again on every correction. `quality-gate.ts --batch` hands the
// judge every file of the batch in one prompt and takes back one verdict per
// (file, rubric) pair, in the same verdict shape a single-file call prints, so
// findings and fix lists still name each file. An answer that does not parse
// sends its files to a call each; a judge that cannot be reached sends them to
// the heuristics. A fake `claude` CLI stands in for the runtime: no network.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { __internal__, ruleVerdict } from "../lib/judge.ts";
import { runDelivery, type DeliveryArgs } from "../lib/delivery-pipeline.ts";
import { loadHarnessConfig } from "../lib/harness-config.ts";
import { getRubric } from "../lib/rubric-selector.ts";
import { writeFakeCli } from "./helpers/fake-cli.ts";
import { spawnBudgetMs } from "./helpers/test-budgets.ts";

const R = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gate-batch-")));
const BIN = path.join(R, "bin");
const CALLS = path.join(R, "judge-calls.jsonl");
const MODE_FILE = path.join(R, "judge-mode.txt");
const GATE = path.join(import.meta.dir, "..", "scripts", "quality-gate.ts");
const REAL_PATH = process.env.PATH;
const savedHost = process.env.NIRVANA_HOST_RUNTIME;
const savedSkills = process.env.NIRVANA_SKILLS_DIR;

// The fake judge. A batched prompt ("## Files to evaluate") is answered per the
// mode file: "ok" verdicts for every listed pair, the file named "bad.md" with a
// material defect; "garbage" with no JSON at all. A single-file prompt always
// gets a passing verdict. Every call is logged with its kind.
writeFakeCli(BIN, "claude", `
import * as fs from "node:fs";
const input = await Bun.stdin.text();
const mode = fs.existsSync(${JSON.stringify(MODE_FILE)}) ? fs.readFileSync(${JSON.stringify(MODE_FILE)}, "utf8").trim() : "ok";
const batch = input.includes("## Files to evaluate");
fs.appendFileSync(${JSON.stringify(CALLS)}, JSON.stringify({ batch, chars: input.length }) + "\\n");
const say = (result) => console.log(JSON.stringify({ type: "result", result, total_cost_usd: 0 }));
if (!batch) { say(JSON.stringify({ verdict: "pass", total_score: 90, criteria_scores: [], critique: [] })); process.exit(0); }
if (mode === "garbage") { say("I could not grade these files."); process.exit(0); }
const files = [...input.matchAll(/^### File (F\\d+): (\\S+) \\(rubrics: ([^)]+)\\)$/gm)];
const verdicts = files.flatMap(([, id, label, rubrics]) => rubrics.split(", ").map((rubric) => label.endsWith("bad.md")
  ? { file: id, rubric, verdict: "pass", total_score: 88, criteria_scores: [], critique: [{ id: "c1", severity: "high", issue: "the table of costs is invented", suggested_fix: "cite the source of each cost" }] }
  : { file: id, rubric, verdict: "pass", total_score: 90, criteria_scores: [], critique: [] }));
say(JSON.stringify({ verdicts }));
`);

beforeAll(() => {
  process.env.PATH = `${BIN}${path.delimiter}${REAL_PATH}`;
  process.env.NIRVANA_HOST_RUNTIME = "claude-code";
  process.env.NIRVANA_SKILLS_DIR = path.join(import.meta.dir, "..", "..");
});
afterAll(() => {
  process.env.PATH = REAL_PATH;
  if (savedHost === undefined) delete process.env.NIRVANA_HOST_RUNTIME; else process.env.NIRVANA_HOST_RUNTIME = savedHost;
  if (savedSkills === undefined) delete process.env.NIRVANA_SKILLS_DIR; else process.env.NIRVANA_SKILLS_DIR = savedSkills;
  fs.rmSync(R, { recursive: true, force: true });
});
afterEach(() => { fs.rmSync(CALLS, { force: true }); fs.rmSync(MODE_FILE, { force: true }); });

const calls = (): Array<{ batch: boolean }> => (fs.existsSync(CALLS) ? fs.readFileSync(CALLS, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);

const MD = "# Documento\n\n" + "Conteúdo do documento com corpo suficiente para contar como entrega e passar no gate. ".repeat(6);
const HTML = "<!doctype html><html><head><title>Página</title></head><body><main><h1>Página</h1>" + "<p>Conteúdo da página.</p>".repeat(12) + "</main></body></html>";

function delivery(name: string): string {
  const dir = path.join(R, name);
  fs.mkdirSync(path.join(dir, "docs"), { recursive: true });
  fs.writeFileSync(path.join(dir, "docs", "plan.md"), MD, "utf8");
  fs.writeFileSync(path.join(dir, "docs", "bad.md"), MD, "utf8");
  fs.writeFileSync(path.join(dir, "index.html"), HTML, "utf8");
  return dir;
}

function gateBatch(files: string[]): { status: number | null; out: any } {
  const r = spawnSync(process.execPath, [GATE, "--batch", "--auto", "--with-revisions", ...files], { cwd: R, encoding: "utf8", env: process.env });
  let out: any = null;
  try { out = JSON.parse(r.stdout); } catch { out = null; }
  return { status: r.status, out };
}

describe("quality-gate.ts --batch", () => {
  test("one judge session grades every file, each with its own verdict; HTML keeps its design rubric", () => {
    const dir = delivery("one-session");
    const files = [path.join(dir, "docs", "plan.md"), path.join(dir, "docs", "bad.md"), path.join(dir, "index.html")];
    const { status, out } = gateBatch(files);
    expect(status).toBe(0);
    expect(calls()).toEqual([expect.objectContaining({ batch: true })]);
    expect(out.mode).toBe("batch");
    expect(out.unjudged).toEqual([]);
    const plan = out.verdicts[files[0]];
    expect(plan).toMatchObject({ status: "PASS", mode: "judge", rubric: "prose_longform" });
    // The rule decides, not the model: a high item fails the file whatever it said.
    const bad = out.verdicts[files[1]];
    expect(bad.status).toBe("FAIL");
    expect(bad.results[0]).toMatchObject({ name: "prose_longform", passed: false, material: true, fix_list: ["cite the source of each cost"] });
    const page = out.verdicts[files[2]];
    expect(page.mode).toBe("judge");
    expect(page.results.map((r: any) => r.name)).toEqual(["prose_longform", "design", "html-valid", "html-layout", "secret-leak"]);
  }, spawnBudgetMs(2));

  test("an answer that does not parse leaves every file unjudged, for a call each", () => {
    const dir = delivery("garbage");
    fs.writeFileSync(MODE_FILE, "garbage");
    const files = [path.join(dir, "docs", "plan.md"), path.join(dir, "docs", "bad.md")];
    const { status, out } = gateBatch(files);
    expect(status).toBe(0);
    expect(out.unjudged.sort()).toEqual([...files].sort());
    expect(out.verdicts).toEqual({});
  }, spawnBudgetMs(2));
});

describe("the delivery pipeline judges a round's text deliverables in one session", () => {
  function deliver(name: string): { res: ReturnType<typeof runDelivery>; warned: string[]; dir: string } {
    const dir = delivery(name);
    const base = loadHarnessConfig(path.join(R, "no-config.yaml"));
    const warned: string[] = [];
    const args: DeliveryArgs = {
      brief: "Entregue o plano e a página.", outputsRoot: dir, pid: `proj-${name}`, slug: null, targetKind: "squad",
      runtime: "claude-code", projectDir: dir, projectRoot: R, workingDir: R, maxRevisions: 0,
      config: { ...base, quality_gate: { ...base.quality_gate, judge_enabled: "reports" } },
      audit: () => {}, gateScript: GATE, log: () => {}, warn: (l) => warned.push(l),
      runHeadlessImpl: (() => { throw new Error("no correction in this test"); }) as any,
    };
    return { res: runDelivery(args), warned, dir };
  }

  test("three text files, one judge session; the material defect is serious and names its file", () => {
    const { res, dir } = deliver("pipeline-batch");
    expect(calls().filter((c) => c.batch)).toHaveLength(1);
    expect(calls().filter((c) => !c.batch)).toHaveLength(0);
    expect(res.state).toBe("withheld");
    expect(res.serious).toEqual([`${path.join("docs", "bad.md")}: the judge reports a material defect`]);
    const findings = fs.readFileSync(path.join(dir, "_GATE-FINDINGS.md"), "utf8");
    expect(findings).toContain("**SERIOUS** `docs/bad.md` · `prose_longform`: [high] the table of costs is invented");
  }, spawnBudgetMs(5));

  test("a batch whose answer does not parse falls back to one call per file", () => {
    fs.writeFileSync(MODE_FILE, "garbage");
    const { res } = deliver("pipeline-fallback");
    expect(calls().filter((c) => c.batch)).toHaveLength(1);
    expect(calls().filter((c) => !c.batch)).toHaveLength(4); // plan.md, bad.md, index.html twice (content + design)
    expect(res.state).toBe("delivered");
  }, spawnBudgetMs(8));
});

describe("parseBatchAnswer", () => {
  const prose = getRubric("prose_longform")!;
  const design = getRubric("design")!;
  const items = [
    { id: "F1", label: "a.md", artifact: "a", rubrics: [prose] },
    { id: "F2", label: "b.html", artifact: "b", rubrics: [prose, design] },
  ];

  test("keeps the listed pairs that pass the schema, drops the rest, and applies the rule per rubric", () => {
    const answer = JSON.stringify({ verdicts: [
      { file: "F1", rubric: "prose_longform", verdict: "pass", total_score: prose.pass_threshold - 1, criteria_scores: [], critique: [] },
      { file: "F2", rubric: "design", verdict: "fail", total_score: 95, criteria_scores: [], critique: [] },
      { file: "F2", rubric: "juridical", verdict: "pass", total_score: 95, criteria_scores: [], critique: [] },
      { file: "F9", rubric: "prose_longform", verdict: "pass", total_score: 95, criteria_scores: [], critique: [] },
      { file: "F2", rubric: "prose_longform", verdict: "pass", total_score: 500, criteria_scores: [], critique: [] },
    ] });
    const parsed = __internal__.parseBatchAnswer(answer, items)!;
    expect([...parsed.keys()]).toEqual(["F1", "F2"]);
    expect(parsed.get("F1")!.get("prose_longform")!.verdict).toBe("fail"); // below threshold
    expect(parsed.get("F2")!.get("design")!.verdict).toBe("pass");         // the model said fail; nothing material, score above
    expect(parsed.get("F2")!.has("prose_longform")).toBe(false);           // out of range: schema fails
    expect(ruleVerdict({ total_score: 95, critique: [] }, design.pass_threshold)).toBe("pass");
  });

  test("an answer with no usable entry is no answer", () => {
    expect(__internal__.parseBatchAnswer("not json", items)).toBeNull();
    expect(__internal__.parseBatchAnswer(JSON.stringify({ verdicts: [{ file: "F7" }] }), items)).toBeNull();
  });

  test("the batched prompt carries every file whole, each rubric once, and lists every pair", () => {
    const persona = __internal__.buildBatchPersona([prose, design]);
    expect(persona.match(/RUBRIC "prose_longform"/g)).toHaveLength(1);
    expect(persona).toContain(`RUBRIC "design"`);
    const user = __internal__.buildBatchUserMessage({ items, brief: "O briefing." });
    expect(user).toContain("O briefing.");
    expect(user).toContain("### File F2: b.html (rubrics: prose_longform, design)");
    expect(user).toContain('- file "F2", rubric "design"');
    expect(user).toContain("<<<F1\na\nF1>>>");
  });
});
