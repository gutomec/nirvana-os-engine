// team.ts — a team of agents built from the library: the roles come from the
// employees of installed businesses, the personas from mind-clones, and a role
// the library has no employee for is an expert-x with a minimal card.
//
// The team is one file, `.nirvana/team.yaml`, that the user's main agent writes
// and edits. This module validates it and compiles one instruction file per
// member; the hosts (Claude Code subagents, OpenBot agents) are written from
// those by team-hosts.ts. Nothing here runs unless someone asks for a team: a
// plain `nrv dispatch` never reads it.
//
// The rules every member gets were paid for on 2026-11-24/25, when a 15-agent
// team ran a full project on OpenBot: a member started a long download and
// ended its turn with nothing to wake it (35 minutes of nobody working); the
// download was gigabytes for one market count; another member opened Docker
// Desktop on the owner's machine unasked; and the reviewer re-read the whole
// project and became the most expensive member without finishing.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { nirvanaHome } from "./deps-home.ts";
import { enumerate, resolveScope } from "./scope.ts";

export const TEAM_FILE = path.join(".nirvana", "team.yaml");
export const TEAM_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const MEMBER_ID_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;
export const TEAM_TIERS = ["lead", "member"] as const;

/** The minimal card of an expert-x: what the role is, what it hands over and
 *  when that is done. No method and no persona: the model works freely, and the
 *  lead's review and the reviewer hold the quality. */
export interface ExpertCard { role: string; delivers: string; done_when: string }

export interface TeamMember {
  id: string;
  /** The name the host shows; unique in the team. */
  name: string;
  /** `<business>/<employee>`: the role comes from that employee file. */
  role_from?: string;
  /** An expert-x: a role no installed business has an employee for. */
  expert?: ExpertCard;
  clones: string[];
  reports_to?: string;
  tier: typeof TEAM_TIERS[number];
  focus?: string;
}

export interface TeamModel { provider?: string; model?: string; effort?: string }

export interface TeamSpec {
  team: string;
  display_name: string;
  purpose: string;
  /** Where the team's projects are written; each project gets a folder under it. */
  output_root: string;
  /** The member that receives the request and runs the project to delivery. */
  orchestrator: string;
  /** The member that reviews before delivery; optional. */
  reviewer?: string;
  members: TeamMember[];
  models: Partial<Record<typeof TEAM_TIERS[number], TeamModel>>;
}

export interface TeamLibrary {
  /** The employee file of `<business>/<employee>`, or null. */
  employeeFile(roleFrom: string): string | null;
  /** The folder of a mind-clone, or null. */
  cloneDir(slug: string): string | null;
}

/** The library the engine sees from `cwd` (scope-aware, as every other lookup). */
export function scopeLibrary(cwd?: string): TeamLibrary {
  const scope = resolveScope(cwd ? { cwd } : {});
  const dirOf = (kind: "businesses" | "mind-clones", slug: string): string | null => {
    const hit = enumerate(scope, kind).find((e) => e.slug === slug && !e.overridden);
    return hit ? hit.dir : null;
  };
  return {
    employeeFile(roleFrom) {
      const [biz, emp, ...rest] = String(roleFrom || "").split("/");
      if (!biz || !emp || rest.length) return null;
      const dir = dirOf("businesses", biz);
      if (!dir) return null;
      const file = path.join(dir, "employees", `${emp}.md`);
      return fs.existsSync(file) ? file : null;
    },
    cloneDir(slug) {
      const dir = dirOf("mind-clones", slug);
      return dir && fs.existsSync(path.join(dir, "agent", "AGENT.md")) ? dir : null;
    },
  };
}

