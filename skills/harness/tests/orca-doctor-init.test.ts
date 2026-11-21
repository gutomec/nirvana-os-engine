// orca-doctor-init.test.ts — the two places a person meets the Orca host
// without running anything: `nrv doctor` says what it found, and `nrv init`
// makes the new project a workspace when it runs inside Orca (ADR-009).
//
// Both run the real scripts as child processes against a fake `orca` on PATH
// and a temporary HOME, so the assertions hold on a machine with Orca, one
// without it, and the three CI images.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { writeFakeCli } from "./helpers/fake-cli.ts";
import { fakeHomeEnv } from "./helpers/fake-home.ts";
import { removeDir } from "./helpers/temp-dirs.ts";

const ROOT = path.resolve(import.meta.dir, "..", "..", "..");
const SKILLS = path.join(ROOT, "skills");
const DOCTOR = path.join(SKILLS, "harness", "scripts", "doctor-system.ts");
const INIT = path.join(SKILLS, "_shared", "scripts", "init-project.ts");
const ORCA_KEYS = ["TERM_PROGRAM", "ORCA_WORKTREE_ID", "ORCA_TERMINAL_HANDLE", "ORCA_PANE_KEY", "ORCA_TAB_ID", "ORCA_CLI_COMMAND", "ORCA_DEV_REPO_ROOT", "NIRVANA_ORCA_HOST", "NIRVANA_ORCA_WORKERS", "NIRVANA_PROJECT_ROOT", "HARNESS_LOGS_DIR"];

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nrv-orca-doctor-")));
const bin = path.join(root, "bin");
const calls = path.join(root, "calls.jsonl");
const home = path.join(root, "home");

function readCalls(): string[][] {
  try { return fs.readFileSync(calls, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
}

/** The environment of a child: the parent's, minus every Orca marker and
 *  engine override, plus what the case sets. */
function childEnv(extra: Record<string, string>, withFake: boolean): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || ORCA_KEYS.includes(k)) continue;
    env[k] = v;
  }
  Object.assign(env, fakeHomeEnv(home, { NIRVANA_HOME: home, NIRVANA_SKILLS_DIR: SKILLS, NIRVANA_SCOPE_QUIET: "1", NIRVANA_ORCA_BOTS_DIR: path.join(home, ".orca", "bots") }) as Record<string, string>);
  // Without the fake, PATH keeps only the runtime and the system: a real
  // Orca installed on this machine must not leak into the "absent" case.
  const system = process.platform === "win32" ? [process.env.SYSTEMROOT ? path.join(process.env.SYSTEMROOT, "System32") : "C:\\Windows\\System32"] : ["/usr/bin", "/bin"];
  env.PATH = [withFake ? bin : null, path.dirname(process.execPath), ...system].filter(Boolean).join(path.delimiter);
  return { ...env, ...extra };
}

beforeAll(() => {
  fs.mkdirSync(path.join(home, ".nirvana"), { recursive: true });
  writeFakeCli(bin, "orca", `
    import * as fs from "node:fs";
    const argv = Bun.argv.slice(2);
    fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(argv) + "\\n");
    const words = argv.filter((a) => a !== "--json");
    const sub = words.slice(0, words[0] === "agent" ? 3 : 2).join(" ");
    let out;
    if (words[0] === "status") out = { ok: true, result: { app: { running: true }, runtime: { appVersion: "9.9.9", capabilities: ["orchestration.contract.v1"] } } };
    else if (sub === "agent hooks status") out = { ok: true, result: { enabled: true, statuses: [{ agent: "claude", state: "installed" }, { agent: "codex", state: "installed" }, { agent: "cursor", state: "not_installed" }] } };
    else if (sub === "repo add") out = { ok: true, result: { repo: { id: "repo-new", displayName: "fresh", path: words[3] } } };
    else if (sub === "worktree set") out = { ok: true, result: {} };
    else out = { ok: false, error: { code: "unknown_command", message: sub } };
    process.stdout.write(JSON.stringify({ id: "t", ...out }) + "\\n");
  `);
  // The name the resolver uses on Linux outside an Orca terminal.
  fs.copyFileSync(path.join(bin, "orca.ts"), path.join(bin, "orca-ide.ts"));
  if (process.platform === "win32") fs.copyFileSync(path.join(bin, "orca.cmd"), path.join(bin, "orca-ide.cmd"));
  else { fs.copyFileSync(path.join(bin, "orca"), path.join(bin, "orca-ide")); fs.chmodSync(path.join(bin, "orca-ide"), 0o755); }
});

