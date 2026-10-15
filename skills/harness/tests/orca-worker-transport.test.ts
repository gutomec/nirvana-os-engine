// orca-worker-transport.test.ts — a headless dispatch becomes an Orca worker
// terminal, and the driver's result keeps its shape (ADR-009).
//
// The transport is exercised two ways. With canned `orca … --json` answers
// (no process) every branch is pinned: the happy path, a question answered
// on the way, a failed outcome that keeps its terminal for inspection, a
// deadline, and every pre-injection failure that must fall back to the
// headless child. Then with a real fake `orca` AND a real fake `claude` on
// PATH, `runHeadless` itself is proven to route through Orca when the host is
// on and through the child when it is off — the same call, two transports,
// one result shape.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writeFakeCli, readCapturedArgs } from "./helpers/fake-cli.ts";
import {
  ORCA_AGENT_ID, briefFileContent, forwardedEnv, interactiveArgv, preTrustWorkspace, runOrcaWorker, screenDialog, screenShowsTrustPrompt, workerCommand,
} from "../../_shared/lib/orca-worker.ts";
import { getRun, markState, openLedger, openRun } from "../lib/run-ledger.ts";
import type { OrcaCall } from "../../_shared/lib/orca.ts";

// ── canned Orca ───────────────────────────────────────────────────────────

type Answer = (args: string[]) => Partial<OrcaCall> | undefined;

function canned(script: Record<string, Answer | Partial<OrcaCall>>, opts: { active?: boolean } = {}) {
  const calls: string[][] = [];
  const fired: string[][] = [];
  const key = (args: string[]) => args.slice(0, 2).join(" ");
  const orcaJsonImpl = (args: string[]): OrcaCall => {
    calls.push(args);
    const entry = script[key(args)];
    const a = typeof entry === "function" ? entry(args) : entry;
    const base: OrcaCall = { ok: false, result: null, error: { code: "unknown_command", message: key(args) }, raw: "", exitCode: 1 };
    return { ...base, ...(a ?? {}) };
  };
  const orcaFireImpl = (args: string[]) => { fired.push(args); };
  // The post-inject screen reads pause between reads; here they do not.
  const hooks: Record<string, any> = { orcaJsonImpl: orcaJsonImpl as any, orcaFireImpl, activeImpl: () => opts.active ?? true, sleep: () => {} };
  return { calls, fired, hooks };
}

const ok = (result: unknown): Partial<OrcaCall> => ({ ok: true, result, error: null });
const fail = (code: string): Partial<OrcaCall> => ({ ok: false, result: null, error: { code, message: code } });

const done = (outcome: "succeeded" | "failed", extra: Record<string, unknown> = {}) => ({
  id: "msg_1", type: "worker_done", subject: "finished", body: "Did the thing. Found nothing odd. Nothing left.",
  payload: JSON.stringify({ taskId: "task_1", dispatchId: "ctx_1", outcome, filesModified: ["/out/a.md"], reportPath: "/out/a.md", ...extra }),
});

const HAPPY = {
  "orchestration run-create": ok({ run: { id: "run_1" } }),
  "orchestration task-create": ok({ task: { id: "task_1" } }),
  "terminal create": ok({ terminal: { handle: "term_1" } }),
  "terminal wait": ok({ wait: { satisfied: true } }),
  "terminal read": ok({ terminal: { tail: ["", "> ", ""] } }),
  "orchestration dispatch": ok({ dispatch: { id: "ctx_1" } }),
  "orchestration check": ok({ deliveryId: "d1", messages: [done("succeeded")] }),
  "orchestration worker-read": ok({ transcript: { messages: [{ role: "assistant", blocks: [{ type: "text", text: "hi" }] }] } }),
};

const base = (over: Record<string, unknown> = {}) => ({
  runtime: "claude-code" as const, prompt: "Write a.md", cwd: os.tmpdir(), appendSystemPrompt: "Be autonomous.", label: "brandcraft/writer", ...over,
});

