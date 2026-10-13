// runtime-cli-contracts.test.ts — argv and stream contracts from the 2026-10-11 runtime audit.
//
//   grok   `--trust` loads project AGENTS.md, skills and MCP in a fresh run folder; a build
//          that rejects it while parsing argv is retried once without it.
//   pi     1.0.0 aborts on `--provider` without `--model`; the prompt goes after `--` so a
//          brief starting with `-` or `---` is not read as an option.
//   kimi   stream-json is one message per line; only assistant messages make the result,
//          never a Tool message's output. Grants travel as `--add-dir`.
//   both   a run is spawned again only on proof that argv parsing refused the flag before
//          any model call (argvRejectedFlag); "unknown" in a paid turn's output is not proof.
//          grok's `{"type":"error","message"}` envelope is the error text.
// Hermetic: fake CLIs on a temp PATH that record argv. No LLM, no network.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { argvRejectedFlag, runHeadless } from "../../_shared/lib/host-agent-driver.ts";
import { writeFakeCli } from "./helpers/fake-cli.ts";
import { spawnBudgetMs } from "./helpers/test-budgets.ts";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-cli-contracts-"));
const BIN = path.join(TMP, "bin");
const CALLS = path.join(TMP, "calls");
const MODE = path.join(TMP, "mode");
const SAVED = { PATH: process.env.PATH, NIRVANA_MODEL: process.env.NIRVANA_MODEL };

const RECORD = `
import * as fs from "node:fs";
import * as path from "node:path";
const argv = Bun.argv.slice(2);
const name = path.basename(import.meta.path).replace(/\\.ts$/, "");
fs.mkdirSync(${JSON.stringify(CALLS)}, { recursive: true });
fs.appendFileSync(path.join(${JSON.stringify(CALLS)}, name + ".jsonl"), JSON.stringify(argv) + "\\n");
const mode = fs.existsSync(${JSON.stringify(MODE)}) ? fs.readFileSync(${JSON.stringify(MODE)}, "utf8") : "";
`;

beforeAll(() => {
  writeFakeCli(BIN, "grok", RECORD + `
    if (mode === "no-trust" && argv.includes("--trust")) {
      console.error("error: unexpected argument '--trust' found");
      process.exit(2);
    }
    // A turn that ran and failed: grok's error envelope, exit 1, "unknown" all over stderr.
    if (mode === "paid-unknown") {
      console.error("error: unknown error; unexpected argument '--trust' in tool output");
      process.stdout.write(JSON.stringify({ type: "error", message: "unknown model grok-x" }));
      process.exit(1);
    }
    // exit 2 and the flag named, but a session on stdout: the turn started.
    if (mode === "trust-with-json" && argv.includes("--trust")) {
      console.error("error: unexpected argument '--trust' found");
      process.stdout.write(JSON.stringify({ sessionId: "gk1", text: "partial" }));
      process.exit(2);
    }
    if (mode === "other-flag") { console.error("error: unexpected argument '--bogus' found"); process.exit(2); }
    if (mode === "no-output-format" && argv.includes("--output-format")) {
      console.error("error: unexpected argument '--output-format' found");
      process.exit(2);
    }
    if (mode === "no-output-format") { process.stdout.write("plain answer"); process.exit(0); }
    process.stdout.write(JSON.stringify({ text: "ok", sessionId: "gk1" }));
  `);
  writeFakeCli(BIN, "pi", RECORD + `
    if (argv.includes("--provider") && !argv.includes("--model")) { console.error("--provider requires --model"); process.exit(1); }
    console.log(JSON.stringify({ type: "session", id: "p1" }));
    console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } }));
  `);
  writeFakeCli(BIN, "kimi", RECORD + `
    if (mode === "legacy" && argv.includes("--add-dir")) { console.error("Error: No such option: --add-dir"); process.exit(2); }
    // commander: exit 1 is its usage code too, so the named flag is the proof.
    if (mode === "commander" && argv.includes("--add-dir")) { console.error("error: unknown option '--add-dir'"); process.exit(1); }
    if (mode === "add-dir-with-json" && argv.includes("--add-dir")) {
      console.log(JSON.stringify({ role: "assistant", content: "started" }));
      console.error("Error: No such option: --add-dir");
      process.exit(2);
    }
    if (mode === "paid-unknown") {
      console.log(JSON.stringify({ role: "assistant", content: "half done" }));
      console.error("provider error: unknown finish reason; unrecognized option in tool call");
      process.exit(1);
    }
    if (mode === "no-stream-json" && argv.includes("--output-format")) {
      console.error("Error: Invalid value for '--output-format': 'stream-json' is not one of 'text'.");
      process.exit(2);
    }
    if (mode === "no-stream-json") { console.log("plain answer"); process.exit(0); }
    const lines = [
      { role: "assistant", content: "Vou ler o arquivo.", tool_calls: [{ id: "t1", type: "function", function: { name: "ReadFile", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "t1", content: "SECRET FILE DUMP 0123456789" },
      { role: "assistant", content: [{ type: "text", text: "Resumo final: " }, { type: "text", text: "três itens." }] },
    ];
    for (const line of lines) console.log(JSON.stringify(line));
  `);
  process.env.PATH = `${BIN}${path.delimiter}${SAVED.PATH ?? ""}`;
  delete process.env.NIRVANA_MODEL;
});

