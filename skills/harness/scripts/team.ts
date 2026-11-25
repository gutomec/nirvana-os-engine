#!/usr/bin/env bun
// team.ts — `nrv team`: a team of agents built from the library, for a host
// that shows each agent working (OpenBot, Hermes Bot Mode) or loads agents per
// project (Claude Code). Written for an agent to run: every answer says what to do next.
//
//   nrv team candidates "<request>"     businesses that fit, with their roles and clones
//   nrv team init <slug> ["<purpose>"]  write the team.yaml skeleton (--here: in this project)
//   nrv team sync                       validate, compile and write the team where the host reads it
//   nrv team status                     the team and where each member is
//   nrv team remove                     take the team's instructions out of the hosts; agents and files stay
//   nrv team flow <squad>               a squad's workflow as a host workflow: the plan, then the record
//
// A team is found by `--dir <folder>`, by `--team <slug>` (under ~/.nirvana/teams)
// or, with neither, in the current folder's `.nirvana/team.yaml`.
// Nothing here runs unless asked for: `nrv dispatch` never reads a team.
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { parse as parseYaml } from "yaml";
import { EXIT, parseArgs } from "../../_shared/lib/bun-helpers.ts";
import { emitAudit } from "../../_shared/lib/audit-emit.ts";
import { findCloneForTask } from "../../_shared/lib/clone-search.ts";
import { listOpenBotAgents, openBotAgentAt, openBotAgentLabels, openBotInstructionFile } from "../../_shared/lib/openbot.ts";
import { enumerate, resolveScope } from "../../_shared/lib/scope.ts";
import {
  loadTeam, scopeLibrary, teamFileOf, teamHomeDir, teamSkeleton, TEAM_SLUG_RE, type TeamMember, type TeamSpec,
} from "../../_shared/lib/team.ts";
import { hermesMemberId, releaseHermes, releaseOpenBot, syncClaudeCode, syncHermes, syncOpenBot, teamOfText, writeNeutral } from "../../_shared/lib/team-hosts.ts";
import { hermesBinary, hermesProfileDir, hermesSoulFile, insideHermes } from "../../_shared/lib/hermes-bots.ts";
import { flowPlan, forgetFlows, recordFlow, recordedFlows, squadWorkflows, workflowProblems } from "../../_shared/lib/team-flow.ts";

const USAGE = [
  "usage: nrv team <command> [--team <slug> | --dir <folder>]",
  '  candidates "<request>"      businesses that fit the request, with their roles and clones',
  '  init <slug> ["<purpose>"]   write the team.yaml skeleton (--here: in the current project)',
  "  sync [--host <h>]           validate, compile and write the team; host: openbot, hermes, claude-code or auto",
  "  sync --host hermes --create create the Hermes Bots the team has no profile for yet",
  "  status                      the team and where each member is",
  "  remove                      take the team's instructions out of the hosts; agents and files stay",
  "  flow <squad> [--workflow <name>]            the plan of a squad's workflow as an OpenBot workflow",
  "  flow <squad> --created <workflowId>         record the workflow you built, so you know when to run it",
  "  flow --list | flow <squad> --forget         the workflows recorded for you; stop using one",
].join("\n");

const { positional, flags } = parseArgs();
const [cmd, ...rest] = positional;
const say = (line = "") => console.log(line);
const fail = (line: string, code: number = EXIT.FAILURES): never => { console.error(line); process.exit(code); };

/** The folder that holds `.nirvana/team.yaml`. */
function teamDir(): string {
  if (typeof flags.dir === "string") return path.resolve(flags.dir);
  if (typeof flags.team === "string") {
    if (!TEAM_SLUG_RE.test(flags.team)) fail(`team: "${flags.team}" is not a team slug`, EXIT.INVALID_ARGS);
    return teamHomeDir(flags.team);
  }
  return process.cwd();
}

