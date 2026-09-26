// install-shared-packs.test.ts — two packs that deliver the same components.
//
// A squad, business or clone that serves a task in one pack ships in the other
// packs that need it too, and every copy lands in the same library directory.
// Two packs can carry different revisions of the same component, and a
// business ships in per-pack variants. Installing, updating or removing one
// pack must not read the other pack's copy as the buyer's work: no "you created" collision,
// no backup of content a pack can reproduce, and no uninstall that takes the
// other pack's component with it. The real scripts, a real temp home.
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnBudgetMs } from "./helpers/test-budgets.ts";

const SCRIPTS = path.join(import.meta.dir, "..", "..", "_shared", "scripts");
const INSTALL = path.join(SCRIPTS, "install-content.ts");
const UNINSTALL = path.join(SCRIPTS, "uninstall-pack.ts");
const roots: string[] = [];
afterEach(() => { while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true }); });

function home(): string {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-shared-packs-")); roots.push(h);
  return h;
}

interface Pack { squads?: Record<string, string>; businesses?: Record<string, string>; clones?: Record<string, string>; }

/** One pack's content dir. The value of each entry is the body of its main file,
 *  which is how two copies of the same component are made to differ. */
function content(h: string, name: string, p: Pack): string {
  const c = path.join(h, "content", name);
  for (const k of ["squads", "businesses", "mind-clones"]) fs.mkdirSync(path.join(c, k), { recursive: true });
  for (const [slug, body] of Object.entries(p.squads ?? {})) {
    fs.mkdirSync(path.join(c, "squads", slug), { recursive: true });
    fs.writeFileSync(path.join(c, "squads", slug, "squad.yaml"), `name: ${slug}\n`);
    fs.writeFileSync(path.join(c, "squads", slug, "README.md"), body);
  }
  for (const [slug, body] of Object.entries(p.businesses ?? {})) {
    fs.mkdirSync(path.join(c, "businesses", slug), { recursive: true });
    fs.writeFileSync(path.join(c, "businesses", slug, "business.yaml"), `name: ${slug}\n`);
    fs.writeFileSync(path.join(c, "businesses", slug, "README.md"), body);
  }
  for (const [slug, body] of Object.entries(p.clones ?? {})) {
    fs.mkdirSync(path.join(c, "mind-clones", slug, "dna"), { recursive: true });
    fs.writeFileSync(path.join(c, "mind-clones", slug, "MANIFEST.yaml"), `name: ${slug}\n`);
    fs.writeFileSync(path.join(c, "mind-clones", slug, "dna", "DNA.md"), body);
  }
  return c;
}

function env(h: string): Record<string, string> {
  const e: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || /^(NIRVANA_HOME|SQUADS_DIR|BUSINESSES_DIR|DNA_LIBRARY)$/.test(k)) continue;
    e[k] = v;
  }
  return Object.assign(e, { HOME: h, USERPROFILE: h, NIRVANA_HOME: h });
}
function install(h: string, c: string, slug: string, version: string) {
  const r = spawnSync(process.execPath, [INSTALL, c, "--slug", slug, "--version", version, "--skip-validate", "--no-index"], { encoding: "utf8", env: env(h), cwd: h });
  return { code: r.status ?? -1, out: `${r.stdout}\n${r.stderr}` };
}
function uninstall(h: string, slug: string) {
  const r = spawnSync(process.execPath, [UNINSTALL, slug], { encoding: "utf8", env: env(h), cwd: h });
  return { code: r.status ?? -1, out: `${r.stdout}\n${r.stderr}` };
}

const squadFile = (h: string, slug: string) => path.join(h, "squads", slug, "README.md");
const bizFile = (h: string, slug: string) => path.join(h, "businesses", slug, "README.md");
const cloneDir = (h: string, slug: string) => path.join(h, "businesses", "_library", "dna", slug);
const backups = (h: string, pack: string) => path.join(h, ".nirvana", "backups", "packs", pack);

// The same components, each pack with its own copy of them.
const A1: Pack = { squads: { "shared-sq": "sq (copy a)\n", "only-a": "a\n" }, businesses: { "shared-biz": "biz variant a\n" }, clones: { "shared-cl": "cl (copy a)\n" } };
const B1: Pack = { squads: { "shared-sq": "sq (copy b)\n" }, businesses: { "shared-biz": "biz variant b\n" }, clones: { "shared-cl": "cl (copy b)\n", "only-b": "b\n" } };

