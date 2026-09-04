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
  deliverAfterRuntimeError,
  candidateArtifacts,
  gateableFiles,
  nonStubText,
  decideGateOutcome,
  producesForRubric,
  type DeliveryArgs,
  type RuntimeErrorOutcome,
} from "../lib/delivery-pipeline.ts";
import { loadHarnessConfig } from "../lib/harness-config.ts";
import * as runLedger from "../lib/run-ledger.ts";
import { SCOPE_GUARD_PT_BR } from "../../_shared/lib/scope-guard.ts";
import { spawnBudgetMs } from "./helpers/test-budgets.ts";

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

  // Reproduction of trace 70341260-ff80-4c9b-9dd4-6925a36c6b99 (27/08/2026): an
  // audit squad copied the entity it was auditing into its own outputs root as
  // `backup-before/`, and the pipeline sent all 276 files of that copy to the
  // gate — including the audited squad's README.*.md. Two revision rounds were
  // spent on prose nobody had written.
  test("a captured entity under the outputs root is NOT gated (backup-before)", () => {
    const oroot = path.join(tmp, "surface-backup");
    fs.mkdirSync(path.join(oroot, "backup-before", "agents"), { recursive: true });
    fs.mkdirSync(path.join(oroot, "backup-before", ".squad-state"), { recursive: true });
    // what the run actually wrote
    fs.writeFileSync(path.join(oroot, "changes.md"), PASSING_MD);
    // what the run only COPIED: a squad root, its prose, and its run state
    fs.writeFileSync(path.join(oroot, "backup-before", "squad.yaml"), "name: audited-squad\nversion: 1.0.0\n");
    fs.writeFileSync(path.join(oroot, "backup-before", "README.hi.md"), FAILING_MD);
    fs.writeFileSync(path.join(oroot, "backup-before", "agents", "writer.md"), FAILING_MD);
    fs.writeFileSync(path.join(oroot, "backup-before", ".squad-state", "runs.json"), JSON.stringify({ runs: [] }) + " ".repeat(300));

    const gated = gateableFiles(oroot, new Set()).map(f => path.relative(oroot, f)).sort();
    expect(gated).toEqual(["changes.md"]);
  });

  test("canonical run state under the outputs root is NOT gated (run-state.ts list)", () => {
    const oroot = path.join(tmp, "surface-runstate");
    fs.mkdirSync(path.join(oroot, ".squad-state"), { recursive: true });
    fs.mkdirSync(path.join(oroot, "projects", "old"), { recursive: true });
    fs.mkdirSync(path.join(oroot, "_internal"), { recursive: true });
    fs.writeFileSync(path.join(oroot, "relatorio.md"), PASSING_MD);
    fs.writeFileSync(path.join(oroot, "_SUMMARY.md"), PASSING_MD);
    fs.writeFileSync(path.join(oroot, ".squad-state", "state.md"), FAILING_MD);
    fs.writeFileSync(path.join(oroot, "projects", "old", "draft.md"), FAILING_MD);
    fs.writeFileSync(path.join(oroot, "_internal", "notes.md"), FAILING_MD);
    // `memory/projects` is run state; bare `memory/` is a business's permanent
    // knowledge, and run-state.ts documents what collapsing the two once cost.
    fs.mkdirSync(path.join(oroot, "memory", "projects"), { recursive: true });
    fs.writeFileSync(path.join(oroot, "memory", "permanent.md"), PASSING_MD);
    fs.writeFileSync(path.join(oroot, "memory", "projects", "old.md"), FAILING_MD);

    const gated = gateableFiles(oroot, new Set()).map(f => path.relative(oroot, f)).sort();
    // `_SUMMARY.md` is a FILE the run authored — the reserved prefix marks
    // directories, never the engine's own root-level handoff files.
    expect(gated).toEqual(["_SUMMARY.md", path.join("memory", "permanent.md"), "relatorio.md"]);
  });

  test("when the captured entity is ALL there is, it IS gated (never silence the only signal)", () => {
    const oroot = path.join(tmp, "surface-only-entity");
    fs.mkdirSync(path.join(oroot, "novo-squad", "agents"), { recursive: true });
    fs.writeFileSync(path.join(oroot, "novo-squad", "squad.yaml"), "name: novo-squad\nversion: 1.0.0\n");
    fs.writeFileSync(path.join(oroot, "novo-squad", "README.md"), PASSING_MD);
    fs.writeFileSync(path.join(oroot, "novo-squad", "agents", "writer.md"), PASSING_MD);

    const gated = gateableFiles(oroot, new Set()).map(f => path.relative(oroot, f)).sort();
    expect(gated).toEqual([path.join("novo-squad", "README.md"), path.join("novo-squad", "agents", "writer.md")]);
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
  }, spawnBudgetMs(2));

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
  }, spawnBudgetMs(2));

  test("gate fail with revisions exhausted → exit 2, x_delivery_withheld, NO delivered", () => {
    const oroot = path.join(tmp, "out-fail");
    fs.mkdirSync(oroot);
    fs.writeFileSync(path.join(oroot, "nota.md"), FAILING_MD);
    const { args, calls } = baseArgs(oroot, { gateExhaustedPolicy: "withhold" }); // maxRevisions: 0 — no revision runs; strict mode is the contract under test
    const res = runDelivery(args);
    expect(res.exitCode).toBe(2);
    expect(res.delivered).toBe(false);
    expect(res.gateOutcome).toBe("fail");
    const events = calls.map(x => x.event);
    expect(events).toContain("gate_failed");
    expect(events).toContain("x_delivery_withheld");
    expect(events).not.toContain("delivered");
  }, spawnBudgetMs(2));

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
  }, spawnBudgetMs(2));

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
  }, spawnBudgetMs(2));

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
        expect(opts.prompt).toContain(SCOPE_GUARD_PT_BR);
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
  }, spawnBudgetMs(2));

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
    const failCase = baseArgs(orootFail, { gateExhaustedPolicy: "withhold", afterGate: () => { hookRuns++; return {}; } });
    const resFail = runDelivery(failCase.args);
    expect(resFail.exitCode).toBe(2);
    expect(hookRuns).toBe(1); // hook did NOT run for the withheld delivery
  }, spawnBudgetMs(2));
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
  }, spawnBudgetMs(2));

  test("verify script exit 0 (PASS) proceeds to the gate with verifySource manifest", () => {
    const oroot = path.join(tmp, "out-mv-pass");
    fs.mkdirSync(oroot);
    fs.writeFileSync(path.join(oroot, "page.html"), PASSING_HTML);
    const { args } = baseArgs(oroot, { manifest: "paths.json", verifyScript: stubVerify(0) });
    const res = runDelivery(args);
    expect(res.exitCode).toBe(0);
    expect(res.verifySource).toBe("manifest");
  }, spawnBudgetMs(2));

  test("verify script exit 2 (indeterminate) falls back to the output scan", () => {
    const oroot = path.join(tmp, "out-mv-ind");
    fs.mkdirSync(oroot);
    fs.writeFileSync(path.join(oroot, "page.html"), PASSING_HTML);
    const { args, calls } = baseArgs(oroot, { manifest: "paths.json", verifyScript: stubVerify(2) });
    const res = runDelivery(args);
    expect(res.exitCode).toBe(0);
    expect(res.verifySource).toBe("scan");
    expect(calls.map(x => x.event)).toContain("verify_passed"); // scan emitted it
  }, spawnBudgetMs(2));

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
  }, spawnBudgetMs(2));
});

