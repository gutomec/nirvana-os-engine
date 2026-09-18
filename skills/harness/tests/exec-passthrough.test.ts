// exec-passthrough.test.ts — `nrv exec`: the runtime as itself.
//
// The fourth thing nrv can do with a runtime, and the only one that promises
// nothing. What these tests protect is not the happy path — it is the three
// properties that keep an unguarded passthrough from becoming a hole:
//
//   1. it is an OPERATOR tool, so no dispatched role can open one;
//   2. it says, every time, that nothing it returns passed the gate;
//   3. it records what it cost.
//
// Hermetic: a fake CLI on a temp PATH, a temp HOME for the audit. No LLM, no
// network, no project.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writeFakeCli } from "./helpers/fake-cli.ts";

const SCRIPT = path.join(import.meta.dir, "..", "scripts", "exec.ts");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-exec-"));
const BIN = path.join(TMP, "bin");
const LOGS = path.join(TMP, "logs");
const CAP = path.join(TMP, "capture");
fs.mkdirSync(CAP, { recursive: true });
fs.mkdirSync(BIN, { recursive: true });

beforeAll(() => {
  // A fake `claude` that records what it was given and answers with a fixed
  // line, so stdout is exact. The prompt arrives on STDIN for this adapter, not
  // in argv, which is the whole reason the parser test reads it from here.
  writeFakeCli(BIN, "claude", [
    `import * as fs from "node:fs";`,
    `import * as path from "node:path";`,
    `const dir = process.env.FAKE_CAPTURE_DIR;`,
    `const argv = Bun.argv.slice(2);`,
    `let stdin = "";`,
    `try { stdin = await Bun.stdin.text(); } catch {}`,
    `if (dir) {`,
    `  try { fs.writeFileSync(path.join(dir, "claude-args.json"), JSON.stringify(argv)); } catch {}`,
    `  try { fs.writeFileSync(path.join(dir, "claude-stdin.txt"), stdin); } catch {}`,
    `}`,
    `process.stdout.write("the answer\\n");`,
  ].join("\n"));
});
afterAll(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ } });

function run(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync("bun", [SCRIPT, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${BIN}${path.delimiter}${process.env.PATH ?? ""}`,
      HARNESS_LOGS_DIR: LOGS,
      NIRVANA_HOST_RUNTIME: "claude-code",
      NO_COLOR: "1",
      FAKE_CAPTURE_DIR: CAP,
      ...env,
    },
    cwd: TMP,
  });
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
}

describe("it is an operator tool", () => {
  test.each(["squad", "employee", "agent-x", "planner", "business", "exec"])(
    "a %s cannot open one",
    (role) => {
      const { code, err } = run(["--quiet", "hello"], { NIRVANA_DISPATCH_ROLE: role });
      expect(code).not.toBe(0);
      expect(err).toContain("dispatch refused");
    },
  );

  test("the operator's own session can", () => {
    const { code, out } = run(["--quiet", "hello"]);
    expect(code).toBe(0);
    expect(out.trim()).toBe("the answer");
  });
});

describe("it never pretends to be a deliverable", () => {
  test("the no-gate notice is printed, on stderr so a pipe stays clean", () => {
    const { out, err } = run(["hello"]);
    expect(out.trim()).toBe("the answer");
    expect(err).toContain("passed no quality gate");
    expect(err).toContain("nrv dispatch");
    expect(out).not.toContain("quality gate");
  });

  test("--quiet drops the notice but never the answer", () => {
    const { out, err } = run(["--quiet", "hello"]);
    expect(out.trim()).toBe("the answer");
    expect(err).not.toContain("passed no quality gate");
  });

  test("--json reports gate: null rather than omitting the question", () => {
    const { code, out } = run(["--json", "hello"]);
    expect(code).toBe(0);
    const v = JSON.parse(out);
    expect(v).toMatchObject({ ok: true, runtime: "claude-code", result: expect.stringContaining("the answer") });
    expect(v.gate).toBeNull();
    expect(v).toHaveProperty("cost_usd");
    expect(v).toHaveProperty("duration_ms");
  });
});

describe("it leaves a trace", () => {
  test("an errand is recorded with its runtime and size, and never with its prompt", () => {
    run(["--quiet", "a secret question about acquisitions"]);
    const day = new Date().toISOString().slice(0, 10);
    const file = path.join(LOGS, day, "audit.jsonl");
    expect(fs.existsSync(file)).toBe(true);
    const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const ev = lines.reverse().find((e) => (e.event ?? e.type ?? "").includes("x_exec_passthrough"));
    expect(ev).toBeDefined();
    expect(ev.runtime).toBe("claude-code");
    expect(ev.prompt_chars).toBe("a secret question about acquisitions".length);
    expect(JSON.stringify(ev)).not.toContain("acquisitions");
  });
});

describe("the arguments", () => {
  test("a repeated word survives: the prompt is parsed by index, not by value", () => {
    // `indexOf` would have matched the second "codex" against the --runtime
    // flag and eaten a word out of the middle of the question. Asserted on what
    // the CLI actually RECEIVED — an earlier version of this test watched
    // stderr for "unknown runtime" and went red on a CI runner that exports
    // USE_BAZEL_FALLBACK_VERSION, which says nothing about the parser.
    const { code } = run(["--quiet", "--runtime", "claude-code", "compare", "codex", "and", "codex"]);
    expect(code).toBe(0);
    expect(fs.readFileSync(path.join(CAP, "claude-stdin.txt"), "utf8")).toContain("compare codex and codex");
  });

  test("an unknown runtime is refused as bad usage, never substituted", () => {
    const { code, err } = run(["--runtime=not-a-runtime", "hello"]);
    expect(code).toBe(4);
    expect(err).toContain("unknown runtime");
  });

  test("no prompt and no stdin is usage, and the usage says where to go for a deliverable", () => {
    const { code, err } = run([]);
    expect(code).toBe(4);
    expect(err).toContain("nrv dispatch --auto --exec");
  });

  test("--help prints and exits 0: asking what a command does is not a usage error", () => {
    const { code, err } = run(["--help"]);
    expect(code).toBe(0);
    expect(err).toContain("No persona, no outputs directory, no quality gate");
  });

  test("a usage error still exits 4, so the two are told apart", () => {
    expect(run([]).code).toBe(4);
  });
});
