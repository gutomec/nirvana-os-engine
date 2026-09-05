// install-content-keep.test.ts — a pack update against a buyer's edits.
//
// --keep-clones leaves every mind-clone already on disk as it is (new ones
// still arrive); without it, a component changed since the pack installed it
// is backed up before the overlay writes over it, and a user-created component
// that collides with a pack slug is backed up too. The real script, a real
// temp home; the only thing skipped is validation and re-indexing.
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnBudgetMs } from "./helpers/test-budgets.ts";

const SCRIPT = path.join(import.meta.dir, "..", "..", "_shared", "scripts", "install-content.ts");
const roots: string[] = [];
afterEach(() => { while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true }); });

function home(): string {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-keep-clones-")); roots.push(h);
  return h;
}
function content(h: string, name: string, clones: Record<string, string>): string {
  const c = path.join(h, "content", name);
  for (const k of ["squads", "businesses", "mind-clones"]) fs.mkdirSync(path.join(c, k), { recursive: true });
  for (const [slug, dna] of Object.entries(clones)) {
    fs.mkdirSync(path.join(c, "mind-clones", slug, "dna"), { recursive: true });
    fs.writeFileSync(path.join(c, "mind-clones", slug, "MANIFEST.yaml"), `name: ${slug}\n`);
    fs.writeFileSync(path.join(c, "mind-clones", slug, "dna", "DNA.md"), dna);
  }
  return c;
}
function run(h: string, c: string, args: string[]) {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || /^(NIRVANA_HOME|SQUADS_DIR|BUSINESSES_DIR|DNA_LIBRARY)$/.test(k)) continue;
    env[k] = v;
  }
  Object.assign(env, { HOME: h, USERPROFILE: h, NIRVANA_HOME: h });
  const r = spawnSync(process.execPath, [SCRIPT, c, "--slug", "test-pack", "--skip-validate", "--no-index", ...args], { encoding: "utf8", env, cwd: h });
  return { code: r.status ?? -1, out: `${r.stdout}\n${r.stderr}` };
}
const dna = (h: string, slug: string) => path.join(h, "businesses", "_library", "dna", slug, "dna", "DNA.md");
const manifest = (h: string) => JSON.parse(fs.readFileSync(path.join(h, ".nirvana", "packs", "test-pack.json"), "utf8"));
const backups = (h: string) => path.join(h, ".nirvana", "backups", "packs", "test-pack");

describe("pack overlay vs the buyer's edits", () => {
  test("--keep-clones: an edited clone stays, a new clone arrives, the manifest still records what the pack last installed", () => {
    const h = home();
    const v1 = content(h, "v1", { "expert-x": "v1\n" });
    expect(run(h, v1, ["--version", "1"]).code).toBe(0);
    expect(fs.readFileSync(dna(h, "expert-x"), "utf8")).toBe("v1\n");
    const recorded = manifest(h)["mind-clones"]["expert-x"];
    fs.writeFileSync(dna(h, "expert-x"), "mine\n");                       // the buyer's edit

    const v2 = content(h, "v2", { "expert-x": "v2\n", "expert-y": "y\n" });
    const r = run(h, v2, ["--version", "2", "--keep-clones"]);
    expect(r.code, r.out).toBe(0);
    expect(fs.readFileSync(dna(h, "expert-x"), "utf8")).toBe("mine\n");   // kept
    expect(fs.readFileSync(dna(h, "expert-y"), "utf8")).toBe("y\n");      // new one still arrives
    expect(r.out).toContain("1 kept (local)");
    expect(manifest(h)["mind-clones"]["expert-x"]).toBe(recorded);        // not "current" — a later plain update replaces it
    expect(manifest(h)["mind-clones"]["expert-y"]).toBeTruthy();
    expect(fs.existsSync(backups(h))).toBe(false);                         // nothing was overwritten, nothing backed up
  }, spawnBudgetMs(2));

  test("without the flag: the edited clone is backed up, then replaced; an untouched clone is replaced without a backup", () => {
    const h = home();
    const v1 = content(h, "v1", { "expert-x": "v1\n", "expert-z": "z1\n" });
    expect(run(h, v1, ["--version", "1"]).code).toBe(0);
    fs.writeFileSync(dna(h, "expert-x"), "mine\n");
    const v2 = content(h, "v2", { "expert-x": "v2\n", "expert-z": "z2\n" });
    const r = run(h, v2, ["--version", "2"]);
    expect(r.code, r.out).toBe(0);
    expect(fs.readFileSync(dna(h, "expert-x"), "utf8")).toBe("v2\n");
    expect(fs.readFileSync(dna(h, "expert-z"), "utf8")).toBe("z2\n");
    expect(r.out).toContain("BACKED UP: 1 component(s)");
    expect(r.out).toContain("~ mind-clones/expert-x");
    expect(r.out).not.toContain("~ mind-clones/expert-z");
    const stamps = fs.readdirSync(backups(h));
    expect(stamps.length).toBe(1);
    expect(fs.readFileSync(path.join(backups(h), stamps[0], "mind-clones", "expert-x", "dna", "DNA.md"), "utf8")).toBe("mine\n");
    expect(fs.existsSync(path.join(backups(h), stamps[0], "mind-clones", "expert-z"))).toBe(false);
  }, spawnBudgetMs(2));

  test("a user-created clone that collides with a pack slug is backed up before the pack wins", () => {
    const h = home();
    const v1 = content(h, "v1", {});
    expect(run(h, v1, ["--version", "1"]).code).toBe(0);
    fs.mkdirSync(path.dirname(dna(h, "mine-clone")), { recursive: true });
    fs.writeFileSync(path.join(h, "businesses", "_library", "dna", "mine-clone", "MANIFEST.yaml"), "name: mine-clone\n");
    fs.writeFileSync(dna(h, "mine-clone"), "hand-made\n");
    const v2 = content(h, "v2", { "mine-clone": "pack\n" });
    const r = run(h, v2, ["--version", "2"]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("OVERWRITTEN: 1 component(s)");
    expect(r.out).toContain("~ mind-clones/mine-clone");
    expect(fs.readFileSync(dna(h, "mine-clone"), "utf8")).toBe("pack\n");
    const stamps = fs.readdirSync(backups(h));
    expect(fs.readFileSync(path.join(backups(h), stamps[0], "mind-clones", "mine-clone", "dna", "DNA.md"), "utf8")).toBe("hand-made\n");
  }, spawnBudgetMs(2));

  test("--dry names what it would back up and touches nothing", () => {
    const h = home();
    const v1 = content(h, "v1", { "expert-x": "v1\n" });
    expect(run(h, v1, ["--version", "1"]).code).toBe(0);
    fs.writeFileSync(dna(h, "expert-x"), "mine\n");
    const v2 = content(h, "v2", { "expert-x": "v2\n" });
    const r = run(h, v2, ["--version", "2", "--dry"]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("WOULD BACK UP: 1 component(s)");
    expect(fs.readFileSync(dna(h, "expert-x"), "utf8")).toBe("mine\n");
    expect(fs.existsSync(backups(h))).toBe(false);
  }, spawnBudgetMs(2));
});
