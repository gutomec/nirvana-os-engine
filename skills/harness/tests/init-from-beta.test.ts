// init-from-beta.test.ts — going back from the 0.15 beta to this line.
//
// 0.14.11's `nrv init` did not know the blocks the 0.15 line writes (the
// on-demand note v3, the invocation contract v4, and the invocation contract v3
// of 0.15.0-beta.1 to beta.5, which shares this line's v3 marker). Re-run on a
// project the beta had initialised, it appended this line's contract beside
// them: an "always" contract next to the beta's "on demand" note, or two
// on-demand notes. Now each 0.15 block is replaced in place by this line's
// block for the chosen mode, and the user's lines around it stay.
//
// The fixtures are CLAUDE.md files written by the real 0.15.0-beta.7
// `nrv init`, in both modes, over a CLAUDE.md with the user's own line, plus a
// line the user added after init. beta5-always is beta.5's template appended
// the way init appends it to an existing file.
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..", "..", "..");
const INIT = path.join(ROOT, "skills/_shared/scripts/init-project.ts");
const FIXTURES = path.join(import.meta.dir, "fixtures", "beta-init");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-init-from-beta-"));
const INIT_TIMEOUT_MS = 60_000;

afterAll(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ } });

function project(name: string, fixture: string): string {
  const dir = path.join(TMP, name);
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  fs.copyFileSync(path.join(FIXTURES, `${fixture}.CLAUDE.md`), path.join(dir, "CLAUDE.md"));
  return dir;
}

function init(dir: string, mode: "always" | "on-demand"): string {
  const r = spawnSync(process.execPath, [INIT, ".", `--orchestrators=${mode}`], {
    cwd: dir, encoding: "utf8",
    env: { ...process.env, HOME: dir, USERPROFILE: dir, NIRVANA_SKILLS_DIR: path.join(ROOT, "skills") },
  });
  expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
  return fs.readFileSync(path.join(dir, "CLAUDE.md"), "utf8");
}

const markers = (text: string) => text.match(/<!-- nirvana-os:[a-z-]+:v\d+ -->/g) ?? [];
const count = (text: string, needle: string) => text.split(needle).length - 1;

/** Exactly one Nirvana block for the mode (plus the writing contract in
 *  "always"), and the user's lines where they were. */
function expectClean(text: string, mode: "always" | "on-demand") {
  const expected = mode === "always"
    ? ["<!-- nirvana-os:invocation-contract:v3 -->", "<!-- nirvana-os:writing-contract:v2 -->"]
    : ["<!-- nirvana-os:on-demand-contract:v2 -->"];
  if (mode === "on-demand" && text.includes("<!-- nirvana-os:writing-contract:v2 -->")) expected.push("<!-- nirvana-os:writing-contract:v2 -->");
  expect(markers(text).sort()).toEqual(expected.sort());
  expect(count(text, "# Project guidelines")).toBe(mode === "always" ? 1 : 0);
  expect(count(text, "## Nirvana-OS")).toBe(mode === "always" ? 0 : 1);
  expect(text.startsWith("# My project\n\nMY RULE ABOVE: keep this line.\n")).toBe(true);
  expect(count(text, "MY RULE BELOW: keep this line too.")).toBe(1);
  // Nothing of the beta's text is left behind.
  expect(text).not.toContain("# Project guidelines (any agent runtime)");
  expect(text).not.toContain("Nirvana-OS: installed, out of the way");
}

describe("a CLAUDE.md written by beta.7's init, re-initialised by 0.14.12", () => {
  for (const source of ["beta7-always", "beta7-on-demand", "beta5-always"]) {
    for (const mode of ["always", "on-demand"] as const) {
      test(`${source} → ${mode}: one Nirvana block, the user's lines intact`, () => {
        const dir = project(`${source}-${mode}`, source);
        const text = init(dir, mode);
        expectClean(text, mode);
        // Idempotent: a second run changes nothing.
        expect(init(dir, mode)).toBe(text);
      }, INIT_TIMEOUT_MS);
    }
  }
});

describe("a file 0.14.11 already doubled", () => {
  test("beta.7 always + 0.14.11's appended contract: the beta's block goes", () => {
    const dir = project("doubled-always", "beta7-always");
    const file = path.join(dir, "CLAUDE.md");
    fs.appendFileSync(file, fs.readFileSync(path.join(ROOT, "skills/_shared/templates/AGENTS.md"), "utf8"));
    expectClean(init(dir, "always").replace(/\n+$/, "\n"), "always");
  }, INIT_TIMEOUT_MS);

  test("beta.7 on-demand + 0.14.11's on-demand note: one note", () => {
    const dir = project("doubled-on-demand", "beta7-on-demand");
    const file = path.join(dir, "CLAUDE.md");
    fs.appendFileSync(file, fs.readFileSync(path.join(ROOT, "skills/_shared/templates/on-demand-contract-snippet.md"), "utf8"));
    const text = init(dir, "on-demand");
    expect(markers(text)).toEqual(["<!-- nirvana-os:on-demand-contract:v2 -->"]);
    expect(text).not.toContain("Nirvana-OS: installed, out of the way");
    expect(text).toContain("MY RULE ABOVE: keep this line.");
    expect(text).toContain("MY RULE BELOW: keep this line too.");
  }, INIT_TIMEOUT_MS);
});
