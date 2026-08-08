// delivery-pipeline.test.ts — the fail-closed delivery pipeline (Phase 4.2).
//
// DELIBERATE behavior changes pinned here (vs the pre-Phase-4 dispatch.ts,
// whose old exit-0-on-gate-fail behavior these tests replace):
//   - .html artifacts ARE gated now (rubricsForExt surface, not .md/.txt/.json)
//   - zero gateable artifacts → exit 3, NO gate_passed, NO delivered
//   - gate fail after revisions → exit 2, x_delivery_withheld, NO delivered
//   - --force-deliver escape → delivered with gate:"fail-forced", exit 0
//   - manifest verify honored via verify-deliverable.ts exit code (stub seam)
// Real quality-gate.ts spawns run over fixture artifacts (offline heuristics,
// deterministic); the revision LLM is an injected runHeadless seam.
// Runs with: bun test skills/harness/tests
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  runDelivery,
  gateableFiles,
  nonStubText,
  decideGateOutcome,
  type DeliveryArgs,
} from "../lib/delivery-pipeline.ts";
import { loadHarnessConfig } from "../lib/harness-config.ts";
import * as runLedger from "../lib/run-ledger.ts";

const GATE = path.join(import.meta.dir, "..", "scripts", "quality-gate.ts");

let tmp: string;
const savedLogsDir = process.env.HARNESS_LOGS_DIR;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-delivery-"));
  // Isolate every audit side effect (pipeline + spawned gate children).
  process.env.HARNESS_LOGS_DIR = path.join(tmp, "logs");
});
afterEach(() => {
  if (savedLogsDir === undefined) delete process.env.HARNESS_LOGS_DIR;
  else process.env.HARNESS_LOGS_DIR = savedLogsDir;
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
});

const PASSING_MD = [
  "# Relatório de entrega",
  "",
  "Este documento descreve a entrega final do projeto com clareza e sem enfeites.",
  "O conteúdo cobre o escopo combinado, os arquivos produzidos e as decisões que",
  "foram tomadas durante a execução, cada uma registrada com a sua justificativa.",
  "",
  "A verificação em disco confirmou todos os artefatos esperados. O time revisou",
  "os resultados e considerou a entrega pronta para uso imediato pelo cliente.",
  "",
].join("\n");

// wiki-lint hard-fails on spaced-hyphen clause stitching (severity 1.0, capped
// at 12 → score 0.4 < 0.7). Deterministic, offline.
const FAILING_MD = "# Nota\n\n" + "palavra - outra ".repeat(30) +
  "\n\nParágrafo final simples para dar corpo ao documento e passar de duzentos bytes com folga.\n";

const PASSING_HTML = [
  "<!doctype html>",
  "<html>",
  "<head><title>Entrega</title></head>",
  "<body>",
  "<main>",
  "<h1>Entrega final</h1>",
  "<p>Conteúdo da página com estrutura balanceada e tamanho suficiente para o gate.</p>",
  "<p>Segundo parágrafo para reforçar o corpo do documento HTML de teste.</p>",
  "</main>",
  "</body>",
  "</html>",
].join("\n");

type AuditCall = { event: string; payload: Record<string, any> };

function baseArgs(oroot: string, over: Partial<DeliveryArgs> = {}): { args: DeliveryArgs; calls: AuditCall[] } {
  const calls: AuditCall[] = [];
  const args: DeliveryArgs = {
    brief: "Produza a entrega de teste.",
    outputsRoot: oroot,
    pid: "proj-delivery-test",
    slug: "test-biz",
    targetKind: "business",
    runtime: "claude-code",
    projectDir: tmp,
    projectRoot: tmp,
    workingDir: tmp,
    maxRevisions: 0,
    config: loadHarnessConfig(path.join(tmp, "no-config.yaml")), // pure defaults, judge off
    audit: (event, payload) => calls.push({ event, payload }),
    gateScript: GATE,
    log: () => {}, warn: () => {},
    runHeadlessImpl: (() => { throw new Error("runHeadless must not be called in this test"); }) as any,
    ...over,
  };
  return { args, calls };
}

