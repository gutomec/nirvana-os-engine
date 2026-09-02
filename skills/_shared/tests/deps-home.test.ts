/**
 * deps-home.test.ts — the dependency home is ONE directory, and it stays that way.
 *
 * The regression this locks: `nrv activate <squad>` used to run the package
 * manager with `cwd: <squad dir>`, so every squad that declared puppeteer or
 * remotion got its own ~276 MB tree, and nothing pinned the caches those
 * packages download into. Two squads, same packages, two copies — plus a
 * Chromium in ~/.cache that no one had asked for.
 *
 * Every test runs against a fixture NIRVANA_HOME. Reading the real ~/.nirvana
 * would make the suite pass on this machine and prove nothing anywhere else.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, lstatSync, symlinkSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";

const REPO = resolve(import.meta.dir, "..", "..", "..");
const LIB = join(REPO, "skills", "_shared", "lib", "deps-home.ts");
const ACTIVATOR = join(REPO, "skills", "squads", "lib", "activator.js");

let home: string;
let saved: string | undefined;

/** Fresh module instance bound to the fixture home (the paths are read per call). */
async function load() {
  return await import(`${LIB}?t=${Date.now()}${Math.random()}`);
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "nrv-deps-"));
  saved = process.env.NIRVANA_HOME;
  process.env.NIRVANA_HOME = home;
});

afterEach(() => {
  if (saved === undefined) delete process.env.NIRVANA_HOME;
  else process.env.NIRVANA_HOME = saved;
  rmSync(home, { recursive: true, force: true });
});

describe("there is exactly one dependency home", () => {
  test("the store, the python home and every cache sit under ~/.nirvana", async () => {
    const D = await load();
    const root = join(home, ".nirvana");
    expect(D.nirvanaHome()).toBe(root);
    expect(D.depsStore()).toBe(join(root, "node_modules"));
    expect(D.pythonHome()).toBe(join(root, "python"));
    expect(D.depsManifest()).toBe(join(root, "package.json"));
    for (const tool of ["puppeteer", "playwright", "huggingface", "pip"]) {
      expect(D.depsCache(tool)).toBe(join(root, "cache", tool));
    }
  });

  test("depsEnv pins every tool that downloads a runtime of its own", async () => {
    const D = await load();
    const env = D.depsEnv({});
    const root = join(home, ".nirvana");
    // Each of these was unset before, which is why 892 MB of Chromium and
    // 4.5 GB of model weights landed in ~/.cache.
    expect(env.PUPPETEER_CACHE_DIR).toBe(join(root, "cache", "puppeteer"));
    expect(env.PLAYWRIGHT_BROWSERS_PATH).toBe(join(root, "cache", "playwright"));
    expect(env.HF_HOME).toBe(join(root, "cache", "huggingface"));
    expect(env.PYTHONUSERBASE).toBe(join(root, "python"));
    expect(env.NODE_PATH).toBe(join(root, "node_modules"));
  });

  test("an existing NODE_PATH is prepended to, never replaced", async () => {
    const D = await load();
    const env = D.depsEnv({ NODE_PATH: "/somewhere/else" });
    expect(env.NODE_PATH.split(":")[0]).toBe(join(home, ".nirvana", "node_modules"));
    expect(env.NODE_PATH).toContain("/somewhere/else");
  });
});

describe("a package name is data, never a command", () => {
  test("the planned install is an argv, and the token is one element of it", async () => {
    const D = await load();
    const token = "left-pad && echo pwned";
    const plan = D.install([token], { dryRun: true });
    expect(Array.isArray(plan.argv)).toBe(true);
    // The token survives whole, as ONE argument. Joined into a shell line it
    // would have become a second command.
    expect(plan.argv.at(-1)).toBe(token);
    expect(plan.argv).toContain("--cwd");
    // And the destination is the store's parent, never a squad.
    expect(plan.argv[plan.argv.indexOf("--cwd") + 1]).toBe(join(home, ".nirvana"));
  });

  test("`bun add` is the primitive, because it merges instead of pruning", async () => {
    const D = await load();
    const plan = D.install(["yaml@^2"], { dryRun: true });
    // `bun install` would delete every package not in this one manifest —
    // i.e. everything the other squads depend on.
    expect(plan.argv[1]).toBe("add");
    expect(plan.argv).not.toContain("install");
  });
});

