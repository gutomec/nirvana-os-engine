// update-help.test.ts — `nrv update --help` explains itself and changes nothing.
//
// It used to fall through to the default path: fetch, back up ~/.nirvana/skills
// to a fresh skills-backup-<ts> directory and re-apply the engine, every time
// someone asked what the command does. An unknown flag did the same.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "..", "scripts", "update.ts");

function run(args: string[]) {
  const home = mkdtempSync(join(tmpdir(), "nrv-update-help-"));
  mkdirSync(join(home, ".nirvana", "skills"), { recursive: true });
  try {
    const r = spawnSync(process.execPath, [SCRIPT, ...args], {
      encoding: "utf8", env: { ...process.env, HOME: home, USERPROFILE: home, NIRVANA_HOME: home },
    });
    const backups = readdirSync(join(home, ".nirvana")).filter((n) => n.startsWith("skills-backup-"));
    return { code: r.status, out: `${r.stdout}${r.stderr}`, backups };
  } finally { rmSync(home, { recursive: true, force: true }); }
}

describe("nrv update --help", () => {
  test("prints the usage, exits 0, touches nothing", () => {
    for (const flag of ["--help", "-h"]) {
      const r = run([flag]);
      expect(r.code).toBe(0);
      expect(r.out).toContain("nrv update [<pack-slug>]");
      expect(r.out).not.toContain("Fetching from origin");
      expect(r.backups).toEqual([]);
    }
  });

  test("an unknown flag is refused with exit 2, not run as a default update", () => {
    const r = run(["--hlep"]);
    expect(r.code).toBe(2);
    expect(r.out).toContain("unknown flag --hlep");
    expect(r.out).not.toContain("Fetching from origin");
    expect(r.backups).toEqual([]);
  });
});
