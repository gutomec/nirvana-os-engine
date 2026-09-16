// Runtime skill entries — install/uninstall lifecycle.
//
// These cover four regressions that all cost the user something real:
//   - install and uninstall used to keep SEPARATE runtime-dir lists and drifted
//     (~/.pi/agent/skills was orphaned on uninstall) → now both import
//     _shared/lib/runtime-dirs.ts;
//   - uninstall only removed SYMLINKS, so it removed nothing on Windows and
//     never for Codex (both get COPIES), and the .pre-nirvana.bak restore never
//     ran either;
//   - a second install over a name collision deleted the user's directory;
//   - the installer forced ~/.claude/skills even when Claude Code was absent.
//
// The installer is exercised for real (spawned), against a miniature engine repo
// and a fixture HOME, so the assertions are about what actually lands on disk.

import { test, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fakeHomeEnv } from "../../harness/tests/helpers/fake-home.ts";
import { parkedBackupPath } from "../lib/runtime-install.ts";
import { RUNTIME_ENTRIES, ENGINE_INTERNAL_SKILLS } from "../lib/runtime-dirs.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SKILLS = ["harness", "businesses", "squads", "_shared", "nirvana"];
const COPY_MARKER = ".nirvana-skill-copy";
const RUNTIME_PARENTS = [".claude", ".codex", ".gemini", ".antigravity", path.join(".pi", "agent")];

let root: string;
let fakeRepo: string;

/**
 * Miniature engine repo: the REAL installer + the REAL shared constants, with
 * stub skill trees. Keeps the run hermetic (no bun install, no network) while
 * still exercising the genuine link/copy/backup code paths.
 */
function buildFakeRepo(dir: string): void {
  fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
  fs.copyFileSync(path.join(REPO, "scripts", "install.ts"), path.join(dir, "scripts", "install.ts"));
  fs.mkdirSync(path.join(dir, "skills", "_shared", "lib"), { recursive: true });
  // Every lib the real installer imports. Miss one and the installer dies at
  // import time, which is what happened when run-state.ts was added: the whole
  // suite went red on all three platforms with `install(home).code` non-zero.
  for (const lib of ["runtime-dirs.ts", "run-state.ts", "runtime-install.ts"]) {
    fs.copyFileSync(
      path.join(REPO, "skills", "_shared", "lib", lib),
      path.join(dir, "skills", "_shared", "lib", lib),
    );
  }
  for (const s of SKILLS) {
    fs.mkdirSync(path.join(dir, "skills", s), { recursive: true });
    fs.writeFileSync(path.join(dir, "skills", s, "SKILL.md"), `---\nname: ${s}\n---\nstub\n`);
  }
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "fake-engine", version: "0.0.0" }) + "\n");
  // Present but empty: makes installDeps skip `bun install` (no network in tests).
  fs.mkdirSync(path.join(dir, "node_modules"), { recursive: true });
}

/**
 * A PATH with the system utilities the installer shells out to (`which`/`where`,
 * `sh`, `rsync`) and NO agent CLI. The installer's second install signal is the
 * binary on PATH, so a test about a runtime being absent has to control PATH:
 * inheriting the developer's made "no Claude Code here" true in CI (no `claude`
 * on the runner) and false on any machine that actually has it installed.
 */
const BARE_PATH = process.platform === "win32"
  ? path.join(process.env.SystemRoot || "C:\\Windows", "System32")
  : "/usr/bin:/bin";

