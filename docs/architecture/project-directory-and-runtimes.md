# The project directory, and how each runtime enters it

**Status:** current · **Date:** 2026-09-05 · **Language:** English (engine documentation)

A Nirvana project is a directory `nrv init` wrote. Everything a run produces
lives under it, and every agent runtime reaches it the same way: by working
**inside** it. This page states the rule once, then the recipe per runtime,
including the two whose home is not the current directory.

## 1. The rule

`log-paths.js` resolves where audit goes, in this order:

1. `HARNESS_LOGS_DIR` (explicit override, honoured everywhere)
2. `<project>/.nirvana/logs/harness/` when the process runs inside a project
3. `NIRVANA_TEST_LOGS_HOME` (test isolation only)
4. `~/.harness-logs/` when nothing above applies

"Inside a project" is decided by `project-root.js`: walk up from the process
**cwd** until a directory carries `.nirvana/`, stopping at `$HOME` (a stray
`~/.nirvana` is the engine's install, never a project). `NIRVANA_PROJECT_ROOT`
names the root explicitly when cwd cannot.

So the invariant a runtime has to satisfy is small: its shell and file tools run
with cwd inside the project, or the variable is set. Then `nrv` commands the
agent issues log under `.nirvana/logs/harness/`, deliverables land under
`outputs/`, briefs under `.nirvana/briefs/`, and `HANDOFF.json` sits at the
root. `nrv audit where` prints the resolved root and the reason.

## 2. What `nrv init` writes

`AGENTS.md`, `CLAUDE.md`, `GEMINI.md` — one contract in three filenames, so
every runtime finds the one it reads — plus `.nirvana/` (briefs, businesses,
squads, mind-clones, `project.yaml`), `.env`, `.env.example`, `.gitignore`,
`README.md`. Per-project skills are opt-in (`--with-skills`); by default the
project relies on the machine's `~/.nirvana/skills`.

## 3. Per runtime

| Runtime | Enter the project | Contract read from | Extra roots | Audit source |
|---|---|---|---|---|
| Claude Code | `cd <project> && claude` | `CLAUDE.md` in cwd | `--add-dir` | hooks (`PreToolUse`/`PostToolUse`) + `nrv audit emit` |
| Codex | `cd <project> && codex`, or `codex exec -C <project>` | `AGENTS.md` in cwd (native) | `--add-dir` | hooks (`PreToolUse`/`PostToolUse` on `Bash\|apply_patch`, trusted by `nrv install`) + `nrv audit emit` |
| Gemini CLI | `cd <project> && gemini` | `GEMINI.md` in cwd | `--include-directories` | hooks + `nrv audit emit` |
| Antigravity | `cd <project> && agy` | `AGENTS.md` in cwd | `--add-dir` | hooks + `nrv audit emit` |
| Hermes | `nrv-hermes`, or `hermes chat --in <project>` | `AGENTS.md` injected from cwd | n/a (works in cwd) | shell hooks (`pre/post_tool_call`) + fs-watch |
| OpenClaw | the project **is** the agent's workspace (below) | `AGENTS.md` in the workspace | n/a (workspace is the root) | `nrv audit emit` + fs-watch (tool hooks: see §4.3) |

The scripted path (`nrv dispatch --exec`, `nrv team step`) passes the project
dir, the outputs root and the business or squad dir to the child runtime through
the flag in the third column (`RUNTIME_DIR_GRANT_FLAG` in the driver). Runtimes
without a flag (grok, pi, kimi, opencode) get a warning on the result.

## 4. OpenClaw: the project is the agent's home

OpenClaw inverts the model. An agent works in its **workspace**: `AGENTS.md`,
`SOUL.md` and `IDENTITY.md` are read from there at every session start (and
scaffolded if missing), relative paths resolve there, and skills are found under
`<workspace>/skills`, `<workspace>/.agents/skills`, then the personal
`~/.agents/skills` (where the installer links the engine), then managed and
bundled ones. The current directory of the person typing plays no part.

### 4.1 The recommended binding

```
nrv init my-project
openclaw agents add my-project --workspace ~/my-project --non-interactive
```

One dedicated agent per project. Its operating instructions are the `AGENTS.md`
`nrv init` wrote, its tools run with cwd in the project, and every `nrv` call it
makes logs in the project. `nrv init` prints this command when `openclaw` is on
PATH; `nrv doctor` lists the agents bound this way.

Measured on 2026-09-05, gateway mode, a fresh `nrv init` project: the agent
summarised the contract correctly ("invoke the harness skill, dispatch through
Business → Squad → agent-x, pass the gate and the audit trail"), `pwd` returned
the project, and `nrv audit emit x_openclaw_probe` landed in
`<project>/.nirvana/logs/harness/<date>/audit.jsonl` with provenance `engine`;
the global log received nothing. The run used OpenClaw's Codex harness for an
OpenAI model (`agentHarnessId: codex`), which is how OpenClaw executes OpenAI
agents.

What OpenClaw adds to the project root on first run: `SOUL.md`, `IDENTITY.md`,
`USER.md`, `BOOTSTRAP.md` (removed after onboarding) and `memory/` with one file
per day. `memory/` is git-ignored by the skeleton; the persona files are
versionable and yours to edit.

Running it: `openclaw agent --agent my-project -m "…"` through the Gateway, or
`--local` when no Gateway holds the state directory (`--local` needs exclusive
ownership of it, and refuses while the service runs). The JSON envelope carries
`result.payloads[].text`, `result.meta.agentMeta.usage` and `costUsd`.

### 4.2 The other binding, and why it is second

`agents.entries.<id>.cwd` points tool execution at a directory other than the
workspace. Logs would land in the project, but the project's `AGENTS.md` would
not be the agent's instructions (bootstrap files come from the workspace), and
the docs state that sandboxed runs reject an alternate cwd. Use it only when the
agent must keep a shared persona across many projects.

### 4.3 Audit inside OpenClaw

OpenClaw's plugin SDK declares `before_tool_call` / `after_tool_call` hooks and
its docs say embedded and CLI runners dispatch them. Its own issue tracker
records them registering and not firing across several releases (#5513, #5943,
#7297, #60209). The engine therefore does not wire an OpenClaw tool hook yet;
audit inside an OpenClaw agent comes from the contract (`nrv audit emit`, which
the probe above exercised) and from `nrv watch-fs <project>` as filesystem
evidence. Wiring a plugin hook is a future cut, gated on a run where the hook is
observed firing.

## 4b. Codex hooks are installed already trusted

Codex runs a hook only after the user reviews it, and an unreviewed hook is
skipped in silence: `codex exec` prints nothing and the hook never fires
(measured: zero payloads without trust, five with it). The trust record is a
hash of the normalized hook definition under `[hooks.state."<file>:<event>:<group>:<handler>"]`
in `config.toml`, and it is reproducible — `_shared/lib/codex-hooks.ts`
computes it the way `codex-rs` does (canonical JSON of the identity, SHA-256),
verified against a hash Codex itself had recorded. `nrv install` therefore
writes both the hooks and their trust, `--check` reports a hook that lost it,
`--uninstall` removes both, and `nrv doctor` shows `codex: audit hooks`.

The payload Codex sends is the shape the Claude bridge already reads
(`tool_name` `Bash` / `apply_patch`, `tool_input`, `tool_response`, `session_id`,
`cwd`). `apply_patch` names its files in the patch text
(`*** Add|Update|Delete File: <path>`); the bridge emits one `artifact_touched`
per file. Hook events are stamped like every other engine write, so they read as
`engine` in Glance and `nrv audit where`.

## 5. Hermes

Hermes works in cwd and injects `AGENTS.md` from it (what `--ignore-rules`
switches off). `nrv-hermes`, installed with the engine, finds the project root by
walking up, exports `NIRVANA_PROJECT_SKILLS` for the `${NIRVANA_PROJECT_SKILLS}`
entry the installer added to `~/.hermes/config.yaml:skills.external_dirs`, and
runs `nrv watch-fs` beside the session. The `pre_tool_call` / `post_tool_call`
shell hooks the installer wires carry `cwd` in their payload, so their events
resolve to the project's log. Hermes reads no project-local `.hermes/`; only
`~/.hermes/`. `hermes project create` + `add-folder` groups sessions in the
desktop app and gives kanban tasks a worktree; it does not move the logs.
Unseen hooks ask for consent once (`--accept-hooks`, `HERMES_ACCEPT_HOOKS=1` or
`hooks_auto_accept: true` for headless use).

## 6. Sources

OpenClaw: [agent workspace](https://docs.openclaw.ai/concepts/agent-workspace) ·
[config — agents](https://docs.openclaw.ai/gateway/config-agents) ·
[`openclaw agent`](https://docs.openclaw.ai/cli/agent) ·
[plugin hooks](https://docs.openclaw.ai/plugins/hooks). Hermes:
[event hooks](https://hermes-agent.nousresearch.com/docs/user-guide/features/hooks).
Codex: [non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode).