describe("packs that share components", () => {
  test("installing a second pack over the first: no collision, no backup, the shared components are named", () => {
    const h = home();
    expect(install(h, content(h, "a1", A1), "pack-a", "1").code).toBe(0);
    const r = install(h, content(h, "b1", B1), "pack-b", "1");
    expect(r.code, r.out).toBe(0);
    expect(r.out).not.toContain("OVERWRITTEN");
    expect(r.out).not.toContain("BACKED UP");
    expect(r.out).toContain("1 shared with other packs");
    expect(fs.existsSync(backups(h, "pack-b"))).toBe(false);
    expect(fs.readFileSync(squadFile(h, "shared-sq"), "utf8")).toBe("sq (copy b)\n");   // the pack being installed delivers its copy
    expect(fs.existsSync(cloneDir(h, "only-b"))).toBe(true);
  }, spawnBudgetMs(2));

  test("updating the first pack after the second wrote last backs nothing up", () => {
    const h = home();
    expect(install(h, content(h, "a1", A1), "pack-a", "1").code).toBe(0);
    expect(install(h, content(h, "b1", B1), "pack-b", "1").code).toBe(0);
    const A2: Pack = { ...A1, squads: { "shared-sq": "sq (copy a, v2)\n", "only-a": "a2\n" } };
    const r = install(h, content(h, "a2", A2), "pack-a", "2");
    expect(r.code, r.out).toBe(0);
    expect(r.out).not.toContain("BACKED UP");
    expect(fs.existsSync(backups(h, "pack-a"))).toBe(false);
    expect(fs.readFileSync(squadFile(h, "shared-sq"), "utf8")).toBe("sq (copy a, v2)\n");
  }, spawnBudgetMs(3));

  test("the buyer's edit to a shared component is still backed up", () => {
    const h = home();
    expect(install(h, content(h, "a1", A1), "pack-a", "1").code).toBe(0);
    expect(install(h, content(h, "b1", B1), "pack-b", "1").code).toBe(0);
    fs.writeFileSync(squadFile(h, "shared-sq"), "mine\n");
    const A2: Pack = { ...A1, squads: { "shared-sq": "sq (copy a, v2)\n", "only-a": "a\n" } };
    const r = install(h, content(h, "a2", A2), "pack-a", "2");
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("BACKED UP: 1 component(s)");
    expect(r.out).toContain("~ squads/shared-sq");
    const stamp = fs.readdirSync(backups(h, "pack-a"))[0];
    expect(fs.readFileSync(path.join(backups(h, "pack-a"), stamp, "squads", "shared-sq", "README.md"), "utf8")).toBe("mine\n");
  }, spawnBudgetMs(3));

  test("a pack that drops a shared component leaves it for the pack that still delivers it", () => {
    const h = home();
    expect(install(h, content(h, "a1", A1), "pack-a", "1").code).toBe(0);
    expect(install(h, content(h, "b1", B1), "pack-b", "1").code).toBe(0);
    const A2: Pack = { squads: { "only-a": "a\n" }, businesses: A1.businesses, clones: A1.clones };
    const r = install(h, content(h, "a2", A2), "pack-a", "2");
    expect(r.code, r.out).toBe(0);
    expect(fs.existsSync(squadFile(h, "shared-sq"))).toBe(true);
  }, spawnBudgetMs(3));

  test("uninstalling one pack keeps every component the other pack delivers", () => {
    const h = home();
    expect(install(h, content(h, "a1", A1), "pack-a", "1").code).toBe(0);
    expect(install(h, content(h, "b1", B1), "pack-b", "1").code).toBe(0);
    const r = uninstall(h, "pack-b");
    expect(r.code, r.out).toBe(0);
    expect(fs.existsSync(squadFile(h, "shared-sq"))).toBe(true);
    expect(fs.existsSync(bizFile(h, "shared-biz"))).toBe(true);
    expect(fs.existsSync(cloneDir(h, "shared-cl"))).toBe(true);
    expect(fs.existsSync(cloneDir(h, "only-b"))).toBe(false);            // only pack-b delivered it
    expect(fs.existsSync(squadFile(h, "only-a"))).toBe(true);
    expect(r.out).toContain("stays squads/shared-sq");
    expect(r.out).toContain("3 shared with other packs stay installed");
    expect(r.out).toContain("nrv update pack-a");                       // the shared business may hold pack-b's variant
    expect(fs.existsSync(path.join(h, ".nirvana", "packs", "pack-b.json"))).toBe(false);
  }, spawnBudgetMs(3));
});
