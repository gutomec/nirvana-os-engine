// team-flow.ts — a squad's workflow as a workflow of a host that draws one
// (OpenBot by Nightly Labs): each step a node the person watches, their
// approval before the result goes out, and a trigger they can put on a clock.
//
// The squad stays the source. The engine reads the workflow the squad declares
// (`workflows/<name>.md`: steps with `id`, `agent`, `requires`) and writes the
// plan: the nodes, the links and what each step is told. It cannot create a
// workflow in OpenBot, whose database is the app's own; the agent that runs the
// command builds it with `edit_workflow`, the way `nrv team sync` names the
// agents and the agent creates them.
//
// A workflow no agent knows about is never used: OpenBot does not list
// workflows in an agent's context. So once the workflow exists, the engine
// records it in a marked section of that agent's instruction file, with when
// to run it. The section is the engine's; the rest of the file is the owner's.
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { nirvanaHome } from "./deps-home.ts";
import { openBotInstructionFile, openBotWriteInstructions, type OpenBotAgent } from "./openbot.ts";

export const FLOWS_BLOCK_BEGIN = "<!-- nirvana-os:flows:v1 -->";
export const FLOWS_BLOCK_END = "<!-- /nirvana-os:flows -->";
const FLOWS_BLOCK_RE = /<!-- nirvana-os:flows:v\d+ -->[\s\S]*?<!-- \/nirvana-os:flows -->\r?\n?/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export interface FlowStep {
  id: string;
  /** The squad agent that does the step: `agents/<agent>.md`. */
  agent: string;
  requires: string[];
}

export interface SquadWorkflow {
  name: string;
  description: string;
  file: string;
  steps: FlowStep[];
}

export interface FlowPlan {
  squad: string;
  workflow: string;
  title: string;
  description: string;
  /** Steps in an order where every step comes after the ones it requires. */
  steps: Array<FlowStep & { agentFile: string; role: string; agentId: string | null; agentName: string | null; task: string }>;
  /** The `ops` of one `edit_workflow` call that creates the whole workflow. */
  ops: Array<Record<string, unknown>>;
  /** Changes when the squad's workflow or one of its agents changes. */
  revision: string;
}

export interface RecordedFlow {
  squad: string;
  workflow: string;
  workflowId: string;
  title: string;
  description: string;
  revision: string;
}

function frontmatter(file: string): Record<string, any> {
  try {
    const doc = parseYaml(fs.readFileSync(file, "utf8").match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "");
    return doc && typeof doc === "object" ? doc as Record<string, any> : {};
  } catch { return {}; }
}

const oneLine = (v: unknown): string => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");

/** The workflows a squad declares, by file name. A file with no steps is left out. */
export function squadWorkflows(squadDir: string): SquadWorkflow[] {
  const dir = path.join(squadDir, "workflows");
  let files: string[] = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort(); } catch { return []; }
  const out: SquadWorkflow[] = [];
  for (const f of files) {
    const file = path.join(dir, f);
    const fm = frontmatter(file);
    const steps: FlowStep[] = (Array.isArray(fm.steps) ? fm.steps : []).flatMap((s: any) => {
      const id = oneLine(s?.id);
      const agent = oneLine(s?.agent) || id;
      if (!id) return [];
      const requires = (Array.isArray(s.requires) ? s.requires : Array.isArray(s.deps) ? s.deps : []).map(oneLine).filter(Boolean);
      return [{ id, agent, requires }];
    });
    if (steps.length) out.push({ name: oneLine(fm.name) || f.slice(0, -3), description: oneLine(fm.description), file, steps });
  }
  return out;
}