describe("the interactive command per runtime", () => {
  test("every runtime with an Orca agent id has a TUI command; qwen has none", () => {
    for (const rt of Object.keys(ORCA_AGENT_ID)) expect(interactiveArgv({ runtime: rt as any, yolo: true, model: "m" })).not.toBeNull();
    expect(interactiveArgv({ runtime: "qwen-code", yolo: true })).toBeNull();
  });

  test("autonomy flags match the headless runners, and --safe drops them", () => {
    expect(interactiveArgv({ runtime: "claude-code", yolo: true, model: "opus", addDirs: ["/p"] })).toEqual(["claude", "--dangerously-skip-permissions", "--model", "opus", "--disallowedTools", "Task", "Agent", "Workflow", "--add-dir", "/p"]);
    expect(interactiveArgv({ runtime: "claude-code", yolo: false, model: "opus" })).toEqual(["claude", "--permission-mode", "acceptEdits", "--model", "opus", "--disallowedTools", "Task", "Agent", "Workflow"]);
    expect(interactiveArgv({ runtime: "codex", yolo: true, model: "gpt-5" })).toEqual(["codex", "--dangerously-bypass-approvals-and-sandbox", "-m", "gpt-5", "-c", "agents.enabled=false"]);
    expect(interactiveArgv({ runtime: "codex", yolo: true, model: "gpt-5", allowSubagents: true })).toEqual(["codex", "--dangerously-bypass-approvals-and-sandbox", "-m", "gpt-5"]);
    expect(interactiveArgv({ runtime: "gemini-cli" as any, yolo: true })).toBeNull();
    expect(interactiveArgv({ runtime: "antigravity-cli", yolo: true, model: "a" })).toEqual(["agy", "--dangerously-skip-permissions", "--model", "a"]);
    expect(interactiveArgv({ runtime: "grok-cli", yolo: true, model: "x" })).toEqual(["grok", "--always-approve", "-m", "x"]);
  });

  test("a confined claude worker carries its run's deny rules, as the headless runner does", () => {
    expect(interactiveArgv({ runtime: "claude-code", yolo: true, model: "opus", addDirs: ["/p"], claudeSettings: "/tmp/fence.json" }))
      .toEqual(["claude", "--dangerously-skip-permissions", "--model", "opus", "--settings", "/tmp/fence.json", "--disallowedTools", "Task", "Agent", "Workflow", "--add-dir", "/p"]);
  });

  test("subagents and workflows are denied unless the caller is an orchestrator", () => {
    expect(interactiveArgv({ runtime: "claude-code", yolo: true, allowSubagents: true })).toEqual(["claude", "--dangerously-skip-permissions"]);
  });

  test("the terminal command enters the run's directory and pins the engine's environment", () => {
    const posix = workerCommand(["claude", "--x"], "/w/a b", { NIRVANA_TRACE_ID: "t1", HARNESS_LOGS_DIR: "/l/it's" }, "darwin");
    expect(posix).toBe(`cd '/w/a b' && env NIRVANA_TRACE_ID='t1' HARNESS_LOGS_DIR='/l/it'\\''s' 'claude' '--x'`);
    const win = workerCommand(["claude"], "C:\\w\\a b", { NIRVANA_TRACE_ID: "t'1" }, "win32");
    expect(win).toBe(`Set-Location -LiteralPath 'C:\\w\\a b'; $env:NIRVANA_TRACE_ID='t''1'; & 'claude'`);
    expect(workerCommand(["pi"], "/w", {}, "linux")).toBe(`cd '/w' && 'pi'`);
  });

  test("only the engine's variables are forwarded, never Orca's pane", () => {
    expect(forwardedEnv({ NIRVANA_TRACE_ID: "t", HARNESS_LOGS_DIR: "/l", ORCA_PANE_KEY: "p", PATH: "/bin", NIRVANA_ORCA_HOST: "auto" }))
      .toEqual({ NIRVANA_TRACE_ID: "t", HARNESS_LOGS_DIR: "/l", NIRVANA_ORCA_HOST: "auto" });
  });

  test("the brief file carries the directive, the prompt and the reporting rule", () => {
    const text = briefFileContent({ prompt: "Write a.md", appendSystemPrompt: "Be autonomous.", cwd: "/w" });
    expect(text).toContain("## System directive\n\nBe autonomous.");
    expect(text).toContain("## Brief\n\nWrite a.md");
    expect(text).toContain("worker_done");
    expect(text).toContain("Working directory: /w");
  });
});

