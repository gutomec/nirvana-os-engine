// openbot.ts — what the engine does, on its own, for the agents of OpenBot by
// Nightly Labs (https://github.com/nightly-labs/openbot). Not CopilotKit's
// project of the same name, which keeps its bots on a server and is out of
// reach of a local `nrv`. Like Orca's bots (orca-bots.ts) and OpenMausBot's
// (openmausbot.ts), nothing here is a command the user runs: the seams that
// already execute (install, `nrv init`, `nrv dispatch`, `nrv doctor`) call
// `openBotAutoSetup()` and every agent on the machine is left ready.
//
// Read from OpenBot's source at commit 00f9e69 (2026-11-24, app 0.78.0):
//   - Every agent has a workspace folder `~/OpenBot/Agents/<agentId>`
//     (src/backend/agent-store.ts: `join(homedir(), "OpenBot", "Agents")`, the
//     same on every platform). A local server the app starts as a child keeps
//     its own root under `~/OpenBot/Servers/<serverId>`, with the same
//     `Agents/<agentId>` layout below it.
//   - An agent keeps its standing rules in one file at the root of its
//     workspace: `AGENTS.md`, or `CLAUDE.md` when only that file exists
//     (docs/architecture/agents.md, "Agent instruction file";
//     AGENT_INSTRUCTION_FILE_NAMES). OpenBot reads it at every turn and gives
//     its text to a provider that does not read it by itself, so every
//     provider (Claude Code, Codex, Grok, OpenCode, Gemini, Cursor, Kimi...)
//     sees it. The app shows it as the agent's "Instructions" and the owner
//     edits it there.
//   - OpenBot's own save creates `AGENTS.md` with mode 0600 and writes
//     atomically; the engine does the same.
//   - Agents run the provider CLIs of this computer with full access, so `nrv`
//     on PATH is reachable from a turn.
//   - A file the agent delivers reaches the chat through the
//     `attach_files_to_response` tool (src/backend/openbot-tools.ts), which
//     refuses a file outside the agent's workspace (seen live), hence the one
//     line this host's note adds.
//
// The engine owns one marked block in that file and nothing else in it. The
// owner's text stays as it is. An owner who deletes the block has turned the
// note off: the engine remembers which agents it prepared, in its own state
// file, and does not put the block back.
//
// Every function is fail-soft and synchronous: a missing folder or a read-only
// file is an answer, never an exception.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Database } from "bun:sqlite";
import { botUse, nirvanaBotRules, type BotUse } from "./bot-note.ts";
import { nirvanaHome } from "./deps-home.ts";

export const OPENBOT_BLOCK_BEGIN = "<!-- nirvana-os:openbot:v1 -->";
export const OPENBOT_BLOCK_END = "<!-- /nirvana-os:openbot -->";
const BLOCK_RE = /<!-- nirvana-os:openbot:v\d+ -->[\s\S]*?<!-- \/nirvana-os:openbot -->\r?\n?/;
/** Instruction files OpenBot reads, in its order of preference. */
const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md"] as const;
/** A workspace folder name OpenBot gives an agent (`agent-<uuid>`, or `bot-<uuid>` before its migration v13). */
const AGENT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export interface OpenBotAgent {
  id: string;
  /** The agent's workspace: where its instruction file lives and its turns run. */
  dir: string;
  /** The local server the agent belongs to; null for this computer's own. */
  server: string | null;
}

export type OpenBotOutcome = "written" | "refreshed" | "current" | "turned-off" | "skipped";

/** OpenBot's root folder. `NIRVANA_OPENBOT_DIR` moves it for a caller that
 *  names no home; the test preload sets it, so a test run never writes into the
 *  owner's real agents. */
export function openBotRoot(home?: string): string {
  if (home === undefined && process.env.NIRVANA_OPENBOT_DIR) return process.env.NIRVANA_OPENBOT_DIR;
  return path.join(home ?? os.homedir(), "OpenBot");
}

/** Where the engine remembers the agents it prepared. */
function stateFile(home?: string): string {
  if (home !== undefined) return path.join(home, ".nirvana", "state", "openbot-agents.json");
  return process.env.NIRVANA_OPENBOT_STATE || path.join(nirvanaHome(), "state", "openbot-agents.json");
}

function listDirs(dir: string): string[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && AGENT_ID_RE.test(e.name))
      .map((e) => e.name);
  } catch { return []; }
}

/** Every agent workspace on the machine, this computer's server first. */
export function listOpenBotAgents(home?: string): OpenBotAgent[] {
  const root = openBotRoot(home);
  const out: OpenBotAgent[] = listDirs(path.join(root, "Agents")).sort()
    .map((id) => ({ id, dir: path.join(root, "Agents", id), server: null }));
  for (const server of listDirs(path.join(root, "Servers")).sort()) {
    for (const id of listDirs(path.join(root, "Servers", server, "Agents")).sort()) {
      out.push({ id, dir: path.join(root, "Servers", server, "Agents", id), server });
    }
  }
  return out;
}

