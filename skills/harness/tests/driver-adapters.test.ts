// driver-adapters.test.ts — per-adapter contract of the unified driver
// (skills/_shared/lib/host-agent-driver.ts), against fake CLI shims on a
// temp PATH. Verifies, for all 9 runtimes:
//   1. DELIVERY: a synthetic 300KB prompt reaches the CLI intact and no argv
//      element ever carries it (ARG_MAX safety: STDIN / --prompt-file /
//      bootstrap temp file / pi @file, per adapter).
//   2. COST: native USD extracted where the CLI reports it (claude, grok,
//      pi, kimi result event); explicit costUnavailable elsewhere — distinct
//      from a reported $0.
//   3. FAILURE CONTRACT: an error envelope/stream on EXIT 0 yields ok:false
//      (the pi exit-0-on-provider-failure pattern, generalized).
// Plus light-layer checks (callHostAgent stdin delivery, legacy __testRuntime
// shape, persona-truncation warning).
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  runHeadless,
  callHostAgent,
  callHostAgentAsync,
  MAX_ARGV_PROMPT_BYTES,
  reapOrphanedPromptFiles,
  __testables,
  type Runtime,
  RUNTIME_DIR_GRANT_FLAG, type RunHeadlessOpts,
} from "../../_shared/lib/host-agent-driver.ts";
import { writeFakeCli, readCapturedArgs, CAPTURE_PRELUDE } from "./helpers/fake-cli.ts";
import { spawnBudgetMs } from "./helpers/test-budgets.ts";
import { makeTempRoot, removeDir } from "./helpers/temp-dirs.ts";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-driver-adapters-test-"));
const BIN = path.join(TMP, "bin");
const CAP = path.join(TMP, "capture");
fs.mkdirSync(BIN, { recursive: true });
fs.mkdirSync(CAP, { recursive: true });

const ORIGINAL_PATH = process.env.PATH;
const BIG = "x".repeat(300_000); // 300KB synthetic prompt — must clear every adapter

// The fakes below are Bun/TypeScript, launched per-OS by fake-cli.ts. They used
// to be bash scripts, which is why this entire file was red on Windows: the OS
// resolves neither an extensionless file nor a shebang, so nothing under test
// ever ran there. On Windows they now land as `.cmd` — the same shape npm gives
// a real agent CLI — which is what makes the driver's own .cmd handling testable.
function fake(name: string, body: string): void {
  writeFakeCli(BIN, name, CAPTURE_PRELUDE + body);
}