describe("gateableFiles — the Phase 4 gate surface", () => {
  test(".html and .yaml ARE gateable now (old nonStubText surface was .md/.txt/.json only)", () => {
    const dir = path.join(tmp, "surface");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "page.html"), PASSING_HTML);
    fs.writeFileSync(path.join(dir, "conf.yaml"), "key: value\n" + "# filler\n".repeat(30));
    fs.writeFileSync(path.join(dir, "bundle.zip"), Buffer.alloc(1024));
    const gated = gateableFiles(dir, new Set()).map(f => path.basename(f)).sort();
    expect(gated).toEqual(["conf.yaml", "page.html"]);
    // the legacy surface would have gated NOTHING here
    expect(nonStubText(dir, new Set())).toEqual([]);
  });

  test("decideGateOutcome semantics unchanged (empty list → indeterminate)", () => {
    expect(decideGateOutcome([], true)).toBe("indeterminate");
    expect(decideGateOutcome(["/tmp/a.md"], false)).toBe("fail");
  });
});

describe("runDelivery — outcomes", () => {
  test("html-only deliverable is GATED now and delivers on pass (exit 0)", () => {
    const oroot = path.join(tmp, "out-html");
    fs.mkdirSync(oroot);
    fs.writeFileSync(path.join(oroot, "page.html"), PASSING_HTML);
    const { args, calls } = baseArgs(oroot);
    const res = runDelivery(args);
    expect(res.exitCode).toBe(0);
    expect(res.delivered).toBe(true);
    expect(res.gateOutcome).toBe("pass");
    expect(res.gatedFiles.map(f => path.basename(f))).toEqual(["page.html"]);
    expect(calls.map(x => x.event)).toContain("verify_passed");
    expect(calls.map(x => x.event)).toContain("gate_passed");
    const delivered = calls.find(x => x.event === "delivered");
    expect(delivered?.payload.gate).toBe("pass");
  });

  test("zero gateable artifacts → exit 3, NO gate_passed, NO delivered", () => {
    const oroot = path.join(tmp, "out-zip");
    fs.mkdirSync(oroot);
    fs.writeFileSync(path.join(oroot, "bundle.zip"), Buffer.alloc(2048));
    const { args, calls } = baseArgs(oroot);
    const res = runDelivery(args);
    expect(res.exitCode).toBe(3);
    expect(res.delivered).toBe(false);
    expect(res.gateOutcome).toBe("indeterminate");
    const events = calls.map(x => x.event);
    expect(events).toContain("x_gate_skipped_no_files");
    expect(events).not.toContain("gate_passed");
    expect(events).not.toContain("delivered");
  });

  test("gate fail with revisions exhausted → exit 2, x_delivery_withheld, NO delivered", () => {
    const oroot = path.join(tmp, "out-fail");
    fs.mkdirSync(oroot);
    fs.writeFileSync(path.join(oroot, "nota.md"), FAILING_MD);
    const { args, calls } = baseArgs(oroot); // maxRevisions: 0 — no revision runs
    const res = runDelivery(args);
    expect(res.exitCode).toBe(2);
    expect(res.delivered).toBe(false);
    expect(res.gateOutcome).toBe("fail");
    const events = calls.map(x => x.event);
    expect(events).toContain("gate_failed");
    expect(events).toContain("x_delivery_withheld");
    expect(events).not.toContain("delivered");
  });

  test("--force-deliver escape → delivered with gate:'fail-forced', exit 0", () => {
    const oroot = path.join(tmp, "out-force");
    fs.mkdirSync(oroot);
    fs.writeFileSync(path.join(oroot, "nota.md"), FAILING_MD);
    const { args, calls } = baseArgs(oroot, { forceDeliver: true });
    const res = runDelivery(args);
    expect(res.exitCode).toBe(0);
    expect(res.delivered).toBe(true);
    expect(res.gateOutcome).toBe("fail-forced");
    const events = calls.map(x => x.event);
    expect(events).toContain("gate_failed"); // the failure stays on the record
    const delivered = calls.find(x => x.event === "delivered");
    expect(delivered?.payload.gate).toBe("fail-forced");
  });

  test("no deliverables at all → exit 1, verify_failed, gate never runs", () => {
    const oroot = path.join(tmp, "out-empty");
    fs.mkdirSync(oroot);
    const { args, calls } = baseArgs(oroot);
    const res = runDelivery(args);
    expect(res.exitCode).toBe(1);
    const events = calls.map(x => x.event);
    expect(events).toContain("verify_failed");
    expect(events).not.toContain("gate_passed");
    expect(events).not.toContain("delivered");
  });

  test("revision seam: a failing artifact fixed by the revision run passes on re-gate", () => {
    const oroot = path.join(tmp, "out-revise");
    fs.mkdirSync(oroot);
    const artifact = path.join(oroot, "nota.md");
    fs.writeFileSync(artifact, FAILING_MD);
    let revisions = 0;
    const { args, calls } = baseArgs(oroot, {
      maxRevisions: 1,
      runHeadlessImpl: ((opts: any) => {
        revisions++;
        expect(opts.prompt).toContain("quality gate reprovou");
        fs.writeFileSync(artifact, PASSING_MD); // the "agent" fixes the file
        return { ok: true, runtime: opts.runtime, sessionId: "sess-rev-1", result: "", costUsd: null, exitCode: 0, stderr: "", durationMs: 5 };
      }) as any,
    });
    const res = runDelivery(args);
    expect(revisions).toBe(1);
    expect(res.exitCode).toBe(0);
    expect(res.revisionsUsed).toBe(1);
    expect(res.sessionId).toBe("sess-rev-1");
    const events = calls.map(x => x.event);
    expect(events).toContain("revision_auto");
    const gp = calls.find(x => x.event === "gate_passed");
    expect(gp?.payload.revisions).toBe(1);
  });

  test("afterGate hook runs ONLY on deliverable outcomes and its zip lands in delivered", () => {
    const orootPass = path.join(tmp, "out-hook-pass");
    fs.mkdirSync(orootPass);
    fs.writeFileSync(path.join(orootPass, "page.html"), PASSING_HTML);
    let hookRuns = 0;
    const passCase = baseArgs(orootPass, { afterGate: () => { hookRuns++; return { zipPath: "/tmp/x.zip" }; } });
    const resPass = runDelivery(passCase.args);
    expect(hookRuns).toBe(1);
    expect(resPass.zipPath).toBe("/tmp/x.zip");
    expect(passCase.calls.find(x => x.event === "delivered")?.payload.zip).toBe("/tmp/x.zip");

    const orootFail = path.join(tmp, "out-hook-fail");
    fs.mkdirSync(orootFail);
    fs.writeFileSync(path.join(orootFail, "nota.md"), FAILING_MD);
    const failCase = baseArgs(orootFail, { afterGate: () => { hookRuns++; return {}; } });
    const resFail = runDelivery(failCase.args);
    expect(resFail.exitCode).toBe(2);
    expect(hookRuns).toBe(1); // hook did NOT run for the withheld delivery
  });
});

