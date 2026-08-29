// install-hooks-uninstall.test.ts — `nrv install --uninstall` is the exact
// inverse of what `nrv install` wrote: the PATH block in a shell rc file, and
// our hook keys in settings.json.
//
// Neither had a test before this file: the rc-file write (wireLocalBinOnPath)
// had no reverse call at all — `--uninstall` skipped it entirely, so a shell
// profile kept the marker + PATH line forever. settings.json was already
// symmetric (patchSettings takes a mode), but nothing proved it end to end.
//
// Runs with a real HOME/USERPROFILE redirect (never NIRVANA_SKIP_PATH_PERSIST,
// which would skip the write this test exists to reverse) — every write lands
// inside the temporary root, never the real profile.
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeDir } from "./helpers/temp-dirs.ts";

const IS_WINDOWS = process.platform === "win32";
const REPO = join(import.meta.dir, "..", "..", "..");
const INSTALL = join(REPO, "skills", "_shared", "scripts", "install.ts");

const ROOTS: string[] = [];
afterAll(() => { for (const r of ROOTS) removeDir(r); });

function home(): string {
  const root = mkdtempSync(join(tmpdir(), "nrv-uninstall-hooks-"));
  ROOTS.push(root);
  return root;
}

function run(args: string[], root: string) {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    HOME: root,
    USERPROFILE: root,
    NIRVANA_SKILLS_DIR: join(REPO, "skills"),
    SHELL: "/bin/zsh",
  };
  delete env.NIRVANA_SKIP_PATH_PERSIST; // this test targets the write it exists to reverse
  const r = spawnSync(process.execPath, [INSTALL, ...args], { cwd: root, env, encoding: "utf8" });
  return { code: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

describe.skipIf(IS_WINDOWS)("nrv install --uninstall — shell rc file (POSIX; Windows persists to the registry instead)", () => {
  test("removes exactly the PATH block it added, leaving every other byte identical", () => {
    const root = home();
    const zshrcBefore = "# my own aliases\nalias ll=\"ls -la\"\n";
    const profileBefore = "umask 022\n";
    writeFileSync(join(root, ".zshrc"), zshrcBefore, "utf8");
    writeFileSync(join(root, ".profile"), profileBefore, "utf8");

    const install = run([], root);
    expect(install.code).toBe(0);
    const zshrcAfterInstall = readFileSync(join(root, ".zshrc"), "utf8");
    const profileAfterInstall = readFileSync(join(root, ".profile"), "utf8");
    expect(zshrcAfterInstall).toContain("# nirvana-os: nrv on PATH");
    expect(profileAfterInstall).toContain("# nirvana-os: nrv on PATH");
    // The block is appended, so the original bytes are still a prefix.
    expect(zshrcAfterInstall.startsWith(zshrcBefore)).toBe(true);
    expect(profileAfterInstall.startsWith(profileBefore)).toBe(true);

    const uninstall = run(["--uninstall"], root);
    expect(uninstall.code).toBe(0);
    expect(readFileSync(join(root, ".zshrc"), "utf8")).toBe(zshrcBefore);
    expect(readFileSync(join(root, ".profile"), "utf8")).toBe(profileBefore);
  }, 30_000);

  test("--dry reports the removal and touches nothing", () => {
    const root = home();
    writeFileSync(join(root, ".zshrc"), "export FOO=bar\n", "utf8");
    expect(run([], root).code).toBe(0);
    const before = readFileSync(join(root, ".zshrc"), "utf8");

    const dry = run(["--uninstall", "--dry"], root);
    expect(dry.code).toBe(0);
    expect(dry.out).toContain("would remove the PATH block from ~/.zshrc");
    expect(readFileSync(join(root, ".zshrc"), "utf8")).toBe(before);
  }, 30_000);

  test("a file we created from nothing is removed entirely, not left as an empty file", () => {
    const root = home();
    expect(existsSync(join(root, ".profile"))).toBe(false);
    expect(run([], root).code).toBe(0);
    expect(existsSync(join(root, ".profile"))).toBe(true); // install created it fresh

    const dry = run(["--uninstall", "--dry"], root);
    expect(dry.out).toContain("we created it");
    expect(existsSync(join(root, ".profile"))).toBe(true); // dry touches nothing

    const uninstall = run(["--uninstall"], root);
    expect(uninstall.code).toBe(0);
    expect(uninstall.out).toContain("removed ~/.profile (was created solely by us)");
    expect(existsSync(join(root, ".profile"))).toBe(false);
  }, 30_000);

  test("a marker with a hand-edited follow-line is reported and left alone", () => {
    const root = home();
    const tampered = "# nirvana-os: nrv on PATH\nexport PATH=\"/opt/custom:$PATH\"\n";
    writeFileSync(join(root, ".zshrc"), tampered, "utf8");

    const uninstall = run(["--uninstall"], root);
    expect(uninstall.code).toBe(0);
    expect(uninstall.out).toContain("does not match what we wrote");
    expect(readFileSync(join(root, ".zshrc"), "utf8")).toBe(tampered);
  }, 30_000);

  test("no marker present — uninstall is a silent no-op for that file", () => {
    const root = home();
    const untouched = "export PATH=\"/opt/custom:$PATH\"\n";
    writeFileSync(join(root, ".zshrc"), untouched, "utf8");

    const uninstall = run(["--uninstall"], root);
    expect(uninstall.code).toBe(0);
    expect(uninstall.out).not.toContain(".zshrc");
    expect(readFileSync(join(root, ".zshrc"), "utf8")).toBe(untouched);
  }, 30_000);
});

describe("nrv install --uninstall — settings.json (symmetric with install, now proven end to end)", () => {
  test("removes only our hook entries; the user's own hooks and keys survive", () => {
    const root = home();
    const claudeDir = join(root, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    const userSettings = {
      theme: "dark",
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ name: "user-own-hook", type: "command", command: "echo mine" }] }],
      },
    };
    writeFileSync(join(claudeDir, "settings.json"), JSON.stringify(userSettings, null, 2) + "\n", "utf8");

    const install = run([], root);
    expect(install.code).toBe(0);
    const afterInstall = JSON.parse(readFileSync(join(claudeDir, "settings.json"), "utf8"));
    expect(afterInstall.theme).toBe("dark");
    const preHooks = afterInstall.hooks.PreToolUse;
    expect(preHooks.some((g: any) => g.hooks.some((h: any) => h.command?.includes("audit-emit-from-hook.ts")))).toBe(true);
    expect(preHooks.some((g: any) => g.hooks.some((h: any) => h.name === "user-own-hook"))).toBe(true);

    const uninstall = run(["--uninstall"], root);
    expect(uninstall.code).toBe(0);
    const afterUninstall = JSON.parse(readFileSync(join(claudeDir, "settings.json"), "utf8"));
    expect(afterUninstall.theme).toBe("dark");
    const keptHooks = afterUninstall.hooks.PreToolUse;
    expect(keptHooks.some((g: any) => g.hooks.some((h: any) => h.name === "user-own-hook"))).toBe(true);
    expect(keptHooks.some((g: any) => g.hooks.some((h: any) => h.command?.includes("audit-emit-from-hook.ts")))).toBe(false);
  }, 30_000);

  test("a settings.json that never had our hooks is not rewritten", () => {
    const root = home();
    const claudeDir = join(root, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    const raw = JSON.stringify({ theme: "light" }, null, 2) + "\n";
    writeFileSync(join(claudeDir, "settings.json"), raw, "utf8");

    const uninstall = run(["--uninstall"], root);
    expect(uninstall.code).toBe(0);
    expect(readFileSync(join(claudeDir, "settings.json"), "utf8")).toBe(raw);
    // No backup file created for a settings.json nothing changed in.
    const files = existsSync(claudeDir) ? readdirSync(claudeDir) : [];
    expect(files.filter((f: string) => f.includes(".nirvana-backup."))).toHaveLength(0);
  }, 30_000);
});
