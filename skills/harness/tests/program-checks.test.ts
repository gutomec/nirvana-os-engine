// program-checks.test.ts — an acceptance criterion a program decides, and the
// seal of what was delivered. Real programs run under Bun on fixture folders;
// the correction is an injected runHeadless seam and the gate runs offline.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runDelivery, GATE_FINDINGS_FILE, type DeliveryArgs } from "../lib/delivery-pipeline.ts";
import { loadHarnessConfig, type HarnessConfig } from "../lib/harness-config.ts";
import {
  businessProgramChecks, readRunChecks, runProgramChecks, squadProgramChecks, writeRunChecks, type ProgramCheck,
} from "../lib/program-checks.ts";
import { briefInputFiles, checkSeal, readSeal, sealChangeLines, SEAL_FILE } from "../lib/delivery-seal.ts";
import { checkCommand, programChecksDirective } from "../lib/program-checks.ts";
import { AUTONOMOUS_DIRECTIVE } from "../lib/host-agent-driver.ts";
import { soloDirective } from "../lib/business-solo.ts";
import { spawnSync } from "node:child_process";
import { isRunStateFile } from "../../_shared/lib/run-plumbing.ts";
import { spawnBudgetMs } from "./helpers/test-budgets.ts";

const GATE = path.join(import.meta.dir, "..", "scripts", "quality-gate.ts");
const judgeOff = (cfg: HarnessConfig): HarnessConfig => ({ ...cfg, quality_gate: { ...cfg.quality_gate, judge_enabled: false } });

let tmp: string;
const saved = { logs: process.env.HARNESS_LOGS_DIR, skills: process.env.NIRVANA_SKILLS_DIR };
beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nrv-checks-")));
  process.env.HARNESS_LOGS_DIR = path.join(tmp, "logs");
  process.env.NIRVANA_SKILLS_DIR = path.join(import.meta.dir, "..", "..");
});
afterEach(() => {
  if (saved.logs === undefined) delete process.env.HARNESS_LOGS_DIR; else process.env.HARNESS_LOGS_DIR = saved.logs;
  if (saved.skills === undefined) delete process.env.NIRVANA_SKILLS_DIR; else process.env.NIRVANA_SKILLS_DIR = saved.skills;
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
});

const REPORT = [
  "# Fechamento do mês",
  "",
  "Este relatório apresenta o fechamento do período com os lançamentos conferidos.",
  "Cada linha do extrato foi pareada com o seu documento, e o total confere com o",
  "saldo informado pelo banco na data de corte combinada com o cliente.",
  "",
  "A conferência em disco confirmou os arquivos esperados e o resultado final.",
  "",
].join("\n");

/** A program that says the total in `total.txt` must be 100. */
const SUM_CHECK = `
import * as fs from "node:fs";
import * as path from "node:path";
const file = path.join(process.argv[2], "total.txt");
if (!fs.existsSync(file)) { console.log("total.txt is missing, so the total cannot be read"); process.exit(2); }
const total = Number(fs.readFileSync(file, "utf8").trim());
if (total !== 100) { console.log("total.txt says " + total + ", the lines add up to 100"); process.exit(1); }
`;

