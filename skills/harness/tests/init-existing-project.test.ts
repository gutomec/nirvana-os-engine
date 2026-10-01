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
function runInit(dir: string, ...args: string[]) {
  return spawnSync(process.execPath, [INIT, ".", ...args], {
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

/** The full invocation contract is opt-in since on-demand became the default. */
const ALWAYS = "--orchestrators=always";

describe("a project that already has a contract file", () => {
  test("keeps the user's rules AND gains the invocation contract", () => {
    const dir = project("existing", { "CLAUDE.md": "# My rules\nnever delete this line\n" });
    runInit(dir, ALWAYS);
    const claude = fs.readFileSync(path.join(dir, "CLAUDE.md"), "utf8");
    expect(claude).toContain("never delete this line");        // user content survives
    expect(claude).toMatch(/invoke the .?harness.? skill/i);   // and orchestration is wired
    expect(claude).toMatch(/Writing contract/);
  }, INIT_TIMEOUT_MS);

  test("the user's rules stay at the top, above what we appended", () => {
    const dir = project("order", { "CLAUDE.md": "# My rules\nMY MARKER LINE\n" });
    runInit(dir, ALWAYS);
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
    runInit(dir, ALWAYS);
    for (const f of ["AGENTS.md", "CLAUDE.md", "GEMINI.md"]) {
      expect(fs.readFileSync(path.join(dir, f), "utf8")).toMatch(/invoke the .?harness.? skill/i);
    }
  }, INIT_TIMEOUT_MS);
});

/**
 * On-demand mode, the default: agents work as they would without Nirvana and
 * reach for it only when the request names it, asks for a business, a squad or
 * a mind-clone, or asks for work on another runtime. Instruction files carry
 * one short marked note and nothing else; --orchestrators=always opts into the
 * full invocation contract.
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
    expect(agents).toContain("nirvana-os:on-demand-contract:v3");
    expect(agents).toContain("The request calls for it when it");
    expect(agents).toContain("as the model to follow");
    expect(agents).not.toContain("nirvana-os:invocation-contract:v3");
    expect(agents).not.toContain("nirvana-os:writing-contract:v2");
    expect(agents).not.toMatch(/invoke the .?harness.? skill for any concrete artifact/i);
  }, INIT_TIMEOUT_MS);

  test("files init creates in on-demand mode carry the note and nothing else", () => {
    const dir = project("od-created", { "AGENTS.md": "# Mine\n" });
    runInitWith(dir, "--orchestrators=on-demand");
    const claude = fs.readFileSync(path.join(dir, "CLAUDE.md"), "utf8");
    expect(claude).toContain("nirvana-os:on-demand-contract:v3");
    expect(claude).not.toContain("nirvana-os:invocation-contract:v3");
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

  test("without a flag a new project is on-demand, in its files and its manifest", () => {
    const dir = project("od-default", { "CLAUDE.md": "# Mine\n" });
    runInit(dir);
    const claude = fs.readFileSync(path.join(dir, "CLAUDE.md"), "utf8");
    expect(claude).toContain("nirvana-os:on-demand-contract:v3");
    expect(claude).not.toContain("nirvana-os:invocation-contract:v3");
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, ".nirvana", "project.yaml"), "utf8"));
    expect(manifest.orchestration_mode).toBe("on-demand");
  }, INIT_TIMEOUT_MS);

  test("a project switches between modes in place, and the user's lines survive both ways", () => {
    const dir = project("od-switch", { "CLAUDE.md": "# Mine\nKEEP-ABOVE\n" });
    const manifest = () => JSON.parse(fs.readFileSync(path.join(dir, ".nirvana", "project.yaml"), "utf8"));
    runInit(dir, ALWAYS);
    expect(manifest().orchestration_mode).toBe("always");
    // a rerun without a flag brings an "always" project to the default
    const r = runInit(dir);
    expect(`${r.stdout}`).toContain("orchestration: always → on-demand");
    let c = fs.readFileSync(path.join(dir, "CLAUDE.md"), "utf8");
    expect(c).toContain("KEEP-ABOVE");
    expect(c).toContain("nirvana-os:on-demand-contract:v3");
    expect(c).not.toContain("nirvana-os:invocation-contract:v3");
    expect(c.match(/nirvana-os:on-demand-contract/g)!.length).toBe(1);
    expect(manifest().orchestration_mode).toBe("on-demand");
    // and back
    runInit(dir, ALWAYS);
    c = fs.readFileSync(path.join(dir, "CLAUDE.md"), "utf8");
    expect(c).toContain("KEEP-ABOVE");
    expect(c).toContain("nirvana-os:invocation-contract:v3");
    expect(c).not.toContain("nirvana-os:on-demand-contract");
    expect(c.match(/nirvana-os:invocation-contract:v3/g)!.length).toBe(1);
    expect(manifest().orchestration_mode).toBe("always");
  }, INIT_TIMEOUT_MS);

  test.each(["v1", "v2"])("an on-demand note %s from an earlier engine is brought to the current text", (version) => {
    const old = ["# Mine", "KEEP", "", `<!-- nirvana-os:on-demand-contract:${version} -->`, "## Nirvana-OS (on demand)", "OLD-NOTE-MUST-GO", ""].join("\n");
    const dir = project(`od-${version}`, { "AGENTS.md": old });
    runInit(dir);
    const c = fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8");
    expect(c).toContain("KEEP");
    expect(c).not.toContain("OLD-NOTE-MUST-GO");
    expect(c.match(/nirvana-os:on-demand-contract:v3/g)!.length).toBe(1);
  }, INIT_TIMEOUT_MS);
});

describe("the scope lives in .nirvana/project.yaml", () => {
  const manifest = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, ".nirvana", "project.yaml"), "utf8"));

  test("init creates no .env, and --scope writes the manifest", () => {
    const dir = project("scope-flag");
    expect(runInitWith(dir, "--scope=project").status).toBe(0);
    expect(fs.existsSync(path.join(dir, ".env"))).toBe(false);
    expect(fs.existsSync(path.join(dir, ".env.example"))).toBe(true);
    expect(manifest(dir).scope).toBe("project");
  }, INIT_TIMEOUT_MS);

  test("--scope on an existing project changes its manifest", () => {
    const dir = project("scope-change");
    runInit(dir);
    expect(manifest(dir).scope).toBe("global");
    runInitWith(dir, "--scope=merge");
    expect(manifest(dir).scope).toBe("merge");
  }, INIT_TIMEOUT_MS);

  test("a legacy .env scope moves into the manifest and leaves the .env", () => {
    const dir = project("scope-legacy", { ".env": "OPENAI_API_KEY=x\nNIRVANA_SCOPE=project\n" });
    const r = runInit(dir);
    expect(`${r.stdout}`).toContain("moved NIRVANA_SCOPE=project from .env into .nirvana/project.yaml");
    expect(manifest(dir).scope).toBe("project");
    const env = fs.readFileSync(path.join(dir, ".env"), "utf8");
    expect(env).not.toContain("NIRVANA_SCOPE");
    expect(env).toContain("OPENAI_API_KEY=x");
  }, INIT_TIMEOUT_MS);

  test("--adopt carries a legacy .env scope into the manifest and leaves the .env untouched", () => {
    const dir = project("scope-adopt", { ".env": "NIRVANA_SCOPE=merge\n" });
    expect(runInitWith(dir, "--adopt").status).toBe(0);
    expect(manifest(dir).scope).toBe("merge");
    expect(fs.readFileSync(path.join(dir, ".env"), "utf8")).toBe("NIRVANA_SCOPE=merge\n");
  }, INIT_TIMEOUT_MS);
});

describe("streams carry meaning — PowerShell paints stderr red", () => {
  test("progress goes to stdout; only warnings and failures go to stderr", () => {
    // Everything used to go to stderr, so a healthy init rendered as a wall of
    // red on Windows, [ok] lines included.
    const dir = project("streams", { "CLAUDE.md": "# Mine\n" });
    const r = runInit(dir, ALWAYS);
    expect(`${r.stdout}`).toContain("[ok]");
    expect(`${r.stderr}`).not.toContain("[ok]");
    expect(`${r.stderr}`).not.toContain("[info]");
    // and the two contract appends are distinguishable in the log
    expect(`${r.stdout}`).toContain("appended invocation contract");
    expect(`${r.stdout}`).toContain("appended writing contract");
  }, INIT_TIMEOUT_MS);
});

describe("a contract written by an earlier engine is refreshed in place", () => {
  test("the v1 block becomes the current template; the user's lines above and the writing contract below survive", () => {
    const v1 = [
      "# My rules", "KEEP-ME-ABOVE", "",
      "<!-- nirvana-os:invocation-contract:v1 -->",
      "# Project guidelines (old)", "", "invoke the **`harness` skill** for any concrete artifact", "OLD-LINE-MUST-GO", "",
      "---", "", "<!-- nirvana-os:writing-contract:v1 -->", "## Writing contract (for any prose deliverable)", "OLD-WRITING-LINE-MUST-GO", "Gate flags = build fails. No auto-rewrite.", "",
      "## The user's own section", "KEEP-ME-BELOW", "",
    ].join("\n");
    const dir = project("refresh-v1", { "AGENTS.md": v1, "CLAUDE.md": v1 });
    const r = runInit(dir, ALWAYS);
    expect(`${r.stdout}`).toContain("refreshed invocation contract (v1 → v3)");
    for (const f of ["AGENTS.md", "CLAUDE.md"]) {
      const c = fs.readFileSync(path.join(dir, f), "utf8");
      expect(c).toContain("KEEP-ME-ABOVE");
      expect(c).toContain("KEEP-ME-BELOW");
      expect(c).not.toContain("OLD-LINE-MUST-GO");
      expect(c).not.toContain("OLD-WRITING-LINE-MUST-GO");
      expect(c.indexOf("Gate flags = build fails")).toBeLessThan(c.indexOf("KEEP-ME-BELOW"));
      expect(c).not.toContain("nirvana-os:invocation-contract:v1");
      expect(c).toContain("nirvana-os:invocation-contract:v3");
      expect(c).toMatch(/Skill\("nirvana"/);
      expect(c.indexOf("KEEP-ME-ABOVE")).toBeLessThan(c.indexOf("nirvana-os:invocation-contract:v3"));
      expect(c.indexOf("nirvana-os:invocation-contract:v3")).toBeLessThan(c.indexOf("KEEP-ME-BELOW"));
      expect(c.match(/nirvana-os:writing-contract:v2/g)!.length).toBe(1);
      expect(c).not.toContain("nirvana-os:writing-contract:v1");
      expect(c).toContain("is not a deliverable and is not judged by it");
    }
    // Idempotent: a second run changes nothing.
    const first = fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8");
    runInit(dir, ALWAYS);
    expect(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8")).toBe(first);
  }, INIT_TIMEOUT_MS);
});

describe("a v2 contract is refreshed to the lean v3", () => {
  test("the old orchestration text goes, the user's lines and the writing contract stay", () => {
    const v2 = ["## Mine", "KEEP-ME-ABOVE", "", "<!-- nirvana-os:invocation-contract:v2 -->", "# old contract", "## 3. Inside a business", "Employees execute work by calling squads.", "",
      "---", "", "<!-- nirvana-os:writing-contract:v2 -->", "## Writing contract (for any prose deliverable)", "Gate flags = build fails. No auto-rewrite.", ""].join("\n");
    const dir = project("refresh-v2", { "AGENTS.md": v2 });
    const r = runInit(dir, ALWAYS);
    expect(`${r.stdout}`).toContain("refreshed invocation contract (v2 → v3)");
    const c = fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8");
    expect(c).toContain("KEEP-ME-ABOVE");
    expect(c).toContain("nirvana-os:invocation-contract:v3");
    expect(c).not.toContain("Employees execute work by calling squads.");
    expect(c.match(/nirvana-os:writing-contract:v2/g)!.length).toBe(1);
  }, INIT_TIMEOUT_MS);
});

describe("a duplicated old block is collapsed by the refresh", () => {
  test("two v1 writing contracts become one v2, and the user's lines after them survive", () => {
    const block = ["<!-- nirvana-os:writing-contract:v1 -->", "## Writing contract (for any prose deliverable)", "OLD-W", "Gate flags = build fails. No auto-rewrite.", ""].join("\n");
    const src = ["<!-- nirvana-os:invocation-contract:v3 -->", "# current contract", "", "---", "", block, "", "---", "", block, "## Mine", "KEEP-ME-LAST", ""].join("\n");
    const dir = project("dup-writing", { "AGENTS.md": src });
    runInit(dir, ALWAYS);
    const c = fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8");
    expect(c.match(/nirvana-os:writing-contract:v2/g)!.length).toBe(1);
    expect(c).not.toContain("writing-contract:v1");
    expect(c).not.toContain("OLD-W");
    expect(c).toContain("KEEP-ME-LAST");
    expect(c.match(/Gate flags = build fails/g)!.length).toBe(1);
  }, INIT_TIMEOUT_MS);
});

describe("Claude Code deny rules for dotenv files", () => {
  test("init writes permissions.deny for .env files, merges into an existing settings.json, and is idempotent", () => {
    const dir = project("deny-rules", { "CLAUDE.md": "# Mine\n" });
    fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".claude", "settings.json"), JSON.stringify({ permissions: { allow: ["Bash(npm test)"], deny: ["Read(./.env)"] }, other: true }, null, 2));
    runInit(dir);
    const s = JSON.parse(fs.readFileSync(path.join(dir, ".claude", "settings.json"), "utf8"));
    expect(s.other).toBe(true);
    expect(s.permissions.allow).toEqual(["Bash(npm test)"]);
    expect(s.permissions.deny).toContain("Read(./.env)");
    expect(s.permissions.deny).toContain("Read(./.env.*)");
    expect(s.permissions.deny.filter((r: string) => r === "Read(./.env)").length).toBe(1);
    const first = fs.readFileSync(path.join(dir, ".claude", "settings.json"), "utf8");
    runInit(dir);
    expect(fs.readFileSync(path.join(dir, ".claude", "settings.json"), "utf8")).toBe(first);
  }, INIT_TIMEOUT_MS);

  test("a settings.json that is not valid JSON is left alone", () => {
    const dir = project("deny-rules-bad", { "CLAUDE.md": "# Mine\n" });
    fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".claude", "settings.json"), "{ not json");
    runInit(dir);
    expect(fs.readFileSync(path.join(dir, ".claude", "settings.json"), "utf8")).toBe("{ not json");
  }, INIT_TIMEOUT_MS);
});
