// driver-autonomy-flags.test.ts — the headless autonomy switch, per adapter and per layer.
//
// A non-interactive child cannot answer an approval prompt, so every adapter whose CLI
// documents an approval-bypass flag passes it by default (per-CLI --help audits of
// 2026-08-26, quoted on each adapter in skills/_shared/lib/host-agent-driver.ts), and one
// variable, NIRVANA_HEADLESS_SKIP_PERMISSIONS=0, turns the bypass off in both layers: the
// light layer (callHostAgent's buildCall) omits the flag, runHeadless takes the runner's
// restricted path, the one `nrv dispatch --safe` selects. Adapters whose flag could not be
// verified (kimi, qwen, opencode) and pi (its --approve is project-file trust, not tool
// permission) carry no flag in the light layer and are pinned that way here.
// Hermetic: the light layer is asserted from buildCall's argv without a process; the
// headless layer against fake CLIs on a temp PATH. No LLM, no network.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  HEADLESS_SKIP_PERMISSIONS_ENV, __testables, claudeDirectiveArgs, headlessSkipPermissions, resolveExecutable,
  runHeadless, type Runtime,
} from "../../_shared/lib/host-agent-driver.ts";
import { CAPTURE_PRELUDE, readCapturedArgs, writeFakeCli } from "./helpers/fake-cli.ts";
import { spawnBudgetMs } from "./helpers/test-budgets.ts";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-driver-autonomy-"));
const BIN = path.join(TMP, "bin");
const CAP = path.join(TMP, "capture");
const CONFIG = path.join(TMP, "claude-config");
for (const dir of [BIN, CAP, CONFIG]) fs.mkdirSync(dir, { recursive: true });

const SAVED: Record<string, string | undefined> = {};
const MANAGED = [HEADLESS_SKIP_PERMISSIONS_ENV, "NIRVANA_MODEL", "ANTHROPIC_MODEL", "CLAUDE_CONFIG_DIR", "PATH", "FAKE_CAPTURE_DIR"];

beforeAll(() => {
  for (const key of MANAGED) SAVED[key] = process.env[key];
  // No system model from the environment or from a settings.json, so argv is exact.
  delete process.env.NIRVANA_MODEL;
  delete process.env.ANTHROPIC_MODEL;
  process.env.CLAUDE_CONFIG_DIR = CONFIG;
  process.env.PATH = `${BIN}${path.delimiter}${SAVED.PATH ?? ""}`;
  process.env.FAKE_CAPTURE_DIR = CAP;
  delete process.env[HEADLESS_SKIP_PERMISSIONS_ENV];

  // Success envelopes only: what is under test is the argv each runner builds.
  const fake = (name: string, body: string) => writeFakeCli(BIN, name, CAPTURE_PRELUDE + body);
  fake("claude", `await stdinLen(); process.stdout.write(JSON.stringify({ type: "result", is_error: false, result: "ok", session_id: "s1", total_cost_usd: 0.01 }));`);
  fake("codex", `await stdinLen(); const oi = argv.indexOf("-o"); if (oi >= 0) fs.writeFileSync(argv[oi + 1], "ok"); console.log(JSON.stringify({ type: "turn.completed" }));`);
  fake("gemini", `await stdinLen(); process.stdout.write(JSON.stringify({ response: "ok", session_id: "g1" }));`);
  fake("agy", `process.stdout.write(JSON.stringify({ response: "ok", session_id: "a1" }));`);
  fake("kimi", `console.log(JSON.stringify({ type: "result", is_error: false, session_id: "k1" }));`);
  fake("grok", `process.stdout.write(JSON.stringify({ text: "ok", session_id: "gk1" }));`);
  fake("pi", `console.log(JSON.stringify({ type: "session", id: "p1" })); console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } }));`);
  fake("qwen", `await stdinLen(); process.stdout.write("ok");`);
  fake("opencode", `process.stdout.write("ok");`);
});

afterAll(() => {
  for (const key of MANAGED) {
    if (SAVED[key] === undefined) delete process.env[key];
    else process.env[key] = SAVED[key];
  }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ }
});

function withSwitch<T>(value: string | undefined, fn: () => T): T {
  if (value === undefined) delete process.env[HEADLESS_SKIP_PERMISSIONS_ENV];
  else process.env[HEADLESS_SKIP_PERMISSIONS_ENV] = value;
  try { return fn(); }
  finally { delete process.env[HEADLESS_SKIP_PERMISSIONS_ENV]; }
}

/** True when `pair` appears as two consecutive argv elements. */
function hasPair(args: string[], pair: [string, string]): boolean {
  return args.some((arg, index) => arg === pair[0] && args[index + 1] === pair[1]);
}

describe("the switch", () => {
  test.each([
    [undefined, true], ["", true], ["1", true], ["true", true], ["yes", true],
    ["0", false], [" 0 ", false], ["false", false], ["OFF", false], ["no", false],
  ])("NIRVANA_HEADLESS_SKIP_PERMISSIONS=%p → skip permissions %p", (value, expected) => {
    expect(withSwitch(value, headlessSkipPermissions)).toBe(expected);
  });
});

