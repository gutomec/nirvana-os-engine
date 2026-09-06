// activator-posix-shell.test.ts — a pack's shell lines are POSIX; the activator
// runs them in a POSIX shell on every platform, Windows included (Git Bash,
// which the nrv launcher already requires there). The lines below are the
// shapes the published packs actually use. A failing hook is a warning the
// driving agent can read, never a failure that hides the squad.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..", "..", "..");
const ACTIVATOR = join(REPO, "skills", "squads", "lib", "activator.js");
const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function fixture(dependencies: string) {
  const root = mkdtempSync(join(tmpdir(), "activator-posix-")); roots.push(root);
  const squadDir = join(root, "squads", "fixture-squad");
  mkdirSync(squadDir, { recursive: true });
  writeFileSync(join(squadDir, "squad.yaml"), 'name: fixture-squad\nversion: "1.0.0"\nprotocol: "5.0"\ndescription: test\n');
  writeFileSync(join(squadDir, "dependencies.yaml"), dependencies);
  return { root, squadDir, stateFile: join(root, "state", "fixture-squad", "activated.json") };
}
function activate(f: { root: string; squadDir: string }) {
  const r = spawnSync(process.execPath, [ACTIVATOR, "activate", "fixture-squad"], {
    encoding: "utf8",
    env: { ...process.env, NIRVANA_SKILLS_DIR: join(REPO, "skills"), NIRVANA_RESOLVED_SQUAD_PATH: f.squadDir, NIRVANA_STATE_DIR: join(f.root, "state"), NIRVANA_HOME: f.root },
  });
  return { status: r.status, json: JSON.parse(r.stdout), stderr: r.stderr ?? "" };
}

describe("the POSIX shell the activator uses", () => {
  test("on Windows, Git Bash is found (the launcher requires it); elsewhere /bin/sh is already POSIX", () => {
    const { _posixShell } = require(ACTIVATOR);
    const shell = _posixShell();
    if (process.platform === "win32") {
      expect(shell, "Git for Windows must be found on a Windows machine that runs nrv").toBeTruthy();
      expect(shell!.toLowerCase()).toContain("bash.exe");
    } else {
      expect(shell).toBeNull();
    }
  });
});

describe("post_install lines shaped like the published packs", () => {
  test("pipes, ||-fallbacks, ~ expansion and head all run, on this platform, through the POSIX shell", () => {
    const f = fixture([
      "post_install:",
      '  - "echo posix-pipe | head -1"',
      '  - "nirvana-tool-that-does-not-exist --version || echo fallback-taken"',
      '  - "test -d ~ && echo home-expands"',
      "  - \"printf '%s\\\\n' a b c | head -1 >/dev/null 2>&1\"",
      '  - "bun --version | head -1"',
      "",
    ].join("\n"));
    const r = activate(f);
    expect(r.status, r.stderr).toBe(0);
    expect(r.json.steps.post_install.items.map((i: any) => i.status)).toEqual(["ok", "ok", "ok", "ok", "ok"]);
    expect(r.json.warnings).toHaveLength(0);
  }, 60_000);

  test("a failing hook is a warning the agent can read; the squad still activates and its state is written", () => {
    const f = fixture('post_install:\n  - "exit 7"\n  - "echo still-runs"\n');
    const r = activate(f);
    expect(r.status).toBe(0);
    expect(r.json.ok).toBe(true);
    expect(r.json.failures).toHaveLength(0);
    expect(r.json.steps.post_install.items.map((i: any) => i.status)).toEqual(["failed", "ok"]);
    expect(r.json.warnings).toHaveLength(1);
    expect(r.json.warnings[0]).toMatchObject({ step: "post_install", status: "failed", cmd: "exit 7" });
    expect(existsSync(f.stateFile)).toBe(true);
  }, 60_000);
});

describe("system tool presence through the same shell", () => {
  test("a tool that exists on every CI machine is already_present; an absent one is a missing_system_tool warning", () => {
    const f = fixture("system:\n  - git\n  - nirvana-certainly-absent-tool\n");
    const r = activate(f);
    expect(r.status).toBe(0);
    const byName = Object.fromEntries(r.json.steps.system.map((i: any) => [i.name, i.status]));
    expect(byName.git).toBe("already_present");
    expect(byName["nirvana-certainly-absent-tool"]).toBe("missing_system_tool");
    expect(r.json.warnings.map((w: any) => w.name)).toEqual(["nirvana-certainly-absent-tool"]);
  }, 60_000);

  test("an object dependency's check: runs in the POSIX shell too", () => {
    const f = fixture('system:\n  - name: git-via-check\n    check: "git --version | head -1"\n');
    const r = activate(f);
    expect(r.status).toBe(0);
    expect(r.json.steps.system[0].status).toBe("already_present");
  }, 60_000);
});
