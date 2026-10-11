// engine-release-channel.test.ts — an implicit engine update keeps the
// installed engine's release channel and never goes back in version.
//
// Every implicit fetch used to download `releases/latest`, which GitHub never
// points at a prerelease: a machine on 0.15.0-beta.5 was put back on 0.14.10 by
// the next `nrv update`. These run the rule (engine-release.ts) on its own, then
// the real `nrv update` script against a fake release list served locally.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  compareSemver, fetchEngineReleases, isPrerelease, mayReplace, parseReleaseList, pickEngineRelease, planEngineUpdate,
  type EngineRelease,
} from "../../nirvana/scripts/engine-release.ts";
import { runAsync, startFakeReleases, type FakeReleaseServer } from "./helpers/fake-releases.ts";
import { spawnBudgetMs } from "./helpers/test-budgets.ts";

const rel = (version: string, prerelease = version.includes("-")): EngineRelease => ({ version, prerelease, url: `u/${version}` });
const LIST = [rel("0.14.9"), rel("0.14.10"), rel("0.15.0-beta.4"), rel("0.15.0-beta.5"), rel("0.15.0-beta.6")];

describe("semver", () => {
  test("orders releases, prereleases and their identifiers the semver way", () => {
    const ordered = ["0.14.9", "0.14.10", "0.15.0-alpha", "0.15.0-alpha.1", "0.15.0-beta", "0.15.0-beta.2", "0.15.0-beta.10", "0.15.0-rc.1", "0.15.0", "0.15.1"];
    for (let i = 0; i < ordered.length - 1; i++) {
      expect(compareSemver(ordered[i], ordered[i + 1]), `${ordered[i]} < ${ordered[i + 1]}`).toBe(-1);
      expect(compareSemver(ordered[i + 1], ordered[i])).toBe(1);
    }
    expect(compareSemver("v0.15.0-beta.5", "0.15.0-beta.5")).toBe(0);
    expect(compareSemver("0.15.0+build.7", "0.15.0")).toBe(0);
    expect(compareSemver("unknown", "0.15.0")).toBeNull();
  });

  test("a hyphen makes a prerelease", () => {
    expect(isPrerelease("0.15.0-beta.5")).toBe(true);
    expect(isPrerelease("0.14.10")).toBe(false);
    expect(isPrerelease(null)).toBe(false);
  });
});

describe("which release an installed engine may move to", () => {
  test("a prerelease moves to the newest greater release, prerelease or stable", () => {
    expect(pickEngineRelease("0.15.0-beta.5", LIST)?.version).toBe("0.15.0-beta.6");
    expect(pickEngineRelease("0.15.0-beta.5", [...LIST, rel("0.15.0")])?.version).toBe("0.15.0");
  });

  test("a stable engine moves only to a greater stable", () => {
    expect(pickEngineRelease("0.14.9", LIST)?.version).toBe("0.14.10");
    expect(pickEngineRelease("0.14.10", LIST)).toBeNull();
  });

  test("nothing older or equal is ever picked", () => {
    expect(pickEngineRelease("0.15.0-beta.6", LIST)).toBeNull();
    expect(pickEngineRelease("0.16.0", LIST)).toBeNull();
  });

  test("no installed engine takes the newest stable", () => {
    expect(pickEngineRelease(null, LIST)?.version).toBe("0.14.10");
  });

  test("a downloaded engine replaces the installed one only when it is newer", () => {
    expect(mayReplace("0.14.10", "0.15.0-beta.5")).toBe(false);
    expect(mayReplace("0.15.0", "0.15.0-beta.5")).toBe(true);
    expect(mayReplace("0.14.10", "0.14.10")).toBe(false);
    expect(mayReplace("0.14.10", "0.14.10", true)).toBe(true);
    expect(mayReplace("0.14.10", null)).toBe(true);
    // An unreadable download: allowed over stable (as before), never over a prerelease.
    expect(mayReplace(null, "0.14.9")).toBe(true);
    expect(mayReplace(null, "0.15.0-beta.5")).toBe(false);
  });

  test("the release list keeps only releases that carry the engine asset", () => {
    const parsed = parseReleaseList([
      { tag_name: "v0.15.0-beta.6", prerelease: true, assets: [{ name: "nirvana-os-engine.tar.gz", browser_download_url: "https://x/b6" }] },
      { tag_name: "v0.15.0-beta.7", prerelease: true, assets: [] },
      { tag_name: "v0.16.0", draft: true, assets: [{ name: "nirvana-os-engine.tar.gz", browser_download_url: "https://x/d" }] },
      { tag_name: "not-a-version", assets: [{ name: "nirvana-os-engine.tar.gz", browser_download_url: "https://x/n" }] },
    ]);
    expect(parsed).toEqual([{ version: "0.15.0-beta.6", prerelease: true, url: "https://x/b6" }]);
  });
});

