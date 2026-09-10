// orca-host.test.ts — the Orca host integration is invisible outside Orca and
// fail-soft inside it (ADR-009).
//
// Two things are proven with a real process, not a mock: that NOTHING here
// spawns the `orca` binary when the environment does not say "inside Orca"
// (a fake `orca` on PATH records every call, and the record must stay empty),
// and that when it does, the answers are parsed from the CLI's own `--json`
// envelope. Environment changes live in beforeAll/afterAll only — `bun test`
// runs every file in one process.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { writeFakeCli } from "../../harness/tests/helpers/fake-cli.ts";
import {
  detectOrca, insideOrcaTerminal, orcaAuditContext, orcaFire, orcaHostActive, orcaJson, orcaNotify, orcaOpenUrl,
  orcaProjectRun, orcaRunComment, orcaSetWorkspace, orcaStatus, orcaStatusForRunState, orcaWorkersActive,
  orcaWorkspaceSelector, resolveOrcaExecutable, stripOrcaPaneEnv, childEnv,
} from "../lib/orca.ts";
import { runOrcaWorker } from "../lib/orca-worker.ts";

const core = createRequire(import.meta.url)("../lib/orca.js");

const INSIDE: NodeJS.ProcessEnv = {
  TERM_PROGRAM: "Orca",
  ORCA_WORKTREE_ID: "repo-1::/work/proj",
  ORCA_TERMINAL_HANDLE: "term_abc",
  ORCA_PANE_KEY: "tab:leaf",
  ORCA_TAB_ID: "tab",
  ORCA_APP_VERSION: "1.4.198",
  ORCA_AGENT_LAUNCH_TOKEN: "tok",
};

describe("detection reads the environment and nothing else", () => {
  test("outside Orca there is no context", () => {
    expect(detectOrca({})).toBeNull();
    expect(insideOrcaTerminal({ TERM_PROGRAM: "ghostty" })).toBe(false);
    expect(orcaAuditContext({})).toBeNull();
  });

  test("an Orca terminal is recognized by any of its markers", () => {
    expect(insideOrcaTerminal({ TERM_PROGRAM: "Orca" })).toBe(true);
    expect(insideOrcaTerminal({ ORCA_TERMINAL_HANDLE: "term_x" })).toBe(true);
    expect(insideOrcaTerminal({ ORCA_WORKTREE_ID: "r::/p" })).toBe(true);
    expect(detectOrca(INSIDE)).toEqual({
      worktreeId: "repo-1::/work/proj", terminalHandle: "term_abc", paneKey: "tab:leaf", tabId: "tab", appVersion: "1.4.198", userDataPath: null,
    });
  });

  test("the audit block carries workspace, pane and version, never the launch token", () => {
    expect(orcaAuditContext(INSIDE)).toEqual({ worktree_id: "repo-1::/work/proj", terminal_handle: "term_abc", pane_key: "tab:leaf", app_version: "1.4.198" });
  });

  test("the pane identity is stripped from a child's environment; the workspace stays", () => {
    const child = stripOrcaPaneEnv({ ...INSIDE, PATH: "/bin" });
    expect(child.ORCA_PANE_KEY).toBeUndefined();
    expect(child.ORCA_TAB_ID).toBeUndefined();
    expect(child.ORCA_AGENT_LAUNCH_TOKEN).toBeUndefined();
    expect(child.ORCA_TERMINAL_HANDLE).toBeUndefined();
    expect(child.ORCA_WORKTREE_ID).toBe("repo-1::/work/proj");
    expect(child.PATH).toBe("/bin");
    // Outside Orca the copy is the environment itself.
    expect(childEnv({ PATH: "/bin", HOME: "/h" })).toEqual({ PATH: "/bin", HOME: "/h" });
  });
});

