// orca-bots.ts — what the engine does, on its own, for Orca's bots and Orca's
// projects. Nothing here is a command the user runs: the seams that already
// execute (install, `nrv init`, `nrv dispatch`, `nrv doctor`) call
// `orcaAutoSetup()` and the machine is left ready.
//
// Measured on Orca 1.4.265 (macOS, 2026-11-20):
//   - A bot lives in `~/.orca/bots/<slug>/` with AGENTS.md, CLAUDE.md
//     (`@AGENTS.md`), SOUL.md, MEMORY.md, memory/ and bot.json.
//   - AGENTS.md states it: "Orca writes this file, CLAUDE.md and bot.json; edits
//     to them are replaced." A block written there does not survive.
//   - SOUL.md changes "only when your owner asks". The engine is not the owner.
//   - MEMORY.md is "one line per fact, newest first", details in
//     `memory/<topic>.md`. That is the one place a fact from outside belongs,
//     so the engine writes one topic file and one line pointing to it.
//   - A bot's run is NOT an Orca terminal: its audit events carry no `orca`
//     block (no ORCA_WORKTREE_ID, no ORCA_TERMINAL_HANDLE). A bot is recognised
//     by where it runs, the folder, and by nothing else.
//   - Orca has no "project created" hook. It has a per-project setup script
//     (`orca.yaml`, `scripts.setup`) that runs when a worktree is created.
//
// Every function is fail-soft and synchronous: a missing folder, a read-only
// file or an unreadable bot.json is an answer, never an exception.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const BOT_TOPIC_FILE = "nirvana-os.md";
export const BOT_TOPIC_MARKER = "<!-- nirvana-os:orca-bot:v1 -->";
const BOT_TOPIC_MARKER_RE = /<!-- nirvana-os:orca-bot:v\d+ -->/;
/** What identifies the engine's line in MEMORY.md: the pointer to its topic file. */
const BOT_MEMORY_POINTER = `memory/${BOT_TOPIC_FILE}`;

export interface OrcaBot {
  slug: string;
  dir: string;
  name: string | null;
  /** The agent the bot runs on, as bot.json names it (`claude`, `codex`, ...). */
  agent: string | null;
}

export type BotSetupOutcome = "written" | "refreshed" | "current" | "skipped";

/** Where Orca keeps its bots: the same relative path on every platform.
 *  `NIRVANA_ORCA_BOTS_DIR` moves it for a caller that names no home; the test
 *  preload sets it, so a test run never writes into the owner's real bots
 *  (measured: the first suite run of this module did exactly that). */
export function orcaBotsRoot(home?: string): string {
  if (home === undefined && process.env.NIRVANA_ORCA_BOTS_DIR) return process.env.NIRVANA_ORCA_BOTS_DIR;
  return path.join(home ?? os.homedir(), ".orca", "bots");
}

function readBot(dir: string): OrcaBot | null {
  let doc: any;
  try { doc = JSON.parse(fs.readFileSync(path.join(dir, "bot.json"), "utf8")); } catch { return null; }
  if (!doc || typeof doc !== "object") return null;
  return {
    slug: path.basename(dir),
    dir,
    name: typeof doc.name === "string" && doc.name ? doc.name : null,
    agent: typeof doc.agent === "string" && doc.agent ? doc.agent : null,
  };
}

/** Every bot on this computer: a folder under the bots root that holds a bot.json. */
export function listOrcaBots(home?: string): OrcaBot[] {
  const root = orcaBotsRoot(home);
  let names: string[];
  try { names = fs.readdirSync(root); } catch { return []; }
  const out: OrcaBot[] = [];
  for (const name of names.sort()) {
    const bot = readBot(path.join(root, name));
    if (bot) out.push(bot);
  }
  return out;
}

/** Case and separators differ between what a caller passes and what the
 *  filesystem holds (Windows, and macOS by default), so paths are compared
 *  resolved and, where the platform folds case, lowercased. */
function comparable(p: string): string {
  let r = path.resolve(p);
  try { r = fs.realpathSync(r); } catch { /* a path that does not exist yet compares as written */ }
  return process.platform === "win32" || process.platform === "darwin" ? r.toLowerCase() : r;
}

/** The bot whose folder holds `dir` (the folder itself or anything below it),
 *  or null. This is how a bot's run is recognised: by its working directory. */
export function orcaBotAt(dir: string, home?: string): OrcaBot | null {
  const root = comparable(orcaBotsRoot(home));
  const here = comparable(dir);
  if (here !== root && !here.startsWith(root + path.sep)) return null;
  const slug = here.slice(root.length + 1).split(path.sep)[0];
  if (!slug) return null;
  return listOrcaBots(home).find((b) => comparable(b.dir) === path.join(root, slug)) ?? null;
}

