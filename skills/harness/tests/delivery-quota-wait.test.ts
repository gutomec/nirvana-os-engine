// delivery-quota-wait.test.ts — a spent quota pauses a delivery, whichever
// step meets it (2026-10-14 Camila incident).
//
// A Codex worker stopped on "You’ve hit your usage limit … try again at 1:21
// AM". The pipeline judged the half-written delivery, ran two "corrections"
// that met the same limit within 16 seconds, called that no progress and
// withheld it; the judge was on the same dead runtime and the gate fell back
// to heuristics. No model is called here: runtimes are injected seams, the
// gate is the real quality-gate.ts in heuristic mode or a stub script.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runDelivery, deliverAfterRuntimeError, runGateOnce, QUOTA_WAIT_EXIT, type DeliveryArgs } from "../lib/delivery-pipeline.ts";
import { loadHarnessConfig, type HarnessConfig } from "../lib/harness-config.ts";
import * as runLedger from "../lib/run-ledger.ts";
import { judgeQuotaOf } from "../scripts/quality-gate.ts";
import { getCooldown } from "../lib/cooldown-registry.ts";
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

describe("a worker stopped on a spent quota waits for the reset", () => {
  test("no gate, no judge, no correction; ledger failed with the reset; _STATUS names it; exit 75", () => {
    const oroot = path.join(tmp, "out");
    write(path.join(oroot, "index.md"), PASSING_MD);
    const led = openTestRun();
    let runs = 0;
    const { args, calls } = baseArgs(oroot, { ledger: led, maxRevisions: 2, runHeadlessImpl: (() => { runs++; throw new Error("no correction may run"); }) as any });
    const out = deliverAfterRuntimeError({ ...args, runtimeError: QUOTA });
    expect(out.exitCode).toBe(QUOTA_WAIT_EXIT);
    expect(out.judged).toBe(false);
    expect(out.result?.state).toBe("quota_wait");
    expect(out.result?.quotaWait?.named).toBe(true);
    expect(runs).toBe(0);
    const events = calls.map(c => c.event);
    for (const e of ["verify_passed", "gate_passed", "gate_failed", "revision_auto", "x_runtime_errored_with_artifacts", "x_delivery_withheld", "delivered"]) expect(events).not.toContain(e);
    expect(events).toContain("x_delivery_quota_wait");
    const row = runLedger.getRun(led.handle, led.runId)!;
    expect(row.state).toBe("failed");
    expect(row.meta.stop_reason).toBe("quota");
    const reset = Date.parse(String(row.meta.quota_reset_at));
    expect(reset).toBeGreaterThan(Date.now());
    expect(new Date(reset).getMinutes()).toBe(21);
    const status = statusOf(oroot);
    expect(status).toMatchObject({ state: "quota_wait", gate: "skipped", exit_code: 75, quota_step: "worker" });
    expect(status.quota_reset_at).toBe(row.meta.quota_reset_at);
    // The runtime is cooled down until the reset.
    expect(getCooldown(tmp, "codex")).not.toBeNull();
    // What the worker wrote stays on disk for the resume.
    expect(fs.existsSync(path.join(oroot, "index.md"))).toBe(true);
  }, spawnBudgetMs(1));

  test("a generic runtime error still goes through the gate, as before", () => {
    const oroot = path.join(tmp, "out");
    write(path.join(oroot, "index.md"), PASSING_MD);
    const { args, calls } = baseArgs(oroot);
    const out = deliverAfterRuntimeError({ ...args, runtimeError: "timed out after 30 min" });
    expect(out.judged).toBe(true);
    expect(calls.map(c => c.event)).toContain("x_runtime_errored_with_artifacts");
  }, spawnBudgetMs(2));
});

