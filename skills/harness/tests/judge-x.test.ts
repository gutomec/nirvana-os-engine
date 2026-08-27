// judge-x.test.ts — the engine's Gauntlet judge: its identity is independent of every
// producer, its persona exists for the seven shipped runtimes and carries the scope guard
// without a recruiting instruction, its persona resolution is strict, its prompt is the
// persona plus the evaluation brief and nothing else (measured against the agent-x first
// turn on the same brief), the headless run is seamed, and the child's outcome is the
// scorecard file, with a spent cap named budget_exhausted. Zero LLM, zero network.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SCOPE_GUARD_SENTINEL, SCOPE_GUARD_SENTINEL_PT_BR } from "../../_shared/lib/scope-guard.ts";
import { runAgentX } from "../lib/dispatch-cascade.ts";
import { compileGauntletPlan } from "../lib/gauntlet/compiler.ts";
import { renderEvaluationBrief, type EvaluationRequest } from "../lib/gauntlet/evaluation-contract.ts";
import { targetsAreIndependent } from "../lib/gauntlet/evaluator-registry.ts";
import {
  BUDGET_EXHAUSTED_SUBTYPE, JUDGE_X_BUDGET_EXHAUSTED_MARK, JUDGE_X_TARGET, buildJudgeXPrompt, isJudgeX, judgeXAvailability, judgeXOutcome,
  resolveJudgeXPromptPath, runJudgeX,
} from "../lib/gauntlet/judge-x.ts";
import { AUTONOMOUS_DIRECTIVE, type Runtime } from "../lib/host-agent-driver.ts";
import type { TargetRef } from "../lib/run-kernel/types.ts";

const AGENTS_DIR = path.resolve(import.meta.dir, "..", "..", "_shared", "agents");
const RUNTIMES: Array<{ runtime: Runtime; flavor: string }> = [
  { runtime: "claude-code", flavor: "claude-code" }, { runtime: "codex", flavor: "codex" }, { runtime: "gemini-cli", flavor: "gemini" },
  { runtime: "antigravity-cli", flavor: "antigravity" }, { runtime: "grok-cli", flavor: "grok" }, { runtime: "kimi-cli", flavor: "kimi" }, { runtime: "pi", flavor: "pi" },
];

// The brief of the first real smoke (Café Solar, 2026-08-26), so the measurement below is on the prompt that failed.
const ORIGINAL_BRIEF = "Café Solar é um cold brew em lata (250 ml, sem açúcar), produto fictício de teste, vendido online no Brasil. Escreva em PT-BR, no arquivo outputs/copy.md: "
  + "1 headline, 3 bullets de benefício e 1 CTA para a página de lançamento. Sem dados reais de terceiros; hipóteses devem ser marcadas como hipóteses. "
  + "Também escreva outputs/_SUMMARY.md com 3 linhas explicando a escolha do ângulo.";
const plan = compileGauntletPlan({ brief: ORIGINAL_BRIEF, intensity: "light" });
const request: EvaluationRequest = {
  schemaVersion: "nirvana.gauntlet-evaluation-request/v1alpha1", projectId: "smoke-evaluator", runId: "run_smoke-evaluator", candidateId: "can_1",
  revisionId: "crv_run_smoke-evaluator_can_1_1", revision: 1, round: 1, holdout: false, candidateRoot: "/tmp/smoke/.nirvana/gauntlet/run_smoke-evaluator/candidates/can_1/rev_1",
  scorecardPath: "/tmp/smoke/.nirvana/gauntlet/run_smoke-evaluator/evaluations/crv_run_smoke-evaluator_can_1_1/outputs/scorecard.json",
  briefDigest: plan.successContract.briefDigest, requirements: plan.successContract.requirements, gauntletIds: ["brief-conformance"],
};
const EVALUATION_BRIEF = renderEvaluationBrief(request, ORIGINAL_BRIEF);

const validScorecard = { schemaVersion: "nirvana.gauntlet-scorecard/v1alpha1", verdict: "pass",
  dimensions: [{ id: "brief-conformance", score: 0.92, confidence: 0.9, blocking: true, passed: true, evidenceRefs: ["outputs/copy.md#L1"] }],
  revisionRequests: [], regressions: [] };

function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-judge-x-"));
  return dir;
}

describe("identity", () => {
  test("judge-x is an agent-x kind with its own slug, independent of agent-x, of every squad and of every business", () => {
    expect(JUDGE_X_TARGET).toEqual({ kind: "agent-x", slug: "judge-x" });
    const producers: TargetRef[] = [{ kind: "agent-x", slug: "agent-x" }, { kind: "squad", slug: "copy", capabilityId: "copy.write" }, { kind: "business", slug: "acme" }];
    for (const producer of producers) expect(targetsAreIndependent(producer, JUDGE_X_TARGET)).toBeTrue();
    expect(targetsAreIndependent(JUDGE_X_TARGET, JUDGE_X_TARGET)).toBeFalse();
    expect(isJudgeX(JUDGE_X_TARGET)).toBeTrue();
    expect(isJudgeX({ kind: "agent-x", slug: "agent-x" })).toBeFalse();
  });
});