beforeAll(() => {
  // path.delimiter, not ":" — Windows separates PATH entries with ";".
  process.env.PATH = `${BIN}${path.delimiter}${ORIGINAL_PATH}`;
  process.env.FAKE_CAPTURE_DIR = CAP;
  delete process.env.FAKE_MODE;

  // claude — STDIN delivery; native total_cost_usd; is_error envelope.
  fake("claude", `
    const len = await stdinLen();
    if (process.env.FAKE_MODE === "error") {
      process.stdout.write(JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, result: "boom", session_id: "s1", total_cost_usd: 0.01 }));
      process.exit(0);
    }
    if (process.env.FAKE_MODE === "budget") {
      // A cap stops the run before any text: no result, no stderr, only the subtype says why.
      process.stdout.write(JSON.stringify({ type: "result", subtype: "error_max_budget_usd", is_error: true, session_id: "s1", total_cost_usd: 3.0 }));
      process.exit(0);
    }
    process.stdout.write(JSON.stringify({ type: "result", is_error: false, result: "len:" + len, session_id: "s1", total_cost_usd: 0.42 }));
  `);

  // codex — STDIN delivery; JSONL events; error on exit 0; no USD.
  fake("codex", `
    const len = await stdinLen();
    const oi = argv.indexOf("-o");
    const out = oi >= 0 ? argv[oi + 1] : "";
    if (process.env.FAKE_MODE === "error") {
      console.log(JSON.stringify({ type: "error", message: "upstream 500" }));
      process.exit(0);
    }
    if (out) { try { fs.writeFileSync(out, "len:" + len); } catch {} }
    console.log(JSON.stringify({ type: "thread.started", thread_id: "t1" }));
    console.log(JSON.stringify({ type: "turn.started" }));
    // A notice, not a failure: codex reports skill-budget truncation and an MCP
    // server that did not start as an item of type error and completes the turn.
    console.log(JSON.stringify({ type: "item.completed", item: { id: "item_0", type: "error", message: "Skill descriptions were shortened to fit the skills context budget." } }));
    console.log(JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "len:" + len } }));
    console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 4, cache_write_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 2 } }));
  `);

  // gemini — STDIN delivery (-p "" + stdin); error field in envelope; no USD.
  fake("gemini", `
    const len = await stdinLen();
    if (process.env.FAKE_MODE === "error") {
      process.stdout.write(JSON.stringify({ error: { type: "QuotaError", message: "quota exhausted" }, session_id: "g1" }));
      process.exit(0);
    }
    process.stdout.write(JSON.stringify({ response: "ok", session_id: "g1", stats: { models: { m: { tokens: { input: len, candidates: 3 } } } } }));
  `);

  // agy — argv small / bootstrap prompt-file large; is_error envelope; no USD.
  fake("agy", `
    const plen = promptFileLen();
    if (process.env.FAKE_MODE === "error") {
      process.stdout.write(JSON.stringify({ is_error: true, error: { message: "agy backend down" }, session_id: "a1" }));
      process.exit(0);
    }
    process.stdout.write(JSON.stringify({ response: "plen:" + plen, session_id: "a1" }));
  `);

  // kimi — bootstrap prompt-file; NDJSON; result event may carry total_cost_usd.
  fake("kimi", `
    const plen = promptFileLen();
    if (process.env.FAKE_MODE === "error") {
      console.log(JSON.stringify({ type: "error", message: "provider exploded" }));
      console.log(JSON.stringify({ type: "result", is_error: true, error: "provider exploded" }));
      process.exit(0);
    }
    console.log(JSON.stringify({ type: "message", text: "plen:" + plen }));
    console.log(JSON.stringify({ type: "result", is_error: false, total_cost_usd: 0.07, session_id: "k1" }));
  `);

  // grok — native --prompt-file; single json envelope; native total_cost_usd.
  fake("grok", `
    const plen = promptFileLen();
    if (process.env.FAKE_MODE === "error") {
      process.stdout.write(JSON.stringify({ is_error: true, error: "xai upstream error", session_id: "gk1" }));
      process.exit(0);
    }
    process.stdout.write(JSON.stringify({ text: "plen:" + plen, session_id: "gk1", total_cost_usd: 0.11 }));
  `);

  // pi — native @file attachment; JSONL stream; stopReason error on exit 0.
  fake("pi", `
    let attached = "";
    for (const a of argv) if (a.startsWith("@")) attached = a.slice(1);
    let plen = 0;
    try { plen = fs.statSync(attached).size; } catch {}
    console.log(JSON.stringify({ type: "session", id: "p1" }));
    if (process.env.FAKE_MODE === "error") {
      console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "failed" }], stopReason: "error", errorMessage: "403 used all available credits" } }));
      process.exit(0);
    }
    console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "plen:" + plen }], usage: { cost: { total: 0.05 } } } }));
  `);

  // qwen — STDIN delivery (gemini fork); plain text happy path; no USD.
  fake("qwen", `
    const len = await stdinLen();
    if (process.env.FAKE_REJECT_INCLUDE && argv.includes("--include-directories")) {
      process.stderr.write("error: unknown option '--include-directories'");
      process.exit(2);
    }
    if (process.env.FAKE_MODE === "error") {
      process.stdout.write(JSON.stringify({ error: { message: "qwen quota" } }));
      process.exit(0);
    }
    process.stdout.write("len:" + len);
  `);

  // opencode — bootstrap prompt-file; exit code only.
  fake("opencode", `
    const plen = promptFileLen();
    if (process.env.FAKE_MODE === "error") {
      console.error("boom");
      process.exit(1);
    }
    process.stdout.write("plen:" + plen);
  `);
});

afterAll(() => {
  process.env.PATH = ORIGINAL_PATH;
  delete process.env.FAKE_CAPTURE_DIR;
  delete process.env.FAKE_MODE;
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ }
});

function capturedArgs(cli: string): string[] {
  return readCapturedArgs(CAP, cli);
}

function assertArgvSafe(cli: string): void {
  const args = capturedArgs(cli);
  expect(args.length).toBeGreaterThan(0);
  for (const a of args) {
    // No argv element may carry the 300KB prompt (Linux MAX_ARG_STRLEN ~128KB).
    expect(Buffer.byteLength(a, "utf8")).toBeLessThanOrEqual(MAX_ARGV_PROMPT_BYTES + 2_000);
  }
}