function install(
  home: string,
  extraArgs: string[] = [],
  envOverride: Record<string, string> = {},
): { code: number; out: string } {
  const r = spawnSync(
    process.execPath,
    [path.join(fakeRepo, "scripts", "install.ts"), "--no-starter", "--no-index", "--no-hermes", ...extraArgs],
    { env: fakeHomeEnv(home, { NIRVANA_PACKS_DIR: path.join(home, "no-packs"), ...envOverride }), encoding: "utf8" },
  );
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function uninstall(home: string): { code: number; out: string } {
  const r = spawnSync(
    process.execPath,
    [path.join(REPO, "skills", "_shared", "scripts", "uninstall-engine.ts")],
    { env: fakeHomeEnv(home), encoding: "utf8" },
  );
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function isLink(p: string): boolean {
  try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; }
}

/**
 * How a runtime entry is materialised, per platform.
 *
 * install.ts:320 sets `preferCopy = IS_WINDOWS || FLAG_COPY_SKILLS || isCodex`,
 * so Windows gets a COPY with the marker file — symlinks there need admin — and
 * POSIX gets a symlink. Codex always gets a copy, on every platform.
 *
 * This suite asserted the POSIX shape unconditionally, which was invisible
 * because CI only ran `bun test skills/harness/tests` and this file lives in
 * _shared. Running the whole suite surfaced six red tests on Windows against a
 * product that was behaving exactly as designed.
 */
const IS_WINDOWS = process.platform === "win32";

/** Ours, however this platform materialises it. */
function isOurs(p: string): boolean {
  return IS_WINDOWS ? fs.existsSync(path.join(p, COPY_MARKER)) : isLink(p);
}
function exists(p: string): boolean {
  try { fs.lstatSync(p); return true; } catch { return false; }
}

function freshHome(name: string, runtimes: string[] = RUNTIME_PARENTS): string {
  const home = path.join(root, name);
  for (const rt of runtimes) fs.mkdirSync(path.join(home, rt), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  return home;
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-runtime-links-"));
  fakeRepo = path.join(root, "engine");
  buildFakeRepo(fakeRepo);
});

afterAll(() => {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
});

// ── Lifecycle over ONE fixture HOME, in order ────────────────────────────────

test("install links every installed runtime and backs up a colliding third-party dir", () => {
  const home = freshHome("home-lifecycle");
  // (c) a third-party directory that happens to carry the door's name (with no
  // `name: nirvana` frontmatter, so it is not the same skill from skills.sh).
  const thirdParty = path.join(home, ".claude", "skills", "nirvana");
  fs.mkdirSync(thirdParty, { recursive: true });
  fs.writeFileSync(path.join(thirdParty, "THIRD-PARTY.txt"), "não é do Nirvana");

  const { code, out } = install(home);
  expect(code).toBe(0);

  // The user's directory was preserved, never deleted, and the move is visible.
  // Parked OUTSIDE the skills root: a sibling `.pre-nirvana.bak` was a second
  // copy of the skill for every runtime that scans recursively.
  const bak = parkedBackupPath(thirdParty, home);
  expect(fs.readFileSync(path.join(bak, "THIRD-PARTY.txt"), "utf8")).toContain("não é do Nirvana");
  expect(out).toMatch(/backups[\\/]runtime-skills/);   // backslashes on Windows
  expect(fs.readdirSync(path.join(home, ".claude", "skills")).filter((e) => /\.bak$/i.test(e))).toEqual([]);

  // pi is wired too — the list the uninstaller used to be missing.
  expect(isOurs(path.join(home, ".pi", "agent", "skills", "nirvana"))).toBe(true);
  for (const s of RUNTIME_ENTRIES) {
    expect(isOurs(path.join(home, ".claude", "skills", s))).toBe(true);
    expect(isOurs(path.join(home, ".gemini", "skills", s))).toBe(true);
    // Codex always gets a COPY, marker included.
    const codex = path.join(home, ".codex", "skills", s);
    expect(isLink(codex)).toBe(false);
    expect(fs.existsSync(path.join(codex, COPY_MARKER))).toBe(true);
  }
  // The engine-internal trees are in the canonical tree and in NO runtime dir.
  for (const s of ENGINE_INTERNAL_SKILLS) {
    expect(fs.existsSync(path.join(home, ".nirvana", "skills", s))).toBe(true);
    for (const rt of RUNTIME_PARENTS) expect(exists(path.join(home, rt, "skills", s)), `${rt}/${s}`).toBe(false);
  }
});

test("an engine up to 0.13.9 linked the internal trees beside the door: the next install unlinks OUR entries, keeps foreign ones", () => {
  const home = freshHome("home-unlink-internals", [".claude", ".gemini"]);
  const tree = path.join(home, ".nirvana", "skills");
  fs.mkdirSync(tree, { recursive: true });
  for (const s of ENGINE_INTERNAL_SKILLS) {
    fs.mkdirSync(path.join(tree, s), { recursive: true });
    plantOurs(path.join(home, ".claude", "skills", s), path.join(tree, s));
  }
  const foreign = path.join(home, ".gemini", "skills", "harness");   // someone else's harness
  fs.mkdirSync(foreign, { recursive: true });
  fs.writeFileSync(path.join(foreign, "KEEP.txt"), "not ours");

  const { code, out } = install(home);
  expect(code).toBe(0);
  for (const s of ENGINE_INTERNAL_SKILLS) expect(exists(path.join(home, ".claude", "skills", s)), s).toBe(false);
  expect(out).toContain("unlinked (engine-internal");
  expect(fs.readFileSync(path.join(foreign, "KEEP.txt"), "utf8")).toBe("not ours");
  expect(isOurs(path.join(home, ".claude", "skills", "nirvana"))).toBe(true);
});

test("re-install is idempotent: no second backup, nothing deleted", () => {
  const home = path.join(root, "home-lifecycle");
  const thirdParty = path.join(home, ".claude", "skills", "nirvana");

  expect(install(home).code).toBe(0);

  const parked = parkedBackupPath(thirdParty, home);
  expect(fs.readFileSync(path.join(parked, "THIRD-PARTY.txt"), "utf8")).toContain("não é do Nirvana");
  expect(fs.readdirSync(path.dirname(parked))).toEqual(["nirvana"]);   // one backup, never a numbered chain
  expect(isOurs(thirdParty)).toBe(true);
  expect(fs.existsSync(path.join(home, ".codex", "skills", "nirvana", COPY_MARKER))).toBe(true);
});

test("a NEW third-party dir over an existing backup is skipped, never deleted", () => {
  const home = path.join(root, "home-lifecycle");
  const target = path.join(home, ".claude", "skills", "nirvana");
  // Our link goes away, the user drops a directory with the same name back in,
  // and the .pre-nirvana.bak from the first install is still there.
  // `recursive` because on Windows our entry is a directory, not a link, and
  // rmSync refuses a directory without it.
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, "SECOND.txt"), "conteúdo do usuário");

  const { code, out } = install(home);
  expect(code).toBe(0);

  // Preserved in place, and the user was told.
  expect(fs.readFileSync(path.join(target, "SECOND.txt"), "utf8")).toBe("conteúdo do usuário");
  expect(isOurs(target)).toBe(false);
  expect(out).toContain("skipped this skill");
  // A directory named like the door with no `name: nirvana` inside is not a
  // provider of it: the foreign-provider rule is about the same skill, not the same name.
  // The original backup is untouched too.
  expect(fs.readFileSync(path.join(parkedBackupPath(target, home), "THIRD-PARTY.txt"), "utf8")).toContain("não é do Nirvana");
  // Every other runtime still got the door normally.
  expect(isOurs(path.join(home, ".gemini", "skills", "nirvana"))).toBe(true);
});

