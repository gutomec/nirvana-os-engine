// init-adopt.test.ts — `nrv init --adopt` declares an existing folder a project.
//
// A project is exactly a folder with `.nirvana/project.yaml`. A folder that
// already holds Nirvana work under the old marker rule (outputs, logs, a
// kernel) needs that one file and nothing else: adoption must not scaffold,
// overwrite or move anything, and running it twice must change nothing.
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnBudgetMs } from "../../harness/tests/helpers/test-budgets.ts";

const SCRIPT = path.join(import.meta.dir, "..", "scripts", "init-project.ts");
const R = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nrv-adopt-")));
afterAll(() => fs.rmSync(R, { recursive: true, force: true }));

function adopt(args: string[], cwd: string, home = path.join(R, "home")) {
  fs.mkdirSync(home, { recursive: true });
  return spawnSync(process.execPath, [SCRIPT, ...args, "--adopt"], {
    cwd, encoding: "utf8",
    env: { ...process.env, HOME: home, USERPROFILE: home, NIRVANA_SKIP_PATH_PERSIST: "1", NO_COLOR: "1" },
  });
}

function tree(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      out.push(path.relative(dir, p));
      if (e.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out.sort();
}

describe("nrv init --adopt", () => {
  test("writes only .nirvana/project.yaml, and a second run changes nothing", () => {
    const folder = path.join(R, "legacy-work");
    fs.mkdirSync(path.join(folder, ".nirvana", "logs"), { recursive: true });
    fs.mkdirSync(path.join(folder, "outputs", "run-1"), { recursive: true });
    fs.writeFileSync(path.join(folder, "notes.md"), "mine\n");
    const before = tree(folder);

    const first = adopt([folder], R);
    expect(first.status, first.stderr + first.stdout).toBe(0);
    const manifest = path.join(folder, ".nirvana", "project.yaml");
    expect(fs.existsSync(manifest)).toBe(true);
    expect(tree(folder)).toEqual([...before, path.join(".nirvana", "project.yaml")].sort());
    const written = fs.readFileSync(manifest, "utf8");

    const second = adopt([], folder);
    expect(second.status, second.stderr + second.stdout).toBe(0);
    expect(fs.readFileSync(manifest, "utf8")).toBe(written);
    expect(`${second.stdout}${second.stderr}`).toContain("already a Nirvana project");
  }, spawnBudgetMs(2));

  test("refuses the home folder", () => {
    const home = path.join(R, "home-refused");
    const r = adopt([home], R, home);
    expect(r.status).not.toBe(0);
    expect(fs.existsSync(path.join(home, ".nirvana", "project.yaml"))).toBe(false);
  }, spawnBudgetMs(1));
});
