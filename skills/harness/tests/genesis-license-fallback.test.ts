// genesis-license-fallback.test.ts — a Genesis Circle key covers every pack,
// wherever it sits in the license store.
//
// A buyer installed Genesis Circle before the per-pack copies existed (so the
// key lived only in ~/.nirvana-license/PROVENANCE.json), then the web-design
// pack. web-design's setup overwrote the single file, Genesis had no copy of
// its own, and `nrv doctor` and `nrv update <other pack>` refused 17 packs.
//
// Now: setup.ts never replaces a Genesis license in the single file with
// another pack's (and gives it its own copy), and every reader consults
// packs/genesis-circle/ after the pack's own file and before the single file.
//
// Hermetic: a temporary HOME, the real setup.ts, update-pack.ts and
// doctor-system.ts, and a fake squads.sh served on 127.0.0.1. Keys are fake.
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
const DOCTOR = path.join(REPO, "skills", "harness", "scripts", "doctor-system.ts");
const GENESIS = "genesis-circle";
const KEYS: Record<string, string> = { [GENESIS]: "NRV-TEST-GENESIS", "web-design": "NRV-TEST-WEB", alpha: "NRV-TEST-ALPHA" };
const OTHER_PACKS = ["marketing", "copywriting", "alpha"];

let root: string;
let releases: FakeReleaseServer;
let store: ReturnType<typeof Bun.serve>;
const requests: Array<{ license_key: string; pack: string }> = [];

const provenance = (edition: string, version = "1.0.0") => JSON.stringify({
  product: "nirvana-os", edition, version, license_key: KEYS[edition], watermark_id: `wm-${edition}`,
  buyer_email: "buyer@example.com", buyer_name: "Test Buyer", issued_at: "2026-10-14T00:00:00.000Z",
  // The doctor only checks that a signature is present; nothing here verifies it.
  signature: "test.not-a-real-signature",
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
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    chunks.push(local, nameBuf, data);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6);
    cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(data.length, 20); cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28); cen.writeUInt32LE(offset, 42);
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
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nrv-genesis-")));
  releases = startFakeReleases(root);
  // squads.sh: a Genesis key updates any pack, any other key only its own; the
  // zip carries the PROVENANCE of the key that asked.
  store = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/pack-update") {
        const body = await req.json() as { license_key: string; pack: string };
        requests.push(body);
        const edition = Object.keys(KEYS).find((k) => KEYS[k] === body.license_key);
        if (!edition || (edition !== GENESIS && edition !== body.pack)) return Response.json({ error: "pack_mismatch" }, { status: 403 });
        return Response.json({ url: `http://127.0.0.1:${store.port}/zip/${body.pack}/${edition}`, version: "1.0.1" });
      }
      const m = /^\/zip\/([\w-]+)\/([\w-]+)$/.exec(url.pathname);
      if (m) {
        return new Response(zip({
          [`starter-pack/squads/${m[1]}-squad/squad.yaml`]: `name: ${m[1]}-squad\n`,
          "PROVENANCE.json": provenance(m[2], "1.0.1"),
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

/** A HOME with a stub engine (the scripts setup.ts and update-pack call) and
 *  the manifests of the packs installed on it. */
function machine(name: string, packs: string[]): string {
  const home = path.join(root, name);
  const skills = path.join(home, ".nirvana", "skills");
  const w = (rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(skills, rel)), { recursive: true }); fs.writeFileSync(path.join(skills, rel), text); };
  w("VERSION", "0.15.0-beta.7\n");
  for (const rel of [["harness", "scripts", "index.ts"], ["_shared", "scripts", "install-content.ts"], ["_shared", "scripts", "license.ts"]]) w(path.join(...rel), "");
  const manifests = path.join(home, ".nirvana", "packs");
  fs.mkdirSync(manifests, { recursive: true });
  for (const slug of packs) fs.writeFileSync(path.join(manifests, `${slug}.json`), JSON.stringify({ slug, version: "1.0.0" }));
  return home;
}

/** A pack as the buyer downloads it. */
function pack(slug: string): string {
  const dir = path.join(root, `pack-${slug}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(path.join(dir, "starter-pack", "squads"), { recursive: true });
  for (const f of ["setup.ts", "setup.sh", "setup.ps1"]) fs.copyFileSync(path.join(SETUP_DIR, f), path.join(dir, f));
  fs.writeFileSync(path.join(dir, "pack.yaml"), `slug: ${slug}\nrequires_engine: ">=0.1.9"\n`);
  fs.writeFileSync(path.join(dir, "PROVENANCE.json"), provenance(slug));
  fs.writeFileSync(path.join(dir, "LICENSE.txt"), `notice ${slug}\n`);
  return dir;
}

function env(home: string, extra: Record<string, string> = {}): Record<string, string | undefined> {
  const e = fakeHomeEnv(home, {
    ...releases.env,
    NIRVANA_VALIDATE_URL: "http://127.0.0.1:9/validate",
    NIRVANA_PACK_UPDATE_URL: `http://127.0.0.1:${store.port}/pack-update`,
    NIRVANA_SCOPE: "global",
    NIRVANA_SKIP_ENGINE_UPDATE: "1",
  });
  for (const k of ["NIRVANA_ENGINE_URL", "NIRVANA_ENGINE_TARBALL", "NIRVANA_CLI_LOCAL", "NIRVANA_PROVENANCE", "NIRVANA_SKILLS_DIR"]) delete e[k];
  return Object.assign(e, extra);
}

const setup = (home: string, slug: string) =>
  runAsync([process.execPath, path.join(pack(slug), "setup.ts")], { cwd: root, env: env(home), timeoutMs: spawnBudgetMs(4) });

const updatePack = (home: string, slug: string) =>
  runAsync([process.execPath, UPDATE_PACK, slug], {
    cwd: home, env: env(home, { NIRVANA_SKILLS_DIR: path.join(home, ".nirvana", "skills") }), timeoutMs: spawnBudgetMs(3),
  });

/** The doctor's license checks, by pack. */
function doctorLicenses(home: string): Record<string, { status: string; note: string }> {
  const r = spawnSync(process.execPath, [DOCTOR, "--json"], {
    cwd: home, encoding: "utf8",
    env: env(home, {
      NIRVANA_HOME: home, NIRVANA_SKILLS_DIR: path.join(REPO, "skills"), CLAUDE_SKILLS_DIR: path.join(REPO, "skills"),
      NIRVANA_SCOPE_QUIET: "1", NIRVANA_NO_UPDATE_CHECK: "1",
    }) as Record<string, string>,
  });
  const checks: Array<{ name: string; status: string; note: string }> = JSON.parse(r.stdout).checks;
  return Object.fromEntries(checks.filter((c) => c.name.startsWith("paid: license"))
    .map((c) => [c.name.replace(/^paid: license ?/, ""), { status: c.status, note: c.note }]));
}

const lic = (home: string, ...rel: string[]) => path.join(home, ".nirvana-license", ...rel);
const readJson = (p: string) => JSON.parse(fs.readFileSync(p, "utf8"));
const write = (p: string, text: string) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };
const ALL = [GENESIS, "web-design", ...OTHER_PACKS];