// ── completeness ceiling ─────────────────────────────────────────────────
// The gate judges QUALITY, never completeness: half a book can be excellent
// prose. A caller whose run was INTERRUPTED (supervisor salvage of a stalled
// row) passes completenessCeiling, and then `delivered` is reachable ONLY
// through a PASSING manifest verification.

const CEILING_REASON = "run was interrupted; the deliverable set is unproven";

describe("runDelivery — completenessCeiling", () => {
  function stubVerify(exitCode: number): string {
    const p = path.join(tmp, `ceil-verify-${exitCode}.ts`);
    fs.writeFileSync(p, `process.exit(${exitCode});\n`);
    return p;
  }

  test("ceiling + gate PASS + NO manifest → exit 2 withheld; reason visible in audit AND ledger; NO delivered", () => {
    const oroot = path.join(tmp, "out-ceil-nomanifest");
    fs.mkdirSync(oroot);
    fs.writeFileSync(path.join(oroot, "page.html"), PASSING_HTML);
    const led = openTestRun();
    const { args, calls } = baseArgs(oroot, { ledger: led, completenessCeiling: { reason: CEILING_REASON } });
    const res = runDelivery(args);

    expect(res.exitCode).toBe(2);
    expect(res.delivered).toBe(false);
    expect(res.gateOutcome).toBe("pass");          // the gate really did pass…
    expect(res.ceilingApplied).toBe(CEILING_REASON); // …the ceiling is what withheld it
    const events = calls.map(x => x.event);
    expect(events).toContain("gate_passed");        // the quality verdict is not hidden
    expect(events).toContain("x_delivery_withheld");
    expect(events).not.toContain("delivered");
    const withheld = calls.find(x => x.event === "x_delivery_withheld")!;
    expect(withheld.payload.ceiling).toBe("completeness");
    expect(withheld.payload.ceiling_reason).toBe(CEILING_REASON);
    expect(withheld.payload.gate).toBe("pass");
    const row = runLedger.getRun(led.handle, led.runId)!;
    expect(row.state).toBe("withheld");
    expect(row.meta.ceiling).toBe("completeness");
    expect(row.meta.ceiling_reason).toBe(CEILING_REASON);
  }, spawnBudgetMs(2));

  test("ceiling + gate PASS + manifest verify PASS → delivered (the ONE door to `delivered`)", () => {
    const oroot = path.join(tmp, "out-ceil-manifest");
    fs.mkdirSync(oroot);
    fs.writeFileSync(path.join(oroot, "page.html"), PASSING_HTML);
    const led = openTestRun();
    const { args, calls } = baseArgs(oroot, {
      ledger: led, completenessCeiling: { reason: CEILING_REASON },
      manifest: "paths.json", verifyScript: stubVerify(0),
    });
    const res = runDelivery(args);

    expect(res.exitCode).toBe(0);
    expect(res.delivered).toBe(true);
    expect(res.verifySource).toBe("manifest");
    expect(res.ceilingApplied).toBeNull();
    expect(calls.map(x => x.event)).toContain("delivered");
    expect(runLedger.getRun(led.handle, led.runId)!.state).toBe("delivered");
  }, spawnBudgetMs(2));

  test("ceiling + manifest INDETERMINATE (rc=2 → scan fallback) still caps at withheld", () => {
    const oroot = path.join(tmp, "out-ceil-ind-manifest");
    fs.mkdirSync(oroot);
    fs.writeFileSync(path.join(oroot, "page.html"), PASSING_HTML);
    const { args } = baseArgs(oroot, {
      completenessCeiling: { reason: CEILING_REASON },
      manifest: "paths.json", verifyScript: stubVerify(2),
    });
    const res = runDelivery(args);
    expect(res.verifySource).toBe("scan");   // the manifest proved nothing
    expect(res.exitCode).toBe(2);
    expect(res.ceilingApplied).toBe(CEILING_REASON);
  }, spawnBudgetMs(2));

  test("ceiling + gate FAIL → withheld for QUALITY; ceiling is not the binding reason", () => {
    const oroot = path.join(tmp, "out-ceil-gatefail");
    fs.mkdirSync(oroot);
    fs.writeFileSync(path.join(oroot, "nota.md"), FAILING_MD);
    const { args, calls } = baseArgs(oroot, { gateExhaustedPolicy: "withhold", completenessCeiling: { reason: CEILING_REASON } });
    const res = runDelivery(args);
    expect(res.exitCode).toBe(2);
    expect(res.gateOutcome).toBe("fail");
    expect(res.ceilingApplied).toBeNull();
    const withheld = calls.find(x => x.event === "x_delivery_withheld")!;
    expect(withheld.payload.gate).toBe("fail");
    expect(withheld.payload.ceiling).toBeNull();
  }, spawnBudgetMs(2));

  test("ceiling outranks --force-deliver (that flag overrides a QUALITY verdict, not completeness)", () => {
    const oroot = path.join(tmp, "out-ceil-force");
    fs.mkdirSync(oroot);
    fs.writeFileSync(path.join(oroot, "nota.md"), FAILING_MD);
    const { args, calls } = baseArgs(oroot, { forceDeliver: true, completenessCeiling: { reason: CEILING_REASON } });
    const res = runDelivery(args);
    expect(res.exitCode).toBe(2);
    expect(res.delivered).toBe(false);
    expect(res.ceilingApplied).toBe(CEILING_REASON);
    expect(calls.map(x => x.event)).not.toContain("delivered");
  }, spawnBudgetMs(2));

  test("no ceiling → behavior identical to before (gate pass delivers)", () => {
    const oroot = path.join(tmp, "out-ceil-absent");
    fs.mkdirSync(oroot);
    fs.writeFileSync(path.join(oroot, "page.html"), PASSING_HTML);
    const { args } = baseArgs(oroot);
    const res = runDelivery(args);
    expect(res.exitCode).toBe(0);
    expect(res.delivered).toBe(true);
    expect(res.ceilingApplied).toBeNull();
  }, spawnBudgetMs(2));
});