function loadOrFail(dir: string): TeamSpec {
  const file = teamFileOf(dir);
  if (!fs.existsSync(file)) {
    fail([
      `team: no team here (${file} does not exist).`,
      'Start one with: nrv team init <slug> "<what the team is for>"',
      "Then name it in each command: --team <slug>",
    ].join("\n"));
  }
  const { spec, problems } = loadTeam(file, scopeLibrary(dir));
  if (!spec || problems.length) {
    console.error(`team: ${file} has ${problems.length} problem(s). Nothing was written.`);
    for (const p of problems) console.error(`  - ${p}`);
    console.error("Fix the file and run the command again.");
    process.exit(EXIT.FAILURES);
  }
  return spec!;
}

const tierLine = (spec: TeamSpec, m: TeamMember): string => {
  const model = spec.models[m.tier];
  const parts = [model?.provider, model?.model, model?.effort && `effort ${model.effort}`].filter(Boolean);
  return parts.length ? parts.join(", ") : "your own provider and model";
};
const roleOf = (m: TeamMember): string => (m.expert ? `expert-x: ${m.expert.role}` : m.role_from!);

// ── candidates ───────────────────────────────────────────────────────

async function candidates(request: string): Promise<void> {
  if (!request) fail('usage: nrv team candidates "<request>"', EXIT.INVALID_ARGS);
  const require_ = createRequire(import.meta.url);
  const loader = require_(path.join(import.meta.dir, "..", "lib", "registry-loader.js"));
  const { preflightReindex } = await import("../lib/preflight-index.ts");
  const { shortlist } = await import("../lib/shortlist.ts");
  preflightReindex();
  const list = await shortlist(request, loader.loadAll(), { size: Number(flags.limit) || 6 });
  const dirs = new Map(enumerate(resolveScope(), "businesses").filter((e) => !e.overridden).map((e) => [e.slug, e.dir]));

  say(`request: ${request}`);
  say();
  say("Businesses whose roles may fit, best first. This list is a keyword search: read it, drop what does not");
  say("belong, and look at `nrv list-businesses` when a part of the request has no business here.");
  for (const b of list.businesses) {
    const dir = dirs.get(b.slug);
    if (!dir) continue;
    say();
    say(`business:${b.slug}`);
    let files: string[] = [];
    try { files = fs.readdirSync(path.join(dir, "employees")).filter((f) => f.endsWith(".md")).sort(); } catch { /* a business with no employees folder */ }
    for (const f of files) {
      let fm: any = {};
      try { fm = parseYaml(fs.readFileSync(path.join(dir, "employees", f), "utf8").match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "") ?? {}; } catch { /* listed by its slug alone */ }
      const clones = Array.isArray(fm.assigned_mind_clones) ? fm.assigned_mind_clones.filter((c: unknown) => typeof c === "string") : [];
      const marks = [!fm.reports_to && "top of its business", (fm.is_antagonist || fm.type === "antagonist_gate") && "reviewer"].filter(Boolean);
      say(`  ${b.slug}/${f.slice(0, -3)} | ${String(fm.role ?? "").replace(/\s+/g, " ").trim() || "-"}${clones.length ? ` | clones: ${clones.join(", ")}` : ""}${marks.length ? ` | ${marks.join(", ")}` : ""}`);
    }
  }
  const clones = findCloneForTask(request, { limit: 6, gated: true });
  say();
  say(clones.length
    ? `Mind-clones that cover the request: ${clones.map((c) => `${c.slug} (${c.coverage.matched}/${c.coverage.total})`).join(", ")}`
    : "No mind-clone covers the request as a whole. Search per role: nrv find-clone \"<what the role needs>\". No clone is better than a wrong one.");
  say();
  say("Next:");
  say('  1. nrv team init <slug> "<what the team is for>"');
  say("  2. Edit the team.yaml it names: a member per role you need (role_from: <business>/<employee>), a clone only");
  say("     when it fits, and an `expert` card (role, delivers, done_when) for a role no business has.");
  say("     Start small: the orchestrator, the leads the request needs and a reviewer.");
  say("  3. nrv team sync --team <slug>");
}

// ── init ─────────────────────────────────────────────────────────────

