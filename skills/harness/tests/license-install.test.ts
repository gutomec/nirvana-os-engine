// license-install.test.ts — installing a license must not require reinstalling
// the pack.
//
// A Windows buyer ran `nrv update genesis-circle` and got "Sem PROVENANCE com
// license_key". The message named the two paths searched (good) and then told
// them to re-run `bun setup.ts` — the whole pack installer — to copy one small
// file. That is the only route that existed: the copy lives inside setup.ts.
import { describe, expect, test, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fakeHomeEnv } from "./helpers/fake-home.ts";

const SCRIPT = path.resolve(import.meta.dir, "..", "..", "_shared", "scripts", "license.ts");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-lic-"));

const PROVENANCE = JSON.stringify({
  license_key: "TEST-KEY-1234", edition: "genesis-circle",
  buyer_email: "buyer@example.com", watermark_id: "wm-test",
});

function home(name: string): string {
  const h = path.join(TMP, name);
  fs.mkdirSync(h, { recursive: true });
  return h;
}

function pack(h: string, dir = "Downloads/nirvana-os-genesis-circle-pack"): string {
  const p = path.join(h, dir);
  fs.mkdirSync(p, { recursive: true });
  fs.writeFileSync(path.join(p, "PROVENANCE.json"), PROVENANCE);
  fs.writeFileSync(path.join(p, "LICENSE.txt"), "licence notice\n");
  return p;
}

const run = (h: string, args: string[], cwd = h) =>
  spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", cwd, env: fakeHomeEnv(h) });

const store = (h: string) => path.join(h, ".nirvana-license", "PROVENANCE.json");

afterAll(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ } });

describe("nrv license install", () => {
  test("finds a downloaded pack without being told where", () => {
    // The buyer's situation: the file is in the folder they unzipped, and they
    // do not know the engine wants it somewhere else.
    const h = home("auto"); pack(h);
    const r = run(h, ["install"]);
    expect(r.status).toBe(0);
    expect(fs.existsSync(store(h))).toBe(true);
    expect(JSON.parse(fs.readFileSync(store(h), "utf8")).license_key).toBe("TEST-KEY-1234");
  }, 30_000);

  test("takes a folder, not only a file — that is what people paste", () => {
    const h = home("folder"); const p = pack(h, "packdir");
    expect(run(h, ["install", p]).status).toBe(0);
    expect(fs.existsSync(store(h))).toBe(true);
  }, 30_000);

  test("brings LICENSE.txt along when it sits next to it", () => {
    const h = home("notice"); pack(h);
    run(h, ["install"]);
    expect(fs.existsSync(path.join(h, ".nirvana-license", "LICENSE.txt"))).toBe(true);
  }, 30_000);

  test("running it twice reports a no-op instead of a phantom install", () => {
    // The pack folder is still on disk after the first run, so the second finds
    // the same original. Re-copying is harmless; saying "installed" when
    // nothing changed is what misleads. Content decides, not the path — an
    // earlier version compared paths with resolve() and this test passed on
    // macOS only by the accident of readdir order.
    const h = home("twice"); pack(h);
    expect(run(h, ["install"]).status).toBe(0);
    const second = run(h, ["install"]);
    expect(second.status).toBe(0);
    expect(second.stdout).toMatch(/Already installed/);
    expect(JSON.parse(fs.readFileSync(store(h), "utf8")).license_key).toBe("TEST-KEY-1234");
  }, 30_000);

  test("pointing it at the store itself never self-copies", () => {
    const h = home("selfcopy"); pack(h);
    run(h, ["install"]);
    const r = run(h, ["install", store(h)]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Already installed/);
    expect(fs.readFileSync(store(h), "utf8")).toBe(PROVENANCE);
  }, 30_000);

  test("with nothing to find, it says where it looked", () => {
    // Never a bare failure: the buyer must be able to check the paths itself.
    const h = home("empty");
    const r = run(h, ["install"]);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/Searched in/);
    expect(r.stdout).toMatch(/nrv license install <path/);
  }, 30_000);

  test("an unsigned provenance is still installed", () => {
    // It is the file the buyer paid for. Telling them it is unsigned is more
    // useful than refusing to move it.
    const h = home("unsigned"); pack(h);
    const r = run(h, ["install"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/não assinada|unsigned/i);
  }, 30_000);
});

describe("one license per pack", () => {
  test("install also keeps the file as the pack's own license, under its edition", () => {
    const h = home("per-pack"); pack(h);
    expect(run(h, ["install"]).status).toBe(0);
    const own = path.join(h, ".nirvana-license", "packs", "genesis-circle");
    expect(fs.readFileSync(path.join(own, "PROVENANCE.json"), "utf8")).toBe(PROVENANCE);
    expect(fs.existsSync(path.join(own, "LICENSE.txt"))).toBe(true);
  }, 30_000);

  test("an install from before the per-pack copies gains one, instead of a no-op", () => {
    const h = home("legacy-upgrade"); pack(h);
    fs.mkdirSync(path.dirname(store(h)), { recursive: true });
    fs.writeFileSync(store(h), PROVENANCE);
    const r = run(h, ["install"]);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toMatch(/Already installed/);
    expect(fs.existsSync(path.join(h, ".nirvana-license", "packs", "genesis-circle", "PROVENANCE.json"))).toBe(true);
  }, 30_000);

  test("--pack reads that pack's own license before the legacy file", () => {
    const h = home("pack-flag");
    const own = path.join(h, ".nirvana-license", "packs", "creators");
    fs.mkdirSync(own, { recursive: true });
    fs.writeFileSync(path.join(own, "PROVENANCE.json"), JSON.stringify({ license_key: "KEY-CREATORS", edition: "creators" }));
    fs.writeFileSync(store(h), PROVENANCE);
    expect(run(h, ["status", "--pack", "creators"]).stdout).toContain("KEY-CREATORS");
    expect(run(h, ["--pack", "creators"]).stdout).toContain("KEY-CREATORS");
    // Without --pack, and for a pack with no file of its own: the legacy file, as before.
    expect(run(h, ["status"]).stdout).toContain("TEST-KEY-1234");
    expect(run(h, ["status", "--pack", "education"]).stdout).toContain("TEST-KEY-1234");
  }, 30_000);
});

describe("the failure message points at the cheap fix", () => {
  test("update-pack offers `nrv license install` before reinstalling the pack", () => {
    const src = fs.readFileSync(path.resolve(import.meta.dir, "..", "..", "_shared", "scripts", "update-pack.ts"), "utf8");
    expect(src).toMatch(/nrv license install/);
    expect(src).toMatch(/costs far more/);
  });
});
