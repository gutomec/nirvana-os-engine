// team-hosts.ts — a compiled team (team.ts) written where a host reads it.
//
//   neutral      <teamDir>/.nirvana/team/members/<id>.md, always: the copy any
//                host can be pointed at (an OpenMausBot bot's instructions, a
//                person reading what a member was told).
//   claude-code  <projectDir>/.claude/agents/<team>-<id>.md, one subagent per
//                member, which Claude Code loads when it opens the project. The
//                orchestrator is the main session: its instructions go to
//                <projectDir>/.nirvana/team/director.md.
//   openbot      one marked section in the AGENTS.md of the OpenBot agent that
//                carries the member's name. The engine cannot create an OpenBot
//                agent (they live in the app's database, which it only reads):
//                it reports the members with no agent, for the host's own agent
//                to create.
//   hermes       one Bot of Hermes Agent's Bot Mode per member: the profile
//                `<team>-<member id>`, the member's instructions in a marked
//                section of its SOUL.md, and its name and role in the roster.
//                A profile is created with `hermes profile create`, and only
//                when the caller asks for it.
//
// The engine owns its marked section and its generated files, and nothing else.
// A member taken out of team.yaml has its section or its file removed; the
// OpenBot agent itself is never deleted.
import * as fs from "node:fs";
import * as path from "node:path";
import {
  listOpenBotAgents, openBotAgentLabels, openBotInstructionFile, openBotReleaseFromTeam, openBotReserveForTeam, openBotWriteInstructions,
  type OpenBotAgent,
} from "./openbot.ts";
import {
  createHermesProfile, HERMES_PROFILE_ID_RE, hermesProfileDir, hermesSoulFile, listHermesProfiles, markHermesBot,
} from "./hermes-bots.ts";
import { compileMember, type TeamLibrary, type TeamMember, type TeamSpec } from "./team.ts";

const TEAM_BLOCK_RE = /<!-- nirvana-os:team:v\d+ ([a-z0-9-]+) -->[\s\S]*?<!-- \/nirvana-os:team -->\r?\n?/;
const begin = (team: string) => `<!-- nirvana-os:team:v1 ${team} -->`;
const END = "<!-- /nirvana-os:team -->";

/** The team whose section a text carries, or null. */
export function teamOfText(text: string): string | null {
  return TEAM_BLOCK_RE.exec(text)?.[1] ?? null;
}

function writeFile(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, "utf8");
}

/** The host-neutral copy of every member's instructions. Returns the folder. */
export function writeNeutral(spec: TeamSpec, teamDir: string, lib: TeamLibrary): string {
  const dir = path.join(teamDir, ".nirvana", "team", "members");
  fs.mkdirSync(dir, { recursive: true });
  const keep = new Set(spec.members.map((m) => `${m.id}.md`));
  for (const m of spec.members) writeFile(path.join(dir, `${m.id}.md`), compileMember(spec, m, { host: "neutral", lib }));
  for (const f of fs.readdirSync(dir)) if (f.endsWith(".md") && !keep.has(f)) fs.rmSync(path.join(dir, f), { force: true });
  return dir;
}

// ── Claude Code ──────────────────────────────────────────────────────

export interface ClaudeCodeSync { written: string[]; removed: string[]; director: string }

const yamlLine = (v: string) => JSON.stringify(v.replace(/\s+/g, " ").trim());

function subagentDescription(spec: TeamSpec, m: TeamMember): string {
  const what = m.expert ? m.expert.role : `the role ${m.role_from}`;
  const voice = m.clones.length ? `, with the method of ${m.clones.join(" and ")}` : "";
  return `${m.name} of the team ${spec.display_name}: ${what}${voice}.${m.focus ? ` ${m.focus}` : ""} Use for the parts of a project that belong to this role.`;
}

