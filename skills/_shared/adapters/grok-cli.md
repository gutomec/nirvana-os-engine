# Adapter · Grok Build CLI (xAI Grok)

> Runtime adapter for Squad Protocol v6 + Business Protocol v2 + Harness Protocol v1.
> Covers the 3 protocols in a single doc. Canonical sections per Squad Protocol v6 §18.5.
> System identity + capabilities (what Nirvana-OS is and can do): see `../NIRVANA-OS.md` (single source).
> Sub-process dispatch, same family as `codex.md` / `kimi-cli.md`. Every flag below was read from `grok --help` or `~/.grok/docs/user-guide/` of `grok 1.0.44`; anything the engine does not pass is marked as such.

---

## 1. Adapter metadata

| Field | Value |
|---|---|
| `runtime` | `grok-cli` |
| `vendor` | xAI |
| `min_version` | Not pinned. The driver's argv needs `--prompt-file`, `--output-format json` and `--always-approve`; `--trust` is optional (a build that rejects it is retried without it, §7). Older builds fall back to `-p` and to `plain` output. |
| `tested_against` | `grok 1.0.44 (5b807183dd79)`, released 2026-09-28, audited 2026-10-11. Latest published: 1.0.50 (2026-10-06), not installed on the audit machine. |
| `default_model` | Inherited from the runtime. The engine NEVER sets a model; it comes from the `grok-cli:<model>` entry of `LLM_CASCADE` (or `opts.model`). Pass a model only when the user explicitly asks. `grok models` lists what the account can use. |
| `config_paths` | `~/.grok/config.toml`, `~/.grok/trusted_folders.toml` (folder trust), `~/.grok/sandbox.toml`, `~/.grok/sessions/`, `<project>/.grok/`, `<project>/AGENTS.md`. `GROK_HOME` moves the whole `~/.grok` tree. |
| `skills_root` | `./.grok/skills`, `<repo>/.grok/skills`, `~/.grok/skills`, plus `.agents/skills` at each tier and `~/.claude/skills` / `./.claude/skills` (Claude compatibility, on by default). Project skills load only in a trusted folder. |
| `agents_root` | Native: `--agent <NAME or file>`, `--agents <JSON>` and personas in config (`16-subagents.md`). The engine uses none of them; the persona travels in the prompt file. |
| `memory_root` | `<project>/AGENTS.md` (trusted folder only); experimental cross-session memory, off by default (`13-memory.md`). |
| `audit_log` | Grok: `~/.grok/sessions/<encoded-cwd>/<session-id>/`, readable with `grok export` and `grok usage <SESSION_ID>`. Engine: jsonl under `~/.harness-logs/` via `runGrok`. |
| `protocol_versions` | Squad 5.0, Business 1.0, Harness 1.0 (with gaps recorded in §13) |

---

## 2. Feature support matrix

`✓` = native · `~` = workaround/partial · `✗` = not supported. "Engine" means what `runGrok` passes today.

