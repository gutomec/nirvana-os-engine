// activate-recovery.test.ts — what `nrv activate` does after a failure, by caller.
//
// The install pass is untouched; these pin the part after it. An agent or a
// script gets a delimited block (and JSON under --json) and is never prompted;
// a person at a terminal is offered an installed agent runtime, whose fix is
// scoped to the listed failures and followed by a re-check of those squads.
// The runtime dispatch, the terminal and the environment are all fakes here:
// no model is ever called.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnBudgetMs } from "./helpers/test-budgets.ts";
import type { Runtime } from "../../_shared/lib/host-agent-driver.ts";
import {
  BLOCK_BEGIN, BLOCK_END, buildFixPrompt, detectCaller, issuesFromOutcome, parseActivatorJson, parseChoice,
  parseFixWithAgent, recover, renderAgentBlock, type ActivationIssue, type FixEnv, type RecoveryDeps, type SquadOutcome,
} from "../lib/activate-recovery.ts";

const REPO = join(import.meta.dir, "..", "..", "..");
const CMD = join(REPO, "skills", "harness", "scripts", "activate.ts");
const roots: string[] = [];
afterAll(() => {
  for (const r of roots) { try { rmSync(r, { recursive: true, force: true }); } catch { /* OS reclaims tmp */ } }
});

const fixEnv: FixEnv = { platform: "darwin", which: (cli) => (["brew", "uv"].includes(cli) ? `/usr/local/bin/${cli}` : null) };

/** An activator result with one failed system install and one missing prereq. */
function failedOutcome(slug = "video-squad"): SquadOutcome {
  return {
    slug, dir: `/squads/${slug}`, exitCode: 1,
    result: {
      slug, ok: false,
      failures: [{ step: "python", status: "install_failed", kind: "python", python: "/envs/v/.venv/bin/python",
        packages: ["numpy>=1.26"], error: "Command failed\nerror: no matching distribution\nresolution failed" }],
      confirmations_required: [],
      warnings: [
        { step: "system", name: "ffmpeg", status: "missing_system_tool", kind: "system", note: "Prereq 'ffmpeg' not found on PATH." },
        { step: "env_vars", name: "OPENAI_API_KEY", status: "missing_required", description: null },
      ],
    },
  };
}

const okOutcome = (slug = "video-squad"): SquadOutcome => ({
  slug, dir: null, exitCode: 0, result: { slug, ok: true, failures: [], confirmations_required: [], warnings: [] },
});

function deps(over: Partial<RecoveryDeps> = {}): RecoveryDeps & { printed: string[]; asked: string[]; dispatched: { runtime: Runtime; prompt: string }[]; rechecked: string[][] } {
  const printed: string[] = [];
  const asked: string[] = [];
  const dispatched: { runtime: Runtime; prompt: string }[] = [];
  const rechecked: string[][] = [];
  const base: RecoveryDeps = {
    caller: { caller: "automation", sessionRuntime: null },
    fixWith: null,
    available: () => ["claude-code", "codex"],
    canonical: (n) => (n === "claude" ? "claude-code" : n) as Runtime,
    ask: async (q) => { asked.push(q); return "n"; },
    dispatch: (runtime, prompt) => { dispatched.push({ runtime, prompt }); return { ok: true, answer: "FIXED 1 video-squad python numpy" }; },
    recheck: async (squads) => { rechecked.push(squads); return squads.map((s) => okOutcome(s)); },
    fixEnv,
    squadDirs: ["/squads/video-squad"],
    print: (t) => printed.push(t),
  };
  return Object.assign(base, over, { printed, asked, dispatched, rechecked });
}

