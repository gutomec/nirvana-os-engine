// bot-note.ts — what every host's bot is told about Nirvana-OS, whatever the
// host (Orca, OpenMausBot, OpenBot). One list, so a bot on one host and a bot
// on another follow the same rules. English, like every string the engine
// writes for an agent; the deliverable's language is the request's.
//
// A bot is its owner's, and most of what it does has nothing to do with
// Nirvana-OS. So the note is **on demand** by default, the way the `nirvana`
// skill is on an agent CLI: the bot reaches for Nirvana-OS when the request
// names it, or names the owner's businesses, squads or mind-clones, or asks
// for a team, and works as it always did otherwise. A bot made for Nirvana-OS,
// one whose name or description names it, sends every deliverable through it.
// `bots.use: always` makes every bot do that.
import { resolveSetting } from "./settings.ts";

export type BotUse = "on-demand" | "always";

/** How this bot uses Nirvana-OS: `always` when the owner set `bots.use` so, or
 *  made the bot for it (its name or description names Nirvana); else on demand. */
export function botUse(name?: string | null, about?: string | null): BotUse {
  try { if (resolveSetting("bots.use").value === "always") return "always"; } catch { /* no settings: the default */ }
  return /\bnirvana\b/i.test(`${name ?? ""} ${about ?? ""}`) ? "always" : "on-demand";
}

/** One sentence on when the note applies, for a host that lists notes by description. */
export function nirvanaBotWhen(use: BotUse): string {
  return use === "always"
    ? "Read before producing any concrete deliverable (report, post, document, page, code, analysis, design). It goes through the nrv command."
    : "Read when a request names Nirvana-OS, your owner's businesses, squads or mind-clones, or asks for a team of agents. Not for other requests.";
}

/** The pointer line a bot keeps in MEMORY.md, after the bullet and any date. */
export function nirvanaMemorySentence(pointer: string): string {
  return `Nirvana-OS is installed on this computer. When to use it, and how, is in ${pointer}.`;
}

/** A MEMORY.md whose pointer line still says every deliverable goes through
 *  Nirvana-OS, the sentence releases up to 0.17.0 wrote, brought to the current
 *  one. The line stays where it is, date included; any other text is untouched. */
export function withCurrentMemorySentence(text: string, pointer: string): string {
  return text.split(`Nirvana-OS is installed on this computer. A request for a concrete deliverable goes through it; how is in ${pointer}.`)
    .join(nirvanaMemorySentence(pointer));
}

/** The intro and the rules, one markdown line each. Each host adds its own
 *  heading, marker and, where its chat needs it, a line of its own. */
export function nirvanaBotRules(use: BotUse = "on-demand"): string[] {
  const when = use === "always"
    ? "- **A concrete deliverable goes to Nirvana-OS.** A report, a post, a document, a page, code, an analysis, a design: run `nrv dispatch --auto --exec \"<brief>\"` and wait for it to exit. It can take several minutes. Do not write the deliverable yourself."
    : [
      "- **Use Nirvana-OS only when the request calls for it.** It does when it names Nirvana, nirvana-os or `nrv`; names or points to one of your owner's businesses, squads or mind-clones, by name, by kind or as the model to follow; or asks for a team of agents. Every other request is yours: work as you always do, and do not bring Nirvana-OS up.",
      "- **When it does, the deliverable goes to Nirvana-OS.** Run `nrv dispatch --auto --exec \"<brief>\"` and wait for it to exit. It can take several minutes. Do not write that deliverable yourself.",
    ].join("\n");
  return [
    "Nirvana-OS is your owner's library of businesses, squads and mind-clones. Its command is `nrv`; when `nrv` is not on PATH, call `~/.local/bin/nrv`.",
    "",
    ...when.split("\n"),
    "- **The brief carries the request in the words and the language it came in.** Nirvana-OS reads any language and delivers in the request's language unless the request names another.",
    "- **A correction** to something already dispatched is `nrv revise <project> \"<change>\"`, never a second dispatch.",
    "- **Questions about the library** are answered by the command, not from memory: `nrv list-businesses`, `nrv list-squads`, `nrv list-clones`, `nrv find \"<need>\"`. Report only what it prints.",
    "- **A delivery is real when the file is on disk.** Reply with the commands you ran and the full path of each delivered file. Exit code 0 means delivered; anything else, say what the command printed.",
  ];
}