describe("with canned Orca answers", () => {
  test("inactive host: null and not one call", () => {
    const c = canned(HAPPY, { active: false });
    expect(runOrcaWorker(base(), c.hooks)).toBeNull();
    expect(c.calls).toEqual([]);
  });

  test("a runtime without an Orca agent id keeps the headless child", () => {
    const c = canned(HAPPY);
    expect(runOrcaWorker(base({ runtime: "qwen-code" }), c.hooks)).toBeNull();
    expect(c.calls).toEqual([]);
  });

  test("the happy path: one Run, one Task, an operator-started terminal, inject, wait, ack, transcript, close", () => {
    const c = canned(HAPPY);
    const r = runOrcaWorker(base(), c.hooks)!;
    expect(r).not.toBeNull();
    expect(r.ok).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(r.runtime).toBe("claude-code");
    // The worker was started under an id the engine chose, so revise can continue it.
    expect(r.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.costUnavailable).toBe(true);
    expect(r.result).toContain("finished");
    expect(r.result).toContain("Did the thing.");
    expect(r.result).toContain("Report: /out/a.md");
    expect(r.warnings?.some((w) => w.includes("term_1") && w.includes("ctx_1"))).toBe(true);
    expect(r.warnings?.some((w) => w.includes("transcript at"))).toBe(true);

    const keys = c.calls.map((a) => a.slice(0, 2).join(" "));
    // After the inject the screen is read again for a few seconds: the worker
    // must have taken its task, not be parked on a dialog.
    const postInject = keys.slice(6).filter((k) => k === "terminal read").length;
    expect(postInject).toBeGreaterThanOrEqual(2);
    expect(keys).toEqual([
      "orchestration run-create", "orchestration task-create", "terminal create", "terminal wait", "terminal read",
      "orchestration dispatch", ...Array(postInject).fill("terminal read"), "orchestration check", "orchestration worker-read",
    ]);
    const runCreate = c.calls[0];
    expect(runCreate).toEqual(["orchestration", "run-create", "--objective", "nirvana · brandcraft/writer"]);
    const taskCreate = c.calls[1];
    expect(taskCreate.slice(0, 4)).toEqual(["orchestration", "task-create", "--run", "run_1"]);
    const spec = taskCreate[taskCreate.indexOf("--spec") + 1];
    expect(spec).toMatch(/^Read the file .*brief\.md and execute every instruction in it/);
    const briefFile = spec.match(/Read the file (.*?) and execute/)![1];
    expect(fs.readFileSync(briefFile, "utf8")).toContain("Write a.md");
    expect(taskCreate).toContain("--task-title");
    const termCreate = c.calls[2];
    expect(termCreate[termCreate.indexOf("--title") + 1]).toBe("brandcraft/writer · claude");
    expect(termCreate[termCreate.indexOf("--command") + 1]).toContain("'--dangerously-skip-permissions'");
    expect(c.calls[3]).toEqual(["terminal", "wait", "--terminal", "term_1", "--for", "tui-idle", "--timeout-ms", "120000"]);
    expect(c.calls[4]).toEqual(["terminal", "read", "--terminal", "term_1", "--limit", "80"]);
    expect(c.calls[5]).toEqual(["orchestration", "dispatch", "--run", "run_1", "--task", "task_1", "--to", "term_1", "--inject"]);
    expect(c.calls[6 + postInject].slice(0, 6)).toEqual(["orchestration", "check", "--run", "run_1", "--wait", "--types"]);
    // The delivery is acknowledged and the finished worker's tab is closed.
    expect(c.fired).toContainEqual(["orchestration", "check", "--run", "run_1", "--ack", "d1"]);
    expect(c.fired).toContainEqual(["terminal", "close", "--terminal", "term_1"]);
  });

  test("the run's own variables (a squad's environment) reach the worker terminal", () => {
    const c = canned(HAPPY);
    runOrcaWorker(base({ env: { NODE_PATH: "/env/brandcraft/node_modules" } }), c.hooks);
    const termCreate = c.calls.find((a) => a[0] === "terminal" && a[1] === "create")!;
    // POSIX `NODE_PATH='…'`, PowerShell `$env:NODE_PATH='…'`: the pin is there either way.
    expect(termCreate[termCreate.indexOf("--command") + 1]).toContain("NODE_PATH='/env/brandcraft/node_modules'");
  });

  test("a claude worker runs with CLAUDE_CODE_DISABLE_WORKFLOWS=1 over the run's own value; an orchestrator does not", () => {
    const worker = canned(HAPPY);
    runOrcaWorker(base({ env: { CLAUDE_CODE_DISABLE_WORKFLOWS: "0" } }), worker.hooks);
    const cmd = (c: ReturnType<typeof canned>) => { const t = c.calls.find((a) => a[0] === "terminal" && a[1] === "create")!; return t[t.indexOf("--command") + 1]; };
    expect(cmd(worker)).toContain("CLAUDE_CODE_DISABLE_WORKFLOWS='1'");
    expect(cmd(worker)).toContain("'Workflow'");
    const orchestrator = canned(HAPPY);
    runOrcaWorker(base({ allowSubagents: true }), orchestrator.hooks);
    expect(cmd(orchestrator)).not.toContain("CLAUDE_CODE_DISABLE_WORKFLOWS");
    expect(cmd(orchestrator)).not.toContain("'Workflow'");
  });

  test("a question on the way is answered with the defaults policy, then the worker finishes", () => {
    let checks = 0;
    const c = canned({
      ...HAPPY,
      "orchestration check": () => (++checks === 1
        ? ok({ deliveryId: "d1", messages: [{ id: "msg_q", type: "question", body: "Which colour?", payload: "{}" }] })
        : ok({ deliveryId: "d2", messages: [done("succeeded")] })),
    });
    const r = runOrcaWorker(base(), c.hooks)!;
    expect(r.ok).toBe(true);
    expect(c.fired.some((f) => f[0] === "orchestration" && f[1] === "reply" && f.includes("msg_q"))).toBe(true);
    expect(r.warnings?.some((w) => w.includes("Which colour?"))).toBe(true);
    // The second check acknowledges the first delivery in the same call.
    const second = c.calls.filter((a) => a[1] === "check")[1];
    expect(second).toContain("--ack");
    expect(second[second.indexOf("--ack") + 1]).toBe("d1");
  });

  test("a failed outcome is ok:false with the worker's words, and its terminal stays open for inspection", () => {
    const c = canned({ ...HAPPY, "orchestration check": ok({ deliveryId: "d1", messages: [done("failed")] }) });
    const r = runOrcaWorker(base(), c.hooks)!;
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(1);
    expect(r.error).toContain("worker reported failure");
    expect(c.fired.some((f) => f[0] === "terminal" && f[1] === "close")).toBe(false);
    expect(r.warnings?.some((w) => w.includes("left open"))).toBe(true);
  });

  test("a worker_done for another dispatch is not ours", () => {
    let checks = 0;
    const c = canned({
      ...HAPPY,
      "orchestration check": () => (++checks === 1
        ? ok({ deliveryId: "d1", messages: [done("succeeded", { dispatchId: "ctx_other", taskId: "task_other" })] })
        : ok({ deliveryId: "d2", messages: [done("succeeded")] })),
      "orchestration worker-show": ok({ dispatch: { status: "dispatched" }, terminal: { connected: true } }),
    });
    const r = runOrcaWorker(base(), c.hooks)!;
    expect(r.ok).toBe(true);
    expect(checks).toBe(2);
  });

  test("silence past the deadline fails the run honestly", () => {
    let t = 1_000_000;
    const c = canned({
      ...HAPPY,
      "orchestration check": () => { t += 60_000; return ok({ deliveryId: null, messages: [] }); },
      "orchestration worker-show": ok({ dispatch: { status: "dispatched" }, terminal: { connected: true } }),
    });
    c.hooks.now = () => t;
    const r = runOrcaWorker(base({ timeoutMs: 150_000 }), c.hooks)!;
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/did not report within/);
    // The window never exceeds what is left of the deadline.
    for (const call of c.calls.filter((a) => a[1] === "check")) {
      expect(Number(call[call.indexOf("--timeout-ms") + 1])).toBeLessThanOrEqual(150_000);
    }
  });

  test("a vanished worker terminal ends the wait", () => {
    const c = canned({
      ...HAPPY,
      "orchestration check": ok({ deliveryId: null, messages: [] }),
      "orchestration worker-show": ok({ dispatch: { status: "dispatched" }, terminal: { connected: false } }),
    });
    const r = runOrcaWorker(base(), c.hooks)!;
    expect(r.ok).toBe(false);
    expect(r.error).toBe("worker terminal is gone");
  });

  test.each([
    ["orchestration run-create", "run_required"],
    ["orchestration task-create", "nested_worker_depth_exceeded"],
    ["terminal create", "runtime_error"],
    ["orchestration dispatch", "inject_rejected"],
  ])("a failure at %s (%s) falls back to the headless child", (stage, code) => {
    const c = canned({ ...HAPPY, [stage]: fail(code) });
    expect(runOrcaWorker(base(), c.hooks)).toBeNull();
    const made = c.calls.map((a) => a.slice(0, 2).join(" "));
    expect(made[made.length - 1]).toBe(stage);
    // A terminal that was opened is closed again; a task that was created is failed.
    if (made.includes("terminal create") && stage !== "terminal create") expect(c.fired).toContainEqual(["terminal", "close", "--terminal", "term_1"]);
    if (made.includes("orchestration task-create") && stage !== "orchestration task-create") expect(c.fired.some((f) => f[1] === "task-update" && f.includes("failed"))).toBe(true);
  });

  test("an agent that never reaches its prompt falls back too", () => {
    const c = canned({ ...HAPPY, "terminal wait": ok({ wait: { satisfied: false } }) });
    expect(runOrcaWorker(base(), c.hooks)).toBeNull();
    expect(c.fired).toContainEqual(["terminal", "close", "--terminal", "term_1"]);
  });

  test("a TUI parked on a workspace trust dialog is idle but deaf: the dispatch falls back before injecting", () => {
    const c = canned({ ...HAPPY, "terminal read": ok({ terminal: { tail: [" Accessing workspace:", " /w", " Quick safety check: Is this a project you created or one you trust?", " ❯ No, exit"] } }) });
    expect(runOrcaWorker(base(), c.hooks)).toBeNull();
    expect(c.calls.map((a) => a.slice(0, 2).join(" "))).not.toContain("orchestration dispatch");
    expect(c.fired).toContainEqual(["terminal", "close", "--terminal", "term_1"]);
  });
});

