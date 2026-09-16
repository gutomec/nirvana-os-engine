// The bootstrap the `nirvana` skill runs on a machine without the engine.
//
// Hermetic: a stub engine tarball whose scripts/install.ts records how it was
// called and plants the files the real one would; bun's own directory is put
// on a bare PATH so the "Bun already present" branch runs and nothing ever
// reaches for the network. What is asserted is the contract the skill relies
// on: no consent means no install; --dry-run touches nothing; a real run lands
// nrv and the entry skill and calls the installer with --no-starter from HOME;
// a second run says so and installs nothing; --update installs again.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fakeHomeEnv } from "../../harness/tests/helpers/fake-home.ts";
import { spawnBudgetMs } from "../../harness/tests/helpers/test-budgets.ts";

const REPO = path.resolve(import.meta.dir, "..", "..", "..");
const SH = path.join(REPO, "skills", "nirvana", "scripts", "bootstrap.sh");
const PS1 = path.join(REPO, "skills", "nirvana", "scripts", "bootstrap.ps1");
const IS_WINDOWS = process.platform === "win32";
const SYSTEM_ROOT = process.env.SystemRoot || "C:\\Windows";
const BARE_PATH = IS_WINDOWS
  ? [path.join(SYSTEM_ROOT, "System32"), path.join(SYSTEM_ROOT, "System32", "WindowsPowerShell", "v1.0")].join(path.delimiter)
  : "/usr/bin:/bin";

let root: string;
let tarball: string;

/** The stub engine: an installer that leaves evidence instead of a product. */
function buildStubTarball(dir: string): string {
  const src = path.join(dir, "engine-src");
  fs.mkdirSync(path.join(src, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(src, "skills"), { recursive: true });
  fs.writeFileSync(path.join(src, "skills", "VERSION"), "9.9.9\n");
  fs.writeFileSync(path.join(src, "scripts", "install.ts"), [
    'import * as fs from "node:fs";',
    'import * as path from "node:path";',
    'import { homedir } from "node:os";',
    "const home = homedir();",
    'const bin = path.join(home, ".local", "bin");',
    "fs.mkdirSync(bin, { recursive: true });",
    'fs.writeFileSync(path.join(bin, "nrv"), "#!/bin/sh\\necho stub\\n");',
    'fs.chmodSync(path.join(bin, "nrv"), 0o755);',
    'fs.writeFileSync(path.join(bin, "nrv.cmd"), "@echo stub\\r\\n");',
    'const skills = path.join(home, ".nirvana", "skills");',
    'fs.mkdirSync(path.join(skills, "harness"), { recursive: true });',
    'fs.mkdirSync(path.join(skills, "nirvana"), { recursive: true });',
    'fs.writeFileSync(path.join(skills, "nirvana", "SKILL.md"), "---\\nname: nirvana\\n---\\n");',
    'fs.writeFileSync(path.join(skills, "VERSION"), "9.9.9\\n");',
    'fs.appendFileSync(path.join(home, "installs.log"), process.argv.slice(2).join(" ") + " | cwd=" + process.cwd() + "\\n");',
  ].join("\n"));
  const t = spawnSync("tar", ["-czf", "engine.tar.gz", "-C", "engine-src", "."], { cwd: dir, encoding: "utf8" });
  if (t.status !== 0) throw new Error(`tar failed: ${t.stderr}`);
  return path.join(dir, "engine.tar.gz");
}

function freshHome(name: string): { home: string; tmp: string } {
  const home = path.join(root, name);
  const tmp = path.join(root, `${name}-tmp`);
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(tmp, { recursive: true });
  return { home, tmp };
}

function run(kind: "sh" | "ps1", home: string, tmp: string, args: string[]): { code: number; out: string } {
  const env = fakeHomeEnv(home, {
    NIRVANA_ENGINE_TARBALL: tarball,
    PATH: `${path.dirname(process.execPath)}${path.delimiter}${BARE_PATH}`,
    Path: `${path.dirname(process.execPath)}${path.delimiter}${BARE_PATH}`,
    TMPDIR: tmp, TMP: tmp, TEMP: tmp,
  });
  delete env.NIRVANA_BOOTSTRAP_YES;
  delete env.NIRVANA_PROJECT_ROOT;
  const r = kind === "sh"
    ? spawnSync("sh", [SH, ...args], { env, encoding: "utf8", cwd: home, timeout: spawnBudgetMs(60_000) })
    : spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", PS1, ...args], { env, encoding: "utf8", cwd: home, timeout: spawnBudgetMs(60_000) });
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/** Windows hands out 8.3 short paths (RUNNER~1) for TEMP and long ones for cwd;
 *  realpathSync.native expands the short form, and the drive letter case varies. */
const canon = (p: string) => IS_WINDOWS ? fs.realpathSync.native(p).toLowerCase() : fs.realpathSync(p);

const installs = (home: string) => fs.existsSync(path.join(home, "installs.log"))
  ? fs.readFileSync(path.join(home, "installs.log"), "utf8").trim().split("\n") : [];
const nrvAt = (home: string) => fs.existsSync(path.join(home, ".local", "bin", IS_WINDOWS ? "nrv.cmd" : "nrv"));

beforeAll(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "nrv-boot-")));
  tarball = buildStubTarball(root);
});
afterAll(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } });

