// pack-setup-channel-licenses.test.ts — what a pack's setup.ts does to a
// machine that already has an engine and other packs.
//
// 1. One license per pack. Every pack's setup wrote the single
//    ~/.nirvana-license/PROVENANCE.json, so the last pack installed took the
//    others' keys away and `nrv update <other pack>` was refused. Setup now also
//    writes ~/.nirvana-license/packs/<slug>/; update-pack reads the pack's own
//    file first and the legacy file after it, so an install made before the
//    per-pack copies still updates.
// 2. The engine's release channel. Setup updates the engine on every run, and
//    `releases/latest` is never a prerelease: a beta engine was put back on the
//    stable line by installing any pack.
// 3. setup.sh hands its arguments to setup.ts.
//
// Hermetic: a stub engine in a temporary HOME (the scripts setup.ts calls,
// each leaving evidence), the real setup.ts and update-pack.ts, and fake
// squads.sh / GitHub endpoints served on 127.0.0.1.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fakeHomeEnv } from "./helpers/fake-home.ts";
import { runAsync, startFakeReleases, type FakeReleaseServer } from "./helpers/fake-releases.ts";
import { spawnBudgetMs } from "./helpers/test-budgets.ts";

const REPO = path.resolve(import.meta.dir, "..", "..", "..");
const SETUP_DIR = path.join(REPO, "packaging", "pack");
const UPDATE_PACK = path.join(REPO, "skills", "_shared", "scripts", "update-pack.ts");
const IS_WINDOWS = process.platform === "win32";

let root: string;
let releases: FakeReleaseServer;
let store: ReturnType<typeof Bun.serve>;
const KEYS: Record<string, string> = { alpha: "NRV-TEST-ALPHA", beta: "NRV-TEST-BETA" };
const requests: Array<{ license_key: string; pack: string }> = [];

const provenance = (pack: string, version: string) => JSON.stringify({
  product: "nirvana-os", edition: pack, version, license_key: KEYS[pack], watermark_id: `wm-${pack}`,
  buyer_email: "buyer@example.com", buyer_name: "Test Buyer", issued_at: "2026-10-11T00:00:00.000Z", signature: null,
}, null, 2) + "\n";

// A stored (uncompressed) zip, enough for unzip, bsdtar and Expand-Archive.
function zip(files: Record<string, string>): Uint8Array {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text, "utf8");
    const nameBuf = Buffer.from(name, "utf8");
    const crc = Bun.hash.crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6); local.writeUInt16LE(0, 8);
    local.writeUInt32LE(0, 10); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, data);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0, 8); cen.writeUInt16LE(0, 10);
    cen.writeUInt32LE(0, 12); cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(data.length, 20); cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28); cen.writeUInt16LE(0, 30); cen.writeUInt16LE(0, 32); cen.writeUInt16LE(0, 34); cen.writeUInt16LE(0, 36);
    cen.writeUInt32LE(0, 38); cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const cenBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cenBuf.length, 12); end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...chunks, cenBuf, end]));
}

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nrv-packs-")));
  releases = startFakeReleases(root);
  // squads.sh: a key updates its own pack only (pack-update/route.ts), and the
  // zip it hands back carries that pack's newer PROVENANCE.
  store = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/pack-update") {
        const body = await req.json() as { license_key: string; pack: string };
        requests.push(body);
        if (KEYS[body.pack] !== body.license_key) return Response.json({ error: "pack_mismatch" }, { status: 403 });
        return Response.json({ url: `http://127.0.0.1:${store.port}/zip/${body.pack}`, version: "1.0.1" });
      }
      const m = /^\/zip\/(\w+)$/.exec(url.pathname);
      if (m) {
        return new Response(zip({
          [`starter-pack/squads/${m[1]}-squad/squad.yaml`]: `name: ${m[1]}-squad\n`,
          "PROVENANCE.json": provenance(m[1], "1.0.1"),
          "LICENSE.txt": `notice ${m[1]}\n`,
        }));
      }
      return new Response("not found", { status: 404 });
    },
  });
});

afterAll(() => {
  releases.stop();
  store.stop(true);
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
});

/** A HOME with a stub engine at `version`: the scripts setup.ts and update-pack
 *  call, each recording how it was called. */