describe("a correction whose runtime failed is not a round", () => {
  const failing = (error: string) => (opts: any) => ({ ok: false, runtime: opts.runtime, sessionId: null, result: "", costUsd: null, exitCode: 1, stderr: "", durationMs: 1, error });

  test("a quota on the correction: no cold retry, no no-progress, not counted, the delivery waits", () => {
    const oroot = path.join(tmp, "out");
    write(path.join(oroot, "dados.json"), INVALID_JSON);
    const led = openTestRun();
    let runs = 0;
    const { args, calls } = baseArgs(oroot, { ledger: led, maxRevisions: 1, sessionId: "sess-1", runHeadlessImpl: ((o: any) => { runs++; return failing(QUOTA)(o); }) as any });
    const res = runDelivery(args);
    expect(runs).toBe(1);                         // no cold retry against the same limit
    expect(res.exitCode).toBe(QUOTA_WAIT_EXIT);
    expect(res.state).toBe("quota_wait");
    expect(res.revisionsUsed).toBe(0);
    expect(res.quotaWait?.step).toBe("correction");
    const auto = calls.filter(c => c.event === "revision_auto");
    expect(auto).toHaveLength(1);
    expect(auto[0].payload).toMatchObject({ ok: false, counted: false, runtime_failure: "quota_exhausted" });
    expect(calls.some(c => c.event === "x_delivery_withheld")).toBe(false);
    expect(calls.some(c => c.payload?.no_progress)).toBe(false);
    expect(runLedger.getRun(led.handle, led.runId)!.meta.stop_reason).toBe("quota");
    expect(statusOf(oroot).state).toBe("quota_wait");
  }, spawnBudgetMs(3));

  test("a transport failure on the correction ends the corrections without counting a round or no-progress", () => {
    const oroot = path.join(tmp, "out");
    write(path.join(oroot, "dados.json"), INVALID_JSON);
    let runs = 0;
    const { args, calls } = baseArgs(oroot, { maxRevisions: 1, runHeadlessImpl: ((o: any) => { runs++; return failing("stream disconnected before completion: error sending request")(o); }) as any });
    const res = runDelivery(args);
    expect(runs).toBe(1);
    expect(res.revisionsUsed).toBe(0);
    expect(res.state).toBe("withheld");           // the serious finding of the real round 0 stands
    expect(calls.find(c => c.event === "revision_auto")?.payload).toMatchObject({ counted: false, runtime_failure: "transport" });
    expect(calls.find(c => c.event === "x_delivery_withheld")?.payload.no_progress).toBeUndefined();
  }, spawnBudgetMs(3));
});

describe("a judge on a spent quota says it could not judge", () => {
  /** A gate that answers like quality-gate.ts does when the judge's runtime is out of quota. */
  function quotaGate(): string {
    const file = path.join(tmp, "quota-gate.ts");
    fs.writeFileSync(file, `console.log(JSON.stringify({ status: "INDETERMINATE", mode: "unjudged", results: [], judge_unavailable: { reason: "quota", reset_at: ${JSON.stringify(new Date(Date.now() + 3600_000).toISOString())}, hint: "Codex usage limit" } })); process.exit(3);\n`);
    return file;
  }

  test("runGateOnce stops at the first unjudged file and reports the quota", () => {
    const f = path.join(tmp, "a.md");
    write(f, PASSING_MD);
    const run = runGateOnce([f, f], { gateScript: quotaGate(), offline: true });
    expect(run.judgeQuota?.hint).toBe("Codex usage limit");
    expect(run.pass).toBe(false);
    expect(run.fails).toHaveLength(0);
  }, spawnBudgetMs(1));

  test("the pipeline emits no gate verdict, no heuristic stand-in, and waits", () => {
    const oroot = path.join(tmp, "out");
    write(path.join(oroot, "index.md"), PASSING_MD);
    const { args, calls } = baseArgs(oroot, { gateScript: quotaGate(), maxRevisions: 2 });
    const res = runDelivery(args);
    expect(res.exitCode).toBe(QUOTA_WAIT_EXIT);
    expect(res.quotaWait?.step).toBe("judge");
    const events = calls.map(c => c.event);
    expect(events).toContain("x_gate_unjudged_quota");
    for (const e of ["gate_passed", "gate_failed", "revision_auto", "delivered", "x_delivery_withheld"]) expect(events).not.toContain(e);
    expect(statusOf(oroot)).toMatchObject({ state: "quota_wait", quota_step: "judge" });
  }, spawnBudgetMs(2));

  test("quality-gate reads a quota out of the judge's failed call", () => {
    expect(judgeQuotaOf(`codex exited 1: ${QUOTA}`)).toMatchObject({ reason: "quota" });
    expect(judgeQuotaOf("schema mismatch")).toBeNull();
  });
});