function init(slug: string, purpose: string): void {
  if (!TEAM_SLUG_RE.test(slug || "")) fail('usage: nrv team init <slug> ["<purpose>"] [--here]   (slug: lowercase letters, digits, hyphens)', EXIT.INVALID_ARGS);
  const here = Boolean(flags.here);
  if (here && openBotAgentAt(process.cwd())) fail("team: this folder is an OpenBot agent's workspace, not a project. Run it without --here.");
  const dir = here ? process.cwd() : teamHomeDir(slug);
  const file = teamFileOf(dir);
  if (fs.existsSync(file)) fail(`team: ${file} already exists. Edit it, or pick another slug.`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, teamSkeleton(slug, purpose), "utf8");
  say(`Team file written: ${file}`);
  say("Edit it, then run:");
  say(here ? "  nrv team sync" : `  nrv team sync --team ${slug}`);
}

// ── sync ─────────────────────────────────────────────────────────────

function pickHost(dir: string): "openbot" | "hermes" | "claude-code" | "neutral" {
  const asked = typeof flags.host === "string" ? flags.host : "auto";
  if (asked === "openbot" || asked === "hermes" || asked === "claude-code" || asked === "neutral") return asked;
  if (asked !== "auto") fail("team: --host is openbot, hermes, claude-code, neutral or auto", EXIT.INVALID_ARGS);
  // Whoever runs the command says where the team goes: an OpenBot agent wants
  // OpenBot teammates; anyone else in a project folder wants project agents.
  if (openBotAgentAt(process.cwd())) return "openbot";
  if (insideHermes()) return "hermes";
  if (dir === process.cwd() || typeof flags.dir === "string") return "claude-code";
  return "neutral";
}

function sync(): void {
  const dir = teamDir();
  const spec = loadOrFail(dir);
  const lib = scopeLibrary(dir);
  const host = pickHost(dir);
  const neutral = writeNeutral(spec, dir, lib);
  const boss = spec.members.find((m) => m.id === spec.orchestrator)!;
  say(`Team ${spec.display_name} (${spec.team}): ${spec.members.length} member(s), orchestrator ${boss.name}.`);
  say(`Each member's instructions: ${neutral}`);
  say(`Project folders go under: ${spec.output_root}`);
  let missing = 0;

  if (host === "claude-code") {
    const r = syncClaudeCode(spec, dir, lib);
    say();
    say(`Claude Code: ${r.written.length} subagent(s) in ${path.join(dir, ".claude", "agents")}${r.removed.length ? `, ${r.removed.length} stale removed` : ""}.`);
    for (const m of spec.members) if (m.id !== spec.orchestrator) say(`  - ${spec.team}-${m.id}: ${m.name} (${roleOf(m)})`);
    say();
    say("Next:");
    say(`  The main session is the orchestrator. Read ${r.director} and run the project as it says.`);
    say("  A session already open loads the new subagents the next time the project is opened.");
  } else if (host === "openbot") {
    const r = syncOpenBot(spec, lib);
    missing = r.missing.length;
    say();
    say(`OpenBot: ${r.written.length} of ${spec.members.length} member(s) have their agent and instructions.`);
    for (const w of r.written) say(`  ✓ ${w.member.name} → ${w.agent.id}`);
    for (const t of r.taken) say(`  ✗ ${t.member.name}: an agent of that name is in the team "${t.team}". Rename the member in team.yaml, or remove that team first (nrv team remove --team ${t.team}).`);
    for (const f of r.failed) say(`  ✗ ${f.name}: its instruction file could not be written.`);
    for (const a of r.released) say(`  - ${a.id}: no longer a member; this team's instructions were taken out. The agent stays.`);
    say();
    say("Next:");
    if (r.missing.length) {
      say("  1. Tell the person which agents you are about to create, then create them with create_agent, with exactly these names.");
      say('     First task of each: "Answer only: ready."');
      for (const m of r.missing) say(`       - name "${m.name}" | title "${roleOf(m).slice(0, 80)}" | ${tierLine(spec, m)}`);
      say(`  2. Run this command again: it writes their instructions. An agent has no instructions until then.`);
    } else if (r.taken.length || r.failed.length) {
      say("  Fix the members marked ✗ above and run this command again.");
    } else {
      const agent = r.written.find((w) => w.member.id === spec.orchestrator)!.agent;
      say(`  The team is ready. Send the request, in the person's own words, to ${boss.name} (${agent.id}) with send_message, expectsReply true.`);
      say("  It runs the project to the delivery and answers you; pass its answer and the project folder's path to the person.");
      say("  When the project ends, the person can hide the agents in OpenBot: a hidden agent keeps working when called.");
    }
  } else if (host === "hermes") {
    if (flags.create && !hermesBinary()) fail("team: the hermes command is not installed, so no Bot can be created. Install Hermes Agent and run this again.");
    const r = syncHermes(spec, lib, { create: Boolean(flags.create) });
    missing = r.missing.length;
    say();
    say(`Hermes: ${r.written.length} of ${spec.members.length} member(s) are Bots with their instructions.`);
    for (const w of r.written) say(`  ✓ ${w.member.name} → @${w.id}${w.created ? " (created)" : ""}`);
    for (const f of r.failed) say(`  ✗ ${f.member.name} (${f.id}): ${f.reason}`);
    for (const id of r.released) say(`  - ${id}: no longer a member; this team's instructions were taken out. The profile stays.`);
    say();
    say("Next:");
    if (r.missing.length) {
      say("  1. Tell the person which Bots are about to be created in their Hermes:");
      for (const x of r.missing) say(`       - "${x.member.name}" (profile ${x.id}) | ${roleOf(x.member).slice(0, 80)} | ${tierLine(spec, x.member)}`);
      say("  2. Run this command again with --create. Each Bot is a new Hermes profile that takes its model and keys from the person's own profile.");
    } else if (r.failed.length) {
      say("  Fix the members marked ✗ above and run this command again.");
    } else {
      const id = hermesMemberId(spec, boss);
      say(`  The team is ready. The orchestrator is ${boss.name} (@${id}).`);
      say("  With Hermes Desktop: the Bots are in the Bots roster; the person opens the orchestrator's Bot Chat and sends the request there.");
      say(`  From a terminal, in the folder the project should use: hermes -p ${id} -z "<the request, in the person's own words>"`);
      say("  A Bot that should use another model: hermes -p <profile> model");
    }
  } else {
    say();
    say("No host was written: this command was not run by an OpenBot or Hermes agent, or inside a project folder.");
    say("  --host openbot       the OpenBot agents that carry the members' names");
    say("  --host hermes        one Bot of Hermes Agent's Bot Mode per member");
    say("  --host claude-code   subagents of the project in --dir <folder>");
  }
  emitAudit({ event: "x_team_synced", team: spec.team, host, members: spec.members.length, missing, team_dir: dir });
}