function run(runtime: Runtime, mode?: "error" | "budget") {
  if (mode) process.env.FAKE_MODE = mode;
  else delete process.env.FAKE_MODE;
  try {
    return runHeadless({ runtime, prompt: BIG, cwd: TMP, yolo: true, timeoutMs: 20_000 });
  } finally {
    delete process.env.FAKE_MODE;
  }
}

function runWith(runtime: Runtime, extra: Partial<RunHeadlessOpts>) {
  delete process.env.FAKE_MODE;
  return runHeadless({ runtime, prompt: "small prompt", cwd: TMP, yolo: true, timeoutMs: 20_000, ...extra });
}

describe("driver adapters — 300KB prompt delivery + cost matrix", () => {
  // The guard used to be one POSIX-sized number on all three systems. Linux and
  // macOS measure a per-argument limit in the hundreds of KB, but Windows caps
  // the WHOLE command line — 32,767 chars through CreateProcess, 8,191 through
  // the command interpreter, which resolveExecutable still takes for a .cmd shim
  // it cannot read. At 100,000 the argv adapters (agy, kimi, opencode, pi) would
  // build a Windows command line they believed safe and watch the interpreter cut
  // it. This runs on all three CI systems, so each branch is exercised where it
  // is true rather than asserted from the other side.
  test("the argv guard respects the platform's real command-line limit", () => {
    if (process.platform === "win32") {
      // Under the interpreter's 8,191, with room for the flags, the model name,
      // every --add-dir and the interpreter's own path.
      expect(MAX_ARGV_PROMPT_BYTES).toBeLessThan(8_191);
      // Still large enough that an ordinary prompt stays on argv.
      expect(MAX_ARGV_PROMPT_BYTES).toBeGreaterThanOrEqual(4_096);
    } else {
      expect(MAX_ARGV_PROMPT_BYTES).toBe(100_000);
    }
  });

  test("claude-code: STDIN; native cost", () => {
    const r = run("claude-code");
    expect(r.ok).toBe(true);
    expect(r.result).toBe("len:300000");
    expect(r.sessionId).toBe("s1");
    expect(r.costUsd).toBe(0.42);
    expect(r.costUnavailable).toBeUndefined();
    assertArgvSafe("claude");
  }, spawnBudgetMs(2));

  test("codex: STDIN; costUnavailable (tokens only, no USD)", () => {
    const r = run("codex");
    expect(r.ok).toBe(true);
    expect(r.result.startsWith("len:300000")).toBe(true);
    expect(r.sessionId).toBe("t1");
    expect(r.costUsd).toBeNull();
    expect(r.costUnavailable).toBe(true);
    assertArgvSafe("codex");
  }, spawnBudgetMs(2));

  test("gemini-cli: STDIN via -p ''; costUnavailable", () => {
    const r = run("gemini-cli");
    expect(r.ok).toBe(true);
    expect(r.result).toContain('"input":300000'); // full envelope kept for cost-estimator
    expect(r.sessionId).toBe("g1");
    expect(r.costUsd).toBeNull();
    expect(r.costUnavailable).toBe(true);
    const args = capturedArgs("gemini");
    const p = args.indexOf("-p");
    expect(p).toBeGreaterThanOrEqual(0);
    expect(args[p + 1]).toBe(""); // prompt rides stdin, not argv
    assertArgvSafe("gemini");
  }, spawnBudgetMs(2));

  test("antigravity-cli: bootstrap prompt-file above threshold; costUnavailable", () => {
    const r = run("antigravity-cli");
    expect(r.ok).toBe(true);
    expect(r.result).toBe("plen:300000"); // shim read the full prompt from the temp file
    expect(r.costUsd).toBeNull();
    expect(r.costUnavailable).toBe(true);
    assertArgvSafe("agy");
  }, spawnBudgetMs(2));

  test("kimi-cli: bootstrap prompt-file; native cost from result event", () => {
    const r = run("kimi-cli");
    expect(r.ok).toBe(true);
    expect(r.result).toBe("plen:300000");
    expect(r.sessionId).toBe("k1");
    expect(r.costUsd).toBe(0.07);
    expect(r.costUnavailable).toBeUndefined();
    assertArgvSafe("kimi");
  }, spawnBudgetMs(2));

  test("grok-cli: native --prompt-file; native cost", () => {
    const r = run("grok-cli");
    expect(r.ok).toBe(true);
    expect(r.result).toBe("plen:300000");
    expect(r.sessionId).toBe("gk1");
    expect(r.costUsd).toBe(0.11);
    expect(r.costUnavailable).toBeUndefined();
    assertArgvSafe("grok");
  }, spawnBudgetMs(2));

  test("pi: native @file attachment; native summed cost", () => {
    const r = run("pi");
    expect(r.ok).toBe(true);
    expect(r.result).toBe("plen:300000");
    expect(r.sessionId).toBe("p1");
    expect(r.costUsd).toBe(0.05);
    expect(r.costUnavailable).toBeUndefined();
    assertArgvSafe("pi");
  }, spawnBudgetMs(2));

  test("qwen-code: STDIN; costUnavailable", () => {
    const r = run("qwen-code");
    expect(r.ok).toBe(true);
    expect(r.result).toBe("len:300000");
    expect(r.costUsd).toBeNull();
    expect(r.costUnavailable).toBe(true);
    assertArgvSafe("qwen");
  }, spawnBudgetMs(2));

  test("opencode: bootstrap prompt-file; costUnavailable", () => {
    const r = run("opencode");
    expect(r.ok).toBe(true);
    expect(r.result).toBe("plen:300000");
    expect(r.costUsd).toBeNull();
    expect(r.costUnavailable).toBe(true);
    assertArgvSafe("opencode");
  }, spawnBudgetMs(2));

  test("temp prompt files are cleaned up after the run", () => {
    // Scoped to what THIS test creates: os.tmpdir() is shared with every other
    // process on the machine, so asserting on its full listing turns any
    // foreign nrv-prompt-* leftover (a dead session, another dispatch) into a
    // failure of this run. Snapshot before, diff after.
    const before = new Set(fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith("nrv-prompt-")));
    run("antigravity-cli");
    run("grok-cli");
    run("pi");
    const after = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith("nrv-prompt-"));
    const leftoversFromThisRun = after.filter((f) => !before.has(f));
    expect(leftoversFromThisRun).toEqual([]);
  }, spawnBudgetMs(3));

  test("reapOrphanedPromptFiles: process-wide cleanup for what a killed process's own finally could never reach", () => {
    // Its own scoped directory, not os.tmpdir() — the reaper is a machine-wide
    // sweep by design (see host-agent-driver.ts), so it must be pointed at a
    // private root here or it would also judge every real leftover on this box.
    const scratch = makeTempRoot("nrv-reap-test-");
    try {
      const stale = path.join(scratch, "nrv-prompt-old-123.md");
      const fresh = path.join(scratch, "nrv-prompt-fresh-456.md");
      const unrelated = path.join(scratch, "not-ours-789.md");
      fs.writeFileSync(stale, "stale");
      fs.writeFileSync(fresh, "fresh");
      fs.writeFileSync(unrelated, "unrelated");
      const old = new Date(Date.now() - 25 * 60 * 60_000); // 25h ago > the 24h default
      fs.utimesSync(stale, old, old);

      const removed = reapOrphanedPromptFiles({ dir: scratch });

      expect(removed).toEqual([stale]);
      expect(fs.existsSync(stale)).toBe(false);
      expect(fs.existsSync(fresh)).toBe(true);      // too young — still a live run's file, by all evidence available
      expect(fs.existsSync(unrelated)).toBe(true);  // wrong prefix — not this driver's file at all
    } finally {
      removeDir(scratch);
    }
  }, spawnBudgetMs(1));
});

