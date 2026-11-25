# Adapter · OpenBot by Nightly Labs (agent host)

> OpenBot (https://github.com/nightly-labs/openbot) is an **agent host**, not a
> runtime: a person creates agents there and talks to them, and each agent runs
> on an agent CLI of this computer (Claude Code, Codex, Grok, OpenCode, Gemini,
> Cursor, Kimi and others). This document says what the engine does for those
> agents, on its own. Read from OpenBot's source at commit `00f9e69`
> (2026-11-24, app 0.78.0); the paths quoted are files of that repository.
>
> It is not CopilotKit's OpenBot, an unrelated project of the same name. That
> one keeps its bots on a server, out of reach of a local `nrv`, and the engine
> does nothing for it.

---

## 1. What the engine relies on

| Fact | Where OpenBot says it |
|---|---|
| Every agent has a workspace folder `~/OpenBot/Agents/<agentId>`, on macOS, Windows and Linux | `src/backend/agent-store.ts` |
| A local server the app starts keeps its own root `~/OpenBot/Servers/<serverId>`, with the same `Agents/<agentId>` layout | `src/main/application-services.ts` |
| An agent keeps its standing rules in `AGENTS.md` at the root of its workspace, or `CLAUDE.md` when only that file exists | `docs/architecture/agents.md` ("Agent instruction file"), `AGENT_INSTRUCTION_FILE_NAMES` |
| OpenBot reads the file at every turn and gives its text to a provider that does not read it by itself, so every provider sees it | same section, `workspaceInstructionFiles` |
| The app shows the file as the agent's **Instructions** and the owner edits it there; OpenBot creates it with mode `0600` and writes atomically | `src/backend/agent/workspace-instructions.ts` |
| Agents run the provider CLIs of this computer with full access, so `nrv` on PATH is reachable from a turn | `README.md` |
| A file reaches the chat through the `attach_files_to_response` tool, which takes only files inside the agent's workspace | `src/backend/openbot-tools.ts`; the refusal was seen live |
| Agent names and providers are in `openbot.db`, table `projection_agents`, column `agent_json` | `docs/TROUBLESHOOTING.md`, the schema |

## 2. What the engine does

`_shared/lib/openbot.ts`. `openBotAutoSetup()` is called by the seams that
already run: the installer (and so every update), `nrv init`, `nrv dispatch`
and `nrv doctor`. There is no command for the user to type, and a machine
without OpenBot costs one failed directory read.

For every agent workspace, the engine keeps **one marked section** in the
agent's instruction file, between `<!-- nirvana-os:openbot:v1 -->` and
`<!-- /nirvana-os:openbot -->`. It carries the rules every host's bot gets
(`_shared/lib/bot-note.ts`): a concrete deliverable goes through
`nrv dispatch --auto --exec "<brief>"`, the brief keeps the request's words and
language, a correction is `nrv revise`, library questions are answered by the
command, and a delivery is real when the file is on disk. One line is this
host's own: copy each delivered file into the workspace and attach the copy
with `attach_files_to_response`, since the delivery is outside the workspace.

An agent with no instruction file gets an `AGENTS.md` holding only the
section, which is what OpenBot itself would create.

## 3. Whose text is whose

- The section is the engine's. It is rewritten in place when the engine's text
  changes, and the owner's text around it is kept byte for byte, line endings
  included.
- Everything else in the file is the owner's and the agent's.
- **Deleting the section turns it off.** The engine records each agent it
  prepared in `~/.nirvana/state/openbot-agents.json` and does not put the
  section back.
- `openbot.db` is only read, for the names the doctor prints. The engine never
  writes a file of the app.

## 4. What the user sees

- `nrv doctor` prints `openbot: agents` with each agent, its provider and its
  state: `prepared now`, `uses Nirvana-OS`, `section refreshed`,
  `section removed by its owner`, or why it was not prepared.
- The agent's **Instructions** page in OpenBot shows the section.
- `nrv init` inside an agent's workspace refuses: OpenBot owns that folder. A
  dispatch from there works as it is and delivers under `~/.nirvana/outputs`.

## 5. Known limits

- An agent created after the last `nrv` command ran is prepared by the next one
  (any dispatch, `nrv doctor`, `nrv init`, an engine update). OpenBot has no
  hook that fires when an agent is created.
- When the section is written while one of the agent's turns runs, OpenBot
  ends that turn with the line "Updated its instructions" and an **Undo**
  button. Undo removes the section, and that counts as the owner turning it
  off. Seen live on the first agent of the test below: the app's own
  introduction turn was running when the doctor prepared it.
- A Codex agent starts a new session when its `AGENTS.md` changes, so the first
  turn after the section is written or refreshed starts fresh.
- An agent that rewrites its own instruction file without the section has
  turned it off, the same as its owner deleting it.
- A remote server, an OpenBot in Docker or on a VPS, keeps its agents on
  another machine; only the workspaces under `~/OpenBot` on this computer are
  prepared.
- OpenBot's license is PolyForm Noncommercial 1.0.0. The engine ships none of
  its code; whoever uses OpenBot for work needs Nightly Labs' commercial terms.

## 6. Measured

On 2026-11-24, on macOS with OpenBot 0.78.0, one agent "Nirvana Prime" on
Claude Haiku 5.5, Nirvana-OS 0.15.6 installed and this adapter run from its
branch. Each request was typed in the agent's chat with no mention of
Nirvana-OS.

| Request | Send to final answer | Dispatch | Gate | Steps |
|---|---|---|---|---|
| A LinkedIn post of up to 120 words | 125 s | `nrv dispatch --auto --exec`, exit 0 | passed | 19, one failed: the attach refused a file outside the workspace; the agent copied it and attached the copy |
| A Markdown checklist for a new agency client, after the attach rule was fixed | 126 s | `nrv dispatch --auto --exec`, exit 0 | passed | 13, none failed |

Both times the agent attached the delivered file to the chat, gave the
original's full path, and listed the decisions the squad made. The audit
showed `brief_received`, `dispatch_squad` and `gate_passed` for each run.
