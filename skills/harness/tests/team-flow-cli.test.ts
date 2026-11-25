// team-flow-cli.test.ts — `nrv team flow` as an OpenBot agent runs it: the
// plan of a squad's workflow, the record once the agent built it, the list and
// the forget, each as a real process with its own home.
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
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nrv-team-flow-cli-")));
const home = path.join(root, "home");
const squads = path.join(root, "squads");
const obRoot = path.join(root, "OpenBot");
const obDb = path.join(root, "openbot.db");
const prime = path.join(obRoot, "Agents", "agent-prime");
afterAll(() => removeDir(root));

fs.mkdirSync(path.join(home, ".nirvana"), { recursive: true });
fs.mkdirSync(prime, { recursive: true });
for (const squad of ["duo", "plain"]) fs.mkdirSync(path.join(squads, squad, "agents"), { recursive: true });
fs.writeFileSync(path.join(squads, "duo", "squad.yaml"), "name: duo\nversion: 1.0.0\n");
fs.writeFileSync(path.join(squads, "plain", "squad.yaml"), "name: plain\nversion: 1.0.0\n");
fs.writeFileSync(path.join(squads, "duo", "agents", "writer.md"), "---\nname: Writer\n---\n");
fs.writeFileSync(path.join(squads, "duo", "agents", "editor.md"), "---\nname: Editor\n---\n");
fs.mkdirSync(path.join(squads, "duo", "workflows"));
fs.writeFileSync(path.join(squads, "duo", "workflows", "write-and-edit.md"),
  "---\nname: write-and-edit\ndescription: A text, written then edited\nsteps:\n  - id: writer\n    agent: writer\n  - id: editor\n    agent: editor\n    requires: [writer]\n---\n");
const db = new Database(obDb);
db.run("CREATE TABLE projection_agents (agent_id TEXT PRIMARY KEY, agent_json TEXT NOT NULL)");
db.run("INSERT INTO projection_agents VALUES (?, ?)", ["agent-prime", JSON.stringify({ name: "Prime", provider: "claude" })]);
db.close();

function run(args: string[], cwd: string = prime): { code: number; out: string; err: string } {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== "NIRVANA_PROJECT_ROOT") env[k] = v;
  Object.assign(env, fakeHomeEnv(home, {
    NIRVANA_HOME: home, NIRVANA_SKILLS_DIR: SKILLS, NIRVANA_SCOPE_QUIET: "1", NIRVANA_ORCA_HOST: "off", SQUADS_DIR: squads,
    NIRVANA_OPENBOT_DIR: obRoot, NIRVANA_OPENBOT_STATE: path.join(root, "openbot-state.json"), NIRVANA_OPENBOT_DB: obDb,
  }) as Record<string, string>);
  const r = spawnSync(process.execPath, [TEAM, ...args], { cwd, env, encoding: "utf8" });
  return { code: r.status ?? -1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

describe("nrv team flow run by an OpenBot agent", () => {
  test("the plan names each step on the agent that asked and gives the one call that builds it", () => {
    const r = run(["flow", "duo"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Workflow plan: duo · write-and-edit");
    expect(r.out).toContain("writer — Writer — runs on Prime (agent-prime) — first");
    expect(r.out).toContain("editor — Editor — runs on Prime (agent-prime) — after writer");
    expect(r.out).toContain('"kind": "approval"');
    expect(r.out).toContain("nrv team flow duo --workflow write-and-edit --created <workflowId>");
    const plan = JSON.parse(run(["flow", "duo", "--json"]).out);
    expect(plan.ops.filter((o: any) => o.op === "add").length).toBe(5);
  }, spawnBudgetMs(3));

  test("record, list and forget", () => {
    const made = run(["flow", "duo", "--created", "wf-9"]);
    expect(made.code).toBe(0);
    expect(made.out).toContain("Recorded: duo · write-and-edit is the workflow wf-9.");
    expect(fs.readFileSync(path.join(prime, "AGENTS.md"), "utf8")).toContain("(workflow `wf-9`): A text, written then edited");
    expect(run(["flow", "--list"]).out).toContain("duo · write-and-edit (workflow wf-9): current");

    fs.appendFileSync(path.join(squads, "duo", "agents", "editor.md"), "\nA new rule.\n");
    expect(run(["flow", "--list"]).out).toContain("the squad changed since");

    const gone = run(["flow", "duo", "--forget"]);
    expect(gone.out).toContain("No longer in your instructions: duo · write-and-edit (workflow wf-9)");
    expect(fs.readFileSync(path.join(prime, "AGENTS.md"), "utf8")).not.toContain("wf-9");
    expect(run(["flow", "--list"]).out).toContain("No workflow built from a squad is recorded for you.");
  }, spawnBudgetMs(6));

  test("what cannot be planned says why and what to do", () => {
    const none = run(["flow", "ghost"]);
    expect(none.code).toBe(1);
    expect(none.err).toContain('no squad "ghost"');
    const plain = run(["flow", "plain"]);
    expect(plain.code).toBe(1);
    expect(plain.err).toContain("declares no workflow with steps");
    expect(plain.err).toContain("nrv dispatch --squad=plain");
    const wrong = run(["flow", "duo", "--workflow", "nope"]);
    expect(wrong.code).toBe(4);
    expect(wrong.err).toContain("write-and-edit (2 steps)");
    const outside = run(["flow", "duo", "--created", "wf-1"], root);
    expect(outside.code).toBe(1);
    expect(outside.err).toContain("OpenBot agent that built the workflow");
  }, spawnBudgetMs(5));
});
