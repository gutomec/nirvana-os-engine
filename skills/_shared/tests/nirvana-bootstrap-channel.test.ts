// The bootstrap of the `nirvana` skill, over an engine that is already
// installed: it keeps the installed engine's release channel and never
// installs an older version (engine-release.ts beside it decides).
//
// Hermetic: a fake release list and stub tarballs served on 127.0.0.1 through
// NIRVANA_ENGINE_RELEASES_API / NIRVANA_ENGINE_LATEST_URL; bun's directory on a
// bare PATH, as in nirvana-bootstrap.test.ts.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fakeHomeEnv } from "../../harness/tests/helpers/fake-home.ts";
import { runAsync, startFakeReleases, type FakeReleaseServer } from "../../harness/tests/helpers/fake-releases.ts";
import { spawnBudgetMs } from "../../harness/tests/helpers/test-budgets.ts";

const REPO = path.resolve(import.meta.dir, "..", "..", "..");
const SH = path.join(REPO, "skills", "nirvana", "scripts", "bootstrap.sh");
const PS1 = path.join(REPO, "skills", "nirvana", "scripts", "bootstrap.ps1");
const IS_WINDOWS = process.platform === "win32";
const SYSTEM_ROOT = process.env.SystemRoot || "C:\\Windows";
const BARE_PATH = IS_WINDOWS
  ? [path.join(SYSTEM_ROOT, "System32"), path.join(SYSTEM_ROOT, "System32", "WindowsPowerShell", "v1.0")].join(path.delimiter)
  : "/usr/bin:/bin";
const KIND: "sh" | "ps1" = IS_WINDOWS ? "ps1" : "sh";
const YES = KIND === "sh" ? "--yes" : "-Yes";
const UPDATE = KIND === "sh" ? "--update" : "-Update";

let root: string;
let server: FakeReleaseServer;

beforeAll(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "nrv-boot-ch-")));
  server = startFakeReleases(root);
});
afterAll(() => {
  server.stop();
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
});

/** A machine with an engine installed at `installed`, nrv present unless `withNrv` is false. */
function installedHome(name: string, installed: string, withNrv = true): { home: string; tmp: string } {
  const home = path.join(root, name);
  const tmp = path.join(root, `${name}-tmp`);
  fs.mkdirSync(path.join(home, ".nirvana", "skills", "harness"), { recursive: true });
  fs.mkdirSync(tmp, { recursive: true });
  fs.writeFileSync(path.join(home, ".nirvana", "skills", "VERSION"), `${installed}\n`);
  if (withNrv) {
    fs.mkdirSync(path.join(home, ".local", "bin"), { recursive: true });
    fs.writeFileSync(path.join(home, ".local", "bin", IS_WINDOWS ? "nrv.cmd" : "nrv"), "#!/bin/sh\necho stub\n", { mode: 0o755 });
  }
  return { home, tmp };
}

async function bootstrap(home: string, tmp: string, args: string[]) {
  const env = fakeHomeEnv(home, {
    ...server.env,
    PATH: `${path.dirname(process.execPath)}${path.delimiter}${BARE_PATH}`,
    Path: `${path.dirname(process.execPath)}${path.delimiter}${BARE_PATH}`,
    TMPDIR: tmp, TMP: tmp, TEMP: tmp,
  });
  for (const k of ["NIRVANA_BOOTSTRAP_YES", "NIRVANA_PROJECT_ROOT", "NIRVANA_ENGINE_URL", "NIRVANA_ENGINE_TARBALL", "NIRVANA_SKILLS_DIR"]) delete env[k];
  const cmd = KIND === "sh" ? ["sh", SH, ...args] : ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", PS1, ...args];
  const r = await runAsync(cmd, { cwd: home, env, timeoutMs: spawnBudgetMs(3) });
  const log = path.join(home, "installs.log");
  return {
    ...r,
    installs: fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : [],
    version: fs.readFileSync(path.join(home, ".nirvana", "skills", "VERSION"), "utf8").trim(),
  };
}

describe(`bootstrap.${KIND} keeps the release channel`, () => {
  test("--update on a beta installs the newest greater beta", async () => {
    server.setRateLimited(false);
    server.setReleases([{ version: "0.14.10" }, { version: "0.15.0-beta.5", prerelease: true }, { version: "0.15.0-beta.6", prerelease: true }]);
    const { home, tmp } = installedHome("up", "0.15.0-beta.5");
    const r = await bootstrap(home, tmp, [YES, UPDATE]);
    expect(r.code, r.out).toBe(0);
    expect(r.installs).toEqual(["0.15.0-beta.6"]);
  }, spawnBudgetMs(3));

  test("--update with nothing newer keeps the engine and installs nothing", async () => {
    server.setReleases([{ version: "0.14.10" }, { version: "0.15.0-beta.5", prerelease: true }]);
    const { home, tmp } = installedHome("current", "0.15.0-beta.5");
    const r = await bootstrap(home, tmp, [YES, UPDATE]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("kept");
    expect(r.installs).toEqual([]);
    expect(r.version).toBe("0.15.0-beta.5");
  }, spawnBudgetMs(3));

  test("a repair with nothing newer reinstalls the installed version, never the older stable", async () => {
    server.setReleases([{ version: "0.14.10" }, { version: "0.15.0-beta.5", prerelease: true }]);
    const { home, tmp } = installedHome("repair", "0.15.0-beta.5", false);
    const r = await bootstrap(home, tmp, [YES]);
    expect(r.code, r.out).toBe(0);
    expect(r.installs).toEqual(["0.15.0-beta.5"]);
  }, spawnBudgetMs(3));

  test("rate limited: the latest stable is fetched but never replaces a newer beta", async () => {
    server.setRateLimited(true);
    server.setLatest("0.14.10");
    const { home, tmp } = installedHome("limited", "0.15.0-beta.5");
    const r = await bootstrap(home, tmp, [YES, UPDATE]);
    server.setRateLimited(false);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("nothing changed");
    expect(r.installs).toEqual([]);
    expect(r.version).toBe("0.15.0-beta.5");
  }, spawnBudgetMs(3));
});