function openTestRun(): { handle: runLedger.LedgerHandle; runId: string } {
  const handle = runLedger.openLedger(path.join(tmp, "ledger.sqlite"));
  const row = runLedger.openRun(handle, { traceId: "t", projectId: "p", targetSlug: "test-biz", targetKind: "business", runtime: "claude-code" });
  runLedger.markState(handle, row.run_id, "running");
  return { handle, runId: row.run_id };
}

// ── runtime-error salvage ────────────────────────────────────────────────
// The real defect: a run whose runtime returned is_error AFTER writing the
// deliverables (usage limit at the end) was marked failed and its artifacts
// were abandoned — no verify, no gate, no delivered/withheld decision.

const RUNTIME_ERROR = "runtime returned an error verdict";

/** Mimics a dispatch call site with the RUNNER as the injected seam: run the
 * (fake) runtime, then apply the not-ok policy. */
function execThenDeliver(
  runner: () => { ok: boolean; error?: string },
  args: DeliveryArgs,
): { ranPipeline: boolean; exitCode: number; outcome: RuntimeErrorOutcome | null } {
  const r = runner();
  if (r.ok) {
    const res = runDelivery(args);
    return { ranPipeline: true, exitCode: res.exitCode, outcome: null };
  }
  const outcome = deliverAfterRuntimeError({
    ...args,
    runtimeError: r.error ?? RUNTIME_ERROR,
    errorContext: { employee: "intake" },
  });
  return { ranPipeline: outcome.judged, exitCode: outcome.exitCode, outcome };
}

