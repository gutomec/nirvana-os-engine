// openmausbot.ts — what the engine does, on its own, for the bots of
// OpenMausBot (https://github.com/milind-soni/OpenMausBot). Like Orca's bots
// (orca-bots.ts), nothing here is a command the user runs: the seams that
// already execute (install, `nrv init`, `nrv dispatch`, `nrv doctor`) call
// `openMausBotAutoSetup()` and every bot on the machine is left ready.
//
// Read from OpenMausBot's source at commit 3aec210 (2026-11-23):
//   - The data folder is `OMB_DATA_DIR`, else `~/.openmausbot`, on every
//     platform (server/data-dir.ts).
//   - `bots.json` there is a JSON array of bot records: `id`, `name`,
//     `modelSelection.instanceId` (the engine the bot runs on) and
//     `memoryEnabled` (off only when `false`).
//   - A bot's memory is `workspaces/<botId>/MEMORY.md` plus
//     `workspaces/<botId>/memory/<topic>.md` (docs/memory.md). The first 200
//     lines or 24 KB of MEMORY.md load into every turn. Each topic file is
//     listed under it by name with the `title`, `description` and `aliases` of
//     its frontmatter, and is read on demand.
//   - The folder is created at the bot's first turn, and `ensureWorkspace`
//     writes MEMORY.md only when there is none: a file the engine wrote first
//     is kept.
//   - A dated line (`- YYYY-MM-DD · from <source> · text`) is an entry the
//     host's upkeep may move to `memory/archive.md` when the file grows. "Lines
//     you wrote by hand (no date) ... never move", so the engine's line carries
//     no date and stays loaded.
//   - A topic file's frontmatter must come before anything but headings and
//     blank lines (server/memory-topics.ts), so the engine's marker sits after
//     it, not on the first line.
//   - Files are owner-only (0600, folders 0700) and written atomically, because
//     the app reads them from another process. The engine does the same.
//   - A bot's turn runs in `task-workspaces/<botId>/<threadId>`, or in the
//     project folder its owner set. The chat opens only files from that folder
//     and from the bot's own, hence the one line this host's note adds.
//
// Every function is fail-soft and synchronous: a missing folder, an unreadable
// bots.json or a read-only file is an answer, never an exception.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { nirvanaBotRules } from "./bot-note.ts";

export const OMB_TOPIC_FILE = "nirvana-os.md";
export const OMB_TOPIC_MARKER = "<!-- nirvana-os:openmausbot:v1 -->";
const OMB_TOPIC_MARKER_RE = /<!-- nirvana-os:openmausbot:v\d+ -->/;
/** What identifies the engine's line in MEMORY.md: the pointer to its topic file. */
const OMB_MEMORY_POINTER = `memory/${OMB_TOPIC_FILE}`;
/** The ids OpenMausBot accepts for a workspace folder (server/workspace.ts). */
const BOT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export interface OpenMausBot {
  id: string;
  /** `workspaces/<id>`: the bot's own folder, where its memory lives. */
  dir: string;
  name: string | null;
  /** The engine instance the bot runs on, as bots.json names it. */
  engine: string | null;
  /** False when the owner switched "Let this bot use memory" off. */
  memoryEnabled: boolean;
}

export type OpenMausBotOutcome = "written" | "refreshed" | "current" | "skipped" | "memory-off";

/** OpenMausBot's data folder. `NIRVANA_OPENMAUSBOT_DIR` moves it for a caller
 *  that names no home; the test preload sets it, so a test run never writes
 *  into the owner's real bots. Otherwise the app's own rule: `OMB_DATA_DIR`,
 *  else `.openmausbot` under the home. */
export function openMausBotDataDir(home?: string): string {
  if (home === undefined) {
    if (process.env.NIRVANA_OPENMAUSBOT_DIR) return process.env.NIRVANA_OPENMAUSBOT_DIR;
    if (process.env.OMB_DATA_DIR) return process.env.OMB_DATA_DIR;
  }
  return path.join(home ?? os.homedir(), ".openmausbot");
}

