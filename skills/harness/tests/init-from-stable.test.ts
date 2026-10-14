// init-from-stable.test.ts — a project 0.14's `nrv init` wrote, re-initialised
// by this line.
//
// The fixtures are CLAUDE.md files written by the real 0.14.11 `nrv init`, in
// both modes, over a CLAUDE.md with the user's own line, plus a line the user
// added after init. This line knows 0.14's markers (invocation contract v3,
// on-demand note v2), so each becomes one current block. The on-demand note
// used to run to the end of the file, so a line the user wrote after it was
// replaced along with it; it now ends at its own last line.
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..", "..", "..");
const INIT = path.join(ROOT, "skills/_shared/scripts/init-project.ts");
const FIXTURES = path.join(import.meta.dir, "fixtures", "stable-init");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-init-from-stable-"));
const INIT_TIMEOUT_MS = 60_000;

afterAll(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ } });

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

describe("a CLAUDE.md written by 0.14.11's init, re-initialised by this line", () => {
  for (const source of ["v0.14.11-always", "v0.14.11-on-demand"]) {
    for (const mode of ["always", "on-demand"] as const) {
      test(`${source} → ${mode}: one Nirvana block, the user's lines intact`, () => {
        const dir = path.join(TMP, `${source}-${mode}`);
        fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
        fs.copyFileSync(path.join(FIXTURES, `${source}.CLAUDE.md`), path.join(dir, "CLAUDE.md"));
        const text = init(dir, mode);
        const nirvana = markers(text).filter((m) => !m.includes("writing-contract"));
        expect(nirvana).toEqual([mode === "always" ? "<!-- nirvana-os:invocation-contract:v4 -->" : "<!-- nirvana-os:on-demand-contract:v3 -->"]);
        expect(count(text, "<!-- nirvana-os:writing-contract:v2 -->")).toBeLessThanOrEqual(1);
        expect(text.startsWith("# My project\n\nMY RULE ABOVE: keep this line.\n")).toBe(true);
        expect(count(text, "MY RULE BELOW: keep this line too.")).toBe(1);
        // Nothing of 0.14's text is left behind.
        expect(text).not.toContain("Nirvana-OS — available on demand");
        expect(text).not.toContain("# Project guidelines (universal");
        expect(init(dir, mode)).toBe(text);
      }, INIT_TIMEOUT_MS);
    }
  }
});