describe("after the inject: did the worker take its task?", () => {
  const AGY_TRUST = ["Accessing workspace:", "/w/outputs/run", "Do you trust the contents of this project?", "Antigravity CLI requires permission to read, edit, and execute files here.", "> Yes, I trust this folder", "  No, exit", "↑/↓ Navigate · enter Confirm"];

  test("the dialogs are told apart from a transcript that only mentions them", () => {
    expect(screenDialog(AGY_TRUST)).toBe("trust-prompt");
    expect(screenDialog(["Bash command: rm -rf build", "Do you want to proceed?", "❯ 1. Yes", "  2. No"])).toBe("permission-prompt");
    expect(screenDialog(["Here is the plan.", "Would you like to proceed?", "❯ 1. Yes, and auto-accept edits", "  2. No, keep planning"])).toBe("plan-review");
    expect(screenDialog(["I will write the plan and then proceed.", "> "])).toBeNull();
    expect(screenDialog(["", "> ", ""])).toBeNull();
  });

  test("agy draws its trust dialog after the inject (2026-10-15): the terminal is closed, the task failed, and the run goes headless", () => {
    let reads = 0;
    const c = canned({ ...HAPPY, "terminal read": () => (++reads === 1 ? ok({ terminal: { tail: ["> "] } }) : ok({ terminal: { tail: AGY_TRUST } })) });
    expect(runOrcaWorker(base({ runtime: "antigravity-cli" }), c.hooks)).toBeNull();
    const keys = c.calls.map((a) => a.slice(0, 2).join(" "));
    expect(keys).toContain("orchestration dispatch");
    expect(keys).not.toContain("orchestration check");
    expect(c.fired).toContainEqual(["terminal", "close", "--terminal", "term_1"]);
    expect(c.fired.some((f) => f[1] === "task-update" && f.includes("failed"))).toBe(true);
  });

  test("a task left unsent on a screen that never moves goes headless too", () => {
    let spec = "";
    const c = canned({
      ...HAPPY,
      "orchestration task-create": (args) => { spec = args[args.indexOf("--spec") + 1]; return ok({ task: { id: "task_1" } }); },
      "terminal read": () => ok({ terminal: { tail: ["$ agy --dangerously-skip-permissions", spec] } }),
    });
    expect(runOrcaWorker(base({ runtime: "antigravity-cli" }), c.hooks)).toBeNull();
    expect(c.fired).toContainEqual(["terminal", "close", "--terminal", "term_1"]);
  });

  test("a screen that moves after the inject is a worker at work", () => {
    let reads = 0;
    const c = canned({ ...HAPPY, "terminal read": () => ok({ terminal: { tail: ["> Read the file…", `✻ Working… (${reads++}s)`] } }) });
    const r = runOrcaWorker(base(), c.hooks)!;
    expect(r.ok).toBe(true);
  });
});