for (const kind of (IS_WINDOWS ? ["ps1"] : ["sh"]) as Array<"sh" | "ps1">) {
  const yes = kind === "sh" ? "--yes" : "-Yes";
  const dry = kind === "sh" ? "--dry-run" : "-DryRun";
  const update = kind === "sh" ? "--update" : "-Update";

  describe(`bootstrap.${kind}`, () => {
    test("no consent, no install: an agent's non-TTY shell stops at exit 3", () => {
      const { home, tmp } = freshHome(`${kind}-noconsent`);
      const { code, out } = run(kind, home, tmp, []);
      expect(code).toBe(3);
      expect(out).toContain("will change this machine");
      expect(nrvAt(home)).toBe(false);
      expect(installs(home)).toEqual([]);
    });

    test("--dry-run prints the list and touches nothing", () => {
      const { home, tmp } = freshHome(`${kind}-dry`);
      const { code, out } = run(kind, home, tmp, [dry]);
      expect(code).toBe(0);
      expect(out).toContain("dry run");
      // Nothing of the bootstrap's own. Not a full listing: PowerShell creates
      // AppData under a redirected USERPROFILE on every start.
      for (const own of [".local", ".nirvana", "installs.log"]) expect(fs.existsSync(path.join(home, own)), own).toBe(false);
      // Only OUR work dirs: PowerShell itself drops __PSScriptPolicyTest_* files
      // into TEMP on every start.
      expect(fs.readdirSync(tmp).filter((e) => e.startsWith("nrv-engine-"))).toEqual([]);
    });

    test("with consent it installs from the tarball, from HOME, with --no-starter, and cleans up", () => {
      const { home, tmp } = freshHome(`${kind}-real`);
      const { code, out } = run(kind, home, tmp, [yes]);
      expect(code).toBe(0);
      expect(nrvAt(home)).toBe(true);
      expect(fs.existsSync(path.join(home, ".nirvana", "skills", "nirvana", "SKILL.md"))).toBe(true);
      const log = installs(home);
      expect(log).toHaveLength(1);
      expect(log[0]).toContain("--no-starter");
      expect(canon(log[0].split("cwd=")[1])).toBe(canon(home));
      expect(out).toContain("engine installed");
      expect(fs.readdirSync(tmp).filter((e) => e.startsWith("nrv-engine-"))).toEqual([]);
    });

    test("a second run says already installed and installs nothing; --update installs again", () => {
      const { home, tmp } = freshHome(`${kind}-real`);
      const again = run(kind, home, tmp, []);
      expect(again.code).toBe(0);
      expect(again.out).toContain("already installed");
      expect(installs(home)).toHaveLength(1);

      const forced = run(kind, home, tmp, [yes, update]);
      expect(forced.code).toBe(0);
      expect(installs(home)).toHaveLength(2);
    });
  });
}