describe("personas", () => {
  test.each(RUNTIMES)("judge-x.$flavor.md exists for $runtime, is closed, read-only and carries the scope guard", ({ runtime, flavor }) => {
    const file = path.join(AGENTS_DIR, `judge-x.${flavor}.md`);
    expect(fs.existsSync(file), file).toBeTrue();
    const text = fs.readFileSync(file, "utf8");
    expect(text).toMatch(new RegExp(`^name: judge-x-${flavor}$`, "m"));
    expect(text).toMatch(new RegExp(`^runtime: ${runtime}$`, "m"));
    expect(text).toMatch(/^invoked_by: harness$/m);
    expect(text).toContain(SCOPE_GUARD_SENTINEL);
    expect(text).toContain("scorecard.json");
    expect(text).toContain("indeterminate");
    // A judge neither recruits nor produces: none of the agent-x recruitment surfaces, no rollover protocol.
    for (const forbidden of ["nrv dispatch", "brief-business.ts", "Agent({", "x_session_rollover", "_SUMMARY.md", "## Premissas assumidas"]) {
      expect(text, `${flavor} carries '${forbidden}'`).not.toContain(forbidden);
    }
    expect(resolveJudgeXPromptPath(runtime, AGENTS_DIR)).toBe(file);
    expect(resolveJudgeXPromptPath(runtime)).toBe(file);
  });

  test("resolution is strict: a runtime without judge-x.<flavor>.md has no judge, never another runtime's persona", () => {
    expect(resolveJudgeXPromptPath("qwen-code", AGENTS_DIR)).toBeNull();
    expect(resolveJudgeXPromptPath("opencode", AGENTS_DIR)).toBeNull();
    const empty = tmp();
    expect(resolveJudgeXPromptPath("claude-code", empty)).toBeNull();
    expect(judgeXAvailability("claude-code", { agentsDir: empty, runtimeOnPath: () => true })).toEqual({ available: false, reason: "no judge-x persona for runtime 'claude-code' (judge-x.claude-code.md)" });
    expect(judgeXAvailability("claude-code", { agentsDir: AGENTS_DIR, runtimeOnPath: () => false })).toEqual({ available: false, reason: "runtime 'claude-code' is not on the PATH" });
    expect(judgeXAvailability("claude-code", { agentsDir: AGENTS_DIR, runtimeOnPath: () => true })).toEqual({ available: true, personaPath: path.join(AGENTS_DIR, "judge-x.claude-code.md") });
  });
});

