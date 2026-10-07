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
  runGateOnce,
  planJudgeBatches,
  findingKey,
  sameSeriousFindings,
  shortLine,
  GATE_FINDINGS_FILE,
  type DeliveryArgs,
  type RuntimeErrorOutcome,
} from "../lib/delivery-pipeline.ts";
import { loadHarnessConfig, type HarnessConfig } from "../lib/harness-config.ts";
// The judge runs by default on report deliverables; these tests pin the
// heuristic gate, whatever runtime the machine has on PATH.
const judgeOff = (cfg: HarnessConfig): HarnessConfig => ({ ...cfg, quality_gate: { ...cfg.quality_gate, judge_enabled: false } });
import * as runLedger from "../lib/run-ledger.ts";
import { soloDirective } from "../lib/business-solo.ts";
import { parseAuditLine } from "../../_shared/lib/cloudevents.js";
import { SCOPE_GUARD_EN } from "../../_shared/lib/scope-guard.ts";
import { spawnBudgetMs } from "./helpers/test-budgets.ts";
import { isRunStateFile } from "../../_shared/lib/run-plumbing.ts";
import { JUDGE_BATCH_FILE_MAX_CHARS, JUDGE_BATCH_MAX_CHARS } from "../lib/judge.ts";

const GATE = path.join(import.meta.dir, "..", "scripts", "quality-gate.ts");

