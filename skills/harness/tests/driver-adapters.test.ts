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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-driver-adapters-test-"));
const BIN = path.join(TMP, "bin");
const CAP = path.join(TMP, "capture");
fs.mkdirSync(BIN, { recursive: true });
fs.mkdirSync(CAP, { recursive: true });

const ORIGINAL_PATH = process.env.PATH;
const BIG = "x".repeat(300_000); // 300KB synthetic prompt — must clear every adapter

// Common shim preamble: capture argv (NUL-separated) for ARG_MAX assertions,
// and resolve the delivered prompt length from whichever channel the adapter
// uses (stdin is read by the shims that declare it).
const CAPTURE = [
  `{ for a in "$@"; do printf '%s\\0' "$a"; done; } > "$FAKE_CAPTURE_DIR/$(basename "$0")-args.bin" 2>/dev/null || true`,
].join("\n");
// Extract a bootstrap temp-prompt-file path from argv and print its byte size.
const PROMPT_FILE_LEN = [
  `PF=$(printf '%s\\n' "$@" | grep -oE '/[^[:space:]]*nrv-prompt-[^[:space:]]*\\.md' | head -1)`,
  `PLEN=0`,
  `if [ -n "$PF" ] && [ -f "$PF" ]; then PLEN=$(wc -c < "$PF" | tr -d ' '); fi`,
].join("\n");

function shim(name: string, body: string): void {
  const f = path.join(BIN, name);
  fs.writeFileSync(f, `#!/bin/bash\n${CAPTURE}\n${body}\n`);
  fs.chmodSync(f, 0o755);
}

