// init-existing-project.test.ts — adopting Nirvana in a project you already have.
//
// `nrv init` materialises the contract as AGENTS.md + CLAUDE.md + GEMINI.md so
// every runtime family finds one. For a file that already exists it kept the
// user's rules and appended only the WRITING contract — which left the most
// common case of all without the INVOCATION contract, the part that tells the
// runtime to orchestrate. AGENTS.md got it, and Claude Code does not read
// AGENTS.md. So a Claude Code user with a pre-existing CLAUDE.md ran init, saw
// "ok", and went on getting inline answers: no dispatch, no gate, no audit.
import { describe, expect, test, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dir, "..", "..", "..");
const INIT = path.join(ROOT, "skills/_shared/scripts/init-project.ts");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-init-existing-"));

/** A cold CI runner spawns Bun and does registry work per call: the five tests
 *  take 684ms together locally and blew the 5s default on Windows. The budget
 *  below is wall-clock reality, not slack for a hang. */
const INIT_TIMEOUT_MS = 60_000;

/** NIRVANA_SKILLS_DIR pinned to the repo: without it the script reads the
 *  INSTALLED templates, and the test would silently grade a different tree. */
function runInit(dir: string) {
  return spawnSync(process.execPath, [INIT, "."], {
    cwd: dir, encoding: "utf8",
    env: { ...process.env, NIRVANA_SKILLS_DIR: path.join(ROOT, "skills") },
  });
}

function project(name: string, files: Record<string, string> = {}): string {
  const dir = path.join(TMP, name);
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  for (const [f, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), body);
  return dir;
}

afterAll(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ } });

describe("a project that already has a contract file", () => {
  test("keeps the user's rules AND gains the invocation contract", () => {
    const dir = project("existing", { "CLAUDE.md": "# My rules\nnever delete this line\n" });
    runInit(dir);
    const claude = fs.readFileSync(path.join(dir, "CLAUDE.md"), "utf8");
    expect(claude).toContain("never delete this line");        // user content survives
    expect(claude).toMatch(/invoke the .?harness.? skill/i);   // and orchestration is wired
    expect(claude).toMatch(/Writing contract/);
  }, INIT_TIMEOUT_MS);

  test("the user's rules stay at the top, above what we appended", () => {
    const dir = project("order", { "CLAUDE.md": "# My rules\nMY MARKER LINE\n" });
    runInit(dir);
    const c = fs.readFileSync(path.join(dir, "CLAUDE.md"), "utf8");
    expect(c.indexOf("MY MARKER LINE")).toBeLessThan(c.indexOf("Writing contract"));
  }, INIT_TIMEOUT_MS);

  test("running it twice changes nothing — markers make it idempotent", () => {
    const dir = project("twice", { "CLAUDE.md": "# Mine\n" });
    runInit(dir);
    const first = fs.readFileSync(path.join(dir, "CLAUDE.md"), "utf8");
    runInit(dir);
    expect(fs.readFileSync(path.join(dir, "CLAUDE.md"), "utf8")).toBe(first);
  }, INIT_TIMEOUT_MS);

  test("code and other files are never touched", () => {
    const dir = project("code", { "app.ts": "console.log('mine')\n", "README.md": "# mine\n" });
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    fs.writeFileSync(path.join(dir, "src/lib.ts"), "export const x = 1\n");
    runInit(dir);
    expect(fs.readFileSync(path.join(dir, "app.ts"), "utf8")).toBe("console.log('mine')\n");
    expect(fs.readFileSync(path.join(dir, "README.md"), "utf8")).toBe("# mine\n");
    expect(fs.readFileSync(path.join(dir, "src/lib.ts"), "utf8")).toBe("export const x = 1\n");
  }, INIT_TIMEOUT_MS);

  test("every runtime family ends up with the invocation contract", () => {
    // A project with only CLAUDE.md must still serve codex (AGENTS.md) and
    // gemini-cli (GEMINI.md) after init.
    const dir = project("all-runtimes", { "CLAUDE.md": "# Mine\n" });
    runInit(dir);
    for (const f of ["AGENTS.md", "CLAUDE.md", "GEMINI.md"]) {
      expect(fs.readFileSync(path.join(dir, f), "utf8")).toMatch(/invoke the .?harness.? skill/i);
    }
  }, INIT_TIMEOUT_MS);
});