/** The note the bot keeps about Nirvana-OS. English, like every string the
 *  engine writes for an agent; the deliverable's language is the request's. */
export function botTopicText(): string {
  return [
    BOT_TOPIC_MARKER,
    "# Nirvana-OS on this computer",
    "",
    "The Nirvana-OS engine wrote this note and keeps it current. To stop using it, take the line that points here out of MEMORY.md; the engine does not put it back.",
    "",
    "Nirvana-OS is your owner's library of businesses, squads and mind-clones. Its command is `nrv`; when `nrv` is not on PATH, call `~/.local/bin/nrv`.",
    "",
    "- **A concrete deliverable goes to Nirvana-OS.** A report, a post, a document, a page, code, an analysis, a design: run `nrv dispatch --auto --exec \"<brief>\"` and wait for it to exit. It can take several minutes. Do not write the deliverable yourself.",
    "- **Write the brief in English**, whatever language the request came in, and say inside it which language the deliverable must be written in. Everything typed into a command is English.",
    "- **A correction** to something already dispatched is `nrv revise <project> \"<change>\"`, never a second dispatch.",
    "- **Questions about the library** are answered by the command, not from memory: `nrv list-businesses`, `nrv list-squads`, `nrv list-clones`, `nrv find \"<need>\"`. Report only what it prints.",
    "- **A delivery is real when the file is on disk.** Reply with the commands you ran and the full path of each delivered file. Exit code 0 means delivered; anything else, say what the command printed.",
    "",
  ].join("\n");
}

/** One dated line, in the form MEMORY.md asks for. */
function botMemoryLine(now: Date): string {
  // The owner's calendar day, not UTC's: an evening install must not be dated tomorrow.
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  return `- ${day}: Nirvana-OS is installed on this computer. A request for a concrete deliverable goes through it; how is in ${BOT_MEMORY_POINTER}.`;
}

/** Put the line first among the facts ("newest first"): right before the first
 *  existing fact line, else at the end of the file. */
function withMemoryLine(text: string, line: string): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const firstFact = lines.findIndex((l) => /^\s*[-*]\s+\S/.test(l));
  if (firstFact >= 0) { lines.splice(firstFact, 0, line); return lines.join(eol); }
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
  return [...lines, "", line, ""].join(eol);
}

/**
 * Leave one bot knowing how to use Nirvana-OS. Idempotent.
 *
 * The topic file is the engine's: written when absent, rewritten when it
 * carries an older marker. The line in MEMORY.md is the bot's and its owner's:
 * it is added once, together with the topic file, and never again, so an owner
 * who removes it has turned the note off and it stays off.
 *
 * A folder without a MEMORY.md is not a bot this code understands: skipped.
 */
export function ensureBotKnowsNirvana(bot: OrcaBot, now: Date = new Date()): BotSetupOutcome {
  const memoryFile = path.join(bot.dir, "MEMORY.md");
  const topicFile = path.join(bot.dir, "memory", BOT_TOPIC_FILE);
  try {
    if (!fs.existsSync(memoryFile)) return "skipped";
    const wanted = botTopicText();
    if (fs.existsSync(topicFile)) {
      const current = fs.readFileSync(topicFile, "utf8");
      // A file of that name without the engine's marker is somebody else's note.
      if (!BOT_TOPIC_MARKER_RE.test(current)) return "skipped";
      if (current === wanted) return "current";
      fs.writeFileSync(topicFile, wanted, "utf8");
      return "refreshed";
    }
    fs.mkdirSync(path.dirname(topicFile), { recursive: true });
    fs.writeFileSync(topicFile, wanted, "utf8");
    const memory = fs.readFileSync(memoryFile, "utf8");
    if (!memory.includes(BOT_MEMORY_POINTER)) fs.writeFileSync(memoryFile, withMemoryLine(memory, botMemoryLine(now)), "utf8");
    return "written";
  } catch { return "skipped"; }
}

/** Does the bot still point at the engine's note? False once its owner removed the line. */
export function botUsesNirvana(bot: OrcaBot): boolean {
  try {
    return fs.existsSync(path.join(bot.dir, "memory", BOT_TOPIC_FILE))
      && fs.readFileSync(path.join(bot.dir, "MEMORY.md"), "utf8").includes(BOT_MEMORY_POINTER);
  } catch { return false; }
}

