// context-window.test.ts — execution.context_window reaches the runtimes that
// have a context ceiling, and only them, and nothing is passed when it is 0.
//
// Real processes against fake CLIs, reading the argv and environment the child
// was actually given: claude takes the ceiling as CLAUDE_CODE_AUTO_COMPACT_WINDOW,
// codex as its own `model_auto_compact_token_limit` config key.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writeFakeCli, readCapturedArgs } from "./helpers/fake-cli.ts";
import { spawnBudgetMs } from "./helpers/test-budgets.ts";
import { runHeadless, type Runtime } from "../../_shared/lib/host-agent-driver.ts";
import { _resetSettingsCache } from "../../_shared/lib/settings.ts";

const roots: string[] = [];
const saved = { ...process.env };
afterAll(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
  process.env = { ...saved };
});
beforeEach(() => {
  for (const k of ["NIRVANA_CONTEXT_WINDOW", "NIRVANA_PROFILE", "CLAUDE_CODE_AUTO_COMPACT_WINDOW"]) delete process.env[k];
  _resetSettingsCache();
});

const CLI: Partial<Record<Runtime, string>> = { "claude-code": "claude", codex: "codex", "gemini-cli": "gemini" };

/** Run a dispatch against a fake CLI; return its argv and the ceiling variable it saw. */
function spawnOf(runtime: Runtime): { argv: string[]; envWindow: string | null } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nrv-ctxwin-")));
  roots.push(root);
  const binDir = path.join(root, "bin");
  const cli = CLI[runtime]!;
  writeFakeCli(binDir, cli, [
    'import * as fs from "node:fs";',
    'import * as path from "node:path";',
    'try { await Bun.stdin.text(); } catch {}',
    'const dir = process.env.FAKE_CAPTURE_DIR!;',
    'fs.writeFileSync(path.join(dir, "' + cli + '-args.json"), JSON.stringify(Bun.argv.slice(2)));',
    'fs.writeFileSync(path.join(dir, "' + cli + '-window.txt"), process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW ?? "");',
    'console.log("{}");',
  ].join("\n"));
  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${previousPath}`;
  process.env.FAKE_CAPTURE_DIR = root;
  try {
    runHeadless({ runtime, prompt: "hi", cwd: root, yolo: true, timeoutMs: spawnBudgetMs(1) } as any);
  } finally {
    process.env.PATH = previousPath;
    delete process.env.FAKE_CAPTURE_DIR;
  }
  const windowFile = path.join(root, `${cli}-window.txt`);
  const envWindow = fs.existsSync(windowFile) ? fs.readFileSync(windowFile, "utf8") || null : null;
  return { argv: readCapturedArgs(root, cli), envWindow };
}

const limitArg = (argv: string[]) => argv.find((a) => a.startsWith("model_auto_compact_token_limit=")) ?? null;

describe("no ceiling configured", () => {
  test("claude gets no ceiling variable and codex no limit key", () => {
    expect(spawnOf("claude-code").envWindow).toBeNull();
    expect(limitArg(spawnOf("codex").argv)).toBeNull();
  }, 60_000);
});

describe("a ceiling configured", () => {
  test("claude sees it as CLAUDE_CODE_AUTO_COMPACT_WINDOW", () => {
    process.env.NIRVANA_CONTEXT_WINDOW = "200000";
    expect(spawnOf("claude-code").envWindow).toBe("200000");
  }, 60_000);

  test("codex gets it as model_auto_compact_token_limit", () => {
    process.env.NIRVANA_CONTEXT_WINDOW = "200000";
    const argv = spawnOf("codex").argv;
    expect(limitArg(argv)).toBe("model_auto_compact_token_limit=200000");
    expect(argv[argv.indexOf("model_auto_compact_token_limit=200000") - 1]).toBe("-c");
  }, 60_000);

  test("a runtime without the concept gets nothing", () => {
    process.env.NIRVANA_CONTEXT_WINDOW = "200000";
    const { argv } = spawnOf("gemini-cli");
    expect(argv.some((a) => a.includes("200000"))).toBe(false);
  }, 60_000);

  test("the economy profile carries its ceiling to the child", () => {
    process.env.NIRVANA_PROFILE = "economy";
    expect(spawnOf("claude-code").envWindow).toBe("200000");
  }, 60_000);
});