describe("driver adapters — failure contract (error envelope on exit 0 → ok:false)", () => {
  test("claude-code: is_error:true — and the CAUSE surfaces in error", () => {
    const r = run("claude-code", "error");
    expect(r.exitCode).toBe(0);
    expect(r.ok).toBe(false);
    // The claude CLI puts the cause in `result` and leaves stderr empty on an
    // error verdict. A truthy-only assertion let the generic fallback pass
    // while the real cause sat unread — callers then retried blind, paying for
    // attempts that were doomed for the same unreported reason.
    expect(r.error).toContain("boom");
  }, spawnBudgetMs(2));

  test("claude-code: a cap that stops the run before any text names itself through the subtype", () => {
    const r = run("claude-code", "budget");
    expect(r.ok).toBe(false);
    // No result and no stderr: the subtype is the only cause on offer, and a
    // caller retrying blind against a budget cap pays the cap again each time.
    expect(r.error).toContain("error_max_budget_usd");
    expect(r.error).not.toContain('""');
  }, spawnBudgetMs(2));

  test("codex: terminal error event", () => {
    const r = run("codex", "error");
    expect(r.exitCode).toBe(0);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("upstream 500");
  }, spawnBudgetMs(2));

  test("gemini-cli: error field in envelope", () => {
    const r = run("gemini-cli", "error");
    expect(r.exitCode).toBe(0);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("quota exhausted");
  }, spawnBudgetMs(2));

  test("antigravity-cli: is_error + error object", () => {
    const r = run("antigravity-cli", "error");
    expect(r.exitCode).toBe(0);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("agy backend down");
  }, spawnBudgetMs(2));

  test("kimi-cli: error event + result is_error", () => {
    const r = run("kimi-cli", "error");
    expect(r.exitCode).toBe(0);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("provider exploded");
  }, spawnBudgetMs(2));

  test("grok-cli: is_error + error string", () => {
    const r = run("grok-cli", "error");
    expect(r.exitCode).toBe(0);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("xai upstream error");
  }, spawnBudgetMs(2));

  test("pi: stopReason=error in stream (the original quirk)", () => {
    const r = run("pi", "error");
    expect(r.exitCode).toBe(0);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("403");
  }, spawnBudgetMs(2));

  test("qwen-code: error field in envelope", () => {
    const r = run("qwen-code", "error");
    expect(r.exitCode).toBe(0);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("qwen quota");
  }, spawnBudgetMs(2));

  test("opencode: non-zero exit (only signal it has)", () => {
    const r = run("opencode", "error");
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(1);
    expect(r.error).toContain("boom");
  }, spawnBudgetMs(2));
});

