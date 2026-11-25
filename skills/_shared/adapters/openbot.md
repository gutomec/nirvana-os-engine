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
(`_shared/lib/bot-note.ts`): the bot uses Nirvana-OS **on demand**: when the request names it, names one of the owner's businesses, squads or mind-clones, or asks for a team, and works as it always did otherwise. A bot made for Nirvana-OS, one whose name or description names it, sends every concrete deliverable through it, and `bots.use: always` makes every bot do that. When Nirvana-OS is used, the deliverable goes through
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

## 4a. Teams

The section also tells the agent when to build a team (the person asks for one,
or the request is a whole project across several areas) and how: `nrv team`.
A team member's `AGENTS.md` carries its team's section in place of this one,
and `nrv doctor` shows it as `member of the team <slug>`. See `teams.md`.

## 4b. Handing work to an OpenBot agent: `nrv bot`

The other direction: a dispatch running anywhere on this computer (Claude Code
in a terminal, Codex, another bot host) hands a part of the work to an agent
the person already configured in OpenBot, an image agent for example. Code:
`_shared/lib/openbot-call.ts` and `harness/scripts/bot.ts`. The engine talks to
the app's local automation API, the one its bundled `cli/openbot-cli.mjs` uses
(read at app 0.78.0), so nothing depends on where the app is installed.

**The person decides who can be called.** Agent settings → **Rules** →
**Permissions** → **Local scripts**, per agent. No agent tool can set it
(`update_profile` refuses the field) and the engine never tries. The switch
also lets a script answer the agent's questions and accept its approvals; the
engine does neither. It belongs on a specialist, and deserves a second thought
on an agent that creates and deletes others.

**What the engine does, with no command from the person:**

- `nrv dispatch` and `nrv revise` read which agents are open (name, title,
  description and provider, from the app's database, read only) and, when the
  app is running, add a short block to the worker's directive: who can be
  called, for what, and the command. The worker decides. With no agent open, or
  the app closed, the block is empty and nothing changes.
- `nrv doctor` prints `openbot: callable` with their names.

**The command, for an agent to run:**

```
nrv bot list
nrv bot ask "<agent>" "<task>" [--out <dir>] [--timeout 30m] [--json]
nrv bot status <deliveryId> [--out <dir>]
```

`ask` sends the task with one added line (nobody is reading the chat: do not
ask before saving, keep every file in the workspace and give its path), waits,
and copies every file the agent made in its workspace since the call started
into `--out` (default `./from-openbot/<agent>`), keeping the relative path.
Hidden folders and the agent's own instruction files are never copied. The
audit gets `x_bot_called` with the agent, the state, the file count and the
seconds.

| Exit | Meaning |
|---|---|
| 0 | the agent finished; its answer and the copied files are printed |
| 1 | the turn failed, the wait ran out, or OpenBot could not be reached |
| 2 | the agent waits for its person: the question is printed, the person answers in OpenBot, `nrv bot status <deliveryId>` finishes the call |
| 4 | wrong arguments |

What does not work:

- **Relaying through another agent.** An orchestrator that forwards the task
  with `send_message` ends its turn at once; the caller never learns when the
  work is done. `nrv bot ask` calls the specialist itself.
- **Running a workflow.** The automation API has no route for one. An agent
  with the switch on can create one with `edit_workflow` and run it with
  `run_workflow` when asked.
- **A remote server.** Only this computer's own OpenBot is reached.

Not checked: Windows and Linux (the automation folder is read from
`%APPDATA%\\OpenBot\\automation` and `~/.config/OpenBot/automation`, as the app's
CLI does, but no call was made there), video generation, and the hourly limit
OpenBot applies to local scripts (its error text names one; the number was not
measured).

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

On 2026-11-25, same machine, the calls of section 4b, made with the app's own `openbot-cli` before `nrv bot` existed. "Estúdio de
Imagem" is an agent on the ChatGPT provider (`gpt-6-luna`) that generates
images with the provider's own image tool.

| Call | Result | Time |
|---|---|---|
| `run "Nirvana Prime"`: a small SVG icon | exit 0, file in the agent's workspace, path in the answer | 16 s |
| `run "Nirvana Prime"`: create a four-node workflow (trigger, two agents, output) and run it | exit 0; the run and its four steps `done` in OpenBot's database | 34 s, the run itself 15 s |
| A hero image relayed by Nirvana Prime to the image agent | the call returned "queued" in 4 s; the PNG (1536×1024) existed 85 s later | not observable by the caller |
| `run "Estúdio de Imagem"`: a square icon | exit 3 after 30 s, the agent asked whether to attach; answered in the chat, `status` returned exit 0 | 30 s + 10 s |