describe("detecting the caller", () => {
  const noHost = () => null;
  test("an agent marker wins, terminal or not", () => {
    const c = detectCaller({ env: { CLAUDECODE: "1" }, stdinTTY: true, stdoutTTY: true, sessionHost: () => "claude-code" });
    expect(c).toEqual({ caller: "agent", sessionRuntime: "claude-code" });
  });
  test("a person needs both stdin and stdout on a terminal and no marker", () => {
    expect(detectCaller({ env: {}, stdinTTY: true, stdoutTTY: true, sessionHost: noHost }).caller).toBe("human");
  });
  test("uncertain detection is never a person", () => {
    expect(detectCaller({ env: {}, stdinTTY: true, stdoutTTY: false, sessionHost: noHost }).caller).toBe("automation");
    expect(detectCaller({ env: {}, stdinTTY: undefined, stdoutTTY: true, sessionHost: noHost }).caller).toBe("automation");
    expect(detectCaller({ env: { CI: "true" }, stdinTTY: true, stdoutTTY: true, sessionHost: noHost }).caller).toBe("automation");
    expect(detectCaller({ env: { NIRVANA_DISPATCH_DEPTH: "1" }, stdinTTY: true, stdoutTTY: true, sessionHost: noHost }).caller).toBe("agent");
    const throwing = () => { throw new Error("ps unavailable"); };
    expect(detectCaller({ env: {}, stdinTTY: false, stdoutTTY: false, sessionHost: throwing }).caller).toBe("automation");
  });
  test("--fix-with-agent with and without a runtime", () => {
    expect(parseFixWithAgent(["--all"])).toBeNull();
    expect(parseFixWithAgent(["--fix-with-agent"])).toBe(true);
    expect(parseFixWithAgent(["--fix-with-agent=codex"])).toBe("codex");
    expect(parseFixWithAgent(["--fix-with-agent="])).toBe(true);
  });
});

describe("reading the failures", () => {
  test("the activator JSON is found after install logs", () => {
    const out = `installing...\n{ not json\n{\n  "slug": "a",\n  "failures": []\n}\n`;
    expect(parseActivatorJson(out)).toEqual({ slug: "a", failures: [] });
    expect(parseActivatorJson("no json here")).toBeNull();
  });
  test("each issue names squad, kind, error, the fix and the permission it needs", () => {
    const issues = issuesFromOutcome(failedOutcome(), fixEnv);
    const py = issues.find((i) => i.kind === "python")!;
    expect(py.fix).toBe('uv pip install --python /envs/v/.venv/bin/python "numpy>=1.26"');
    expect(py.error.split("\n").length).toBeLessThanOrEqual(4);
    const ff = issues.find((i) => i.name === "ffmpeg")!;
    expect(ff.fix).toBe("brew install ffmpeg");
    expect(ff.needs_permission).toBe(true);
    const key = issues.find((i) => i.kind === "env_var")!;
    expect(key.agent_fixable).toBe(false);
    expect(key.permission_reason).toContain("OPENAI_API_KEY");
    expect(issues.every((i) => i.retry === "nrv activate video-squad")).toBe(true);
  });
  test("a gate refusal and a missing squad are issues an agent cannot fix", () => {
    const gate = issuesFromOutcome({ slug: "s", dir: null, exitCode: 1, result: null, gateLines: ["verify: 2 errors"] }, fixEnv);
    expect(gate[0]).toMatchObject({ kind: "admission", fix: "nrv validate squad s", agent_fixable: false });
    const missing = issuesFromOutcome({ slug: "s", dir: null, exitCode: 4, result: null, stderr: "not found" }, fixEnv);
    expect(missing[0]).toMatchObject({ kind: "squad", agent_fixable: false });
  });
  test("the block is delimited and carries every issue", () => {
    const block = renderAgentBlock(issuesFromOutcome(failedOutcome(), fixEnv));
    expect(block.startsWith(BLOCK_BEGIN)).toBe(true);
    expect(block.endsWith(BLOCK_END)).toBe(true);
    expect(block).toContain("fix: brew install ffmpeg");
    expect(block).toContain("then: nrv activate video-squad");
    expect(block).toContain("permission:");
  });
});