/** What is wrong with a workflow as a graph; empty when it can be drawn. */
export function workflowProblems(wf: SquadWorkflow, squadDir: string): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const s of wf.steps) {
    if (!ID_RE.test(s.id)) problems.push(`step "${s.id}": the id must be letters, digits, dots, hyphens or underscores`);
    if (ids.has(s.id)) problems.push(`step "${s.id}": the id is used twice`);
    ids.add(s.id);
    if (!fs.existsSync(path.join(squadDir, "agents", `${s.agent}.md`))) problems.push(`step "${s.id}": the squad has no agents/${s.agent}.md`);
  }
  for (const s of wf.steps) for (const r of s.requires) if (!ids.has(r)) problems.push(`step "${s.id}": requires "${r}", which is not a step`);
  if (!problems.length && ordered(wf.steps).length !== wf.steps.length) problems.push("the steps require each other in a circle");
  return problems;
}

/** Steps with every requirement before them; shorter than the input on a cycle. */
function ordered(steps: FlowStep[]): FlowStep[] {
  const done = new Set<string>();
  const out: FlowStep[] = [];
  for (let moved = true; moved && out.length < steps.length;) {
    moved = false;
    for (const s of steps) {
      if (done.has(s.id) || !s.requires.every((r) => done.has(r))) continue;
      done.add(s.id); out.push(s); moved = true;
    }
  }
  return out;
}

const ref = (id: string): string => `s_${id.replace(/[^A-Za-z0-9_]/g, "_")}`;

/**
 * The plan of one squad workflow as a host workflow.
 *
 * `agents` are the host's agents by lowercased name; a step whose squad agent
 * has a namesake there runs on it, and any other step runs on `self`, the
 * agent that asked for the plan. With neither, the step's agent is left for
 * whoever builds the workflow to fill in.
 */
export function flowPlan(
  squad: string, squadDir: string, wf: SquadWorkflow,
  host: { self: { id: string; name: string } | null; agents: Map<string, { id: string; name: string }> },
): FlowPlan {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(wf.file));
  const steps = ordered(wf.steps).map((s) => {
    const agentFile = path.join(squadDir, "agents", `${s.agent}.md`);
    const fm = frontmatter(agentFile);
    try { hash.update(fs.readFileSync(agentFile)); } catch { /* reported by workflowProblems */ }
    const role = oneLine(fm.name) || oneLine(fm.role) || s.agent;
    const runner = host.agents.get(s.agent.toLowerCase()) ?? host.agents.get(role.toLowerCase()) ?? host.self;
    const from = s.requires.length ? `the result of ${s.requires.map((r) => `"${r}"`).join(" and ")}` : "the request the workflow was started with";
    const task = [
      `You are the step "${s.id}" of the squad "${squad}", in its workflow "${wf.name}". Your role: ${role}.`,
      `Read ${agentFile} and work as it says. Your input is ${from}.`,
      "Do this step and nothing beyond it. Answer with the result the next step needs, complete, in the language of the request. Do not ask a question: when something is missing, decide and say what you assumed.",
    ].join(" ");
    return { ...s, agentFile, role, agentId: runner?.id ?? null, agentName: runner?.name ?? null, task };
  });

  const required = new Set(steps.flatMap((s) => s.requires));
  const last = steps.filter((s) => !required.has(s.id));
  const title = `${squad} · ${wf.name}`.slice(0, 160);
  const ops: Array<Record<string, unknown>> = [{ op: "add", ref: "start", kind: "trigger", fields: { trigger: "manual" } }];
  for (const s of steps) {
    ops.push({ op: "add", ref: ref(s.id), kind: "agent", fields: { agentId: s.agentId ?? "<the id of the agent that does this step>", task: s.task } });
    for (const from of s.requires.length ? s.requires.map(ref) : ["start"]) ops.push({ op: "connect", from, to: ref(s.id), type: "text" });
  }
  ops.push({ op: "add", ref: "approve", kind: "approval", fields: { question: `Approve the result of "${title}" before it is delivered?` } });
  for (const s of last) ops.push({ op: "connect", from: ref(s.id), to: "approve", type: "text" });
  ops.push({ op: "add", ref: "deliver", kind: "output", fields: { target: "notify" } });
  ops.push({ op: "connect", from: "approve", to: "deliver", type: "text" });

  return { squad, workflow: wf.name, title, description: wf.description, steps, ops, revision: hash.digest("hex").slice(0, 16) };
}