describe("light layer — callHostAgent / callHostAgentAsync", () => {
  test("callHostAgent delivers a 300KB message via STDIN to the detected host (claude)", () => {
    const r = callHostAgent("small persona", BIG, { timeoutMs: 20_000 });
    expect("text" in r && r.text).toBe("len:300000");
    if ("host" in r) expect(r.host).toBe("claude-code");
    assertArgvSafe("claude");
  }, spawnBudgetMs(2));

  test("callHostAgentAsync honors legacy __testRuntime shape (buildArgs only)", async () => {
    // Spawn the interpreter directly (see fake-cli.ts): the legacy shape carries
    // the CLI as an absolute path, so there is no PATH lookup to exercise here
    // and no reason to put a launcher between the driver and the process.
    const legacyScript = path.join(BIN, "legacy-fake.ts");
    fs.writeFileSync(legacyScript, `console.log("legacy-ok");\n`);
    const legacy = {
      name: "legacy-fake",
      cli: process.execPath,
      buildArgs: (_p: string, _u: string) => [legacyScript],
      parseStdout: (s: string) => s.trim(),
    };
    const r = await callHostAgentAsync("", "hi", { __testRuntime: legacy, timeoutMs: 10_000, heartbeatMs: 0 });
    expect("text" in r && r.text).toBe("legacy-ok");
  }, spawnBudgetMs(2));

  test("persona truncation warns on stderr with sizes", () => {
    const seen: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => { seen.push(a.join(" ")); };
    try {
      const out = __testables.clampPersona("p".repeat(9_000), "claude-code");
      expect(out.length).toBe(8_000);
    } finally {
      console.error = orig;
    }
    expect(seen.some((m) => m.includes("9000") && m.includes("8000") && m.includes("claude-code"))).toBe(true);
  });

  test("small prompts still travel via argv on threshold adapters (no temp file)", () => {
    const call = __testables.argvOrPromptFile("small prompt", (p) => ["-p", p]);
    expect(call.args).toEqual(["-p", "small prompt"]);
    expect(call.tmpFiles).toBeUndefined();
  });
});