| Feature (Business v2 §6.5) | Squad v6 | Business v2 | Harness v1 | Notes |
|---|---|---|---|---|
| `max_turns` | ~ | ~ | ~ | The CLI has `--max-turns <N>` (headless only). The engine does **not** pass it; `RunHeadlessOpts` has no `maxTurns`. The only bound is the caller's optional `timeoutMs`. |
| `tool_whitelist` | ~ | ~ | ~ | The CLI has `--tools` (allowlist) and `--disallowed-tools` (denylist), both headless only, plus repeatable `--allow` / `--deny` rules (`--allowedTools` / `--disallowedTools` are compat aliases). The engine passes none of them; `allowedTools` and `noTools` are ignored for grok. |
| `subagent_spawning` | ✓ | ✓ | ✓ | Native `spawn_subagent`, max depth 1. Off switches: `--no-subagents`, `GROK_SUBAGENTS=0`, `--disallowed-tools Agent`. The engine passes none, so a grok worker can open its own subagents. |
| `audit_trail` | ✓ | ✓ | ✓ | Session transcripts on disk (`grok export`), hooks on every tool call (§10), plus the engine's jsonl. |
| `scheduled_invocation` | ~ | ~ | ~ | In-session scheduler (`/loop`, `scheduler_create`, `20-background-tasks.md`). A headless run exits when its turn ends, so the harness still uses external cron. |
| `event_bus` | ~ | ~ | ~ | Mentions/tickets via file system; no broker. |
| `hooks` | ✓ | ✓ | ✓ | `PreToolUse`, `PostToolUse`, `SessionStart`, `Stop`, `SubagentStop` and more (§10). |
| `sandboxing` | ✓ | ✓ | ✓ | `--sandbox <PROFILE>` / `GROK_SANDBOX` (`workspace`, `read-only`, `strict`, `devbox`, custom). macOS uses Seatbelt since 1.0.44. The engine passes no profile, even on `--safe`. |
| `session_memory` | ✓ | ✓ | ✓ | Per-session context; resumable with `-r` (§7). |
| `project_memory` | ✓ | ✓ | ✓ | `AGENTS.md` / `CLAUDE.md` read natively, gated by folder trust. |
| `global_memory` | ~ | ~ | ~ | Experimental cross-session memory, off by default (`GROK_MEMORY=0` forces it off); `~/.claude/` rules are read through Claude compatibility. |
| `handoff_artifacts` | ✓ | ✓ | ✓ | `--output-format json` returns one object (§7). `--json-schema <SCHEMA>` constrains the shape; the engine does not pass it. |
| `fork_context` | ✓ | ✓ | ✓ | `--fork-session` with `-r` / `-c` forks into a new session id. Not used by the engine. |
| `teammate_primitive` | ✗ | ✗ | ✗ | No `TeamCreate`; the parent can message its subagents, but a team is a file-system convention. |
| `telemetry_otel` | ✓ | ✓ | ✓ | `GROK_EXTERNAL_OTEL=1` plus the standard `OTEL_*` exporter variables (`24-monitoring-usage.md`). |
| `mcp` | ✓ | ✓ | ✓ | `grok mcp`; project MCP servers load only in a trusted folder. |

> **Note outside the canonical matrix:** Grok's differentiators for Nirvana are the **media tools built into the Build CLI** (`image_gen` / `image_edit` / `image_to_video`) and the **subscription route with $0 marginal cost** (§8). Grok also has no spend cap of its own: `--max-budget` style limits do not exist in the CLI.

---

## 3. Concept mapping

| Concept (Protocol) | Grok Build CLI equivalent | Implementation |
|---|---|---|
| Squad / Business | Skills directory + AGENTS.md | `<project>/.agents/skills/<name>/` + the CWD's `AGENTS.md`, both loaded only in a trusted folder (`--trust`) |
| Capability | Workflow file | `<skill>/capabilities/<id>.md`, read by the agent from the prompt's instructions |
| Employee (seat) | Persona in the prompt file | A business runs as ONE solo agent (`skills/harness/lib/business-solo.ts`) that plays the seats itself; persona + DNA go in the prompt file. Native `--agent` profiles exist but are not used. |
| `is_brief_intake: true` | Default persona when the skill is active | Built in the prompt / the skill's `AGENTS.md` |
| `is_antagonist: true` | Separate sub-process | A second `grok --prompt-file ...` call with the antagonist persona |
| Handoff artifact | JSON on stdout | `text` field of the json envelope, persisted in `<project>/.handoffs/` |
| Mention `@employee` | Convention in the handoff | The adapter detects it → new sub-process |
| Ticket | Persisted file | `<project>/.tickets/<TICKET_ID>.json` |
| Escalation trigger | Wrapper script + harness call | The wrapper checks the condition → emits a notification to the harness |
| Permanent memory | `<project>/AGENTS.md` + custom files | Experimental native memory exists but is off by default |
| Project memory | `<project>/AGENTS.md` | Native, trusted folder only |
| Session memory | Session under `~/.grok/sessions/` | Resumed with `-r <sessionId>` on revise |
| Routing decision (harness) | Pre-spawn lookup table | BM25 over `capabilities[].examples[]` in a Bun wrapper |

---

## 4. Frontmatter mapping

### Squad v6 / Business v2 → AGENTS.md

Grok reads `AGENTS.md`, `CLAUDE.md`, `Claude.md` and `CLAUDE.local.md` natively (`12-project-rules.md`), but only after the folder is trusted. The adapter keeps the same two-file tactic as Codex/Kimi:

```yaml
# AGENTS.md (head of the project/skill)
You are an AI agent operating under the Squad/Business Protocol.

Available capabilities: [media.video.analyze, media.transcript.extract, ...]
Default tools: [Read, Write, Bash]
```

```yaml
# .agents/manifest.yaml (auxiliary: read by a wrapper, not by Grok)
name: nexus-council
protocol: 1.0
employees: [ceo, marketing-lead, ...]
operation_mode: zero_human
```

### Employee → prompt file

The engine writes one temp file and passes it with `--prompt-file`. `withPreamble` puts the autonomous-mode directive (`appendSystemPrompt`) at the top of that file, separated by `---`; it is user-turn text, not system text. Grok's `--rules <TEXT>` (append to the system prompt) and `--system-prompt-override` (replace it) exist, and the engine uses neither.

```
<autonomous-mode directive (appendSystemPrompt)>
---
<employee core persona (frontmatter → top)>
<mind-clone DNA: injectMindClones().combined_prompt>
## Brief
<enriched brief>
## Allowed tools
<tool whitelist>
## Output contract
Reply ONLY with a single JSON object: {...}
```

> For `type: mind_clone`, the adapter **prepends** `(DISCLOSURE: AI-generated persona, not a real person.)` to the persona, same as Codex.

---

## 5. Tool whitelist mechanics

The CLI enforces tool limits; the engine does not use them yet.

- `--tools <a,b,c>`: allowlist of built-in tools (headless only). MCP meta-tools stay available unless denied.
- `--disallowed-tools <a,b,c>`: denylist (headless only). Accepts `Agent`, `Agent(explore)`, `Agent(explore, plan)` to block subagents. When both flags are given, the denylist wins.
- `--allow <RULE>` / `--deny <RULE>`, repeatable, TUI and headless: `Bash(...)`, `Edit(...)`, `Write(...)`, `Read(...)`, `Grep(...)`, `WebFetch(...)`, `MCPTool(...)` with glob patterns. Deny beats allow. They gate execution; they do not remove the tool.
- `--permission-mode default|acceptEdits|auto|dontAsk|bypassPermissions|plan`. `bypassPermissions` equals `--always-approve`. Deny rules, hooks and admin locks still apply under always-approve.
- `--disable-web-search` removes web search and fetch.

Tool names are internal ids, not the portable names: `read_file`, `grep`, `list_dir`, `search_replace`, `web_search`, `web_fetch`, and the shell tool (`run_terminal_cmd` in `14-headless-mode.md`, `run_terminal_command` in `10-hooks.md`; the docs disagree, so read the real list from `grok inspect --json` or from the `system/init` line of `streaming-messages-json`). Portable mapping (Squad v6 §10.7): `read` → `read_file`, `edit`/`write` → `search_replace` and the write tool, `grep` → `grep`, `bash` → the shell tool, `web_fetch` → `web_fetch`, `web_search` → `web_search`. MCP tools keep the `mcp__<server>__` prefix.

What the engine does today: on the autonomous path it passes `--always-approve` and no allowlist. On `--safe` (`yolo: false`) it passes neither `--always-approve` nor `--trust`, and no `--tools`, `--permission-mode` or `--sandbox` either, so the restriction is "the CLI's default approval mode in a headless run". The persona's "## Allowed tools" block is a soft limit only.

Built-in media: `image_gen` / `image_edit` (toggle `features.image_gen`) and `image_to_video` are native tools, reachable when the persona asks for them.

---

## 6. Max-turns mechanics

The CLI exposes `--max-turns <N>`, headless only. When the cap hits, the turn ends with a `StopCancelled` hook, a `max_turns_reached` event in `streaming-json`, or the `error_max_turns` subtype in `streaming-messages-json`. The json envelope's `num_turns` counts main-agent model rounds (subagent calls are not counted).

**The engine does not pass `--max-turns`.** `runGrok` has no turn input (`RunHeadlessOpts` carries no `maxTurns`), so an employee's `maxTurns` does not reach grok. The only bound is `opts.timeoutMs` → `spawnSync` timeout, which is unset by default (uncapped). A timed-out child is killed by signal and the driver records exit code 124.

Grok has no spend cap: the headless guide says `error_max_budget_usd` "is never emitted, because grok has no budget feature". An engine `maxBudgetUsd` is not passed to grok and cannot be.