describe("Genesis Circle, then another pack", () => {
  test("a Genesis install from before the per-pack copies survives web-design's setup", async () => {
    const home = machine("old-genesis-then-web", ALL);
    write(lic(home, "PROVENANCE.json"), provenance(GENESIS));
    write(lic(home, "LICENSE.txt"), "notice genesis-circle\n");

    const r = await setup(home, "web-design");
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("Genesis Circle license");
    expect(readJson(lic(home, "PROVENANCE.json")).edition).toBe(GENESIS);
    expect(readJson(lic(home, "packs", GENESIS, "PROVENANCE.json")).edition).toBe(GENESIS);
    expect(fs.readFileSync(lic(home, "packs", GENESIS, "LICENSE.txt"), "utf8")).toBe("notice genesis-circle\n");
    expect(readJson(lic(home, "packs", "web-design", "PROVENANCE.json")).edition).toBe("web-design");

    const doctor = doctorLicenses(home);
    for (const slug of ALL) expect(doctor[slug]?.status, `${slug}: ${doctor[slug]?.note}`).toBe("PASS");

    requests.length = 0;
    for (const slug of ["web-design", ...OTHER_PACKS]) {
      const u = await updatePack(home, slug);
      expect(u.code, u.out).toBe(0);
      expect(u.out).toContain(`Pack '${slug}' updated to 1.0.1`);
    }
    expect(requests.map((q) => [q.pack, q.license_key])).toEqual([
      ["web-design", KEYS["web-design"]],
      ...OTHER_PACKS.map((slug) => [slug, KEYS[GENESIS]]),
    ]);
    expect(readJson(lic(home, "PROVENANCE.json")).edition).toBe(GENESIS);
  }, spawnBudgetMs(12));

  test("Genesis installed by today's setup, then web-design: every pack updates and the doctor passes", async () => {
    const home = machine("genesis-then-web", ALL);
    for (const slug of [GENESIS, "web-design"]) {
      const r = await setup(home, slug);
      expect(r.code, r.out).toBe(0);
    }
    expect(readJson(lic(home, "PROVENANCE.json")).edition).toBe(GENESIS);
    expect(readJson(lic(home, "packs", GENESIS, "PROVENANCE.json")).edition).toBe(GENESIS);

    const doctor = doctorLicenses(home);
    for (const slug of ALL) expect(doctor[slug]?.status, `${slug}: ${doctor[slug]?.note}`).toBe("PASS");

    requests.length = 0;
    for (const slug of OTHER_PACKS) {
      const u = await updatePack(home, slug);
      expect(u.code, u.out).toBe(0);
    }
    expect(requests.every((q) => q.license_key === KEYS[GENESIS])).toBe(true);
  }, spawnBudgetMs(12));

  test("Genesis installed after another pack takes the single file back", async () => {
    const home = machine("web-then-genesis", ["web-design", GENESIS]);
    for (const slug of ["web-design", GENESIS]) expect((await setup(home, slug)).code).toBe(0);
    expect(readJson(lic(home, "PROVENANCE.json")).edition).toBe(GENESIS);
    expect(readJson(lic(home, "packs", "web-design", "PROVENANCE.json")).edition).toBe("web-design");
  }, spawnBudgetMs(10));
});