describe("after the failure, by caller", () => {
  const issues = () => issuesFromOutcome(failedOutcome(), fixEnv);

  test("an agent is never prompted and nothing is dispatched", async () => {
    const d = deps({ caller: { caller: "agent", sessionRuntime: "codex" } });
    const r = await recover(issues(), d);
    expect(d.asked).toHaveLength(0);
    expect(d.dispatched).toHaveLength(0);
    expect(r.prompted).toBe(false);
    expect(r.recheckExit).toBeNull();
  });

  test("automation is never prompted", async () => {
    const d = deps();
    const r = await recover(issues(), d);
    expect(d.asked).toHaveLength(0);
    expect(r.skipped).toBe("not requested");
  });

  test("a person is asked, the chosen runtime gets the scoped prompt, and the squads are checked again", async () => {
    const d = deps({ caller: { caller: "human", sessionRuntime: null }, ask: async (q) => { d.asked.push(q); return "2"; } });
    const r = await recover(issues(), d);
    expect(d.asked[0]).toBe("Want an agent to try to fix these? Found: Claude Code, Codex. [1/2/n] ");
    expect(d.dispatched).toHaveLength(1);
    expect(d.dispatched[0].runtime).toBe("codex");
    const prompt = d.dispatched[0].prompt;
    expect(prompt).toContain("Fix ONLY the items listed below");
    expect(prompt).toContain("Do NOT create, edit, move or delete anything inside a squad folder: /squads/video-squad");
    expect(prompt).toContain("FIXED|NOT FIXED");
    expect(prompt).toContain("numpy");
    expect(prompt).not.toContain("OPENAI_API_KEY");   // only the user can supply it
    expect(d.rechecked).toEqual([["video-squad"]]);
    expect(r.resolved).toBe(true);
    expect(r.recheckExit).toBe(0);
    expect(r.agentFix!.fixed.map((i) => i.name)).toContain("ffmpeg");
    expect(d.printed.join("\n")).toContain("Some dependencies are not ready");
  });

  test("the re-check reports what still fails", async () => {
    const d = deps({ caller: { caller: "human", sessionRuntime: null }, ask: async () => "1", recheck: async () => [failedOutcome()] });
    const r = await recover(issues(), d);
    expect(r.resolved).toBe(false);
    expect(r.recheckExit).toBe(1);
    expect(r.agentFix!.still_failing.length).toBeGreaterThan(0);
    expect(d.printed.join("\n")).toContain("Still not ready");
  });

  test("'n' prints the instructions and dispatches nothing", async () => {
    const d = deps({ caller: { caller: "human", sessionRuntime: null } });
    const r = await recover(issues(), d);
    expect(d.asked).toHaveLength(1);
    expect(d.dispatched).toHaveLength(0);
    expect(r.skipped).toBe("declined");
    expect(r.recheckExit).toBeNull();
    expect(d.printed.join("\n")).toContain("To fix by hand:");
  });

  test("no usable runtime: instructions only, no question", async () => {
    const d = deps({ caller: { caller: "human", sessionRuntime: null }, available: () => [] });
    const r = await recover(issues(), d);
    expect(d.asked).toHaveLength(0);
    expect(d.dispatched).toHaveLength(0);
    expect(r.skipped).toBe("no usable runtime");
    expect(d.printed.join("\n")).toContain("brew install ffmpeg");
  });

  test("--fix-with-agent in automation runs the fix without asking, on the first installed runtime", async () => {
    const d = deps({ fixWith: true });
    const r = await recover(issues(), d);
    expect(d.asked).toHaveLength(0);
    expect(d.dispatched[0].runtime).toBe("claude-code");
    expect(d.rechecked).toEqual([["video-squad"]]);
    expect(r.recheckExit).toBe(0);
  });

  test("--fix-with-agent prefers the session runtime, and a named one must be installed", async () => {
    const session = deps({ fixWith: true, caller: { caller: "agent", sessionRuntime: "codex" } });
    await recover(issues(), session);
    expect(session.dispatched[0].runtime).toBe("codex");
    const named = deps({ fixWith: "claude" });
    await recover(issues(), named);
    expect(named.dispatched[0].runtime).toBe("claude-code");
    const absent = deps({ fixWith: "gemini-cli" });
    const r = await recover(issues(), absent);
    expect(absent.dispatched).toHaveLength(0);
    expect(r.skipped).toContain("not installed");
  });

  test("nothing an agent can fix: no question, no dispatch", async () => {
    const only = issues().filter((i) => !i.agent_fixable);
    const d = deps({ caller: { caller: "human", sessionRuntime: null } });
    await recover(only, d);
    expect(d.asked).toHaveLength(0);
    expect(d.dispatched).toHaveLength(0);
  });

  test("an answer by name or number, anything else is no", () => {
    const rts: Runtime[] = ["claude-code", "codex"];
    expect(parseChoice("1", rts)).toBe("claude-code");
    expect(parseChoice("Codex", rts)).toBe("codex");
    expect(parseChoice("", rts)).toBeNull();
    expect(parseChoice("7", rts)).toBeNull();
    expect(parseChoice("n", rts)).toBeNull();
  });

  test("the prompt lists only the issues it is given", () => {
    const list: ActivationIssue[] = issues().filter((i) => i.kind === "python");
    const p = buildFixPrompt(list, { platform: "linux", squadDirs: [] });
    expect(p).toContain("1. squad video-squad · python");
    expect(p).not.toContain("ffmpeg");
  });
});

