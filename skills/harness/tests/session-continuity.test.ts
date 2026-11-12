// session-continuity.test.ts — every run records a session it can be resumed
// from, in every runtime, including the runs that fail, are killed or time out.
//
// The defect: an Orca worker run recorded `session_id: null`, so `nrv revise`
// had no conversation to continue and the orchestrator re-dispatched from
// scratch on every correction (carta-duda, 2026-10-15). Here, per runtime:
//   - claude, grok and pi take the id the engine chose (`--session-id`), kimi
//     `--session`; a claude run killed before its JSON keeps the id when its
//     transcript exists, and does not invent one when it does not;
//   - codex's id comes from the `--json` stream, also when the run fails or
//     times out after it started, else from codex's own session file;
//   - agy's id comes from the stream's first event when no result arrives;
//   - a continued session (`--continue-from`) is resumed from the folder it was
//     made in, by the first worker only, and a pruned one starts fresh.
//
// Hermetic: fake CLIs on a temp PATH, no model, no network.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { continueSessionOnNextWorker, runHeadless, sessionHome } from "../../_shared/lib/host-agent-driver.ts";
import { codexSessionFor, looksLikeMissingSession } from "../../_shared/lib/session-capture.ts";
import { CAPTURE_PRELUDE, AGY_FAKE_PRELUDE, readCapturedArgs, writeFakeCli } from "./helpers/fake-cli.ts";
import { spawnBudgetMs } from "./helpers/test-budgets.ts";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-session-continuity-"));
const BIN = path.join(TMP, "bin");
const CAP = path.join(TMP, "capture");
const CFG = path.join(TMP, "claude-config");
const CODEX_HOME = path.join(TMP, "codex-home");
for (const d of [BIN, CAP, CFG, CODEX_HOME]) fs.mkdirSync(d, { recursive: true });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEYS = ["PATH", "FAKE_CAPTURE_DIR", "FAKE_MODE", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "NIRVANA_MODEL", "ANTHROPIC_MODEL", "NIRVANA_ORCA_HOST"];
const saved: Record<string, string | undefined> = {};

const flag = (argv: string[], name: string): string | undefined => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };

beforeAll(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  process.env.PATH = `${BIN}${path.delimiter}${saved.PATH ?? ""}`;
  process.env.FAKE_CAPTURE_DIR = CAP;
  process.env.CLAUDE_CONFIG_DIR = CFG;
  process.env.CODEX_HOME = CODEX_HOME;
  process.env.NIRVANA_ORCA_HOST = "off";
  delete process.env.NIRVANA_MODEL;
  delete process.env.ANTHROPIC_MODEL;

  // claude: the envelope echoes the id it was given. "killed" prints nothing
  // and dies (a timeout, a SIGKILL) after writing its transcript; "early" dies
  // before any turn; "missing" answers a resume like a pruned session.
  writeFakeCli(BIN, "claude", CAPTURE_PRELUDE + `
    await stdinLen();
    const a = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
    const sid = a("--resume") ?? a("--session-id");
    const mode = process.env.FAKE_MODE;
    if (mode === "missing" && argv.includes("--resume")) { process.stderr.write("No conversation found with session ID: " + sid + "\\n"); process.exit(1); }
    if (mode === "early") { process.stderr.write("fatal before the first turn\\n"); process.exit(1); }
    fs.mkdirSync(path.join(process.env.CLAUDE_CONFIG_DIR, "projects", "-cwd"), { recursive: true });
    fs.writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, "projects", "-cwd", sid + ".jsonl"), "{}\\n");
    fs.appendFileSync(path.join(process.env.FAKE_CAPTURE_DIR, "claude-cwds"), process.cwd() + "\\n");
    if (mode === "killed") { process.stdout.write("partial output"); process.exit(137); }
    process.stdout.write(JSON.stringify({ type: "result", is_error: false, result: "ok", session_id: sid, total_cost_usd: 0.01 }));
  `);

  // codex: the thread id on the first event; "timeout" sleeps after it.
  writeFakeCli(BIN, "codex", CAPTURE_PRELUDE + `
    await stdinLen();
    console.log(JSON.stringify({ type: "thread.started", thread_id: "thread-123" }));
    if (process.env.FAKE_MODE === "timeout") { await Bun.sleep(20_000); }
    if (process.env.FAKE_MODE === "fail") { console.log(JSON.stringify({ type: "turn.failed", error: { message: "boom" } })); process.exit(1); }
    console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }));
  `);

  // agy: "dies" prints the init event (it names the conversation) and exits mid-turn.
  writeFakeCli(BIN, "agy", AGY_FAKE_PRELUDE + `
    await agyPrompt();
    if (process.env.FAKE_MODE === "dies") {
      console.log(JSON.stringify({ event: "init", conversation_id: "conv-777" }));
      process.stderr.write("AGY_ERROR: model error\\n");
      process.exit(3);
    }
    agyReply({ conversation_id: "conv-777", response: "ok" });
  `);

  // kimi and grok: record argv, echo the session they were given.
  writeFakeCli(BIN, "kimi", CAPTURE_PRELUDE + `
    if (process.env.FAKE_MODE === "old" && argv.includes("--session")) { process.stderr.write("Error: No such option: --session\\n"); process.exit(2); }
    console.log(JSON.stringify({ role: "assistant", content: "ok" }));
  `);
  writeFakeCli(BIN, "grok", CAPTURE_PRELUDE + `
    const i = argv.indexOf("--session-id");
    console.log(JSON.stringify({ text: "ok", sessionId: i >= 0 ? argv[i + 1] : "grok-own" }));
  `);
});

