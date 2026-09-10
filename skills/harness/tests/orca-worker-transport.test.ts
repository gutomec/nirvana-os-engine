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
  ORCA_AGENT_ID, briefFileContent, forwardedEnv, interactiveArgv, preTrustWorkspace, runOrcaWorker, screenShowsTrustPrompt, workerCommand,
} from "../../_shared/lib/orca-worker.ts";
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
  const hooks = { orcaJsonImpl: orcaJsonImpl as any, orcaFireImpl, activeImpl: () => opts.active ?? true };
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
    expect(interactiveArgv({ runtime: "claude-code", yolo: true, model: "opus", addDirs: ["/p"] })).toEqual(["claude", "--dangerously-skip-permissions", "--model", "opus", "--add-dir", "/p"]);
    expect(interactiveArgv({ runtime: "claude-code", yolo: false, model: "opus" })).toEqual(["claude", "--permission-mode", "acceptEdits", "--model", "opus"]);
    expect(interactiveArgv({ runtime: "codex", yolo: true, model: "gpt-5" })).toEqual(["codex", "--dangerously-bypass-approvals-and-sandbox", "-m", "gpt-5"]);
    expect(interactiveArgv({ runtime: "gemini-cli", yolo: false, model: "g" })).toEqual(["gemini", "--approval-mode", "auto_edit", "-m", "g"]);
    expect(interactiveArgv({ runtime: "antigravity-cli", yolo: true, model: "a" })).toEqual(["agy", "--dangerously-skip-permissions", "--model", "a"]);
    expect(interactiveArgv({ runtime: "grok-cli", yolo: true, model: "x" })).toEqual(["grok", "--always-approve", "-m", "x"]);
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
    expect(r.sessionId).toBeNull();
    expect(r.costUnavailable).toBe(true);
    expect(r.result).toContain("finished");
    expect(r.result).toContain("Did the thing.");
    expect(r.result).toContain("Report: /out/a.md");
    expect(r.warnings?.some((w) => w.includes("term_1") && w.includes("ctx_1"))).toBe(true);
    expect(r.warnings?.some((w) => w.includes("transcript at"))).toBe(true);

    const keys = c.calls.map((a) => a.slice(0, 2).join(" "));
    expect(keys).toEqual([
      "orchestration run-create", "orchestration task-create", "terminal create", "terminal wait", "terminal read",
      "orchestration dispatch", "orchestration check", "orchestration worker-read",
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
    expect(termCreate[termCreate.indexOf("--command") + 1]).toContain("--dangerously-skip-permissions");
    expect(c.calls[3]).toEqual(["terminal", "wait", "--terminal", "term_1", "--for", "tui-idle", "--timeout-ms", "120000"]);
    expect(c.calls[4]).toEqual(["terminal", "read", "--terminal", "term_1", "--limit", "80"]);
    expect(c.calls[5]).toEqual(["orchestration", "dispatch", "--run", "run_1", "--task", "task_1", "--to", "term_1", "--inject"]);
    expect(c.calls[6].slice(0, 6)).toEqual(["orchestration", "check", "--run", "run_1", "--wait", "--types"]);
    // The delivery is acknowledged and the finished worker's tab is closed.
    expect(c.fired).toContainEqual(["orchestration", "check", "--run", "run_1", "--ack", "d1"]);
    expect(c.fired).toContainEqual(["terminal", "close", "--terminal", "term_1"]);
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
      // gemini: the trusted-folders map.
      expect(preTrustWorkspace("gemini-cli", cwd, env)).toEqual([path.join(home, ".gemini", "trustedFolders.json")]);
      expect(JSON.parse(fs.readFileSync(path.join(home, ".gemini", "trustedFolders.json"), "utf8"))[cwd]).toBe("TRUST_FOLDER");
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
  const KEYS = ["PATH", "NIRVANA_ORCA_HOST", "NIRVANA_ORCA_WORKERS", "TERM_PROGRAM", "ORCA_WORKTREE_ID", "ORCA_TERMINAL_HANDLE", "ORCA_PANE_KEY", "ORCA_CLI_COMMAND", "ORCA_DEV_REPO_ROOT", "NIRVANA_ORCA_KEEP_WORKERS"];
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
        "terminal read": { terminal: { tail: ["> "] } },
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

  test("host on: the same call runs as an Orca worker, and claude is not spawned by the engine", () => {
    process.env.NIRVANA_ORCA_HOST = "on";
    fs.rmSync(orcaCalls, { force: true });
    fs.rmSync(path.join(capture, "claude-args.json"), { force: true });
    const r = runHeadless({ runtime: "claude-code", prompt: "hello", cwd: root, timeoutMs: 60_000, label: "squad demo" });
    expect(r.ok).toBe(true);
    expect(r.result).toContain("Wrote the file.");
    expect(r.sessionId).toBeNull();
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
});
