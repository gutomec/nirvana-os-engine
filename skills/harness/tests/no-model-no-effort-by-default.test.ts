// no-model-no-effort-by-default.test.ts — the dispatch carries nothing the
// user did not ask for.
//
// Owner doctrine (2026-09-12): "Nenhum modelo ou effort deve ser especificado
// por padrão. O padrão é sempre o que está por padrão no sistema do usuário.
// Por exemplo para despachar o codex o padrão é somente despachar o codex sem
// especificar modelo nem effort, para usar o padrão do meu codex. (…) Porém se
// eu especificar modelo e especificar effort, então deve ser despachado
// especificando o modelo e o effort que eu mandei."
//
// The engine used to do the opposite, and the way it went wrong is why these
// cases run a REAL process and read the argv it was actually given rather than
// asserting on a resolver's return value. `resolveSystemModel` read
// `ANTHROPIC_MODEL` — a vendor variable set on many machines, nothing to do
// with Nirvana — before it checked which runtime it was answering for.
// Measured with it exported: the resolver answered `opus` for all nine
// runtimes, so the driver ran `gemini --model opus`, `agy --model opus`,
// `pi --model opus`, `qwen --model opus`. Only the codex adapter guarded
// itself. It also read `~/.claude/settings.json`, which a `claude` child reads
// on its own, so the engine was re-stating a decision that was never its.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writeFakeCli, readCapturedArgs } from "./helpers/fake-cli.ts";
import { spawnBudgetMs } from "./helpers/test-budgets.ts";
import { runHeadless } from "../../_shared/lib/host-agent-driver.ts";
import type { Runtime } from "../../_shared/lib/host-agent-driver.ts";

const roots: string[] = [];
afterAll(() => { for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true }); });

const saved = { ...process.env };
beforeEach(() => {
  for (const k of ["NIRVANA_MODEL", "NIRVANA_EFFORT", "ANTHROPIC_MODEL", "CLAUDE_CONFIG_DIR"]) delete process.env[k];
});
afterAll(() => { process.env = { ...saved }; });

/** The CLI name each runtime actually spawns. */
const CLI: Partial<Record<Runtime, string>> = {
  "claude-code": "claude", codex: "codex", "gemini-cli": "gemini",
  "antigravity-cli": "agy", "kimi-cli": "kimi", "grok-cli": "grok",
  pi: "pi", "qwen-code": "qwen", opencode: "opencode",
};

