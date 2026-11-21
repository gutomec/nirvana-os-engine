# Adapter · Orca (host)

> Orca is a **host**, not a runtime: it manages workspaces and the terminals the
> agents run in (claude, codex, antigravity, grok, kimi, pi, opencode and
> others). This document says what the engine does when it finds itself inside
> one of Orca's terminals, and why nothing changes anywhere else. Decision record:
> `docs/architecture/adrs/ADR-009-orca-host.md`. Measured against Orca 1.4.198
> on 2026-09-09.

---

## 1. What Orca is

| Field | Value |
|---|---|
| Product | Orca desktop app and headless runtime (`orca serve`), CLI `orca` |
| Role for the engine | Execution host above the runtime; never a dependency |
| Workspaces | git repos and plain folders (`orca repo add --path <dir>`), each with a card (comment, board column) |
| Terminals | PTYs Orca owns, with an agent identity read from its status hooks |
| Orchestration | Run (namespace + inbox) → Task (DAG, `--deps`) → Dispatch (one attempt in one terminal); `worker-start`, `dispatch --inject`, `worker_done`, `ask`/`reply`, `escalation`, `check --wait`, `worker-read` (provider transcript), `--on <environment>` for paired servers. Experimental: a human turns it on in Settings |
| Also | embedded browser (`orca tab create --url`), automations (cron prompts), public artifacts (human-gated), skill sharing, iOS/Android emulators, Linear/Jira |
| Executable | `ORCA_CLI_COMMAND` when set; `orca-dev` in a dev checkout; **`orca-ide` on Linux outside an Orca terminal** (bare `orca` there is the GNOME screen reader); `orca` otherwise |

## 2. Detection, and the two settings

An Orca terminal exports `TERM_PROGRAM=Orca`, `ORCA_WORKTREE_ID` (`<repoId>::<path>`), `ORCA_TERMINAL_HANDLE`, `ORCA_PANE_KEY`, `ORCA_TAB_ID`, `ORCA_APP_VERSION`, `ORCA_USER_DATA_PATH` and the `ORCA_AGENT_HOOK_*` endpoint its status hooks post to. The engine reads those and nothing else (`_shared/lib/orca.js`).

| Setting | Variable | Default | Meaning |
|---|---|---|---|
| `host.orca` | `NIRVANA_ORCA_HOST` | `auto` | `auto`: only inside an Orca terminal. `on`: from any terminal, if the app answers (the workspace is then selected by the project path). `off`: never call Orca. |
| `execution.orca_workers` | `NIRVANA_ORCA_WORKERS` | `off` | `off`: dispatched workers run as the invisible headless child, also inside an Orca terminal. `on`: with the host active, each headless dispatch runs as a worker terminal (§4), for an owner who wants to watch workers in Orca. The variable also takes `1`/`0`. Replaces `host.orca_workers` (default `true`), retired in 0.15. |

Being inside an Orca terminal no longer moves workers into Orca tabs by itself. On 2026-10-15 an agy worker opened in a fresh run folder drew its "Do you trust the contents of this project?" dialog 0.3 s after the task was injected and waited 94 minutes for an Enter nobody pressed; four earlier Orca workers (grok, codex, agy) never reported back either. The headless child never asks.

`nrv config set host.orca off` is honored everywhere the settings core is read; the variable is honored by the CJS audit emitter too. The ledger's card projection gates on the variable and the terminal markers first (its module is the heartbeat sidecar's entry point and must not pay for the settings core on every start); a config-file `on` outside an Orca terminal reaches it through the variable the spawners pin on their children.

## 3. What changes inside Orca

| Seam | Outside Orca | Inside Orca |
|---|---|---|
| Audit events (`nrv audit emit`, hooks, engine) | unchanged | carry `orca: { worktree_id, terminal_handle, pane_key, app_version }` |
| `nrv doctor` | no line when Orca is not installed; an informational line when it is | `orca: host` names the app version, the agents with Orca hooks, whether orchestration is advertised, and the enclosing workspace. On both sides `orca: bots` lists each bot with its agent and whether it uses Nirvana-OS, and prepares one that lacks the note (§7) |
| `nrv init` | with the CLI on PATH: writes `orca.yaml` (§7) and, when the app answers, registers the project as a workspace, once per machine. Nothing is printed for the user to run | the same, and the current workspace's card is claimed instead of registering it again |
| Ledger transitions (`openRun`, `markState`) | unchanged | the workspace card shows `nirvana · <kind>/<slug> · <state>` and moves between `in-progress`, `in-review`, `completed` |
| Desktop notifications (`os-notify`) | unchanged | the same text lands on the card |
| `nrv glance` | system browser | a tab in Orca's embedded browser, scoped to the workspace |
| `runHeadless` (every `--exec` seat, squad, agent-x) | invisible child process | the same child by default; with `execution.orca_workers: on`, a worker terminal (§4), falling back to the child when it cannot start or stops on a dialog |
| Children the engine spawns | inherit the environment | inherit it **minus** the pane identity, so a `claude -p` is not reported as the coordinator pane's agent |

