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

describe("a project initialized with the previous invocation contract", () => {
  const legacyMarker = "<!-- nirvana-os:invocation-contract:v1 -->";
  const capabilityMarker = "<!-- nirvana-os:capability-verification-contract:v1 -->";

  test("the first migration preserves every user prefix and updates all mirrors", () => {
    const originals = {
      "AGENTS.md": `# Agent rules\nOWNER AGENTS LINE\n\n${legacyMarker}\n# Old Nirvana contract\n`,
      "CLAUDE.md": `# Claude rules\nOWNER CLAUDE LINE\n\n${legacyMarker}\n# Old Nirvana contract\n`,
      "GEMINI.md": `# Gemini rules\nOWNER GEMINI LINE\n\n${legacyMarker}\n# Old Nirvana contract\n`,
    };
    const dir = project("legacy-capability-first", originals);
    const r = runInit(dir);
    expect(r.status).toBe(0);

    for (const [name, original] of Object.entries(originals)) {
      const migrated = fs.readFileSync(path.join(dir, name), "utf8");
      expect(migrated.startsWith(original)).toBe(true);
      expect(migrated.match(new RegExp(capabilityMarker, "g"))).toHaveLength(1);
      expect(migrated).toMatch(/existing and usable/i);
      expect(migrated).toMatch(/existing but misconfigured/i);
      expect(migrated).toMatch(/genuinely missing/i);
    }
  }, INIT_TIMEOUT_MS);

  test("re-running the migration is a byte-for-byte no-op", () => {
    const original = `# Mine\nDO NOT REWRITE\n\n${legacyMarker}\n# Old Nirvana contract\n`;
    const dir = project("legacy-capability-twice", {
      "AGENTS.md": original,
      "CLAUDE.md": original,
      "GEMINI.md": original,
    });
    expect(runInit(dir).status).toBe(0);
    const first = Object.fromEntries(
      ["AGENTS.md", "CLAUDE.md", "GEMINI.md"].map((name) => [name, fs.readFileSync(path.join(dir, name), "utf8")]),
    );
    for (const body of Object.values(first)) expect(body).toContain(capabilityMarker);
    expect(runInit(dir).status).toBe(0);
    for (const [name, body] of Object.entries(first)) {
      expect(fs.readFileSync(path.join(dir, name), "utf8")).toBe(body);
    }
  }, INIT_TIMEOUT_MS);
});

/**
 * On-demand mode — adopting Nirvana must not silently change a configured
 * project.
 *
 * Appending the invocation contract to a pre-existing AGENTS.md turns Nirvana
 * into the default orchestrator for every agent in the repo. That is the right
 * default for a fresh project and a significant silent change for an existing
 * one — the owner asked for the choice: --orchestrators=always keeps the
 * historical behavior, --orchestrators=on-demand leaves the project's rules
 * alone and adds one short marked note ("act only when explicitly asked").
 * Non-interactive without a flag stays "always", so CI does not change.
 */
function runInitWith(dir: string, ...args: string[]) {
  return spawnSync(process.execPath, [INIT, ".", ...args], {
    cwd: dir, encoding: "utf8",
    env: { ...process.env, NIRVANA_SKILLS_DIR: path.join(ROOT, "skills") },
  });
}

