// update-backup-both-paths.test.ts — the rollback the script promises exists.
//
// `nrv update` documents, at the top of the file, that it backs up
// ~/.nirvana/skills before applying anything, and it prints a one-command
// rollback at the end. On an installation created by `npx @nirvana-os/cli` —
// the path every buyer who did not clone the repo takes — neither ever ran.
// `updateFromRelease()` ends in `process.exit`, so the backup, the prune and
// the `nirvana_updated` audit event, all written below that call, belonged to
// the git checkout alone. The rollback line named a directory that was never
// created, and nineteen days of one user's audit log carried zero
// `nirvana_updated` events across a 0.9.0 to 0.13.6 upgrade (issue #253).
//
// These run the real script as a subprocess against a stub engine tarball, so
// what is proven is what the file system looks like afterwards.
import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { spawnBudgetMs } from "./helpers/test-budgets.ts";

const SCRIPT = path.join(import.meta.dir, "..", "scripts", "update.ts");
const roots: string[] = [];
afterAll(() => { for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true }); });

/** Strip ANSI colour so a printed path can be compared to a real one. */
const plain = (s: string) => s.replace(/\[[0-9;]*m/g, "");

/** A whole fake machine: a home with no ~/nirvana-os checkout (so the script
 *  takes the release path), a deployed skills tree, and a stub engine tarball
 *  whose installer overwrites that tree the way the real one does. */
function machine(opts: { installerExits?: number; olderBackups?: string[] } = {}) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nrv-upd-")));
  roots.push(home);
  const skills = path.join(home, ".nirvana", "skills");
  fs.mkdirSync(skills, { recursive: true });
  fs.writeFileSync(path.join(skills, "VERSION"), "0.13.6\n");
  fs.writeFileSync(path.join(skills, "MARKER.txt"), "the deployment that was here before the update");
  for (const name of opts.olderBackups ?? []) {
    fs.mkdirSync(path.join(home, ".nirvana", name), { recursive: true });
    fs.writeFileSync(path.join(home, ".nirvana", name, "old.txt"), "x");
  }

  // The stub engine: scripts/install.ts at the root, skills/VERSION beside it.
  const src = path.join(home, "engine-src");
  fs.mkdirSync(path.join(src, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(src, "skills"), { recursive: true });
  fs.writeFileSync(path.join(src, "skills", "VERSION"), "0.13.7\n");
  fs.writeFileSync(path.join(src, "scripts", "install.ts"), [
    'import * as fs from "node:fs";',
    'import * as path from "node:path";',
    'const dir = process.env.NIRVANA_SKILLS_DIR!;',
    'fs.writeFileSync(path.join(dir, "MARKER.txt"), "overwritten by the new engine");',
    'fs.writeFileSync(path.join(dir, "VERSION"), "0.13.7");',
    `process.exit(${opts.installerExits ?? 0});`,
  ].join("\n"));
  const t = spawnSync("tar", ["-czf", "engine.tar.gz", "-C", "engine-src", "."], { cwd: home, encoding: "utf8" });
  if (t.status !== 0) throw new Error(`tar failed: ${t.stderr}`);

  const run = () => spawnSync(process.execPath, [SCRIPT], {
    encoding: "utf8",
    timeout: spawnBudgetMs(60_000),
    env: {
      ...process.env,
      HOME: home, USERPROFILE: home,          // os.homedir(), both platforms
      NIRVANA_SKILLS_DIR: skills,
      NIRVANA_ENGINE_TARBALL: path.join(home, "engine.tar.gz"),
    },
  });
  const backups = () => fs.readdirSync(path.join(home, ".nirvana")).filter((e) => e.startsWith("skills-backup-")).sort();
  const auditEvents = () => {
    const day = path.join(home, ".harness-logs", new Date().toISOString().slice(0, 10), "audit.jsonl");
    if (!fs.existsSync(day)) return [];
    return fs.readFileSync(day, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  };
  return { home, skills, run, backups, auditEvents };
}

describe("a release install gets the same safety net as a git checkout", () => {
  // One run, four facts about it. Deliberately not four runs: each one extracts
  // a tarball and spawns the installer, and the Windows job runs the whole
  // suite inside one wall-clock budget that a few extra subprocesses move.
  test("it copies the tree aside, records the update, and prints a rollback that exists", () => {
    const m = machine();
    const r = m.run();
    expect(r.status).toBe(0);

    const backups = m.backups();
    expect(backups).toHaveLength(1);
    // The copy holds what was deployed BEFORE, which is the whole point.
    expect(fs.readFileSync(path.join(m.home, ".nirvana", backups[0], "MARKER.txt"), "utf8"))
      .toBe("the deployment that was here before the update");
    expect(fs.readFileSync(path.join(m.skills, "MARKER.txt"), "utf8")).toBe("overwritten by the new engine");

    const line = plain(r.stdout).split("\n").find((l) => l.includes("rm -rf") && l.includes("mv"));
    expect(line, "no rollback line was printed on the release path").toBeDefined();
    expect(fs.existsSync(line!.match(/mv\s+(\S+)\s/)![1])).toBe(true);

    const updated = m.auditEvents().filter((e) => e.event === "nirvana_updated");
    expect(updated).toHaveLength(1);
    expect(updated[0].path).toBe("release");
    expect(updated[0].to_version).toBe("0.13.7");
    expect(String(updated[0].backup)).toContain("skills-backup-");
  }, 90_000);

  test("older backups are pruned, exactly as the doctor's advice assumes", () => {
    // `nrv doctor` tells the user "nrv update keeps only the latest". On a
    // release install that prune never ran either, so the claim was never true.
    const m = machine({ olderBackups: ["skills-backup-2026-01-01T00-00-00", "skills-backup-2026-02-02T00-00-00"] });
    expect(m.run().status).toBe(0);
    expect(m.backups()).toHaveLength(1);
  }, 90_000);
});

describe("a failed update keeps what could still save it", () => {
  test("the backup survives, nothing is pruned, and the rollback is printed", () => {
    const m = machine({ installerExits: 1, olderBackups: ["skills-backup-2026-01-01T00-00-00"] });
    const r = m.run();
    expect(r.status).toBe(1);
    // Two: the one this run made and the one it did NOT prune.
    expect(m.backups()).toHaveLength(2);
    expect(plain(`${r.stdout}${r.stderr}`)).toContain("rm -rf");
    // A failed update is not an update: no record is written.
    expect(m.auditEvents().filter((e) => e.event === "nirvana_updated")).toHaveLength(0);
  }, 90_000);
});

describe("what the file still promises", () => {
  const src = fs.readFileSync(SCRIPT, "utf8").replace(/\r\n/g, "\n");

  test("both paths reach the same helpers — the split is gone", () => {
    // One definition plus a call from each path.
    for (const helper of ["backupSkills(", "pruneOldBackups(", "emitUpdated(", "rollbackHint("]) {
      const uses = src.split(helper).length - 1;
      expect(uses, `${helper} appears ${uses} times, so one update path still misses it`).toBeGreaterThanOrEqual(3);
    }
  });

  test("the audit directory is created with the tolerant mkdir", () => {
    // A recursive mkdir can throw EEXIST under Bun on Windows, which is how
    // audit events were being dropped elsewhere in the engine.
    expect(src).toContain("ensureDir(auditDir)");
    expect(src).not.toContain("fs.mkdirSync(auditDir, { recursive: true })");
  });
});
