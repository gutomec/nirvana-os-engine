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
  __testables,
  type Runtime,
} from "../../_shared/lib/host-agent-driver.ts";
import { writeFakeCli, readCapturedArgs, CAPTURE_PRELUDE } from "./helpers/fake-cli.ts";
import { spawnBudgetMs } from "./helpers/test-budgets.ts";

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
    console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } }));
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

function run(runtime: Runtime, mode?: "error") {
  if (mode) process.env.FAKE_MODE = mode;
  else delete process.env.FAKE_MODE;
  try {
    return runHeadless({ runtime, prompt: BIG, cwd: TMP, yolo: true, timeoutMs: 20_000 });
  } finally {
    delete process.env.FAKE_MODE;
  }
}

describe("driver adapters — 300KB prompt delivery + cost matrix", () => {
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
    run("antigravity-cli");
    run("grok-cli");
    run("pi");
    const leftovers = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith("nrv-prompt-"));
    expect(leftovers).toEqual([]);
  }, spawnBudgetMs(3));
});

describe("driver adapters — failure contract (error envelope on exit 0 → ok:false)", () => {
  test("claude-code: is_error:true", () => {
    const r = run("claude-code", "error");
    expect(r.exitCode).toBe(0);
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
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