describe("the executable follows Orca's own rule", () => {
  test("ORCA_CLI_COMMAND wins, then a dev checkout, then the Linux screen-reader guard", () => {
    expect(resolveOrcaExecutable({ ORCA_CLI_COMMAND: "/opt/orca/bin/orca" }, "linux")).toBe("/opt/orca/bin/orca");
    expect(resolveOrcaExecutable({ ORCA_DEV_REPO_ROOT: "/src/orca" }, "darwin")).toBe("orca-dev");
    expect(resolveOrcaExecutable({}, "linux")).toBe("orca-ide");
    expect(resolveOrcaExecutable({ TERM_PROGRAM: "Orca" }, "linux")).toBe("orca");
    expect(resolveOrcaExecutable({}, "darwin")).toBe("orca");
    expect(resolveOrcaExecutable({}, "win32")).toBe("orca");
  });
});

describe("the host mode", () => {
  test("auto means inside an Orca terminal; on and off override it", () => {
    expect(core.orcaHostActiveEnv({})).toBe(false);
    expect(core.orcaHostActiveEnv(INSIDE)).toBe(true);
    expect(core.orcaHostActiveEnv({ ...INSIDE, NIRVANA_ORCA_HOST: "off" })).toBe(false);
    expect(core.orcaHostActiveEnv({ NIRVANA_ORCA_HOST: "on" })).toBe(true);
    expect(core.orcaHostActiveEnv({ NIRVANA_ORCA_HOST: "auto" })).toBe(false);
  });

  test("the workspace selector is the enclosing worktree, else the project by path", () => {
    expect(orcaWorkspaceSelector("/p", INSIDE)).toBe("id:repo-1::/work/proj");
    expect(orcaWorkspaceSelector("/p", {})).toBe("path:/p");
    expect(orcaWorkspaceSelector(null, {})).toBe("active");
  });
});

describe("the card projection", () => {
  test("ledger states map onto the board columns", () => {
    expect(orcaStatusForRunState("dispatched")).toBe("in-progress");
    expect(orcaStatusForRunState("running")).toBe("in-progress");
    expect(orcaStatusForRunState("verifying")).toBe("in-progress");
    expect(orcaStatusForRunState("gated")).toBe("in-review");
    expect(orcaStatusForRunState("withheld")).toBe("in-review");
    expect(orcaStatusForRunState("stalled")).toBe("in-review");
    expect(orcaStatusForRunState("failed")).toBe("in-review");
    expect(orcaStatusForRunState("delivered")).toBe("completed");
    expect(orcaStatusForRunState("nope")).toBeNull();
  });

  test("the comment names the target and the state, and the error only when it explains the state", () => {
    expect(orcaRunComment({ target_kind: "business", target_slug: "brandcraft", state: "running" })).toBe("nirvana · business/brandcraft · running");
    expect(orcaRunComment({ target_kind: "squad", target_slug: "x", state: "failed", last_error: "runtime  exited 1" })).toBe("nirvana · squad/x · failed · runtime exited 1");
    expect(orcaRunComment({ target_kind: "squad", target_slug: "x", state: "running", last_error: "old" })).toBe("nirvana · squad/x · running");
    expect(orcaRunComment({ state: "delivered", project_id: "proj-1" })).toBe("nirvana · run/proj-1 · delivered");
  });
});