test("uninstall removes our links AND our copies, cleans dangling links, keeps what is not ours", () => {
  const home = path.join(root, "home-lifecycle");
  const nirvanaSkills = path.join(home, ".nirvana", "skills");

  // (d) a dangling link: the target is deleted while the link remains. Only
  // reachable where entries ARE links — on Windows the installer copies
  // (install.ts:320), so removing the engine tree leaves a full directory, not a
  // broken link. Same for the foreign symlink below: creating a directory
  // symlink on Windows needs admin, which CI does not have.
  const dangling = path.join(home, ".gemini", "skills", "nirvana");
  const foreignTarget = path.join(home, "elsewhere");
  const foreignLink = path.join(home, ".antigravity", "skills", "nirvana");
  if (!IS_WINDOWS) {
    fs.rmSync(path.join(nirvanaSkills, "nirvana"), { recursive: true, force: true });
    expect(isLink(dangling)).toBe(true);
    expect(fs.existsSync(dangling)).toBe(false); // broken — existsSync() cannot see it

    fs.mkdirSync(foreignTarget, { recursive: true });
    fs.rmSync(foreignLink, { force: true });
    fs.symlinkSync(foreignTarget, foreignLink);
  }

  const { code, out } = uninstall(home);
  expect(code).toBe(0);

  // (a) symlinks gone, (b) copies gone, (d) dangling link gone.
  if (!IS_WINDOWS) expect(exists(dangling)).toBe(false);
  for (const s of SKILLS) {
    expect(exists(path.join(home, ".codex", "skills", s))).toBe(false);
    expect(exists(path.join(home, ".pi", "agent", "skills", s))).toBe(false);
  }
  expect(exists(path.join(home, ".gemini", "skills", "nirvana"))).toBe(false);

  // (c) the third-party directory and its backup survived untouched.
  const claudeDoor = path.join(home, ".claude", "skills", "nirvana");
  expect(fs.readFileSync(path.join(claudeDoor, "SECOND.txt"), "utf8")).toBe("conteúdo do usuário");
  expect(fs.existsSync(path.join(parkedBackupPath(claudeDoor, home), "THIRD-PARTY.txt"))).toBe(true);
  expect(out).toContain("not ours");

  // The foreign symlink is not ours either.
  if (!IS_WINDOWS) {
    expect(isLink(foreignLink)).toBe(true);
    expect(fs.readlinkSync(foreignLink)).toBe(foreignTarget);
  }

  // Engine tree gone.
  expect(fs.existsSync(nirvanaSkills)).toBe(false);
});