afterAll(() => {
  for (const [k, v] of Object.entries(SAVED)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ }
});

function calls(cli: string): string[][] {
  try { return fs.readFileSync(path.join(CALLS, `${cli}.jsonl`), "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l)); }
  catch { return []; }
}
function reset(mode = ""): void {
  fs.writeFileSync(MODE, mode);
  fs.rmSync(CALLS, { recursive: true, force: true });
}

describe("grok-cli", () => {
  test("--trust rides the autonomous path", () => {
    reset();
    const r = runHeadless({ runtime: "grok-cli", prompt: "do", cwd: TMP, timeoutMs: 20_000 });
    expect(r.ok, r.error ?? r.stderr).toBe(true);
    expect(calls("grok")).toHaveLength(1);
    expect(calls("grok")[0]).toContain("--trust");
  }, spawnBudgetMs(2));

  test("a build that rejects --trust while parsing argv is retried once without it", () => {
    reset("no-trust");
    const r = runHeadless({ runtime: "grok-cli", prompt: "do", cwd: TMP, timeoutMs: 20_000 });
    expect(r.ok, r.error ?? r.stderr).toBe(true);
    const seen = calls("grok");
    expect(seen).toHaveLength(2);
    expect(seen[1]).not.toContain("--trust");
  }, spawnBudgetMs(3));

  test("a turn that failed is never spawned again, and the error envelope's message is the error", () => {
    reset("paid-unknown");
    const r = runHeadless({ runtime: "grok-cli", prompt: "do", cwd: TMP, timeoutMs: 20_000 });
    expect(calls("grok")).toHaveLength(1);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("unknown model grok-x");
  }, spawnBudgetMs(2));

  test("--trust named with exit 2 but a session on stdout is not a parse failure: no retry", () => {
    reset("trust-with-json");
    const r = runHeadless({ runtime: "grok-cli", prompt: "do", cwd: TMP, timeoutMs: 20_000 });
    expect(calls("grok")).toHaveLength(1);
    expect(r.ok).toBe(false);
  }, spawnBudgetMs(2));

  test("a usage error about another flag retries nothing", () => {
    reset("other-flag");
    const r = runHeadless({ runtime: "grok-cli", prompt: "do", cwd: TMP, timeoutMs: 20_000 });
    expect(calls("grok")).toHaveLength(1);
    expect(r.ok).toBe(false);
  }, spawnBudgetMs(2));

  test("a build that refuses --output-format while parsing argv is retried once without it", () => {
    reset("no-output-format");
    const r = runHeadless({ runtime: "grok-cli", prompt: "do", cwd: TMP, timeoutMs: 20_000 });
    expect(r.ok, r.error ?? r.stderr).toBe(true);
    const seen = calls("grok");
    expect(seen).toHaveLength(2);
    expect(seen[1]).not.toContain("--output-format");
    expect(r.result).toBe("plain answer");
  }, spawnBudgetMs(3));

  test("an error envelope on exit 0 still fails the run", () => {
    reset();
    const fake = path.join(TMP, "bin2");
    writeFakeCli(fake, "grok", `process.stdout.write(JSON.stringify({ type: "error", message: "rate limited" })); process.exit(0);`);
    const saved = process.env.PATH;
    process.env.PATH = `${fake}${path.delimiter}${saved ?? ""}`;
    try {
      const r = runHeadless({ runtime: "grok-cli", prompt: "do", cwd: TMP, timeoutMs: 20_000 });
      expect(r.ok).toBe(false);
      expect(r.error).toBe("rate limited");
    } finally { process.env.PATH = saved; }
  }, spawnBudgetMs(2));
});

describe("pi", () => {
  test("--provider without a model is not passed (pi 1.0.0 aborts on it) and the result says so", () => {
    reset();
    const r = runHeadless({ runtime: "pi", prompt: "do", cwd: TMP, timeoutMs: 20_000, providerHint: "ollama" });
    expect(r.ok, r.error ?? r.stderr).toBe(true);
    expect(calls("pi")[0]).not.toContain("--provider");
    expect((r.warnings ?? []).some(w => w.includes("--provider ollama"))).toBe(true);
  }, spawnBudgetMs(2));

  test("--provider travels together with --model", () => {
    reset();
    const r = runHeadless({ runtime: "pi", prompt: "do", cwd: TMP, timeoutMs: 20_000, model: "qwen3-coder", providerHint: "ollama" });
    expect(r.ok, r.error ?? r.stderr).toBe(true);
    const args = calls("pi")[0];
    expect(args[args.indexOf("--provider") + 1]).toBe("ollama");
    expect(args[args.indexOf("--model") + 1]).toBe("qwen3-coder");
  }, spawnBudgetMs(2));

  test("a brief that starts with --- goes after --, as the last argument", () => {
    reset();
    const brief = "---\ntitle: x\n---\n- first item";
    const r = runHeadless({ runtime: "pi", prompt: brief, cwd: TMP, timeoutMs: 20_000 });
    expect(r.ok, r.error ?? r.stderr).toBe(true);
    const args = calls("pi")[0];
    expect(args.at(-2)).toBe("--");
    expect(args.at(-1)).toBe(brief);
  }, spawnBudgetMs(2));
});

describe("kimi-cli", () => {
  test("only assistant messages make the result; a Tool message's output never does", () => {
    reset();
    const r = runHeadless({ runtime: "kimi-cli", prompt: "do", cwd: TMP, timeoutMs: 20_000 });
    expect(r.ok, r.error ?? r.stderr).toBe(true);
    expect(r.result).toBe("Resumo final: três itens.");
    expect(r.result).not.toContain("SECRET FILE DUMP");
  }, spawnBudgetMs(2));

  test("grants travel as --add-dir, with no 'no grant' warning", () => {
    reset();
    const dirs = [path.join(TMP, "project"), path.join(TMP, "outputs")];
    const r = runHeadless({ runtime: "kimi-cli", prompt: "do", cwd: TMP, timeoutMs: 20_000, addDirs: dirs });
    expect(r.ok, r.error ?? r.stderr).toBe(true);
    const args = calls("kimi")[0];
    for (const d of dirs) expect(args[args.indexOf(d) - 1]).toBe("--add-dir");
    expect(r.warnings ?? []).toEqual([]);
  }, spawnBudgetMs(2));

  test("a build without --add-dir is retried once without the grants, and the result says so", () => {
    reset("legacy");
    const r = runHeadless({ runtime: "kimi-cli", prompt: "do", cwd: TMP, timeoutMs: 20_000, addDirs: [path.join(TMP, "project")] });
    expect(r.ok, r.error ?? r.stderr).toBe(true);
    const seen = calls("kimi");
    expect(seen).toHaveLength(2);
    expect(seen[1]).not.toContain("--add-dir");
    expect((r.warnings ?? []).some(w => w.includes("does not know --add-dir"))).toBe(true);
  }, spawnBudgetMs(3));
});

describe("kimi-cli: a retry only on proof of an argv parse failure", () => {
  test("commander's exit 1 with the flag named is proof: retried once without --add-dir", () => {
    reset("commander");
    const r = runHeadless({ runtime: "kimi-cli", prompt: "do", cwd: TMP, timeoutMs: 20_000, addDirs: [path.join(TMP, "project")] });
    expect(r.ok, r.error ?? r.stderr).toBe(true);
    const seen = calls("kimi");
    expect(seen).toHaveLength(2);
    expect(seen[1]).not.toContain("--add-dir");
  }, spawnBudgetMs(3));

  test("an event on stdout means the turn started: no retry, even with the flag named", () => {
    reset("add-dir-with-json");
    const r = runHeadless({ runtime: "kimi-cli", prompt: "do", cwd: TMP, timeoutMs: 20_000, addDirs: [path.join(TMP, "project")] });
    expect(calls("kimi")).toHaveLength(1);
    expect(r.ok).toBe(false);
  }, spawnBudgetMs(2));

  test("a failed turn that says 'unknown' and 'unrecognized option' is never spawned again", () => {
    reset("paid-unknown");
    const r = runHeadless({ runtime: "kimi-cli", prompt: "do", cwd: TMP, timeoutMs: 20_000 });
    expect(calls("kimi")).toHaveLength(1);
    expect(r.ok).toBe(false);
  }, spawnBudgetMs(2));

  test("a build that refuses the stream-json value is retried once without --output-format", () => {
    reset("no-stream-json");
    const r = runHeadless({ runtime: "kimi-cli", prompt: "do", cwd: TMP, timeoutMs: 20_000 });
    expect(r.ok, r.error ?? r.stderr).toBe(true);
    const seen = calls("kimi");
    expect(seen).toHaveLength(2);
    expect(seen[1]).not.toContain("--output-format");
    expect(r.result).toBe("plain answer");
  }, spawnBudgetMs(3));
});

describe("argvRejectedFlag", () => {
  const res = (status: number | null, stderr: string, stdout = "") => ({ status, stderr, stdout });
  test("clap, commander and click messages that name the flag are proof", () => {
    expect(argvRejectedFlag(res(2, "error: unexpected argument '--trust' found"), "--trust", 2)).toBe(true);
    expect(argvRejectedFlag(res(1, "error: unknown option '--add-dir'"), "--add-dir")).toBe(true);
    expect(argvRejectedFlag(res(2, "Error: No such option: --add-dir"), "--add-dir")).toBe(true);
    expect(argvRejectedFlag(res(2, "error: invalid value 'json' for '--output-format <FORMAT>'"), "--output-format", 2)).toBe(true);
  });
  test("anything short of that is not", () => {
    expect(argvRejectedFlag(res(0, "error: unexpected argument '--trust' found"), "--trust")).toBe(false);
    expect(argvRejectedFlag(res(1, "error: unexpected argument '--trust' found"), "--trust", 2)).toBe(false);
    expect(argvRejectedFlag(res(2, "error: unexpected argument '--bogus' found"), "--trust", 2)).toBe(false);
    expect(argvRejectedFlag(res(2, "error: unexpected argument '--trusted' found"), "--trust", 2)).toBe(false);
    expect(argvRejectedFlag(res(1, "unknown error while calling the model"), "--add-dir")).toBe(false);
    expect(argvRejectedFlag(res(2, "error: unknown option '--add-dir'", '{"session_id":"s1"}'), "--add-dir")).toBe(false);
    expect(argvRejectedFlag(res(1, "the --add-dir folder is unknown"), "--add-dir")).toBe(false);
  });
});
