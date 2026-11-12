// brief-work-folders.test.ts — the folder a brief places the work in survives
// the resume, the revision, the correction and the claims check (2026-10-14
// Camila incident).
//
// A resumed worker copied a whole website project into its deliverables,
// because the resume prompt asked for "the final files under the outputs root"
// and the claims check accepted evidence only there; the same check called an
// existing `_work/revisao.md` nonexistent.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runDelivery, type DeliveryArgs } from "../lib/delivery-pipeline.ts";
import { loadHarnessConfig, type HarnessConfig } from "../lib/harness-config.ts";
import { claimProblems, evidencePaths, evidenceVerdict } from "../lib/solo-review.ts";
import { briefWorkDirs, workElsewhereRule } from "../../_shared/lib/brief-work-dirs.ts";
import { CONTINUE_PROMPT } from "../scripts/supervisor.ts";
import { spawnBudgetMs } from "./helpers/test-budgets.ts";

const GATE = path.join(import.meta.dir, "..", "scripts", "quality-gate.ts");
/** The incident's message, verbatim (no personal data in it). */
const QUOTA = "You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at 1:21 AM.";
const judgeOff = (cfg: HarnessConfig): HarnessConfig => ({ ...cfg, quality_gate: { ...cfg.quality_gate, judge_enabled: false } });

let tmp: string;
const saved = { logs: process.env.HARNESS_LOGS_DIR, skills: process.env.NIRVANA_SKILLS_DIR };
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-incident-"));
  process.env.HARNESS_LOGS_DIR = path.join(tmp, "logs");
  process.env.NIRVANA_SKILLS_DIR = path.join(import.meta.dir, "..", "..");
});
afterEach(() => {
  if (saved.logs === undefined) delete process.env.HARNESS_LOGS_DIR; else process.env.HARNESS_LOGS_DIR = saved.logs;
  if (saved.skills === undefined) delete process.env.NIRVANA_SKILLS_DIR; else process.env.NIRVANA_SKILLS_DIR = saved.skills;
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
});

const PASSING_MD = [
  "# Relatório de entrega", "",
  "Este documento descreve a entrega final do projeto com clareza e sem enfeites.",
  "O conteúdo cobre o escopo combinado, os arquivos produzidos e as decisões que",
  "foram tomadas durante a execução, cada uma registrada com a sua justificativa.", "",
].join("\n");
const INVALID_JSON = '{"items": [' + '"valor", '.repeat(40);

type Call = { event: string; payload: Record<string, any> };
function baseArgs(oroot: string, over: Partial<DeliveryArgs> = {}): { args: DeliveryArgs; calls: Call[] } {
  const calls: Call[] = [];
  const args: DeliveryArgs = {
    brief: "Produza a entrega de teste.", outputsRoot: oroot, pid: "proj-incident", slug: "test-biz", targetKind: "business",
    runtime: "codex", projectDir: tmp, projectRoot: tmp, workingDir: tmp, maxRevisions: 0,
    config: judgeOff(loadHarnessConfig(path.join(tmp, "no-config.yaml"))),
    audit: (event, payload) => calls.push({ event, payload }), gateScript: GATE, log: () => {}, warn: () => {},
    runHeadlessImpl: (() => { throw new Error("no runtime may run here"); }) as any,
    claimsCheck: false,
    ...over,
  };
  return { args, calls };
}
function openTestRun(): { handle: runLedger.LedgerHandle; runId: string } {
  const handle = runLedger.openLedger(path.join(tmp, "ledger.sqlite"));
  const row = runLedger.openRun(handle, { traceId: "t", projectId: "p", targetSlug: "test-biz", targetKind: "business", runtime: "codex" });
  runLedger.markState(handle, row.run_id, "running");
  return { handle, runId: row.run_id };
}
const statusOf = (oroot: string) => JSON.parse(fs.readFileSync(path.join(oroot, "_STATUS.json"), "utf8"));
const write = (file: string, text: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };

describe("claims: evidence is honest about _work/ and accepts the brief's work folder", () => {
  const CRITERIA = [{ id: "d1", description: "o texto foi revisado", blocking: true }] as any;

  test("an existing _work/ file is refused as run state, never as nonexistent", () => {
    const oroot = path.join(tmp, "out");
    write(path.join(oroot, "_work", "revisao.md"), "notas");
    write(path.join(oroot, "_CLAIMS.json"), JSON.stringify([{ id: "d1", evidence: "_work/revisao.md:5-11, veredito da revisão" }]));
    expect(evidencePaths("_work/revisao.md:5-11, veredito")).toEqual(["_work/revisao.md"]);
    const [p] = claimProblems(oroot, CRITERIA);
    expect(p.why).toContain("run state");
    expect(p.why).not.toContain("names no file that exists");
  });

  test("a file in the folder the brief places the work in is accepted as evidence", () => {
    const oroot = path.join(tmp, "out");
    const proj = path.join(tmp, "proj");
    write(path.join(proj, "index.html"), "<html></html>");
    fs.mkdirSync(oroot, { recursive: true });
    const brief = `## Output\nO site fica em ${proj} (trabalhe nele, no lugar).\n`;
    const dirs = briefWorkDirs(brief, oroot, tmp);
    expect(dirs).toEqual([proj]);
    expect(evidenceVerdict(oroot, `${proj}/index.html:1-20, a página`, dirs).file).not.toBeNull();
    expect(evidenceVerdict(oroot, `${proj}/index.html:1-20, a página`, []).file).toBeNull();
    write(path.join(oroot, "_CLAIMS.json"), JSON.stringify([{ id: "d1", evidence: `${proj}/index.html:1-20, a página` }]));
    expect(claimProblems(oroot, CRITERIA, dirs)).toEqual([]);
  });

  test("the fix prompt keeps the brief's folder and never asks to move the work", () => {
    const oroot = path.join(tmp, "out");
    const proj = path.join(tmp, "proj");
    fs.mkdirSync(proj, { recursive: true });
    write(path.join(oroot, "dados.json"), INVALID_JSON);
    const prompts: string[] = [];
    const { args } = baseArgs(oroot, {
      brief: `Corrija o projeto em ${proj}.`, maxRevisions: 1,
      runHeadlessImpl: ((o: any) => { prompts.push(o.prompt); return { ok: true, runtime: o.runtime, sessionId: null, result: "", costUsd: null, exitCode: 0, stderr: "", durationMs: 1 }; }) as any,
    });
    runDelivery(args);
    expect(prompts[0]).toContain(workElsewhereRule(path.resolve(oroot), [proj]));
    expect(prompts[0]).toContain(proj);
  }, spawnBudgetMs(4));
});

describe("brief work folders and the resume prompt", () => {
  test("absolute folders only, not files, not the outputs root, not the engine's home or the user's home", () => {
    const home = path.join(tmp, "home");
    const proj = path.join(tmp, "site");
    const oroot = path.join(tmp, "outputs", "run");
    fs.mkdirSync(path.join(home, ".nirvana", "skills"), { recursive: true });
    fs.mkdirSync(proj, { recursive: true });
    fs.mkdirSync(oroot, { recursive: true });
    write(path.join(tmp, "input.pdf"), "x");
    const brief = [
      `Trabalhe em ${proj}.`, `Entrada: ${path.join(tmp, "input.pdf")}.`, `Saída: ${oroot}.`,
      `Skills: ${path.join(home, ".nirvana", "skills")}`, `Casa: ${home}`, `Novo: ${path.join(tmp, "novo-projeto")}`,
      "Veja https://chatgpt.com/settings/usage",
    ].join("\n");
    expect(briefWorkDirs(brief, oroot, home)).toEqual([proj, path.join(tmp, "novo-projeto")]);
  });

  test("the supervisor's resume prompt no longer sends the work to the outputs root", () => {
    expect(CONTINUE_PROMPT).not.toContain("under the outputs root of this project");
    expect(CONTINUE_PROMPT).toContain("never copied under the outputs root");
  });
});
