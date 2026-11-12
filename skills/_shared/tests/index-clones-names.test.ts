// index-clones-names.test.ts — manifest.aliases and manifest.canonical reach
// the registry, where name recognition (harness/lib/clone-names.ts) reads them.
// Project-scoped scan in a temp HOME: the owner's registries are never touched.
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const SCRIPT = path.join(import.meta.dir, "..", "scripts", "index-clones.ts");
const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true }); });

describe("index-clones", () => {
  test("carries aliases and canonical; absent, they are [] and null", () => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nrv-index-names-home-")));
    const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nrv-index-names-")));
    roots.push(home, project);
    fs.mkdirSync(path.join(project, ".nirvana"), { recursive: true });
    fs.writeFileSync(path.join(project, ".nirvana", "project.yaml"), "schema_version: nirvana.project/v1alpha1\n");
    const write = (slug: string, extra: string) => {
      const dir = path.join(project, ".nirvana", "mind-clones", slug);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "MANIFEST.yaml"), `manifest:\n  name: ${slug}\n  display_name: "Nayib Bukele"\n  version: 1.0.0\n${extra}`);
    };
    write("nayib-bukele", '  aliases: ["Chivo", 7]\n  canonical: true\n');
    write("nayib-bukele-ceo", "  canonical: nayib-bukele\n");
    write("someone-else", "");
    const r = Bun.spawnSync([process.execPath, SCRIPT], {
      cwd: project,
      env: { ...process.env, HOME: home, USERPROFILE: home, NIRVANA_SCOPE: "project", NIRVANA_PROJECT_ROOT: project },
    });
    expect(r.exitCode, r.stderr.toString()).toBe(0);
    const reg = JSON.parse(fs.readFileSync(path.join(project, ".nirvana", ".mind-clones-registry.json"), "utf8")).mind_clones;
    expect([reg["nayib-bukele"].aliases, reg["nayib-bukele"].canonical]).toEqual([["Chivo"], true]);
    expect(reg["nayib-bukele-ceo"].canonical).toBe("nayib-bukele");
    expect([reg["someone-else"].aliases, reg["someone-else"].canonical]).toEqual([[], null]);
  });
});
