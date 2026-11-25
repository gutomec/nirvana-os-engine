#!/usr/bin/env bun
// team.ts — `nrv team`: a team of agents built from the library, for a host
// that shows each agent working (OpenBot) or loads agents per project (Claude
// Code). Written for an agent to run: every answer says what to do next.
//
//   nrv team candidates "<request>"     businesses that fit, with their roles and clones
//   nrv team init <slug> ["<purpose>"]  write the team.yaml skeleton (--here: in this project)
//   nrv team sync                       validate, compile and write the team where the host reads it
//   nrv team status                     the team and where each member is
//   nrv team remove                     take the team's instructions out of the hosts; agents and files stay
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
import { releaseOpenBot, syncClaudeCode, syncOpenBot, teamOfText, writeNeutral } from "../../_shared/lib/team-hosts.ts";

const USAGE = [
  "usage: nrv team <command> [--team <slug> | --dir <folder>]",
  '  candidates "<request>"      businesses that fit the request, with their roles and clones',
  '  init <slug> ["<purpose>"]   write the team.yaml skeleton (--here: in the current project)',
  "  sync [--host <h>]           validate, compile and write the team; host: openbot, claude-code or auto",
  "  status                      the team and where each member is",
  "  remove                      take the team's instructions out of the hosts; agents and files stay",
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

function pickHost(dir: string): "openbot" | "claude-code" | "neutral" {
  const asked = typeof flags.host === "string" ? flags.host : "auto";
  if (asked === "openbot" || asked === "claude-code" || asked === "neutral") return asked;
  if (asked !== "auto") fail("team: --host is openbot, claude-code, neutral or auto", EXIT.INVALID_ARGS);
  // Whoever runs the command says where the team goes: an OpenBot agent wants
  // OpenBot teammates; anyone else in a project folder wants project agents.
  if (openBotAgentAt(process.cwd())) return "openbot";
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
  } else {
    say();
    say("No host was written: this command was not run by an OpenBot agent or inside a project folder.");
    say("  --host openbot       the OpenBot agents that carry the members' names");
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
    const where = [
      openbot.has(m.name.toLowerCase()) && `OpenBot ${openbot.get(m.name.toLowerCase())}`,
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
  say(`Team ${spec.team}: its instructions were taken out of ${released.length} OpenBot agent(s) and ${removed.length} Claude Code subagent file(s).`);
  for (const a of released) say(`  - OpenBot ${a.id}: the agent stays; delete it in OpenBot if it is no longer wanted.`);
  say(`The team file stays: ${teamFileOf(dir)}`);
  emitAudit({ event: "x_team_removed", team: spec.team, openbot_agents: released.length, claude_code_files: removed.length, team_dir: dir });
}

switch (cmd) {
  case "candidates": await candidates(rest.join(" ").trim()); break;
  case "init": init(rest[0], rest.slice(1).join(" ").trim()); break;
  case "sync": sync(); break;
  case "status": status(); break;
  case "remove": remove(); break;
  default:
    console.error(USAGE);
    process.exit(cmd && cmd !== "help" ? EXIT.INVALID_ARGS : EXIT.OK);
}