export interface OrcaAutoSetupResult {
  bots: Array<{ bot: OrcaBot; outcome: BotSetupOutcome }>;
}

/** Every bot on the machine, prepared. Called by the seams that already run;
 *  a machine without Orca has no bots folder and this is one failed readdir. */
export function orcaAutoSetup(home?: string, now: Date = new Date()): OrcaAutoSetupResult {
  const bots = listOrcaBots(home).map((bot) => ({ bot, outcome: ensureBotKnowsNirvana(bot, now) }));
  return { bots };
}

// ── the project's setup script ────────────────────────────────────────────

export const ORCA_YAML = "orca.yaml";

/** The line a worktree's setup terminal runs: make the worktree a Nirvana
 *  project. `--adopt` writes only `.nirvana/project.yaml`, never the worktree's
 *  own files, and is idempotent, so the line needs no test around it and reads
 *  the same under bash and under PowerShell: the file can be committed and
 *  shared between machines of different systems. */
export const ORCA_SETUP_COMMAND = "nrv init . --adopt";

export function orcaYamlText(): string {
  return [
    "# Written by Nirvana-OS: every worktree Orca creates for this project starts as a Nirvana project.",
    "scripts:",
    "  setup: |",
    `    ${ORCA_SETUP_COMMAND}`,
    "",
  ].join("\n");
}

export type OrcaYamlOutcome = "written" | "present" | "skipped";

/** Write `orca.yaml` at a project's root when there is none. A file that is
 *  already there is the project's own and is left exactly as it is, whatever it
 *  says: merging into someone's setup script is not the engine's call. */
export function ensureOrcaSetupScript(projectRoot: string): OrcaYamlOutcome {
  const file = path.join(projectRoot, ORCA_YAML);
  try {
    if (fs.existsSync(file)) return "present";
    fs.writeFileSync(file, orcaYamlText(), "utf8");
    return "written";
  } catch { return "skipped"; }
}

// ── a workspace Orca opened that is not a project yet ─────────────────────

/** The folder of the enclosing Orca worktree when `cwd` is that folder or sits
 *  inside it; null outside an Orca terminal or when the terminal was moved
 *  somewhere else. `ORCA_WORKTREE_ID` is `<repoId>::<path>`. */
export function orcaWorktreeRootFor(cwd: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const id = env.ORCA_WORKTREE_ID || "";
  const at = id.indexOf("::");
  if (at < 0) return null;
  const root = id.slice(at + 2);
  if (!root || !path.isAbsolute(root)) return null;
  const r = comparable(root);
  const here = comparable(cwd);
  return here === r || here.startsWith(r + path.sep) ? path.resolve(root) : null;
}

// ── a project Orca does not know yet ──────────────────────────────────────

export type OrcaWorkspaceOutcome = "registered" | "known" | "unreachable" | "failed";

/** Roots this machine already registered with Orca. Kept in the engine's store,
 *  not in the project: `.nirvana/` is committed, and a mark that travels with
 *  the repository would stop the next machine from registering it. */
function knownWorkspacesFile(storeDir: string): string {
  return path.join(storeDir, "cache", "orca-workspaces.json");
}

function readKnownWorkspaces(storeDir: string): string[] {
  try {
    const doc = JSON.parse(fs.readFileSync(knownWorkspacesFile(storeDir), "utf8"));
    return Array.isArray(doc?.roots) ? doc.roots.filter((r: unknown) => typeof r === "string") : [];
  } catch { return []; }
}

export interface OrcaWorkspaceDeps {
  /** Is the Orca app answering? */
  running: () => boolean;
  /** `orca repo add --path <dir>`. */
  register: (dir: string) => { ok: boolean };
  /** The engine's store (`~/.nirvana`). */
  storeDir: string;
}

/**
 * Register a project as an Orca workspace, once per machine. The first call
 * with the app running registers it and records the root; every later call is
 * one small file read. With the app closed nothing is called and nothing is
 * recorded, so the next run that finds Orca open does it.
 */
export function ensureOrcaWorkspace(projectRoot: string, deps: OrcaWorkspaceDeps): OrcaWorkspaceOutcome {
  const key = comparable(projectRoot);
  const known = readKnownWorkspaces(deps.storeDir);
  if (known.includes(key)) return "known";
  try {
    if (!deps.running()) return "unreachable";
    if (!deps.register(path.resolve(projectRoot)).ok) return "failed";
    const file = knownWorkspacesFile(deps.storeDir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ roots: [...known, key] }, null, 2) + "\n", "utf8");
    return "registered";
  } catch { return "failed"; }
}