describe("deliverAfterRuntimeError — a not-ok run with artifacts is still judged", () => {
  test("runner ok:false + artifacts that PASS → pipeline runs, delivered, exit 0; error visible in audit + ledger", () => {
    const oroot = path.join(tmp, "out-err-pass");
    fs.mkdirSync(oroot);
    const led = openTestRun();
    const { args, calls } = baseArgs(oroot, { ledger: led });
    // The runner writes real deliverables and THEN reports an error verdict —
    // the live failure mode (turn/usage limit hit at the end of the run).
    const runner = () => {
      fs.writeFileSync(path.join(oroot, "guia.md"), PASSING_MD);
      fs.writeFileSync(path.join(oroot, "guia.html"), PASSING_HTML);
      return { ok: false, error: RUNTIME_ERROR };
    };
    const out = execThenDeliver(runner, args);

    expect(out.ranPipeline).toBe(true);
    expect(out.exitCode).toBe(0);
    expect(out.outcome!.candidates).toBe(2);
    expect(out.outcome!.result!.delivered).toBe(true);

    const events = calls.map(x => x.event);
    expect(events).toContain("x_runtime_errored_with_artifacts");
    expect(events).toContain("verify_passed");
    expect(events).toContain("gate_passed");
    expect(events).toContain("delivered");
    // The runtime error is NOT swallowed: it rides in the x_ event…
    const errEvent = calls.find(x => x.event === "x_runtime_errored_with_artifacts")!;
    expect(errEvent.payload.error).toBe(RUNTIME_ERROR);
    expect(errEvent.payload.candidates).toBe(2);
    expect(errEvent.payload.employee).toBe("intake");
    // …and on the ledger row, all the way to the terminal state.
    const row = runLedger.getRun(led.handle, led.runId)!;
    expect(row.state).toBe("delivered");
    expect(row.last_error).toBe(RUNTIME_ERROR);
    expect(row.meta.runtime_errored).toBe(true);
  });

  test("runner ok:false with NO artifacts → nothing judged, exit 1, ledger failed (unchanged behavior)", () => {
    const oroot = path.join(tmp, "out-err-empty");
    fs.mkdirSync(oroot);
    const led = openTestRun();
    const { args, calls } = baseArgs(oroot, { ledger: led });
    const out = execThenDeliver(() => ({ ok: false, error: RUNTIME_ERROR }), args);

    expect(out.ranPipeline).toBe(false);
    expect(out.exitCode).toBe(1);
    expect(out.outcome!.candidates).toBe(0);
    expect(out.outcome!.result).toBeNull();
    const events = calls.map(x => x.event);
    expect(events).not.toContain("x_runtime_errored_with_artifacts");
    expect(events).not.toContain("verify_passed");
    expect(events).not.toContain("gate_passed");
    expect(events).not.toContain("delivered");
    const row = runLedger.getRun(led.handle, led.runId)!;
    expect(row.state).toBe("failed");
    expect(row.last_error).toBe(RUNTIME_ERROR);
  });

  test("fail-closed preserved: errored run whose artifacts FAIL the gate → exit 2, withheld, never delivered", () => {
    const oroot = path.join(tmp, "out-err-fail");
    fs.mkdirSync(oroot);
    const led = openTestRun();
    const { args, calls } = baseArgs(oroot, { ledger: led, gateExhaustedPolicy: "withhold" }); // maxRevisions: 0
    const runner = () => {
      fs.writeFileSync(path.join(oroot, "nota.md"), FAILING_MD);
      return { ok: false, error: RUNTIME_ERROR };
    };
    const out = execThenDeliver(runner, args);

    expect(out.ranPipeline).toBe(true);
    expect(out.exitCode).toBe(2);
    expect(out.outcome!.result!.delivered).toBe(false);
    const events = calls.map(x => x.event);
    expect(events).toContain("gate_failed");
    expect(events).toContain("x_delivery_withheld");
    expect(events).not.toContain("delivered");
    const row = runLedger.getRun(led.handle, led.runId)!;
    expect(row.state).toBe("withheld");
    expect(row.meta.gate).toBe("fail");
    expect(row.meta.runtime_errored).toBe(true);
    expect(row.last_error).toBe(RUNTIME_ERROR);
  });

  test("errored run with only non-gateable artifacts → exit 3 indeterminate, nothing delivered", () => {
    const oroot = path.join(tmp, "out-err-ind");
    fs.mkdirSync(oroot);
    const { args, calls } = baseArgs(oroot);
    const runner = () => {
      fs.writeFileSync(path.join(oroot, "bundle.zip"), Buffer.alloc(2048));
      return { ok: false, error: RUNTIME_ERROR };
    };
    const out = execThenDeliver(runner, args);
    expect(out.exitCode).toBe(3);
    expect(calls.map(x => x.event)).not.toContain("delivered");
  });

  test("candidateArtifacts reuses the pipeline's own discovery (stubs don't count)", () => {
    const oroot = path.join(tmp, "out-err-stub");
    fs.mkdirSync(oroot, { recursive: true });
    fs.mkdirSync(path.join(oroot, "assets"));
    fs.writeFileSync(path.join(oroot, "stub.md"), "oi\n");                        // < 200 bytes
    fs.writeFileSync(path.join(oroot, "assets", "hero.png"), Buffer.alloc(4096)); // nested, real
    expect(candidateArtifacts(oroot, "Produza a entrega.").map(f => path.basename(f))).toEqual(["hero.png"]);
    // …unless the brief named the small file explicitly.
    expect(candidateArtifacts(oroot, "escreva stub.md").map(f => path.basename(f)).sort()).toEqual(["hero.png", "stub.md"]);
  });
});