describe("reading the release list", () => {
  const env = { NIRVANA_ENGINE_RELEASES_API: "http://api.invalid/releases", NIRVANA_ENGINE_LATEST_URL: "http://dl.invalid/latest.tar.gz" };

  test("the rate limit is reported, never thrown, and the plan falls back to latest", async () => {
    const limited = async () => new Response("{}", { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1700000000" } });
    const r = await fetchEngineReleases("o/r", { env, fetchImpl: limited });
    expect("error" in r && r.error).toContain("rate limit");
    const plan = await planEngineUpdate("0.15.0-beta.5", { env, fetchImpl: limited });
    expect(plan.kind).toBe("fallback");
    expect(plan.kind === "fallback" && plan.url).toBe(env.NIRVANA_ENGINE_LATEST_URL);
    expect(plan.reason).toContain("only if newer than 0.15.0-beta.5");
  });

  test("an unreachable API falls back the same way", async () => {
    const down = async () => { throw new Error("ECONNREFUSED"); };
    const plan = await planEngineUpdate("0.14.9", { env, fetchImpl: down });
    expect(plan.kind).toBe("fallback");
    expect(plan.reason).toContain("unreachable");
  });

  test("nothing greater means current, with the newest of the channel named", async () => {
    const list = async () => Response.json([
      { tag_name: "v0.14.10", prerelease: false, assets: [{ name: "nirvana-os-engine.tar.gz", browser_download_url: "https://x/s" }] },
      { tag_name: "v0.15.0-beta.5", prerelease: true, assets: [{ name: "nirvana-os-engine.tar.gz", browser_download_url: "https://x/b5" }] },
    ]);
    const plan = await planEngineUpdate("0.15.0-beta.5", { env, fetchImpl: list });
    expect(plan.kind).toBe("current");
    const stable = await planEngineUpdate("0.14.10", { env, fetchImpl: list });
    expect(stable.kind).toBe("current");
  });
});

// ── `nrv update` on a release install, end to end ─────────────────────────────
let root: string;
let server: FakeReleaseServer;

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nrv-channel-")));
  server = startFakeReleases(root);
});
afterAll(() => {
  server.stop();
  fs.rmSync(root, { recursive: true, force: true });
});

const UPDATE = path.join(import.meta.dir, "..", "scripts", "update.ts");

async function nrvUpdate(name: string, installed: string, extraEnv: Record<string, string> = {}, args: string[] = []) {
  const home = path.join(root, name);
  const skills = path.join(home, ".nirvana", "skills");
  fs.mkdirSync(skills, { recursive: true });
  fs.writeFileSync(path.join(skills, "VERSION"), `${installed}\n`);
  const env: Record<string, string | undefined> = { ...process.env, HOME: home, USERPROFILE: home, NIRVANA_SKILLS_DIR: skills, ...server.env };
  delete env.NIRVANA_ENGINE_URL;
  delete env.NIRVANA_ENGINE_TARBALL;
  Object.assign(env, extraEnv);
  const r = await runAsync([process.execPath, UPDATE, ...args], { cwd: home, env, timeoutMs: spawnBudgetMs(3) });
  const log = path.join(home, "installs.log");
  return {
    ...r,
    version: fs.readFileSync(path.join(skills, "VERSION"), "utf8").trim(),
    installs: fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : [],
    backups: fs.readdirSync(path.join(home, ".nirvana")).filter((e) => e.startsWith("skills-backup-")),
  };
}

