/**
 * squad-env.test.ts — every squad installs into its own environment, and its
 * folder is never written to.
 *
 * The regression this locks: one shared store held one version per package,
 * and its presence check looked at the NAME only, so a squad declaring zod@^3
 * ran on the zod 4.4.3 another squad had installed. Two squads pinning two
 * versions of one package must each get theirs, reached through the run's
 * variables, with nothing created in the squad folder.
 *
 * Hermetic: a fixture NIRVANA_HOME, packages from local tarballs (`file:`),
 * a wheel built on the spot. No registry, no network.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import {
  ensureSquadEnv, nodeLine, prepareSquadEnvs, pythonLine, splitNodeToken, squadEnvDir, squadEnvLines,
  squadPythonBin, squadRunEnv, squadVenvDir, gitExcludeFile, npxShimFiles, squadShimDir, type SquadEnvResult,
} from "../lib/squad-env.ts";
import { binDirsOn, binFile, planNpx, realNpx, windowsCmdLine } from "../lib/npx-shim.ts";
import { depsStore, venvPython } from "../lib/deps-home.ts";
import { squadWorkCard } from "../lib/work-cards.ts";

const REPO = path.resolve(import.meta.dir, "..", "..", "..");
const ACTIVATOR = path.join(REPO, "skills", "squads", "lib", "activator.js");
const BUN = process.execPath;
const FIXTURES = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-squad-env-pkgs-"));
const saved = { home: process.env.NIRVANA_HOME, skills: process.env.NIRVANA_SKILLS_DIR };
const hasNode = spawnSync("node", ["--version"], { windowsHide: true }).status === 0;
let home: string;

/** A one-file npm package as a tarball, so `bun install` never reaches a registry. */
function tarball(name: string, version: string): string {
  const file = path.join(FIXTURES, `${name}-${version}.tgz`);
  if (fs.existsSync(file)) return file;
  const src = path.join(FIXTURES, `${name}-${version}`, "package");
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, "package.json"), JSON.stringify({ name, version, main: "index.js" }));
  fs.writeFileSync(path.join(src, "index.js"), `module.exports = ${JSON.stringify(version)};\n`);
  const r = spawnSync("tar", ["-czf", file, "-C", path.dirname(src), "package"], { windowsHide: true });
  if (r.status !== 0) throw new Error(`tar failed: ${r.stderr}`);
  return file;
}

function squad(slug: string, deps: string): string {
  const dir = path.join(home, "squads", slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "squad.yaml"), `name: ${slug}\ndescription: fixture\n`);
  fs.writeFileSync(path.join(dir, "dependencies.yaml"), deps);
  return dir;
}

const nodeDeps = (...tokens: string[]) => `node:\n  packages:\n${tokens.map((t) => `    - ${JSON.stringify(t)}\n`).join("")}`;

/** Run a script that lives in the squad folder, from there, with the squad's run env. */
function runInSquad(slug: string, squadDir: string, cmd: string, file: string, code: string): string {
  fs.mkdirSync(path.join(squadDir, "scripts"), { recursive: true });
  const f = path.join(squadDir, "scripts", file);
  fs.writeFileSync(f, code);
  const r = spawnSync(cmd, [f], { cwd: squadDir, encoding: "utf8", windowsHide: true, env: { ...process.env, ...squadRunEnv([slug]) } });
  return r.stdout.trim();
}

/**
 * Every path under `dir` with its kind, and for files their size and mtime:
 * what "unchanged" means. `dirMtimes` adds the folders' own mtimes, which any
 * new entry changes; it is off when a link may legitimately appear.
 */
function snapshot(dir: string, dirMtimes = true): string[] {
  const out = dirMtimes ? [`.|${fs.statSync(dir).mtimeMs}`] : [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      const st = fs.lstatSync(full);
      const rel = path.relative(dir, full).split(path.sep).join("/");
      if (st.isSymbolicLink()) out.push(`${rel}|link`);
      else if (st.isDirectory()) { out.push(`${rel}|dir${dirMtimes ? `|${st.mtimeMs}` : ""}`); walk(full); }
      else out.push(`${rel}|file|${st.size}|${st.mtimeMs}`);
    }
  };
  walk(dir);
  return out.sort();
}