describe("runDelivery — ledger terminal states (never-stall guarantee)", () => {

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
  }, spawnBudgetMs(2));

  test("gate fail → ledger withheld (terminal), NOT delivered", () => {
    const oroot = path.join(tmp, "out-led-fail");
    fs.mkdirSync(oroot);
    fs.writeFileSync(path.join(oroot, "nota.md"), FAILING_MD);
    const led = openTestRun();
    const { args } = baseArgs(oroot, { ledger: led, gateExhaustedPolicy: "withhold" });
    const res = runDelivery(args);
    expect(res.exitCode).toBe(2);
    const row = runLedger.getRun(led.handle, led.runId)!;
    expect(row.state).toBe("withheld");
    expect(row.meta.gate).toBe("fail");
  }, spawnBudgetMs(2));

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
  }, spawnBudgetMs(2));
});

// ── gate retry ceiling → accepted with reservations (owner policy 2026-08-21) ─

describe("runDelivery — gate exhausted: accepted with reservations", () => {
  test("default policy delivers the last attempt, writes _QA-RESERVATIONS.md, emits the event", () => {
    const oroot = path.join(tmp, "out-reservations");
    fs.mkdirSync(oroot);
    fs.writeFileSync(path.join(oroot, "nota.md"), FAILING_MD);
    const { args, calls } = baseArgs(oroot); // no policy arg, no env → default "accept"
    const res = runDelivery(args);
    expect(res.exitCode).toBe(0);
    expect(res.delivered).toBe(true);
    expect(res.gateOutcome).toBe("fail-accepted");
    const note = fs.readFileSync(path.join(oroot, "_QA-RESERVATIONS.md"), "utf8");
    expect(note).toContain("retry ceiling");
    expect(note).toContain("nota.md");
    const events = calls.map(x => x.event);
    expect(events).toContain("x_delivered_with_reservations");
    expect(events).toContain("delivered");
    expect(events).not.toContain("x_delivery_withheld");
    expect(calls.find(x => x.event === "delivered")!.payload.gate).toBe("fail-accepted");
  }, spawnBudgetMs(2));

  test("a reservation the producer already wrote survives the gate's own", () => {
    const oroot = path.join(tmp, "out-reservations-merge");
    fs.mkdirSync(oroot);
    fs.writeFileSync(path.join(oroot, "nota.md"), FAILING_MD);
    // What a chain writes when a seat failed twice and the run went on without
    // it. Overwriting this told the reader the gate was unresolved and nothing
    // else — the missing seat vanished from the only file that mentioned it.
    fs.writeFileSync(path.join(oroot, "_QA-RESERVATIONS.md"), "# Lacunas da cadeia\n\n- **writer** não entregou (2 tentativas).");
    const { args } = baseArgs(oroot);
    runDelivery(args);
    const note = fs.readFileSync(path.join(oroot, "_QA-RESERVATIONS.md"), "utf8");
    expect(note).toContain("writer");
    expect(note).toContain("retry ceiling");
  }, spawnBudgetMs(2));

  test("the completeness ceiling outranks the acceptance (reservations never cover a missing deliverable)", () => {
    const oroot = path.join(tmp, "out-reservations-ceiling");
    fs.mkdirSync(oroot);
    fs.writeFileSync(path.join(oroot, "nota.md"), FAILING_MD);
    const { args } = baseArgs(oroot, { completenessCeiling: { reason: CEILING_REASON } });
    const res = runDelivery(args);
    expect(res.delivered).toBe(false);
    expect(res.exitCode).toBe(2);
    expect(res.ceilingApplied).toBe(CEILING_REASON);
  }, spawnBudgetMs(2));

  test("explicit withhold policy keeps the strict exit 2", () => {
    const oroot = path.join(tmp, "out-reservations-strict");
    fs.mkdirSync(oroot);
    fs.writeFileSync(path.join(oroot, "nota.md"), FAILING_MD);
    const { args, calls } = baseArgs(oroot, { gateExhaustedPolicy: "withhold" });
    const res = runDelivery(args);
    expect(res.exitCode).toBe(2);
    expect(res.delivered).toBe(false);
    expect(calls.map(x => x.event)).toContain("x_delivery_withheld");
  }, spawnBudgetMs(2));
});

describe("producesForRubric — delivery.produces_to_rubric", () => {
  test("off (the default) hands the judge [], which is what it received before v6", () => {
    expect(producesForRubric(["landing-page", "copy"], false)).toEqual([]);
    expect(producesForRubric(undefined, false)).toEqual([]);
  });

  test("on, the target's declaration reaches the rubric selector, trimmed and deduped", () => {
    expect(producesForRubric([" landing-page ", "copy", "landing-page", "", "  "], true)).toEqual(["landing-page", "copy"]);
    expect(producesForRubric(null, true)).toEqual([]);
  });
});