test("backups are restored when the entry removed WAS ours", () => {
  const home = freshHome("home-restore", [".gemini"]);
  const target = path.join(home, ".gemini", "skills", "nirvana");
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, "MINE.txt"), "diretório do usuário");

  expect(install(home).code).toBe(0);
  expect(isOurs(target)).toBe(true);           // ours now, user's dir parked in .bak

  expect(uninstall(home).code).toBe(0);
  expect(isLink(target)).toBe(false);
  expect(fs.readFileSync(path.join(target, "MINE.txt"), "utf8")).toBe("diretório do usuário");
  expect(exists(parkedBackupPath(target, home))).toBe(false);
});

test("a legacy .pre-nirvana.bak beside the entry (installs up to 0.13.9) is still restored", () => {
  const home = freshHome("home-restore-legacy", [".gemini"]);
  const target = path.join(home, ".gemini", "skills", "nirvana");
  expect(install(home).code).toBe(0);
  fs.mkdirSync(`${target}.pre-nirvana.bak`, { recursive: true });
  fs.writeFileSync(path.join(`${target}.pre-nirvana.bak`, "OLD.txt"), "parked by an older install");

  expect(uninstall(home).code).toBe(0);
  expect(fs.readFileSync(path.join(target, "OLD.txt"), "utf8")).toBe("parked by an older install");
  expect(exists(`${target}.pre-nirvana.bak`)).toBe(false);
});

test("content roots follow NIRVANA_HOME / SQUADS_DIR / BUSINESSES_DIR / DNA_LIBRARY, like the pack overlay", () => {
  const home = freshHome("home-content-roots", [".gemini"]);
  const elsewhere = path.join(home, "elsewhere");
  const { code } = install(home, [], {
    SQUADS_DIR: path.join(elsewhere, "my-squads"),
    BUSINESSES_DIR: path.join(elsewhere, "my-businesses"),
    DNA_LIBRARY: path.join(elsewhere, "my-dna"),
  });
  expect(code).toBe(0);
  for (const d of ["my-squads", "my-businesses", "my-dna"]) expect(fs.existsSync(path.join(elsewhere, d))).toBe(true);
  expect(fs.existsSync(path.join(home, "squads"))).toBe(false);
  expect(fs.existsSync(path.join(home, "businesses"))).toBe(false);

  const home2 = freshHome("home-content-roots-nh", [".gemini"]);
  expect(install(home2, [], { NIRVANA_HOME: path.join(home2, "nh") }).code).toBe(0);
  expect(fs.existsSync(path.join(home2, "nh", "businesses", "_library", "dna"))).toBe(true);
  expect(fs.existsSync(path.join(home2, "businesses"))).toBe(false);
});

test("copy-mode install is removed by uninstall (the Windows / Codex path)", () => {
  const home = freshHome("home-copy", [".gemini", ".antigravity"]);
  expect(install(home, ["--copy-skills"]).code).toBe(0);

  for (const s of RUNTIME_ENTRIES) {
    const p = path.join(home, ".gemini", "skills", s);
    expect(isLink(p)).toBe(false);
    expect(fs.existsSync(path.join(p, COPY_MARKER))).toBe(true);
  }

  expect(uninstall(home).code).toBe(0);
  for (const s of SKILLS) {
    expect(exists(path.join(home, ".gemini", "skills", s))).toBe(false);
    expect(exists(path.join(home, ".antigravity", "skills", s))).toBe(false);
  }
});

test("no runtime is a prerequisite: a HOME without ~/.claude never gets one", () => {
  const home = freshHome("home-no-claude", [".gemini"]);

  // No agent binary on PATH: the only install signal in this HOME is the
  // ~/.gemini dir. Without pinning PATH the assertion below reads the
  // developer's machine instead of the fixture.
  const { code, out } = install(home, [], { PATH: BARE_PATH, Path: BARE_PATH });
  expect(code).toBe(0);

  expect(exists(path.join(home, ".claude"))).toBe(false);
  expect(exists(path.join(home, ".codex"))).toBe(false);
  expect(exists(path.join(home, ".pi"))).toBe(false);

  // The canonical tree is still complete, and the installed runtime got the door.
  for (const s of SKILLS) expect(fs.existsSync(path.join(home, ".nirvana", "skills", s, "SKILL.md"))).toBe(true);
  for (const s of RUNTIME_ENTRIES) expect(isOurs(path.join(home, ".gemini", "skills", s))).toBe(true);
  expect(out).toContain(path.join(home, ".gemini", "skills"));
});