afterAll(() => {
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]!; }
  continueSessionOnNextWorker(null);
  fs.rmSync(TMP, { recursive: true, force: true });
});

function run(runtime: Parameters<typeof runHeadless>[0]["runtime"], mode: string | null, extra: Partial<Parameters<typeof runHeadless>[0]> = {}) {
  if (mode) process.env.FAKE_MODE = mode; else delete process.env.FAKE_MODE;
  try {
    return runHeadless({ runtime, prompt: "do the task", cwd: TMP, timeoutMs: 15_000, ...extra });
  } finally { delete process.env.FAKE_MODE; }
}

describe("headless runs record a resumable id", () => {
  test("claude: a fresh run takes the id the engine chose, and the session store gets it", () => {
    const r = run("claude-code", null);
    expect(r.ok).toBe(true);
    const argv = readCapturedArgs(CAP, "claude");
    expect(flag(argv, "--session-id")).toMatch(UUID);
    expect(r.sessionId).toBe(flag(argv, "--session-id")!);
    expect(argv).not.toContain("--resume");
  }, spawnBudgetMs(1));

  test("claude: a resume names the session and never assigns a new one", () => {
    const r = run("claude-code", null, { sessionId: "abc-123" });
    const argv = readCapturedArgs(CAP, "claude");
    expect(flag(argv, "--resume")).toBe("abc-123");
    expect(argv).not.toContain("--session-id");
    expect(r.sessionId).toBe("abc-123");
  }, spawnBudgetMs(1));

  test("claude: a run killed before its JSON keeps its id once its transcript exists, and invents none when it does not", () => {
    const killed = run("claude-code", "killed");
    expect(killed.ok).toBe(false);
    expect(killed.sessionId).toBe(flag(readCapturedArgs(CAP, "claude"), "--session-id")!);
    const early = run("claude-code", "early");
    expect(early.ok).toBe(false);
    expect(early.sessionId).toBeNull();
  }, spawnBudgetMs(2));

  test("codex: the stream's thread id, also when the turn failed or the run timed out", () => {
    expect(run("codex", null).sessionId).toBe("thread-123");
    expect(run("codex", "fail").sessionId).toBe("thread-123");
    const timedOut = run("codex", "timeout", { timeoutMs: 3_000 });
    expect(timedOut.ok).toBe(false);
    expect(timedOut.sessionId).toBe("thread-123");
  }, spawnBudgetMs(4));

  test("codex: with no id on the stream, the session file codex wrote for this folder since the run started", () => {
    const cwd = fs.mkdtempSync(path.join(TMP, "codex-cwd-"));
    const d = new Date();
    const day = path.join(CODEX_HOME, "sessions", String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0"));
    fs.mkdirSync(day, { recursive: true });
    const write = (name: string, id: string, dir: string, at: number) => fs.writeFileSync(path.join(day, name),
      JSON.stringify({ type: "session_meta", payload: { id, cwd: dir, timestamp: new Date(at).toISOString() } }) + "\n");
    const since = Date.now();
    write("rollout-1.jsonl", "older", cwd, since - 3_600_000);
    write("rollout-2.jsonl", "elsewhere", TMP, since + 100);
    write("rollout-3.jsonl", "mine", cwd, since + 200);
    expect(codexSessionFor(cwd, since)).toBe("mine");
    expect(codexSessionFor(path.join(TMP, "nowhere"), since)).toBeNull();
  });

  test("agy: a run that died mid-turn keeps the conversation its first event named", () => {
    const r = run("antigravity-cli", "dies");
    expect(r.ok).toBe(false);
    expect(r.sessionId).toBe("conv-777");
  }, spawnBudgetMs(1));

  test("kimi: `--session <id>` names a fresh run and continues a resumed one; a build without it records none", () => {
    const fresh = run("kimi-cli", null);
    const argv = readCapturedArgs(CAP, "kimi");
    expect(flag(argv, "--session")).toMatch(UUID);
    expect(fresh.sessionId).toBe(flag(argv, "--session")!);
    run("kimi-cli", null, { sessionId: "k-1" });
    expect(flag(readCapturedArgs(CAP, "kimi"), "--session")).toBe("k-1");
    const old = run("kimi-cli", "old");
    expect(readCapturedArgs(CAP, "kimi")).not.toContain("--session");
    expect(old.sessionId).toBeNull();
    expect(old.warnings?.join(" ")).toContain("--session");
  }, spawnBudgetMs(4));

  test("grok: `--session-id` on a fresh run, `-r` on a resume", () => {
    const fresh = run("grok-cli", null);
    const argv = readCapturedArgs(CAP, "grok");
    expect(flag(argv, "--session-id")).toMatch(UUID);
    expect(fresh.sessionId).toBe(flag(argv, "--session-id")!);
    run("grok-cli", null, { sessionId: "g-1" });
    const resumed = readCapturedArgs(CAP, "grok");
    expect(flag(resumed, "-r")).toBe("g-1");
    expect(resumed).not.toContain("--session-id");
  }, spawnBudgetMs(2));
});

describe("a continued session runs where it was made", () => {
  test("the next worker resumes it from its own folder; a judge or router does not take it", () => {
    const home = fs.mkdtempSync(path.join(TMP, "earlier-run-"));
    const now = fs.mkdtempSync(path.join(TMP, "this-run-"));
    continueSessionOnNextWorker({ sessionId: "sess-earlier", runtime: "claude-code", workspace: home, fromProject: "p-earlier" });
    fs.rmSync(path.join(CAP, "claude-cwds"), { force: true });
    // An answer-only call (a router) and a call with no worker role pass it by.
    run("claude-code", null, { noTools: true, dispatchRole: "squad" });
    expect(readCapturedArgs(CAP, "claude")).not.toContain("--resume");
    run("claude-code", null);
    expect(readCapturedArgs(CAP, "claude")).not.toContain("--resume");
    // The worker takes it, in the earlier run's folder, not its own.
    const r = run("claude-code", null, { dispatchRole: "squad", workspace: now });
    expect(flag(readCapturedArgs(CAP, "claude"), "--resume")).toBe("sess-earlier");
    expect(r.sessionId).toBe("sess-earlier");
    expect(sessionHome("sess-earlier")).toBe(home);
    const cwds = fs.readFileSync(path.join(CAP, "claude-cwds"), "utf8").trim().split("\n");
    expect(fs.realpathSync(cwds[cwds.length - 1])).toBe(fs.realpathSync(home));
    // Consumed once: the next worker starts its own session.
    run("claude-code", null, { dispatchRole: "squad", workspace: now });
    expect(readCapturedArgs(CAP, "claude")).not.toContain("--resume");
    // A correction that resumes it later in this process runs there too, whatever folder it names.
    run("claude-code", null, { dispatchRole: "squad", workspace: now, sessionId: "sess-earlier" });
    const again = fs.readFileSync(path.join(CAP, "claude-cwds"), "utf8").trim().split("\n");
    expect(fs.realpathSync(again[again.length - 1])).toBe(fs.realpathSync(home));
  }, spawnBudgetMs(5));

  test("a session the runtime no longer knows: the worker starts fresh in its own folder, and says so", () => {
    const now = fs.mkdtempSync(path.join(TMP, "fresh-run-"));
    continueSessionOnNextWorker({ sessionId: "sess-pruned", runtime: "claude-code", workspace: null, fromProject: "p-old" });
    const r = run("claude-code", "missing", { dispatchRole: "solo", workspace: now });
    expect(r.ok).toBe(true);
    expect(readCapturedArgs(CAP, "claude")).not.toContain("--resume");
    expect(r.sessionId).toMatch(UUID);
    expect(r.warnings?.join(" ")).toContain("could not be resumed");
  }, spawnBudgetMs(2));

  test("a session on another runtime is never handed to this one", () => {
    continueSessionOnNextWorker({ sessionId: "thread-x", runtime: "codex", workspace: null, fromProject: "p" });
    run("claude-code", null, { dispatchRole: "squad" });
    expect(readCapturedArgs(CAP, "claude")).not.toContain("--resume");
    continueSessionOnNextWorker(null);
  }, spawnBudgetMs(1));
});

describe("what counts as a session that is gone", () => {
  test("the CLIs' own words for it; a quota or a model error is not one", () => {
    expect(looksLikeMissingSession("No conversation found with session ID: abc")).toBe(true);
    expect(looksLikeMissingSession('warning: conversation "x" not found')).toBe(true);
    expect(looksLikeMissingSession("Error: thread abc not found")).toBe(true);
    expect(looksLikeMissingSession("You've hit your usage limit")).toBe(false);
    expect(looksLikeMissingSession("Reached max turns (40)")).toBe(false);
    expect(looksLikeMissingSession(null)).toBe(false);
  });
});

describe("the orchestrator is told to revise, not re-dispatch", () => {
  const REPO = path.resolve(import.meta.dir, "..", "..", "..");
  const read = (...p: string[]) => fs.readFileSync(path.join(REPO, ...p), "utf8");

  test("harness SKILL.md: a change to dispatched work is a revise; decide is for the worker's questions; --continue-from for a new brief", () => {
    const skill = read("skills", "harness", "SKILL.md");
    expect(skill).toContain("A change to dispatched work is a revise, never a new dispatch.");
    expect(skill).toContain("## 7. Changes, corrections and follow-ups");
    expect(skill).toContain('nrv revise <project> "<the change>"');
    expect(skill).toContain("nrv revise --last [<business|squad>]");
    expect(skill).toContain("`nrv brief decide` is only for a question the worker asked while it runs.");
    expect(skill).toContain("--continue-from <project>");
  });

  test("nirvana SKILL.md and the agent contract say the same", () => {
    expect(read("skills", "nirvana", "SKILL.md")).toContain("goes back to the same worker, never a new dispatch: `nrv revise");
    for (const f of ["AGENTS.md", "CLAUDE.md", "GEMINI.md"]) expect(read(f)).toContain("which continues the worker's own\nsession; never a new dispatch");
  });
});