/** Every bot in bots.json. A record without a usable id is not listed. */
export function listOpenMausBots(home?: string): OpenMausBot[] {
  const data = openMausBotDataDir(home);
  let doc: unknown;
  try { doc = JSON.parse(fs.readFileSync(path.join(data, "bots.json"), "utf8")); } catch { return []; }
  if (!Array.isArray(doc)) return [];
  const out: OpenMausBot[] = [];
  for (const rec of doc) {
    if (!rec || typeof rec !== "object" || typeof rec.id !== "string" || !BOT_ID_RE.test(rec.id)) continue;
    const engine = rec.modelSelection && typeof rec.modelSelection === "object" ? rec.modelSelection.instanceId : null;
    out.push({
      id: rec.id,
      dir: path.join(data, "workspaces", rec.id),
      name: typeof rec.name === "string" && rec.name ? rec.name : null,
      engine: typeof engine === "string" && engine ? engine : null,
      memoryEnabled: rec.memoryEnabled !== false,
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

function comparable(p: string): string {
  let r = path.resolve(p);
  try { r = fs.realpathSync(r); } catch { /* a path that does not exist yet compares as written */ }
  return process.platform === "win32" || process.platform === "darwin" ? r.toLowerCase() : r;
}

/** The bot whose private folders hold `dir`: its own folder (`workspaces/<id>`)
 *  or one of its conversations' (`task-workspaces/<id>/...`). Null anywhere
 *  else, including a project folder the owner pointed the bot at. */
export function openMausBotAt(dir: string, home?: string): OpenMausBot | null {
  const data = comparable(openMausBotDataDir(home));
  const here = comparable(dir);
  for (const area of ["workspaces", "task-workspaces"]) {
    const root = path.join(data, area);
    if (!here.startsWith(root + path.sep)) continue;
    const id = here.slice(root.length + 1).split(path.sep)[0];
    return listOpenMausBots(home).find((b) => comparable(path.join(data, area, b.id)) === path.join(root, id)) ?? null;
  }
  return null;
}

/** The note the bot keeps about Nirvana-OS: a topic file whose frontmatter is
 *  what OpenMausBot lists under the bot's memory at every turn. */
export function openMausBotTopicText(): string {
  return [
    "---",
    "title: Nirvana-OS on this computer",
    "description: Read before producing any concrete deliverable (report, post, document, page, code, analysis, design). It goes through the nrv command.",
    "aliases: [nirvana, nrv, businesses, squads, mind-clones]",
    "---",
    OMB_TOPIC_MARKER,
    "",
    "The Nirvana-OS engine wrote this note and keeps it current. To stop using it, take the line that points here out of MEMORY.md; the engine does not put it back.",
    "",
    ...nirvanaBotRules(),
    "- **Show the delivery in the chat.** The delivered file is outside your working folder, and the chat opens only files from there: attach it with `attach_file` when you have that tool, otherwise copy it into your current working folder. Give its full path either way.",
    "",
  ].join("\n");
}

/** The line in MEMORY.md. No date on purpose: see the header of this file. */
function memoryLine(): string {
  return `- Nirvana-OS is installed on this computer. A request for a concrete deliverable goes through it; how is in ${OMB_MEMORY_POINTER}.`;
}

/** Put the line first among the bullet lines, else at the end of the file. */
function withMemoryLine(text: string, line: string): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const firstFact = lines.findIndex((l) => /^\s*[-*]\s+\S/.test(l));
  if (firstFact >= 0) { lines.splice(firstFact, 0, line); return lines.join(eol); }
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
  return [...lines, "", line, ""].join(eol);
}

/** Owner-only and atomic, as OpenMausBot writes these files itself: the app
 *  and the bot's own tools read them from other processes. The mode is a no-op
 *  on Windows, where the profile folder's ACL already does that job. */
function writePrivate(file: string, text: string): void {
  const tmp = `${file}.${process.pid}.nrv-tmp`;
  fs.writeFileSync(tmp, text, { encoding: "utf8", mode: 0o600 });
  try { fs.renameSync(tmp, file); } catch (e) { try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ } throw e; }
}

/**
 * Leave one bot knowing how to use Nirvana-OS. Idempotent.
 *
 * The topic file is the engine's: written when absent, rewritten when it
 * carries an older text under the engine's marker. The line in MEMORY.md is the
 * bot's and its owner's: it is added once, together with the topic file, and
 * never again, so an owner who removes it has turned the note off and it stays
 * off.
 *
 * A bot that has not had its first turn has no folder yet. The engine creates
 * it, with a MEMORY.md holding the line, so the bot knows from its first
 * conversation; OpenMausBot keeps a MEMORY.md that is already there.
 *
 * A bot whose owner switched its memory off is left untouched: nothing in
 * these files would reach it, and the owner asked for no memory.
 */
export function ensureOpenMausBotKnowsNirvana(bot: OpenMausBot): OpenMausBotOutcome {
  if (!bot.memoryEnabled) return "memory-off";
  const memoryFile = path.join(bot.dir, "MEMORY.md");
  const topicFile = path.join(bot.dir, "memory", OMB_TOPIC_FILE);
  try {
    const wanted = openMausBotTopicText();
    if (fs.existsSync(topicFile)) {
      const current = fs.readFileSync(topicFile, "utf8");
      // A file of that name without the engine's marker is somebody else's note.
      if (!OMB_TOPIC_MARKER_RE.test(current)) return "skipped";
      if (current === wanted) return "current";
      writePrivate(topicFile, wanted);
      return "refreshed";
    }
    fs.mkdirSync(path.dirname(topicFile), { recursive: true, mode: 0o700 });
    writePrivate(topicFile, wanted);
    const memory = fs.existsSync(memoryFile) ? fs.readFileSync(memoryFile, "utf8") : "# Memory\n";
    if (!memory.includes(OMB_MEMORY_POINTER)) writePrivate(memoryFile, withMemoryLine(memory, memoryLine()));
    return "written";
  } catch { return "skipped"; }
}

/** Does the bot still point at the engine's note? False once its owner removed the line. */
export function openMausBotUsesNirvana(bot: OpenMausBot): boolean {
  try {
    return fs.existsSync(path.join(bot.dir, "memory", OMB_TOPIC_FILE))
      && fs.readFileSync(path.join(bot.dir, "MEMORY.md"), "utf8").includes(OMB_MEMORY_POINTER);
  } catch { return false; }
}

export interface OpenMausBotAutoSetupResult {
  bots: Array<{ bot: OpenMausBot; outcome: OpenMausBotOutcome }>;
}

/** Every bot on the machine, prepared. A machine without OpenMausBot has no
 *  bots.json and this is one failed read. */
export function openMausBotAutoSetup(home?: string): OpenMausBotAutoSetupResult {
  return { bots: listOpenMausBots(home).map((bot) => ({ bot, outcome: ensureOpenMausBotKnowsNirvana(bot) })) };
}