test("install and uninstall share ONE runtime-dir list", async () => {
  const mod = await import("../lib/runtime-dirs.ts");
  const installSrc = fs.readFileSync(path.join(REPO, "scripts", "install.ts"), "utf8");
  const uninstallSrc = fs.readFileSync(path.join(REPO, "skills", "_shared", "scripts", "uninstall-engine.ts"), "utf8");

  // Both import the shared module, and neither redeclares the constants.
  for (const src of [installSrc, uninstallSrc]) {
    expect(src).toMatch(/runtime-dirs\.ts/);
    expect(src).not.toMatch(/^const RUNTIME_SKILL_DIRS\s*=/m);
    expect(src).not.toMatch(/^const SKILLS\s*=/m);
    expect(src).not.toMatch(/^const COPY_MARKER\s*=/m);
  }
  expect(mod.RUNTIME_SKILL_DIRS).toHaveLength(6);
  expect(mod.RUNTIME_SKILL_DIRS.some((d: string) => d.includes(path.join(".pi", "agent")))).toBe(true);
  // OpenClaw. Added with the adapter and missed here, which is how the count
  // drifted: assert the dir, not just the length, so the next runtime says why.
  expect(mod.RUNTIME_SKILL_DIRS.some((d: string) => d.includes(path.join(".agents", "skills")))).toBe(true);
  expect(mod.SKILLS).toEqual(SKILLS);
  expect(mod.COPY_MARKER).toBe(COPY_MARKER);
});

// ── Retirement of a name the engine stopped shipping ─────────────────────────
//
// 0.13.9 shipped the entry skill as `nirvana-os`; 0.14 ships it as `nirvana`.
// Neither the installer nor the uninstaller iterated anything but the current
// list, so on every existing machine the old tree and its link in six runtime
// dirs would have survived every future install. RETIRED_SKILLS names it.

/** Our entry for a retired name, however this platform materialises it. */
function plantOurs(entry: string, target: string): void {
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  if (IS_WINDOWS) { fs.mkdirSync(entry); fs.writeFileSync(path.join(entry, COPY_MARKER), "copy"); }
  else fs.symlinkSync(target, entry);
}

test("a retired name is removed from ~/.nirvana and from every runtime dir; a foreign dir sharing it is kept", () => {
  const home = freshHome("home-retire");
  const oldTree = path.join(home, ".nirvana", "skills", "nirvana-os");
  fs.mkdirSync(oldTree, { recursive: true });
  fs.writeFileSync(path.join(oldTree, "SKILL.md"), "---\nname: nirvana-os\n---\nold\n");
  const ours = [".claude", ".codex", ".antigravity", path.join(".pi", "agent")]
    .map((rt) => path.join(home, rt, "skills", "nirvana-os"));
  for (const p of ours) plantOurs(p, oldTree);
  const foreign = path.join(home, ".gemini", "skills", "nirvana-os");
  fs.mkdirSync(foreign, { recursive: true });
  fs.writeFileSync(path.join(foreign, "FOREIGN.txt"), "not ours");

  const { code, out } = install(home);
  expect(code).toBe(0);

  expect(exists(oldTree)).toBe(false);
  for (const p of ours) expect(exists(p)).toBe(false);
  expect(fs.readFileSync(path.join(foreign, "FOREIGN.txt"), "utf8")).toBe("not ours");
  expect(out).toContain("is not Nirvana's");
  // The current name is wired everywhere the old one was.
  for (const rt of [".claude", ".gemini", ".antigravity"]) expect(isOurs(path.join(home, rt, "skills", "nirvana"))).toBe(true);
  expect(fs.existsSync(path.join(home, ".codex", "skills", "nirvana", COPY_MARKER))).toBe(true);
});

