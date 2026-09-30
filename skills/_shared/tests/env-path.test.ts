// env-path.test.ts — a path override is expanded, or ignored; never read relative to the cwd.
//
// A runtime that loads a .env without shell expansion hands the engine values
// such as `$NIRVANA_HOME/.harness-logs` literally, and path.resolve used to turn
// them into a folder literally named `$NIRVANA_HOME` under whatever cwd the
// agent ran in.
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const { expandPath, envPath, isAbsolutePath } = require_("../lib/env-path.js") as {
  expandPath: (v: string, env?: Record<string, string | undefined>) => string | null;
  envPath: (name: string, env?: Record<string, string | undefined>) => string | null;
  isAbsolutePath: (p: string) => boolean;
};

const R = fs.mkdtempSync(path.join(os.tmpdir(), "env-path-"));
afterAll(() => fs.rmSync(R, { recursive: true, force: true }));
const ABS = path.join(R, "home");

describe("expandPath", () => {
  test("expands $VAR, ${VAR} and a chain of references", () => {
    expect(expandPath("$BASE/logs", { BASE: ABS })).toBe(path.join(ABS, "logs"));
    expect(expandPath("${BASE}/logs", { BASE: ABS })).toBe(path.join(ABS, "logs"));
    // NIRVANA_HOME=$HOME, HARNESS_LOGS_DIR=$NIRVANA_HOME/.harness-logs, all literal.
    expect(expandPath("$NIRVANA_HOME/.harness-logs", { NIRVANA_HOME: "$HOME", HOME: ABS })).toBe(path.join(ABS, ".harness-logs"));
  });

  test("expands ~ to the user's home", () => {
    expect(expandPath("~/x", {})).toBe(path.join(os.homedir(), "x"));
  });

  test("a reference nothing resolves, or a relative value, is not a path", () => {
    expect(expandPath("$NIRVANA_HOME/.harness-logs", {})).toBeNull();
    expect(expandPath("relative/logs", {})).toBeNull();
    expect(expandPath("", {})).toBeNull();
  });

  test("absolute values stay valid, Windows-shaped ones included", () => {
    expect(expandPath(ABS, {})).toBe(path.resolve(ABS));
    expect(isAbsolutePath("C:\\Users\\someone\\logs")).toBeTrue();
    expect(isAbsolutePath("C:/Users/someone/logs")).toBeTrue();
    expect(isAbsolutePath("\\\\server\\share\\logs")).toBeTrue();
    expect(expandPath("C:\\Users\\someone\\logs", {})).not.toBeNull();
  });
});

describe("envPath", () => {
  test("unset is null and silent; unusable is null and warned once", () => {
    expect(envPath("UNSET_PATH_VAR_FOR_TEST", {})).toBeNull();
    const writes: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (chunk: any) => { writes.push(String(chunk)); return true; };
    try {
      const env = { WEIRD_DIR_FOR_TEST: "$NOPE/dir" };
      expect(envPath("WEIRD_DIR_FOR_TEST", env)).toBeNull();
      expect(envPath("WEIRD_DIR_FOR_TEST", env)).toBeNull();
    } finally {
      (process.stderr as any).write = original;
    }
    expect(writes.filter(w => w.includes("WEIRD_DIR_FOR_TEST"))).toHaveLength(1);
  });
});

// The readers, each in its own process: paths.js computes NIRVANA_HOME at load.
function run(code: string, env: Record<string, string>): { out: string; cwdEntries: string[] } {
  const cwd = fs.mkdtempSync(path.join(R, "cwd-"));
  const r = spawnSync(process.execPath, ["-e", code], { cwd, encoding: "utf8", env: { ...process.env, ...env } });
  expect(r.status, r.stderr).toBe(0);
  return { out: r.stdout.trim(), cwdEntries: fs.readdirSync(cwd) };
}

const LIB = path.join(import.meta.dir, "..", "lib");
const AUDIT = path.join(import.meta.dir, "..", "..", "harness", "lib", "audit.js");

describe("the readers never create a `$` folder under the cwd", () => {
  test("log-paths honors an expanded override and skips an unresolvable one", () => {
    const expanded = run(`const { harnessLogsDir } = require(${JSON.stringify(path.join(LIB, "log-paths.js"))}); console.log(harnessLogsDir({ cwd: process.cwd() }));`,
      { HARNESS_LOGS_DIR: "$BASE_FOR_TEST/logs", BASE_FOR_TEST: ABS });
    expect(expanded.out).toBe(path.join(ABS, "logs"));
    const skipped = run(`const { harnessLogsDir } = require(${JSON.stringify(path.join(LIB, "log-paths.js"))}); console.log(harnessLogsDir({ cwd: process.cwd() }));`,
      { HARNESS_LOGS_DIR: "$UNSET_FOR_TEST/logs" });
    expect(skipped.out).not.toContain("$");
  });

  test("paths.js resolves a chain of literal references to real directories", () => {
    const { out } = run(`const p = require(${JSON.stringify(path.join(LIB, "paths.js"))}).resolvePaths({ skipScopeFile: true }); console.log(JSON.stringify({ squads: p.SQUADS_DIR, logs: p.HARNESS_LOGS_DIR }));`,
      { NIRVANA_HOME: "$HOME_FOR_TEST", HOME_FOR_TEST: ABS, SQUADS_DIR: "$NIRVANA_HOME/squads", HARNESS_LOGS_DIR: "$UNSET_FOR_TEST/.harness-logs" });
    const got = JSON.parse(out);
    expect(got.squads).toBe(path.join(ABS, "squads"));
    expect(got.logs).not.toContain("$");
  });

  test("an audit event emitted under a literal override lands nowhere near the cwd", () => {
    const { cwdEntries } = run(`const a = require(${JSON.stringify(AUDIT)}); a.emit("session_started", { trace_id: "t-env-path" });`,
      { HARNESS_LOGS_DIR: "$UNSET_FOR_TEST/.harness-logs", NIRVANA_STATE_DB: path.join(R, "state.db"), NIRVANA_TEST_LOGS_HOME: path.join(R, "logs-floor") });
    expect(cwdEntries.filter(e => e.includes("$"))).toEqual([]);
  });
});