/** One subagent file per member under `.claude/agents`, and the orchestrator's instructions for the main session. */
export function syncClaudeCode(spec: TeamSpec, projectDir: string, lib: TeamLibrary): ClaudeCodeSync {
  const dir = path.join(projectDir, ".claude", "agents");
  const prefix = `${spec.team}-`;
  const written: string[] = [];
  const keep = new Set<string>();
  for (const m of spec.members) {
    if (m.id === spec.orchestrator) continue;
    const name = `${prefix}${m.id}`;
    const file = path.join(dir, `${name}.md`);
    keep.add(path.basename(file));
    writeFile(file, [
      "---",
      `name: ${name}`,
      `description: ${yamlLine(subagentDescription(spec, m))}`,
      "---",
      begin(spec.team),
      compileMember(spec, m, { host: "claude-code", lib }).trimEnd(),
      END,
      "",
    ].join("\n"));
    written.push(file);
  }
  // Only files this team generated are removed: the marker names the team.
  const removed: string[] = [];
  let present: string[] = [];
  try { present = fs.readdirSync(dir); } catch { /* no agents folder: nothing stale */ }
  for (const f of present) {
    if (!f.startsWith(prefix) || !f.endsWith(".md") || keep.has(f)) continue;
    const file = path.join(dir, f);
    try { if (teamOfText(fs.readFileSync(file, "utf8")) === spec.team) { fs.rmSync(file, { force: true }); removed.push(file); } } catch { /* unreadable: not ours to remove */ }
  }
  const director = path.join(projectDir, ".nirvana", "team", "director.md");
  const boss = spec.members.find((m) => m.id === spec.orchestrator)!;
  const ref = (m: TeamMember) => (m.id === spec.orchestrator ? `**${m.name}**` : `**${m.name}** (subagent \`${prefix}${m.id}\`)`);
  writeFile(director, compileMember(spec, boss, { host: "claude-code", lib, ref }));
  return { written, removed, director };
}

// ── OpenBot ──────────────────────────────────────────────────────────

export interface OpenBotSync {
  /** Members whose agent exists and now carries their instructions. */
  written: Array<{ member: TeamMember; agent: OpenBotAgent }>;
  /** Members with no agent of that name: the host's agent creates them. */
  missing: TeamMember[];
  /** Members whose name belongs to an agent that is in another team. */
  taken: Array<{ member: TeamMember; team: string }>;
  /** Agents that carried this team's section and are no longer members. */
  released: OpenBotAgent[];
  /** Members whose file could not be written. */
  failed: TeamMember[];
}

function withTeamBlock(text: string, block: string): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const wanted = block.split("\n").join(eol);
  if (TEAM_BLOCK_RE.test(text)) return text.replace(TEAM_BLOCK_RE, () => wanted);
  const body = text.replace(/\s+$/, "");
  return body ? `${body}${eol}${eol}${wanted}` : wanted;
}

/** Write each member's section into the OpenBot agent that has its name. */
export function syncOpenBot(spec: TeamSpec, lib: TeamLibrary, home?: string): OpenBotSync {
  const labels = openBotAgentLabels(home);
  // This computer's own agents only: a local server's agents have their own owner.
  const agents = listOpenBotAgents(home).filter((a) => a.server === null);
  const byName = new Map<string, OpenBotAgent>();
  for (const a of agents) {
    const name = labels.get(a.id)?.name;
    if (name && !byName.has(name.toLowerCase())) byName.set(name.toLowerCase(), a);
  }
  const read = (a: OpenBotAgent): string => { try { return fs.readFileSync(openBotInstructionFile(a.dir), "utf8"); } catch { return ""; } };

  const out: OpenBotSync = { written: [], missing: [], taken: [], released: [], failed: [] };
  const mine = new Map<string, OpenBotAgent>();
  for (const m of spec.members) {
    const agent = byName.get(m.name.toLowerCase());
    if (!agent) { out.missing.push(m); continue; }
    const other = teamOfText(read(agent));
    if (other && other !== spec.team) { out.taken.push({ member: m, team: other }); continue; }
    mine.set(m.id, agent);
  }
  const ref = (m: TeamMember) => (mine.has(m.id) ? `**${m.name}** (\`${mine.get(m.id)!.id}\`)` : `**${m.name}**`);
  openBotReserveForTeam([...mine.values()], home);
  for (const m of spec.members) {
    const agent = mine.get(m.id);
    if (!agent) continue;
    const block = `${begin(spec.team)}\n${compileMember(spec, m, { host: "openbot", lib, ref }).trimEnd()}\n${END}\n`;
    try {
      const file = openBotInstructionFile(agent.dir);
      const current = read(agent);
      const next = withTeamBlock(current, block);
      if (next !== current) openBotWriteInstructions(file, next);
      out.written.push({ member: m, agent });
    } catch { out.failed.push(m); }
  }
  const kept = new Set([...mine.values()].map((a) => a.id));
  for (const a of agents) {
    if (kept.has(a.id)) continue;
    const text = read(a);
    if (teamOfText(text) !== spec.team) continue;
    try { openBotWriteInstructions(openBotInstructionFile(a.dir), text.replace(TEAM_BLOCK_RE, "")); out.released.push(a); } catch { /* left as it is */ }
  }
  openBotReleaseFromTeam(out.released, home);
  return out;
}