/** Where a node_modules link resolves, or null when it is not one. */
function linkTarget(dir: string): string | null {
  const p = path.join(dir, "node_modules");
  try { return fs.lstatSync(p).isSymbolicLink() ? fs.realpathSync(p) : null; } catch { return null; }
}

const real = (p: string) => fs.realpathSync(p);
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

beforeAll(() => { process.env.NIRVANA_SKILLS_DIR = path.join(REPO, "skills"); });
afterAll(() => {
  if (saved.skills === undefined) delete process.env.NIRVANA_SKILLS_DIR; else process.env.NIRVANA_SKILLS_DIR = saved.skills;
  fs.rmSync(FIXTURES, { recursive: true, force: true });
});
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-squad-env-"));
  process.env.NIRVANA_HOME = home;
});
afterEach(() => {
  if (saved.home === undefined) delete process.env.NIRVANA_HOME; else process.env.NIRVANA_HOME = saved.home;
  fs.rmSync(home, { recursive: true, force: true });
});

describe("one environment per squad", () => {
  test("two squads pinning two versions of one package each get theirs", () => {
    const a = squad("old-zod", nodeDeps(`leftish@file:${tarball("leftish", "1.0.0")}`));
    const b = squad("new-zod", nodeDeps(`leftish@file:${tarball("leftish", "2.0.0")}`));
    const ra = ensureSquadEnv("old-zod", a, { bun: BUN });
    const rb = ensureSquadEnv("new-zod", b, { bun: BUN });
    expect(ra).toMatchObject({ ok: true, problems: [], cached: false, node: { installed: true } });
    expect(rb).toMatchObject({ ok: true, node: { installed: true } });
    expect(ra.dir).toBe(path.join(home, ".nirvana", "envs", "old-zod"));
    expect(fs.existsSync(path.join(ra.dir, "bun.lock"))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(ra.dir, "package.json"), "utf8"))).toMatchObject({ name: "squad-env-old-zod", private: true });
    const code = 'console.log(require("leftish"));';
    expect(runInSquad("old-zod", a, BUN, "v.ts", code)).toBe("1.0.0");
    expect(runInSquad("new-zod", b, BUN, "v.ts", code)).toBe("2.0.0");
    // Nothing went to the legacy shared store.
    expect(fs.existsSync(path.join(depsStore(), "leftish"))).toBe(false);
  });

  test("nothing changed: the answer comes from the state file and nothing is spawned", () => {
    const dir = squad("steady", nodeDeps(`leftish@file:${tarball("leftish", "1.0.0")}`));
    expect(ensureSquadEnv("steady", dir, { bun: BUN }).cached).toBe(false);
    // A bun that does not exist would fail any spawn: the hot path must not reach it.
    const again = ensureSquadEnv("steady", dir, { bun: path.join(home, "no-such-bun") });
    expect(again).toMatchObject({ ok: true, cached: true, node: { installed: false } });
    expect(again.durationMs).toBeLessThan(200);
  });

  test("a changed declaration installs again, and a failed install is retried rather than cached", () => {
    const dir = squad("moving", nodeDeps(`leftish@file:${tarball("leftish", "1.0.0")}`));
    ensureSquadEnv("moving", dir, { bun: BUN });
    fs.writeFileSync(path.join(dir, "dependencies.yaml"), nodeDeps(`leftish@file:${tarball("leftish", "2.0.0")}`));
    const broken = ensureSquadEnv("moving", dir, { bun: path.join(home, "no-such-bun") });
    expect(broken.ok).toBe(false);
    expect(broken.problems[0]).toContain("bun install failed");
    const fixed = ensureSquadEnv("moving", dir, { bun: BUN });
    expect(fixed).toMatchObject({ ok: true, cached: false, node: { installed: true } });
    expect(runInSquad("moving", dir, BUN, "v.ts", 'console.log(require("leftish"));')).toBe("2.0.0");
  });

  test("ensure and activation add nothing to the squad folder but the node_modules links to the environment", () => {
    const dir = squad("untouched", nodeDeps(`leftish@file:${tarball("leftish", "1.0.0")}`));
    fs.mkdirSync(path.join(dir, "dashboard"), { recursive: true });
    fs.writeFileSync(path.join(dir, "dashboard", "package.json"), JSON.stringify({ dependencies: { leftish: `file:${tarball("leftish", "2.0.0")}` } }));
    const before = snapshot(dir, false);
    const withLinks = [...before, "node_modules|link", "dashboard/node_modules|link"].sort();

    const r = ensureSquadEnv("untouched", dir, { bun: BUN });
    expect(r).toMatchObject({ ok: true, problems: [], node: { installed: true }, subapps: [{ name: "dashboard", installed: true }] });
    expect(snapshot(dir, false)).toEqual(withLinks);
    expect(linkTarget(dir)).toBe(real(path.join(r.dir, "node_modules")));
    // The sub-app keeps its own version, inside the environment, and its link says so.
    expect(linkTarget(path.join(dir, "dashboard"))).toBe(real(path.join(r.dir, "subapps", "dashboard", "node_modules")));
    expect(JSON.parse(fs.readFileSync(path.join(dir, "dashboard", "node_modules", "leftish", "package.json"), "utf8")).version).toBe("2.0.0");

    // Activation, first on what is already prepared, then from scratch.
    const activate = () => spawnSync(BUN, [ACTIVATOR, "activate", "untouched"], {
      encoding: "utf8", windowsHide: true,
      env: { ...process.env, NIRVANA_HOME: home, SQUADS_DIR: path.join(home, "squads"), NIRVANA_STATE_DIR: path.join(home, "state"),
        NIRVANA_SKILLS_DIR: path.join(REPO, "skills"), NIRVANA_RESOLVED_SQUAD_PATH: dir, NIRVANA_BUN: BUN },
    });
    const warm = activate();
    expect(warm.status).toBe(0);
    expect(JSON.parse(warm.stdout).steps).toMatchObject({ node: { status: "already_present" }, subapps: [{ dir: "dashboard", status: "already_present" }] });
    fs.rmSync(r.dir, { recursive: true, force: true });
    const cold = activate();
    expect(cold.status).toBe(0);
    expect(JSON.parse(cold.stdout).steps).toMatchObject({ node: { status: "installed" }, subapps: [{ dir: "dashboard", status: "installed" }] });
    expect(snapshot(dir, false)).toEqual(withLinks);
  });

  test("a real node_modules the squad ships is left exactly as it is, and nothing else changes", () => {
    const dir = squad("ships-tree", nodeDeps(`leftish@file:${tarball("leftish", "1.0.0")}`));
    fs.mkdirSync(path.join(dir, "node_modules", "own"), { recursive: true });
    fs.writeFileSync(path.join(dir, "node_modules", "own", "marker"), "mine");
    fs.mkdirSync(path.join(dir, "dashboard"), { recursive: true });
    fs.writeFileSync(path.join(dir, "dashboard", "package.json"), JSON.stringify({ dependencies: { leftish: `file:${tarball("leftish", "2.0.0")}` } }));
    fs.writeFileSync(path.join(dir, "dashboard", "node_modules"), "a file the author put here");
    const before = snapshot(dir);
    const r = ensureSquadEnv("ships-tree", dir, { bun: BUN });
    expect(r).toMatchObject({ ok: true, problems: [] });
    expect(snapshot(dir)).toEqual(before);
  });

  test("a link to a missing target or to the legacy store is recreated; a link the author made elsewhere is not", () => {
    const tgz = tarball("leftish", "1.0.0");
    const broken = squad("broken-link", nodeDeps(`leftish@file:${tgz}`));
    fs.symlinkSync(path.join(home, "gone", "node_modules"), path.join(broken, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    const rb = ensureSquadEnv("broken-link", broken, { bun: BUN });
    expect(linkTarget(broken)).toBe(real(path.join(rb.dir, "node_modules")));

    const legacy = squad("legacy-link", nodeDeps(`leftish@file:${tgz}`));
    fs.mkdirSync(depsStore(), { recursive: true });
    fs.symlinkSync(depsStore(), path.join(legacy, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    const rl = ensureSquadEnv("legacy-link", legacy, { bun: BUN });
    expect(linkTarget(legacy)).toBe(real(path.join(rl.dir, "node_modules")));

    const elsewhere = path.join(home, "authors-own-tree");
    fs.mkdirSync(elsewhere, { recursive: true });
    const foreign = squad("foreign-link", nodeDeps(`leftish@file:${tgz}`));
    fs.symlinkSync(elsewhere, path.join(foreign, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    expect(ensureSquadEnv("foreign-link", foreign, { bun: BUN }).problems).toEqual([]);
    expect(linkTarget(foreign)).toBe(real(elsewhere));
  });

  test("a link that is already right is not recreated", () => {
    const dir = squad("settled", nodeDeps(`leftish@file:${tarball("leftish", "1.0.0")}`));
    ensureSquadEnv("settled", dir, { bun: BUN });
    const first = fs.lstatSync(path.join(dir, "node_modules"));
    ensureSquadEnv("settled", dir, { bun: BUN });
    const second = fs.lstatSync(path.join(dir, "node_modules"));
    expect([second.ino, second.mtimeMs, second.birthtimeMs]).toEqual([first.ino, first.mtimeMs, first.birthtimeMs]);
  });

  test.skipIf(process.platform === "win32" || isRoot)("a read-only squad folder: no link, no error, and the packages still resolve", () => {
    const dir = squad("read-only", nodeDeps(`leftish@file:${tarball("leftish", "1.0.0")}`));
    fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(dir, "scripts", "v.ts"), 'console.log(require("leftish"));');
    fs.chmodSync(dir, 0o555);
    try {
      const r = ensureSquadEnv("read-only", dir, { bun: BUN });
      expect(r).toMatchObject({ ok: true, problems: [], node: { installed: true } });
      expect(fs.existsSync(path.join(dir, "node_modules"))).toBe(false);
      const out = spawnSync(BUN, [path.join(dir, "scripts", "v.ts")], { cwd: dir, encoding: "utf8", env: { ...process.env, ...squadRunEnv(["read-only"]) } });
      expect(out.stdout.trim()).toBe("1.0.0");
    } finally { fs.chmodSync(dir, 0o755); }
  });

  test("inside a git work tree the link is excluded through .git/info/exclude, once, and .gitignore is never touched", () => {
    const repo = path.join(home, "squads");
    fs.mkdirSync(path.join(repo, ".git", "info"), { recursive: true });
    const dir = squad("in-git", nodeDeps(`leftish@file:${tarball("leftish", "1.0.0")}`));
    fs.writeFileSync(path.join(dir, ".gitignore"), "dist/\n");
    ensureSquadEnv("in-git", dir, { bun: BUN });
    fs.unlinkSync(path.join(dir, "node_modules"));
    ensureSquadEnv("in-git", dir, { bun: BUN });   // recreated: the exclude is not added twice
    expect(fs.readFileSync(path.join(repo, ".git", "info", "exclude"), "utf8")).toBe("node_modules\n");
    expect(fs.readFileSync(path.join(dir, ".gitignore"), "utf8")).toBe("dist/\n");
  });

  test("a linked worktree's exclude is the shared one, found through gitdir: and commondir", () => {
    const main = path.join(home, "main-repo", ".git");
    fs.mkdirSync(path.join(main, "worktrees", "wt"), { recursive: true });
    fs.writeFileSync(path.join(main, "worktrees", "wt", "commondir"), "../..\n");
    const wt = path.join(home, "wt");
    fs.mkdirSync(path.join(wt, "squad"), { recursive: true });
    fs.writeFileSync(path.join(wt, ".git"), `gitdir: ${path.join(main, "worktrees", "wt")}\n`);
    expect(gitExcludeFile(path.join(wt, "squad"))).toBe(path.join(main, "info", "exclude"));
    expect(gitExcludeFile(os.tmpdir())).toBeNull();
  });

  test.skipIf(!hasNode)("the run env reaches the packages from the squad folder: bun, node CommonJS and node ESM", () => {
    const dir = squad("reach", nodeDeps(`leftish@file:${tarball("leftish", "1.0.0")}`));
    ensureSquadEnv("reach", dir, { bun: BUN });
    expect(runInSquad("reach", dir, BUN, "a.ts", 'import l from "leftish"; console.log(l);')).toBe("1.0.0");
    expect(runInSquad("reach", dir, "node", "b.cjs", 'console.log(require("leftish"));')).toBe("1.0.0");
    // Node's ESM loader ignores NODE_PATH; the hook in NODE_OPTIONS is what resolves this one.
    expect(runInSquad("reach", dir, "node", "c.mjs", 'import l from "leftish"; console.log(l);')).toBe("1.0.0");
  });

  test("a squad that declares nothing gets no environment and spawns nothing", () => {
    const dir = squad("plain", "system:\n  - git\n");
    const r = ensureSquadEnv("plain", dir, { bun: path.join(home, "no-such-bun") });
    expect(r).toMatchObject({ ok: true, node: null, python: null, cached: true });
    expect(fs.existsSync(squadEnvDir("plain"))).toBe(false);
  });

  test("tokens keep the declared version exactly", () => {
    expect(splitNodeToken("zod@^3")).toEqual(["zod", "^3"]);
    expect(splitNodeToken("@remotion/cli@4.0.0")).toEqual(["@remotion/cli", "4.0.0"]);
    expect(splitNodeToken("sharp")).toEqual(["sharp", "latest"]);
    expect(splitNodeToken("@scope/pkg")).toEqual(["@scope/pkg", "latest"]);
    expect(splitNodeToken("alias@npm:real@1.2.3")).toEqual(["alias", "npm:real@1.2.3"]);
  });
});

describe("python", () => {
  test("the interpreter path follows the platform", () => {
    expect(venvPython("/e/.venv", "linux")).toBe("/e/.venv/bin/python");
    expect(venvPython("/e/.venv", "darwin")).toBe("/e/.venv/bin/python");
    expect(venvPython("C:\\e\\.venv", "win32")).toBe("C:\\e\\.venv\\Scripts\\python.exe");
    expect(squadVenvDir("x")).toBe(path.join(home, ".nirvana", "envs", "x", ".venv"));
  });

  const pyCmd = process.platform === "win32" ? "python" : "python3";
  const uv = spawnSync("uv", ["--version"], { windowsHide: true }).status === 0;
  const py = spawnSync(pyCmd, ["--version"], { windowsHide: true }).status === 0;
  test.skipIf(!uv || !py)("uv builds the squad's own venv, two squads keep two versions, and the folder is untouched", () => {
    const wheel = (v: string) => {
      const file = path.join(FIXTURES, `pyleft-${v}-py3-none-any.whl`);
      const code = [
        "import sys, zipfile",
        "v, p = sys.argv[1], sys.argv[2]",
        "z = zipfile.ZipFile(p, 'w')",
        "z.writestr('pyleft/__init__.py', 'VERSION = %r\\n' % v)",
        "d = 'pyleft-%s.dist-info/' % v",
        "z.writestr(d + 'METADATA', 'Metadata-Version: 2.1\\nName: pyleft\\nVersion: %s\\n' % v)",
        "z.writestr(d + 'WHEEL', 'Wheel-Version: 1.0\\nGenerator: test\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n')",
        "z.writestr(d + 'RECORD', '')",
        "z.close()",
      ].join("\n");
      spawnSync(pyCmd, ["-I", "-c", code, v, file], { windowsHide: true });
      return file;
    };
    const one = squad("py-one", `python:\n  packages:\n    - ${JSON.stringify(wheel("1.0"))}\n`);
    const two = squad("py-two", `python:\n  packages:\n    - ${JSON.stringify(wheel("2.0"))}\n`);
    const before = snapshot(one);
    const r1 = ensureSquadEnv("py-one", one);
    const r2 = ensureSquadEnv("py-two", two);
    expect(r1).toMatchObject({ ok: true, python: { installed: true, bin: venvPython(squadVenvDir("py-one")) } });
    expect(r2.ok).toBe(true);
    const version = (slug: string) => spawnSync(squadPythonBin(slug)!, ["-c", "import pyleft; print(pyleft.VERSION)"], { encoding: "utf8", windowsHide: true }).stdout.trim();
    expect(version("py-one")).toBe("1.0");
    expect(version("py-two")).toBe("2.0");
    expect(ensureSquadEnv("py-one", one).cached).toBe(true);
    expect(snapshot(one)).toEqual(before);
    // The run env puts the venv first on PATH, so a bare `python` in a squad script is the squad's.
    expect(squadRunEnv(["py-one"]).VIRTUAL_ENV).toBe(squadVenvDir("py-one"));
  });
});

describe("what the worker is told", () => {
  /** A venv's interpreter, as a file: the line only checks that it exists. */
  function fakeVenv(slug: string): string {
    const bin = venvPython(squadVenvDir(slug));
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.writeFileSync(bin, "");
    return bin;
  }

  test("the Python line appears only when the squad has a venv", () => {
    const dir = squad("cardy", "");
    expect(squadEnvLines("cardy")).toEqual([]);
    expect(squadWorkCard("cardy", dir)).not.toContain("This squad's Python");
    const bin = fakeVenv("cardy");
    expect(squadEnvLines("cardy")).toEqual([pythonLine(bin)]);
    expect(squadWorkCard("cardy", dir)).toContain(pythonLine(bin));
  });

  test("the Node line and the run env appear only when the squad has packages", () => {
    expect(squadRunEnv(["nothing-here"])).toEqual({});
    const modules = path.join(squadEnvDir("noded"), "node_modules");
    fs.mkdirSync(path.join(modules, ".bin"), { recursive: true });
    expect(squadEnvLines("noded")).toEqual([nodeLine(modules)]);
    const base = { PATH: "/usr/bin", NODE_PATH: "/mine", NODE_OPTIONS: "--max-old-space-size=4096" };
    const env = squadRunEnv(["noded"], base);
    expect(env.NODE_PATH).toBe([modules, "/mine"].join(path.delimiter));
    expect(env.PATH).toBe([path.join(modules, ".bin"), "/usr/bin"].join(path.delimiter));
    expect(env.NODE_OPTIONS).toStartWith("--max-old-space-size=4096 --import=file:");
    expect(env.NODE_OPTIONS).toEndWith("node-path-hook.mjs");
    // Windows spells it Path: the same key comes back, never a second one.
    const win = squadRunEnv(["noded"], { Path: "C:\\x" });
    expect(Object.keys(win)).toContain("Path");
    expect(Object.keys(win)).not.toContain("PATH");
  });

  test("an install failure reaches the card as one line", () => {
    const dir = squad("broken", "");
    expect(squadWorkCard("broken", dir, ["bun install failed: x"])).toContain("Environment problem: bun install failed: x");
  });
});

describe("prepareSquadEnvs (the dispatch step)", () => {
  const res = (over: Partial<SquadEnvResult>): SquadEnvResult =>
    ({ ok: true, problems: [], node: null, subapps: [], python: null, durationMs: 1800, cached: true, dir: "/e", ...over });

  test("ensures every squad that will run, prints only what installed or failed, and returns the failures", () => {
    const dirs = ["quiet", "fresh", "failing"].map((s) => ({ slug: s, dir: squad(s, "") }));
    const called: string[] = [];
    const lines: string[] = [];
    const notes = prepareSquadEnvs([...dirs, { slug: "absent", dir: path.join(home, "nowhere") }], {
      print: (l) => lines.push(l),
      ensure: (slug, dir) => {
        called.push(`${slug}:${path.basename(dir)}`);
        if (slug === "fresh") return res({ cached: false, node: { installed: true, packages: [] } });
        if (slug === "failing") return res({ ok: false, cached: false, problems: ["python: uv exited 1"] });
        return res({});
      },
    });
    expect(called).toEqual(["quiet:quiet", "fresh:fresh", "failing:failing"]);
    expect(lines).toEqual(["  env fresh: node ready (1.8 s)", "  ⚠ env failing: python: uv exited 1"]);
    expect([...notes.entries()]).toEqual([["failing", ["python: uv exited 1"]]]);
  });
});

describe("npx in the worker's run", () => {
  /** A package with one bin, as a tarball, so the env has something for npx to find. */
  function binTarball(): string {
    const file = path.join(FIXTURES, "probe-cli-1.0.0.tgz");
    if (fs.existsSync(file)) return file;
    const src = path.join(FIXTURES, "probe-cli", "package");
    fs.mkdirSync(path.join(src, "bin"), { recursive: true });
    fs.writeFileSync(path.join(src, "package.json"), JSON.stringify({ name: "@probe/cli", version: "1.0.0", bin: { probe: "bin/probe.js" } }));
    fs.writeFileSync(path.join(src, "bin", "probe.js"), '#!/usr/bin/env bun\nconsole.log("probe from the env", process.argv.slice(2).join(" "));\n', { mode: 0o755 });
    spawnSync("tar", ["-czf", file, "-C", path.dirname(src), "package"], { windowsHide: true });
    return file;
  }

  test.skipIf(process.platform === "win32")("a squad script's `npx <bin>` runs the environment's binary, whatever npx flags it carries", () => {
    const dir = squad("npx-user", nodeDeps(`@probe/cli@file:${binTarball()}`));
    expect(ensureSquadEnv("npx-user", dir, { bun: BUN }).ok).toBe(true);
    expect(fs.existsSync(path.join(squadShimDir("npx-user"), "npx"))).toBe(true);
    const env = { ...process.env, ...squadRunEnv(["npx-user"]) };
    for (const line of ["npx probe a b", "npx -y probe a b", "npx --no-install -- probe a b", "npx @probe/cli@1.0.0 a b", "npx --package=@probe/cli probe a b", "npx -p @probe/cli probe a b"]) {
      const r = spawnSync("sh", ["-c", line], { cwd: dir, encoding: "utf8", env });
      expect(`${line} -> ${r.stdout.trim()}`).toBe(`${line} -> probe from the env a b`);
    }
  });

  const files = new Set([
    "/e1/node_modules/.bin/probe", "/e2/node_modules/.bin/other",
    "C:\\e\\node_modules\\.bin\\probe.cmd", "/usr/local/bin/npx", "C:\\node\\npx.cmd",
  ]);
  const exists = (p: string) => files.has(p);
  const read = (f: string) => f === path.join("/e1/node_modules", "@probe/cli", "package.json") ? JSON.stringify({ bin: { probe: "x.js" } }) : null;
  const dirs = ["/e1/node_modules/.bin", "/e2/node_modules/.bin"];

  test("the plan: flags, --, --package, a versioned scoped spec, and what falls through", () => {
    const o = { platform: "linux" as const, exists, read };
    expect(planNpx(["probe", "x"], dirs, o)).toEqual({ kind: "bin", bin: "/e1/node_modules/.bin/probe", args: ["x"] });
    expect(planNpx(["--yes", "--", "other", "-v"], dirs, o)).toEqual({ kind: "bin", bin: "/e2/node_modules/.bin/other", args: ["-v"] });
    expect(planNpx(["-p", "whatever", "probe"], dirs, o)).toMatchObject({ kind: "bin", bin: "/e1/node_modules/.bin/probe" });
    expect(planNpx(["@probe/cli@^1", "render"], dirs, o)).toEqual({ kind: "bin", bin: "/e1/node_modules/.bin/probe", args: ["render"] });
    expect(planNpx(["-c", "probe x"], dirs, o).kind).toBe("fallthrough");
    expect(planNpx(["tsx", "x.ts"], dirs, o).kind).toBe("fallthrough");
    expect(planNpx(["-y"], dirs, o).kind).toBe("fallthrough");
  });

  test("Windows: .cmd bins, the real npx found past every shim folder, and the generated npx.cmd", () => {
    expect(binFile("C:\\e\\node_modules\\.bin", "probe", "win32", exists)).toBe("C:\\e\\node_modules\\.bin\\probe.cmd");
    expect(binDirsOn("C:\\e\\.shim;C:\\e\\node_modules\\.bin;C:\\node", "win32")).toEqual(["C:\\e\\node_modules\\.bin"]);
    expect(realNpx("C:\\e\\.shim;C:\\node", "win32", (p) => p === "C:\\node\\npx.cmd" || p === "C:\\e\\.shim\\npx.cmd")).toBe("C:\\node\\npx.cmd");
    expect(realNpx("/e/.shim:/usr/local/bin", "linux", exists)).toBe("/usr/local/bin/npx");
    expect(windowsCmdLine("C:\\b\\probe.cmd", ["a^b", "c&d"])).toBe('"C:\\b\\probe.cmd" "a^b" "c&d"');
    const shim = npxShimFiles("C:\\bun\\bun.exe", "C:\\skills\\_shared\\lib\\npx-shim.ts");
    expect(shim.cmd.split("\r\n")).toEqual([
      "@echo off",
      "rem Nirvana squad environment: npx that runs the environment's own binaries (npx-shim.ts).",
      'set "NRV_BUN=C:\\bun\\bun.exe"',
      'if not exist "%NRV_BUN%" set "NRV_BUN=bun"',
      '"%NRV_BUN%" "C:\\skills\\_shared\\lib\\npx-shim.ts" %*',
      "exit /b %ERRORLEVEL%",
      "",
    ]);
    expect(npxShimFiles("/o'k/bun", "/s/npx-shim.ts").posix).toContain("B='/o'\\''k/bun'");
  });
});