/** Where a team lives: a project's own (`<dir>/.nirvana/team.yaml`) or, by slug, under the engine's home. */
export function teamHomeDir(slug: string): string {
  return path.join(nirvanaHome(), "teams", slug);
}
export function teamFileOf(dir: string): string {
  return path.join(dir, TEAM_FILE);
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const expandHome = (p: string): string => (p === "~" || p.startsWith("~/") || p.startsWith("~\\") ? path.join(os.homedir(), p.slice(2)) : p);

/** Read a team file into a spec plus every problem found; `spec` is null only when the file cannot be read as a team at all. */
export function loadTeam(file: string, lib: TeamLibrary): { spec: TeamSpec | null; problems: string[] } {
  let doc: any;
  try { doc = parseYaml(fs.readFileSync(file, "utf8")); }
  catch (e: any) { return { spec: null, problems: [`${file} cannot be read as YAML: ${e?.message ?? e}`] }; }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return { spec: null, problems: [`${file} is not a team: expected a YAML mapping`] };

  const problems: string[] = [];
  const team = str(doc.team);
  if (!TEAM_SLUG_RE.test(team)) problems.push("team: a lowercase slug is required (letters, digits, hyphens)");
  const members: TeamMember[] = [];
  const rawMembers = Array.isArray(doc.members) ? doc.members : [];
  if (!rawMembers.length) problems.push("members: at least one member is required");
  for (const [i, m] of rawMembers.entries()) {
    const id = str(m?.id);
    const where = id ? `member ${id}` : `member #${i + 1}`;
    if (!MEMBER_ID_RE.test(id)) { problems.push(`${where}: id must be a lowercase slug`); continue; }
    if (members.some((x) => x.id === id)) { problems.push(`${where}: the id is used twice`); continue; }
    const name = str(m.name) || id;
    if (members.some((x) => x.name.toLowerCase() === name.toLowerCase())) problems.push(`${where}: the name "${name}" is used twice; a host finds its agent by name`);
    const roleFrom = str(m.role_from);
    const ex = m.expert && typeof m.expert === "object" ? m.expert : null;
    let expert: ExpertCard | undefined;
    if (roleFrom && ex) problems.push(`${where}: give role_from or expert, not both`);
    if (roleFrom) {
      if (!lib.employeeFile(roleFrom)) problems.push(`${where}: role_from "${roleFrom}" is not an employee of an installed business (expected <business>/<employee>)`);
    } else if (ex) {
      expert = { role: str(ex.role), delivers: str(ex.delivers), done_when: str(ex.done_when) };
      for (const k of ["role", "delivers", "done_when"] as const) if (!expert[k]) problems.push(`${where}: expert.${k} is required`);
    } else {
      problems.push(`${where}: needs role_from (<business>/<employee>) or an expert card (role, delivers, done_when)`);
    }
    const clones = (Array.isArray(m.clones) ? m.clones : []).map(str).filter(Boolean);
    for (const c of clones) if (!lib.cloneDir(c)) problems.push(`${where}: mind-clone "${c}" is not installed; remove it or install it. A member works without a clone`);
    if (expert && clones.length) problems.push(`${where}: an expert-x has no mind-clone; a role with a clone needs role_from`);
    const tier = str(m.tier) || "member";
    if (!(TEAM_TIERS as readonly string[]).includes(tier)) problems.push(`${where}: tier must be lead or member`);
    members.push({
      id, name, clones, tier: (tier === "lead" ? "lead" : "member"),
      ...(roleFrom ? { role_from: roleFrom } : {}), ...(expert ? { expert } : {}),
      ...(str(m.reports_to) ? { reports_to: str(m.reports_to) } : {}), ...(str(m.focus) ? { focus: str(m.focus) } : {}),
    });
  }
  const ids = new Set(members.map((m) => m.id));
  const orchestrator = str(doc.orchestrator);
  if (!ids.has(orchestrator)) problems.push("orchestrator: must be the id of a member");
  const reviewer = str(doc.reviewer);
  if (reviewer && !ids.has(reviewer)) problems.push("reviewer: must be the id of a member");
  if (reviewer && reviewer === orchestrator) problems.push("reviewer: cannot be the orchestrator; the one who ran the work does not review it");
  for (const m of members) {
    if (!m.reports_to) continue;
    if (!ids.has(m.reports_to)) problems.push(`member ${m.id}: reports_to "${m.reports_to}" is not a member`);
    if (m.reports_to === m.id) problems.push(`member ${m.id}: reports to itself`);
  }
  // A reporting chain that never reaches the top would leave a lead waiting for itself.
  for (const m of members) {
    const seen = new Set<string>([m.id]);
    for (let cur = m.reports_to; cur && ids.has(cur); cur = members.find((x) => x.id === cur)?.reports_to) {
      if (seen.has(cur)) { problems.push(`member ${m.id}: its reporting line is a loop`); break; }
      seen.add(cur);
    }
  }
  const models: TeamSpec["models"] = {};
  for (const tier of TEAM_TIERS) {
    const v = doc.models?.[tier];
    if (v && typeof v === "object") models[tier] = { ...(str(v.provider) ? { provider: str(v.provider) } : {}), ...(str(v.model) ? { model: str(v.model) } : {}), ...(str(v.effort) ? { effort: str(v.effort) } : {}) };
  }
  const outputRoot = str(doc.output_root) ? path.resolve(expandHome(str(doc.output_root))) : path.join(nirvanaHome(), "outputs", "teams", team || "team");
  return {
    spec: {
      team, display_name: str(doc.display_name) || team, purpose: str(doc.purpose), output_root: outputRoot,
      orchestrator, ...(reviewer ? { reviewer } : {}), members, models,
    },
    problems,
  };
}

/** The skeleton `nrv team init` writes: valid YAML with the shape explained, for an agent to fill in. */
export function teamSkeleton(slug: string, purpose: string): string {
  return [
    "# A team built from the Nirvana-OS library. Edit this file, then run `nrv team sync`.",
    "# - role_from: <business>/<employee>, from an installed business (`nrv team candidates \"<request>\"` lists them).",
    "# - clones: mind-clones for that role, only ones that fit (`nrv find-clone \"<what the role needs>\"`). None is fine.",
    "# - expert: for a role no business has: role, delivers, done_when. Keep it short; it gets no clone.",
    "# - tier: lead for the orchestrator, department leads and the reviewer; member for the others.",
    "# Start small: the orchestrator, the leads the request needs and a reviewer. Add members when the work asks for them.",
    `team: ${slug}`,
    `display_name: ${JSON.stringify(slug)}`,
    `purpose: ${JSON.stringify(purpose || "")}`,
    "orchestrator: director",
    "# reviewer: reviewer",
    "members:",
    "  - id: director",
    "    name: \"Director\"",
    "    tier: lead",
    "    expert:",
    "      role: \"Runs the project from the request to the delivery\"",
    "      delivers: \"The brief, the decisions and the final delivery with every file listed\"",
    "      done_when: \"Every part the request asked for exists, was reviewed and is listed in the delivery\"",
    "# models:",
    "#   lead: { provider: claude, model: claude-opus-5-5, effort: high }",
    "#   member: { provider: claude, model: claude-sonnet-5-5, effort: high }",
    "",
  ].join("\n");
}

// ─────────────────────────────────────────────────────────────────────
// Compiling a member's instructions
// ─────────────────────────────────────────────────────────────────────

export type TeamHost = "neutral" | "openbot" | "claude-code" | "hermes";

export interface CompileContext {
  host: TeamHost;
  lib: TeamLibrary;
  /** How a teammate is named in the text: on OpenBot, with its agent id. */
  ref?: (m: TeamMember) => string;
}

const byId = (spec: TeamSpec, id?: string) => (id ? spec.members.find((m) => m.id === id) : undefined);
const reportsOf = (spec: TeamSpec, id: string) => spec.members.filter((m) => m.reports_to === id);

function roleSection(m: TeamMember, lib: TeamLibrary): string[] {
  if (m.expert) {
    return [
      "## Your role",
      `You are an expert-x: the library has no employee for this role, so you work from this card and your own judgment.`,
      `- **Role:** ${m.expert.role}`,
      `- **You deliver:** ${m.expert.delivers}`,
      `- **Done when:** ${m.expert.done_when}`,
    ];
  }
  const file = lib.employeeFile(m.role_from!);
  const raw = file ? fs.readFileSync(file, "utf8") : "";
  const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "";
  let acceptance: string[] = [];
  try {
    const doc = parseYaml(fm) as any;
    acceptance = (Array.isArray(doc?.acceptance) ? doc.acceptance : []).map((a: any) => `- ${String(a?.description ?? "").trim()}${a?.blocking ? " (blocking)" : ""}`).filter((l: string) => l.length > 2);
  } catch { /* a role file with unreadable frontmatter still gives its body */ }
  // The role file's own headings sit under this section's.
  const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim().replace(/^(#{1,4}) /gm, (_m, h: string) => `${"#".repeat(Math.min(6, h.length + 2))} `);
  return [
    `## Your role (employee \`${m.role_from}\`)`,
    body || "(the role file has no text)",
    ...(acceptance.length ? ["", "## Your acceptance criteria", ...acceptance] : []),
  ];
}

function personaSection(m: TeamMember, lib: TeamLibrary): string[] {
  if (!m.clones.length) return [];
  const lines = m.clones.map((c) => {
    const dir = lib.cloneDir(c);
    const files = dir ? ["agent/AGENT.md", "agent/SOUL.md", "dna/dna-schema.md"].map((f) => path.join(dir, ...f.split("/"))).filter((f) => fs.existsSync(f)) : [];
    return `- \`${c}\`: ${files.map((f) => `\`${f}\``).join(", ") || "(files not found)"}`;
  });
  return [
    "## Your persona",
    ...lines,
    "",
    `Read these files before your first task and work with ${m.clones.length > 1 ? "these people's methods; use the one that fits the task and say which" : "this person's method and judgment"}.`,
  ];
}

/** What every member obeys, whatever the host. */
export function sharedRules(spec: TeamSpec, host: TeamHost): string[] {
  const talk = host === "openbot"
    ? "- Talk to teammates only through `send_message`. A request or a task goes with `expectsReply` true; your answer to a task replies to its message (`replyToMessageId`)."
    : host === "claude-code"
      ? "- You are called for one task and answer once: your answer is all the caller sees of your work."
      : host === "hermes"
        ? "- Talk to teammates by their handle. In your Bot Chat, use `message_agent` (target: the handle, with what you expect back); its answer comes later as a notification, so go on with what does not depend on it. When that tool is not in the session, run `hermes -p <the handle without the @> -z \"<the task>\"` in the project folder and read the answer from its output."
        : "- Talk to teammates only through the host's own messaging; a task expects one answer, sent to whoever asked.";
  return [
    `## Rules for everyone in ${spec.display_name}`,
    `- Every project has one folder under \`${spec.output_root}\`. Write your files there, in your area's subfolder, and pass **paths** in messages, never pasted documents.`,
    "- Deliverables are in the language of the request. Code, file names and identifiers are in English.",
    talk,
    "- You do the work of your role yourself. Do not call Nirvana-OS (`nrv dispatch`) for it, and do not create or delete agents.",
    "- **Effort fits the question.** Do what the task needs to be decided well, then stop. An estimate with its source and its margin, in minutes, beats an exact figure that takes an hour; go deeper only when the number would change a decision, and say so first.",
    "- **Never end a turn waiting on something nobody will wake you for.** A command that runs longer than your turn either finishes before you answer or is not started. When the host has a wake-up for it, open one and say so; otherwise answer with what you have and what is missing.",
    "- **The machine is its owner's.** Do not open applications or start services on it (Docker, databases, servers, browsers), and do not install anything, unless the person asked for it in this project. When a check needs one, say what you would run and why, and leave it undone.",
    "- Say what you assumed. Keep what you measured apart from what you estimate. A claim about law, a market or a number names its source and date, or is marked as an assumption.",
    "- When something you need belongs to another role, ask whoever you answer to; do not decide it for them.",
  ];
}

function protocolSection(spec: TeamSpec, m: TeamMember, ctx: CompileContext): string[] {
  const ref = ctx.ref ?? ((x: TeamMember) => `**${x.name}**`);
  const lead = byId(spec, m.reports_to);
  const reports = reportsOf(spec, m.id);
  const reviewer = byId(spec, spec.reviewer);
  if (m.id === spec.orchestrator) {
    const direct = reports.filter((r) => r.id !== spec.reviewer);
    const how = ctx.host === "claude-code"
      ? "You are the main session. Each teammate is a subagent of this project: give it one task at a time, in parallel when the tasks are independent, and read what it answers."
      : "You talk to the members who answer to you, never to their own teams, and you do not write their content yourself.";
    return [
      "## How you run a project",
      `You are the orchestrator of ${spec.display_name}. ${how}`,
      "",
      direct.length ? `Who answers to you: ${direct.map(ref).join("; ")}.${reviewer ? ` Your reviewer: ${ref(reviewer)}.` : ""}` : `You have no one under you yet: do the work yourself and ask the person to add a member when a part needs a specialist.${reviewer ? ` Your reviewer: ${ref(reviewer)}.` : ""}`,
      "",
      "1. **Intake.** Restate the request and your assumptions. Ask the person only for a decision you cannot make without them, all at once, and go on with what does not depend on the answer. Create the project folder and write `brief.md` in it.",
      "2. **Split.** Give each part to the member whose role owns it, with the request's own words, what the part must achieve and a size for the effort (\"an estimate with sources, in about fifteen minutes\"). Independent parts go out together.",
      "3. **Keep it moving.** When an answer you are waiting for does not come, ask once; if it still does not come, go on without that part and say so in the delivery. Nobody waits in silence.",
      "4. **One decision point.** When the scope is defined, show the person the scope and the cost of what is left, and wait for a yes before the long part of the work.",
      reviewer
        ? `5. **Review.** Send ${reviewer.name} the list of files that changed and what each must satisfy, not \"the whole project\". Pass each blocking finding to the member who owns it, at most two rounds.`
        : "5. **Review.** Check each part against the request before you deliver; there is no separate reviewer in this team.",
      "6. **Delivery.** Write `delivery.md`: the decisions and why, what was left out and why, and every file with its path. Give the person the project folder's full path. Keep `decisions.md` updated along the way.",
    ];
  }
  if (m.id === spec.reviewer) {
    return [
      "## How you review",
      `You are the antagonist of ${spec.display_name}: you find what is wrong before the person does. ${ref(byId(spec, spec.orchestrator)!)} sends you a list of files and what each must satisfy.`,
      "- Review that list and nothing else. Read a file outside it only to check a claim that points there.",
      "- Check that the parts agree with each other and with the request, and that every claim about law, a market or a number has a source.",
      "- Write `review.md` in the project folder: blocking and non-blocking findings, each with the file, what is wrong and what would fix it, and a verdict, approved or not approved. Answer with its path.",
      "- A review is one pass. When it grows past what the list asked for, stop and say what is left unreviewed.",
    ];
  }
  if (reports.length) {
    return [
      "## How you lead",
      `You answer to ${lead ? ref(lead) : "the person"}. Your team: ${reports.map(ref).join(", ")}.`,
      "- Split each task among your team, in parallel when the parts are independent, each with a size for the effort. Do the parts that are yours.",
      "- Review what comes back against each member's acceptance criteria and send it back once, with specific notes, when it misses.",
      "- When a member's answer does not come, ask once, then go on without it and say what is missing.",
      "- Answer with a summary of your area's decisions and the paths of its files.",
    ];
  }
  return [
    "## How you work",
    `You answer to ${lead ? ref(lead) : "the orchestrator"}.`,
    "- Do the task in your role, write the files in the project folder, and answer with their paths, the decisions you made and what you assumed.",
  ];
}

/** One member's instructions, whole. */
export function compileMember(spec: TeamSpec, m: TeamMember, ctx: CompileContext): string {
  const ref = ctx.ref ?? ((x: TeamMember) => `**${x.name}**`);
  const lead = byId(spec, m.reports_to);
  const blocks: string[][] = [
    [
      `# ${m.name} · ${spec.display_name}`,
      "",
      `You are **${m.name}**, a member of ${spec.display_name}${spec.purpose ? `: ${spec.purpose.replace(/\s+/g, " ")}` : "."}${lead ? ` You answer to ${ref(lead)}.` : ""}${m.focus ? `\n\nYour focus in this team: ${m.focus}` : ""}`,
    ],
    personaSection(m, ctx.lib),
    protocolSection(spec, m, ctx),
    sharedRules(spec, ctx.host),
    roleSection(m, ctx.lib),
  ];
  return blocks.filter((b) => b.length).map((b) => b.join("\n")).join("\n\n") + "\n";
}