function machine(name: string, version = "0.15.0-beta.5"): string {
  const home = path.join(root, name);
  const skills = path.join(home, ".nirvana", "skills");
  const w = (rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(skills, rel)), { recursive: true }); fs.writeFileSync(path.join(skills, rel), text); };
  const record = (tag: string) => [
    'import * as fs from "node:fs";', 'import * as path from "node:path";', 'import { homedir } from "node:os";',
    `fs.appendFileSync(path.join(homedir(), "calls.log"), ${JSON.stringify(tag)} + " " + process.argv.slice(2).join(" ") + "\\n");`,
  ].join("\n");
  w("VERSION", `${version}\n`);
  w(path.join("harness", "scripts", "index.ts"), record("index"));
  w(path.join("_shared", "scripts", "install-content.ts"), record("install-content"));
  w(path.join("_shared", "scripts", "license.ts"), record("license"));
  return home;
}

/** A pack as the buyer downloads it: the base plus their two files. */
function pack(slug: string, version = "1.0.0"): string {
  const dir = path.join(root, `pack-${slug}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(path.join(dir, "starter-pack", "squads"), { recursive: true });
  for (const f of ["setup.ts", "setup.sh", "setup.ps1"]) fs.copyFileSync(path.join(SETUP_DIR, f), path.join(dir, f));
  fs.writeFileSync(path.join(dir, "pack.yaml"), `slug: ${slug}\nrequires_engine: ">=0.1.9"\n`);
  fs.writeFileSync(path.join(dir, "PROVENANCE.json"), provenance(slug, version));
  fs.writeFileSync(path.join(dir, "LICENSE.txt"), `notice ${slug}\n`);
  return dir;
}

function env(home: string, extra: Record<string, string> = {}): Record<string, string | undefined> {
  const e = fakeHomeEnv(home, {
    ...releases.env,
    NIRVANA_VALIDATE_URL: "http://127.0.0.1:9/validate",
    NIRVANA_PACK_UPDATE_URL: `http://127.0.0.1:${store.port}/pack-update`,
    NIRVANA_SCOPE: "global",
  });
  for (const k of ["NIRVANA_ENGINE_URL", "NIRVANA_ENGINE_TARBALL", "NIRVANA_CLI_LOCAL", "NIRVANA_PROVENANCE", "NIRVANA_SKILLS_DIR", "NIRVANA_SKIP_ENGINE_UPDATE"]) delete e[k];
  return Object.assign(e, extra);
}

const setup = (home: string, packDir: string, extra: Record<string, string> = {}) =>
  runAsync([process.execPath, path.join(packDir, "setup.ts")], { cwd: packDir, env: env(home, extra), timeoutMs: spawnBudgetMs(4) });

const updatePack = (home: string, slug: string) =>
  runAsync([process.execPath, UPDATE_PACK, slug], {
    cwd: home, env: env(home, { NIRVANA_SKILLS_DIR: path.join(home, ".nirvana", "skills") }), timeoutMs: spawnBudgetMs(3),
  });

const lic = (home: string, ...rel: string[]) => path.join(home, ".nirvana-license", ...rel);
const readJson = (p: string) => JSON.parse(fs.readFileSync(p, "utf8"));
const installs = (home: string) => {
  const log = path.join(home, "installs.log");
  return fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : [];
};