/** Run a dispatch against a fake CLI and return the argv it received. */
function argvOf(runtime: Runtime, extra: Record<string, unknown> = {}): string[] {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nrv-nomodel-")));
  roots.push(root);
  const binDir = path.join(root, "bin");
  const cli = CLI[runtime]!;
  // CAPTURE_PRELUDE writes argv to FAKE_CAPTURE_DIR; the body only has to exit.
  writeFakeCli(binDir, cli, [
    'import * as fs from "node:fs";',
    'import * as path from "node:path";',
    'const argv = Bun.argv.slice(2);',
    'try { await Bun.stdin.text(); } catch {}',
    'fs.writeFileSync(path.join(process.env.FAKE_CAPTURE_DIR!, "' + cli + '-args.json"), JSON.stringify(argv));',
    'console.log("{}");',
  ].join("\n"));

  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${previousPath}`;
  process.env.FAKE_CAPTURE_DIR = root;
  try {
    runHeadless({ runtime, prompt: "oi", cwd: root, yolo: true, timeoutMs: spawnBudgetMs(1), ...extra } as any);
  } finally {
    process.env.PATH = previousPath;
    delete process.env.FAKE_CAPTURE_DIR;
  }
  return readCapturedArgs(root, cli);
}

const hasModelFlag = (argv: string[]) => argv.includes("--model") || argv.includes("-m");
const effortIn = (argv: string[]) =>
  argv.some((a) => a === "--effort") || argv.some((a) => a.startsWith("model_reasoning_effort="));

describe("no pin, no flag: the CLI is run bare", () => {
  // Every runtime the driver can execute, because the leak reached all nine.
  test.each(Object.keys(CLI) as Runtime[])("%s is dispatched with no model and no effort", (runtime) => {
    const argv = argvOf(runtime);
    expect(argv.length, `${runtime} was never spawned — the fake CLI captured nothing`).toBeGreaterThan(0);
    expect(hasModelFlag(argv), `${runtime} argv: ${argv.join(" ")}`).toBe(false);
    expect(effortIn(argv), `${runtime} argv: ${argv.join(" ")}`).toBe(false);
  }, 60_000);

  test("a vendor env var does not become a dispatch flag — the nine-runtime leak", () => {
    process.env.ANTHROPIC_MODEL = "claude-opus-5";
    for (const runtime of ["gemini-cli", "pi", "qwen-code", "kimi-cli", "grok-cli"] as Runtime[]) {
      const argv = argvOf(runtime);
      expect(hasModelFlag(argv), `${runtime} got a model from ANTHROPIC_MODEL: ${argv.join(" ")}`).toBe(false);
    }
  }, 120_000);

  test("the user's own claude settings do not become a flag either", () => {
    const cfg = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nrv-ccfg-")));
    roots.push(cfg);
    fs.writeFileSync(path.join(cfg, "settings.json"), JSON.stringify({ model: "claude-fable-5" }));
    process.env.CLAUDE_CONFIG_DIR = cfg;
    expect(hasModelFlag(argvOf("claude-code"))).toBe(false);
  }, 60_000);
});

describe("what the user asked for IS passed", () => {
  test("an explicit model on the call reaches claude", () => {
    expect(argvOf("claude-code", { model: "fable" })).toContain("--model");
  }, 60_000);

  test("a pinned model reaches the dispatch", () => {
    process.env.NIRVANA_MODEL = "fable";
    const argv = argvOf("claude-code");
    expect(argv).toContain("--model");
    expect(argv[argv.indexOf("--model") + 1]).toBe("fable");
  }, 60_000);

  test("an explicit effort reaches claude as --effort", () => {
    const argv = argvOf("claude-code", { effort: "xhigh" });
    expect(argv).toContain("--effort");
    expect(argv[argv.indexOf("--effort") + 1]).toBe("xhigh");
  }, 60_000);

  test("an explicit effort reaches codex as its config key, not as a flag it has no idea about", () => {
    // codex has no --effort; the level is `model_reasoning_effort` in
    // ~/.codex/config.toml, overridden per run with -c. The owner's own config
    // carries `model_reasoning_effort = "xhigh"`, which is exactly the value a
    // dispatch must not silently replace.
    const argv = argvOf("codex", { effort: "max" });
    expect(argv).not.toContain("--effort");
    expect(argv.some((a) => a === 'model_reasoning_effort="max"')).toBe(true);
  }, 60_000);

  test("a pinned effort reaches the dispatch the same way", () => {
    process.env.NIRVANA_EFFORT = "high";
    expect(argvOf("claude-code")).toContain("--effort");
  }, 60_000);

  test("a Claude alias pinned while dispatching codex is dropped, never sent as -m", () => {
    // `codex -m opus` is a hard error. The pin applies to any runtime by
    // design; the adapter is what refuses the mismatch.
    process.env.NIRVANA_MODEL = "opus";
    const argv = argvOf("codex");
    expect(hasModelFlag(argv), `codex argv: ${argv.join(" ")}`).toBe(false);
  }, 60_000);

  test("a runtime with no effort concept runs without it, and says so", () => {
    // qwen has no effort setting. The request is not honoured and the driver
    // announces that once; what it must never do is invent a flag, and what it
    // must not do either is drop it silently so the brief looks obeyed.
    const said: string[] = [];
    const originalError = console.error;
    console.error = (...a: unknown[]) => { said.push(a.map(String).join(" ")); };
    let argv: string[];
    try { argv = argvOf("qwen-code", { effort: "max" }); } finally { console.error = originalError; }
    expect(effortIn(argv), `qwen argv: ${argv.join(" ")}`).toBe(false);
    expect(argv.length).toBeGreaterThan(0);
    expect(said.join("\n")).toContain("has no effort setting");
  }, 60_000);

  test("a level that is not a level is refused, not forwarded", () => {
    expect(effortIn(argvOf("claude-code", { effort: "altissimo" }))).toBe(false);
  }, 60_000);
});
