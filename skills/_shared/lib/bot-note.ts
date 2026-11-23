// bot-note.ts — what every host's bot is told about Nirvana-OS, whatever the
// host (Orca, OpenMausBot). One list, so a bot on one host and a bot on
// another follow the same rules. English, like every string the engine writes
// for an agent; the deliverable's language is the request's.

/** The intro and the rules, one markdown line each. Each host adds its own
 *  heading, marker and, where its chat needs it, a line of its own. */
export function nirvanaBotRules(): string[] {
  return [
    "Nirvana-OS is your owner's library of businesses, squads and mind-clones. Its command is `nrv`; when `nrv` is not on PATH, call `~/.local/bin/nrv`.",
    "",
    "- **A concrete deliverable goes to Nirvana-OS.** A report, a post, a document, a page, code, an analysis, a design: run `nrv dispatch --auto --exec \"<brief>\"` and wait for it to exit. It can take several minutes. Do not write the deliverable yourself.",
    "- **The brief carries the request in the words and the language it came in.** Nirvana-OS reads any language and delivers in the request's language unless the request names another.",
    "- **A correction** to something already dispatched is `nrv revise <project> \"<change>\"`, never a second dispatch.",
    "- **Questions about the library** are answered by the command, not from memory: `nrv list-businesses`, `nrv list-squads`, `nrv list-clones`, `nrv find \"<need>\"`. Report only what it prints.",
    "- **A delivery is real when the file is on disk.** Reply with the commands you ran and the full path of each delivered file. Exit code 0 means delivered; anything else, say what the command printed.",
  ];
}
