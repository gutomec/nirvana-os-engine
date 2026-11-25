// openbot-doctor-init.test.ts — the two places a person meets the OpenBot
// integration without running anything for it: `nrv doctor` prepares the
// agents and says so, and `nrv init` refuses an agent's workspace. Both run the
// real scripts as child processes against a temporary HOME and a temporary
// OpenBot root.
import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fakeHomeEnv } from "./helpers/fake-home.ts";
import { removeDir } from "./helpers/temp-dirs.ts";

const ROOT = path.resolve(import.meta.dir, "..", "..", "..");
const SKILLS = path.join(ROOT, "skills");
const DOCTOR = path.join(SKILLS, "harness", "scripts", "doctor-system.ts");
const INIT = path.join(SKILLS, "_shared", "scripts", "init-project.ts");

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nrv-openbot-doctor-")));
const home = path.join(root, "home");
fs.mkdirSync(path.join(home, ".nirvana"), { recursive: true });
afterAll(() => removeDir(root));

function childEnv(obRoot: string, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || k === "NIRVANA_PROJECT_ROOT") continue;
    env[k] = v;
  }
  Object.assign(env, fakeHomeEnv(home, {
    NIRVANA_HOME: home, NIRVANA_SKILLS_DIR: SKILLS, NIRVANA_SCOPE_QUIET: "1", NIRVANA_ORCA_HOST: "off",
    NIRVANA_OPENBOT_DIR: obRoot, NIRVANA_OPENBOT_STATE: path.join(obRoot, "..", `${path.basename(obRoot)}-state.json`),
    NIRVANA_OPENBOT_DB: path.join(obRoot, "..", `${path.basename(obRoot)}.db`),
  }) as Record<string, string>);
  return { ...env, ...extra };
}

function makeRoot(name: string, agents: string[]): string {
  const obRoot = path.join(root, name);
  fs.mkdirSync(obRoot, { recursive: true });
  for (const id of agents) fs.mkdirSync(path.join(obRoot, "Agents", id), { recursive: true });
  return obRoot;
}

function doctorLine(obRoot: string): { status: string; note: string } | undefined {
  const work = path.join(root, "work-" + Math.random().toString(36).slice(2, 8));
  fs.mkdirSync(path.join(work, ".nirvana"), { recursive: true });
  const r = spawnSync(process.execPath, [DOCTOR, "--json"], { encoding: "utf8", env: childEnv(obRoot, { NIRVANA_PROJECT_ROOT: work }), cwd: work, timeout: 90_000 });
  const parsed = JSON.parse(r.stdout || "{}") as { checks?: Array<{ name: string; status: string; note: string }> };
  return (parsed.checks ?? []).find((c) => c.name === "openbot: agents");
}

describe("nrv doctor", () => {
  test("prepares each agent, names it from the app's database, and the next run reports it in use", () => {
    const obRoot = makeRoot("two", ["agent-1", "agent-2"]);
    const db = new Database(path.join(root, "two.db"));
    db.run("CREATE TABLE projection_agents (agent_id TEXT PRIMARY KEY, agent_json TEXT NOT NULL)");
    db.run("INSERT INTO projection_agents VALUES (?, ?)", ["agent-1", JSON.stringify({ name: "Ada", provider: "claude" })]);
    db.close();
    const first = doctorLine(obRoot);
    expect(first?.status).toBe("PASS");
    expect(first!.note).toContain("Ada (claude): prepared now");
    expect(first!.note).toContain("agent-2: prepared now");
    expect(fs.readFileSync(path.join(obRoot, "Agents", "agent-1", "AGENTS.md"), "utf8")).toContain("nrv dispatch --auto --exec");
    expect(doctorLine(obRoot)!.note).toContain("Ada (claude): uses Nirvana-OS");
  }, 240_000);

  test("without OpenBot there is no line at all", () => {
    expect(doctorLine(path.join(root, "absent"))).toBeUndefined();
  }, 120_000);
});

describe("nrv init", () => {
  test("an agent's workspace is not a project: refused, only the agent's section written", () => {
    const obRoot = makeRoot("init", ["agent-1"]);
    const ws = path.join(obRoot, "Agents", "agent-1");
    const r = spawnSync(process.execPath, [INIT, "."], { cwd: ws, encoding: "utf8", env: childEnv(obRoot), timeout: 120_000 });
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toContain("is the workspace of the OpenBot agent agent-1, not a project");
    expect(fs.readdirSync(ws)).toEqual(["AGENTS.md"]);
  }, 150_000);
});