describe("consumers resolve by symlink, and a real tree is never clobbered", () => {
  test("link points node_modules at the store and is idempotent", async () => {
    const D = await load();
    const consumer = join(home, "squads", "demo");
    mkdirSync(consumer, { recursive: true });

    const first = D.link(consumer);
    expect(first.status).toBe("linked");
    expect(lstatSync(join(consumer, "node_modules")).isSymbolicLink()).toBe(true);

    expect(D.link(consumer).status).toBe("already_linked");
  });

  test("an existing real node_modules is reported, not deleted", async () => {
    const D = await load();
    const consumer = join(home, "squads", "occupied");
    mkdirSync(join(consumer, "node_modules", "some-pkg"), { recursive: true });

    const r = D.link(consumer);
    expect(r.status).toBe("occupied");
    // Still there: adopting it is a separate, explicit step.
    expect(existsSync(join(consumer, "node_modules", "some-pkg"))).toBe(true);
  });
});

describe("scatter is detectable", () => {
  test("a real tree outside the store is found; a link to the store is not", async () => {
    const D = await load();
    const root = join(home, "content");
    const strayDir = join(root, "squad-a");
    const linkedDir = join(root, "squad-b");
    mkdirSync(join(strayDir, "node_modules", "puppeteer"), { recursive: true });
    writeFileSync(join(strayDir, "node_modules", "puppeteer", "index.js"), "x".repeat(2048));
    mkdirSync(linkedDir, { recursive: true });
    mkdirSync(D.depsStore(), { recursive: true });
    symlinkSync(D.depsStore(), join(linkedDir, "node_modules"), "dir");

    const strays = D.findStrays([root]);
    expect(strays.map((s: { dir: string }) => s.dir)).toEqual([join(strayDir, "node_modules")]);
    expect(strays[0].bytes).toBeGreaterThan(2000);
  });

  test("the store itself is never reported as a stray", async () => {
    const D = await load();
    mkdirSync(join(D.depsStore(), "yaml"), { recursive: true });
    expect(D.findStrays([join(home, ".nirvana")])).toEqual([]);
  });
});

describe("the activator installs centrally — the source says so", () => {
  const src = () => readFileSync(ACTIVATOR, "utf8");

  test("the local node path no longer points a package manager at the squad dir", () => {
    // The exact line that caused the incident. Its return would reintroduce it.
    expect(src()).not.toContain("cwd: g ? undefined : (expandPath(!Array.isArray(spec) ? spec.cwd : null) || squadDir)");
    expect(src()).toContain("DEPS.install(tokens)");
    expect(src()).toContain("DEPS.link(squadDir)");
  });

  test("sub-apps are centralized too, instead of one install per sub-directory", () => {
    // `runCmd(cmd, { cwd: sub })` is what gave instagram-intelligence-nirvana
    // a node_modules in dashboard/ AND scripts/.
    expect(src()).not.toContain("const r = runCmd(cmd, { cwd: sub });");
    expect(src()).toContain("DEPS.link(sub)");
  });

  test("a synthesized manifest carries no squad-local destination", () => {
    expect(src()).not.toContain("cwd: squadDir");
    expect(src()).not.toContain("target_dir: squadDir");
  });

  test("every spawn inherits the pinned environment", () => {
    const s = src();
    expect(s).toContain("env: { ...DEPS.depsEnv(process.env), ...(opts.env || {}) }");
    // Both spawn helpers, not just one.
    expect(s.split("DEPS.depsEnv(process.env)").length - 1).toBeGreaterThanOrEqual(2);
  });
});

describe("the contract tells agents the rule", () => {
  test("the project template forbids installing where you are standing", () => {
    const tpl = readFileSync(join(REPO, "skills", "_shared", "templates", "AGENTS.md"), "utf8");
    expect(tpl).toContain("nirvana:deps-rule:v1");
    expect(tpl).toContain("~/.nirvana/node_modules");
    expect(tpl).toContain("nrv deps install");
    // The carve-out has to survive too, or squads lose ffmpeg.
    expect(tpl.toLowerCase()).toContain("ffmpeg");
  });

  test("the squad dependency template no longer teaches a squad-local cwd", () => {
    const tpl = readFileSync(join(REPO, "skills", "squads", "templates", "dependencies.template.yaml"), "utf8");
    expect(tpl).not.toContain('cwd: "${SQUADS_DIR}');
    expect(tpl).toContain("~/.nirvana/node_modules");
  });
});