function comparable(p: string): string {
  let r = path.resolve(p);
  try { r = fs.realpathSync(r); } catch { /* a path that does not exist yet compares as written */ }
  return process.platform === "win32" || process.platform === "darwin" ? r.toLowerCase() : r;
}

/** The agent whose workspace holds `dir`, or null. */
export function openBotAgentAt(dir: string, home?: string): OpenBotAgent | null {
  const here = comparable(dir);
  return listOpenBotAgents(home).find((a) => {
    const ws = comparable(a.dir);
    return here === ws || here.startsWith(ws + path.sep);
  }) ?? null;
}

/** The block the engine keeps in the agent's instruction file. */
export function openBotBlockText(use: BotUse = "on-demand"): string {
  return [
    OPENBOT_BLOCK_BEGIN,
    "## Nirvana-OS on this computer",
    "",
    "The Nirvana-OS engine wrote this section and keeps it current. To stop using it, delete the section; the engine does not put it back.",
    "",
    ...nirvanaBotRules(use),
    "- **Show the delivery in the chat.** `attach_files_to_response` takes only files inside your workspace, and the delivery is outside it: copy each delivered file into your workspace, attach the copy, and give the original's full path too.",
    `- **A team, when the person asks for one**${use === "always" ? " or the request is a whole project across several areas (product, design, law and launch together, for example)" : ""}: the specialists become OpenBot agents the person can watch. Run \`nrv team candidates "<request>"\`, choose the roles, write the team file with \`nrv team init\`, then \`nrv team sync --team <slug>\` and do what it prints: it names the agents to create and who receives the request. Anything smaller is one \`nrv dispatch\`.`,
    OPENBOT_BLOCK_END,
    "",
  ].join("\n");
}

/** The instruction file OpenBot reads for this workspace: the first that exists, else `AGENTS.md`. */
export function openBotInstructionFile(dir: string): string {
  for (const name of INSTRUCTION_FILES) {
    const file = path.join(dir, name);
    try { if (fs.statSync(file).isFile()) return file; } catch { /* next */ }
  }
  return path.join(dir, INSTRUCTION_FILES[0]);
}

function readPrepared(home?: string): Set<string> {
  try {
    const doc = JSON.parse(fs.readFileSync(stateFile(home), "utf8"));
    return new Set(Array.isArray(doc?.prepared) ? doc.prepared.filter((x: unknown) => typeof x === "string") : []);
  } catch { return new Set(); }
}

function writePrepared(set: Set<string>, home?: string): void {
  const file = stateFile(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writePrivate(file, JSON.stringify({ prepared: [...set].sort() }, null, 2) + "\n");
}

/** Owner-only and atomic, as OpenBot writes the file itself: the app and the
 *  agent read it from other processes. The mode is a no-op on Windows, where
 *  the profile folder's ACL already does that job. */
function writePrivate(file: string, text: string): void {
  const tmp = `${file}.${process.pid}.nrv-tmp`;
  let mode = 0o600;
  try { mode = fs.statSync(file).mode & 0o777; } catch { /* new file */ }
  fs.writeFileSync(tmp, text, { encoding: "utf8", mode });
  try { fs.renameSync(tmp, file); } catch (e) { try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ } throw e; }
}

/** The agent's text with the engine's block put in: replaced where it is, else appended. */
function withBlock(text: string, block: string): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const wanted = block.split("\n").join(eol);
  if (BLOCK_RE.test(text)) return text.replace(BLOCK_RE, wanted);
  const body = text.replace(/\s+$/, "");
  return body ? `${body}${eol}${eol}${wanted}` : wanted;
}

/** Leave one agent knowing how to use Nirvana-OS. Idempotent. */
function ensureAgent(agent: OpenBotAgent, prepared: Set<string>, use: BotUse = "on-demand"): OpenBotOutcome {
  const key = comparable(agent.dir);
  const file = openBotInstructionFile(agent.dir);
  try {
    const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    const block = openBotBlockText(use);
    if (!BLOCK_RE.test(current)) {
      if (prepared.has(key)) return "turned-off";
      writePrivate(file, withBlock(current, block));
      prepared.add(key);
      return "written";
    }
    prepared.add(key);
    const next = withBlock(current, block);
    if (next === current) return "current";
    writePrivate(file, next);
    return "refreshed";
  } catch { return "skipped"; }
}

