// verify-install-hooks.test.ts — the gate wired into the paths a buyer walks.
//
// verify-hooks.test.ts proves the decision module; this file proves the
// WIRING, through the real CLIs, with the flags coming from the environment
// exactly as a buyer's `nrv config` would set them:
//
//   nrv install <dir>               → installer.ts, on the staged copy
//   install-content.ts <pack>       → per entity, before the first mirror
//   nrv activate <slug>             → before the first dependency is installed
//
// The rule the whole cut answers to: with the shipped defaults every one of
// them proceeds. Only the flag turns a report into a refusal, and
// --skip-validate / --skip-verify always walk past it.
//
// Runs with: bun test skills/harness/tests
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..", "..", "..");
const INSTALL = join(REPO, "skills", "_shared", "scripts", "install-asset.ts");
const INSTALL_CONTENT = join(REPO, "skills", "_shared", "scripts", "install-content.ts");
const ACTIVATE = join(REPO, "skills", "harness", "scripts", "activate.ts");

const ROOTS: string[] = [];
afterAll(() => { for (const r of ROOTS) try { rmSync(r, { recursive: true, force: true }); } catch { /* best effort */ } });

function home(): string {
  const root = mkdtempSync(join(tmpdir(), "nrv-install-gate-"));
  ROOTS.push(root);
  for (const d of ["squads", "businesses", "source", "state", "logs"]) mkdirSync(join(root, d), { recursive: true });
  return root;
}

/**
 * A home the child actually believes in, on every platform.
 *
 * `installer.ts` resolves its roots lazily from `NIRVANA_HOME` / `SQUADS_DIR`,
 * so redirecting those is enough for it. `install-content.ts` does not: it
 * reads `os.homedir()` once, at module scope, and joins `squads`,
 * `businesses` and `.nirvana/packs` onto it. `os.homedir()` follows `$HOME` on
 * macOS and Linux and `%USERPROFILE%` on Windows — so a test that sets only
 * `HOME` redirects the overlay on two platforms out of three and silently
 * writes into the real profile on the third. That is what turned this file red
 * on the Windows runner and nowhere else.
 */
function homeEnv(root: string): Record<string, string> {
  const drive = /^([A-Za-z]:)(.*)$/.exec(root);
  return {
    HOME: root,
    USERPROFILE: root,
    // uv_os_homedir falls back to HOMEDRIVE + HOMEPATH when USERPROFILE is
    // absent; keeping them consistent means no third answer exists.
    ...(drive ? { HOMEDRIVE: drive[1], HOMEPATH: drive[2] || "\\" } : {}),
  };
}

function env(root: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...process.env,
    ...homeEnv(root),
    NIRVANA_HOME: root,
    NIRVANA_STATE_DIR: join(root, "state"),
    HARNESS_LOGS_DIR: join(root, "logs"),
    SQUADS_DIR: join(root, "squads"),
    BUSINESSES_DIR: join(root, "businesses"),
    DNA_LIBRARY: join(root, "businesses", "_library", "dna"),
    NIRVANA_SKILLS_DIR: join(REPO, "skills"),
    CLAUDE_SKILLS_DIR: join(REPO, "skills"),
    NIRVANA_SCOPE: "global",
    NIRVANA_SCOPE_QUIET: "1",
    NIRVANA_NO_UPDATE_CHECK: "1",
    ...extra,
  } as Record<string, string>;
}