describe("light layer — buildCall argv per adapter", () => {
  const MERGED = "persona\n\n---\n\nmsg";
  function argv(name: string, value: string | undefined): string[] {
    const adapter = __testables.RUNTIMES.find((r: { name: string }) => r.name === name);
    if (!adapter?.buildCall) throw new Error(`adapter ${name} has no buildCall`);
    const call = withSwitch(value, () => adapter.buildCall!("persona", "msg"));
    for (const file of call.tmpFiles ?? []) { try { fs.rmSync(file, { force: true }); } catch { /* ignore */ } }
    // A temp prompt file is unique per call; its slot reads <file> so argv can be compared exactly.
    return call.args.map((arg: string, index: number) => call.args[index - 1] === "--prompt-file" ? "<file>" : arg);
  }

  test.each([
    ["claude-code",
      ["-p", "--no-session-persistence", "--output-format", "json", "--dangerously-skip-permissions", "--append-system-prompt", "persona"],
      ["-p", "--no-session-persistence", "--output-format", "json", "--append-system-prompt", "persona"]],
    ["codex", ["exec", "--dangerously-bypass-approvals-and-sandbox"], ["exec"]],
    ["gemini-cli", ["-p", "", "--approval-mode", "yolo"], ["-p", ""]],
    ["antigravity-cli", ["-p", MERGED, "--dangerously-skip-permissions"], ["-p", MERGED]],
    ["grok-cli", ["--prompt-file", "<file>", "--always-approve"], ["--prompt-file", "<file>"]],
  ])("%s passes its documented bypass flag by default and drops it under =0", (name, byDefault, restricted) => {
    expect(argv(name, undefined)).toEqual(byDefault);
    expect(argv(name, "1")).toEqual(byDefault);
    expect(argv(name, "0")).toEqual(restricted);
  });

  test.each([
    ["pi", ["-p", "--no-approve", "--append-system-prompt", "persona", "msg"]],
    ["kimi-cli", ["-p", MERGED]],
    ["qwen-code", ["-p", ""]],
    ["opencode", ["run", MERGED]],
  ])("%s has no verified bypass flag: the same argv with and without the switch", (name, expected) => {
    expect(argv(name, undefined)).toEqual(expected);
    expect(argv(name, "0")).toEqual(expected);
  });
});