describe("the doctor on a store already damaged", () => {
  test("legacy file overwritten by web-design, Genesis only in packs/genesis-circle: PASS", () => {
    const home = machine("damaged-with-copy", ALL);
    write(lic(home, "PROVENANCE.json"), provenance("web-design"));
    write(lic(home, "packs", GENESIS, "PROVENANCE.json"), provenance(GENESIS));
    const doctor = doctorLicenses(home);
    for (const slug of ALL) expect(doctor[slug]?.status, `${slug}: ${doctor[slug]?.note}`).toBe("PASS");
  }, spawnBudgetMs(1));

  test("legacy file overwritten and no Genesis copy anywhere: the warning names the Genesis remedy", () => {
    const home = machine("damaged-no-copy", ALL);
    write(lic(home, "PROVENANCE.json"), provenance("web-design"));
    const doctor = doctorLicenses(home);
    expect(doctor["web-design"].status).toBe("PASS");
    for (const slug of [GENESIS, ...OTHER_PACKS]) {
      expect(doctor[slug].status).toBe("WARN");
      expect(doctor[slug].note).toContain("the only license here is for 'web-design'");
      expect(doctor[slug].note).toContain("If you own Genesis Circle, run its setup again");
    }
  }, spawnBudgetMs(1));

  test("no license at all: the failure keeps its message and adds the hint", () => {
    const home = machine("no-license", ["alpha"]);
    const doctor = doctorLicenses(home);
    expect(doctor[""].status).toBe("FAIL");
    expect(doctor[""].note).toContain("pack installed but no license");
    expect(doctor[""].note).toContain("If you own Genesis Circle, run its setup again");
  }, spawnBudgetMs(1));
});

describe("old single-file installs", () => {
  test("a pack whose license is only the legacy file passes the doctor and updates", async () => {
    const home = machine("legacy-alpha", ["alpha"]);
    write(lic(home, "PROVENANCE.json"), provenance("alpha"));
    expect(doctorLicenses(home)[""].status).toBe("PASS");
    requests.length = 0;
    const u = await updatePack(home, "alpha");
    expect(u.code, u.out).toBe(0);
    expect(requests.map((q) => q.license_key)).toEqual([KEYS.alpha]);
  }, spawnBudgetMs(4));

  test("a Genesis key only in the legacy file covers every pack", () => {
    const home = machine("legacy-genesis", ALL);
    write(lic(home, "PROVENANCE.json"), provenance(GENESIS));
    const doctor = doctorLicenses(home);
    for (const slug of ALL) expect(doctor[slug]?.status, `${slug}: ${doctor[slug]?.note}`).toBe("PASS");
  }, spawnBudgetMs(1));
});