describe("on-demand mode leaves the project's behavior alone", () => {
  test("existing files gain only the on-demand note — no invocation, no writing contract", () => {
    const dir = project("od-existing", { "AGENTS.md": "# Mine\nMY LINE\n" });
    runInitWith(dir, "--orchestrators=on-demand");
    const agents = fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8");
    expect(agents).toContain("MY LINE");
    expect(agents).toContain("nirvana-os:on-demand-contract:v1");
    expect(agents).toContain("ONLY when the user explicitly asks");
    expect(agents).not.toContain("nirvana-os:invocation-contract:v1");
    expect(agents).not.toContain("nirvana-os:writing-contract:v1");
    expect(agents).not.toContain("nirvana-os:capability-verification-contract:v1");
    expect(agents).not.toMatch(/invoke the .?harness.? skill for any concrete artifact/i);
  }, INIT_TIMEOUT_MS);

  test("files init creates in on-demand mode carry the note and nothing else", () => {
    const dir = project("od-created", { "AGENTS.md": "# Mine\n" });
    runInitWith(dir, "--orchestrators=on-demand");
    const claude = fs.readFileSync(path.join(dir, "CLAUDE.md"), "utf8");
    expect(claude).toContain("nirvana-os:on-demand-contract:v1");
    expect(claude).not.toContain("nirvana-os:invocation-contract:v1");
  }, INIT_TIMEOUT_MS);

  test("on-demand is idempotent", () => {
    const dir = project("od-twice", { "AGENTS.md": "# Mine\n" });
    runInitWith(dir, "--orchestrators=on-demand");
    const first = fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8");
    runInitWith(dir, "--orchestrators=on-demand");
    expect(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8")).toBe(first);
  }, INIT_TIMEOUT_MS);

  test("an invalid mode is rejected, not guessed", () => {
    const dir = project("od-bad");
    const r = runInitWith(dir, "--orchestrators=sometimes");
    expect(r.status).not.toBe(0);
    expect(`${r.stderr}`).toContain('"always" or "on-demand"');
  }, INIT_TIMEOUT_MS);

  test("non-interactive without a flag keeps the historical default (always)", () => {
    // The five cases in the block above run exactly this way — pinned here by
    // name so the compat promise is explicit rather than incidental.
    const dir = project("od-default", { "CLAUDE.md": "# Mine\n" });
    runInit(dir);
    expect(fs.readFileSync(path.join(dir, "CLAUDE.md"), "utf8")).toContain("nirvana-os:invocation-contract:v1");
  }, INIT_TIMEOUT_MS);
});

describe("the promised .env exists even when the template does not", () => {
  test("a skills tree without the template still yields a working .env, and --scope works on it", () => {
    // One install shipped without project-skeleton/.env: init warned, finished
    // "[ok] done", pointed the user at a file that did not exist — and --scope
    // crashed on the read. The fallback keeps the promise the help makes.
    const stripped = path.join(TMP, "stripped-skills");
    fs.cpSync(path.join(ROOT, "skills", "_shared", "templates"), path.join(stripped, "_shared", "templates"), { recursive: true });
    fs.cpSync(path.join(ROOT, "skills", "_shared", "lib"), path.join(stripped, "_shared", "lib"), { recursive: true });
    fs.rmSync(path.join(stripped, "_shared", "templates", "project-skeleton", ".env"));

    const dir = project("env-fallback");
    const r = spawnSync(process.execPath, [INIT, ".", "--scope=project"], {
      cwd: dir, encoding: "utf8",
      env: { ...process.env, NIRVANA_SKILLS_DIR: stripped },
    });
    expect(r.status).toBe(0);
    const env = fs.readFileSync(path.join(dir, ".env"), "utf8");
    expect(env).toContain("NIRVANA_SCOPE=project");
  }, INIT_TIMEOUT_MS);
});

describe("streams carry meaning — PowerShell paints stderr red", () => {
  test("progress goes to stdout; only warnings and failures go to stderr", () => {
    // Everything used to go to stderr, so a healthy init rendered as a wall of
    // red on Windows, [ok] lines included.
    const dir = project("streams", { "CLAUDE.md": "# Mine\n" });
    const r = runInit(dir);
    expect(`${r.stdout}`).toContain("[ok]");
    expect(`${r.stderr}`).not.toContain("[ok]");
    expect(`${r.stderr}`).not.toContain("[info]");
    // and the two contract appends are distinguishable in the log
    expect(`${r.stdout}`).toContain("appended invocation contract");
    expect(`${r.stdout}`).toContain("appended writing contract");
  }, INIT_TIMEOUT_MS);
});