/** Hand these workspaces to a team (team-hosts.ts): the generic section, which
 *  sends a deliverable to `nrv dispatch`, is taken out, because a team member is
 *  the employee itself, and the workspace is recorded as prepared so the section
 *  is not put back. The owner's text is kept. */
export function openBotReserveForTeam(agents: OpenBotAgent[], home?: string): void {
  if (!agents.length) return;
  const prepared = readPrepared(home);
  for (const agent of agents) {
    prepared.add(comparable(agent.dir));
    const file = openBotInstructionFile(agent.dir);
    try {
      const current = fs.readFileSync(file, "utf8");
      if (BLOCK_RE.test(current)) writePrivate(file, current.replace(BLOCK_RE, ""));
    } catch { /* no instruction file yet: nothing to take out */ }
  }
  try { writePrepared(prepared, home); } catch { /* next run retries */ }
}

/** Give workspaces back after a team let them go: the next run prepares them
 *  like any other agent, generic section included. */
export function openBotReleaseFromTeam(agents: OpenBotAgent[], home?: string): void {
  if (!agents.length) return;
  const prepared = readPrepared(home);
  for (const agent of agents) prepared.delete(comparable(agent.dir));
  try { writePrepared(prepared, home); } catch { /* next run retries */ }
}

/** Write an agent's instruction file as OpenBot does: owner-only and atomic. */
export function openBotWriteInstructions(file: string, text: string): void {
  writePrivate(file, text);
}

/** Does the agent's instruction file still carry the engine's block? */
export function openBotUsesNirvana(agent: OpenBotAgent): boolean {
  try { return BLOCK_RE.test(fs.readFileSync(openBotInstructionFile(agent.dir), "utf8")); } catch { return false; }
}

/** OpenBot's database: `openbot.db` in the app's user data (Electron `userData`). */
export function openBotDatabasePath(home?: string): string {
  const h = home ?? os.homedir();
  if (process.platform === "win32") return path.join(home === undefined && process.env.APPDATA ? process.env.APPDATA : path.join(h, "AppData", "Roaming"), "OpenBot", "openbot.db");
  if (process.platform === "darwin") return path.join(h, "Library", "Application Support", "OpenBot", "openbot.db");
  return path.join(home === undefined && process.env.XDG_CONFIG_HOME ? process.env.XDG_CONFIG_HOME : path.join(h, ".config"), "OpenBot", "openbot.db");
}

/** Display name and provider of each agent this computer's server knows, read
 *  only, for the doctor's line. The app owns the database; the engine never
 *  writes it. Empty when it cannot be read. */
export function openBotAgentLabels(home?: string): Map<string, { name: string | null; provider: string | null; about: string | null }> {
  const out = new Map<string, { name: string | null; provider: string | null; about: string | null }>();
  const file = home === undefined && process.env.NIRVANA_OPENBOT_DB ? process.env.NIRVANA_OPENBOT_DB : openBotDatabasePath(home);
  if (!fs.existsSync(file)) return out;
  try {
    const db = new Database(file, { readonly: true });
    try {
      for (const row of db.query("SELECT agent_id, agent_json FROM projection_agents").all() as Array<{ agent_id: string; agent_json: string }>) {
        let doc: any = null;
        try { doc = JSON.parse(row.agent_json); } catch { /* label stays empty */ }
        const name = doc?.name ?? doc?.profile?.name;
        const provider = doc?.provider ?? doc?.profile?.provider;
        const about = [doc?.title, doc?.description].filter((v) => typeof v === "string" && v).join(". ");
        out.set(row.agent_id, { name: typeof name === "string" && name ? name : null, provider: typeof provider === "string" && provider ? provider : null, about: about || null });
      }
    } finally { db.close(); }
  } catch { /* an older or newer schema: no labels */ }
  return out;
}

export interface OpenBotAutoSetupResult {
  agents: Array<{ agent: OpenBotAgent; outcome: OpenBotOutcome }>;
}

/** Every agent on the machine, prepared. A machine without OpenBot has no
 *  `~/OpenBot/Agents` and this is one failed read. */
export function openBotAutoSetup(home?: string): OpenBotAutoSetupResult {
  const agents = listOpenBotAgents(home);
  if (!agents.length) return { agents: [] };
  const prepared = readPrepared(home);
  const before = prepared.size;
  // An agent made for Nirvana-OS, one whose name or description names it,
  // sends every deliverable through it; any other uses it on demand.
  const labels = openBotAgentLabels(home);
  const result = agents.map((agent) => {
    const label = labels.get(agent.id);
    return { agent, outcome: ensureAgent(agent, prepared, botUse(label?.name, label?.about)) };
  });
  if (prepared.size !== before) { try { writePrepared(prepared, home); } catch { /* next run retries */ } }
  return { agents: result };
}
