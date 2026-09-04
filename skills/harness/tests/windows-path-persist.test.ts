// windows-path-persist.test.ts — an install into a temporary HOME never
// reaches the real Windows user PATH (issue #87).
//
// On Windows wireLocalBinOnPath() persists %USERPROFILE%\.local\bin to
// HKCU\Environment\Path. USERPROFILE decides the path being written; the 'User'
// target is always the account running the test. Before the guards every
// fake-home test left %TEMP%\nrv-*\home\.local\bin on the real user PATH: 22
// entries on one machine, most pointing at directories long deleted.
//
// The registry value is read through PowerShell, independently of the code
// under test, before and after two real installs in a temporary HOME: the
// engine installer with NIRVANA_SKIP_PATH_PERSIST=1 (the buyer flow, as the
// other fake-home tests run it), then the hook installer it installed, without
// the flag, so the temporary-directory guard alone has to hold.
//
// Windows only by nature — the registry is the thing under test. Elsewhere the
// tests are skipped with that reason; the pure guard logic is covered on every
// platform by skills/_shared/tests/windows-user-path.test.ts.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fakeHomeEnv } from "./helpers/fake-home.ts";
import { removeDir } from "./helpers/temp-dirs.ts";
import { TEARDOWN_BUDGET_MS } from "./helpers/test-budgets.ts";

const IS_WINDOWS = process.platform === "win32";
const SKIP_REASON = "Windows only: the registry value HKCU\\Environment\\Path is the thing under test";
const REPO = path.resolve(import.meta.dir, "..", "..", "..");

let root = "";
let home = "";

beforeAll(() => {
  if (!IS_WINDOWS) return;
  root = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-path-persist-"));
  home = path.join(root, "home");
  fs.mkdirSync(home, { recursive: true });
});
afterAll(() => { if (root) removeDir(root); }, TEARDOWN_BUDGET_MS);

/** The user PATH as Windows stores it, read without the module under test. */
function userPath(): string {
  const r = spawnSync("powershell", [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command",
    "[Environment]::GetEnvironmentVariable('Path','User')",
  ], { encoding: "utf8" });
  expect(r.status).toBe(0);
  return (r.stdout ?? "").replace(/\r?\n$/, "");
}

function run(args: string[], env: NodeJS.ProcessEnv): { code: number; out: string } {
  const r = spawnSync(process.execPath, args, { cwd: root, env, encoding: "utf8" });
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

describe(`the Windows user PATH survives an install into a temporary HOME (${SKIP_REASON})`, () => {
  test.skipIf(!IS_WINDOWS)("with NIRVANA_SKIP_PATH_PERSIST=1 the installer says so and writes nothing", () => {
    const before = userPath();
    const r = run([path.join(REPO, "scripts", "install.ts"), "--no-starter", "--no-index", "--no-hermes"],
      fakeHomeEnv(home, { NIRVANA_PACKS_DIR: path.join(home, "no-packs") }));
    expect(r.code).toBe(0);
    expect(r.out).toContain("NIRVANA_SKIP_PATH_PERSIST=1");
    expect(userPath()).toBe(before);
    expect(before.toLowerCase()).not.toContain(path.join(home, ".local", "bin").toLowerCase());
  }, 600_000);

  test.skipIf(!IS_WINDOWS)("without the flag the temporary-directory guard alone holds", () => {
    const before = userPath();
    const env = fakeHomeEnv(home);
    delete env.NIRVANA_SKIP_PATH_PERSIST;
    // The hook installer the previous test installed: the script that persists.
    const r = run([path.join(home, ".nirvana", "skills", "_shared", "scripts", "install.ts")], env);
    expect(r.code).toBe(0);
    expect(r.out).toContain("is under a temporary directory");
    expect(r.out).not.toContain("added ");
    expect(userPath()).toBe(before);
  }, 120_000);
});
