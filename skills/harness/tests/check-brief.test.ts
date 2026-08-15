/**
 * The preflight that reads a dispatch brief before an agent does.
 *
 * Two briefs went out this session naming things that could not be found — a
 * script that lived on another branch, a squad directory under a name it never
 * had. Both agents improvised and recovered, but improvising against a wrong
 * target is the failure mode that reports success. At 195 dispatches it stops
 * being an annoyance.
 *
 * What is pinned here is mostly the SILENCE. A checker that flags a path the
 * brief asks the agent to create, or a slug that is really a filename, gets
 * switched off within a day — so the false-positive cases carry as much weight
 * as the true ones.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..", "..", "..");
const CHECK = join(REPO, "scripts", "check-brief.ts");

const tmp = mkdtempSync(join(tmpdir(), "brief-"));

/**
 * The slug list is injected rather than read from the machine's library, and
 * the "real path" cases point at files this suite creates. CI has no `~/squads`
 * and no registry, so a suite that leaned on either would assert nothing there
 * while passing on the author's laptop — the shadow-suite failure this project
 * has already been bitten by.
 */
const SLUGS = join(tmp, "slugs.json");
writeFileSync(SLUGS, JSON.stringify(["brandcraft", "design-system-nirvana"]), "utf8");

/** A real file on disk for the path cases to resolve against. */
const REAL_DIR = join(tmp, "squads", "brandcraft");
mkdirSync(REAL_DIR, { recursive: true });
const REAL_FILE = join(REAL_DIR, "squad.yaml");
writeFileSync(REAL_FILE, "name: brandcraft\n", "utf8");

function run(body: string, args: string[] = []) {
  const f = join(tmp, `b${Math.abs(hash(body))}.md`);
  writeFileSync(f, body, "utf8");
  const r = spawnSync(process.execPath, [CHECK, f, "--slugs", SLUGS, ...args], { cwd: REPO, encoding: "utf8" });
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}
// Deterministic name per body: Math.random() would leave the tmpdir unreadable
// when a case fails and you want to look at the fixture.
function hash(s: string) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return h; }

describe("it catches what a stale brief gets wrong", () => {
  test("a path that does not exist", () => {
    const r = run("Edit ~/nirvana-packs/genesis-content/squads/no-such-squad-here/squad.yaml");
    expect(r.out).toContain("does not exist");
    expect(r.out).toContain("no-such-squad-here");
  });

  test("a script on a branch this checkout does not have", () => {
    const r = run("Run `bun scripts/coverage-ratchet-that-moved.ts --check` first.");
    expect(r.out).toMatch(/no such script/);
  });

  test("a slug that is not in the registry", () => {
    // The real shape of this error: a plausible name for a squad that exists
    // under a different one.
    const r = run("Neighbour: `design-system-nirvana-pro`.");
    expect(r.out).toContain("not in the registry");
  });

  test("--strict is what a dispatch step would gate on", () => {
    const body = "Edit ~/definitely/not/a/real/path/squad.yaml";
    expect(run(body).code).toBe(0);
    expect(run(body, ["--strict"]).code).toBe(1);
  });
});

describe("it stays quiet when the brief is right", () => {
  test("real path, real script, real slug", () => {
    const r = run([
      `Target: the \`design-system-nirvana\` squad at ${REAL_FILE}`,
      "Run `bun scripts/check-not-for-fires.ts brandcraft` before and after.",
    ].join("\n"), ["--strict"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("resolves");
    expect(r.out).toMatch(/checked 1 paths · 1 scripts · 1 slugs/);
  });

  test("a Windows path is seen, on any platform", () => {
    // The suite creates its fixtures under tmpdir, which on Windows is a
    // `C:\...` path. A checker that only knows POSIX reported "0 paths checked"
    // there and passed — inspecting nothing while looking green.
    const r = run("Edit C:\\Users\\someone\\nirvana-packs\\squads\\ghost\\squad.yaml", ["--strict"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("does not exist");
    expect(r.out).toMatch(/checked 1 paths/);
  });

  test("a single-word name is not judged as a slug", () => {
    // 13 of the 255 entities are one word, and three of those words are
    // `documentation`, `testing` and `monitoring`. Judging bare words would
    // fire on ordinary prose far more often than it would catch a real typo.
    const r = run("Read `testing` notes and the `monitoring` section.", ["--strict"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/· 0 slugs/);
  });

  test("a path the agent is told to CREATE is not an error", () => {
    // Briefs name their own outputs. Flagging those would make the checker
    // useless for exactly the briefs that produce something.
    const r = run("Write the report to ~/nirvana-os/.nirvana/outputs/run-01/report.md (new)", ["--strict"]);
    expect(r.code).toBe(0);
  });

  test("filenames in backticks are not judged as slugs", () => {
    const r = run("Read `router.js` and `squad.yaml`, then `build-all-packs.sh`.", ["--strict"]);
    expect(r.code).toBe(0);
  });

  test("a relative path is left alone rather than guessed at", () => {
    // Without a stated cwd, `skills/harness/lib` could resolve against the repo,
    // the pack, or the installed library. Guessing produces false alarms.
    const r = run("Look under skills/harness/lib and packaging/pack.", ["--strict"]);
    expect(r.code).toBe(0);
  });
});

describe("the checker reports what it inspected", () => {
  test("it prints counts, so an empty check is visibly empty", () => {
    // A preflight that silently checks nothing reads exactly like a passing one.
    const r = run(`Target: the \`design-system-nirvana\` squad at ${REAL_FILE}`);
    expect(r.out).toMatch(/checked 1 paths · 0 scripts · 1 slugs/);
  });
});

process.on("exit", () => { try { rmSync(tmp, { recursive: true, force: true }); } catch {} });