beforeAll(() => {
  process.env.PATH = `${BIN}:${ORIGINAL_PATH}`;
  process.env.FAKE_CAPTURE_DIR = CAP;
  delete process.env.FAKE_MODE;

  // claude — STDIN delivery; native total_cost_usd; is_error envelope.
  shim("claude", [
    `IN=$(cat)`,
    `if [ "$FAKE_MODE" = "error" ]; then`,
    `  printf '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"boom","session_id":"s1","total_cost_usd":0.01}'`,
    `  exit 0`,
    `fi`,
    `printf '{"type":"result","is_error":false,"result":"len:%s","session_id":"s1","total_cost_usd":0.42}' "\${#IN}"`,
  ].join("\n"));

  // codex — STDIN delivery; JSONL events; error/turn.failed on exit 0; no USD.
  shim("codex", [
    `IN=$(cat)`,
    `OUT=""; prev=""`,
    `for a in "$@"; do if [ "$prev" = "-o" ]; then OUT="$a"; fi; prev="$a"; done`,
    `if [ "$FAKE_MODE" = "error" ]; then`,
    `  echo '{"type":"error","message":"upstream 500"}'`,
    `  exit 0`,
    `fi`,
    `[ -n "$OUT" ] && printf 'len:%s' "\${#IN}" > "$OUT"`,
    `echo '{"type":"thread.started","thread_id":"t1"}'`,
    `echo '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":5}}'`,
  ].join("\n"));

  // gemini — STDIN delivery (-p "" + stdin); error field in json envelope; no USD.
  shim("gemini", [
    `IN=$(cat)`,
    `if [ "$FAKE_MODE" = "error" ]; then`,
    `  printf '{"error":{"type":"QuotaError","message":"quota exhausted"},"session_id":"g1"}'`,
    `  exit 0`,
    `fi`,
    `printf '{"response":"ok","session_id":"g1","stats":{"models":{"m":{"tokens":{"input":%s,"candidates":3}}}}}' "\${#IN}"`,
  ].join("\n"));

  // agy — argv small / bootstrap prompt-file large; is_error envelope; no USD.
  shim("agy", [
    PROMPT_FILE_LEN,
    `if [ "$FAKE_MODE" = "error" ]; then`,
    `  printf '{"is_error":true,"error":{"message":"agy backend down"},"session_id":"a1"}'`,
    `  exit 0`,
    `fi`,
    `printf '{"response":"plen:%s","session_id":"a1"}' "$PLEN"`,
  ].join("\n"));

  // kimi — argv small / bootstrap prompt-file large; NDJSON; result event may
  // carry total_cost_usd (native extraction when reported).
  shim("kimi", [
    PROMPT_FILE_LEN,
    `if [ "$FAKE_MODE" = "error" ]; then`,
    `  echo '{"type":"error","message":"provider exploded"}'`,
    `  echo '{"type":"result","is_error":true,"error":"provider exploded"}'`,
    `  exit 0`,
    `fi`,
    `echo "{\\"type\\":\\"message\\",\\"text\\":\\"plen:$PLEN\\"}"`,
    `echo '{"type":"result","is_error":false,"total_cost_usd":0.07,"session_id":"k1"}'`,
  ].join("\n"));

  // grok — native --prompt-file; single json envelope; native total_cost_usd.
  shim("grok", [
    `PF=""; prev=""`,
    `for a in "$@"; do if [ "$prev" = "--prompt-file" ]; then PF="$a"; fi; prev="$a"; done`,
    `PLEN=0; if [ -n "$PF" ] && [ -f "$PF" ]; then PLEN=$(wc -c < "$PF" | tr -d ' '); fi`,
    `if [ "$FAKE_MODE" = "error" ]; then`,
    `  printf '{"is_error":true,"error":"xai upstream error","session_id":"gk1"}'`,
    `  exit 0`,
    `fi`,
    `printf '{"text":"plen:%s","session_id":"gk1","total_cost_usd":0.11}' "$PLEN"`,
  ].join("\n"));

  // pi — argv small / native @file attachment large; JSONL stream; stopReason
  // error on exit 0; native usage.cost.total.
  shim("pi", [
    `AF=""`,
    `for a in "$@"; do case "$a" in @*) AF="\${a#@}";; esac; done`,
    `PLEN=0; if [ -n "$AF" ] && [ -f "$AF" ]; then PLEN=$(wc -c < "$AF" | tr -d ' '); fi`,
    `echo '{"type":"session","id":"p1"}'`,
    `if [ "$FAKE_MODE" = "error" ]; then`,
    `  echo '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"failed"}],"stopReason":"error","errorMessage":"403 used all available credits"}}'`,
    `  exit 0`,
    `fi`,
    `echo "{\\"type\\":\\"message_end\\",\\"message\\":{\\"role\\":\\"assistant\\",\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"plen:$PLEN\\"}],\\"usage\\":{\\"cost\\":{\\"total\\":0.05}}}}"`,
  ].join("\n"));

  // qwen — STDIN delivery (gemini fork); plain text happy path, error field
  // envelope on failure; no USD.
  shim("qwen", [
    `IN=$(cat)`,
    `if [ "$FAKE_MODE" = "error" ]; then`,
    `  printf '{"error":{"message":"qwen quota"}}'`,
    `  exit 0`,
    `fi`,
    `printf 'len:%s' "\${#IN}"`,
  ].join("\n"));

  // opencode — argv small / bootstrap prompt-file large; exit code only.
  shim("opencode", [
    PROMPT_FILE_LEN,
    `if [ "$FAKE_MODE" = "error" ]; then`,
    `  echo "boom" >&2`,
    `  exit 1`,
    `fi`,
    `printf 'plen:%s' "$PLEN"`,
  ].join("\n"));
});

afterAll(() => {
  process.env.PATH = ORIGINAL_PATH;
  delete process.env.FAKE_CAPTURE_DIR;
  delete process.env.FAKE_MODE;
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ }
});