describe("bootstrap.sh usage", () => {
  test("an unknown flag is refused with exit 2", () => {
    if (IS_WINDOWS) return;
    const { home, tmp } = freshHome("sh-usage");
    const { code, out } = run("sh", home, tmp, ["--bogus"]);
    expect(code).toBe(2);
    expect(out).toContain("unknown option");
  });
});

// ── Integrity: the checksum sidecar beside the tarball ───────────────────────
//
// The release publishes <asset>.sha256; a local NIRVANA_ENGINE_TARBALL may have
// a <file>.sha256 sibling. A matching digest is reported, a mismatch stops the
// install before anything is written (exit 6), and no sidecar at all is said
// and tolerated (older releases have none).
describe("bootstrap checksum", () => {
  const kind: "sh" | "ps1" = IS_WINDOWS ? "ps1" : "sh";
  const yes = kind === "sh" ? "--yes" : "-Yes";

  function runWithTarball(home: string, tmp: string, tb: string, args: string[]): { code: number; out: string } {
    const env = fakeHomeEnv(home, {
      NIRVANA_ENGINE_TARBALL: tb,
      PATH: `${path.dirname(process.execPath)}${path.delimiter}${BARE_PATH}`,
      Path: `${path.dirname(process.execPath)}${path.delimiter}${BARE_PATH}`,
      TMPDIR: tmp, TMP: tmp, TEMP: tmp,
    });
    delete env.NIRVANA_BOOTSTRAP_YES;
    delete env.NIRVANA_PROJECT_ROOT;
    const r = kind === "sh"
      ? spawnSync("sh", [SH, ...args], { env, encoding: "utf8", cwd: home, timeout: spawnBudgetMs(60_000) })
      : spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", PS1, ...args], { env, encoding: "utf8", cwd: home, timeout: spawnBudgetMs(60_000) });
    return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  }

  test("a matching sidecar is verified and the install proceeds", () => {
    const { home, tmp } = freshHome(`${kind}-sha-ok`);
    const tb = path.join(tmp, "engine.tar.gz");
    fs.copyFileSync(tarball, tb);
    const digest = createHash("sha256").update(fs.readFileSync(tb)).digest("hex");
    fs.writeFileSync(`${tb}.sha256`, `${digest}  nirvana-os-engine.tar.gz\n`);
    const { code, out } = runWithTarball(home, tmp, tb, [yes]);
    expect(code).toBe(0);
    expect(out).toContain("Checksum verified");
    expect(nrvAt(home)).toBe(true);
  });

  test("a mismatching sidecar stops everything with exit 6 and nothing installed", () => {
    const { home, tmp } = freshHome(`${kind}-sha-bad`);
    const tb = path.join(tmp, "engine.tar.gz");
    fs.copyFileSync(tarball, tb);
    fs.writeFileSync(`${tb}.sha256`, `${"0".repeat(64)}  nirvana-os-engine.tar.gz\n`);
    const { code, out } = runWithTarball(home, tmp, tb, [yes]);
    expect(code).toBe(6);
    expect(out).toContain("Checksum mismatch");
    expect(nrvAt(home)).toBe(false);
    expect(installs(home)).toEqual([]);
  });

  test("no sidecar is said and tolerated", () => {
    const { home, tmp } = freshHome(`${kind}-sha-none`);
    const tb = path.join(tmp, "engine.tar.gz");
    fs.copyFileSync(tarball, tb);
    const { code, out } = runWithTarball(home, tmp, tb, [yes]);
    expect(code).toBe(0);
    expect(out).toContain("No checksum published");
  });
});