test("retiring our entry restores the pre-Nirvana backup parked beside it, leaving no .bak", () => {
  const home = freshHome("home-retire-restore", [".gemini"]);
  const oldTree = path.join(home, ".nirvana", "skills", "nirvana-os");
  fs.mkdirSync(oldTree, { recursive: true });
  const entry = path.join(home, ".gemini", "skills", "nirvana-os");
  plantOurs(entry, oldTree);
  fs.mkdirSync(`${entry}.pre-nirvana.bak`, { recursive: true });   // legacy location, installs up to 0.13.9
  fs.writeFileSync(path.join(`${entry}.pre-nirvana.bak`, "MINE.txt"), "the user's directory");

  expect(install(home).code).toBe(0);

  expect(fs.readFileSync(path.join(entry, "MINE.txt"), "utf8")).toBe("the user's directory");
  expect(exists(`${entry}.pre-nirvana.bak`)).toBe(false);
  expect(fs.readdirSync(path.join(home, ".gemini", "skills")).filter((e) => /\.bak$/i.test(e))).toEqual([]);
});

// ── Coexistence with the same skill installed by skills.sh ───────────────────
//
// `npx skills add gutomec/nirvana-os-engine -g` puts the canonical copy of
// `nirvana` in ~/.agents/skills and RELATIVE symlinks to it in the other agent
// dirs. The installer used to park any foreign entry as <name>.pre-nirvana.bak
// — dangling every one of those links and leaving a .bak the doctor advises
// deleting. Same skill, same name: it stays, and the log says who provides it.

test("the same skill installed by skills.sh is kept, not parked as a backup", () => {
  const home = freshHome("home-coexist", [".claude", ".gemini"]);
  const canonical = path.join(home, ".agents", "skills", "nirvana");
  fs.mkdirSync(canonical, { recursive: true });
  fs.writeFileSync(path.join(canonical, "SKILL.md"), "---\nname: nirvana\n---\nfrom skills.sh\n");
  fs.writeFileSync(path.join(canonical, "SKILLS_SH.txt"), "installed by npx skills add");
  const claudeLink = path.join(home, ".claude", "skills", "nirvana");
  fs.mkdirSync(path.dirname(claudeLink), { recursive: true });
  if (!IS_WINDOWS) fs.symlinkSync(path.join("..", "..", ".agents", "skills", "nirvana"), claudeLink);

  const { code, out } = install(home);
  expect(code).toBe(0);

  expect(fs.readFileSync(path.join(canonical, "SKILLS_SH.txt"), "utf8")).toBe("installed by npx skills add");
  expect(exists(`${canonical}.pre-nirvana.bak`)).toBe(false);
  if (!IS_WINDOWS) {
    expect(isLink(claudeLink)).toBe(true);
    expect(fs.readFileSync(path.join(claudeLink, "SKILLS_SH.txt"), "utf8")).toBe("installed by npx skills add");
    expect(exists(`${claudeLink}.pre-nirvana.bak`)).toBe(false);
  }
  expect(out).toContain("provided by another installer");
  // A dir with no foreign entry gets our door; the internal trees are linked nowhere.
  expect(isOurs(path.join(home, ".gemini", "skills", "nirvana"))).toBe(true);
  expect(exists(path.join(home, ".claude", "skills", "harness"))).toBe(false);
});

test("a foreign dir named nirvana whose SKILL.md declares another name is still parked", () => {
  const home = freshHome("home-coexist-other", [".gemini"]);
  const foreign = path.join(home, ".gemini", "skills", "nirvana");
  fs.mkdirSync(foreign, { recursive: true });
  fs.writeFileSync(path.join(foreign, "SKILL.md"), "---\nname: something-else\n---\n");

  expect(install(home).code).toBe(0);

  expect(fs.existsSync(path.join(parkedBackupPath(foreign, home), "SKILL.md"))).toBe(true);
  expect(exists(`${foreign}.pre-nirvana.bak`)).toBe(false);
  expect(isOurs(foreign)).toBe(true);
});

test("uninstall leaves the skills.sh copy and its links alone", () => {
  const home = path.join(root, "home-coexist");
  const canonical = path.join(home, ".agents", "skills", "nirvana");
  const claudeLink = path.join(home, ".claude", "skills", "nirvana");

  const { code, out } = uninstall(home);
  expect(code).toBe(0);

  expect(fs.readFileSync(path.join(canonical, "SKILLS_SH.txt"), "utf8")).toBe("installed by npx skills add");
  if (!IS_WINDOWS) expect(isLink(claudeLink)).toBe(true);
  expect(out).toContain("provided by another installer");
  expect(exists(path.join(home, ".gemini", "skills", "nirvana"))).toBe(false);
});