// ─── what an agent was told about the workflows it has ──────────────────────

function stateFile(): string {
  return path.join(nirvanaHome(), "state", "openbot-flows.json");
}

function readState(): Record<string, RecordedFlow[]> {
  try {
    const doc = JSON.parse(fs.readFileSync(stateFile(), "utf8"));
    return doc && typeof doc === "object" && !Array.isArray(doc) ? doc as Record<string, RecordedFlow[]> : {};
  } catch { return {}; }
}

function writeState(state: Record<string, RecordedFlow[]>): void {
  const file = stateFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state, null, 2) + "\n", "utf8");
}

/** The workflows recorded for one agent. */
export function recordedFlows(agentId: string): RecordedFlow[] {
  return (readState()[agentId] ?? []).filter((f) => f && typeof f.workflowId === "string");
}

/** The section the engine keeps in the agent's instruction file; "" with no workflow. */
export function flowsBlockText(flows: RecordedFlow[]): string {
  if (!flows.length) return "";
  return [
    FLOWS_BLOCK_BEGIN,
    "## Workflows built from Nirvana-OS squads",
    "",
    "The Nirvana-OS engine wrote this section and keeps it current. Each line is a workflow of this computer, built from a squad of your owner's library. When the person asks for what a line describes, run that workflow instead of doing the work yourself: `run_workflow` with the request, in the person's words, as its input. A step that runs on you waits in your own queue until your turn ends, so do not wait for the run: say it started, that it stops for the person's approval in OpenBot before delivering, and end your turn. When asked how it went, read it with `read_workflow_runs` and report what each step did. Run one only in a turn the person started.",
    "",
    ...flows.map((f) => `- **${f.title}** (workflow \`${f.workflowId}\`): ${f.description || `the squad ${f.squad}, workflow ${f.workflow}`}`),
    FLOWS_BLOCK_END,
    "",
  ].join("\n");
}

function withFlowsBlock(text: string, block: string): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const wanted = block.split("\n").join(eol);
  if (FLOWS_BLOCK_RE.test(text)) return text.replace(FLOWS_BLOCK_RE, wanted);
  if (!wanted) return text;
  const body = text.replace(/\s+$/, "");
  return body ? `${body}${eol}${eol}${wanted}` : wanted;
}

function writeBlock(agent: OpenBotAgent, flows: RecordedFlow[]): void {
  const file = openBotInstructionFile(agent.dir);
  const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const next = withFlowsBlock(current, flowsBlockText(flows));
  if (next !== current) openBotWriteInstructions(file, next);
}

/** Record a workflow the agent built, replacing an older record of the same squad workflow. */
export function recordFlow(agent: OpenBotAgent, flow: RecordedFlow): RecordedFlow[] {
  const state = readState();
  const flows = (state[agent.id] ?? []).filter((f) => !(f.squad === flow.squad && f.workflow === flow.workflow));
  flows.push(flow);
  flows.sort((a, b) => a.title.localeCompare(b.title));
  state[agent.id] = flows;
  writeState(state);
  writeBlock(agent, flows);
  return flows;
}

/** Take a squad's workflows out of the agent's section; the host's workflow itself stays. */
export function forgetFlows(agent: OpenBotAgent, squad: string, workflow?: string): RecordedFlow[] {
  const state = readState();
  const all = state[agent.id] ?? [];
  const gone = all.filter((f) => f.squad === squad && (!workflow || f.workflow === workflow));
  if (!gone.length) return [];
  const kept = all.filter((f) => !gone.includes(f));
  if (kept.length) state[agent.id] = kept; else delete state[agent.id];
  writeState(state);
  writeBlock(agent, kept);
  return gone;
}