/** Take a team's section out of every OpenBot agent that carries it. The agents
 *  stay, and the engine's next run prepares them like any other agent. */
export function releaseOpenBot(team: string, home?: string): OpenBotAgent[] {
  const released: OpenBotAgent[] = [];
  for (const a of listOpenBotAgents(home)) {
    const file = openBotInstructionFile(a.dir);
    let text = "";
    try { text = fs.readFileSync(file, "utf8"); } catch { continue; }
    if (teamOfText(text) !== team) continue;
    try { openBotWriteInstructions(file, text.replace(TEAM_BLOCK_RE, "")); released.push(a); } catch { /* left as it is */ }
  }
  openBotReleaseFromTeam(released, home);
  return released;
}

// ── Hermes (Bot Mode) ────────────────────────────────────────────────

export interface HermesSync {
  /** Members whose Bot exists and now carries their instructions. */
  written: Array<{ member: TeamMember; id: string; created: boolean }>;
  /** Members with no profile yet: created when the caller asks for it. */
  missing: Array<{ member: TeamMember; id: string }>;
  /** Members that could not be written, with why. */
  failed: Array<{ member: TeamMember; id: string; reason: string }>;
  /** Profiles that carried this team's section and are no longer members. */
  released: string[];
}

/** The Hermes profile of a member: `<team>-<member id>`. */
export const hermesMemberId = (spec: TeamSpec, m: TeamMember): string => `${spec.team}-${m.id}`;

const hermesRole = (m: TeamMember): string => (m.expert ? m.expert.role : `The role ${m.role_from}`).replace(/\s+/g, " ").trim();

/** Write each member into the Hermes Bot `<team>-<id>`. A missing profile is
 *  created only with `create`; without it the member is reported as missing. */
export function syncHermes(spec: TeamSpec, lib: TeamLibrary, opts: { create?: boolean } = {}): HermesSync {
  const out: HermesSync = { written: [], missing: [], failed: [], released: [] };
  const ref = (m: TeamMember) => `**${m.name}** (\`@${hermesMemberId(spec, m)}\`)`;
  const kept = new Set<string>();
  for (const m of spec.members) {
    const id = hermesMemberId(spec, m);
    kept.add(id);
    if (!HERMES_PROFILE_ID_RE.test(id)) { out.failed.push({ member: m, id, reason: "the team slug and the member id together are longer than a Hermes profile id (64 characters)" }); continue; }
    const dir = hermesProfileDir(id);
    let created = false;
    if (!fs.existsSync(dir)) {
      if (!opts.create) { out.missing.push({ member: m, id }); continue; }
      const made = createHermesProfile(id, `${m.name}: ${hermesRole(m)}`);
      if (!made.ok) { out.failed.push({ member: m, id, reason: made.message }); continue; }
      created = true;
    }
    try {
      const file = hermesSoulFile(dir);
      let current = "";
      try { current = fs.readFileSync(file, "utf8"); } catch { /* a profile with no SOUL.md yet */ }
      const other = teamOfText(current);
      if (other && other !== spec.team) { out.failed.push({ member: m, id, reason: `the profile carries the team "${other}"` }); continue; }
      const block = `${begin(spec.team)}\n${compileMember(spec, m, { host: "hermes", lib, ref }).trimEnd()}\n${END}\n`;
      const next = withTeamBlock(current, block);
      if (next !== current) writeFile(file, next);
      markHermesBot(dir, { title: m.name, description: hermesRole(m) });
      out.written.push({ member: m, id, created });
    } catch (e: any) { out.failed.push({ member: m, id, reason: e?.message ?? "its files could not be written" }); }
  }
  out.released = releaseHermes(spec.team, kept);
  return out;
}

/** Take a team's section out of every Hermes profile that carries it, except
 *  the ones in `keep`. The profiles stay. */
export function releaseHermes(team: string, keep: Set<string> = new Set()): string[] {
  const released: string[] = [];
  for (const p of listHermesProfiles()) {
    if (keep.has(p.id)) continue;
    const file = hermesSoulFile(p.dir);
    let text = "";
    try { text = fs.readFileSync(file, "utf8"); } catch { continue; }
    if (teamOfText(text) !== team) continue;
    try { fs.writeFileSync(file, text.replace(TEAM_BLOCK_RE, ""), "utf8"); released.push(p.id); } catch { /* left as it is */ }
  }
  return released;
}
