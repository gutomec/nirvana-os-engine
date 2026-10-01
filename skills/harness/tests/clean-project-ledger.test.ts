// clean-project-ledger.test.ts — `nrv clean <project>` closes the project's open
// ledger rows, and refuses while one of its runs is still working.
//
// The incident this pins: a run failed on quota, `nrv clean` moved its folder,
// the project was re-dispatched on another runtime, and the old `failed` row
// stayed active, so the supervisor could resume it into the folder the new run
// was using. Hermetic: temp HOME, temp project, temp ledger; the real script.
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as runLedger from "../lib/run-ledger.ts";
import { makeTempRoot, removeDir } from "./helpers/temp-dirs.ts";
import { spawnBudgetMs } from "./helpers/test-budgets.ts";

const SKILLS = path.resolve(import.meta.dir, "..", "..");
const CLEAN = path.join(SKILLS, "harness", "scripts", "clean-project.ts");
const PID = "proj-clean";

const roots: string[] = [];
const handles: runLedger.LedgerHandle[] = [];
afterEach(() => {
  while (handles.length) handles.pop()!.close();
  while (roots.length) removeDir(roots.pop()!);
});

function fixture() {
  const root = makeTempRoot("nrv-clean-ledger-");
  roots.push(root);
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  const runDir = path.join(project, "outputs", PID);
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(project, ".nirvana"), { recursive: true });
  fs.writeFileSync(path.join(project, ".nirvana", "project.yaml"), "name: clean-fixture\n");
  fs.mkdirSync(path.join(runDir, "squads", "copy"), { recursive: true });
  fs.writeFileSync(path.join(runDir, "brief.md"), "# brief\n");
  const db = path.join(root, "ledger.sqlite");
  const ledger = runLedger.openLedger(db);
  handles.push(ledger);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || /^(NIRVANA_|HARNESS_|NRV_)/.test(key)) continue;
    env[key] = value;
  }
  Object.assign(env, {
    HOME: home, USERPROFILE: home, NIRVANA_SKILLS_DIR: SKILLS, NIRVANA_RUN_LEDGER_DB: db,
    NIRVANA_STATE_DB: path.join(root, "state.db"), HARNESS_LOGS_DIR: path.join(root, "logs"), NIRVANA_TEST_LOGS_HOME: path.join(root, "logs"),
  });
  /** A row of this project in `state`, walked there legally. */
  const row = (state: runLedger.RunState, opts: Partial<runLedger.OpenRunOpts> = {}): string => {
    const opened = runLedger.openRun(ledger, { traceId: PID, projectId: PID, projectRoot: project, targetKind: "squad", targetSlug: "copy",
      meta: { scaffold_root: runDir, project_dir: path.join(runDir, "squads", "copy") }, ...opts });
    if (state !== "dispatched") runLedger.markState(ledger, opened.run_id, "running");
    if (state === "failed" || state === "stalled" || state === "delivered") runLedger.markState(ledger, opened.run_id, state, state === "failed" ? { error: "quota" } : {});
    return opened.run_id;
  };
  const clean = (...args: string[]) => spawnSync(process.execPath, [CLEAN, PID, ...args, "--no-color"], { cwd: project, env, encoding: "utf8" });
  const get = (runId: string) => runLedger.getRun(ledger, runId)!;
  return { root, home, project, runDir, ledger, row, clean, get };
}

describe("nrv clean closes the project's open ledger rows", () => {
  test("every open row of the project ends abandoned (\"project cleaned\"); other projects and finished runs are untouched", () => {
    const fx = fixture();
    const failed = fx.row("failed");
    const stalled = fx.row("stalled");
    const orphan = fx.row("running", { initialLeaseSec: -60 });   // worker gone, lease expired
    // A run recorded under another root (a store run) whose scaffold is the folder being cleaned.
    const storeRun = fx.row("failed", { projectRoot: fx.home });
    const otherProject = fx.row("failed", { projectId: "another-project", traceId: "another-project" });
    const delivered = fx.row("delivered");

    const r = fx.clean();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(fs.existsSync(fx.runDir)).toBe(false);
    expect(fs.readdirSync(path.join(fx.home, ".nirvana", "trash")).length).toBe(1);
    for (const id of [failed, stalled, orphan, storeRun]) {
      expect(fx.get(id).state, id).toBe("abandoned");
      expect(fx.get(id).last_error).toBe("project cleaned");
    }
    expect(fx.get(otherProject).state).toBe("failed");
    expect(fx.get(delivered).state).toBe("delivered");
    expect(r.stdout).toContain("Open runs abandoned");
  }, spawnBudgetMs(1));

  test("a run still working refuses the clean (exit 4) and nothing moves; --force cleans and abandons it", () => {
    const fx = fixture();
    // The test process stands in for a live worker.
    const live = fx.row("running", { childPid: process.pid });
    const failed = fx.row("failed");

    const refused = fx.clean();
    expect(refused.status, refused.stdout + refused.stderr).toBe(4);
    expect(refused.stderr).toContain(`${live} (squad/copy, running) is still running: worker pid ${process.pid} is alive`);
    expect(refused.stderr).toContain(process.platform === "win32" ? `taskkill /PID ${process.pid}` : `kill ${process.pid}`);
    expect(refused.stderr).toContain("--force");
    expect(fs.existsSync(fx.runDir)).toBe(true);
    expect(fx.get(live).state).toBe("running");
    expect(fx.get(failed).state).toBe("failed");

    const forced = fx.clean("--force");
    expect(forced.status, forced.stdout + forced.stderr).toBe(0);
    expect(fs.existsSync(fx.runDir)).toBe(false);
    expect(fx.get(live).state).toBe("abandoned");
    expect(fx.get(failed).state).toBe("abandoned");
  }, spawnBudgetMs(2));

  test("a pid-less run inside its lease counts as working too (the dispatcher between its worker and the gate)", () => {
    const fx = fixture();
    const judging = fx.row("running", { initialLeaseSec: 600 });
    runLedger.markState(fx.ledger, judging, "verifying");
    const r = fx.clean();
    expect(r.status, r.stdout + r.stderr).toBe(4);
    expect(r.stderr).toContain(`${judging} (squad/copy, verifying) is still running: its lease runs until`);
    expect(fx.get(judging).state).toBe("verifying");
  }, spawnBudgetMs(1));

  test("--dry-run names the rows it would close and closes none", () => {
    const fx = fixture();
    const failed = fx.row("failed");
    const r = fx.clean("--dry-run");
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain(`open run: ${failed} (squad/copy, failed) → abandoned`);
    expect(fs.existsSync(fx.runDir)).toBe(true);
    expect(fx.get(failed).state).toBe("failed");
  }, spawnBudgetMs(1));

  test("a folder already gone still has its open rows closed", () => {
    const fx = fixture();
    const failed = fx.row("failed");
    fs.rmSync(fx.runDir, { recursive: true, force: true });
    const r = fx.clean();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(fx.get(failed).state).toBe("abandoned");
  }, spawnBudgetMs(1));
});