describe("prompt", () => {
  test("is the persona plus the evaluation brief: paths, scope guard, no directive, no catalog, no runtime rules", () => {
    const persona = fs.readFileSync(path.join(AGENTS_DIR, "judge-x.claude-code.md"), "utf8");
    const prompt = buildJudgeXPrompt({ persona, brief: EVALUATION_BRIEF, projectId: "prj", outputsRoot: "/tmp/e/outputs", scorecardPath: "/tmp/e/outputs/scorecard.json" });
    expect(prompt.startsWith(persona)).toBeTrue();
    expect(prompt).toContain("# JUDGE-X DISPATCH");
    expect(prompt).toContain("- output_path: /tmp/e/outputs");
    expect(prompt).toContain("- scorecard_path: /tmp/e/outputs/scorecard.json");
    expect(prompt).toContain(EVALUATION_BRIEF);
    expect(prompt).toContain(SCOPE_GUARD_SENTINEL);
    expect(prompt).toContain(SCOPE_GUARD_SENTINEL_PT_BR);
    for (const absent of ["AVAILABLE SQUADS", "FUNDAMENTAL PREMISE", "AUTONOMOUS MODE", "nrv dispatch", "USE_"]) expect(prompt).not.toContain(absent);
  });

  test("the judge's first turn is a fraction of agent-x's on the same evaluation brief (chars / 4 as tokens)", () => {
    let agentXPrompt = "";
    let agentXSystem = "";
    runAgentX({
      brief: EVALUATION_BRIEF, briefPath: "/tmp/e/evaluation-brief.md", runtime: "claude-code", projectId: "prj", projectDir: "/tmp/e", projectRoot: "/tmp/e",
      outputsRoot: "/tmp/e/outputs", reason: "explicit user target", appendSystemPrompt: AUTONOMOUS_DIRECTIVE, audit: () => {},
      runWithCascadeImpl: ((opts: { prompt: string; appendSystemPrompt?: string; runtime: Runtime }) => {
        agentXPrompt = opts.prompt; agentXSystem = opts.appendSystemPrompt ?? "";
        return { ok: true, runtime: opts.runtime, sessionId: null, result: "", costUsd: 0, exitCode: 0, stderr: "", durationMs: 0, handoffs: [], finalRuntime: opts.runtime };
      }) as any,
    });
    const judgePersona = fs.readFileSync(path.join(AGENTS_DIR, "judge-x.claude-code.md"), "utf8");
    const judgePrompt = buildJudgeXPrompt({ persona: judgePersona, brief: EVALUATION_BRIEF, projectId: "prj", outputsRoot: "/tmp/e/outputs", scorecardPath: "/tmp/e/outputs/scorecard.json" });
    const agentXTurn = agentXPrompt.length + agentXSystem.length;
    const judgeTurn = judgePrompt.length;
    // Same brief in both, so the reduction lives in what wraps it: the judge wrap is at most a third of agent-x's.
    const agentXWrap = agentXTurn - EVALUATION_BRIEF.length;
    const judgeWrap = judgeTurn - EVALUATION_BRIEF.length;
    expect(agentXSystem).toContain("AUTONOMOUS MODE");
    expect(judgeWrap).toBeLessThanOrEqual(agentXWrap / 3);
    expect(judgeTurn).toBeLessThanOrEqual(agentXTurn / 2);
    // Reference values on this tree, recorded so a persona that grows past them is noticed: agent-x ≈ 15.5K chars (≈ 3.9K tokens),
    // judge-x ≈ 7K chars (≈ 1.75K tokens) with a 3K-char evaluation brief. Bounds, not exact numbers.
    expect(Math.round(agentXTurn / 4)).toBeGreaterThan(3000);
    expect(Math.round(judgeTurn / 4)).toBeLessThan(2000);
  });
});

describe("runJudgeX", () => {
  test("runs the persona and the brief through the cascade runner with no system directive, no ledger, the candidate root granted, and audits judge-x", () => {
    const calls: any[] = [];
    const audit: Array<{ event: string; payload: Record<string, any> }> = [];
    const result = runJudgeX({
      brief: EVALUATION_BRIEF, runtime: "claude-code", projectId: "prj-evl", projectDir: "/tmp/e/judge-x", projectRoot: "/tmp/e", outputsRoot: "/tmp/e/outputs",
      scorecardPath: "/tmp/e/outputs/scorecard.json", candidateRoot: "/tmp/cand", maxBudgetUsd: 1.5, timeoutMs: 1000, yolo: true, agentsDir: AGENTS_DIR,
      audit: (event, payload) => audit.push({ event, payload }),
      runWithCascadeImpl: ((opts: any) => { calls.push(opts); return { ok: true, runtime: opts.runtime, sessionId: "s-judge", result: "", costUsd: 0.8, exitCode: 0, stderr: "", durationMs: 42, handoffs: [], finalRuntime: opts.runtime, resultSubtype: "success" }; }) as any,
    });
    expect(result).toMatchObject({ ok: true, sessionId: "s-judge", costUsd: 0.8, budgetExhausted: false, promptPath: path.join(AGENTS_DIR, "judge-x.claude-code.md"), finalRuntime: "claude-code" });
    expect(calls).toHaveLength(1);
    // The judge runs INSIDE the project, with its scaffold, its outputs root and the
    // candidate it reads granted as additional directories.
    expect(calls[0]).toMatchObject({ runtime: "claude-code", cwd: "/tmp/e", addDirs: ["/tmp/e/judge-x", "/tmp/e/outputs", "/tmp/cand"], maxBudgetUsd: 1.5, timeoutMs: 1000, yolo: true, projectId: "prj-evl", taskHint: "judge-x (Gauntlet evaluation)" });
    expect(calls[0].appendSystemPrompt).toBeUndefined();
    expect(calls[0].ledger).toBeUndefined();
    expect(calls[0].prompt).toContain("# JUDGE-X DISPATCH");
    expect(calls[0].prompt.length).toBe(result.promptChars);
    expect(audit.map(entry => entry.event)).toEqual(["x_dispatch_judge_x", "agent_executed"]);
    expect(audit[0].payload).toMatchObject({ trace_id: "prj-evl", runtime: "claude-code", scorecard_path: "/tmp/e/outputs/scorecard.json", max_budget_usd: 1.5, prompt_chars: result.promptChars });
    expect(audit[1].payload).toMatchObject({ employee: "judge-x", mode: "judge-x", cost_usd: 0.8, session_id: "s-judge" });
  });

  test("a spent cap is reported as budgetExhausted from the runtime's own result subtype", () => {
    const audit: Array<{ event: string; payload: Record<string, any> }> = [];
    const result = runJudgeX({
      brief: EVALUATION_BRIEF, runtime: "claude-code", projectId: "prj-evl", projectDir: "/tmp/e/judge-x", projectRoot: "/tmp/e", outputsRoot: "/tmp/e/outputs",
      scorecardPath: "/tmp/e/outputs/scorecard.json", maxBudgetUsd: 1.5, agentsDir: AGENTS_DIR, audit: (event, payload) => audit.push({ event, payload }),
      runWithCascadeImpl: ((opts: any) => ({ ok: false, runtime: opts.runtime, sessionId: "s", result: "", costUsd: 1.52, exitCode: 1, stderr: "", durationMs: 9,
        handoffs: [], finalRuntime: opts.runtime, resultSubtype: BUDGET_EXHAUSTED_SUBTYPE, error: "runtime returned an error verdict" })) as any,
    });
    expect(result).toMatchObject({ ok: false, budgetExhausted: true, costUsd: 1.52 });
    expect(audit[1].payload).toMatchObject({ employee: "judge-x", budget_exhausted: true });
  });

  test("a runtime without a persona does not run", () => {
    const empty = tmp();
    let ran = 0;
    const result = runJudgeX({ brief: EVALUATION_BRIEF, runtime: "claude-code", projectId: "p", projectDir: empty, projectRoot: empty, outputsRoot: path.join(empty, "out"),
      scorecardPath: path.join(empty, "out", "scorecard.json"), agentsDir: empty, audit: () => {}, runWithCascadeImpl: ((() => { ran += 1; }) as any) });
    expect(result.ok).toBeFalse();
    expect(result.error).toContain("no judge-x persona for runtime 'claude-code'");
    expect(ran).toBe(0);
  });
});

