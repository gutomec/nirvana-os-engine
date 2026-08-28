/**
 * The buyer's path, end to end, in a temporary HOME.
 *
 * This is the test whose absence cost months. The installer that ships inside
 * every content pack read PROVENANCE.json for the pack version and never copied
 * it to ~/.nirvana-license/, so buyers finished with "✓ Pack installed" and no
 * license on disk; the failure surfaced days later, from another directory, as
 * `nrv update` claiming there was no license at all. Nothing caught it because
 * nothing had ever run setup.ts — the only assertions were greps over its source.
 *
 * So this one executes it. Real engine install, real pack build, real overlay,
 * real license copy, and then it looks at the disk. Everything it asserts is
 * something a buyer would notice was missing.
 *
 * Hermetic: no network. The engine is installed from this checkout and
 * NIRVANA_SKIP_ENGINE_UPDATE=1 keeps setup.ts from reaching for GitHub. The one
 * step that does try the network (`nrv update --check`, which asks the server
 * for the current version) degrades to an offline message by design — what is
 * asserted there is that it finds the license, not that it reaches the server.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { fakeHomeEnv } from "./helpers/fake-home.ts";
import { spawnBudgetMs } from "./helpers/test-budgets.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SLUG = "buyer-path-fixture";
const LICENSE_KEY = "NRV-TEST-0000-1111-2222";

let root: string;
let home: string;
let packDir: string;
let env: NodeJS.ProcessEnv;

/** The smallest thing that is still a pack: one of each kind. */
function buildFixtureContent(dir: string): void {
  const w = (p: string, s: string) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
  w(path.join(dir, "squads", "fixture-squad", "squad.yaml"),
    "name: fixture-squad\ndescription: A fixture squad for the buyer-path test\ncapabilities: []\n");
  w(path.join(dir, "businesses", "fixture-biz", "business.yaml"),
    "name: fixture-biz\ndescription: A fixture business for the buyer-path test\n");
  w(path.join(dir, "mind-clones", "fixture-clone", "MANIFEST.yaml"), "name: fixture-clone\n");
  w(path.join(dir, "README.md"), "# Fixture pack\n");
}

/**
 * Place PROVENANCE.json and LICENSE.txt the way squads.sh does at download time
 * (apps/web/lib/nirvana/build.ts): at the single top-level directory if the zip
 * has exactly one, at the root otherwise. A content pack has many root entries,
 * so `rootDir` is null and both files land beside setup.ts — which is where
 * setup.ts looks (`join(HERE, "PROVENANCE.json")`). If that ever stops being
 * true, the license silently stops installing again, so the shape is asserted
 * below rather than assumed.
 */
function injectPerBuyerFiles(dir: string): void {
  fs.writeFileSync(path.join(dir, "PROVENANCE.json"), JSON.stringify({
    product: "nirvana-os", edition: SLUG, version: "9.9.9",
    license_key: LICENSE_KEY, watermark_id: "wm-test",
    buyer_email: "buyer@example.com", buyer_name: "Test Buyer",
    issued_at: new Date().toISOString(), signature: null,
  }, null, 2) + "\n");
  fs.writeFileSync(path.join(dir, "LICENSE.txt"), "Fixture license notice\n");
}

function run(cmd: string, args: string[], cwd: string): { code: number; out: string } {
  const r = spawnSync(cmd, args, { cwd, env, encoding: "utf8" });
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

const bun = (args: string[], cwd: string) => run(process.execPath, args, cwd);

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-buyer-"));
  home = path.join(root, "home");
  fs.mkdirSync(home, { recursive: true });
  // fakeHomeEnv carries NIRVANA_SKIP_PATH_PERSIST=1: on Windows the installer
  // would otherwise persist this HOME's .local\bin to the real user PATH (#87).
  env = fakeHomeEnv(home, {
    NIRVANA_SKIP_ENGINE_UPDATE: "1",
    // Registries must resolve to the fake HOME, not to whatever project the
    // test runner happens to sit in. Without this the overlay indexes into the
    // repo's own .nirvana/ and the assertions read the developer's library.
    NIRVANA_SCOPE: "global",
  });
  delete env.NIRVANA_PROVENANCE;

  // 1. The engine, installed the way the buyer's `npx @nirvana-os/cli` does.
  const eng = bun([path.join(REPO, "scripts", "install.ts"), "--no-starter", "--no-hermes"], root);
  if (eng.code !== 0) throw new Error(`engine install failed (${eng.code}):\n${eng.out}`);

  // 2. The pack, built by the real builder from a fixture content tree.
  const content = path.join(root, "content");
  buildFixtureContent(content);
  packDir = path.join(root, "pack");
  const builder = path.join(os.homedir(), "nirvana-packs", "scripts", "build-content-pack.ts");
  if (fs.existsSync(builder)) {
    // The builder resolves the engine from homedir() by default, and here HOME
    // is the fake one. Point it at this checkout — the setup.* it copies into
    // the pack must be the ones being tested.
    const r = spawnSync(process.execPath, [builder, SLUG, content, packDir], {
      cwd: path.join(os.homedir(), "nirvana-packs"),
      env: { ...env, NIRVANA_ENGINE_DIR: REPO },
      encoding: "utf8",
    });
    const b = { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
    if (b.code !== 0) throw new Error(`pack build failed (${b.code}):\n${b.out}`);
  } else {
    // nirvana-packs is a separate private repo and is absent in CI. Assemble the
    // same shape by hand — the pack format is what matters here, not the builder.
    fs.mkdirSync(path.join(packDir, "starter-pack"), { recursive: true });
    for (const k of ["squads", "businesses", "mind-clones"]) {
      fs.cpSync(path.join(content, k), path.join(packDir, "starter-pack", k), { recursive: true });
    }
    fs.writeFileSync(path.join(packDir, "pack.yaml"), `slug: ${SLUG}\nrequires_engine: ">=0.1.9"\n`);
    fs.writeFileSync(path.join(packDir, "README.md"), "# Fixture pack\n");
    for (const f of ["setup.ts", "setup.sh", "setup.ps1"]) {
      fs.copyFileSync(path.join(REPO, "packaging", "pack", f), path.join(packDir, f));
    }
  }

  // 3. What the buyer downloads: the base plus their two files.
  injectPerBuyerFiles(packDir);

  // 4. What the buyer runs.
  const s = bun([path.join(packDir, "setup.ts")], packDir);
  if (s.code !== 0) throw new Error(`setup.ts failed (${s.code}):\n${s.out}`);
}, 600_000);