describe("runDelivery — manifest verify (stub verify-deliverable seam)", () => {
  function stubVerify(exitCode: number): string {
    const p = path.join(tmp, `stub-verify-${exitCode}.ts`);
    fs.writeFileSync(p, `process.exit(${exitCode});\n`);
    return p;
  }

  test("verify script exit 1 (FAIL) is honored: pipeline stops with exit 1, gate never runs", () => {
    const oroot = path.join(tmp, "out-mv-fail");
    fs.mkdirSync(oroot);
    fs.writeFileSync(path.join(oroot, "page.html"), PASSING_HTML); // artifacts exist, manifest disagrees
    const { args, calls } = baseArgs(oroot, { manifest: "paths.json", verifyScript: stubVerify(1) });
    const res = runDelivery(args);
    expect(res.exitCode).toBe(1);
    expect(res.verifySource).toBe("manifest");
    expect(calls.map(x => x.event)).not.toContain("gate_passed");
  });

  test("verify script exit 0 (PASS) proceeds to the gate with verifySource manifest", () => {
    const oroot = path.join(tmp, "out-mv-pass");
    fs.mkdirSync(oroot);
    fs.writeFileSync(path.join(oroot, "page.html"), PASSING_HTML);
    const { args } = baseArgs(oroot, { manifest: "paths.json", verifyScript: stubVerify(0) });
    const res = runDelivery(args);
    expect(res.exitCode).toBe(0);
    expect(res.verifySource).toBe("manifest");
  });

  test("verify script exit 2 (indeterminate) falls back to the output scan", () => {
    const oroot = path.join(tmp, "out-mv-ind");
    fs.mkdirSync(oroot);
    fs.writeFileSync(path.join(oroot, "page.html"), PASSING_HTML);
    const { args, calls } = baseArgs(oroot, { manifest: "paths.json", verifyScript: stubVerify(2) });
    const res = runDelivery(args);
    expect(res.exitCode).toBe(0);
    expect(res.verifySource).toBe("scan");
    expect(calls.map(x => x.event)).toContain("verify_passed"); // scan emitted it
  });

  test("no manifest → homegrown scan (verify-deliverable never spawned)", () => {
    const oroot = path.join(tmp, "out-mv-none");
    fs.mkdirSync(oroot);
    fs.writeFileSync(path.join(oroot, "page.html"), PASSING_HTML);
    const boom = path.join(tmp, "must-not-run.ts");
    fs.writeFileSync(boom, "process.exit(1);\n");
    const { args } = baseArgs(oroot, { manifest: null, verifyScript: boom });
    const res = runDelivery(args);
    expect(res.exitCode).toBe(0);
    expect(res.verifySource).toBe("scan");
  });
});

