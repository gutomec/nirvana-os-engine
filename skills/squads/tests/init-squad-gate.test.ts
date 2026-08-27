// init-squad-gate.test.ts — the scaffolder hands over an ADMITTED squad.
//
// A v6 scaffold declares four components it has not written yet and no
// `.nirvana-surface.json` (a hash of files that exist only after this script
// runs), so before the creation hook a brand-new squad was born REJECTED on
// two errors nobody was told about. The hook repairs what the engine owns and
// then judges; what it cannot repair, it deletes rather than leave on disk
// pretending to be a squad.
//
// Runs with: bun test skills/squads/tests
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..", "..", "..");
const INIT = join(REPO, "skills", "squads", "scripts", "init-squad.ts");
const VERIFY = join(REPO, "skills", "_shared", "scripts", "verify.ts");
const ROOTS: string[] = [];
afterAll(() => { for (const r of ROOTS) try { rmSync(r, { recursive: true, force: true }); } catch { /* best effort */ } });

function home(): string {
  const root = mkdtempSync(join(tmpdir(), "nrv-init-squad-"));
  ROOTS.push(root);
  return root;
}

function env(root: string): Record<string, string> {
  return {
    ...process.env,
    NIRVANA_HOME: root,
    NIRVANA_STATE_DIR: join(root, "state"),
    HARNESS_LOGS_DIR: join(root, "logs"),
    SQUADS_DIR: join(root, "squads"),
    BUSINESSES_DIR: join(root, "businesses"),
    DNA_LIBRARY: join(root, "dna"),
    NIRVANA_SKILLS_DIR: join(REPO, "skills"),
    CLAUDE_SKILLS_DIR: join(REPO, "skills"),
    NIRVANA_SCOPE: "global",
    NIRVANA_SCOPE_QUIET: "1",
  } as Record<string, string>;
}

function init(root: string, dir: string, ...args: string[]) {
  const r = spawnSync(process.execPath, [INIT, dir, ...args], { cwd: root, env: env(root), encoding: "utf8" });
  return { code: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

describe("a scaffolded squad passes the gate it was just measured by", () => {
  test("the engine-owned files are written and the verdict is ADMITTED", () => {
    const root = home();
    const dir = join(root, "squads", "fresh-squad");
    expect(init(root, dir).code).toBe(0);

    for (const f of [".nirvana-surface.json", "agents/orchestrator.md", "agents/specialist.md", "tasks/plan.md", "tasks/execute.md"]) {
      expect(existsSync(join(dir, f))).toBe(true);
    }
    const v = spawnSync(process.execPath, [VERIFY, "squad", dir, "--json", "--no-retrieval"], { cwd: root, env: env(root), encoding: "utf8" });
    const report = JSON.parse(v.stdout);
    expect(report.findings.filter((f: any) => f.severity === "error")).toEqual([]);
    expect(report.verdict).toBe("ADMITTED");
    expect(v.status).toBe(0);
  }, 30_000);

  test("--skip-verify leaves the scaffold exactly as the templates wrote it", () => {
    const root = home();
    const dir = join(root, "squads", "raw-squad");
    const r = init(root, dir, "--skip-verify");
    expect(r.code).toBe(0);
    expect(r.out).toContain("skipped by --skip-verify");
    expect(existsSync(join(dir, ".nirvana-surface.json"))).toBe(false);
    expect(existsSync(join(dir, "agents", "orchestrator.md"))).toBe(false);
  }, 30_000);

  test("a scaffold the fixers cannot repair is deleted, not left half-made", () => {
    const root = home();
    const dir = join(root, "squads", "doomed-squad");
    // Only the two templates are faked — the script itself is the repo's, and
    // it reads templates from CLAUDE_SKILLS_DIR. The manifest here cannot
    // parse, which is the one error with no mechanical fixer.
    const templates = join(root, "fake-skills", "squads", "templates");
    mkdirSync(templates, { recursive: true });
    writeFileSync(join(templates, "squad.yaml.tmpl"), 'name: {{SQUAD_NAME}}\ndescription: "unterminated\n  - [\n', "utf8");
    writeFileSync(join(templates, "workflow.md.tmpl"), "---\nname: {{WORKFLOW_REF}}\nsteps: []\n---\n\n## {{TASK_1}}\n", "utf8");
    const r = spawnSync(process.execPath, [INIT, dir], {
      cwd: root, env: { ...env(root), NIRVANA_SKILLS_DIR: join(root, "fake-skills"), CLAUDE_SKILLS_DIR: join(root, "fake-skills") }, encoding: "utf8",
    });
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toContain("does not pass the admission gate");
    expect(existsSync(dir)).toBe(false);
  }, 30_000);
});

describe("the printed next steps match what is on disk", () => {
  test("step 4 is the gate itself", () => {
    const source = readFileSync(INIT, "utf8");
    expect(source).toContain("nrv validate squad");
  });
});