describe("nrv update keeps the channel", () => {
  test("a beta moves to the newest greater beta, never to the older stable", async () => {
    server.setRateLimited(false);
    server.setReleases([{ version: "0.14.10" }, { version: "0.15.0-beta.5", prerelease: true }, { version: "0.15.0-beta.6", prerelease: true }]);
    const r = await nrvUpdate("beta-up", "0.15.0-beta.5");
    expect(r.code, r.out).toBe(0);
    expect(r.installs).toEqual(["0.15.0-beta.6"]);
    expect(r.version).toBe("0.15.0-beta.6");
  }, spawnBudgetMs(3));

  test("a beta with nothing newer stays put: no download, no backup, no install", async () => {
    server.setReleases([{ version: "0.14.10" }, { version: "0.15.0-beta.5", prerelease: true }]);
    const r = await nrvUpdate("beta-current", "0.15.0-beta.5");
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("0.15.0-beta.5 is current");
    expect(r.installs).toEqual([]);
    expect(r.backups).toEqual([]);
    expect(r.version).toBe("0.15.0-beta.5");
  }, spawnBudgetMs(3));

  test("a stable engine ignores prereleases and takes the newer stable", async () => {
    server.setReleases([{ version: "0.14.10" }, { version: "0.14.11" }, { version: "0.15.0-beta.6", prerelease: true }]);
    const r = await nrvUpdate("stable-up", "0.14.10");
    expect(r.code, r.out).toBe(0);
    expect(r.installs).toEqual(["0.14.11"]);
  }, spawnBudgetMs(3));

  test("--check names the release it would install and changes nothing", async () => {
    server.setReleases([{ version: "0.15.0-beta.6", prerelease: true }]);
    const r = await nrvUpdate("check", "0.15.0-beta.5", {}, ["--check"]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("0.15.0-beta.5 → 0.15.0-beta.6");
    expect(r.installs).toEqual([]);
  }, spawnBudgetMs(3));

  test("rate limited: latest is downloaded but an older stable never replaces a beta", async () => {
    server.setRateLimited(true);
    server.setLatest("0.14.10");
    const r = await nrvUpdate("limited-beta", "0.15.0-beta.5");
    server.setRateLimited(false);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("rate limit");
    expect(r.out).toContain("nothing changed");
    expect(r.installs).toEqual([]);
    expect(r.version).toBe("0.15.0-beta.5");
  }, spawnBudgetMs(3));

  test("rate limited: a newer latest is still installed (today's behaviour)", async () => {
    server.setRateLimited(true);
    server.setLatest("0.14.10");
    const r = await nrvUpdate("limited-stable", "0.14.9");
    server.setRateLimited(false);
    expect(r.code, r.out).toBe(0);
    expect(r.installs).toEqual(["0.14.10"]);
  }, spawnBudgetMs(3));

  test("an explicit NIRVANA_ENGINE_URL still wins, even to an older version", async () => {
    server.setReleases([{ version: "0.15.0-beta.6", prerelease: true }]);
    const r = await nrvUpdate("pinned", "0.15.0-beta.5", { NIRVANA_ENGINE_URL: `${server.base}/download/v0.14.10/nirvana-os-engine.tar.gz` });
    expect(r.code, r.out).toBe(0);
    expect(r.installs).toEqual(["0.14.10"]);
  }, spawnBudgetMs(3));
});
