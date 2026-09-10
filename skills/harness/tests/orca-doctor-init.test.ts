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
  Object.assign(env, fakeHomeEnv(home, { NIRVANA_HOME: home, NIRVANA_SKILLS_DIR: SKILLS, NIRVANA_SCOPE_QUIET: "1" }) as Record<string, string>);
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

  test("outside Orca, with the CLI installed, the one command is printed and nothing is called", () => {
    fs.rmSync(calls, { force: true });
    const dir = path.join(root, "proj-outside");
    const r = runInit(dir, {});
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Orca: orca(-ide)? repo add --path /);
    expect(readCalls()).toEqual([]);
  }, 150_000);
});