// ── status / remove ──────────────────────────────────────────────────

function status(): void {
  const dir = teamDir();
  const spec = loadOrFail(dir);
  say(`Team ${spec.display_name} (${spec.team}) — ${teamFileOf(dir)}`);
  if (spec.purpose) say(`  ${spec.purpose.replace(/\s+/g, " ")}`);
  const labels = openBotAgentLabels();
  const agents = listOpenBotAgents().filter((a) => a.server === null);
  const openbot = new Map<string, string>();
  for (const a of agents) {
    const name = labels.get(a.id)?.name;
    if (!name) continue;
    let text = "";
    try { text = fs.readFileSync(openBotInstructionFile(a.dir), "utf8"); } catch { /* no file */ }
    if (teamOfText(text) === spec.team) openbot.set(name.toLowerCase(), a.id);
  }
  for (const m of spec.members) {
    const marks = [m.id === spec.orchestrator && "orchestrator", m.id === spec.reviewer && "reviewer", m.reports_to && `answers to ${m.reports_to}`].filter(Boolean).join(", ");
    let soul = "";
    try { soul = fs.readFileSync(hermesSoulFile(hermesProfileDir(hermesMemberId(spec, m))), "utf8"); } catch { /* no such Bot */ }
    const where = [
      openbot.has(m.name.toLowerCase()) && `OpenBot ${openbot.get(m.name.toLowerCase())}`,
      teamOfText(soul) === spec.team && `Hermes @${hermesMemberId(spec, m)}`,
      m.id !== spec.orchestrator && fs.existsSync(path.join(dir, ".claude", "agents", `${spec.team}-${m.id}.md`)) && `Claude Code ${spec.team}-${m.id}`,
    ].filter(Boolean).join(", ") || "not on a host yet";
    say(`  ${m.name} [${m.id}] ${roleOf(m)}${m.clones.length ? ` + ${m.clones.join(", ")}` : ""}${marks ? ` — ${marks}` : ""} — ${where}`);
  }
}