afterAll(() => removeDir(root));

interface DoctorCheck { name: string; status: string; note: string }

function runDoctor(extra: Record<string, string>, withFake: boolean): DoctorCheck[] {
  const work = path.join(root, "work-" + Math.random().toString(36).slice(2, 8));
  fs.mkdirSync(path.join(work, ".nirvana"), { recursive: true });
  const r = spawnSync(process.execPath, [DOCTOR, "--json"], { encoding: "utf8", env: childEnv({ NIRVANA_PROJECT_ROOT: work, ...extra }, withFake), cwd: work, timeout: 90_000 });
  const parsed = JSON.parse(r.stdout || "{}") as { checks?: DoctorCheck[] };
  return parsed.checks ?? [];
}

describe("nrv doctor", () => {
  test("with Orca installed and running: one informational line with version, hooks and orchestration", () => {
    const line = runDoctor({}, true).find((c) => c.name === "orca: host");
    expect(line).toBeTruthy();
    expect(line!.status).toBe("PASS");
    expect(line!.note).toContain("app 9.9.9");
    expect(line!.note).toContain("hooks on claude, codex");
    expect(line!.note).toContain("orchestration available");
    expect(line!.note).toContain("host inactive here");
  }, 120_000);

  test("inside an Orca terminal the line names the workspace and says the host is active", () => {
    const line = runDoctor({ TERM_PROGRAM: "Orca", ORCA_WORKTREE_ID: "repo-1::/work/one", ORCA_TERMINAL_HANDLE: "term_1" }, true).find((c) => c.name === "orca: host");
    expect(line).toBeTruthy();
    expect(line!.note).toContain("host active");
    expect(line!.note).toContain("worktree /work/one");
  }, 120_000);

  test("without Orca on PATH there is no line at all — a machine without it is not degraded", () => {
    const checks = runDoctor({}, false);
    expect(checks.length).toBeGreaterThan(10);
    expect(checks.find((c) => c.name === "orca: host")).toBeUndefined();
  }, 120_000);
});