function program(name: string, body: string): string {
  const file = path.join(tmp, "squad", "scripts", name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return file;
}
const check = (over: Partial<ProgramCheck> & { run: string }): ProgramCheck => ({
  id: "totals_match", description: "the total equals the sum of the lines", blocking: true, args: ["{outputs}"], timeoutSec: 30, ...over,
});

type AuditCall = { event: string; payload: Record<string, any> };
function deliveryArgs(oroot: string, over: Partial<DeliveryArgs> = {}): { args: DeliveryArgs; calls: AuditCall[] } {
  const calls: AuditCall[] = [];
  const projectDir = path.join(tmp, "run");
  fs.mkdirSync(projectDir, { recursive: true });
  return { calls, args: {
    brief: "Feche o mês.", outputsRoot: oroot, pid: "proj-checks", slug: null, targetKind: "squad", runtime: "claude-code",
    projectDir, projectRoot: tmp, workingDir: tmp, maxRevisions: 2,
    config: judgeOff(loadHarnessConfig(path.join(tmp, "no-config.yaml"))),
    audit: (event, payload) => calls.push({ event, payload }),
    gateScript: GATE, log: () => {}, warn: () => {},
    runHeadlessImpl: (() => { throw new Error("no correction expected"); }) as any,
    ...over,
  } };
}
function outputs(total: string | null): string {
  const oroot = path.join(tmp, "out");
  fs.mkdirSync(oroot, { recursive: true });
  fs.writeFileSync(path.join(oroot, "relatorio.md"), REPORT);
  if (total !== null) fs.writeFileSync(path.join(oroot, "total.txt"), total);
  return oroot;
}
const statusOf = (oroot: string) => JSON.parse(fs.readFileSync(path.join(oroot, "_STATUS.json"), "utf8"));

describe("running a program check", () => {
  test("exit 0 passes, exit 1 fails with its lines, exit 2 is not measured", () => {
    const run = program("sum.ts", SUM_CHECK);
    const opts = { outputsRoot: outputs("100"), projectDir: tmp };
    expect(runProgramChecks([check({ run })], opts).map((r) => [r.state, r.lines])).toEqual([["pass", []]]);
    fs.writeFileSync(path.join(opts.outputsRoot, "total.txt"), "90");
    expect(runProgramChecks([check({ run })], opts)[0]).toMatchObject({ state: "fail", lines: ["total.txt says 90, the lines add up to 100"] });
    fs.rmSync(path.join(opts.outputsRoot, "total.txt"));
    expect(runProgramChecks([check({ run })], opts)[0]).toMatchObject({ state: "not_measured", lines: ["total.txt is missing, so the total cannot be read"] });
  }, spawnBudgetMs(3));

  test("a crash, a timeout, a missing program and an unknown language are not measured, never a pass", () => {
    const opts = { outputsRoot: outputs("100"), projectDir: tmp };
    const states = runProgramChecks([
      check({ id: "crash", run: program("crash.ts", "throw new Error('boom');") }),
      check({ id: "slow", run: program("slow.ts", "await new Promise((r) => setTimeout(r, 10000));"), timeoutSec: 1 }),
      check({ id: "gone", run: path.join(tmp, "squad", "scripts", "nothing.ts") }),
      check({ id: "ruby", run: program("check.rb", "exit 0") }),
    ], opts);
    expect(states.map((r) => [r.id, r.state])).toEqual([["crash", "not_measured"], ["slow", "not_measured"], ["gone", "not_measured"], ["ruby", "not_measured"]]);
    expect(states[1].lines[0]).toContain("did not finish in 1 s");
    expect(states[3].lines[0]).toContain("no interpreter");
  }, spawnBudgetMs(4));

  test("the program sees the outputs and the project folders, and exit 1 with nothing to fix reads as a crash", () => {
    const oroot = outputs("100");
    const run = program("env.ts", `
      import * as fs from "node:fs";
      if (process.env.NIRVANA_OUTPUTS_DIR !== process.argv[2] || !process.env.NIRVANA_PROJECT_DIR || process.cwd() !== fs.realpathSync(process.argv[2])) { console.log("wrong environment"); process.exit(2); }
      process.exit(1);`);
    const r = runProgramChecks([check({ run })], { outputsRoot: oroot, projectDir: tmp })[0];
    expect(r.state).toBe("not_measured");
    expect(r.lines[0]).toContain("named nothing to fix");
  }, spawnBudgetMs(2));
});

describe("several squads in one dispatch", () => {
  test("a check with a folder reads that squad's own outputs, not its neighbours'", () => {
    const oroot = path.join(tmp, "out");
    fs.mkdirSync(path.join(oroot, "one"), { recursive: true });
    fs.mkdirSync(path.join(oroot, "two"), { recursive: true });
    fs.writeFileSync(path.join(oroot, "one", "total.txt"), "100");
    fs.writeFileSync(path.join(oroot, "two", "total.txt"), "90");
    const run = program("sum.ts", SUM_CHECK);
    const r = runProgramChecks([check({ id: "one:totals", run, dir: "one" }), check({ id: "two:totals", run, dir: "two" })], { outputsRoot: oroot, projectDir: tmp });
    expect(r.map((x) => [x.id, x.state])).toEqual([["one:totals", "pass"], ["two:totals", "fail"]]);
  }, spawnBudgetMs(2));
});

describe("declaring a program check", () => {
  test("a squad capability's acceptance names it; a path outside the squad is ignored", () => {
    const squad = path.join(tmp, "squad");
    program("sum.ts", SUM_CHECK);
    fs.writeFileSync(path.join(squad, "squad.yaml"), [
      "name: closing", "capabilities:", "  - id: finance.month.close", "    acceptance:",
      "      - { id: totals_match, description: 'the total equals the sum', check: scripts/sum.ts }",
      "      - { id: advisory, description: 'rows are sorted', blocking: false, check: { run: scripts/sum.ts, args: ['{outputs}', '--sorted'], timeout_sec: 5 } }",
      "      - { id: prose, description: 'reads well' }",
      "      - { id: escape, description: 'outside', check: ../elsewhere.ts }",
    ].join("\n"));
    const checks = squadProgramChecks(squad, "finance.month.close");
    expect(checks.map((c) => [c.id, c.blocking, c.args, c.timeoutSec])).toEqual([
      ["totals_match", true, ["{outputs}"], 120], ["advisory", false, ["{outputs}", "--sorted"], 5],
    ]);
    expect(checks[0].run).toBe(path.join(squad, "scripts", "sum.ts"));
    expect(squadProgramChecks(squad, "finance.other")).toEqual([]);
    expect(squadProgramChecks(null, "x")).toEqual([]);
  });

  test("a business's employees declare them, one per id, and a run keeps its checks beside the brief", () => {
    const biz = path.join(tmp, "biz");
    fs.mkdirSync(path.join(biz, "employees"), { recursive: true });
    const fm = (id: string) => `---\nname: x\nacceptance:\n  - { id: ${id}, description: "the total equals the sum", check: scripts/sum.ts }\n---\n# Role\n`;
    fs.writeFileSync(path.join(biz, "employees", "a.md"), fm("totals_match"));
    fs.writeFileSync(path.join(biz, "employees", "b.md"), fm("totals_match"));
    fs.writeFileSync(path.join(biz, "employees", "c.md"), "no frontmatter");
    const checks = businessProgramChecks(biz);
    expect(checks.map((c) => c.id)).toEqual(["totals_match"]);
    const run = path.join(tmp, "run");
    writeRunChecks(run, checks);
    expect(readRunChecks(run)).toEqual(checks);
    expect(isRunStateFile("checks.json")).toBe(true);
    writeRunChecks(run, []);
    expect(readRunChecks(run)).toEqual([]);
  });
});

describe("the gate with program checks", () => {
  test("a failing blocking check sends its exact lines to the worker, and the delivery passes once the program does", () => {
    const oroot = outputs("90");
    const run = program("sum.ts", SUM_CHECK);
    let prompt = "";
    const { args, calls } = deliveryArgs(oroot, {
      programChecks: [check({ run })],
      runHeadlessImpl: ((opts: any) => {
        prompt = opts.prompt;
        fs.writeFileSync(path.join(oroot, "total.txt"), "100");
        return { ok: true, runtime: opts.runtime, sessionId: "s1", result: "", costUsd: null, exitCode: 0, stderr: "", durationMs: 5 };
      }) as any,
    });
    const res = runDelivery(args);
    expect(prompt).toContain("A program checked the deliverables");
    expect(prompt).toContain("total.txt says 90, the lines add up to 100");
    expect([res.state, res.exitCode, res.revisionsUsed]).toEqual(["delivered", 0, 1]);
    expect(res.checks!.map((c) => c.state)).toEqual(["pass"]);
    expect(statusOf(oroot).checks).toEqual([{ id: "totals_match", state: "pass", blocking: true }]);
    const rounds = calls.filter((c) => c.event === "x_program_checks").map((c) => [c.payload.round, c.payload.failed, c.payload.passed]);
    expect(rounds).toEqual([[0, ["totals_match"], []], [1, [], ["totals_match"]]]);
    const findings = fs.readFileSync(path.join(oroot, GATE_FINDINGS_FILE), "utf8");
    expect(findings).toContain("totals_match (blocking): FAIL");
    expect(findings).toContain("totals_match (blocking): pass");
  }, spawnBudgetMs(6));

  test("a blocking check that keeps failing withholds the delivery; an advisory one ships with reservations", () => {
    const run = program("sum.ts", SUM_CHECK);
    const noFix = ((opts: any) => ({ ok: true, runtime: opts.runtime, sessionId: "s", result: "", costUsd: null, exitCode: 0, stderr: "", durationMs: 5 })) as any;
    const blocked = runDelivery(deliveryArgs(outputs("90"), { programChecks: [check({ run })], runHeadlessImpl: noFix }).args);
    expect([blocked.state, blocked.exitCode]).toEqual(["withheld", 2]);
    expect(blocked.serious[0]).toContain("program check totals_match");
    const advisory = runDelivery(deliveryArgs(outputs("90"), { programChecks: [check({ run, blocking: false })], runHeadlessImpl: noFix }).args);
    expect([advisory.state, advisory.exitCode]).toEqual(["delivered_with_reservations", 0]);
  }, spawnBudgetMs(10));

  test("a blocking check that could not measure is never a pass: delivered with reservations, and it says which", () => {
    const oroot = outputs(null);
    const res = runDelivery(deliveryArgs(oroot, { programChecks: [check({ run: program("sum.ts", SUM_CHECK) })] }).args);
    expect([res.state, res.exitCode, res.revisionsUsed]).toEqual(["delivered_with_reservations", 0, 0]);
    expect(statusOf(oroot).checks).toEqual([{ id: "totals_match", state: "not_measured", blocking: true }]);
    const reservations = fs.readFileSync(path.join(oroot, "_QA-RESERVATIONS.md"), "utf8");
    expect(reservations).toContain("Not measured is not approved");
    expect(reservations).toContain("total.txt is missing");
  }, spawnBudgetMs(3));

  test("with no check declared the pipeline behaves as before, and reads the run's checks.json when given none", () => {
    const plain = runDelivery(deliveryArgs(outputs("90")).args);
    expect([plain.state, plain.checks]).toEqual(["delivered", undefined]);
    const { args } = deliveryArgs(outputs("100"));
    writeRunChecks(args.projectDir, [check({ run: program("sum.ts", SUM_CHECK) })]);
    expect(runDelivery(args).checks!.map((c) => c.state)).toEqual(["pass"]);
  }, spawnBudgetMs(4));
});

describe("the seal of a delivery", () => {
  test("a delivery records the hash of each deliverable, and an edit, a removal and a new file each show", () => {
    const oroot = outputs("100");
    const input = path.join(tmp, "extrato.csv");
    fs.writeFileSync(input, "data,valor\n2026-11-01,100\n");
    const { args, calls } = deliveryArgs(oroot, { brief: `Feche o mês a partir de ${input}.` });
    expect(runDelivery(args).state).toBe("delivered");
    const seal = readSeal(oroot)!;
    expect(seal.files.map((f) => f.path)).toEqual(["relatorio.md", "total.txt"]);
    expect(seal.inputs.map((f) => f.path)).toEqual([input]);
    expect(seal.gate).toBe("pass");
    expect(statusOf(oroot).sealed).toBe(true);
    expect(isRunStateFile(SEAL_FILE)).toBe(true);
    expect(calls.find((c) => c.event === "x_delivery_sealed")!.payload).toMatchObject({ files: 2, inputs: 1 });

    const now = () => [path.join(oroot, "relatorio.md"), path.join(oroot, "total.txt"), path.join(oroot, "novo.md")].filter((f) => fs.existsSync(f));
    expect(checkSeal(oroot, now())).toMatchObject({ sealed: true, intact: true, changed: [], staleInputs: [] });
    fs.appendFileSync(path.join(oroot, "relatorio.md"), "\nUma linha a mais.\n");
    fs.rmSync(path.join(oroot, "total.txt"));
    fs.writeFileSync(path.join(oroot, "novo.md"), REPORT);
    fs.appendFileSync(input, "2026-11-02,50\n");
    expect(checkSeal(oroot, now())).toMatchObject({ intact: false, changed: ["relatorio.md"], missing: ["total.txt"], added: ["novo.md"], staleInputs: [input] });
  }, spawnBudgetMs(3));

  test("a folder with no seal says so, and a withheld delivery is not sealed", () => {
    expect(checkSeal(path.join(tmp, "nowhere"))).toMatchObject({ sealed: false, intact: false });
    const oroot = outputs("90");
    const noFix = ((opts: any) => ({ ok: true, runtime: opts.runtime, sessionId: "s", result: "", costUsd: null, exitCode: 0, stderr: "", durationMs: 5 })) as any;
    runDelivery(deliveryArgs(oroot, { programChecks: [check({ run: program("sum.ts", SUM_CHECK) })], runHeadlessImpl: noFix }).args);
    expect(readSeal(oroot)).toBeNull();
  }, spawnBudgetMs(6));

  test("only files that exist outside the outputs root count as inputs of a brief", () => {
    const oroot = outputs("100");
    const input = path.join(tmp, "base.csv");
    fs.writeFileSync(input, "a\n");
    const brief = `Use ${input}, e não ${path.join(tmp, "inexistente.csv")}. Saída em ${path.join(oroot, "relatorio.md")}.`;
    expect(briefInputFiles(brief, oroot)).toEqual([input]);
  });
});

describe("what moved since the approval", () => {
  test("a worker that builds on a delivery is told which files and inputs changed; nothing is said when none did", () => {
    const oroot = outputs("100");
    const input = path.join(tmp, "extrato.csv");
    fs.writeFileSync(input, "a\n");
    runDelivery(deliveryArgs(oroot, { brief: `A partir de ${input}.` }).args);
    expect(sealChangeLines(oroot)).toEqual([]);
    expect(sealChangeLines(path.join(tmp, "unsealed"))).toEqual([]);
    fs.appendFileSync(path.join(oroot, "relatorio.md"), "\nEditado à mão.\n");
    fs.appendFileSync(input, "b\n");
    const lines = sealChangeLines(oroot).join("\n");
    expect(lines).toContain("edited after the approval: relatorio.md");
    expect(lines).toContain(`inputs the work was built from that changed since: ${input}`);
    expect(lines).toContain("without being asked");
  }, spawnBudgetMs(3));

  test("nrv seal check answers intact, then names what moved, and says so for a folder with no seal", () => {
    const oroot = outputs("100");
    runDelivery(deliveryArgs(oroot).args);
    const SEAL = path.join(import.meta.dir, "..", "scripts", "seal.ts");
    const run = (...a: string[]) => { const r = spawnSync(process.execPath, [SEAL, ...a], { encoding: "utf8" }); return { code: r.status, out: r.stdout + r.stderr }; };
    const intact = run("check", "--dir", oroot);
    expect([intact.code, intact.out.includes("Intact")]).toEqual([0, true]);
    fs.appendFileSync(path.join(oroot, "relatorio.md"), "\nMais uma linha.\n");
    const moved = run("check", "--dir", oroot);
    expect(moved.code).toBe(1);
    expect(moved.out).toContain("Edited after the approval (1)");
    expect(moved.out).toContain("nrv revise");
    expect(JSON.parse(run("check", "--dir", oroot, "--json").out)).toMatchObject({ ok: false, changed: ["relatorio.md"] });
    expect(run("check", "--dir", path.join(tmp, "empty")).out).toContain("No seal");
    expect(run("verify").code).toBe(4);
  }, spawnBudgetMs(8));
});

describe("what the worker is told", () => {
  test("the programs that will check it, with the command to run each", () => {
    const c = check({ run: path.join(tmp, "squad", "scripts", "sum.ts") });
    expect(programChecksDirective([], "/out")).toBe("");
    const text = programChecksDirective([c, check({ id: "py", blocking: false, run: path.join(tmp, "squad", "scripts", "x.py"), args: ["{outputs}", "--strict"] })], path.join(tmp, "out"));
    expect(text).toContain("PROGRAM CHECKS");
    expect(text).toContain("- totals_match (blocking): the total equals the sum of the lines");
    expect(text).toContain(checkCommand(c, path.join(tmp, "out")));
    expect(text).toContain(`python3 ${path.join(tmp, "squad", "scripts", "x.py")} ${path.join(tmp, "out")} --strict`);
  });

  test("every worker records the choices it made alone instead of asking, the solo worker of a business too", () => {
    for (const directive of [AUTONOMOUS_DIRECTIVE, soloDirective("")]) {
      expect(directive).toContain("_DECISIONS.md");
      expect(directive).toContain("it stands in for the question");
    }
    expect(isRunStateFile("_DECISIONS.md")).toBe(true);
  });

  test("a delivery whose worker recorded decisions names the file in its status", () => {
    const oroot = outputs("100");
    fs.writeFileSync(path.join(oroot, "_DECISIONS.md"), "- Chose a monthly cut; a weekly one was set aside: the statement is monthly.\n");
    runDelivery(deliveryArgs(oroot).args);
    expect(statusOf(oroot).decisions).toBe(path.join(oroot, "_DECISIONS.md"));
    expect(readSeal(oroot)!.files.map((f) => f.path)).not.toContain("_DECISIONS.md");
  }, spawnBudgetMs(3));
});