function remove(): void {
  const dir = teamDir();
  const spec = loadOrFail(dir);
  const released = releaseOpenBot(spec.team);
  const agentsDir = path.join(dir, ".claude", "agents");
  const removed: string[] = [];
  let present: string[] = [];
  try { present = fs.readdirSync(agentsDir); } catch { /* none */ }
  for (const f of present) {
    if (!f.startsWith(`${spec.team}-`) || !f.endsWith(".md")) continue;
    const file = path.join(agentsDir, f);
    try { if (teamOfText(fs.readFileSync(file, "utf8")) === spec.team) { fs.rmSync(file, { force: true }); removed.push(file); } } catch { /* not ours */ }
  }
  const hermes = releaseHermes(spec.team);
  say(`Team ${spec.team}: its instructions were taken out of ${released.length} OpenBot agent(s), ${hermes.length} Hermes Bot(s) and ${removed.length} Claude Code subagent file(s).`);
  for (const a of released) say(`  - OpenBot ${a.id}: the agent stays; delete it in OpenBot if it is no longer wanted.`);
  for (const id of hermes) say(`  - Hermes ${id}: the profile stays; the person deletes it with \`hermes profile delete ${id}\` if it is no longer wanted.`);
  say(`The team file stays: ${teamFileOf(dir)}`);
  emitAudit({ event: "x_team_removed", team: spec.team, openbot_agents: released.length, hermes_bots: hermes.length, claude_code_files: removed.length, team_dir: dir });
}

// ── flow ─────────────────────────────────────────────────────────────