describe("directory grants — every runtime that has a flag passes it; the rest say so", () => {
  const dirs = [path.join(TMP, "project"), path.join(TMP, "outputs")];

  test("the grant table names a flag for the runtimes whose CLIs have one", () => {
    expect(RUNTIME_DIR_GRANT_FLAG["claude-code"]).toBe("--add-dir");
    expect(RUNTIME_DIR_GRANT_FLAG.codex).toBe("--add-dir");
    expect(RUNTIME_DIR_GRANT_FLAG["gemini-cli"]).toBe("--include-directories");
    expect(RUNTIME_DIR_GRANT_FLAG["antigravity-cli"]).toBe("--add-dir");
    expect(RUNTIME_DIR_GRANT_FLAG["qwen-code"]).toBe("--include-directories");
  });

  for (const [runtime, cli] of [["claude-code", "claude"], ["codex", "codex"], ["gemini-cli", "gemini"], ["antigravity-cli", "agy"], ["qwen-code", "qwen"]] as const) {
    test(`${runtime}: each extra directory rides argv behind ${RUNTIME_DIR_GRANT_FLAG[runtime]}`, () => {
      const r = runWith(runtime, { addDirs: dirs });
      expect(r.ok).toBe(true);
      const args = capturedArgs(cli);
      const flag = RUNTIME_DIR_GRANT_FLAG[runtime]!;
      for (const d of dirs) {
        const i = args.indexOf(d);
        expect(i).toBeGreaterThan(0);
        expect(args[i - 1]).toBe(flag);
      }
      // Other notices may ride along (the codex fake emits one); a grant notice may not.
      expect((r.warnings ?? []).some(w => w.includes("no directory-grant flag"))).toBe(false);
    }, spawnBudgetMs(2));
  }

  for (const runtime of ["grok-cli", "pi", "kimi-cli", "opencode"] as const) {
    test(`${runtime}: no flag → the result says the grant did not happen`, () => {
      const r = runWith(runtime, { addDirs: dirs });
      expect(RUNTIME_DIR_GRANT_FLAG[runtime]).toBeNull();
      expect(r.warnings?.length).toBe(1);
      expect(r.warnings![0]).toContain("no directory-grant flag");
      expect(r.warnings![0]).toContain(dirs[0]);
    }, spawnBudgetMs(2));
  }

  test("qwen-code: a build that rejects --include-directories is retried without it", () => {
    process.env.FAKE_REJECT_INCLUDE = "1";
    try {
      const r = runWith("qwen-code", { addDirs: dirs });
      expect(r.ok).toBe(true);
      expect(capturedArgs("qwen")).not.toContain("--include-directories");
    } finally { delete process.env.FAKE_REJECT_INCLUDE; }
  }, spawnBudgetMs(3));
});

describe("codex — flags audited against 0.153.4, usage and notices", () => {
  test("trust: bypass flag; grants, model and provider as -c", () => {
    const r = runWith("codex", { addDirs: [path.join(TMP, "biz")], model: "gpt-5.5", providerHint: "openai" });
    expect(r.ok).toBe(true);
    const args = capturedArgs("codex");
    expect(args).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(args).not.toContain("--provider");
    expect(args).toContain('model_provider="openai"');
    expect(args[args.indexOf("--model") + 1]).toBe("gpt-5.5");
    expect(args).not.toContain("--ephemeral");
    expect(args).not.toContain("-s");
  }, spawnBudgetMs(2));

  test("--safe: the sandbox stays and approvals go to the reviewer agent", () => {
    runWith("codex", { yolo: false });
    const args = capturedArgs("codex");
    expect(args[args.indexOf("-s") + 1]).toBe("workspace-write");
    expect(args).toContain("--approve-for-me");
    expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
  }, spawnBudgetMs(2));

  test("a Claude alias never reaches --model; an OpenAI id does", () => {
    runWith("codex", { model: "opus" });
    expect(capturedArgs("codex")).not.toContain("--model");
    runWith("codex", { model: "gpt-6-astra" });
    expect(capturedArgs("codex")).toContain("gpt-6-astra");
  }, spawnBudgetMs(3));

  test("ephemeral, output schema, images and web search ride argv; ephemeral yields to resume", () => {
    const schema = path.join(TMP, "verdict.schema.json");
    fs.writeFileSync(schema, "{}");
    runWith("codex", { ephemeral: true, outputSchema: schema, images: [path.join(TMP, "a.png")], webSearch: "live" });
    let args = capturedArgs("codex");
    expect(args).toContain("--ephemeral");
    expect(args[args.indexOf("--output-schema") + 1]).toBe(schema);
    expect(args[args.indexOf("-i") + 1]).toBe(path.join(TMP, "a.png"));
    expect(args).toContain('web_search="live"');
    runWith("codex", { ephemeral: true, sessionId: "t1" });
    args = capturedArgs("codex");
    expect(args.slice(0, 3)).toEqual(["exec", "resume", "t1"]);
    expect(args).not.toContain("--ephemeral");
  }, spawnBudgetMs(3));

  test("usage comes back whole and a notice item is a warning, not a failure", () => {
    const r = runWith("codex", {});
    expect(r.ok).toBe(true);
    expect(r.usage).toEqual({ inputTokens: 10, cachedInputTokens: 4, cacheWriteInputTokens: 0, outputTokens: 5, reasoningOutputTokens: 2 });
    expect(r.warnings).toEqual(["Skill descriptions were shortened to fit the skills context budget."]);
  }, spawnBudgetMs(2));
});