describe("one license per pack", () => {
  const SKIP = { NIRVANA_SKIP_ENGINE_UPDATE: "1" };

  test("two packs installed one after the other can both be updated", async () => {
    const home = machine("two-packs");
    for (const slug of ["alpha", "beta"]) {
      const r = await setup(home, pack(slug), SKIP);
      expect(r.code, r.out).toBe(0);
    }
    // Each pack's own file, and the legacy file exactly as before: the last pack's.
    expect(readJson(lic(home, "packs", "alpha", "PROVENANCE.json")).license_key).toBe(KEYS.alpha);
    expect(readJson(lic(home, "packs", "beta", "PROVENANCE.json")).license_key).toBe(KEYS.beta);
    expect(fs.readFileSync(lic(home, "packs", "alpha", "LICENSE.txt"), "utf8")).toBe("notice alpha\n");
    expect(readJson(lic(home, "PROVENANCE.json")).license_key).toBe(KEYS.beta);

    requests.length = 0;
    for (const slug of ["alpha", "beta"]) {
      const r = await updatePack(home, slug);
      expect(r.code, r.out).toBe(0);
      expect(r.out).toContain(`Pack '${slug}' updated to 1.0.1`);
    }
    expect(requests.map((q) => [q.pack, q.license_key])).toEqual([["alpha", KEYS.alpha], ["beta", KEYS.beta]]);
    // Each update refreshed its own pack's license; the legacy file followed only its own edition.
    expect(readJson(lic(home, "packs", "alpha", "PROVENANCE.json")).version).toBe("1.0.1");
    expect(readJson(lic(home, "packs", "beta", "PROVENANCE.json")).version).toBe("1.0.1");
    expect(readJson(lic(home, "PROVENANCE.json")).edition).toBe("beta");
  }, spawnBudgetMs(8));

  test("an install with only the legacy single file still updates", async () => {
    const home = machine("legacy-only");
    fs.mkdirSync(lic(home), { recursive: true });
    fs.writeFileSync(lic(home, "PROVENANCE.json"), provenance("alpha", "1.0.0"));
    requests.length = 0;
    const r = await updatePack(home, "alpha");
    expect(r.code, r.out).toBe(0);
    expect(requests.map((q) => q.license_key)).toEqual([KEYS.alpha]);
    expect(readJson(lic(home, "PROVENANCE.json")).version).toBe("1.0.1");
  }, spawnBudgetMs(3));

  test("the license check after setup names the pack (an older engine ignores it)", async () => {
    const home = machine("check-pack");
    expect((await setup(home, pack("alpha"), SKIP)).code).toBe(0);
    expect(fs.readFileSync(path.join(home, "calls.log"), "utf8")).toContain("license check --pack alpha");
  }, spawnBudgetMs(4));
});

describe("pack setup keeps the engine's release channel", () => {
  test("a beta engine moves to the newest greater beta", async () => {
    releases.setRateLimited(false);
    releases.setReleases([{ version: "0.14.10" }, { version: "0.15.0-beta.5", prerelease: true }, { version: "0.15.0-beta.6", prerelease: true }]);
    const home = machine("setup-up");
    const r = await setup(home, pack("alpha"));
    expect(r.code, r.out).toBe(0);
    expect(installs(home)).toEqual(["0.15.0-beta.6"]);
  }, spawnBudgetMs(5));

  test("a beta engine with nothing newer is left alone, never put on the older stable", async () => {
    releases.setReleases([{ version: "0.14.10" }, { version: "0.15.0-beta.5", prerelease: true }]);
    const home = machine("setup-current");
    const r = await setup(home, pack("alpha"));
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("0.15.0-beta.5 is current");
    expect(installs(home)).toEqual([]);
  }, spawnBudgetMs(5));

  test("a stable engine takes the newer stable and ignores prereleases", async () => {
    releases.setReleases([{ version: "0.14.10" }, { version: "0.15.0-beta.6", prerelease: true }]);
    const home = machine("setup-stable", "0.14.9");
    const r = await setup(home, pack("alpha"));
    expect(r.code, r.out).toBe(0);
    expect(installs(home)).toEqual(["0.14.10"]);
  }, spawnBudgetMs(5));

  test("rate limited: latest is fetched, and kept out when it is older", async () => {
    releases.setRateLimited(true);
    releases.setLatest("0.14.10");
    const home = machine("setup-limited");
    const r = await setup(home, pack("alpha"));
    releases.setRateLimited(false);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("rate limit");
    expect(r.out).toContain("kept");
    expect(installs(home)).toEqual([]);
    expect(fs.readFileSync(path.join(home, ".nirvana", "skills", "VERSION"), "utf8").trim()).toBe("0.15.0-beta.5");
  }, spawnBudgetMs(5));
});

describe("setup.sh / setup.ps1 hand their arguments to setup.ts", () => {
  test("every argument arrives, spaces included", () => {
    const dir = path.join(root, "args");
    fs.mkdirSync(dir, { recursive: true });
    for (const f of ["setup.sh", "setup.ps1"]) fs.copyFileSync(path.join(SETUP_DIR, f), path.join(dir, f));
    fs.writeFileSync(path.join(dir, "setup.ts"), 'console.log(JSON.stringify(process.argv.slice(2)));\n');
    const e = { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ""}` };
    const r = IS_WINDOWS
      ? spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(dir, "setup.ps1"), "--profile=economy", "two words"], { cwd: dir, env: e, encoding: "utf8" })
      : spawnSync("bash", [path.join(dir, "setup.sh"), "--profile=economy", "two words"], { cwd: dir, env: e, encoding: "utf8" });
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    expect(JSON.parse(r.stdout.trim().split("\n").pop()!)).toEqual(["--profile=economy", "two words"]);
  }, spawnBudgetMs(2));
});
