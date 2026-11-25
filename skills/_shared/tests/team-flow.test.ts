// team-flow.test.ts — a squad's workflow as a host workflow: the plan, the ops
// of the one call that builds it, and the section that tells the agent when to
// run it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  FLOWS_BLOCK_BEGIN, flowPlan, flowsBlockText, forgetFlows, recordFlow, recordedFlows, squadWorkflows, workflowProblems,
} from "../lib/team-flow.ts";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nrv-team-flow-")));
const squadDir = path.join(root, "squads", "content");
const savedHome = process.env.NIRVANA_HOME;

function agentFile(slug: string, name: string): void {
  fs.writeFileSync(path.join(squadDir, "agents", `${slug}.md`), `---\nname: "${name}"\n---\n\n# ${slug}\n`);
}

beforeAll(() => {
  process.env.NIRVANA_HOME = path.join(root, "home");
  fs.mkdirSync(path.join(squadDir, "agents"), { recursive: true });
  fs.mkdirSync(path.join(squadDir, "workflows"), { recursive: true });
  agentFile("strategist", "Content Strategist");
  agentFile("writer", "Writer");
  agentFile("designer", "Designer");
  agentFile("scheduler", "Scheduler");
  fs.writeFileSync(path.join(squadDir, "workflows", "pipeline.md"), [
    "---", "name: pipeline", "description: From a theme to scheduled posts", "steps:",
    "  - id: scheduler", "    agent: scheduler", "    requires: [writer, designer]",
    "  - id: writer", "    agent: writer", "    requires:", "      - strategist",
    "  - id: designer", "    agent: designer", "    requires: [strategist]",
    "  - id: strategist", "    agent: strategist",
    "---", "", "Body.", "",
  ].join("\n"));
  fs.writeFileSync(path.join(squadDir, "workflows", "notes.md"), "---\nname: notes\n---\nNo steps here.\n");
});

afterAll(() => {
  if (savedHome === undefined) delete process.env.NIRVANA_HOME; else process.env.NIRVANA_HOME = savedHome;
  fs.rmSync(root, { recursive: true, force: true });
});

const self = { id: "agent-prime", name: "Prime" };
const noAgents = new Map<string, { id: string; name: string }>();

describe("reading a squad's workflows", () => {
  test("a workflow is its steps; a file with no steps is not one", () => {
    const list = squadWorkflows(squadDir);
    expect(list.map((w) => w.name)).toEqual(["pipeline"]);
    expect(list[0].description).toBe("From a theme to scheduled posts");
    expect(list[0].steps.find((s) => s.id === "scheduler")!.requires).toEqual(["writer", "designer"]);
    expect(squadWorkflows(path.join(root, "nowhere"))).toEqual([]);
  });

  test("what cannot be drawn is named: a missing agent, an unknown requirement, a circle", () => {
    const [wf] = squadWorkflows(squadDir);
    expect(workflowProblems(wf, squadDir)).toEqual([]);
    expect(workflowProblems({ ...wf, steps: [{ id: "a", agent: "ghost", requires: ["b"] }] }, squadDir)).toEqual([
      'step "a": the squad has no agents/ghost.md', 'step "a": requires "b", which is not a step',
    ]);
    const circle = [{ id: "writer", agent: "writer", requires: ["designer"] }, { id: "designer", agent: "designer", requires: ["writer"] }];
    expect(workflowProblems({ ...wf, steps: circle }, squadDir)).toEqual(["the steps require each other in a circle"]);
  });
});