afterAll(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } });

describe("what the buyer has after running setup.ts", () => {
  test("the license is on disk, where nrv update looks for it", () => {
    const p = path.join(home, ".nirvana-license", "PROVENANCE.json");
    expect(fs.existsSync(p)).toBe(true);
    expect(JSON.parse(fs.readFileSync(p, "utf8")).license_key).toBe(LICENSE_KEY);
  });

  test("the license notice travels with it", () => {
    expect(fs.existsSync(path.join(home, ".nirvana-license", "LICENSE.txt"))).toBe(true);
  });

  test("the content landed in the library", () => {
    expect(fs.existsSync(path.join(home, "squads", "fixture-squad", "squad.yaml"))).toBe(true);
    expect(fs.existsSync(path.join(home, "businesses", "fixture-biz", "business.yaml"))).toBe(true);
    expect(fs.existsSync(path.join(home, "businesses", "_library", "dna", "fixture-clone", "MANIFEST.yaml"))).toBe(true);
  });

  test("the registries can actually see it", () => {
    // Content on disk that the router cannot find is the most expensive failure
    // mode there is, because everything LOOKS installed.
    //
    // The path is asked of the engine's own resolver rather than guessed. The
    // guess was `$HOME/.squads-registry.json`, which is right on POSIX and wrong
    // on Windows — and a test that hardcodes where a file should be cannot catch
    // the day it moves.
    const r = spawnSync(process.execPath, ["-e",
      'const p = await import(process.argv[1]); console.log(p.SQUADS_REGISTRY_PATH);',
      path.join(home, ".nirvana", "skills", "_shared", "lib", "paths.js"),
    ], { cwd: root, env, encoding: "utf8" });
    const reg = (r.stdout || "").trim();
    expect(reg.length).toBeGreaterThan(0);
    expect(fs.existsSync(reg)).toBe(true);
    expect(fs.readFileSync(reg, "utf8")).toContain("fixture-squad");
  }, spawnBudgetMs(2));

  test("the pack manifest records the version", () => {
    const p = path.join(home, ".nirvana", "packs", `${SLUG}.json`);
    expect(fs.existsSync(p)).toBe(true);
    expect(JSON.parse(fs.readFileSync(p, "utf8")).version).toBe("9.9.9");
  });

  test("`nrv installed` lists the pack", () => {
    const r = bun([path.join(home, ".nirvana", "skills", "_shared", "scripts", "list-installed.ts")], root);
    expect(r.code).toBe(0);
    expect(r.out).toContain(SLUG);
    expect(r.out).not.toContain("No installations recorded");
  });

  test("`nrv license status` shows the key", () => {
    const r = bun([path.join(home, ".nirvana", "skills", "_shared", "scripts", "license.ts"), "status"], root);
    expect(r.out).toContain(LICENSE_KEY);
  });

  test("`nrv update --check` finds the license", () => {
    // Offline by construction: the validate URL points at a closed port so the
    // fetch fails immediately instead of hanging on a CI runner that cannot
    // reach squads.sh. What this proves is that the command got PAST the license
    // lookup — reaching the server is not the point, and never was.
    const r = spawnSync(process.execPath, [
      path.join(home, ".nirvana", "skills", "_shared", "scripts", "update-pack.ts"), SLUG, "--check",
    ], { cwd: root, env: { ...env, NIRVANA_VALIDATE_URL: "http://127.0.0.1:9/validate" }, encoding: "utf8" });
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    expect(out).not.toContain("No PROVENANCE");
    expect(out).not.toContain("nothing to update");
    // Reaching the network step at all means it got past the license lookup —
    // without a license it exits before ever trying to connect.
    expect(out).toContain("Offline use stays available");
  }, 30_000);
});

describe("the pack shape the per-buyer injection depends on", () => {
  test("setup.ts sits at the pack root", () => {
    expect(fs.existsSync(path.join(packDir, "setup.ts"))).toBe(true);
  });

  test("more than one root entry, so the injection lands beside it", () => {
    // build.ts places the two files inside the single top-level directory when
    // there is exactly one, and at the root otherwise. Wrapping a pack in a
    // folder would move PROVENANCE.json away from setup.ts without any error.
    const tops = new Set(fs.readdirSync(packDir).filter((e) => !e.startsWith("__MACOSX")));
    expect(tops.size).toBeGreaterThan(1);
  });
});