---

## 7. Subagent spawning

### Dispatch argv (what `runGrok` actually runs)

```bash
grok --prompt-file <tmp-file> --output-format json --cwd <cwd> \
  [-r <sessionId>]        # only when resuming (opts.sessionId set, e.g. nrv revise)
  [--always-approve]      # autonomous path; dropped under --safe
  [--trust]               # autonomous path; dropped under --safe
  [-m <model>]            # only when opts.model or the cascade resolves one
```

- `--prompt-file <PATH>`: single-turn prompt from a file, lossless at any size. The temp file is deleted after the run.
- `--output-format json`: one object on stdout after the run.
- `--cwd <dir>`: working directory (the child's process cwd is the same dir).
- `-r <id>`: resume the session `opts.sessionId`.
- `--session-id <uuid>`: a fresh run is started under an id the engine chose, so a run that dies before printing its envelope still has one. A build that rejects the flag is retried without it.
- `--always-approve`: auto-approve every tool call. Without it a headless run waits for approvals it cannot get. `--yolo` is a documented alias in the headless guide but absent from `--help`; the engine uses the documented flag.
- `--trust`: hidden flag (not in `--help`; `grok --trust --version` parses on 1.0.44). It grants folder trust, so project `AGENTS.md`, project skills under `.agents/skills`, project hooks, project MCP/LSP and project permission rules load. Without it, "headless startup with these sources requires `--trust` or a prior grant", and a fresh run folder has no prior grant.
- `-m <model>`: from `opts.model` or `resolveSystemModel("grok-cli")`; never hardcoded.

Retries, in order, each only on proof that argv parsing refused the flag before any model call (`argvRejectedFlag`): exit 2 (clap's usage-error code), stderr naming that flag in an `unexpected argument` / unknown-option / invalid-value message, and no JSON object on stdout. Any other failure, whatever words it uses, is a turn that ran and is reported as failed, never spawned again.
1. `--trust` refused → rerun once without `--trust`.
2. `--prompt-file` refused → rerun with `-p <prompt>` on argv (ARG_MAX-unsafe for large prompts; only for very old builds).
3. `--output-format` refused → rerun without `--output-format` (plain text on stdout).

Not passed today: `--effort`, `--no-subagents`, `--max-turns`, `--rules`, `--tools`, `--disallowed-tools`, `--permission-mode`, `--sandbox`, `--json-schema`. Grok is not in `EFFORT_CAPABLE`, so a requested effort is warned about once and dropped. There is no directory-grant flag (`--add-dir` equivalent): extra `addDirs` produce a warning.

### Light layer (`RUNTIMES` entry `grok-cli`)

```bash
grok --prompt-file <tmp-file> [--always-approve --trust]
```

Persona and user message are merged into one file. `--always-approve --trust` are added only when `headlessSkipPermissions()` is on (setting `execution.headless_skip_permissions`). No `--output-format`, so stdout is plain; the parser still tries JSON keys `text`, `response`, `result`, `output`.

### Result envelope

Success (`--output-format json`):

```json
{"text":"...","stopReason":"end_turn","sessionId":"...","requestId":"...",
 "num_turns":7,"usage":{...},"modelUsage":{"<model>":{...,"costUSD":0.0127}},
 "total_cost_usd":0.0127,"total_cost_usd_ticks":126890500}
```

`total_cost_usd` appears only when the server reported a complete cost. When some calls lacked cost, `cost_is_partial: true` and every cost float is omitted; `usage_is_incomplete: true` does the same. A prompt that never reached the model has no spend fields.

Failure: `{"type":"error","message":"..."}` with a non-zero exit (130 on SIGINT, 143 on SIGTERM, 1 otherwise).

How `runGrok` reads it: result text from `response`, `result`, `output` or `text`; session id from `session_id`, `sessionId`, `conversation_id` or `session.id` (falling back to the id it was given or a fresh UUID); cost from `total_cost_usd`, else `costUnavailable`. Failure is `exit != 0`, an `is_error` / `error` field, or the `{"type":"error","message"}` envelope, whose `message` becomes the run's error (stderr is the fallback only when no envelope says why). `cost_is_partial`, `usage_is_incomplete`, `num_turns` and `total_cost_usd_ticks` are not read.

### Sessions

- `-s, --session-id <UUID>`: names a **new** session only (must be a valid, unused UUID). It does not resume.
- `-r, --resume [<ID_OR_TITLE>]`: resume by id, or by title in the current directory; most recent if omitted. Scripts should pass ids.
- `-c, --continue`: most recent session for the cwd.
- `--fork-session`: with `-r` / `-c`, continue under a new session id (which `-s` may name).
- `--restore-code`: also restore the repository snapshot on resume.
- `grok sessions list|search|delete`, `grok export`, `grok usage <SESSION_ID> [TURN]`.

### Native subagents

The main agent calls `spawn_subagent`; built-in types are `general-purpose`, `explore` and `plan`, and project or user agents can add or shadow types. Depth is fixed at one: a subagent cannot spawn another. `--agents <JSON>` defines subagents inline (headless only), `--agent <NAME>` picks the agent profile. Because the engine passes no `--no-subagents`, a grok worker can delegate inside its own run; Claude workers get the opposite default (`--disallowedTools Task Agent` unless `allowSubagents`).

**For a mention `@x`:** the adapter detects it in the returned handoff and opens a new sub-process for `x`. **Parallel fan-out** between employees stays at the OS level: independent `grok --prompt-file` sub-processes.

---

## 8. Memory storage

| Layer | Path | Persistence |
|---|---|---|
| Permanent (cross-session) | `<project>/AGENTS.md` + custom files; optional native memory (`topics/` per scope, off by default) | Manual / experimental |
| Project | `<project>/AGENTS.md` | Native, trusted folder only |
| Session | `~/.grok/sessions/<encoded-cwd>/<session-id>/` | Persisted by grok; resumed with `-r` |
| Business permanent | `~/businesses/<biz>/memory/permanent.md` | Adapter persists |
| Project (business) | `<project>/<biz>/<project_id>/memory/` | Isolation by construction |

> **Isolation guard:** Grok does not enforce Nirvana's memory isolation. The adapter builds the prompt with ONLY the memory relevant to the `project_id` before spawning, otherwise `audit_event: isolation_violation`. If native memory is ever turned on, its workspace scope is shared by clones and worktrees of the same repo.

**Authentication: two tracks.** The model comes ONLY from the `grok-cli:<model>` cascade entry. The credential comes from one of two routes:

- **Subscription via `grok login`**: an xAI account. **$0 marginal cost**; the envelope usually omits `total_cost_usd` on this route ("pool/OAuth paths often omit it"), so the driver reports `costUsd: null` + `costUnavailable`. This is the route the **`grok-studio-nirvana`** squad uses.
- **xAI API via `XAI_API_KEY` (paid)**: pay-per-token; cost is stamped for API-key traffic and lands in `total_cost_usd`.

---

## 9. Context window and compaction

- Window: depends on the model chosen via `LLM_CASCADE`. Since 1.0.44 a model can advertise several window sizes (`/context-window <size>` in the TUI); the first listed size is the default. The engine does not pin a number.
- Compaction: automatic at 85% of the window (`[session] auto_compact_threshold_percent`), manual with `/compact`. Hooks `PreCompact` / `PostCompact` fire around it; `streaming-json` may emit `auto_compact_*` events.
- When the brief asks for a visual artifact, `image_gen` / `image_edit` / `image_to_video` run in the same session.

---

## 10. Hook system

Grok has a full hook system (`10-hooks.md`). Sources, all merged:

| Scope | Path | Trusted? |
|---|---|---|
| Global | `~/.grok/hooks/*.json`, `~/.grok/config.toml` | Always |
| Global | `~/.claude/settings.json` (+ `settings.local.json`) | Always (Claude compatibility, on by default) |
| Global | `~/.cursor/hooks.json` | Always (Cursor compatibility) |
| Project | `<project>/.grok/hooks/*.json`, `<project>/.claude/settings.json`, `<project>/.cursor/hooks.json` | Folder trust required |
| Org | `managed_config.toml`, `requirements.toml` | Always |
| Plugin | Bundled in installed plugins | Per plugin |

Events: `SessionStart`, `SessionEnd`, `UserPromptSubmit` (can block), `PreToolUse` (can deny), `PostToolUse` (can replace the output the model sees), `PostToolUseFailure`, `PermissionDenied`, `Stop` (can block), `StopFailure`, `StopCancelled`, `Notification`, `SubagentStart`, `SubagentStop` (can block), `PreCompact`, `PostCompact`. Since 1.0.49 (release notes, not on the audit machine) hook permission prompts appear in every approval mode.

Consequence for Nirvana: because `~/.claude/settings.json` is always loaded, the audit hooks that `nrv setup` installs there (`audit-emit-from-hook.ts pre|post`, no agent argument) also fire inside grok children. The script then labels them `claude-code-hook`, and grok's tool names (`search_replace`, the shell tool) differ from Claude's. Turning this off is `[compat.claude] hooks = false` in `~/.grok/config.toml`; a grok-native hook file under `~/.grok/hooks/` would carry the right label. Neither exists today.

| Desired hook | Grok |
|---|---|
| `PreToolUse` | Native `PreToolUse` (can deny) |
| `PostToolUse` | Native `PostToolUse` |
| `UserPromptSubmit` | Native `UserPromptSubmit` (can block) |
| `Stop` | Native `Stop` / `StopFailure` / `StopCancelled` |
| `SessionStart` | Native `SessionStart` |
| `Compact` | Native `PreCompact` / `PostCompact` |

---

## 11. Invocation examples

### Example 1: Squad capability (autonomous path)

```bash
# User: "gerar key visual do lançamento e um teaser vertical"
# What runGrok runs (prompt written to a temp file first):
grok --prompt-file <tmp-prompt-file> --output-format json --cwd <run-dir> \
  --always-approve --trust -m <model>
# stdout: {"text":"...","sessionId":"0199...","total_cost_usd":...}
```

### Example 2: Business brief, then a revise

```bash
# First dispatch: the business runs as ONE solo agent that plays the seats
grok --prompt-file <brief-file> --output-format json --cwd <run-dir> --always-approve --trust \
  > .handoffs/nexus-1.json

# nrv revise <project> "<change>": same session, resumed by id
grok --prompt-file <revision-file> --output-format json --cwd <run-dir> \
  -r <sessionId-from-nexus-1> --always-approve --trust

# A stand-alone sub-process is only spawned for an explicit mention `@alex-hormozi`
grok --prompt-file <alex-persona-file> --output-format json --cwd <run-dir> --always-approve --trust \
  > .handoffs/alex-1.json
```

### Example 3: `--safe` dispatch

```bash
# nrv dispatch --safe: no auto-approve, no folder-trust grant
grok --prompt-file <brief-file> --output-format json --cwd <run-dir>
```

### Example 4: Harness escalation

```bash
# Wrapper detects budget_violation (timeout)
echo '{"type":"human_escalation_required","trigger_id":"budget","severity":"high",...}' \
  > .harness/notifications/$(date +%s).json
# The harness orchestrator (in another runtime or interactive) consumes the file
```

Flags that exist in the CLI and that a hand-built command may add (the engine does not): `--max-turns <N>`, `--effort <none|minimal|low|medium|high|xhigh|max>` (alias of `--reasoning-effort`), `--no-subagents`, `--rules "<text>"`, `--tools <list>`, `--disallowed-tools <list>`, `--sandbox <profile>`, `--json-schema '<schema>'`, `--output-format streaming-json|streaming-messages-json` (+ `--include-partial-messages`).

---

## 12. Runtime-specific validators

- **Binary**: `grok --version` answers. Check which file `grok` resolves to: the installer also creates `~/.grok/bin/agent` pointing at grok, which shadows the Cursor CLI's `agent` binary when `~/.grok/bin` comes first on `PATH`.
- **Credential present**: `grok login` done, or `XAI_API_KEY` in the environment. With neither, dispatch fails.
- **Resolvable model**: the cascade's `grok-cli:<model>` appears in `grok models`.
- **Folder trust**: without `--trust` (the `--safe` path), project `AGENTS.md`, skills, hooks and MCP load only if the folder is already in `~/.grok/trusted_folders.toml`, or if `GROK_FOLDER_TRUST=0` turns the gate off. A nested git checkout is a separate workspace. `grok inspect --json` in the run folder shows what grok actually discovers.
- **MCP server reachability**: if the persona references `mcp__<server>__*`, check `grok mcp` for that server.

---

## 13. Known limitations

1. **No turn cap from the engine.** `--max-turns` exists, but `runGrok` has no input for it; only an optional wall-clock timeout bounds a run.
2. **No spend cap anywhere.** Grok has no budget feature, and the subscription route usually reports no cost (`costUnavailable`).
3. **Tool limits are not wired.** `--tools`, `--disallowed-tools`, `--allow`, `--deny`, `--permission-mode` and `--sandbox` exist; the engine passes none, and `--safe` only drops `--always-approve` and `--trust`.
4. **Workers can open subagents.** `--no-subagents` exists and is not passed, so the engine's depth rule does not hold for grok.
5. **Effort is dropped.** `--effort` exists and works headless; grok is not in `EFFORT_CAPABLE`.
6. **Directive is user text.** The autonomous directive is prepended to the prompt file instead of going through `--rules`.
7. **Error envelope parsed.** `{"type":"error","message"}` fails the run (even on exit 0) and its message is the error shown.
8. **Audit attribution.** Grok runs the `~/.claude/settings.json` hooks, so its tool events arrive labelled as Claude (§10).
9. **`--trust` is undocumented in `--help`.** It parses on 1.0.44 and is in the user guide; a build that drops it falls back to running without trust (retry in §7), which silently loses `AGENTS.md` and project skills in a fresh run folder.
10. **No `TeamCreate`** → teams are a file-system convention.
11. **`agent` binary collision** (`~/.grok/bin/agent`), see §12.
12. **Headless stdin.** 1.0.44 does not read piped stdin into the prompt (`--prompt-file` is the channel); release notes say 1.0.50 runs a bare `grok` with piped stdin headless. The engine does not rely on either.

**Compensating advantage:** built-in media generation, a $0-marginal subscription route, native hooks/subagents/sandbox/OTel, a resumable session store, and a json envelope with token and cost detail.

---

## 14. Source references

- `grok --help`, `grok agent --help`, `grok sessions --help`, `grok inspect --help`, `grok usage --help`, `grok --trust --version` (local, `grok 1.0.44`, 2026-10-11).
- `~/.grok/docs/user-guide/`: `08-skills.md`, `10-hooks.md`, `12-project-rules.md`, `13-memory.md`, `14-headless-mode.md`, `16-subagents.md`, `17-sessions.md`, `18-sandbox.md`, `20-background-tasks.md`, `22-permissions-and-safety.md`, `24-monitoring-usage.md`.
- `~/.grok/CHANGELOG.md` (1.0.44 Seatbelt sandbox, context window sizes).
- Release mirror for 1.0.45 to 1.0.50: https://releases.sh/xai/grok-build-releases.md (official https://x.ai/build/changelog returned 403 to the fetcher).
- Driver: `skills/_shared/lib/host-agent-driver.ts` (`runGrok`; `RUNTIMES` entry `grok-cli`), re-exported by `skills/harness/lib/host-agent-driver.ts`.
- Reference squad (subscription route): `grok-studio-nirvana`.
- Squad Protocol v6: `~/.nirvana/skills/squads/SQUAD_PROTOCOL_V6.md`
- Business Protocol v2: `~/.nirvana/skills/businesses/BUSINESS_PROTOCOL_V2.md`
- Harness protocol: `~/.nirvana/skills/harness/SKILL.md`

---

## 15. Version history

| Version | Date | Changes |
|---|---|---|
| 1.0.0 | 2026-07-20 | Initial doc: covers Squad 5.0 + Business 1.0 + Harness 1.0 against Grok Build CLI (`grok 0.2.103`), Grok family (`grok-code` / `grok-4` / `grok-4-fast`). Dispatch via `grok -p --output-format json --always-approve --cwd`. |
| 1.1.0 | 2026-10-11 | Rewritten against `grok 1.0.44` (latest 1.0.50). Real driver argv (`--prompt-file`, `-r` on resume, `--trust` on the autonomous path with a no-trust retry). Documents native subagents, hooks (incl. `~/.claude/settings.json`), `--tools` / `--allow` / `--deny`, folder trust, sandbox, effort, sessions, the json and error envelopes, the absence of a budget cap and the `agent` binary collision. Removes the false claims that the driver passes `--max-turns` and that grok lacks resume, subagents and hooks. |
