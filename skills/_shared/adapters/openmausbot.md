# Adapter · OpenMausBot (bot host)

> OpenMausBot is a **bot host**, not a runtime: a person creates bots there and
> talks to them, and each bot runs on an agent CLI the machine already has
> (`claude`, `codex`, `grok`). This document says what the engine does for those
> bots, on its own. Read from OpenMausBot's source at commit `3aec210`
> (2026-11-23); the paths quoted are files of that repository.

---

## 1. What the engine relies on

| Fact | Where OpenMausBot says it |
|---|---|
| The data folder is `OMB_DATA_DIR`, else `~/.openmausbot`, on macOS, Windows and Linux | `server/data-dir.ts` |
| `bots.json` in that folder is a JSON array of bot records: `id`, `name`, `modelSelection.instanceId`, `memoryEnabled` | `server/bots-text.ts`, `server/store.ts` |
| A bot's memory is `workspaces/<botId>/MEMORY.md` and `workspaces/<botId>/memory/<topic>.md` | `docs/memory.md`, `server/workspace.ts` |
| The first 200 lines or 24 KB of `MEMORY.md` load into every turn | `docs/memory.md` |
| Each topic file is listed under the memory by name, with the `title`, `description` and `aliases` of its frontmatter, and is read on demand | `server/memory-topics.ts` |
| Upkeep moves only dated entries (`- YYYY-MM-DD · …`) to `memory/archive.md`; a line with no date never moves | `docs/memory.md`, `server/memory-entries.ts` |
| The folder appears at the bot's first turn; a `MEMORY.md` already there is kept | `ensureWorkspace` in `server/workspace.ts` |
| Memory files are owner-only (`0600`, folders `0700`) and written atomically | `docs/memory.md` |
| A turn runs in `task-workspaces/<botId>/<threadId>`, or in the project folder the owner set; the chat opens only files from that folder and the bot's own | `workspaceLocationsPrompt` in `server/workspace.ts` |

## 2. What the engine does

`_shared/lib/openmausbot.ts`. `openMausBotAutoSetup()` is called by the seams
that already run: the installer (and so every update), `nrv init`,
`nrv dispatch` and `nrv doctor`. There is no command for the user to type, and
a machine without OpenMausBot costs one failed file read.

For every bot in `bots.json` whose memory is on:

1. **`workspaces/<botId>/memory/nirvana-os.md`**, the engine's own file. Its
   frontmatter is what OpenMausBot lists under the bot's memory, so the bot sees
   at every turn that the note exists and when to read it. The body carries the
   same rules every host's bot gets (`_shared/lib/bot-note.ts`): a concrete
   deliverable goes through `nrv dispatch --auto --exec "<brief>"`, the brief
   keeps the request's words and language, a correction is `nrv revise`,
   library questions are answered by the command, and a delivery is real when
   the file is on disk. One line is this host's own: attach the delivered file
   (`attach_file`) or copy it into the working folder, because the chat opens
   files only from there.
2. **One line in `MEMORY.md`** pointing at that file, with no date, so the
   host's upkeep never archives it.

A bot that has not had its first turn has no folder yet. The engine creates it
with a `MEMORY.md` holding that line, and the bot knows from its first
conversation.

## 3. Whose file is whose

- The topic file is the engine's. It is rewritten when the engine's text
  changes. A `nirvana-os.md` without the engine's marker
  (`<!-- nirvana-os:openmausbot:v1 -->`) is somebody else's note and is left
  alone.
- The line in `MEMORY.md` is the bot's and its owner's. It is added once,
  together with the topic file. **Removing it turns the note off**, and the
  engine does not put it back.
- A bot with **Let this bot use memory** switched off is not touched.
- `bots.json` and every other file of the app are only read.

## 4. What the user sees

- `nrv doctor` prints `openmausbot: bots` with each bot, its engine and its
  state: `prepared now`, `uses Nirvana-OS`, `note refreshed`,
  `note turned off by its owner`, or why it was not prepared.
- `nrv init` inside `workspaces/<botId>` or `task-workspaces/<botId>/…`
  refuses: those are a bot's private folders, not a project. A dispatch from
  there works as it is and delivers under `~/.nirvana/outputs`.

## 5. Known limits

- A bot created after the last `nrv` command ran is prepared by the next one
  (any dispatch, `nrv doctor`, `nrv init`, an engine update). OpenMausBot has no
  hook that fires when a bot is created.
- The bot needs an engine that can run a shell command. One on a chat-only
  engine reads the note and cannot act on it.
- A Cloud or team home keeps its data on another machine; only the bots of the
  data folder on this computer are prepared.
- Not yet measured against a running OpenMausBot: the note's wording was
  checked with the host's own parsers (`parseMemoryEntries`,
  `parseTopicHeader`, `renderTopicIndex`), not in a live conversation.

## 6. Tests

`_shared/tests/openmausbot.test.ts`. The test preload points
`NIRVANA_OPENMAUSBOT_DIR` at a temp folder, so no test run writes into the
owner's real bots.