describe("the silence budget replaces the 7-day deadline", () => {
  const quiet = (t: { now: number }, step = 60_000) => ({
    ...HAPPY,
    "orchestration check": (args: string[]) => { t.now += Math.min(step, Number(args[args.indexOf("--timeout-ms") + 1])); return ok({ deliveryId: null, messages: [] }); },
    "orchestration worker-show": ok({ dispatch: { status: "dispatched", lastHeartbeatAt: null }, terminal: { connected: true } }),
  });

  test("a worker silent since the inject is ended as stalled, its terminal closed, long before a week", () => {
    const t = { now: 1_000_000 };
    const c = canned(quiet(t));
    c.hooks.now = () => t.now;
    c.hooks.stallThresholds = { silenceMs: 0, noStartMs: 5 * 60_000 };
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-orca-quiet-"));
    const r = runOrcaWorker(base({ cwd, timeoutMs: 7 * 24 * 60 * 60_000 }), c.hooks)!;
    expect(r.ok).toBe(false);
    expect(r.stalled?.rule).toBe("never_started");
    expect(r.error).toMatch(/^stalled: the worker never started/);
    expect(t.now - 1_000_000).toBeLessThanOrEqual(6 * 60_000);
    expect(c.fired).toContainEqual(["terminal", "close", "--terminal", "term_1"]);
    for (const call of c.calls.filter((a) => a[1] === "check")) expect(Number(call[call.indexOf("--timeout-ms") + 1])).toBeLessThanOrEqual(5 * 60_000);
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  test("Orca's own check-ins keep a quiet worker alive until it reports", () => {
    const t = { now: 1_000_000 };
    let checks = 0;
    const c = canned({
      ...quiet(t),
      "orchestration check": () => { t.now += 4 * 60_000; return ++checks < 4 ? ok({ deliveryId: null, messages: [] }) : ok({ deliveryId: "d", messages: [done("succeeded")] }); },
      "orchestration worker-show": () => ok({ dispatch: { status: "dispatched", lastHeartbeatAt: new Date(t.now).toISOString() }, terminal: { connected: true } }),
    });
    c.hooks.now = () => t.now;
    c.hooks.stallThresholds = { silenceMs: 5 * 60_000, noStartMs: 5 * 60_000 };
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-orca-beat-"));
    const r = runOrcaWorker(base({ cwd }), c.hooks)!;
    expect(r.ok).toBe(true);
    expect(r.stalled).toBeUndefined();
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  test("with a ledger: the terminal is recorded on the row, and a stall marks the row for the agent", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-orca-ledger-"));
    const db = path.join(tmp, "ledger.sqlite");
    const h = openLedger(db);
    const row = openRun(h, { targetSlug: "s", targetKind: "squad", runtime: "claude-code", projectId: "p", traceId: "p", projectRoot: tmp });
    markState(h, row.run_id, "running");
    const t = { now: 1_000_000 };
    let recordedDuringWait: unknown = null;
    const c = canned({
      ...quiet(t),
      "orchestration check": (args: string[]) => {
        recordedDuringWait ??= getRun(h, row.run_id)!.meta.orca_worker;
        t.now += Number(args[args.indexOf("--timeout-ms") + 1]);
        return ok({ deliveryId: null, messages: [] });
      },
    });
    c.hooks.now = () => t.now;
    c.hooks.stallThresholds = { silenceMs: 3 * 60_000, noStartMs: 0 };
    const r = runOrcaWorker(base({ cwd: tmp, ledger: { runId: row.run_id, dbPath: db } }), c.hooks)!;
    expect(recordedDuringWait).toMatchObject({ terminal: "term_1", run_id: "run_1", task_id: "task_1", dispatch_id: "ctx_1" });
    expect(r.stalled?.rule).toBe("silence");
    const after = getRun(h, row.run_id)!;
    expect(after.state).toBe("stalled");
    expect((after.meta.stall as any).decided_by).toBe("orca-wait");
    expect(after.meta.salvaged).toBe(true);
    expect((after.meta.orca_worker as any).closed_at).toBeTruthy();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe("the worker's session: assigned, resumed or read back", () => {
  const commandOf = (c: ReturnType<typeof canned>) => { const t = c.calls.find((a) => a[0] === "terminal" && a[1] === "create")!; return t[t.indexOf("--command") + 1]; };
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  test("each CLI's own spelling for continuing a session or naming a new one", () => {
    expect(interactiveArgv({ runtime: "claude-code", yolo: true, allowSubagents: true }, { assign: "u1" })).toEqual(["claude", "--dangerously-skip-permissions", "--session-id", "u1"]);
    expect(interactiveArgv({ runtime: "claude-code", yolo: true, allowSubagents: true }, { resume: "s1" })).toEqual(["claude", "--dangerously-skip-permissions", "--resume", "s1"]);
    expect(interactiveArgv({ runtime: "codex", yolo: true, allowSubagents: true }, { resume: "t1" })).toEqual(["codex", "resume", "t1", "--dangerously-bypass-approvals-and-sandbox"]);
    // agy resumes the folder's most recent conversation, as its headless runner does on this line.
    expect(interactiveArgv({ runtime: "antigravity-cli", yolo: true }, { resume: "c1" })).toEqual(["agy", "--dangerously-skip-permissions", "--continue"]);
    expect(interactiveArgv({ runtime: "grok-cli", yolo: true }, { assign: "g1" })).toEqual(["grok", "--always-approve", "--session-id", "g1"]);
    expect(interactiveArgv({ runtime: "grok-cli", yolo: true }, { resume: "g1" })).toEqual(["grok", "--always-approve", "-r", "g1"]);
    expect(interactiveArgv({ runtime: "kimi-cli", yolo: true }, { assign: "k1" })).toEqual(["kimi", "--session", "k1"]);
    expect(interactiveArgv({ runtime: "pi", yolo: true }, { resume: "p1" })).toEqual(["pi", "--session-id", "p1"]);
    expect(interactiveArgv({ runtime: "opencode", yolo: true }, { resume: "o1" })).toBeNull();
  });

  test("a fresh claude worker starts under an id the engine chose, returns it and audits it", () => {
    const c = canned(HAPPY);
    const r = runOrcaWorker(base(), c.hooks)!;
    expect(r.sessionId).toMatch(UUID);
    expect(commandOf(c)).toContain(`'--session-id' '${r.sessionId}'`);
  });

  test("a revision in Orca resumes the worker's session in the terminal", () => {
    const c = canned(HAPPY);
    const r = runOrcaWorker(base({ sessionId: "sess-before" }), c.hooks)!;
    expect(r.ok).toBe(true);
    expect(r.sessionId).toBe("sess-before");
    expect(commandOf(c)).toContain("'--resume' 'sess-before'");
    expect(commandOf(c)).not.toContain("--session-id");
  });

  test("a runtime that cannot resume interactively hands the resume to the headless child", () => {
    const c = canned(HAPPY);
    expect(runOrcaWorker(base({ runtime: "opencode", sessionId: "o1" }), c.hooks)).toBeNull();
    expect(c.calls).toEqual([]);
  });

  test("a codex worker's id is read from the session codex filed for its folder since it started", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-orca-codex-"));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-orca-codex-cwd-"));
    try {
      const d = new Date();
      const day = path.join(home, "sessions", String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0"));
      fs.mkdirSync(day, { recursive: true });
      const meta = (id: string, dir: string, ts: string) => JSON.stringify({ timestamp: ts, type: "session_meta", payload: { id, cwd: dir, timestamp: ts } }) + "\n";
      // Another folder, and an older session of this folder: neither is the worker's.
      fs.writeFileSync(path.join(day, "rollout-a.jsonl"), meta("other-folder", os.tmpdir(), new Date(Date.now() + 1000).toISOString()));
      fs.writeFileSync(path.join(day, "rollout-b.jsonl"), meta("too-old", cwd, new Date(Date.now() - 3_600_000).toISOString()));
      const c = canned({
        ...HAPPY,
        // The worker's session appears while it works.
        "orchestration dispatch": () => {
          fs.writeFileSync(path.join(day, "rollout-c.jsonl"), meta("thread-of-the-worker", cwd, new Date().toISOString()));
          return ok({ dispatch: { id: "ctx_1" } });
        },
      });
      const r = runOrcaWorker(base({ runtime: "codex", cwd }), { ...c.hooks, sessionEnv: { HOME: home, CODEX_HOME: home } })!;
      expect(r.sessionId).toBe("thread-of-the-worker");
      expect(commandOf(c)).not.toContain("--session-id");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("an agy worker's id is the conversation its prompt from this folder went to", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-orca-agy-"));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-orca-agy-cwd-"));
    try {
      const hist = path.join(home, ".gemini", "antigravity-cli", "history.jsonl");
      fs.mkdirSync(path.dirname(hist), { recursive: true });
      fs.writeFileSync(hist, JSON.stringify({ display: "old", timestamp: Date.now() - 3_600_000, workspace: cwd, conversationId: "conv-old" }) + "\n"
        + JSON.stringify({ display: "elsewhere", timestamp: Date.now() + 1000, workspace: os.tmpdir(), conversationId: "conv-other" }) + "\n");
      const c = canned({
        ...HAPPY,
        "orchestration dispatch": () => {
          fs.appendFileSync(hist, JSON.stringify({ display: "Read the file", timestamp: Date.now(), workspace: cwd, conversationId: "conv-worker" }) + "\n");
          return ok({ dispatch: { id: "ctx_1" } });
        },
      });
      const r = runOrcaWorker(base({ runtime: "antigravity-cli", cwd }), { ...c.hooks, sessionEnv: { HOME: home } })!;
      expect(r.sessionId).toBe("conv-worker");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("a claude worker's tokens are read from its own transcript, the turns since it started only", () => {
    const cfg = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-orca-claude-"));
    try {
      let file = "";
      const turn = (id: string, at: number, model: string) => JSON.stringify({ type: "assistant", timestamp: new Date(at).toISOString(),
        message: { id, model, usage: { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 50 } } }) + "\n";
      const c = canned({
        ...HAPPY,
        "orchestration dispatch": () => {
          // The worker writes its transcript under the id it was started with.
          const cmd = c.calls.find((a) => a[1] === "create" && a[0] === "terminal")!;
          const sid = cmd[cmd.indexOf("--command") + 1].match(/'--session-id' '([0-9a-f-]+)'/)![1];
          file = path.join(cfg, "projects", "-w", `${sid}.jsonl`);
          fs.mkdirSync(path.dirname(file), { recursive: true });
          // An earlier turn (before the worker) and one message written on two lines.
          fs.writeFileSync(file, turn("m0", Date.now() - 3_600_000, "sonnet") + turn("m1", Date.now(), "sonnet") + turn("m1", Date.now(), "sonnet"));
          return ok({ dispatch: { id: "ctx_1" } });
        },
      });
      const r = runOrcaWorker(base(), { ...c.hooks, sessionEnv: { HOME: cfg, CLAUDE_CONFIG_DIR: cfg } })!;
      expect(file).not.toBe("");
      expect(r.usage).toEqual({ inputTokens: 1110, cachedInputTokens: 1000, cacheWriteInputTokens: 100, outputTokens: 50, reasoningOutputTokens: 0 });
      expect(r.model).toBe("sonnet");
      // Priced by the estimator's table (sonnet: $3 in, $15 out per million), an estimate.
      expect(r.costUsd).toBeCloseTo((110 * 3 + 1000 * 3 + 50 * 15) / 1_000_000, 9);
      expect(r.costEstimated).toBe(true);
    } finally {
      fs.rmSync(cfg, { recursive: true, force: true });
    }
  });
});

describe("the workspace trust record", () => {
  test("the dialogs of the three CLIs are recognized on screen; a prompt is not", () => {
    expect(screenShowsTrustPrompt(["Accessing workspace:", "/w"])).toBe(true);
    expect(screenShowsTrustPrompt("Do you trust the files in this folder?")).toBe(true);
    expect(screenShowsTrustPrompt(["Do you trust this folder?"])).toBe(true);
    expect(screenShowsTrustPrompt(["> ", "Welcome to Claude Code"])).toBe(false);
    expect(screenShowsTrustPrompt(undefined)).toBe(false);
  });

  test("each runtime's own record is written once, for the raw and the real path, and never twice", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-trust-"));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-trust-cwd-"));
    const env = { HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, ".codex") } as NodeJS.ProcessEnv;
    try {
      // claude-code: ~/.claude.json, an existing document is kept.
      fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ projects: { "/other": { hasTrustDialogAccepted: false } }, theme: "dark" }), "utf8");
      expect(preTrustWorkspace("claude-code", cwd, env)).toEqual([path.join(home, ".claude.json")]);
      const claude = JSON.parse(fs.readFileSync(path.join(home, ".claude.json"), "utf8"));
      expect(claude.theme).toBe("dark");
      expect(claude.projects["/other"]).toEqual({ hasTrustDialogAccepted: false });
      expect(claude.projects[cwd].hasTrustDialogAccepted).toBe(true);
      expect(claude.projects[fs.realpathSync(cwd)].hasTrustDialogAccepted).toBe(true);
      expect(preTrustWorkspace("claude-code", cwd, env)).toEqual([]);
      // codex: a TOML section appended, once.
      expect(preTrustWorkspace("codex", cwd, env)).toEqual([path.join(home, ".codex", "config.toml")]);
      const toml = fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8");
      expect(toml).toContain(`[projects.${JSON.stringify(cwd)}]\ntrust_level = "trusted"`);
      expect(preTrustWorkspace("codex", cwd, env)).toEqual([]);
      expect(fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8")).toBe(toml);
      // qwen-code: the trusted-folders map, in its own home.
      expect(preTrustWorkspace("qwen-code", cwd, env)).toEqual([path.join(home, ".qwen", "trustedFolders.json")]);
      expect(JSON.parse(fs.readFileSync(path.join(home, ".qwen", "trustedFolders.json"), "utf8"))[cwd]).toBe("TRUST_FOLDER");
      // The Gemini CLI is no longer a runtime: its trust file is never written.
      expect(preTrustWorkspace("gemini-cli" as any, cwd, env)).toEqual([]);
      expect(fs.existsSync(path.join(home, ".gemini"))).toBe(false);
      // a runtime with no known record writes nothing.
      expect(preTrustWorkspace("grok-cli", cwd, env)).toEqual([]);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("through the driver, with real fakes on PATH", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-orca-driver-"));
  const bin = path.join(root, "bin");
  const capture = path.join(root, "capture");
  const orcaCalls = path.join(root, "orca-calls.jsonl");
  const saved: Record<string, string | undefined> = {};
  const KEYS = ["PATH", "NIRVANA_ORCA_HOST", "NIRVANA_ORCA_WORKERS", "TERM_PROGRAM", "ORCA_WORKTREE_ID", "ORCA_TERMINAL_HANDLE", "ORCA_PANE_KEY", "ORCA_CLI_COMMAND", "ORCA_DEV_REPO_ROOT", "NIRVANA_ORCA_KEEP_WORKERS", "NIRVANA_ORCA_POST_INJECT_MS", "FAKE_ORCA_DIALOG"];
  const reads = path.join(root, "orca-reads");
  let runHeadless: typeof import("../lib/host-agent-driver.ts").runHeadless;

  beforeAll(async () => {
    for (const k of KEYS) saved[k] = process.env[k];
    fs.mkdirSync(capture, { recursive: true });
    writeFakeCli(bin, "orca", `
      import * as fs from "node:fs";
      const argv = Bun.argv.slice(2);
      fs.appendFileSync(${JSON.stringify(orcaCalls)}, JSON.stringify(argv) + "\\n");
      const sub = argv.slice(0, 2).join(" ");
      const answers = {
        "orchestration run-create": { run: { id: "run_9" } },
        "orchestration task-create": { task: { id: "task_9" } },
        "terminal create": { terminal: { handle: "term_9" } },
        "terminal wait": { wait: { satisfied: true } },
        // FAKE_ORCA_DIALOG: the TUI draws agy's trust dialog after the first read.
        "terminal read": sub !== "terminal read" ? null : (() => {
          const n = (fs.existsSync(${JSON.stringify(reads)}) ? Number(fs.readFileSync(${JSON.stringify(reads)}, "utf8")) : 0) + 1;
          fs.writeFileSync(${JSON.stringify(reads)}, String(n));
          return process.env.FAKE_ORCA_DIALOG && n > 1
            ? { terminal: { tail: ["Accessing workspace:", "Do you trust the contents of this project?", "> Yes, I trust this folder", "  No, exit"] } }
            : { terminal: { tail: ["> "] } };
        })(),
        "orchestration dispatch": { dispatch: { id: "ctx_9" } },
        "orchestration check": { deliveryId: "d9", messages: [{ id: "m9", type: "worker_done", subject: "ok", body: "Wrote the file.", payload: JSON.stringify({ taskId: "task_9", dispatchId: "ctx_9", outcome: "succeeded", filesModified: [], reportPath: null }) }] },
        "orchestration worker-read": { transcript: { messages: [] } },
        "terminal close": { close: {} },
      };
      const result = answers[sub];
      process.stdout.write(JSON.stringify(result ? { ok: true, result } : { ok: false, error: { code: "unknown_command", message: sub } }) + "\\n");
    `);
    // The same fake under the name the resolver uses on Linux outside Orca.
    fs.copyFileSync(path.join(bin, "orca.ts"), path.join(bin, "orca-ide.ts"));
    if (process.platform === "win32") fs.copyFileSync(path.join(bin, "orca.cmd"), path.join(bin, "orca-ide.cmd"));
    else { fs.copyFileSync(path.join(bin, "orca"), path.join(bin, "orca-ide")); fs.chmodSync(path.join(bin, "orca-ide"), 0o755); }
    writeFakeCli(bin, "claude", `
      import * as fs from "node:fs";
      const argv = Bun.argv.slice(2);
      fs.writeFileSync(${JSON.stringify(path.join(capture, "claude-args.json"))}, JSON.stringify(argv));
      await Bun.stdin.text();
      process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "headless child ran", session_id: "sess-child", total_cost_usd: 0.01 }));
    `);
    delete process.env.ORCA_CLI_COMMAND;
    delete process.env.ORCA_DEV_REPO_ROOT;
    delete process.env.NIRVANA_ORCA_WORKERS;
    delete process.env.NIRVANA_ORCA_KEEP_WORKERS;
    delete process.env.FAKE_ORCA_DIALOG;
    // One post-inject read, no pause: the fakes answer at once.
    process.env.NIRVANA_ORCA_POST_INJECT_MS = "0";
    process.env.PATH = `${bin}${path.delimiter}${saved.PATH ?? ""}`;
    ({ runHeadless } = await import("../lib/host-agent-driver.ts"));
  });

  afterAll(() => {
    for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("host off: the headless child runs, and orca is never called", () => {
    process.env.NIRVANA_ORCA_HOST = "off";
    process.env.TERM_PROGRAM = "Orca";
    process.env.ORCA_WORKTREE_ID = "r::/w";
    process.env.ORCA_PANE_KEY = "p:k";
    fs.rmSync(orcaCalls, { force: true });
    const r = runHeadless({ runtime: "claude-code", prompt: "hello", cwd: root, timeoutMs: 60_000 });
    expect(r.ok).toBe(true);
    expect(r.result).toBe("headless child ran");
    expect(r.sessionId).toBe("sess-child");
    expect(readCapturedArgs(capture, "claude")).toContain("-p");
    expect(fs.existsSync(orcaCalls)).toBe(false);
  });

  test("inside Orca, execution.orca_workers is off by default: the headless child runs", () => {
    process.env.NIRVANA_ORCA_HOST = "on";
    delete process.env.NIRVANA_ORCA_WORKERS;
    fs.rmSync(orcaCalls, { force: true });
    fs.rmSync(path.join(capture, "claude-args.json"), { force: true });
    const r = runHeadless({ runtime: "claude-code", prompt: "hello", cwd: root, timeoutMs: 60_000 });
    expect(r.ok).toBe(true);
    expect(r.result).toBe("headless child ran");
    expect(readCapturedArgs(capture, "claude")).toContain("-p");
    expect(fs.existsSync(orcaCalls)).toBe(false);
  });

  test("a trust dialog drawn after the inject: the same run continues as the headless child", () => {
    process.env.NIRVANA_ORCA_HOST = "on";
    process.env.NIRVANA_ORCA_WORKERS = "on";
    process.env.FAKE_ORCA_DIALOG = "1";
    fs.rmSync(reads, { force: true });
    fs.rmSync(orcaCalls, { force: true });
    fs.rmSync(path.join(capture, "claude-args.json"), { force: true });
    try {
      const r = runHeadless({ runtime: "claude-code", prompt: "hello", cwd: root, timeoutMs: 60_000, label: "squad demo" });
      expect(r.ok).toBe(true);
      expect(r.result).toBe("headless child ran");
      // The headless runner started its own session under an engine-chosen id.
      const args = readCapturedArgs(capture, "claude");
      expect(args).toContain("--session-id");
      Bun.sleepSync(500);
      const keys = fs.readFileSync(orcaCalls, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).slice(0, 2).join(" "));
      expect(keys).toContain("orchestration dispatch");
      expect(keys).toContain("terminal close");
      expect(keys).not.toContain("orchestration check");
    } finally { delete process.env.FAKE_ORCA_DIALOG; }
  });

  test("host on: the same call runs as an Orca worker, and claude is not spawned by the engine", () => {
    process.env.NIRVANA_ORCA_HOST = "on";
    process.env.NIRVANA_ORCA_WORKERS = "on";
    fs.rmSync(orcaCalls, { force: true });
    fs.rmSync(path.join(capture, "claude-args.json"), { force: true });
    const r = runHeadless({ runtime: "claude-code", prompt: "hello", cwd: root, timeoutMs: 60_000, label: "squad demo" });
    expect(r.ok).toBe(true);
    expect(r.result).toContain("Wrote the file.");
    expect(r.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(fs.existsSync(path.join(capture, "claude-args.json"))).toBe(false);
    // `terminal close` is fire-and-forget: give the detached child a moment to record itself.
    Bun.sleepSync(500);
    const calls: string[][] = fs.readFileSync(orcaCalls, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const keys = calls.map((a) => a.slice(0, 2).join(" "));
    expect(keys.slice(0, 6)).toEqual(["orchestration run-create", "orchestration task-create", "terminal create", "terminal wait", "terminal read", "orchestration dispatch"]);
    expect(keys).toContain("orchestration check");
    expect(keys).toContain("terminal close");
    const term = calls[2];
    expect(term[term.indexOf("--title") + 1]).toBe("squad demo · claude");
    expect(term[term.indexOf("--worktree") + 1]).toBe("id:r::/w");
  });

  test("a confined worker's terminal starts in its run folder, filed under the caller's project", () => {
    process.env.NIRVANA_ORCA_HOST = "on";
    process.env.NIRVANA_ORCA_WORKERS = "on";
    delete process.env.ORCA_WORKTREE_ID;
    const run = path.join(root, "outputs", "run-1");
    fs.mkdirSync(path.join(root, "outputs", "run-0"), { recursive: true });
    fs.rmSync(orcaCalls, { force: true });
    const r = runHeadless({ runtime: "claude-code", prompt: "hello", cwd: root, workspace: run, timeoutMs: 60_000, label: "squad demo" });
    expect(r.ok).toBe(true);
    Bun.sleepSync(500);
    const calls: string[][] = fs.readFileSync(orcaCalls, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const term = calls.find((a) => a[0] === "terminal" && a[1] === "create")!;
    expect(term[term.indexOf("--worktree") + 1]).toBe(`path:${root}`);
    const command = term[term.indexOf("--command") + 1];
    // `cd '<run>' && …` on POSIX, `Set-Location -LiteralPath '<run>'; …` on Windows.
    expect(command.indexOf(run)).toBeGreaterThanOrEqual(0);
    expect(command.indexOf(run)).toBeLessThan(command.indexOf("claude"));
    // The run beside it (run-0) is not fenced off: no folder is denied, and
    // with no project deny rules there is no settings file at all.
    expect(command).not.toContain("--settings");
    process.env.ORCA_WORKTREE_ID = "r::/w";
  });
});