describe("the plan", () => {
  test("steps come after what they require, each told its role, its file and its input", () => {
    const plan = flowPlan("content", squadDir, squadWorkflows(squadDir)[0], { self, agents: noAgents });
    expect(plan.title).toBe("content · pipeline");
    expect(plan.steps.map((s) => s.id)).toEqual(["strategist", "writer", "designer", "scheduler"]);
    const writer = plan.steps.find((s) => s.id === "writer")!;
    expect(writer.task).toContain('the step "writer" of the squad "content"');
    expect(writer.task).toContain(path.join(squadDir, "agents", "writer.md"));
    expect(writer.task).toContain('the result of "strategist"');
    expect(plan.steps[0].task).toContain("the request the workflow was started with");
  });

  test("the ops are one edit_workflow call: trigger, a node per step, the person's approval, the output", () => {
    const { ops } = flowPlan("content", squadDir, squadWorkflows(squadDir)[0], { self, agents: noAgents });
    expect(ops.filter((o) => o.op === "add").map((o) => `${o.ref}:${o.kind}`)).toEqual([
      "start:trigger", "s_strategist:agent", "s_writer:agent", "s_designer:agent", "s_scheduler:agent", "approve:approval", "deliver:output",
    ]);
    const links = ops.filter((o) => o.op === "connect").map((o) => `${o.from}>${o.to}`);
    expect(links).toEqual([
      "start>s_strategist", "s_strategist>s_writer", "s_strategist>s_designer", "s_writer>s_scheduler", "s_designer>s_scheduler",
      "s_scheduler>approve", "approve>deliver",
    ]);
    expect(ops[0].fields).toEqual({ trigger: "manual" });
    expect((ops.find((o) => o.ref === "deliver")!.fields as any).target).toBe("notify");
    // A ref is always defined before an op names it.
    const seen = new Set<string>();
    for (const o of ops) {
      if (o.op === "add") seen.add(o.ref as string);
      else expect(seen.has(o.from as string) && seen.has(o.to as string)).toBe(true);
    }
  });

  test("a step runs on the host agent that carries its name, else on the agent that asked", () => {
    const agents = new Map([["writer", { id: "agent-w", name: "Writer" }]]);
    const plan = flowPlan("content", squadDir, squadWorkflows(squadDir)[0], { self, agents });
    expect(plan.steps.find((s) => s.id === "writer")!.agentId).toBe("agent-w");
    expect(plan.steps.find((s) => s.id === "designer")!.agentId).toBe("agent-prime");
    const nobody = flowPlan("content", squadDir, squadWorkflows(squadDir)[0], { self: null, agents: noAgents });
    expect(nobody.steps[0].agentId).toBeNull();
    expect((nobody.ops[1].fields as any).agentId).toContain("the id of the agent");
  });

  test("the revision changes when the squad changes", () => {
    const before = flowPlan("content", squadDir, squadWorkflows(squadDir)[0], { self, agents: noAgents }).revision;
    expect(flowPlan("content", squadDir, squadWorkflows(squadDir)[0], { self: null, agents: noAgents }).revision).toBe(before);
    fs.appendFileSync(path.join(squadDir, "agents", "writer.md"), "\nA new rule.\n");
    expect(flowPlan("content", squadDir, squadWorkflows(squadDir)[0], { self, agents: noAgents }).revision).not.toBe(before);
  });
});

describe("what the agent is told", () => {
  const dir = path.join(root, "OpenBot", "Agents", "agent-prime");
  const agent = { id: "agent-prime", dir, server: null };
  const flow = { squad: "content", workflow: "pipeline", workflowId: "wf-1", title: "content · pipeline", description: "From a theme to scheduled posts", revision: "r1" };

  test("recording writes one section, keeps the owner's text, and replaces an older record", () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "AGENTS.md"), "# Mine\n\nKeep this.\n");
    recordFlow(agent, flow);
    let text = fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8");
    expect(text.startsWith("# Mine\n\nKeep this.\n\n" + FLOWS_BLOCK_BEGIN)).toBe(true);
    expect(text).toContain("- **content · pipeline** (workflow `wf-1`): From a theme to scheduled posts");
    expect(text).toContain("run_workflow");

    recordFlow(agent, { ...flow, workflowId: "wf-2" });
    text = fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8");
    expect(text.split(FLOWS_BLOCK_BEGIN).length).toBe(2);
    expect(text).toContain("wf-2");
    expect(text).not.toContain("wf-1");
    expect(recordedFlows("agent-prime").map((f) => f.workflowId)).toEqual(["wf-2"]);
  });

  test("forgetting the last one takes the section out and leaves the owner's text", () => {
    expect(forgetFlows(agent, "other")).toEqual([]);
    expect(forgetFlows(agent, "content").map((f) => f.workflowId)).toEqual(["wf-2"]);
    expect(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8")).toBe("# Mine\n\nKeep this.\n\n");
    expect(recordedFlows("agent-prime")).toEqual([]);
    expect(flowsBlockText([])).toBe("");
  });
});