// ── the command itself, run as an agent and as a script would ──────────────

function library(): string {
  const root = mkdtempSync(join(tmpdir(), "activate-recovery-"));
  roots.push(root);
  writeFileSync(join(root, "AGENTS.md"), "# fixture project\n");
  writeFileSync(join(root, ".env"), "NIRVANA_SCOPE=project\n");
  const dir = join(root, ".nirvana", "squads", "broken-squad");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "squad.yaml"), 'name: broken-squad\nversion: "1.0.0"\nprotocol: "5.0"\ndescription: fixture\n');
  writeFileSync(join(dir, "dependencies.yaml"), [
    'schema_version: "1.0"',
    "system:",
    "  - name: broken-tool",
    '    check: "command -v nirvana-absent-binary-xyz"',
    "    install:",
    '      darwin: "exit 3"',
    '      linux: "exit 3"',
    '      win32: "exit 3"',
    "",
  ].join("\n"));
  return root;
}

/** Strips every agent marker the test runner may have inherited. */
function cleanEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (/^(CLAUDECODE|CLAUDE_CODE_|CODEX_|GEMINI_|ANTIGRAVITY_|AGY_|PI_|KIMI_|GROK_|QWEN_|OPENCODE|NIRVANA_HOST_RUNTIME|NIRVANA_DISPATCH_)/.test(k)) continue;
    env[k] = v;
  }
  return { ...env, NRV_HOST_ANCESTRY: "0", NIRVANA_SKILLS_DIR: join(REPO, "skills"), ...extra };
}

function run(root: string, args: string[], extra: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [CMD, ...args], {
    cwd: root, encoding: "utf8", input: "",
    env: cleanEnv({ NIRVANA_PROJECT_ROOT: root, NIRVANA_SCOPE: "project", ...extra }),
  });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

describe("nrv activate after a failure", () => {
  test("an agent session gets the block, and --json the same data, without a prompt", () => {
    const root = library();
    const plain = run(root, ["broken-squad"], { CLAUDECODE: "1" });
    expect(plain.code).toBe(1);
    expect(plain.stdout).toContain(BLOCK_BEGIN);
    expect(plain.stdout).toContain("broken-tool (install_failed)");
    expect(plain.stdout).toContain("fix: exit 3");
    expect(plain.stdout).toContain("then: nrv activate broken-squad");
    expect(plain.stdout).not.toContain("Want an agent");

    const json = run(root, ["broken-squad", "--json"], { CLAUDECODE: "1" });
    expect(json.code).toBe(1);
    const data = JSON.parse(json.stdout);
    expect(data.caller).toBe("agent");
    expect(data.session_runtime).toBe("claude-code");
    expect(data.ok).toBe(false);
    expect(data.issues[0]).toMatchObject({ squad: "broken-squad", kind: "system", name: "broken-tool", fix: "exit 3" });
    expect(json.stderr).toContain(BLOCK_BEGIN);
    expect(json.stderr).not.toContain("Want an agent");
  }, spawnBudgetMs(4));

  test("a script (no terminal, no marker) is not prompted and exits non-zero", () => {
    const root = library();
    const r = run(root, ["--all", "--json"]);
    expect(r.code).toBe(1);
    const data = JSON.parse(r.stdout);
    expect(data.caller).toBe("automation");
    expect(data.agent_fix).toBeNull();
    expect(`${r.stdout}${r.stderr}`).not.toContain("Want an agent");
  }, spawnBudgetMs(3));
});