function capturedArgs(cli: string): string[] {
  const f = path.join(CAP, `${cli}-args.bin`);
  if (!fs.existsSync(f)) return [];
  const parts = fs.readFileSync(f, "utf8").split("\0");
  parts.pop(); // trailing NUL artifact only — interior empty args (-p "") are real
  return parts;
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
  });

  test("codex: STDIN; costUnavailable (tokens only, no USD)", () => {
    const r = run("codex");
    expect(r.ok).toBe(true);
    expect(r.result.startsWith("len:300000")).toBe(true);
    expect(r.sessionId).toBe("t1");
    expect(r.costUsd).toBeNull();
    expect(r.costUnavailable).toBe(true);
    assertArgvSafe("codex");
  });

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
  });

  test("antigravity-cli: bootstrap prompt-file above threshold; costUnavailable", () => {
    const r = run("antigravity-cli");
    expect(r.ok).toBe(true);
    expect(r.result).toBe("plen:300000"); // shim read the full prompt from the temp file
    expect(r.costUsd).toBeNull();
    expect(r.costUnavailable).toBe(true);
    assertArgvSafe("agy");
  });

  test("kimi-cli: bootstrap prompt-file; native cost from result event", () => {
    const r = run("kimi-cli");
    expect(r.ok).toBe(true);
    expect(r.result).toBe("plen:300000");
    expect(r.sessionId).toBe("k1");
    expect(r.costUsd).toBe(0.07);
    expect(r.costUnavailable).toBeUndefined();
    assertArgvSafe("kimi");
  });

  test("grok-cli: native --prompt-file; native cost", () => {
    const r = run("grok-cli");
    expect(r.ok).toBe(true);
    expect(r.result).toBe("plen:300000");
    expect(r.sessionId).toBe("gk1");
    expect(r.costUsd).toBe(0.11);
    expect(r.costUnavailable).toBeUndefined();
    assertArgvSafe("grok");
  });

  test("pi: native @file attachment; native summed cost", () => {
    const r = run("pi");
    expect(r.ok).toBe(true);
    expect(r.result).toBe("plen:300000");
    expect(r.sessionId).toBe("p1");
    expect(r.costUsd).toBe(0.05);
    expect(r.costUnavailable).toBeUndefined();
    assertArgvSafe("pi");
  });

  test("qwen-code: STDIN; costUnavailable", () => {
    const r = run("qwen-code");
    expect(r.ok).toBe(true);
    expect(r.result).toBe("len:300000");
    expect(r.costUsd).toBeNull();
    expect(r.costUnavailable).toBe(true);
    assertArgvSafe("qwen");
  });

  test("opencode: bootstrap prompt-file; costUnavailable", () => {
    const r = run("opencode");
    expect(r.ok).toBe(true);
    expect(r.result).toBe("plen:300000");
    expect(r.costUsd).toBeNull();
    expect(r.costUnavailable).toBe(true);
    assertArgvSafe("opencode");
  });

  test("temp prompt files are cleaned up after the run", () => {
    run("antigravity-cli");
    run("grok-cli");
    run("pi");
    const leftovers = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith("nrv-prompt-"));
    expect(leftovers).toEqual([]);
  });
});

describe("driver adapters — failure contract (error envelope on exit 0 → ok:false)", () => {
  test("claude-code: is_error:true", () => {
    const r = run("claude-code", "error");
    expect(r.exitCode).toBe(0);
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });

  test("codex: terminal error event", () => {
    const r = run("codex", "error");
    expect(r.exitCode).toBe(0);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("upstream 500");
  });

  test("gemini-cli: error field in envelope", () => {
    const r = run("gemini-cli", "error");
    expect(r.exitCode).toBe(0);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("quota exhausted");
  });

  test("antigravity-cli: is_error + error object", () => {
    const r = run("antigravity-cli", "error");
    expect(r.exitCode).toBe(0);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("agy backend down");
  });

  test("kimi-cli: error event + result is_error", () => {
    const r = run("kimi-cli", "error");
    expect(r.exitCode).toBe(0);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("provider exploded");
  });

  test("grok-cli: is_error + error string", () => {
    const r = run("grok-cli", "error");
    expect(r.exitCode).toBe(0);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("xai upstream error");
  });

  test("pi: stopReason=error in stream (the original quirk)", () => {
    const r = run("pi", "error");
    expect(r.exitCode).toBe(0);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("403");
  });

  test("qwen-code: error field in envelope", () => {
    const r = run("qwen-code", "error");
    expect(r.exitCode).toBe(0);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("qwen quota");
  });

  test("opencode: non-zero exit (only signal it has)", () => {
    const r = run("opencode", "error");
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(1);
    expect(r.error).toContain("boom");
  });
});

describe("light layer — callHostAgent / callHostAgentAsync", () => {
  test("callHostAgent delivers a 300KB message via STDIN to the detected host (claude)", () => {
    const r = callHostAgent("small persona", BIG, { timeoutMs: 20_000 });
    expect("text" in r && r.text).toBe("len:300000");
    if ("host" in r) expect(r.host).toBe("claude-code");
    assertArgvSafe("claude");
  });

  test("callHostAgentAsync honors legacy __testRuntime shape (buildArgs only)", async () => {
    const legacy = {
      name: "legacy-fake",
      cli: path.join(BIN, "legacy-fake"),
      buildArgs: (_p: string, _u: string) => ["ignored-arg"],
      parseStdout: (s: string) => s.trim(),
    };
    fs.writeFileSync(legacy.cli, `#!/bin/bash\necho legacy-ok\n`);
    fs.chmodSync(legacy.cli, 0o755);
    const r = await callHostAgentAsync("", "hi", { __testRuntime: legacy, timeoutMs: 10_000, heartbeatMs: 0 });
    expect("text" in r && r.text).toBe("legacy-ok");
  });

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