describe("headless layer — runHeadless argv per runtime", () => {
  function argv(runtime: Runtime, cli: string, value: string | undefined, yolo?: boolean): string[] {
    try { fs.rmSync(path.join(CAP, `${cli}-args.json`), { force: true }); } catch { /* ignore */ }
    const result = withSwitch(value, () => runHeadless({ runtime, prompt: "do the task", cwd: TMP, timeoutMs: 20_000, ...(yolo === undefined ? {} : { yolo }) }));
    expect(result.ok, result.error ?? result.stderr).toBe(true);
    return readCapturedArgs(CAP, cli);
  }

  test("claude-code: --dangerously-skip-permissions by default; the acceptEdits allowlist path under =0", () => {
    const trusted = argv("claude-code", "claude", undefined);
    expect(trusted).toContain("--dangerously-skip-permissions");
    expect(trusted).not.toContain("--permission-mode");
    expect(trusted).not.toContain("--allowedTools");
    const restricted = argv("claude-code", "claude", "0", true);
    expect(restricted).not.toContain("--dangerously-skip-permissions");
    expect(hasPair(restricted, ["--permission-mode", "acceptEdits"])).toBeTrue();
    expect(restricted).toContain("--allowedTools");
  });

  // A `.cmd`/`.bat` runtime — every npm-installed CLI — can only be started through cmd.exe
  // (resolveExecutable), and cmd.exe ends the command line at the first CR/LF of an argument
  // whatever the quoting. The directive is the only argument that spans lines, so everything
  // pushed after it used to vanish: the squad dispatch lost both `--add-dir` grants AND
  // `--dangerously-skip-permissions` from a 6251-character line, far under cmd.exe's 8191
  // limit — a grant dropped in silence and a headless child with no permission mode.
  // The cure is the one control-plane/maestro-turn.ts already used: under a shell the
  // directive travels as a FILE, so the command line never contains a newline at all.
  test("claude-code: the directive travels by file under a shell, inline without one — both branches", () => {
    const directive = "line one\nline two";

    const inline = claudeDirectiveArgs(directive, false);
    expect(inline.args).toEqual(["--append-system-prompt", directive]);
    expect(inline.tmpFiles).toBeUndefined();

    const viaFile = claudeDirectiveArgs(directive, true);
    expect(viaFile.args[0]).toBe("--append-system-prompt-file");
    expect(viaFile.args).toHaveLength(2);
    // The whole point: what reaches the command line carries no newline for cmd.exe to cut on.
    expect(viaFile.args[1]).not.toContain("\n");
    expect(fs.readFileSync(viaFile.args[1], "utf8")).toBe(directive);
    expect(viaFile.tmpFiles).toEqual([viaFile.args[1]]);
    fs.rmSync(viaFile.args[1], { force: true });

    expect(claudeDirectiveArgs("", true).args).toEqual([]);
  });

  test("claude-code: no grant and no permission flag is ever pushed behind the directive", () => {
    try { fs.rmSync(path.join(CAP, "claude-args.json"), { force: true }); } catch { /* ignore */ }
    const result = runHeadless({
      runtime: "claude-code", prompt: "do the task", cwd: TMP, timeoutMs: 20_000,
      appendSystemPrompt: "line one\nline two", addDirs: ["/tmp/grant-a", "/tmp/grant-b"],
    });
    expect(result.ok, result.error ?? result.stderr).toBe(true);
    const args = readCapturedArgs(CAP, "claude");
    // Which channel carried it is the platform's decision, read from the same resolver the
    // driver used — not guessed, and not skipped on the system where it differs.
    const flag = resolveExecutable("claude").shell ? "--append-system-prompt-file" : "--append-system-prompt";
    const at = args.indexOf(flag);
    expect(at).toBeGreaterThanOrEqual(0);
    expect(args).toHaveLength(at + 2);   // the directive pair is last: nothing behind it to lose
    expect(args.lastIndexOf("--add-dir")).toBeLessThan(at);
    expect(args.indexOf("--dangerously-skip-permissions")).toBeLessThan(at);
    expect(hasPair(args, ["--add-dir", "/tmp/grant-b"])).toBeTrue();
    // What the CHILD received, read from its own argv. Inline (the direct-spawn path, and every
    // POSIX run) this is the multi-line directive itself, so the run proves what no simulation
    // here can: an argument carrying a newline crosses the process boundary whole. On the Windows
    // runner it crosses CreateProcess and the child's own command-line parser, which is the one
    // link the shim reader could not check on the machine that wrote it.
    if (flag === "--append-system-prompt") expect(args[at + 1]).toBe("line one\nline two");
    else expect(fs.readFileSync(args[at + 1], "utf8")).toBe("line one\nline two");
  }, spawnBudgetMs(2));

  test("codex: --dangerously-bypass-approvals-and-sandbox by default; the workspace-write sandbox under =0", () => {
    expect(argv("codex", "codex", undefined)).toContain("--dangerously-bypass-approvals-and-sandbox");
    const restricted = argv("codex", "codex", "0", true);
    expect(restricted).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(hasPair(restricted, ["-s", "workspace-write"])).toBeTrue();
  });

  test("gemini-cli: --approval-mode yolo by default; auto_edit under =0", () => {
    expect(hasPair(argv("gemini-cli", "gemini", undefined), ["--approval-mode", "yolo"])).toBeTrue();
    expect(hasPair(argv("gemini-cli", "gemini", "0", true), ["--approval-mode", "auto_edit"])).toBeTrue();
  });

  test("antigravity-cli: --dangerously-skip-permissions by default; nothing under =0", () => {
    expect(argv("antigravity-cli", "agy", undefined)).toContain("--dangerously-skip-permissions");
    expect(argv("antigravity-cli", "agy", "0", true)).not.toContain("--dangerously-skip-permissions");
  });

  test("grok-cli: --always-approve by default; nothing under =0", () => {
    expect(argv("grok-cli", "grok", undefined)).toContain("--always-approve");
    expect(argv("grok-cli", "grok", "0", true)).not.toContain("--always-approve");
  });

  test("pi: --approve (project-file trust) by default; --no-approve under =0", () => {
    const trusted = argv("pi", "pi", undefined);
    expect(trusted).toContain("--approve");
    expect(trusted).not.toContain("--no-approve");
    const restricted = argv("pi", "pi", "0", true);
    expect(restricted).toContain("--no-approve");
    expect(restricted).not.toContain("--approve");
  });

  test("qwen-code: --approval-mode yolo by default; nothing under =0", () => {
    expect(hasPair(argv("qwen-code", "qwen", undefined), ["--approval-mode", "yolo"])).toBeTrue();
    expect(argv("qwen-code", "qwen", "0", true)).not.toContain("--approval-mode");
  });

  test.each([["kimi-cli", "kimi"], ["opencode", "opencode"]] as [Runtime, string][])("%s: no bypass flag in either state (none verified)", (runtime, cli) => {
    const flags = ["--dangerously-skip-permissions", "--dangerously-bypass-approvals-and-sandbox", "--approval-mode", "--always-approve", "--yolo"];
    for (const value of [undefined, "0"]) {
      const args = argv(runtime, cli, value);
      for (const flag of flags) expect(args).not.toContain(flag);
    }
  });

  test("an explicit yolo:false stays restricted with the switch on", () => {
    expect(argv("claude-code", "claude", "1", false)).not.toContain("--dangerously-skip-permissions");
  });
});