## 4. The worker transport

`_shared/lib/orca-worker.ts`, called first by the driver's runner switch when `execution.orca_workers` is `on`. The sequence, each step through `orca … --json`:

1. Write the brief file: the autonomous directive, the prompt the headless runner would have sent, and one reporting paragraph. The prompt travels **by reference** — Orca's inject types the task spec into the TUI, and a seat prompt is tens of kilobytes.
2. `orchestration run-create --objective "nirvana · <label>"` — one Run per dispatch, so its mailbox is this dispatch's alone.
3. `orchestration task-create --run <R> --spec "Read the file <brief> and execute every instruction in it…" --task-title <label>`.
4. Record workspace trust for `<cwd>` the way the runtime itself does (`~/.claude.json` `projects[cwd].hasTrustDialogAccepted`, `~/.codex/config.toml` `[projects."cwd"] trust_level = "trusted"`, `~/.qwen/trustedFolders.json`), then `terminal create --worktree <selector> --title "<label> · <agent>" --command "cd <cwd> && env NIRVANA_… <agent argv>"` — operator-started, with the engine's own autonomy flags (`claude --dangerously-skip-permissions`, `codex --dangerously-bypass-approvals-and-sandbox`, `agy --dangerously-skip-permissions`, `grok --always-approve`; `--safe` drops them). PowerShell syntax on Windows. The headless runner already runs the agent there with every permission bypassed and no dialog; the record makes the same decision visible in the runtime's own file.
5. `terminal wait --for tui-idle --timeout-ms 120000`, then `terminal read`: a TUI parked on a first-run trust dialog is idle too, and deaf to the preamble (measured: the inject call sat until its timeout). A screen that still shows one is a fallback, not a hang.
6. `orchestration dispatch --run <R> --task <T> --to <handle> --inject` — Orca types its preamble plus the spec; the worker learns its task and dispatch ids and how to report.
7. **Did it take the task?** For about six seconds after the inject (`NIRVANA_ORCA_POST_INJECT_MS`), `terminal read` every 1.5 s. A trust, permission or plan-review dialog on screen, or the task spec left sitting unsent on a screen that never moves, closes the terminal, fails the task and returns `null`: the same run goes to the headless child, under the session rules the headless runner always applies (`x_orca_transport_fallback` with `after_inject: true`). The `tui-idle` wait answers before a slow TUI has drawn its dialog, so the check before the inject alone missed it.
8. The terminal, Run, task and dispatch ids are recorded on the run's ledger row (`meta.orca_worker`), so `nrv run-track stop` and the stall guard can close the terminal: a worker in an Orca tab is not in the dispatcher's process tree.
9. `orchestration check --run <R> --wait --types worker_done,escalation,question --timeout-ms <window>` in a loop, acknowledging each delivery; a `question` is answered with `orchestration reply` and the zero-human policy. The wait ends on the report, a failed dispatch, a vanished terminal, an explicit `--timeout`, or the **silence budget**: no message, no Orca check-in (`worker-show`'s heartbeat), no file written under the run's folders, no hook-recorded tool activity and no live child run since the inject for `execution.stall_timeout_min` (90), or nothing at all for `execution.stall_no_start_min` (45). A window never outlasts the budget. A stall marks the ledger row `stalled` and the dispatch exits 76, as the heartbeat sidecar's stall guard does for a headless child (`harness/lib/stall-guard.ts`). The 7-day ledger backstop no longer applies to a worker.
10. `orchestration worker-read --dispatch <D>` — the provider transcript, archived beside the brief.
11. `terminal close` on success, on a timeout and on a stall; the tab stays open on another failure (and with `NIRVANA_ORCA_KEEP_WORKERS=1`).

Audit: `x_orca_worker_started`, `x_orca_worker_done`, `x_orca_transport_fallback` (with the stage and Orca's error code). The result is a `RunHeadlessResult` like any other: `ok` from the outcome, `result` from the worker's summary and report path, `costUsd` from the worker's own transcript when it is claude and the model has a price (an estimate: `costEstimated: true`), else `null`; `sessionId` as §5 says; `warnings` naming the terminal, the dispatch and the transcript. `x_orca_worker_done` carries the `session_id`.

**Fallbacks that keep the headless child** (returned as `null`): host inactive, `execution.orca_workers` off, a runtime without an Orca agent id (`qwen-code`), `run-create` refused (orchestration off: `run_required`), `task-create` or `dispatch` refused (`nested_worker_depth_exceeded`, `inject_rejected`), the terminal not created, the agent not reaching its prompt, a trust dialog still on screen before the inject, and, after it, a dialog or an unsent task (step 7). A task or terminal already created is failed or closed first.

Orca reports an operator-started worker as `unsupervised`, which is exact: the engine owns the terminal's lifecycle as it owns a child pid. `worker-release` would report `retained` with no action; the engine closes the tab itself.

## 5. Runtime → Orca agent id

| Nirvana runtime | Orca agent | Interactive command |
|---|---|---|
| `claude-code` | `claude` | `claude --dangerously-skip-permissions [--model M] [--add-dir D…]` |
| `codex` | `codex` | `codex --dangerously-bypass-approvals-and-sandbox [-m M] [--add-dir D…]` |
| `antigravity-cli` | `antigravity` | `agy --dangerously-skip-permissions [--model M]` |
| `grok-cli` | `grok` | `grok --always-approve [-m M]` |
| `kimi-cli` | `kimi` | `kimi [-m M]` |
| `pi` | `pi` | `pi [--model M]` |
| `opencode` | `opencode` | `opencode` |
| `qwen-code` | none | headless child |

**The worker's session.** Every worker records a session `nrv revise` and the gate's corrections can continue, as a headless run does:

| Runtime | New worker | Resume (revise, corrections) | Where the id comes from |
|---|---|---|---|
| `claude-code` | `--session-id <uuid>` | `--resume <id>` | chosen by the engine |
| `grok-cli` | `--session-id <uuid>` | `-r <id>` | chosen by the engine |
| `kimi-cli` | `--session <uuid>` | `--session <id>` | chosen by the engine |
| `pi` | `--session-id <uuid>` | `--session-id <id>` | chosen by the engine |
| `codex` | (codex chooses) | `codex resume <id> …` | `$CODEX_HOME/sessions/…/rollout-*.jsonl` whose `session_meta` names the worker's folder and a start after the worker's |
| `antigravity-cli` | (agy chooses) | `--conversation <id>` | the last `~/.gemini/antigravity-cli/history.jsonl` entry for the worker's folder since it started |
| `opencode` | none | headless child | none: a revise there runs fresh and seeded |

A worker runs in its own run folder, so "this folder, since this moment" is one session. The readers live in `_shared/lib/session-capture.ts`.

Hermes and OpenClaw are not Orca agents; they run as plain commands in an Orca terminal and keep their own adapters.

## 6. Known limits

- **Session ids read back.** codex and agy pick their own ids, so the engine reads them from their session files after the worker ends (§5). A worker whose CLI wrote nothing there records no id, and `nrv revise` then runs a fresh session seeded with the brief, the delivery and the gate findings (`x_revise_fresh_session`).
- **Depth.** Orca's nested-worker depth defaults to one generation. A seat that sub-dispatches a squad runs that squad as a headless child (`nested_worker_depth_exceeded` → fallback) unless the user raises the depth in Orca's settings.
- **Experimental toggle.** The orchestration layer is off until a human enables it in Orca's Settings. Off, every dispatch keeps the headless child; the card, the audit block, the doctor line and the browser tab still work.
- **Cost.** Orca reports none. A claude worker's tokens are read from its transcript and priced when the model is in the estimator's table; otherwise the cost stays unknown (`costUnavailable`).
- **Windows shell.** The worker command is PowerShell; an Orca terminal configured for cmd.exe would not run it (the agent then never reaches its prompt and the dispatch falls back).
- **Trust records.** Pre-accepting trust is known for Claude Code, Codex and Qwen; Antigravity, Grok, Kimi, Pi and OpenCode rely on the screen checks before and after the inject and fall back if they ask.
- **Unsent prompt.** "Not accepted" is read from the screen alone: a dialog, or the spec still on the last lines of a screen that did not change across the reads. A TUI that takes the task without redrawing anything for six seconds would be sent to the headless child; none measured so far does (claude, codex and agy animate a timer while they work).
- **Orca's heartbeat field.** The silence budget reads `lastHeartbeatAt` (or `last_heartbeat_at`) from `worker-show`; on 2026-10-15 it stayed NULL for a hung worker. Its spelling on a live check-in is not yet confirmed against Orca; the file, hook and child-run signals do not depend on it.
- **Attribution of plain children.** Orca's hooks attribute a `claude -p` that inherits the pane variables to that pane. The engine strips them; a script that spawns an agent by itself inside an Orca terminal does not get that courtesy.

## 7. Bots and projects: what the engine sets up on its own

Nobody types a setup command for Orca. The seams that already run (`nrv setup` at install and update, `nrv init`, `nrv dispatch`, `nrv doctor`) leave the machine ready; `host.orca: off` turns the project half off. Code: `_shared/lib/orca-bots.ts`.

**Bots.** A bot lives in `~/.orca/bots/<slug>/` with `AGENTS.md`, `CLAUDE.md` (`@AGENTS.md`), `SOUL.md`, `MEMORY.md`, `memory/` and `bot.json`, and runs on the owner's agent sign-in. Three facts decide where the engine may write:

| File | Who owns it | What the engine does |
|---|---|---|
| `AGENTS.md`, `CLAUDE.md`, `bot.json` | Orca ("edits to them are replaced") | nothing |
| `SOUL.md` | the owner ("change it only when your owner asks") | nothing |
| `MEMORY.md`, `memory/<topic>.md` | the bot's memory, one line per fact | writes `memory/nirvana-os.md` and one dated line pointing to it |

The note tells the bot to hand a concrete deliverable to `nrv dispatch --auto --exec "<brief>"`, to write the brief in English and state the deliverable's language inside it, to correct with `nrv revise`, to answer library questions with the `nrv list-*` commands and to report full paths. The topic file is the engine's and is rewritten when its marker (`<!-- nirvana-os:orca-bot:vN -->`) is older. The line in `MEMORY.md` is added once, with the topic file, and never again: an owner who takes it out has turned the note off. A `memory/nirvana-os.md` without the marker is somebody's own note and is left alone.

A bot's run is not an Orca terminal (its audit events carry no `orca` block), so a bot is recognised by its folder. `nrv init` on a bot's folder is refused: the files it would write are the ones Orca owns.

**Projects.** Orca has no "project created" hook; it has a per-project setup script that runs when a worktree is created.

| Moment | What happens |
|---|---|
| `nrv init` with the Orca CLI on PATH | `orca.yaml` is written when the project has none (`scripts.setup: nrv init . --adopt`, the same line under bash and PowerShell); the project is registered as a workspace when the app answers |
| Orca creates a worktree | its setup terminal runs `nrv init . --adopt`: `.nirvana/project.yaml` and nothing else, idempotent |
| A top-level `nrv dispatch` from an Orca workspace that is not a project | the workspace is adopted (`.nirvana/project.yaml`) and gets the same `orca.yaml`, then the run proceeds in it |
| A dispatch with the host active from a project Orca was never shown | registered as a workspace, once (`~/.nirvana/cache/orca-workspaces.json` remembers it per machine) |

An `orca.yaml` already in the project is never edited. `NIRVANA_ORCA_BOTS_DIR` moves the bots root; the test preload sets it so a test run cannot reach the owner's bots.

Not done, and why: a restricted mode for requests a bot takes from someone other than its owner. On 1.4.265 nothing in a bot's run says who asked, so the engine cannot tell the two apart.

## 8. Measured

On 2026-09-09, Orca 1.4.198, macOS: the transport sequence ran end to end from a shell outside Orca targeting a registered workspace (`run-create`, `task-create`, `terminal create` with `claude --dangerously-skip-permissions`, `wait tui-idle`, `dispatch --inject`, `check --run --wait`); the worker sent `worker_done` with `taskId`, `dispatchId`, `outcome: succeeded`, `filesModified` and `reportPath`, and the file the brief asked for existed eighteen seconds after injection. `worker-read` returned the provider transcript with `source: "transcript"`. Two headless `claude -p` children were spawned in Orca terminals: the one inheriting `ORCA_PANE_KEY` registered its pane as a `claude` agent; the one without it registered nothing. `run-create` from a shell outside any Orca terminal succeeded and bound the Run to a live agent terminal of the workspace, which is why the engine creates Runs only for its own dispatches and addresses every later call with `--run`.

On 2026-11-20, Orca 1.4.265, macOS: a bot created in the UI on Claude Code used Nirvana-OS with no instruction (the agent found the `nirvana` skill) and delivered through `nrv dispatch --auto --exec`; its hook events carried the bot folder as `cwd` and no `orca` block; its `AGENTS.md` carried the "edits to them are replaced" line quoted in §7. `nrv init . --adopt` was run twice in a row (written, then "already a Nirvana project"). A scaffold-only dispatch inside a simulated workspace (fake `orca`, `ORCA_WORKTREE_ID`) adopted it, wrote `orca.yaml` and registered once. Not measured: the setup script firing in a real worktree, the bots root on Windows, and whether a bot rereads `MEMORY.md` at the start of every chat.

## 9. Sources

Orca's own version-matched guides: `orca skills get orca-cli`, `orca skills get orchestration`, `orca agent-context --json` (234 commands with usage and notes on 1.4.198).