describe("judgeXOutcome", () => {
  const requirements = plan.successContract.requirements;

  test("a valid scorecard completes the Run whatever the runtime said", () => {
    const dir = tmp();
    const scorecardPath = path.join(dir, "scorecard.json");
    fs.writeFileSync(scorecardPath, JSON.stringify(validScorecard), "utf8");
    expect(judgeXOutcome({ scorecardPath, requirements, run: { budgetExhausted: false }, maxBudgetUsd: 1.5 })).toMatchObject({ exitCode: 0, gateOutcome: "pass", scorecard: { verdict: "pass" } });
    expect(judgeXOutcome({ scorecardPath, requirements, run: { budgetExhausted: false, error: "runtime returned an error verdict" } })).toMatchObject({ exitCode: 0 });
  });

  test.each([
    ["missing", (_: string) => {}, /scorecard\.json not found at .*; runtime: runtime returned an error verdict$/],
    ["invalid JSON", (file: string) => fs.writeFileSync(file, "{ not json", "utf8"), /is not valid JSON/],
    ["out of contract", (file: string) => fs.writeFileSync(file, JSON.stringify({ ...validScorecard, verdict: "revise", dimensions: [{ ...validScorecard.dimensions[0], id: "style", passed: false }] }), "utf8"), /'style' is not in the success contract/],
    ["an implicit pass", (file: string) => fs.writeFileSync(file, JSON.stringify({ ...validScorecard, dimensions: [{ ...validScorecard.dimensions[0], score: 0.2 }] }), "utf8"), /below the minimum 0\.85/],
  ])("a scorecard that is %s withholds the Run with the reason", (_: string, write: (file: string) => void, reason: RegExp) => {
    const dir = tmp();
    const scorecardPath = path.join(dir, "scorecard.json");
    write(scorecardPath);
    const outcome = judgeXOutcome({ scorecardPath, requirements, run: { budgetExhausted: false, error: "runtime returned an error verdict" } });
    expect(outcome).toMatchObject({ exitCode: 2, gateOutcome: "fail", budgetExhausted: false });
    if (outcome.exitCode === 2) expect(outcome.reason).toMatch(reason);
  });

  test("a spent cap names budget_exhausted with the mark the adapter reads and the cap itself", () => {
    const dir = tmp();
    const outcome = judgeXOutcome({ scorecardPath: path.join(dir, "scorecard.json"), requirements, run: { budgetExhausted: true, error: "runtime returned an error verdict" }, maxBudgetUsd: 1.5 });
    expect(outcome).toMatchObject({ exitCode: 2, budgetExhausted: true });
    if (outcome.exitCode === 2) {
      expect(outcome.reason.startsWith(`${JUDGE_X_BUDGET_EXHAUSTED_MARK}: the spend cap of USD 1.5 ended the run before scorecard.json was written`)).toBeTrue();
      expect(outcome.reason).toContain("scorecard.json not found");
    }
  });
});