function run(script: string, args: string[], root: string, extra: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [script, ...args], { cwd: root, env: env(root, extra), encoding: "utf8" });
  return { code: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/**
 * A squad with a real manifest and NO `.nirvana-surface.json` — the HARD error
 * a buyer's own hand-made squad carries most often, and the one the gate would
 * have blocked on day one if it blocked by default.
 */
function brokenSquad(dir: string, slug: string): string {
  mkdirSync(join(dir, "agents"), { recursive: true });
  mkdirSync(join(dir, "workflows"), { recursive: true });
  writeFileSync(join(dir, "squad.yaml"), [
    `name: ${slug}`,
    "version: 1.0.0",
    'protocol: "5.0"',
    "description: A squad a buyer wrote by hand, complete except for what the engine owns",
    "",
  ].join("\n"), "utf8");
  writeFileSync(join(dir, "agents", "solo.md"), "---\nname: solo\nmaxTurns: 8\ntools: [Read]\n---\n\n# solo\n", "utf8");
  return dir;
}

const ENFORCE = { NIRVANA_VERIFY_ENFORCE_ON_INSTALL: "1" };

describe("nrv install", () => {
  test("the flag off: the gate reports and the squad installs", () => {
    const root = home();
    const src = brokenSquad(join(root, "source", "handmade"), "handmade");
    const r = run(INSTALL, [src, "--type=squad", "--skip-reindex"], root);
    expect(r.out).toContain("surface_missing");
    expect(r.out).toContain("proceeding anyway");
    expect(r.code).toBe(0);
    expect(existsSync(join(root, "squads", "handmade", "squad.yaml"))).toBe(true);
  }, 30_000);

  test("the flag on: the same squad is refused and nothing lands", () => {
    const root = home();
    const src = brokenSquad(join(root, "source", "handmade"), "handmade");
    const r = run(INSTALL, [src, "--type=squad", "--skip-reindex"], root, ENFORCE);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("refused by the admission gate");
    expect(existsSync(join(root, "squads", "handmade"))).toBe(false);
  }, 30_000);

  test("--skip-validate escapes the refusal", () => {
    const root = home();
    const src = brokenSquad(join(root, "source", "handmade"), "handmade");
    const r = run(INSTALL, [src, "--type=squad", "--skip-reindex", "--skip-validate"], root, ENFORCE);
    expect(r.code).toBe(0);
    expect(existsSync(join(root, "squads", "handmade", "squad.yaml"))).toBe(true);
  }, 30_000);
});

describe("install-content (the paid overlay)", () => {
  // One pack slug per case. The overlay records what it installed in
  // `<home>/.nirvana/packs/<slug>.json` and then only checks what is ENTERING
  // — a slug already installed at the same hash is not re-judged, by design.
  // Sharing one slug across the three cases means that as soon as the home is
  // not isolated, case 2 finds case 1's manifest, has nothing entering, and
  // passes the gate by never reaching it. Distinct slugs make that impossible
  // to happen quietly.
  function pack(root: string, slug: string): string {
    const content = join(root, "source", slug);
    brokenSquad(join(content, "squads", slug), slug);
    return content;
  }

  /** The overlay must have written inside this root, never into a real home. */
  function landedIn(root: string, slug: string): boolean {
    return existsSync(join(root, "squads", slug, "squad.yaml"));
  }

  test("the flag off: it warns per entity and mirrors the pack", () => {
    const root = home();
    const r = run(INSTALL_CONTENT, [pack(root, "packed-a"), "--slug", "pack-a"], root);
    expect(r.out).toContain("surface_missing");
    expect(r.out).toContain("proceeding anyway");
    expect(r.code).toBe(0);
    expect(landedIn(root, "packed-a")).toBe(true);
    // The overlay resolves its roots from os.homedir(), so this asserts the
    // redirection itself: without it the mirror lands in the real profile and
    // every other assertion here becomes meaningless.
    expect(existsSync(join(root, ".nirvana", "packs", "pack-a.json"))).toBe(true);
  }, 30_000);

  test("the flag on: nothing is mirrored, and the refusal names the component", () => {
    const root = home();
    const r = run(INSTALL_CONTENT, [pack(root, "packed-b"), "--slug", "pack-b"], root, ENFORCE);
    expect(r.code).toBe(1);
    expect(r.out).toContain("squads/packed-b");
    expect(r.out).toContain("Nothing was installed");
    expect(existsSync(join(root, "squads", "packed-b"))).toBe(false);
    // A refusal happens before the manifest is written: nothing was recorded.
    expect(existsSync(join(root, ".nirvana", "packs", "pack-b.json"))).toBe(false);
  }, 30_000);

  test("--skip-validate escapes, and the pack installs whole", () => {
    const root = home();
    const r = run(INSTALL_CONTENT, [pack(root, "packed-c"), "--slug", "pack-c", "--skip-validate"], root, ENFORCE);
    expect(r.code).toBe(0);
    expect(landedIn(root, "packed-c")).toBe(true);
  }, 30_000);

  test("a slug already installed at the same hash is not re-judged", () => {
    // The other half of the contract the shared-slug bug was hiding: the gate
    // is about what ENTERS, so a second identical overlay of the same pack has
    // nothing entering and passes even with the flag on. Asserted on purpose,
    // in one place, instead of leaking into the three cases above.
    const root = home();
    const content = pack(root, "packed-d");
    expect(run(INSTALL_CONTENT, [content, "--slug", "pack-d", "--skip-validate"], root, ENFORCE).code).toBe(0);
    const second = run(INSTALL_CONTENT, [content, "--slug", "pack-d"], root, ENFORCE);
    expect(second.code).toBe(0);
    expect(second.out).not.toContain("surface_missing");
    expect(second.out).toContain("0 new");
  }, 30_000);
});

describe("nrv activate", () => {
  test("the flag off activates; the flag on refuses before touching dependencies", () => {
    const root = home();
    brokenSquad(join(root, "squads", "handmade"), "handmade");
    // No dependencies.yaml: the activator has nothing to install, so the exit
    // code carries the gate's answer and nothing else.
    const off = run(ACTIVATE, ["handmade", "--dry-run"], root);
    expect(off.out).toContain("surface_missing");
    expect(off.out).not.toContain("refused");

    const on = run(ACTIVATE, ["handmade", "--dry-run"], root, { NIRVANA_VERIFY_ENFORCE_ON_ACTIVATE: "1" });
    expect(on.code).toBe(1);
    expect(on.out).toContain("refused");

    const skipped = run(ACTIVATE, ["handmade", "--dry-run", "--skip-verify"], root, { NIRVANA_VERIFY_ENFORCE_ON_ACTIVATE: "1" });
    expect(skipped.out).toContain("skipped by --skip-verify");
    expect(skipped.out).not.toContain("refused");
  }, 30_000);

  test("the install flag does not activate, and the activate flag does not install", () => {
    const root = home();
    const src = brokenSquad(join(root, "source", "handmade"), "handmade");
    const install = run(INSTALL, [src, "--type=squad", "--skip-reindex"], root, { NIRVANA_VERIFY_ENFORCE_ON_ACTIVATE: "1" });
    expect(install.code).toBe(0);
    const activate = run(ACTIVATE, ["handmade", "--dry-run"], root, ENFORCE);
    expect(activate.out).not.toContain("refused");
  }, 30_000);
});
