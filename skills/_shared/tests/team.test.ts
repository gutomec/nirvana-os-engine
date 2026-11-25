// team.test.ts — a team built from the library: what `.nirvana/team.yaml` may
// say, what each member is told, and how the team reaches Claude Code and
// OpenBot. A library and an OpenBot home on disk; no host is called.
import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { compileMember, loadTeam, sharedRules, teamFileOf, teamSkeleton, type TeamLibrary } from "../lib/team.ts";
import { releaseOpenBot, syncClaudeCode, syncOpenBot, teamOfText, writeNeutral } from "../lib/team-hosts.ts";
import { OPENBOT_BLOCK_BEGIN, openBotAutoSetup, openBotDatabasePath } from "../lib/openbot.ts";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nrv-team-")));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

// A library of one business with two employees and one mind-clone.
const libDir = path.join(root, "library");
const employee = (slug: string, text: string) => {
  const file = path.join(libDir, "businesses", "acme", "employees", `${slug}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
};
employee("writer", "---\nname: writer\nrole: Writer\nacceptance:\n  - id: a1\n    description: Every line is concrete\n    blocking: true\n---\n# Writer\n\n## Method\nWrite short.\n");
employee("qa", "---\nname: qa\nrole: QA\n---\n# QA\nFind what is wrong.\n");
const cloneDir = path.join(libDir, "clones", "ada");
fs.mkdirSync(path.join(cloneDir, "agent"), { recursive: true });
fs.writeFileSync(path.join(cloneDir, "agent", "AGENT.md"), "# Ada\n");
const lib: TeamLibrary = {
  employeeFile: (r) => { const [b, e] = r.split("/"); const f = path.join(libDir, "businesses", b ?? "", "employees", `${e}.md`); return fs.existsSync(f) ? f : null; },
  cloneDir: (c) => (c === "ada" ? cloneDir : null),
};

let seq = 0;
function teamAt(yaml: string): { dir: string; file: string } {
  const dir = path.join(root, `team-${++seq}`);
  const file = teamFileOf(dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, yaml);
  return { dir, file };
}

const GOOD = `
team: studio
display_name: "Studio"
purpose: "Writes and reviews."
output_root: ${JSON.stringify(path.join(root, "out"))}
orchestrator: director
reviewer: reviewer
members:
  - id: director
    name: "Director"
    tier: lead
    expert: { role: "Runs the project", delivers: "The delivery", done_when: "Every part exists" }
  - id: writer
    name: "Writer"
    role_from: acme/writer
    clones: [ada]
    reports_to: director
  - id: reviewer
    name: "Reviewer"
    tier: lead
    role_from: acme/qa
    reports_to: director
models:
  lead: { provider: claude, model: big, effort: high }
`;

describe("the team file", () => {
  test("a valid team loads with its members, tiers, models and output root", () => {
    const { spec, problems } = loadTeam(teamAt(GOOD).file, lib);
    expect(problems).toEqual([]);
    expect(spec!.members.map((m) => [m.id, m.tier, m.clones])).toEqual([["director", "lead", []], ["writer", "member", ["ada"]], ["reviewer", "lead", []]]);
    expect(spec!.models.lead).toEqual({ provider: "claude", model: "big", effort: "high" });
    expect(spec!.output_root).toBe(path.join(root, "out"));
  });

  test("every problem is named, and none is fixed silently", () => {
    const { problems } = loadTeam(teamAt(`
team: Bad Slug
orchestrator: nobody
reviewer: a
members:
  - id: a
    name: "Same"
    role_from: acme/ghost
  - id: b
    name: "same"
    expert: { role: "X", delivers: "", done_when: "Y" }
    clones: [ada]
    reports_to: b
  - id: c
    role_from: acme/writer
    clones: [nobody-installed]
    reports_to: d
  - id: d
    role_from: acme/writer
    reports_to: c
  - id: e
`).file, lib);
    const has = (needle: string) => expect(problems.some((p) => p.includes(needle)), needle).toBe(true);
    has("team: a lowercase slug");
    has('role_from "acme/ghost" is not an employee');
    has('the name "same" is used twice');
    has("expert.delivers is required");
    has("an expert-x has no mind-clone");
    has("reports to itself");
    has('mind-clone "nobody-installed" is not installed');
    has("its reporting line is a loop");
    has("needs role_from");
    has("orchestrator: must be the id of a member");
  });

  test("the reviewer is never the orchestrator; the skeleton is a valid team", () => {
    const bad = loadTeam(teamAt(GOOD.replace("reviewer: reviewer", "reviewer: director")).file, lib);
    expect(bad.problems.join(" ")).toContain("does not review");
    const sk = loadTeam(teamAt(teamSkeleton("fresh", "A purpose: with a colon")).file, lib);
    expect(sk.problems).toEqual([]);
    expect(sk.spec!.purpose).toBe("A purpose: with a colon");
  });
});

describe("what a member is told", () => {
  const spec = loadTeam(teamAt(GOOD).file, lib).spec!;
  const of = (id: string, host: "neutral" | "openbot" | "claude-code" = "neutral") => compileMember(spec, spec.members.find((m) => m.id === id)!, { host, lib });

  test("an employee: the role file's text and acceptance, and the clone's files by path", () => {
    const t = of("writer");
    expect(t).toContain("## Your role (employee `acme/writer`)");
    expect(t).toContain("#### Method");
    expect(t).toContain("- Every line is concrete (blocking)");
    expect(t).toContain(path.join(cloneDir, "agent", "AGENT.md"));
    expect(t).toContain("You answer to **Director**.");
  });

  test("an expert-x: the three lines of its card and no persona", () => {
    const t = of("director");
    expect(t).toContain("You are an expert-x");
    expect(t).toContain("- **Done when:** Every part exists");
    expect(t).not.toContain("## Your persona");
  });

  test("the orchestrator runs the project; the reviewer reviews a list, in one pass", () => {
    expect(of("director")).toContain("One decision point.");
    expect(of("director")).toContain("Send Reviewer the list of files that changed");
    expect(of("reviewer")).toContain("Review that list and nothing else.");
  });

  test("everyone gets the rules the pilot paid for", () => {
    const rules = sharedRules(spec, "openbot").join("\n");
    for (const needle of ["Effort fits the question", "Never end a turn waiting", "The machine is its owner's", "Docker", "Do not call Nirvana-OS"]) expect(rules).toContain(needle);
    expect(rules).toContain("send_message");
    expect(sharedRules(spec, "claude-code").join("\n")).not.toContain("send_message");
    for (const m of spec.members) expect(of(m.id, "openbot")).toContain("The machine is its owner's");
  });
});

describe("Claude Code: the team as the project's subagents", () => {
  test("one file per member but the orchestrator, whose instructions go to the main session", () => {
    const { dir, file } = teamAt(GOOD);
    const spec = loadTeam(file, lib).spec!;
    const r = syncClaudeCode(spec, dir, lib);
    expect(r.written.map((f) => path.basename(f)).sort()).toEqual(["studio-reviewer.md", "studio-writer.md"]);
    const sub = fs.readFileSync(path.join(dir, ".claude", "agents", "studio-writer.md"), "utf8");
    expect(sub.startsWith("---\nname: studio-writer\ndescription: \"Writer of the team Studio")).toBe(true);
    expect(teamOfText(sub)).toBe("studio");
    expect(fs.readFileSync(r.director, "utf8")).toContain("**Writer** (subagent `studio-writer`)");
    expect(fs.existsSync(path.join(writeNeutral(spec, dir, lib), "director.md"))).toBe(true);
  });

  test("a member taken out loses its file; a file the team did not write is left alone", () => {
    const { dir, file } = teamAt(GOOD);
    syncClaudeCode(loadTeam(file, lib).spec!, dir, lib);
    const mine = path.join(dir, ".claude", "agents", "studio-notes.md");
    fs.writeFileSync(mine, "---\nname: studio-notes\n---\nMine.\n");
    fs.writeFileSync(file, GOOD.replace(/  - id: writer[\s\S]*?reports_to: director\n/, ""));
    const r = syncClaudeCode(loadTeam(file, lib).spec!, dir, lib);
    expect(r.removed.map((f) => path.basename(f))).toEqual(["studio-writer.md"]);
    expect(fs.existsSync(mine)).toBe(true);
  });
});

describe("OpenBot: the team in the agents that carry the members' names", () => {
  function openBotHome(name: string, agents: Record<string, string>): string {
    const home = path.join(root, name);
    const db = openBotDatabasePath(home);
    fs.mkdirSync(path.dirname(db), { recursive: true });
    const d = new Database(db);
    d.run("CREATE TABLE projection_agents (agent_id TEXT PRIMARY KEY, agent_json TEXT NOT NULL)");
    for (const [id, agentName] of Object.entries(agents)) {
      fs.mkdirSync(path.join(home, "OpenBot", "Agents", id), { recursive: true });
      d.run("INSERT INTO projection_agents VALUES (?, ?)", [id, JSON.stringify({ name: agentName, provider: "claude" })]);
    }
    d.close();
    return home;
  }
  const agentsFile = (home: string, id: string) => path.join(home, "OpenBot", "Agents", id, "AGENTS.md");
  const spec = () => loadTeam(teamAt(GOOD).file, lib).spec!;

  test("members with no agent are reported, never created; the others get their section", () => {
    const home = openBotHome("ob-partial", { "agent-1": "Director", "agent-2": "Someone else" });
    const r = syncOpenBot(spec(), lib, home);
    expect(r.written.map((w) => [w.member.id, w.agent.id])).toEqual([["director", "agent-1"]]);
    expect(r.missing.map((m) => m.name)).toEqual(["Writer", "Reviewer"]);
    expect(teamOfText(fs.readFileSync(agentsFile(home, "agent-1"), "utf8"))).toBe("studio");
    expect(fs.existsSync(agentsFile(home, "agent-2"))).toBe(false);
  });

  test("a full team: ids in the text, the owner's text kept, the generic section out and not put back", () => {
    const home = openBotHome("ob-full", { "agent-1": "Director", "agent-2": "writer", "agent-3": "Reviewer" });
    openBotAutoSetup(home);
    fs.writeFileSync(agentsFile(home, "agent-2"), "Owner's note.\n\n" + fs.readFileSync(agentsFile(home, "agent-2"), "utf8"));
    const r = syncOpenBot(spec(), lib, home);
    expect(r.missing).toEqual([]);
    const writer = fs.readFileSync(agentsFile(home, "agent-2"), "utf8");
    expect(writer.startsWith("Owner's note.")).toBe(true);
    expect(writer).not.toContain(OPENBOT_BLOCK_BEGIN);
    expect(writer).toContain("You answer to **Director** (`agent-1`).");
    expect(fs.readFileSync(agentsFile(home, "agent-1"), "utf8")).toContain("**Writer** (`agent-2`)");
    // The engine's own setup leaves a team member as it is.
    expect(openBotAutoSetup(home).agents.every((a) => a.outcome === "turned-off")).toBe(true);
    expect(fs.readFileSync(agentsFile(home, "agent-2"), "utf8")).toBe(writer);
    // A second sync changes nothing.
    syncOpenBot(spec(), lib, home);
    expect(fs.readFileSync(agentsFile(home, "agent-2"), "utf8")).toBe(writer);
  });

  test("an agent in another team is not taken; a former member and a removed team are released", () => {
    const home = openBotHome("ob-other", { "agent-1": "Director", "agent-2": "Writer", "agent-3": "Reviewer", "agent-4": "Old member" });
    fs.writeFileSync(agentsFile(home, "agent-2"), "<!-- nirvana-os:team:v1 other-team -->\nx\n<!-- /nirvana-os:team -->\n");
    fs.writeFileSync(agentsFile(home, "agent-4"), "Keep.\n\n<!-- nirvana-os:team:v1 studio -->\nold\n<!-- /nirvana-os:team -->\n");
    const r = syncOpenBot(spec(), lib, home);
    expect(r.taken.map((t) => [t.member.id, t.team])).toEqual([["writer", "other-team"]]);
    expect(r.released.map((a) => a.id)).toEqual(["agent-4"]);
    expect(fs.readFileSync(agentsFile(home, "agent-4"), "utf8").trim()).toBe("Keep.");
    expect(releaseOpenBot("studio", home).map((a) => a.id).sort()).toEqual(["agent-1", "agent-3"]);
    expect(teamOfText(fs.readFileSync(agentsFile(home, "agent-2"), "utf8"))).toBe("other-team");
    // A released agent is an ordinary agent again: the engine's own setup prepares it.
    const after = Object.fromEntries(openBotAutoSetup(home).agents.map((a) => [a.agent.id, a.outcome]));
    expect([after["agent-1"], after["agent-3"], after["agent-4"]]).toEqual(["written", "written", "written"]);
  });
});