let tmp: string;
const savedLogsDir = process.env.HARNESS_LOGS_DIR;
const savedSkillsDir = process.env.NIRVANA_SKILLS_DIR;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-delivery-"));
  // Isolate every audit side effect (pipeline + spawned gate children).
  process.env.HARNESS_LOGS_DIR = path.join(tmp, "logs");
  // The gate loads its rubrics from this checkout, never from an install.
  process.env.NIRVANA_SKILLS_DIR = path.join(import.meta.dir, "..", "..");
});
afterEach(() => {
  if (savedLogsDir === undefined) delete process.env.HARNESS_LOGS_DIR;
  else process.env.HARNESS_LOGS_DIR = savedLogsDir;
  if (savedSkillsDir === undefined) delete process.env.NIRVANA_SKILLS_DIR;
  else process.env.NIRVANA_SKILLS_DIR = savedSkillsDir;
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
    config: judgeOff(loadHarnessConfig(path.join(tmp, "no-config.yaml"))), // defaults with the judge off: these pin the heuristic gate
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
    fs.writeFileSync(path.join(oroot, "_CLAIMS.json"), JSON.stringify([{ id: "d1", evidence: "relatorio.md:1-9, the whole report" }]) + " ".repeat(300));
    fs.writeFileSync(path.join(oroot, ".squad-state", "state.md"), FAILING_MD);
    fs.writeFileSync(path.join(oroot, "projects", "old", "draft.md"), FAILING_MD);
    fs.writeFileSync(path.join(oroot, "_internal", "notes.md"), FAILING_MD);
    // `memory/projects` is run state; bare `memory/` is a business's permanent
    // knowledge, and run-state.ts documents what collapsing the two once cost.
    fs.mkdirSync(path.join(oroot, "memory", "projects"), { recursive: true });
    fs.writeFileSync(path.join(oroot, "memory", "permanent.md"), PASSING_MD);
    fs.writeFileSync(path.join(oroot, "memory", "projects", "old.md"), FAILING_MD);

    const gated = gateableFiles(oroot, new Set()).map(f => path.relative(oroot, f)).sort();
    // `_SUMMARY.md` and `_CLAIMS.json` are the worker talking about its work
    // (run-plumbing.ts isRunStateFile): the gate judges the work itself.
    expect(gated).toEqual([path.join("memory", "permanent.md"), "relatorio.md"]);
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
        expect(opts.prompt).toContain("quality gate rejected");
        expect(opts.prompt).toContain(SCOPE_GUARD_EN);
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

  test("a session that does not resume is retried cold, once, with the brief, full paths and the producer's role", () => {
    const oroot = path.join(tmp, "out-cold");
    fs.mkdirSync(oroot);
    const artifact = path.join(oroot, "nota.md");
    fs.writeFileSync(artifact, FAILING_MD);
    const seen: any[] = [];
    const { args, calls } = baseArgs(oroot, {
      maxRevisions: 1,
      sessionId: "sess-expired",
      targetKind: "squad",
      producerRole: "squad",
      runHeadlessImpl: ((opts: any) => {
        seen.push(opts);
        if (opts.sessionId) {
          return { ok: false, runtime: opts.runtime, sessionId: null, result: "", costUsd: null, exitCode: 1, stderr: "No conversation found", durationMs: 5, error: "No conversation found" };
        }
        fs.writeFileSync(artifact, PASSING_MD);
        return { ok: true, runtime: opts.runtime, sessionId: "sess-cold-1", result: "", costUsd: null, exitCode: 0, stderr: "", durationMs: 5 };
      }) as any,
    });
    const res = runDelivery(args);
    expect(seen).toHaveLength(2);
    expect(seen[0].sessionId).toBe("sess-expired");
    expect(seen[1].sessionId).toBeUndefined();
    // The resumed round had the conversation; the cold one gets what it lacked.
    expect(seen[0].prompt).not.toContain("Produza a entrega de teste.");
    expect(seen[1].prompt).toContain("Produza a entrega de teste.");
    for (const call of seen) {
      expect(call.prompt).toContain(path.resolve(artifact));
      expect(call.prompt).toContain(path.resolve(oroot));
      expect(call.dispatchRole).toBe("squad");
    }
    expect(res.exitCode).toBe(0);
    expect(res.sessionId).toBe("sess-cold-1");
    expect(calls.find(x => x.event === "revision_auto")?.payload.cold_retry).toBe(true);
  }, spawnBudgetMs(2));

  test("no producer role, no stamp: the revision carries what the producer carried", () => {
    const oroot = path.join(tmp, "out-norole");
    fs.mkdirSync(oroot);
    const artifact = path.join(oroot, "nota.md");
    fs.writeFileSync(artifact, FAILING_MD);
    const seen: any[] = [];
    const { args } = baseArgs(oroot, {
      maxRevisions: 1,
      runHeadlessImpl: ((opts: any) => {
        seen.push(opts);
        fs.writeFileSync(artifact, PASSING_MD);
        return { ok: true, runtime: opts.runtime, sessionId: "sess-1", result: "", costUsd: null, exitCode: 0, stderr: "", durationMs: 5 };
      }) as any,
    });
    runDelivery(args);
    expect(seen).toHaveLength(1);
    expect("dispatchRole" in seen[0]).toBe(false);
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
  test("off hands the judge [], and the judge infers the rubric from the extension", () => {
    expect(producesForRubric(["landing-page", "copy"], false)).toEqual([]);
    expect(producesForRubric(undefined, false)).toEqual([]);
  });

  test("on, the target's declaration reaches the rubric selector, trimmed and deduped", () => {
    expect(producesForRubric([" landing-page ", "copy", "landing-page", "", "  "], true)).toEqual(["landing-page", "copy"]);
    expect(producesForRubric(null, true)).toEqual([]);
  });
});

// ── owner rule A: serious findings, reservations, _STATUS.json ───────────
// A serious finding (a leaked secret, an invalid file, a material defect, an
// unproven blocking criterion) keeps being corrected past the normal limit,
// up to SERIOUS_EXTRA_ROUNDS more rounds, and is WITHHELD if it stays; any
// other failure ships with reservations. Every outcome lands in _STATUS.json.

// Unparseable: json-valid fails, which is serious.
const INVALID_JSON = '{"items": [' + '"valor", '.repeat(40);
const VALID_JSON = JSON.stringify({ items: Array.from({ length: 30 }, (_, i) => `item ${i}`) });

function statusOf(oroot: string): Record<string, any> {
  return JSON.parse(fs.readFileSync(path.join(oroot, "_STATUS.json"), "utf8"));
}

function auditLines(): any[] {
  const day = new Date().toISOString().slice(0, 10);
  const file = path.join(tmp, "logs", day, "audit.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(l => { try { return parseAuditLine(l); } catch { return {}; } });
}

const WORK_BRIEF = [
  "## Request (verbatim)", "Quero uma página de entrega.", "",
  "## Decisions", "None.", "",
  "## Your part", "A página.", "",
  "## Inputs", "None.", "",
  "## Done when",
  "- A página existe e abre no navegador (bloqueante)",
  "  - um detalhe aninhado que não é critério",
  "- Tem um título claro",
  "", "## Output", "page.html", "",
].join("\n");

describe("runDelivery — _STATUS.json and the state field", () => {
  test("a pass: state delivered, gate pass, exit 0", () => {
    const oroot = path.join(tmp, "st-pass");
    fs.mkdirSync(oroot);
    fs.writeFileSync(path.join(oroot, "page.html"), PASSING_HTML);
    const res = runDelivery(baseArgs(oroot).args);
    expect(res.state).toBe("delivered");
    expect(statusOf(oroot)).toEqual({ state: "delivered", gate: "pass", serious: [], reservations: null, exit_code: 0 });
  }, spawnBudgetMs(2));

  test("only run state under the outputs root is NOT a delivery: exit 1, state failed, gate skipped", () => {
    const oroot = path.join(tmp, "st-only-state");
    fs.mkdirSync(path.join(oroot, "_work"), { recursive: true });
    fs.writeFileSync(path.join(oroot, "_SUMMARY.md"), PASSING_MD);
    fs.writeFileSync(path.join(oroot, "_CLAIMS.json"), JSON.stringify([{ id: "d1", evidence: "x" }]) + " ".repeat(300));
    fs.writeFileSync(path.join(oroot, "_work", "PROGRESS.md"), PASSING_MD);
    const { args, calls } = baseArgs(oroot);
    const res = runDelivery(args);
    expect(res.exitCode).toBe(1);
    expect(res.state).toBe("failed");
    expect(res.produced).toEqual([]);
    expect(calls.find(x => x.event === "verify_failed")?.payload.reason).toBe("only run state");
    expect(statusOf(oroot)).toMatchObject({ state: "failed", gate: "skipped", exit_code: 1 });
  }, spawnBudgetMs(1));

  test("nothing gateable: state indeterminate, gate skipped, exit 3", () => {
    const oroot = path.join(tmp, "st-ind");
    fs.mkdirSync(oroot);
    fs.writeFileSync(path.join(oroot, "bundle.zip"), Buffer.alloc(2048));
    const res = runDelivery(baseArgs(oroot).args);
    expect(res.state).toBe("indeterminate");
    expect(statusOf(oroot)).toMatchObject({ state: "indeterminate", gate: "skipped", exit_code: 3 });
  }, spawnBudgetMs(1));

  test("a style failure after the corrections: delivered WITH RESERVATIONS, exit 0, the note named in _STATUS.json", () => {
    const oroot = path.join(tmp, "st-reservations");
    fs.mkdirSync(oroot);
    fs.writeFileSync(path.join(oroot, "nota.md"), FAILING_MD);
    const res = runDelivery(baseArgs(oroot).args);
    expect(res.exitCode).toBe(0);
    expect(res.state).toBe("delivered_with_reservations");
    expect(res.serious).toEqual([]);
    const status = statusOf(oroot);
    expect(status.state).toBe("delivered_with_reservations");
    expect(status.gate).toBe("fail");
    expect(status.reservations).toBe(path.join(oroot, "_QA-RESERVATIONS.md"));
    // No environment knob decides this any more: the rule is the owner's.
    expect(fs.readFileSync(status.reservations, "utf8")).not.toContain("NIRVANA_GATE_EXHAUSTED");
  }, spawnBudgetMs(2));
});

const okRun = (opts: any) => ({ ok: true, runtime: opts.runtime, sessionId: null, result: "", costUsd: null, exitCode: 0, stderr: "", durationMs: 1 });

describe("runDelivery — a serious finding (rule A)", () => {
  test("serious findings that change every round keep being corrected past max_revisions, 3 more rounds, then are WITHHELD", () => {
    const oroot = path.join(tmp, "se-json");
    fs.mkdirSync(oroot);
    const a = path.join(oroot, "a.json");
    const b = path.join(oroot, "b.json");
    fs.writeFileSync(a, INVALID_JSON);
    fs.writeFileSync(b, VALID_JSON);
    let runs = 0;
    const warned: string[] = [];
    // Each correction fixes the broken file and breaks the other: progress every
    // round, never a pass.
    const { args, calls } = baseArgs(oroot, {
      maxRevisions: 1, warn: (l: string) => warned.push(l),
      runHeadlessImpl: ((opts: any) => {
        runs++;
        const broken = runs % 2 === 1 ? b : a;
        fs.writeFileSync(broken === a ? b : a, VALID_JSON);
        fs.writeFileSync(broken, INVALID_JSON);
        return okRun(opts);
      }) as any,
    });
    const res = runDelivery(args);
    expect(runs).toBe(4);                      // 1 normal round + 3 for the serious finding
    expect(res.revisionsUsed).toBe(4);
    expect(res.exitCode).toBe(2);
    expect(res.state).toBe("withheld");
    expect(res.delivered).toBe(false);
    expect(res.serious).toEqual(["a.json: json-valid failed"]);
    const events = calls.map(x => x.event);
    expect(events).not.toContain("delivered");
    expect(calls.find(x => x.event === "x_delivery_withheld")?.payload.serious).toEqual(["a.json: json-valid failed"]);
    expect(calls.find(x => x.event === "x_delivery_withheld")?.payload.no_progress).toBeUndefined();
    expect(statusOf(oroot)).toEqual({ state: "withheld", gate: "fail", serious: ["a.json: json-valid failed"], reservations: null, exit_code: 2 });
    // Where the 4 comes from, on the line itself, and each serious finding under it.
    const counter = warned.filter(l => l.includes("auto-revision"));
    expect(counter).toHaveLength(4);
    expect(counter[0]).toContain("auto-revision 1/4 (max_revisions 1 + 3 for serious findings; 1 serious finding(s))");
    expect(counter[3]).toContain("auto-revision 4/4");
    const firstFinding = warned[warned.indexOf(counter[0]) + 1];
    expect(firstFinding).toStartWith("    ! a.json: json-valid failed");
    expect(firstFinding.length).toBeLessThanOrEqual(4 + 2 + 160);
  }, spawnBudgetMs(10));

  test("a correction that leaves the same serious finding ends the extra rounds: no progress, WITHHELD", () => {
    const oroot = path.join(tmp, "se-stuck");
    fs.mkdirSync(oroot);
    fs.writeFileSync(path.join(oroot, "dados.json"), INVALID_JSON);
    let runs = 0;
    const warned: string[] = [];
    const { args, calls } = baseArgs(oroot, {
      maxRevisions: 1, warn: (l: string) => warned.push(l),
      runHeadlessImpl: ((opts: any) => { runs++; return okRun(opts); }) as any,
    });
    const res = runDelivery(args);
    expect(runs).toBe(1);                      // the normal round runs; no extra round follows it
    expect(res.revisionsUsed).toBe(1);
    expect(res.state).toBe("withheld");
    expect(res.serious).toEqual(["dados.json: json-valid failed"]);
    expect(calls.find(x => x.event === "x_delivery_withheld")?.payload.no_progress).toBe(true);
    expect(warned.some(l => l.includes("no progress"))).toBe(true);
    expect(fs.readFileSync(path.join(oroot, GATE_FINDINGS_FILE), "utf8")).toContain("No progress: round 1 carries the same serious findings as round 0");
  }, spawnBudgetMs(4));

  test("no progress is caught in the middle of the extra rounds too", () => {
    const oroot = path.join(tmp, "se-stuck-later");
    fs.mkdirSync(oroot);
    const a = path.join(oroot, "a.json");
    const b = path.join(oroot, "b.json");
    fs.writeFileSync(a, INVALID_JSON);
    fs.writeFileSync(b, VALID_JSON);
    let runs = 0;
    const { args } = baseArgs(oroot, {
      maxRevisions: 1,
      // The first correction moves the defect to b.json; the next ones change nothing.
      runHeadlessImpl: ((opts: any) => { runs++; if (runs === 1) { fs.writeFileSync(a, VALID_JSON); fs.writeFileSync(b, INVALID_JSON); } return okRun(opts); }) as any,
    });
    const res = runDelivery(args);
    expect(runs).toBe(2);                      // round 2 made no progress over round 1: round 3 never runs
    expect(res.state).toBe("withheld");
    expect(res.serious).toEqual(["b.json: json-valid failed"]);
  }, spawnBudgetMs(5));

  test("the normal rounds always run, whatever they change", () => {
    const oroot = path.join(tmp, "se-normal");
    fs.mkdirSync(oroot);
    fs.writeFileSync(path.join(oroot, "dados.json"), INVALID_JSON);
    let runs = 0;
    const { args } = baseArgs(oroot, { maxRevisions: 2, runHeadlessImpl: ((opts: any) => { runs++; return okRun(opts); }) as any });
    runDelivery(args);
    expect(runs).toBe(2);                      // max_revisions is the user's: both run; the extra rounds do not
  }, spawnBudgetMs(5));

  test("a serious finding the correction fixes falls back to the normal outcome", () => {
    const oroot = path.join(tmp, "se-fixed");
    fs.mkdirSync(oroot);
    const file = path.join(oroot, "dados.json");
    fs.writeFileSync(file, INVALID_JSON);
    const { args } = baseArgs(oroot, {
      maxRevisions: 1,
      runHeadlessImpl: ((opts: any) => { fs.writeFileSync(file, VALID_JSON); return { ok: true, runtime: opts.runtime, sessionId: null, result: "", costUsd: null, exitCode: 0, stderr: "", durationMs: 1 }; }) as any,
    });
    const res = runDelivery(args);
    expect(res.revisionsUsed).toBe(1);
    expect(res.state).toBe("delivered");
  }, spawnBudgetMs(3));

  test("--force-deliver overrides a quality verdict, never a serious finding", () => {
    const oroot = path.join(tmp, "se-force");
    fs.mkdirSync(oroot);
    fs.writeFileSync(path.join(oroot, "dados.json"), INVALID_JSON);
    const { args, calls } = baseArgs(oroot, { forceDeliver: true });
    const res = runDelivery(args);
    expect(res.exitCode).toBe(2);
    expect(calls.map(x => x.event)).not.toContain("delivered");
  }, spawnBudgetMs(2));

  test("maxRevisions 0 (an unattended caller) runs no correction at all, serious or not", () => {
    const oroot = path.join(tmp, "se-zero");
    fs.mkdirSync(oroot);
    fs.writeFileSync(path.join(oroot, "dados.json"), INVALID_JSON);
    const res = runDelivery(baseArgs(oroot).args); // runHeadless throws if called
    expect(res.revisionsUsed).toBe(0);
    expect(res.state).toBe("withheld");
  }, spawnBudgetMs(2));

  test("a leaked secret is serious, and the run's own value is what the gate looks for", () => {
    const oroot = path.join(tmp, "se-secret");
    fs.mkdirSync(oroot);
    const saved = process.env.NRV_TEST_PIPELINE_API_KEY;
    process.env.NRV_TEST_PIPELINE_API_KEY = "nrv-fixture-9f3c2a7d1e";
    try {
      fs.writeFileSync(path.join(oroot, "nota.md"), PASSING_MD + "\nA chave usada foi nrv-fixture-9f3c2a7d1e.\n");
      const res = runDelivery(baseArgs(oroot).args);
      expect(res.state).toBe("withheld");
      expect(res.serious).toEqual(["nota.md: secret-leak failed"]);
    } finally {
      if (saved === undefined) delete process.env.NRV_TEST_PIPELINE_API_KEY; else process.env.NRV_TEST_PIPELINE_API_KEY = saved;
    }
  }, spawnBudgetMs(2));

  test("a blocking criterion the solo review left unconfirmed withholds even a passing gate", () => {
    const oroot = path.join(tmp, "se-review");
    fs.mkdirSync(oroot);
    fs.writeFileSync(path.join(oroot, "page.html"), PASSING_HTML);
    const { args, calls } = baseArgs(oroot, { reviewBlockingMissed: ["d1"] });
    const res = runDelivery(args);
    expect(res.gateOutcome).toBe("pass");
    expect(res.state).toBe("withheld");
    expect(calls.map(x => x.event)).toContain("gate_passed");
    expect(calls.map(x => x.event)).not.toContain("delivered");
    expect(statusOf(oroot)).toMatchObject({ gate: "pass", serious: ["review: blocking criterion d1 was not confirmed"] });
  }, spawnBudgetMs(2));
});

describe("runDelivery — the claims check of a business delivery", () => {
  function claimsCase(name: string, claims: unknown | null, extra: Partial<DeliveryArgs> = {}) {
    const oroot = path.join(tmp, name);
    fs.mkdirSync(path.join(oroot, "site"), { recursive: true });
    fs.writeFileSync(path.join(oroot, "site", "page.html"), PASSING_HTML);
    if (claims !== null) fs.writeFileSync(path.join(oroot, "_CLAIMS.json"), JSON.stringify(claims));
    const { args, calls } = baseArgs(oroot, { brief: WORK_BRIEF, ...extra });
    return { oroot, res: runDelivery(args), calls };
  }

  test("no _CLAIMS.json: the blocking criterion is unproven, so the delivery is withheld", () => {
    const { res } = claimsCase("cl-none", null);
    expect(res.state).toBe("withheld");
    expect(res.serious).toEqual(["blocking criterion d1 (A página existe e abre no navegador): _CLAIMS.json is missing or not a JSON array"]);
  }, spawnBudgetMs(2));

  test("evidence that names a file which does not exist is no proof", () => {
    const { res } = claimsCase("cl-missing", [{ id: "d1", evidence: "site/inexistente.html:1-20, a página" }]);
    expect(res.state).toBe("withheld");
    expect(res.serious[0]).toContain("names no file that exists under the outputs root");
  }, spawnBudgetMs(2));

  test("evidence naming an existing file delivers; a Windows separator and a line range are fine", () => {
    const { res } = claimsCase("cl-ok", [{ id: "d1", evidence: "site\\page.html:1-11, the page itself" }]);
    expect(res.state).toBe("delivered");
    expect(res.serious).toEqual([]);
  }, spawnBudgetMs(2));

  test("only BLOCKING criteria are checked, and only nested-free top-level bullets are criteria", () => {
    // d2 ("Tem um título claro") is not blocking; the nested bullet is no criterion at all.
    const { res } = claimsCase("cl-blocking-only", [{ id: "d1", evidence: "`site/page.html`, inteira" }]);
    expect(res.state).toBe("delivered");
  }, spawnBudgetMs(2));

  test("the claims check is a business check: a squad run with the same brief is not held to it", () => {
    const { res } = claimsCase("cl-squad", null, { targetKind: "squad", slug: null });
    expect(res.state).toBe("delivered");
  }, spawnBudgetMs(2));

  test("a correction is told which criterion lacks proof, and the solo worker keeps its role and directive", () => {
    const seen: any[] = [];
    const { res } = claimsCase("cl-revise", null, {
      maxRevisions: 1, producerRole: "solo", rulesDirective: "\nRULES",
      runHeadlessImpl: ((opts: any) => {
        seen.push(opts);
        fs.writeFileSync(path.join(tmp, "cl-revise", "_CLAIMS.json"), JSON.stringify([{ id: "d1", evidence: "site/page.html:1, the page" }]));
        return { ok: true, runtime: opts.runtime, sessionId: null, result: "", costUsd: null, exitCode: 0, stderr: "", durationMs: 1 };
      }) as any,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].dispatchRole).toBe("solo");
    expect(seen[0].appendSystemPrompt).toBe(soloDirective("\nRULES"));
    expect(seen[0].prompt).toContain("d1 (A página existe e abre no navegador)");
    expect(seen[0].prompt).toContain("_SUMMARY.md and _CLAIMS.json");
    expect(res.state).toBe("delivered");
  }, spawnBudgetMs(3));
});

describe("runDelivery — what the gate reports about itself", () => {
  test("the real mode per file: a judge that ran on some files is `mixed`, never stamped `judge`", () => {
    const fakeGate = path.join(tmp, "fake-gate.ts");
    fs.writeFileSync(fakeGate, `
const file = Bun.argv[2];
const mode = file.endsWith(".md") ? "judge" : "heuristic";
console.log(JSON.stringify({ status: "PASS", mode, results: [] }));
`, "utf8");
    const oroot = path.join(tmp, "mode-mixed");
    fs.mkdirSync(oroot);
    fs.writeFileSync(path.join(oroot, "nota.md"), PASSING_MD);
    fs.writeFileSync(path.join(oroot, "page.html"), PASSING_HTML);
    const { args, calls } = baseArgs(oroot, { gateScript: fakeGate });
    runDelivery(args);
    const passed = calls.find(x => x.event === "gate_passed")!;
    expect(passed.payload.mode).toBe("mixed");
    expect(passed.payload.judged_files).toBe(1);
  }, spawnBudgetMs(2));

  test("a judge that gave no verdict is reported as heuristic", () => {
    const oroot = path.join(tmp, "mode-heuristic");
    fs.mkdirSync(oroot);
    fs.writeFileSync(path.join(oroot, "page.html"), PASSING_HTML);
    const { args, calls } = baseArgs(oroot);
    runDelivery(args);
    expect(calls.find(x => x.event === "gate_passed")!.payload.mode).toBe("heuristic");
  }, spawnBudgetMs(2));
});

describe("runDelivery — the ledger while the run is judged", () => {
  test("the worker's pid is cleared and the lease renewed by the pipeline", () => {
    const oroot = path.join(tmp, "led-pid");
    fs.mkdirSync(oroot);
    fs.writeFileSync(path.join(oroot, "page.html"), PASSING_HTML);
    const led = openTestRun();
    runLedger.recordChildPid(led.handle, led.runId, 999_999, null);
    const res = runDelivery(baseArgs(oroot, { ledger: led }).args);
    expect(res.state).toBe("delivered");
    const row = runLedger.getRun(led.handle, led.runId)!;
    expect(row.child_pid).toBeNull();
    const renewals = auditLines().filter(l => l.event === "x_ledger_lease_renewed" && l.run_id === led.runId);
    expect(renewals.length).toBeGreaterThan(0);
    expect(renewals.every(l => l.source === "delivery-pipeline")).toBe(true);
  }, spawnBudgetMs(2));

  test("a publication that throws is reported, and the run still reaches delivered (never stuck at gated)", () => {
    const oroot = path.join(tmp, "led-throw");
    fs.mkdirSync(oroot);
    fs.writeFileSync(path.join(oroot, "page.html"), PASSING_HTML);
    const led = openTestRun();
    const { args, calls } = baseArgs(oroot, { ledger: led, afterGate: () => { throw new Error("pdf engine exploded"); } });
    const res = runDelivery(args);
    expect(res.state).toBe("delivered");
    expect(calls.find(x => x.event === "x_after_gate_failed")?.payload.error).toBe("pdf engine exploded");
    expect(runLedger.getRun(led.handle, led.runId)!.state).toBe("delivered");
  }, spawnBudgetMs(2));
});

describe("deliverAfterRuntimeError — a worker that crashed is never a full pass", () => {
  test("passing artifacts ship WITH RESERVATIONS naming the error, and the row never passes through failed", () => {
    const oroot = path.join(tmp, "rt-reservations");
    fs.mkdirSync(oroot);
    fs.writeFileSync(path.join(oroot, "guia.html"), PASSING_HTML);
    const led = openTestRun();
    const outcome = deliverAfterRuntimeError({ ...baseArgs(oroot, { ledger: led }).args, runtimeError: "timed out after 30 min" });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.result!.state).toBe("delivered_with_reservations");
    expect(outcome.result!.ceilingApplied).toContain("timed out after 30 min");
    expect(fs.readFileSync(path.join(oroot, "_QA-RESERVATIONS.md"), "utf8")).toContain("timed out after 30 min");
    const row = runLedger.getRun(led.handle, led.runId)!;
    expect(row.state).toBe("delivered");
    expect(row.last_error).toBe("timed out after 30 min");
    const transitions = auditLines().filter(l => l.event === "x_ledger_state_changed" && l.run_id === led.runId).map(l => l.to);
    expect(transitions).not.toContain("failed");
    expect(transitions).toContain("verifying");
  }, spawnBudgetMs(2));

  test("a serious finding after a crash is withheld", () => {
    const oroot = path.join(tmp, "rt-serious");
    fs.mkdirSync(oroot);
    fs.writeFileSync(path.join(oroot, "dados.json"), INVALID_JSON);
    const outcome = deliverAfterRuntimeError({ ...baseArgs(oroot).args, runtimeError: "killed" });
    expect(outcome.result!.state).toBe("withheld");
    expect(outcome.exitCode).toBe(2);
  }, spawnBudgetMs(2));

  test("a crash that left only run state is nothing to judge", () => {
    const oroot = path.join(tmp, "rt-only-state");
    fs.mkdirSync(path.join(oroot, "_work"), { recursive: true });
    fs.writeFileSync(path.join(oroot, "_work", "PROGRESS.md"), PASSING_MD);
    const outcome = deliverAfterRuntimeError({ ...baseArgs(oroot).args, runtimeError: "killed" });
    expect(outcome.judged).toBe(false);
    expect(outcome.exitCode).toBe(1);
    expect(statusOf(oroot)).toMatchObject({ state: "failed", exit_code: 1 });
  });

  test("a caller's own ceiling still wins (the supervisor's salvage withholds)", () => {
    const oroot = path.join(tmp, "rt-caller-ceiling");
    fs.mkdirSync(oroot);
    fs.writeFileSync(path.join(oroot, "guia.html"), PASSING_HTML);
    const outcome = deliverAfterRuntimeError({ ...baseArgs(oroot, { completenessCeiling: { reason: CEILING_REASON } }).args, runtimeError: "killed" });
    expect(outcome.result!.state).toBe("withheld");
    expect(outcome.result!.ceilingApplied).toBe(CEILING_REASON);
  }, spawnBudgetMs(2));
});

describe("runDelivery — _GATE-FINDINGS.md, the gate's round-by-round record", () => {
  test("every round is recorded with rubric, file, reasoning, fixes and seriousness; the file is run state", () => {
    const oroot = path.join(tmp, "gf-rounds");
    fs.mkdirSync(oroot);
    fs.writeFileSync(path.join(oroot, "dados.json"), INVALID_JSON);
    fs.writeFileSync(path.join(oroot, "nota.md"), FAILING_MD);
    const { args } = baseArgs(oroot, { maxRevisions: 1, runHeadlessImpl: okRun as any });
    const res = runDelivery(args);
    const file = path.join(oroot, GATE_FINDINGS_FILE);
    const text = fs.readFileSync(file, "utf8");
    expect(text).toStartWith("# Gate findings");
    expect(text).toContain("## Gate run · proj-delivery-test");
    expect(text).toContain("### Round 0 (first gate) · FAIL");
    expect(text).toContain("### Round 1 (after correction 1) · FAIL");
    expect(text).toMatch(/- \*\*SERIOUS\*\* `dados\.json` · `json-valid`: \S/);
    expect(text).toMatch(/- `nota\.md` · `wiki-lint`: \S/);
    expect(text).toContain("  - fix: ");
    // Serious first within a round.
    const round0 = text.slice(text.indexOf("### Round 0"), text.indexOf("### Round 1"));
    expect(round0.indexOf("**SERIOUS**")).toBeLessThan(round0.indexOf("`nota.md`"));
    // Never a deliverable: not produced, not gated, not a candidate.
    expect(isRunStateFile(GATE_FINDINGS_FILE)).toBe(true);
    expect(isRunStateFile(`sub\\${GATE_FINDINGS_FILE}`, "win32")).toBe(true);
    expect(res.produced.map(f => path.basename(f))).not.toContain(GATE_FINDINGS_FILE);
    expect(res.gatedFiles.map(f => path.basename(f))).not.toContain(GATE_FINDINGS_FILE);
    expect(gateableFiles(oroot, new Set()).map(f => path.basename(f))).not.toContain(GATE_FINDINGS_FILE);
    expect(candidateArtifacts(oroot, "").map(f => path.basename(f))).not.toContain(GATE_FINDINGS_FILE);
  }, spawnBudgetMs(4));

  test("a passing round is recorded as such, and a run that leaves only the findings file delivered nothing", () => {
    const oroot = path.join(tmp, "gf-pass");
    fs.mkdirSync(oroot);
    fs.writeFileSync(path.join(oroot, "page.html"), PASSING_HTML);
    runDelivery(baseArgs(oroot).args);
    expect(fs.readFileSync(path.join(oroot, GATE_FINDINGS_FILE), "utf8")).toContain("### Round 0 (first gate) · PASS");

    const only = path.join(tmp, "gf-only");
    fs.mkdirSync(only);
    fs.writeFileSync(path.join(only, GATE_FINDINGS_FILE), "# Gate findings\n\n" + "x".repeat(400));
    const res = runDelivery(baseArgs(only).args);
    expect(res.exitCode).toBe(1);
    expect(res.state).toBe("failed");
  }, spawnBudgetMs(2));

  test("a non-serious failure names its limit's source too", () => {
    const oroot = path.join(tmp, "gf-style");
    fs.mkdirSync(oroot);
    fs.writeFileSync(path.join(oroot, "nota.md"), FAILING_MD);
    const warned: string[] = [];
    runDelivery(baseArgs(oroot, { maxRevisions: 1, warn: (l: string) => warned.push(l), runHeadlessImpl: okRun as any }).args);
    expect(warned.find(l => l.includes("auto-revision"))).toContain("auto-revision 1/1 (max_revisions 1)");
    expect(warned.some(l => l.startsWith("    ! "))).toBe(false);
  }, spawnBudgetMs(3));
});

describe("serious finding identity", () => {
  test("keys ignore case, separators and spacing; equality is by set of keys, never prose", () => {
    expect(findingKey("rubric", "JSON-valid", "docs\\Plan.json")).toBe(findingKey("rubric", "json-valid", "docs/plan.json"));
    const a = [{ key: findingKey("criterion", "d1"), text: "blocking criterion d1 (x): no claim", detail: "" }];
    const b = [{ key: findingKey("criterion", " D1 "), text: "blocking criterion d1 (x): evidence names no file", detail: "other words" }];
    expect(sameSeriousFindings(a, b)).toBe(true);
    expect(sameSeriousFindings(a, [...b, { key: "rubric|secret-leak|a.md", text: "", detail: "" }])).toBe(false);
    expect(sameSeriousFindings([], [])).toBe(false);
  });

  test("shortLine folds whitespace and cuts long lines", () => {
    expect(shortLine("a\n  b")).toBe("a b");
    const long = shortLine("x".repeat(500));
    expect(long).toHaveLength(160);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("runDelivery — a run stopped under the pipeline spends nothing more", () => {
  const throwingGate = () => {
    const gate = path.join(tmp, "gate-must-not-run.ts");
    fs.writeFileSync(gate, `require("node:fs").writeFileSync(${JSON.stringify(path.join(tmp, "gate-ran"))}, "1"); process.exit(1);\n`);
    return gate;
  };

  test("abandoned before the pipeline: no verify, no gate, the row stays abandoned, _STATUS.json says stopped", () => {
    const oroot = path.join(tmp, "stop-before");
    fs.mkdirSync(oroot);
    fs.writeFileSync(path.join(oroot, "page.html"), PASSING_HTML);
    const led = openTestRun();
    runLedger.abandon(led.handle, led.runId, "stopped by the user");
    const warned: string[] = [];
    const { args, calls } = baseArgs(oroot, { ledger: led, gateScript: throwingGate(), warn: (l: string) => warned.push(l) });
    const res = runDelivery(args);
    expect(res.stopped).toBe("abandoned: stopped by the user");
    expect(res.exitCode).toBe(1);
    expect(res.state).toBe("failed");
    expect(res.delivered).toBe(false);
    expect(fs.existsSync(path.join(tmp, "gate-ran"))).toBe(false);
    expect(runLedger.getRun(led.handle, led.runId)!.state).toBe("abandoned");
    expect(statusOf(oroot)).toMatchObject({ state: "failed", stopped: "abandoned: stopped by the user", exit_code: 1 });
    expect(calls.map(x => x.event)).toEqual(["x_delivery_stopped"]);
    expect(warned.filter(l => l.includes("was stopped"))).toHaveLength(1);
    expect(warned.some(l => l.includes("[run-ledger]"))).toBe(false);
    expect(auditLines().some(l => l.event === "x_ledger_lease_renewed" && l.run_id === led.runId)).toBe(false);
  }, spawnBudgetMs(1));

  test("stopped during a correction: no cold retry, no gate after it, nothing more spawned", () => {
    const oroot = path.join(tmp, "stop-revision");
    fs.mkdirSync(oroot);
    fs.writeFileSync(path.join(oroot, "dados.json"), INVALID_JSON);
    const led = openTestRun();
    let runs = 0;
    const { args, calls } = baseArgs(oroot, {
      ledger: led, maxRevisions: 2, sessionId: "sess-1",
      // `nrv run-track stop` lands while the correction's worker runs, and kills it.
      runHeadlessImpl: ((opts: any) => { runs++; runLedger.abandon(led.handle, led.runId, "stopped by the user"); return { ...okRun(opts), ok: false, error: "killed" }; }) as any,
    });
    const res = runDelivery(args);
    expect(runs).toBe(1);
    expect(res.stopped).toBe("abandoned: stopped by the user");
    expect(res.revisionsUsed).toBe(1);
    expect(runLedger.getRun(led.handle, led.runId)!.state).toBe("abandoned");
    const events = calls.map(x => x.event);
    expect(events.filter(e => e === "gate_failed" || e === "gate_passed")).toHaveLength(0);
    expect(events).toContain("x_delivery_stopped");
    expect(events).not.toContain("x_delivery_withheld");
    expect(fs.readFileSync(path.join(oroot, GATE_FINDINGS_FILE), "utf8")).toContain("Stopped before the cold retry of correction 1");
  }, spawnBudgetMs(3));

  test("stopped after a correction finished: the gate does not run again", () => {
    const oroot = path.join(tmp, "stop-after");
    fs.mkdirSync(oroot);
    fs.writeFileSync(path.join(oroot, "dados.json"), INVALID_JSON);
    const led = openTestRun();
    const { args } = baseArgs(oroot, {
      ledger: led, maxRevisions: 2,
      runHeadlessImpl: ((opts: any) => { runLedger.abandon(led.handle, led.runId, "stopped by the user"); return okRun(opts); }) as any,
    });
    const gateLog = path.join(tmp, "gate-calls");
    const countingGate = path.join(tmp, "counting-gate.ts");
    fs.writeFileSync(countingGate, `require("node:fs").appendFileSync(${JSON.stringify(gateLog)}, "x"); console.log(JSON.stringify({ status: "FAIL", mode: "heuristic", results: [{ name: "json-valid", passed: false, reasoning: "bad", fix_list: ["fix it"] }] })); process.exit(1);\n`);
    const res = runDelivery({ ...args, gateScript: countingGate });
    expect(res.stopped).toBe("abandoned: stopped by the user");
    expect(fs.readFileSync(gateLog, "utf8")).toBe("x"); // the first gate only
  }, spawnBudgetMs(3));

  test("a killed worker's runtime error on a stopped run is not salvaged", () => {
    const oroot = path.join(tmp, "stop-error");
    fs.mkdirSync(oroot);
    fs.writeFileSync(path.join(oroot, "page.html"), PASSING_HTML);
    const led = openTestRun();
    runLedger.abandon(led.handle, led.runId, "stopped by the user");
    const warned: string[] = [];
    const out = deliverAfterRuntimeError({ ...baseArgs(oroot, { ledger: led, gateScript: throwingGate(), warn: (l: string) => warned.push(l) }).args, runtimeError: "killed" });
    expect(out.result?.stopped).toBe("abandoned: stopped by the user");
    expect(out.exitCode).toBe(1);
    expect(fs.existsSync(path.join(tmp, "gate-ran"))).toBe(false);
    expect(runLedger.getRun(led.handle, led.runId)!.state).toBe("abandoned");
    expect(warned.some(l => l.includes("[run-ledger]"))).toBe(false);
  }, spawnBudgetMs(1));

  test("runGateOnce asks before every call and spawns nothing once stopped", () => {
    const oroot = path.join(tmp, "stop-gate");
    fs.mkdirSync(oroot);
    fs.writeFileSync(path.join(oroot, "a.md"), PASSING_MD);
    fs.writeFileSync(path.join(oroot, "b.md"), PASSING_MD);
    let asked = 0;
    const run = runGateOnce([path.join(oroot, "a.md"), path.join(oroot, "b.md")], {
      gateScript: throwingGate(), offline: false, shouldStop: () => { asked++; return true; },
    });
    expect(run.stopped).toBe(true);
    expect(asked).toBe(1);
    expect(fs.existsSync(path.join(tmp, "gate-ran"))).toBe(false);
  }, spawnBudgetMs(1));

  test("a delivered row (closed by someone else) keeps its own _STATUS.json and exits 0", () => {
    const oroot = path.join(tmp, "stop-delivered");
    fs.mkdirSync(oroot);
    fs.writeFileSync(path.join(oroot, "page.html"), PASSING_HTML);
    fs.writeFileSync(path.join(oroot, "_STATUS.json"), JSON.stringify({ state: "delivered", gate: "pass", serious: [], reservations: null, exit_code: 0 }));
    const led = openTestRun();
    runLedger.markState(led.handle, led.runId, "verifying");
    runLedger.markState(led.handle, led.runId, "gated");
    runLedger.markState(led.handle, led.runId, "delivered");
    const res = runDelivery(baseArgs(oroot, { ledger: led, gateScript: throwingGate() }).args);
    expect(res.exitCode).toBe(0);
    expect(res.stopped).toBe("delivered");
    expect(statusOf(oroot).stopped).toBeUndefined();
  }, spawnBudgetMs(1));
});

describe("planJudgeBatches — one judge session for the small text deliverables of a round", () => {
  test("small files share a batch; a large one keeps its own call; a lone file is no batch", () => {
    const dir = path.join(tmp, "batches");
    fs.mkdirSync(dir);
    const make = (name: string, bytes: number) => { const f = path.join(dir, name); fs.writeFileSync(f, "a".repeat(bytes)); return f; };
    const small = [1, 2, 3].map(i => make(`s${i}.md`, 1_000));
    const large = make("large.md", JUDGE_BATCH_FILE_MAX_CHARS + 1);
    expect(planJudgeBatches([...small, large])).toEqual([small]);
    expect(planJudgeBatches([small[0]])).toEqual([]);
    expect(planJudgeBatches([large])).toEqual([]);
  });

  test("a delivery larger than one batch takes several, none over the cap", () => {
    const dir = path.join(tmp, "batches-cap");
    fs.mkdirSync(dir);
    const files = Array.from({ length: 10 }, (_, i) => { const f = path.join(dir, `f${i}.md`); fs.writeFileSync(f, "a".repeat(JUDGE_BATCH_FILE_MAX_CHARS)); return f; });
    const batches = planJudgeBatches(files);
    expect(batches.flat()).toEqual(files.slice(0, batches.flat().length));
    for (const b of batches) expect(b.length * JUDGE_BATCH_FILE_MAX_CHARS).toBeLessThanOrEqual(JUDGE_BATCH_MAX_CHARS);
    expect(batches.length).toBeGreaterThan(1);
  });
});
