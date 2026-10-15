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
| `execution.orca_workers` | `NIRVANA_ORCA_WORKERS` | `off` | `off`: a headless dispatch stays the invisible child process, also inside an Orca terminal. `on`: with the host active, it runs as a worker terminal, falling back to the child when the agent stops on a dialog. Replaces `host.orca_workers` (on by default until 0.14.12): an interactive TUI can stop on a trust, permission or plan dialog nobody answers (an agy worker sat 94 minutes on its trust dialog, 2026-10-15); the headless child cannot. `1`/`true` in the variable mean `on`. |

`nrv config set host.orca off` is honored everywhere the settings core is read; the variable is honored by the CJS audit emitter too. The ledger's card projection gates on the variable and the terminal markers first (its module is the heartbeat sidecar's entry point and must not pay for the settings core on every start); a config-file `on` outside an Orca terminal reaches it through the variable the spawners pin on their children.

## 3. What changes inside Orca

| Seam | Outside Orca | Inside Orca |
|---|---|---|
| Audit events (`nrv audit emit`, hooks, engine) | unchanged | carry `orca: { worktree_id, terminal_handle, pane_key, app_version }` |
| `nrv doctor` | no line when Orca is not installed; an informational line when it is | `orca: host` names the app version, the agents with Orca hooks, whether orchestration is advertised, and the enclosing workspace |
| `nrv init` | prints the one `repo add` command when the CLI is on PATH | registers the project as a workspace (or claims the current one) and sets its card |
| Ledger transitions (`openRun`, `markState`) | unchanged | the workspace card shows `nirvana · <kind>/<slug> · <state>` and moves between `in-progress`, `in-review`, `completed` |
| Desktop notifications (`os-notify`) | unchanged | the same text lands on the card |
| `nrv glance` | system browser | a tab in Orca's embedded browser, scoped to the workspace |
| `runHeadless` (every `--exec` seat, squad, agent-x) | invisible child process | the same child, unless `execution.orca_workers: on`: then a worker terminal (§4), falling back to the child on any failure before the worker takes its task |
| Children the engine spawns | inherit the environment | inherit it **minus** the pane identity, so a `claude -p` is not reported as the coordinator pane's agent |

## 4. The worker transport

`_shared/lib/orca-worker.ts`, called first by the driver's runner switch. The sequence, each step through `orca … --json`:

1. Write the brief file: the autonomous directive, the prompt the headless runner would have sent, and one reporting paragraph. The prompt travels **by reference** — Orca's inject types the task spec into the TUI, and a seat prompt is tens of kilobytes.
2. `orchestration run-create --objective "nirvana · <label>"` — one Run per dispatch, so its mailbox is this dispatch's alone.
3. `orchestration task-create --run <R> --spec "Read the file <brief> and execute every instruction in it…" --task-title <label>`.
4. Record workspace trust for `<cwd>` the way the runtime itself does (`~/.claude.json` `projects[cwd].hasTrustDialogAccepted`, `~/.codex/config.toml` `[projects."cwd"] trust_level = "trusted"`, `~/.qwen/trustedFolders.json`), then `terminal create --worktree <selector> --title "<label> · <agent>" --command "cd <cwd> && env NIRVANA_… <agent argv>"` — operator-started, with the engine's own autonomy flags (`claude --dangerously-skip-permissions`, `codex --dangerously-bypass-approvals-and-sandbox`, `agy --dangerously-skip-permissions`, `grok --always-approve`; `--safe` drops them). PowerShell syntax on Windows. The headless runner already runs the agent there with every permission bypassed and no dialog; the record makes the same decision visible in the runtime's own file.
5. `terminal wait --for tui-idle --timeout-ms 120000`, then `terminal read`: a TUI parked on a first-run trust dialog is idle too, and deaf to the preamble (measured: the inject call sat until its timeout). A screen that still shows one is a fallback, not a hang.
6. `orchestration dispatch --run <R> --task <T> --to <handle> --inject` — Orca types its preamble plus the spec; the worker learns its task and dispatch ids and how to report. The screen is then read again for six seconds (`NIRVANA_ORCA_POST_INJECT_MS`): a trust, permission or plan-review dialog, or the task left unsent on a screen that does not move, closes the terminal and the run continues as the headless child (`x_orca_transport_fallback` with `after_inject: true`). The terminal, Run, Task and dispatch ids are recorded on the ledger row (`meta.orca_worker`), so the stall guard and `nrv run-track close` can close it.
7. `orchestration check --run <R> --wait --types worker_done,escalation,question --timeout-ms <window>` in a loop, acknowledging each delivery; a `question` is answered with `orchestration reply` and the zero-human policy; an explicit `--timeout`, a failed dispatch or a vanished terminal ends the wait as a failure, and so does the silence budget: no message, no Orca heartbeat, no file under the run's folders, no hook-recorded tool event and no live child run for `execution.stall_timeout_min` (or none at all within `execution.stall_no_start_min` of the inject) ends it as stalled, the terminal closed. The ledger's 7-day backstop does not apply to the wait.
8. `orchestration worker-read --dispatch <D>` — the provider transcript, archived beside the brief.
9. `terminal close` on success, on a timeout and on a stall; the tab stays open on another failure (and with `NIRVANA_ORCA_KEEP_WORKERS=1`).