function flow(squad: string | undefined): void {
  const self = openBotAgentAt(process.cwd());
  const labels = openBotAgentLabels();
  const nameOf = (id: string): string => labels.get(id)?.name ?? id;

  if (flags.list) {
    if (!self) fail("team flow: run this from an OpenBot agent's workspace; workflows are recorded per agent.");
    const flows = recordedFlows(self!.id);
    if (!flows.length) { say("No workflow built from a squad is recorded for you."); return; }
    const squads = new Map(enumerate(resolveScope(), "squads").filter((e) => !e.overridden).map((e) => [e.slug, e.dir]));
    say(`Workflows recorded for you (${flows.length}):`);
    for (const f of flows) {
      const dir = squads.get(f.squad);
      const wf = dir ? squadWorkflows(dir).find((w) => w.name === f.workflow) : undefined;
      const state = !dir ? "the squad is no longer installed"
        : !wf ? "the squad no longer declares this workflow"
        : flowPlan(f.squad, dir, wf, { self: null, agents: new Map() }).revision === f.revision ? "current"
        : `the squad changed since: run nrv team flow ${f.squad} --workflow ${f.workflow} and apply it to the workflow`;
      say(`  ${f.title} (workflow ${f.workflowId}): ${state}`);
    }
    return;
  }

  if (!squad) fail(USAGE, EXIT.INVALID_ARGS);
  if (flags.forget) {
    if (!self) fail("team flow: run this from an OpenBot agent's workspace.");
    const gone = forgetFlows(self!, squad!, typeof flags.workflow === "string" ? flags.workflow : undefined);
    if (!gone.length) { say(`Nothing recorded for you from the squad ${squad}.`); return; }
    for (const f of gone) say(`No longer in your instructions: ${f.title} (workflow ${f.workflowId}). The workflow itself stays in OpenBot; delete it there when the person asks.`);
    emitAudit({ event: "x_flow_forgotten", host: "openbot", squad, agent_id: self!.id, workflows: gone.length });
    return;
  }

  const entry = enumerate(resolveScope(), "squads").find((e) => e.slug === squad && !e.overridden);
  if (!entry) fail(`team flow: no squad "${squad}" in the library. See them: nrv list-squads`);
  const workflows = squadWorkflows(entry!.dir);
  if (!workflows.length) fail(`team flow: the squad ${squad} declares no workflow with steps (${path.join(entry!.dir, "workflows")}). It runs as one piece: nrv dispatch --squad=${squad} "<brief>" --exec`);
  const wanted = typeof flags.workflow === "string" ? flags.workflow : null;
  const wf = wanted ? workflows.find((w) => w.name === wanted) : workflows.length === 1 ? workflows[0] : null;
  if (!wf) {
    console.error(wanted ? `team flow: the squad ${squad} has no workflow "${wanted}".` : `team flow: the squad ${squad} declares ${workflows.length} workflows. Name one with --workflow:`);
    for (const w of workflows) console.error(`  ${w.name} (${w.steps.length} steps)${w.description ? `: ${w.description}` : ""}`);
    process.exit(EXIT.INVALID_ARGS);
  }
  const problems = workflowProblems(wf!, entry!.dir);
  if (problems.length) {
    console.error(`team flow: ${wf!.file} cannot be drawn as a workflow. Nothing was written.`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(EXIT.FAILURES);
  }

  const agents = new Map<string, { id: string; name: string }>();
  for (const a of listOpenBotAgents().filter((x) => x.server === null)) {
    const name = labels.get(a.id)?.name;
    if (name) agents.set(name.toLowerCase(), { id: a.id, name });
  }
  const plan = flowPlan(squad!, entry!.dir, wf!, { self: self ? { id: self.id, name: nameOf(self.id) } : null, agents });

  if (typeof flags.created === "string") {
    if (!self) fail("team flow: run --created from the workspace of the OpenBot agent that built the workflow.");
    recordFlow(self!, { squad: squad!, workflow: plan.workflow, workflowId: flags.created, title: plan.title, description: plan.description, revision: plan.revision });
    say(`Recorded: ${plan.title} is the workflow ${flags.created}.`);
    say(`Your instruction file now says when to run it: ${openBotInstructionFile(self!.dir)}`);
    say("Tell the person the workflow is in OpenBot's Workflows page, that it waits for their approval before delivering, and that they can give its trigger a schedule there.");
    say("When you run it, do not wait for it in the same turn: a step that runs on you starts only after your turn ends.");
    emitAudit({ event: "x_flow_recorded", host: "openbot", squad, workflow: plan.workflow, workflow_id: flags.created, agent_id: self!.id, steps: plan.steps.length });
    return;
  }

  if (flags.json) { console.log(JSON.stringify({ ok: true, ...plan })); return; }
  say(`Workflow plan: ${plan.title}`);
  if (plan.description) say(plan.description);
  say();
  say(`Steps (${plan.steps.length}), each after the ones it requires:`);
  for (const s of plan.steps) {
    say(`  ${s.id} — ${s.role} — runs on ${s.agentName ? `${s.agentName} (${s.agentId})` : "an agent you choose"}${s.requires.length ? ` — after ${s.requires.join(", ")}` : " — first"}`);
  }
  say("Then the person approves, and the result is delivered to them.");
  say();
  say("Build it with one call (only in a turn the person started):");
  say(`  edit_workflow { "title": ${JSON.stringify(plan.title)}, "tidy": true, "ops": <the ops below> }`);
  say(JSON.stringify(plan.ops, null, 2));
  say();
  if (!self) say("This was not run by an OpenBot agent, so no agent was chosen for the steps: put an agent id in each agentId.");
  say("If the tool refuses a field, fix that field as its message says and call it again; keep the steps and their order.");
  say("When it answers with the workflow id, record it so you know when to run it:");
  say(`  nrv team flow ${squad} --workflow ${plan.workflow} --created <workflowId>`);
}

switch (cmd) {
  case "flow": flow(rest[0]); break;
  case "candidates": await candidates(rest.join(" ").trim()); break;
  case "init": init(rest[0], rest.slice(1).join(" ").trim()); break;
  case "sync": sync(); break;
  case "status": status(); break;
  case "remove": remove(); break;
  default:
    console.error(USAGE);
    process.exit(cmd && cmd !== "help" ? EXIT.INVALID_ARGS : EXIT.OK);
}
