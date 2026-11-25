// team-cli.test.ts — `nrv team` as an agent runs it: init, sync to Claude Code
// and to OpenBot, status and remove, each as a real process with its own home.
// The teams here are expert-x only, so no library is needed.
import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fakeHomeEnv } from "./helpers/fake-home.ts";
import { removeDir } from "./helpers/temp-dirs.ts";
import { spawnBudgetMs } from "./helpers/test-budgets.ts";

const SKILLS = path.resolve(import.meta.dir, "..", "..");
const TEAM = path.join(SKILLS, "harness", "scripts", "team.ts");

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nrv-team-cli-")));
const home = path.join(root, "home");
const obRoot = path.join(root, "OpenBot");
const obDb = path.join(root, "openbot.db");
fs.mkdirSync(path.join(home, ".nirvana"), { recursive: true });
afterAll(() => removeDir(root));

function run(args: string[], cwd: string): { code: number; out: string; err: string } {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== "NIRVANA_PROJECT_ROOT") env[k] = v;
  Object.assign(env, fakeHomeEnv(home, {
    NIRVANA_HOME: home, NIRVANA_SKILLS_DIR: SKILLS, NIRVANA_SCOPE_QUIET: "1", NIRVANA_ORCA_HOST: "off",
    NIRVANA_OPENBOT_DIR: obRoot, NIRVANA_OPENBOT_STATE: path.join(root, "openbot-state.json"), NIRVANA_OPENBOT_DB: obDb,
  }) as Record<string, string>);
  const r = spawnSync(process.execPath, [TEAM, ...args], { cwd, env, encoding: "utf8" });
  return { code: r.status ?? -1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

const TEAM_YAML = `
team: duo
display_name: "Duo"
orchestrator: director
members:
  - id: director
    name: "Duo Director"
    tier: lead
    expert: { role: "Runs the project", delivers: "The delivery", done_when: "Every part exists" }
  - id: writer
    name: "Duo Writer"
    expert: { role: "Writes the piece", delivers: "The text", done_when: "The text meets the request" }
    reports_to: director
`;

describe("nrv team in a project (Claude Code)", () => {
  const project = path.join(root, "project");
  fs.mkdirSync(project, { recursive: true });

  test("init --here writes the skeleton and refuses to overwrite it", () => {
    const a = run(["init", "duo", "Two people", "--here"], project);
    expect(a.code).toBe(0);
    expect(fs.existsSync(path.join(project, ".nirvana", "team.yaml"))).toBe(true);
    expect(run(["init", "duo", "--here"], project).code).toBe(1);
  }, spawnBudgetMs(2));

  test("sync writes the subagents and says who the orchestrator is; status and remove follow", () => {
    fs.writeFileSync(path.join(project, ".nirvana", "team.yaml"), TEAM_YAML);
    const s = run(["sync"], project);
    expect(s.code).toBe(0);
    expect(s.out).toContain("Claude Code: 1 subagent(s)");
    expect(s.out).toContain("The main session is the orchestrator");
    expect(fs.existsSync(path.join(project, ".claude", "agents", "duo-writer.md"))).toBe(true);
    expect(fs.existsSync(path.join(project, ".nirvana", "team", "director.md"))).toBe(true);
    expect(run(["status"], project).out).toContain("Claude Code duo-writer");
    const r = run(["remove"], project);
    expect(r.out).toContain("1 Claude Code subagent file(s)");
    expect(fs.existsSync(path.join(project, ".claude", "agents", "duo-writer.md"))).toBe(false);
    expect(fs.existsSync(path.join(project, ".nirvana", "team.yaml"))).toBe(true);
  }, spawnBudgetMs(4));

  test("a team file with a problem writes nothing and names the problem", () => {
    const bad = path.join(root, "bad");
    fs.mkdirSync(path.join(bad, ".nirvana"), { recursive: true });
    fs.writeFileSync(path.join(bad, ".nirvana", "team.yaml"), TEAM_YAML.replace("orchestrator: director", "orchestrator: ghost"));
    const s = run(["sync"], bad);
    expect(s.code).toBe(1);
    expect(s.err).toContain("orchestrator: must be the id of a member");
    expect(fs.existsSync(path.join(bad, ".claude"))).toBe(false);
  }, spawnBudgetMs(1));

  test("no team here: the answer says how to start one", () => {
    const empty = path.join(root, "empty");
    fs.mkdirSync(empty);
    const s = run(["sync"], empty);
    expect(s.code).toBe(1);
    expect(s.err).toContain("nrv team init <slug>");
  }, spawnBudgetMs(1));
});

describe("nrv team run by an OpenBot agent", () => {
  const prime = path.join(obRoot, "Agents", "agent-prime");
  fs.mkdirSync(prime, { recursive: true });
  const db = new Database(obDb);
  db.run("CREATE TABLE projection_agents (agent_id TEXT PRIMARY KEY, agent_json TEXT NOT NULL)");
  db.run("INSERT INTO projection_agents VALUES (?, ?)", ["agent-prime", JSON.stringify({ name: "Prime", provider: "claude" })]);
  db.close();
  const teamFile = path.join(home, ".nirvana", "teams", "duo", ".nirvana", "team.yaml");

  test("init from an agent's workspace puts the team under the engine's home", () => {
    expect(run(["init", "duo", "--here"], prime).code).toBe(1);
    const a = run(["init", "duo", "Two people"], prime);
    expect(a.code).toBe(0);
    expect(a.out).toContain("nrv team sync --team duo");
    expect(fs.existsSync(teamFile)).toBe(true);
  }, spawnBudgetMs(2));

  test("sync names the agents to create, and once they exist, who receives the request", () => {
    fs.writeFileSync(teamFile, TEAM_YAML);
    const first = run(["sync", "--team", "duo"], prime);
    expect(first.code).toBe(0);
    expect(first.out).toContain("OpenBot: 0 of 2 member(s)");
    expect(first.out).toContain('name "Duo Director"');
    expect(first.out).toContain("Run this command again");

    const d = new Database(obDb);
    for (const [id, name] of [["agent-d", "Duo Director"], ["agent-w", "Duo Writer"]]) {
      fs.mkdirSync(path.join(obRoot, "Agents", id), { recursive: true });
      d.run("INSERT INTO projection_agents VALUES (?, ?)", [id, JSON.stringify({ name, provider: "claude" })]);
    }
    d.close();
    const second = run(["sync", "--team", "duo"], prime);
    expect(second.out).toContain("OpenBot: 2 of 2 member(s)");
    expect(second.out).toContain("to Duo Director (agent-d) with send_message");
    expect(fs.readFileSync(path.join(obRoot, "Agents", "agent-w", "AGENTS.md"), "utf8")).toContain("You answer to **Duo Director** (`agent-d`).");
    expect(fs.existsSync(path.join(prime, "AGENTS.md"))).toBe(false);
    expect(run(["status", "--team", "duo"], prime).out).toContain("OpenBot agent-w");

    const r = run(["remove", "--team", "duo"], prime);
    expect(r.out).toContain("2 OpenBot agent(s)");
    expect(fs.readFileSync(path.join(obRoot, "Agents", "agent-w", "AGENTS.md"), "utf8").trim()).toBe("");
  }, spawnBudgetMs(5));
});