Audit: `x_orca_worker_started`, `x_orca_worker_done`, `x_orca_transport_fallback` (with the stage and Orca's error code). The result is a `RunHeadlessResult` like any other: `ok` from the outcome, `result` from the worker's summary and report path, `costUsd` estimated from the claude transcript for a claude worker and null otherwise (Orca reports no cost), `sessionId` (§6), `warnings` naming the terminal, the dispatch and the transcript.

**Fallbacks that keep the headless child** (returned as `null` before the worker takes its task): host inactive, `execution.orca_workers` off, a runtime without an Orca agent id (`qwen-code`), `run-create` refused (orchestration off: `run_required`), `task-create` or `dispatch` refused (`nested_worker_depth_exceeded`, `inject_rejected`), the terminal not created, the agent not reaching its prompt, a trust dialog still on screen, a dialog or an unsent task after the inject, a resume on a runtime that cannot resume interactively (`opencode`). A task or terminal already created is failed or closed first.

Orca reports an operator-started worker as `unsupervised`, which is exact: the engine owns the terminal's lifecycle as it owns a child pid. `worker-release` would report `retained` with no action; the engine closes the tab itself.

## 5. Runtime → Orca agent id

| Nirvana runtime | Orca agent | Interactive command |
|---|---|---|
| `claude-code` | `claude` | `claude --dangerously-skip-permissions [--resume S \| --session-id S] [--model M] [--add-dir D…]` |
| `codex` | `codex` | `codex [resume S] --dangerously-bypass-approvals-and-sandbox [-m M] [--add-dir D…]` |
| `antigravity-cli` | `antigravity` | `agy --dangerously-skip-permissions [--continue] [--model M]` |
| `grok-cli` | `grok` | `grok --always-approve [-r S \| --session-id S] [-m M]` |
| `kimi-cli` | `kimi` | `kimi [--session S] [-m M]` |
| `pi` | `pi` | `pi [--session-id S] [--model M]` |
| `opencode` | `opencode` | `opencode` (a resume runs as the headless child) |
| `qwen-code` | none | headless child |

Hermes and OpenClaw are not Orca agents; they run as plain commands in an Orca terminal and keep their own adapters.

## 6. Known limits

- **Session ids.** Orca does not expose the worker's provider session id, so the engine assigns one where the CLI takes it (claude, grok, kimi, pi) and reads it back from the CLI's own files where it does not (codex `$CODEX_HOME/sessions`, agy `~/.gemini/antigravity-cli/history.jsonl`; `session-capture.ts`). opencode records none. `nrv revise` resumes the session in a new worker terminal.
- **Depth.** Orca's nested-worker depth defaults to one generation. A seat that sub-dispatches a squad runs that squad as a headless child (`nested_worker_depth_exceeded` → fallback) unless the user raises the depth in Orca's settings.
- **Experimental toggle.** The orchestration layer is off until a human enables it in Orca's Settings. Off, every dispatch keeps the headless child; the card, the audit block, the doctor line and the browser tab still work.
- **Cost.** Orca reports no cost; a claude worker's tokens are read from its transcript and priced by the estimator, any other worker's cost stays unknown (`costUnavailable`).
- **Windows shell.** The worker command is PowerShell; an Orca terminal configured for cmd.exe would not run it (the agent then never reaches its prompt and the dispatch falls back).
- **Trust records.** Pre-accepting trust is known for Claude Code, Codex and Qwen; Antigravity, Grok, Kimi, Pi and OpenCode rely on the screen check and fall back if they ask.
- **Attribution of plain children.** Orca's hooks attribute a `claude -p` that inherits the pane variables to that pane. The engine strips them; a script that spawns an agent by itself inside an Orca terminal does not get that courtesy.

## 7. Measured

On 2026-09-09, Orca 1.4.198, macOS: the transport sequence ran end to end from a shell outside Orca targeting a registered workspace (`run-create`, `task-create`, `terminal create` with `claude --dangerously-skip-permissions`, `wait tui-idle`, `dispatch --inject`, `check --run --wait`); the worker sent `worker_done` with `taskId`, `dispatchId`, `outcome: succeeded`, `filesModified` and `reportPath`, and the file the brief asked for existed eighteen seconds after injection. `worker-read` returned the provider transcript with `source: "transcript"`. Two headless `claude -p` children were spawned in Orca terminals: the one inheriting `ORCA_PANE_KEY` registered its pane as a `claude` agent; the one without it registered nothing. `run-create` from a shell outside any Orca terminal succeeded and bound the Run to a live agent terminal of the workspace, which is why the engine creates Runs only for its own dispatches and addresses every later call with `--run`.

## 8. Sources

Orca's own version-matched guides: `orca skills get orca-cli`, `orca skills get orchestration`, `orca agent-context --json` (234 commands with usage and notes on 1.4.198).