describe("nrv init", () => {
  function runInit(dir: string, extra: Record<string, string>): { stdout: string; stderr: string; status: number | null } {
    fs.mkdirSync(dir, { recursive: true });
    const r = spawnSync(process.execPath, [INIT, "."], { cwd: dir, encoding: "utf8", env: childEnv(extra, true), timeout: 120_000 });
    return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status };
  }

  test("inside Orca the new project is registered as a workspace", () => {
    fs.rmSync(calls, { force: true });
    const dir = path.join(root, "proj-inside");
    const r = runInit(dir, { TERM_PROGRAM: "Orca", ORCA_WORKTREE_ID: "repo-1::/somewhere/else", ORCA_TERMINAL_HANDLE: "term_1" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Orca: registered as workspace 'fresh'");
    const add = readCalls().find((c) => c[0] === "repo" && c[1] === "add");
    expect(add).toBeTruthy();
    expect(add!.slice(0, 4)).toEqual(["repo", "add", "--path", fs.realpathSync(dir)]);
  }, 150_000);

  test("inside Orca, in the current workspace, the card is claimed and nothing is registered twice", () => {
    fs.rmSync(calls, { force: true });
    const dir = path.join(root, "proj-current");
    fs.mkdirSync(dir, { recursive: true });
    const r = runInit(dir, { TERM_PROGRAM: "Orca", ORCA_WORKTREE_ID: `repo-1::${fs.realpathSync(dir)}`, ORCA_TERMINAL_HANDLE: "term_1" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("this directory is the current Orca workspace");
    Bun.sleepSync(500);
    const seen = readCalls();
    expect(seen.some((c) => c[0] === "repo")).toBe(false);
    expect(seen).toContainEqual(["worktree", "set", "--worktree", `id:repo-1::${fs.realpathSync(dir)}`, "--comment", "nirvana project · ready", "--workspace-status", "todo", "--json"]);
  }, 150_000);

  test("outside Orca, with the app answering, the project is registered and carries the setup script: no command is printed", () => {
    fs.rmSync(calls, { force: true });
    const dir = path.join(root, "proj-outside");
    const r = runInit(dir, {});
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Orca: registered as workspace 'fresh'");
    expect(r.stdout).not.toMatch(/repo add --path/);
    expect(readCalls().find((c) => c[0] === "repo" && c[1] === "add")!.slice(0, 4)).toEqual(["repo", "add", "--path", fs.realpathSync(dir)]);
    expect(fs.readFileSync(path.join(dir, "orca.yaml"), "utf8")).toContain("nrv init . --adopt");
  }, 150_000);

  test("a second init of the same project does not register it again, and an orca.yaml already there is left as it is", () => {
    const dir = path.join(root, "proj-outside");
    fs.writeFileSync(path.join(dir, "orca.yaml"), "scripts:\n  setup: |\n    echo mine\n");
    fs.rmSync(calls, { force: true });
    const r = runInit(dir, {});
    expect(r.status).toBe(0);
    expect(readCalls().some((c) => c[0] === "repo")).toBe(false);
    expect(fs.readFileSync(path.join(dir, "orca.yaml"), "utf8")).toContain("echo mine");
  }, 150_000);

  test("host.orca off: nothing is written for Orca and nothing is called", () => {
    fs.rmSync(calls, { force: true });
    const dir = path.join(root, "proj-off");
    const r = runInit(dir, { NIRVANA_ORCA_HOST: "off" });
    expect(r.status).toBe(0);
    expect(fs.existsSync(path.join(dir, "orca.yaml"))).toBe(false);
    expect(readCalls()).toEqual([]);
  }, 150_000);

  test("an Orca bot's folder is refused, its files untouched, and the bot is left with its Nirvana note", () => {
    const bot = path.join(home, ".orca", "bots", "helper");
    fs.mkdirSync(path.join(bot, "memory"), { recursive: true });
    fs.writeFileSync(path.join(bot, "bot.json"), JSON.stringify({ id: "b1", name: "Helper", agent: "claude" }));
    fs.writeFileSync(path.join(bot, "AGENTS.md"), "# Helper\n\nOrca writes this file.\n");
    fs.writeFileSync(path.join(bot, "MEMORY.md"), "# Memory\n\nOne line per fact, newest first. Longer notes go in memory/<topic>.md.\n");
    const r = spawnSync(process.execPath, [INIT, "."], { cwd: bot, encoding: "utf8", env: childEnv({}, true), timeout: 120_000 });
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toContain("home of the Orca bot 'Helper'");
    expect(fs.readFileSync(path.join(bot, "AGENTS.md"), "utf8")).toBe("# Helper\n\nOrca writes this file.\n");
    expect(fs.existsSync(path.join(bot, ".nirvana"))).toBe(false);
    expect(fs.existsSync(path.join(bot, "CLAUDE.md"))).toBe(false);
    expect(fs.readFileSync(path.join(bot, "memory", "nirvana-os.md"), "utf8")).toContain("nrv dispatch --auto --exec");
    expect(fs.readFileSync(path.join(bot, "MEMORY.md"), "utf8")).toContain("memory/nirvana-os.md");
  }, 150_000);
});

describe("nrv doctor and the bots", () => {
  test("a bot on the machine is listed, and one without the note is prepared by the doctor itself", () => {
    const bot = path.join(home, ".orca", "bots", "writer");
    fs.mkdirSync(bot, { recursive: true });
    fs.writeFileSync(path.join(bot, "bot.json"), JSON.stringify({ id: "b2", name: "Writer", agent: "codex" }));
    fs.writeFileSync(path.join(bot, "MEMORY.md"), "# Memory\n\n- 2026-01-01: likes short answers.\n");
    const line = runDoctor({}, true).find((c) => c.name === "orca: bots");
    expect(line).toBeTruthy();
    expect(line!.note).toContain("Writer (codex): prepared now");
    const memory = fs.readFileSync(path.join(bot, "MEMORY.md"), "utf8").split("\n");
    // Newest first: the engine's line sits above the fact that was already there.
    expect(memory.findIndex((l) => l.includes("memory/nirvana-os.md"))).toBeLessThan(memory.findIndex((l) => l.includes("likes short answers")));
    expect(runDoctor({}, true).find((c) => c.name === "orca: bots")!.note).toContain("Writer (codex): uses Nirvana-OS");
  }, 240_000);
});