describe("runDelivery — ledger terminal states (never-stall guarantee)", () => {
  function openTestRun(): { handle: runLedger.LedgerHandle; runId: string } {
    const handle = runLedger.openLedger(path.join(tmp, "ledger.sqlite"));
    const row = runLedger.openRun(handle, { traceId: "t", projectId: "p", targetSlug: "test-biz", targetKind: "business", runtime: "claude-code" });
    runLedger.markState(handle, row.run_id, "running");
    return { handle, runId: row.run_id };
  }

  test("gate pass → ledger delivered (terminal)", () => {
    const oroot = path.join(tmp, "out-led-pass");
    fs.mkdirSync(oroot);
    fs.writeFileSync(path.join(oroot, "page.html"), PASSING_HTML);
    const led = openTestRun();
    const { args } = baseArgs(oroot, { ledger: led });
    const res = runDelivery(args);
    expect(res.exitCode).toBe(0);
    const row = runLedger.getRun(led.handle, led.runId)!;
    expect(row.state).toBe("delivered");
    expect(row.meta.gate).toBe("pass");
  });

  test("gate fail → ledger withheld (terminal), NOT delivered", () => {
    const oroot = path.join(tmp, "out-led-fail");
    fs.mkdirSync(oroot);
    fs.writeFileSync(path.join(oroot, "nota.md"), FAILING_MD);
    const led = openTestRun();
    const { args } = baseArgs(oroot, { ledger: led });
    const res = runDelivery(args);
    expect(res.exitCode).toBe(2);
    const row = runLedger.getRun(led.handle, led.runId)!;
    expect(row.state).toBe("withheld");
    expect(row.meta.gate).toBe("fail");
  });

  test("zero gateable → ledger withheld with gate:'indeterminate' (terminal, supervisor never re-dispatches)", () => {
    const oroot = path.join(tmp, "out-led-ind");
    fs.mkdirSync(oroot);
    fs.writeFileSync(path.join(oroot, "bundle.zip"), Buffer.alloc(2048));
    const led = openTestRun();
    const { args } = baseArgs(oroot, { ledger: led });
    const res = runDelivery(args);
    expect(res.exitCode).toBe(3);
    const row = runLedger.getRun(led.handle, led.runId)!;
    expect(row.state).toBe("withheld");
    expect(row.meta.gate).toBe("indeterminate");
  });
});