describe("with a fake orca on PATH", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-orca-host-"));
  const bin = path.join(root, "bin");
  const calls = path.join(root, "calls.jsonl");
  const saved: Record<string, string | undefined> = {};
  const KEYS = ["PATH", "TERM_PROGRAM", "ORCA_WORKTREE_ID", "ORCA_TERMINAL_HANDLE", "ORCA_PANE_KEY", "ORCA_TAB_ID", "NIRVANA_ORCA_HOST", "NIRVANA_ORCA_WORKERS", "ORCA_CLI_COMMAND", "ORCA_DEV_REPO_ROOT"];

  const readCalls = (): string[][] => {
    try { return fs.readFileSync(calls, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
  };
  const settle = () => Bun.sleepSync(400);

  beforeAll(() => {
    for (const k of KEYS) saved[k] = process.env[k];
    writeFakeCli(bin, "orca", `
      import * as fs from "node:fs";
      const argv = Bun.argv.slice(2);
      fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(argv) + "\\n");
      const words = argv.filter((a) => a !== "--json");
      const sub = words[0] === "orchestration" || words[0] === "worktree" || words[0] === "tab" ? words.slice(0, 2).join(" ") : words[0];
      let out;
      if (sub === "status") out = { ok: true, result: { app: { running: true }, runtime: { appVersion: "9.9.9", capabilities: ["orchestration.contract.v1"] } } };
      else if (sub === "worktree set") out = { ok: true, result: { worktree: { id: argv[3] } } };
      else if (sub === "tab create") out = { ok: true, result: { tab: { browserPageId: "page_1" } } };
      else if (sub === "orchestration run-create") out = { ok: false, error: { code: "run_required", message: "orchestration is off" } };
      else out = { ok: false, error: { code: "unknown_command", message: "unknown: " + sub } };
      process.stdout.write(JSON.stringify({ id: "x", ...out }) + "\\n");
    `);
    delete process.env.ORCA_CLI_COMMAND;
    delete process.env.ORCA_DEV_REPO_ROOT;
    delete process.env.NIRVANA_ORCA_HOST;
    delete process.env.NIRVANA_ORCA_WORKERS;
    // On Linux the resolver outside an Orca terminal names `orca-ide`; the fake
    // answers to that name too, so the "nothing spawned" proof holds there.
    writeFakeCli(bin, "orca-ide", `process.stdout.write(JSON.stringify({ ok: true, result: {} }) + "\\n"); require("node:fs").appendFileSync(${JSON.stringify(calls)}, JSON.stringify(["orca-ide", ...Bun.argv.slice(2)]) + "\\n");`);
    process.env.PATH = `${bin}${path.delimiter}${saved.PATH ?? ""}`;
  });

  afterAll(() => {
    for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("outside Orca, nothing is spawned — the card, the browser, the notification and the worker are all no-ops", () => {
    delete process.env.TERM_PROGRAM;
    delete process.env.ORCA_WORKTREE_ID;
    delete process.env.ORCA_TERMINAL_HANDLE;
    delete process.env.ORCA_PANE_KEY;
    expect(orcaHostActive()).toBe(false);
    expect(orcaWorkersActive()).toBe(false);
    expect(orcaSetWorkspace({ comment: "x", status: "in-progress" })).toBe(false);
    expect(orcaNotify("t", "m")).toBe(false);
    expect(orcaProjectRun({ state: "running", target_kind: "squad", target_slug: "s" })).toBe(false);
    expect(orcaOpenUrl("http://localhost:1")).toBe(false);
    expect(runOrcaWorker({ runtime: "claude-code", prompt: "p", cwd: root })).toBeNull();
    settle();
    expect(readCalls()).toEqual([]);
  });

  test("inside Orca, the card update and the browser tab go through the CLI, and answers are parsed", () => {
    process.env.TERM_PROGRAM = "Orca";
    process.env.ORCA_WORKTREE_ID = "repo-9::/work/nine";
    process.env.ORCA_TERMINAL_HANDLE = "term_nine";
    process.env.ORCA_PANE_KEY = "t:l";
    expect(orcaHostActive()).toBe(true);
    const st = orcaStatus();
    expect(st).toEqual({ running: true, appVersion: "9.9.9", orchestration: true, capabilities: ["orchestration.contract.v1"], error: null });
    expect(orcaOpenUrl("http://localhost:3737")).toBe(true);
    expect(orcaProjectRun({ state: "gated", target_kind: "business", target_slug: "b", last_error: null })).toBe(true);
    orcaNotify("Nirvana-OS", "run finished");
    settle();
    const seen = readCalls();
    expect(seen).toContainEqual(["status", "--json"]);
    expect(seen).toContainEqual(["tab", "create", "--url", "http://localhost:3737", "--json"]);
    expect(seen).toContainEqual(["worktree", "set", "--worktree", "id:repo-9::/work/nine", "--comment", "nirvana · business/b · gated", "--workspace-status", "in-review", "--json"]);
    expect(seen).toContainEqual(["worktree", "set", "--worktree", "id:repo-9::/work/nine", "--comment", "Nirvana-OS: run finished", "--json"]);
  });

  test("an Orca error is an answer, not an exception, and the worker falls back to the headless child", () => {
    const r = orcaJson(["orchestration", "run-create", "--objective", "x"]);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("run_required");
    expect(orcaWorkersActive()).toBe(true);
    expect(runOrcaWorker({ runtime: "claude-code", prompt: "p", cwd: root })).toBeNull();
    const r2 = orcaJson(["no", "such"], { timeoutMs: 5_000 });
    expect(r2.ok).toBe(false);
    expect(r2.error?.code).toBe("unknown_command");
  });

  test("host.orca=off silences everything even inside Orca; on enables it outside", () => {
    process.env.NIRVANA_ORCA_HOST = "off";
    expect(orcaHostActive()).toBe(false);
    expect(orcaSetWorkspace({ comment: "silenced" })).toBe(false);
    delete process.env.TERM_PROGRAM;
    delete process.env.ORCA_WORKTREE_ID;
    delete process.env.ORCA_TERMINAL_HANDLE;
    delete process.env.ORCA_PANE_KEY;
    process.env.NIRVANA_ORCA_HOST = "on";
    expect(orcaHostActive()).toBe(true);
    expect(orcaSetWorkspace({ comment: "forced", projectRoot: "/work/forced" })).toBe(true);
    settle();
    const seen = readCalls();
    expect(seen.some((c) => c.includes("silenced"))).toBe(false);
    expect(seen).toContainEqual(["worktree", "set", "--worktree", "path:/work/forced", "--comment", "forced", "--json"]);
    delete process.env.NIRVANA_ORCA_HOST;
  });

  test("a missing binary is a quiet failure", () => {
    process.env.ORCA_CLI_COMMAND = path.join(root, "definitely-not-here");
    const r = orcaJson(["status"], { timeoutMs: 3_000 });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBeTruthy();
    expect(() => orcaFire(["status"])).not.toThrow();
    delete process.env.ORCA_CLI_COMMAND;
  });
});

describe("the audit emitter stamps the orca block", () => {
  const saved: Record<string, string | undefined> = {};
  const KEYS = ["TERM_PROGRAM", "ORCA_WORKTREE_ID", "ORCA_TERMINAL_HANDLE", "ORCA_PANE_KEY", "ORCA_APP_VERSION"];
  const audit = createRequire(import.meta.url)("../../harness/lib/audit.js");

  beforeAll(() => { for (const k of KEYS) saved[k] = process.env[k]; });
  afterAll(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

  test("outside Orca an event has no orca key; inside, it names the workspace and pane", () => {
    for (const k of KEYS) delete process.env[k];
    const outside = audit.emit("x_orca_probe", { n: 1 }, { trace_id: "t-orca" });
    expect(outside.event.orca).toBeUndefined();
    process.env.TERM_PROGRAM = "Orca";
    process.env.ORCA_WORKTREE_ID = "repo-2::/work/two";
    process.env.ORCA_TERMINAL_HANDLE = "term_two";
    process.env.ORCA_PANE_KEY = "p:k";
    process.env.ORCA_APP_VERSION = "1.4.198";
    const inside = audit.emit("x_orca_probe", { n: 2 }, { trace_id: "t-orca" });
    expect(inside.event.orca).toEqual({ worktree_id: "repo-2::/work/two", terminal_handle: "term_two", pane_key: "p:k", app_version: "1.4.198" });
    // A caller that already wrote its own block is not overwritten.
    const own = audit.emit("x_orca_probe", { n: 3, orca: { worktree_id: "custom" } }, { trace_id: "t-orca" });
    expect(own.event.orca).toEqual({ worktree_id: "custom" });
  });
});
