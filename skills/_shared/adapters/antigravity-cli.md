# Adapter · Antigravity CLI (`agy`)

> Runtime adapter for Squad Protocol v6 + Business Protocol v2 + Harness Protocol v1.
> Covers the 3 protocols in a single doc. Canonical sections per Squad Protocol v6 §18.5.
> System identity + capabilities (what Nirvana-OS is and can do): see `../NIRVANA-OS.md` (single source).

> **Google's agent CLI.** `agy` replaced the Gemini CLI for individual tiers on 2026-06-18 (Google Developers Blog, "An important update: transitioning Gemini CLI to Antigravity CLI"). The Gemini CLI is no longer a Nirvana runtime; agy is how Nirvana reaches Gemini models directly. The CLI is versioned 1.x and ships every one or two days, so every flag below was read from `agy --help`, `agy changelog` and the docs bundled with the binary on **1.3.3** (2026-10-10). Re-check `agy --help` before relying on a flag on another build.

---

## 1. Adapter metadata

| Field | Value |
|---|---|
| `runtime` | `antigravity-cli` |
| `vendor` | Google |
| `cli` | `agy` (installed by the official installer to `~/.local/bin/agy` on macOS; `agy update` updates it in place) |
| `min_version` | 1.2.10 recommended: from there a turn that fails mid-stream exits 3 instead of 0. `--output-format`, `--input-format stream-json` and `--conversation` exist on every build the engine supports (all three are on 1.3.3) |
| `default_model` | Inherited from the runtime. The engine never sets a model; the user's agy config decides. A model is passed only when the user asks for one (`--model`). `agy models` lists the ids |
| `tested_against` | agy 1.3.3 (flag surface, changelog, bundled docs). No model call was made for this doc |
| `config_root` | `~/.gemini/config/` (global customization root: `config.json`, `hooks.json`, `mcp_config.json`, `skills.json`, `rules.json`, `plugins.json`, `agents.json`, `skills/`, `rules/`). Workspace root: `<project>/.agents/`. CLI settings: `~/.gemini/antigravity-cli/settings.json` |
| `nirvana_hook` | `~/.gemini/config/hooks.json`, named hook `nirvana-os`: a `PreInvocation` handler running `bun ".../gemini-session-start.ts" --agy`, timeout 10 s (written by `install.ts`) |
| `skills_root` | `~/.gemini/config/skills/<name>/`, `~/.gemini/antigravity-cli/skills/<name>/`, `<workspace>/.agents/skills/<name>/` |
| `agents_root` | `<workspace>/.agents/agents/<name>.md` (Markdown custom agents); `agents.json` in a customization root or at a plugin root (1.3.3) |
| `memory_root` | `GEMINI.md` / `AGENTS.md` walked up from cwd to the repo root; global rules in `~/.gemini/config/` |
| `audit_log` | Hook payloads carry `transcriptPath` and `artifactDirectoryPath` (under an `antigravity-cli/` directory for the CLI). Nirvana keeps its own audit (`outputs/<trace>/audit.jsonl`) |
| `protocol_versions` | Squad 5.0, Business 1.0, Harness 1.0 (with gaps recorded in §13) |

---

## 2. Feature support matrix

`✓` = native · `~` = workaround/partial · `✗` = not supported

| Feature (Business v2 §6.5) | Squad v6 | Business v2 | Harness v1 | Notes |
|---|---|---|---|---|
| `max_turns` | ✗ | ✗ | ✗ | No turn or step flag. `--print-timeout <dur>` bounds wall-clock time; a `Stop` hook sees `terminationReason: max_steps_exceeded` when agy's own step limit hits |
| `tool_whitelist` | ~ | ~ | ~ | No per-call tools flag. A Markdown custom agent declares `tools` and is picked with `--agent`; `--mode plan` and `--sandbox` restrict behavior. The engine uses `--mode plan` for answer-only calls (§5) |
| `subagent_spawning` | ✓ | ✓ | ✓ | Native subagents: `.agents/agents/*.md`, `@<subagent> <message>`, `invoke_subagent` in a custom agent's tools. The engine dispatches each turn as its own `agy -p` process |
| `audit_trail` | ~ | ~ | ~ | Transcript path in every hook payload; `--log-file` for the CLI log. The engine audits from the JSON envelope |
| `scheduled_invocation` | ✗ | ✗ | ✗ | Timers the agent schedules live inside a session only. Cross-run scheduling is external cron |
| `event_bus` | ~ | ~ | ~ | Mentions and tickets through the file system; no broker |
| `hooks` | ✓ | ✓ | ✓ | `PreToolUse`, `PostToolUse`, `PreInvocation`, `PostInvocation`, `Stop` (§10) |
| `sandboxing` | ✓ | ✓ | ✓ | `--sandbox` (OS terminal sandbox, macOS and Windows), `--mode accept-edits\|plan`, approval prompts unless `--dangerously-skip-permissions` |
| `session_memory` | ✓ | ✓ | ✓ | Conversations persist and resume with `--conversation <id>` or `--continue` |
| `project_memory` | ✓ | ✓ | ✓ | `GEMINI.md` / `AGENTS.md` loaded from cwd up to the repo root |
| `global_memory` | ✓ | ✓ | ✓ | Global rules in `~/.gemini/config/` (`AGENTS.md`, `GEMINI.md`, `rules/`) |
| `handoff_artifacts` | ✓ | ✓ | ✓ | Files on disk plus the JSON envelope; `--json-schema` yields validated `structured_output` (not wired by the engine) |
| `fork_context` | ~ | ~ | ~ | Each subagent runs its own conversation; subagents with a `branch` workspace get an isolated copy (1.3.3) |
| `teammate_primitive` | ~ | ~ | ~ | Subagents plus `agy remote-control`; a formal team only by convention |
| `telemetry_otel` | ✗ | ✗ | ✗ | No OTel export documented. Token usage comes back in the JSON envelope |

---

## 3. Concept mapping

| Concept (Protocol) | Antigravity equivalent | Implementation |
|---|---|---|
| Squad / Business | Workspace skills + rules | The engine dispatches the brief as one `agy -p` run; agy also loads any `GEMINI.md` / `AGENTS.md` above cwd |
| Capability | Skill | `<root>/skills/<name>/SKILL.md` with `name` and `description` frontmatter, or the capability text inside the brief |
| Employee (seat) | Seat file played by the one business agent; optional agy custom agent | A business runs as ONE solo agent (`skills/harness/lib/business-solo.ts`) that opens a seat's file when it works as that seat. A stand-alone agy subagent would live in `.agents/agents/<name>.md` and be chosen with `--agent <name>`; the engine does not generate these |
| `is_brief_intake: true` | First turn of the run | The brief is the `-p` prompt |
| `is_antagonist: true` | A separate `agy -p` run, or a native subagent | The engine prefers a separate run with its own trace |
| Handoff artifact | File + JSON envelope | Persisted in `<project>/.handoffs/` or the trace's outputs |
| Mention `@employee` | `@<subagent> <message>` (native, 1.2.9) for agy subagents | Nirvana mentions are resolved by the engine, not by agy |
| Ticket | Persisted file | `<project>/.tickets/<TICKET_ID>.json` |
| Escalation trigger | Engine check + harness notification | `.harness/notifications/<ts>.json` |
| Permanent memory | Global rules in `~/.gemini/config/` + engine files | Business memory stays in `~/businesses/<biz>/memory/` |
| Project memory | `<project>/AGENTS.md` / `GEMINI.md` | Auto-load |
| Session memory | agy conversation | Resumed with `--conversation <id>` |
| Routing decision (harness) | None in agy | The orchestrator routes before spawning |

---

## 4. Frontmatter mapping

### Squad v6 / Business v2 → agy skill

agy reads Agent Skills: a directory with a `SKILL.md` whose YAML frontmatter has `name` (lowercase, hyphenated) and `description` (when to use it). Optional `scripts/`, `examples/`, `resources/`, `references/` folders sit beside it.

```markdown
---
name: media-video-analyze
description: Use this skill when the brief asks to analyze a video and extract a transcript.
---

# Steps
1. ...
```

`GEMINI.md` / `AGENTS.md` take no frontmatter and are always active for their directory scope.

### Employee → agy custom agent (optional)

A Markdown custom agent in `.agents/agents/<name>.md`. The keys the changelog names for its frontmatter are `tools`, `skills`, `rules`, `agents`, `plugins`, `hooks`, `inheritCustomizations` and `excludeDefaultComponents`; relative paths resolve against the agent file's directory. The full schema is in the online reference (https://antigravity.google/docs/cli/reference), not in the bundled docs, so generate one only after checking it there. For a `type: mind_clone`, the adapter prepends `(DISCLOSURE: AI-generated persona, not real person.)` to the description.

---

## 5. Tool whitelist mechanics

- agy has no flag that lists allowed tools for one call. Restriction comes from three places: a custom agent's `tools` list (with `--agent`), `--mode plan` (plan before acting), and `PreToolUse` hooks that answer `allow`, `deny`, `ask` or `force_ask` per tool name (`run_command`, `view_file`, `browser_.*`, ...).
- Approval: without `--dangerously-skip-permissions`, a headless run stops on the first tool that needs approval. Since 1.2.15 a denied request is respected and not worked around.
- The engine passes `--dangerously-skip-permissions` unless the run asks for safety (`opts.yolo === false`, the `--safe` path).
- An answer-only call (`opts.noTools`, the routers) runs with `--mode plan` and never with `--dangerously-skip-permissions`, whatever `execution.headless_skip_permissions` says, and never with `--disable-slash-commands` (agy warns that plan mode "has no effect while slash command expansion is disabled"). Measured on 1.3.3 (2026-10-13): a JSON-only prompt answers normally (exit 0, `status: SUCCESS`, `response` holds the JSON); a tool that needs a permission (`write_file`, `command`) is auto-denied, nothing is written, and agy still exits 0 with `response: ""` and `denied_actions: [{"action": ..., "display_name": ...}]`. The driver reports that envelope as a failed run whose error names the denied actions, and does not run it again.

---

## 6. Max-turns mechanics

agy exposes no turn or iteration limit on the command line. What exists:

1. `--print-timeout <dur>` (Go duration, for example `20m`). Default `0s` waits until the turn completes; since 1.2.9 the run waits for background tasks up to that deadline, capped at 30 minutes.
2. agy's internal step limit, visible to a `Stop` hook as `terminationReason: "max_steps_exceeded"`.
3. The engine's spawn timeout (`opts.timeoutMs`), which kills the process; the result reports exit 124 and nothing is parsed.

A protocol `max_turns` is therefore not enforceable on agy. The engine does not pass `--print-timeout` today.

---

## 7. Subagent spawning

**What the engine runs.** Every turn is one `agy` process, spawned once (`runAntigravity` in `skills/_shared/lib/host-agent-driver.ts`):

```bash
printf '%s\n' '{"event":"user","message":{"content":"<prompt>"}}' | \
agy --input-format stream-json --output-format stream-json \
  [--conversation <id> | --continue] \
  [--model <id>] \
  [--mode plan | --dangerously-skip-permissions] \
  [--add-dir <dir>]... \
  -p=
```

- `-p=` (alias `--print`, `--prompt`): run one prompt non-interactively, here read from stdin. It goes last and in the `=` form: a bare `-p` followed by another flag takes that flag as the prompt and exits 2. agy has **no system-prompt flag** (1.3.3 flags: `add-dir`, `agent`, `continue`, `conversation`, `dangerously-skip-permissions`, `disable-slash-commands`, `effort`, `input-format`, `json-schema`, `log-file`, `mode`, `model`, `new-project`, `output-format`, `print`, `print-timeout`, `project`, `prompt`, `sandbox`), so the fixed part travels in the message: the prompt is `appendSystemPrompt + "\n\n---\n\n" + prompt` when a preamble is set. The fixed part always comes first and nothing variable (cwd, a timestamp, the request) precedes it, so a provider prefix cache can hit; the routers also run in one constant folder for the same reason. Whether Google's backend caches that prefix is the provider's decision, not visible in the envelope beyond `cache_read_tokens`. The message bytes are the same whatever the prompt's size, because every size takes the one transport below.
- Prompt delivery: stdin, for every call and every size (fresh or resumed, worker or answer-only), as ONE NDJSON line `{"event":"user","message":{"content":"<full prompt>"}}`; stdin is then closed, so agy ends after that turn. No argv budget applies and no temp file is written. Before 2026-10-14 a prompt over the argv budget (100 000 bytes, 6 000 on Windows, so almost every call there) went to a temp file behind a "read this file" message; live on 1.3.3 (2026-10-13) the model in `--mode plan` tried to read it with a shell command, agy auto-denied it and the router got `response: ""`, and the temp path changed the message on every call. Measured on 1.3.3: the block form `"content":[{"type":"text","text":"..."}]` is also accepted, an unknown event name only warns (`ignoring unsupported stream input message event "..."`), a line with no `event` is an error.
- `--output-format stream-json`: NDJSON on stdout, an `{"event":"init",...}` line, step updates, and a final `{"event":"result","result":{...}}` whose `result` object has the shape `--output-format json` prints whole (`conversation_id`, `status`, `response`, `error`, `duration_seconds`, `num_turns`, `usage`, `denied_actions`). A run with no result line is a failed run carrying agy's stderr. From that object the engine reads `response` (or `result`), `session_id` / `sessionId` / `conversation_id`, `is_error`, `error`, `denied_actions` and `usage` (`input_tokens`, `output_tokens`, `thinking_tokens`, `cache_read_tokens`). No USD cost and no model name are reported. The run is marked `costUnavailable`; when the model is known (the `--model` the run passed, or a `model` field should a build add one) the driver prices the tokens with the estimator's price table and marks the result `costEstimated: true`. Otherwise `costUsd` stays `null`, which every report shows as unknown, never as $0.
- Resume: `--conversation <id>` when the previous envelope returned a real id; `--continue` (agy: "Continue the most recent conversation") only when the id is the engine's placeholder `nrv-agy-<uuid>`. agy cannot be given an id up front.
- `--model <id>`: only from `opts.model` or the resolved system model.
- `--dangerously-skip-permissions`: unless `opts.yolo === false` or `opts.noTools`.
- `--mode plan`: only on an answer-only call (`opts.noTools`).
- `--add-dir <dir>`: once per directory the run is granted (project, outputs root, business or squad dir).
- Never passed: `--effort` (see §13), `--sandbox`, `--json-schema`, `--print-timeout`, `--agent`, `--disable-slash-commands`.

**A resume that lands in a new conversation.** agy 1.3.3 answers `--conversation <unknown-id>` with exit 0, `warning: conversation "<id>" not found` on stderr and a NEW `conversation_id` in the envelope: the turn ran without the previous context. The driver does not re-run it (it was paid for). It marks the result `resumeLost: true`, adds a warning saying the resume failed, and records the new id as the session id; `nrv revise`, the gate's correction rounds and the solo review's corrections print that warning and audit it (`x_resume_lost`, or `resume_lost: true` on `revision_auto`). Either sign is enough: the stderr line, or an envelope id that differs from the one asked for.

**No re-spawn.** A failed run is reported as failed. Since 1.2.10 a model or agent error mid-turn exits 3 after the turn was paid for, so the two retries that used to re-run the turn (without `--output-format`, and `--conversation` → `--continue`) are gone. Recovery is the caller's (the delivery pipeline's cold retry).

**Light layer.** The `RUNTIMES` adapter used for short helper calls runs `agy --input-format stream-json --output-format stream-json [--dangerously-skip-permissions] -p=` with `<persona>\n\n---\n\n<message>` as the one stdin event, and returns the result event's `response`, trimmed. The skip flag follows the `execution.headless_skip_permissions` setting (`NIRVANA_HEADLESS_SKIP_PERMISSIONS`).

**Native subagents.** Inside an interactive agy session the model can delegate to subagents defined in `.agents/agents/`, address one with `@<name> <message>`, or start a session as one with `--agent <name>` (works headless since 1.2.11). Nirvana does not rely on them for dispatch.

---

## 8. Memory storage

| Layer | Path | Persistence |
|---|---|---|
| Permanent (cross-session) | Global rules in `~/.gemini/config/` (`AGENTS.md`, `GEMINI.md`, `rules/`) | Manual |
| Project | `<project>/AGENTS.md` or `GEMINI.md`, plus every one above cwd up to the repo root | Auto-load |
| Session | agy conversation | Persisted by agy; resumable |
| Business permanent | `~/businesses/<biz>/memory/permanent.md` | Engine persists |
| Project (business) | `<project>/<biz>/<project_id>/memory/` | Isolation by construction |

Rules are deduplicated per conversation. Each rule file is capped at 24 000 bytes (truncated on line boundaries), and always-on plus global rules share a 20 000-token budget; rules over budget become file-path pointers.

> **Isolation guard:** agy does not isolate memory between projects. The engine builds the prompt with ONLY the memory relevant to the `project_id` before spawning, otherwise `audit_event: isolation_violation`. A `GEMINI.md` / `AGENTS.md` above the run's cwd is loaded regardless, so dispatch cwd matters.

---

## 9. Context window and compaction

- The window depends on the model in use; `agy models` lists what the account can run.
- Compaction is automatic and spreads its user-request budget across all captured prompts (1.2.8).
- The `nirvana-os` `PreInvocation` hook runs before **every** model call, so in the operator's own session its context is re-sent each time and counts against the window on long runs. In a child the engine started it injects nothing (§10).
- Since 1.3.2 `--dangerously-skip-permissions` no longer approves the implementation plan in plan mode; plans wait for review unless `Artifact Review` is changed in `/config`. A headless run in `--mode plan` may therefore block.

---

## 10. Hook system

Hooks live in `hooks.json` in a customization root: `~/.gemini/config/hooks.json` (global) or `<workspace>/.agents/hooks.json`. Plugins may ship their own. Each top-level key is a named hook (`"enabled": false` turns it off); handlers of the same event across named hooks run in sequence.

| Event | When it fires | Shape | Output |
|---|---|---|---|
| `PreToolUse` | Before a tool step | Grouped: `matcher` regex on the tool name + `hooks` | `decision`: `allow` / `deny` / `ask` / `force_ask`; optional `reason`, `permissionOverrides`, `overwrite` |
| `PostToolUse` | After a tool step | Grouped | `{}` |
| `PreInvocation` | Before every model call (input has `invocationNum`) | Flat list of handlers | `injectSteps`: `userMessage`, `ephemeralMessage` or `toolCall` |
| `PostInvocation` | After tool calls finish | Flat | `injectSteps`, `terminationBehavior`: `force_continue` / `terminate` |
| `Stop` | When the loop ends (`terminationReason`: `model_stop`, `max_steps_exceeded`, `error`) | Flat | `decision: "continue"` re-enters the loop |

- Handler fields: `type` (only `"command"`), `command` (run with `sh -c`, or `cmd /c` on Windows, from the directory holding `hooks.json`; `~` expands), `timeout` in **seconds**, default 30.
- Input is JSON on stdin with camelCase keys: `conversationId`, `workspacePaths`, `transcriptPath`, `artifactDirectoryPath`, `modelName`. Output is JSON on stdout. Hooks run synchronously and block the loop.
- Nirvana installs one named hook, `nirvana-os`, a `PreInvocation` that injects the project's session context as an `ephemeralMessage`. In a child the engine started it exits at once with no output, before reading stdin: a dispatched worker (`NIRVANA_DISPATCH_DEPTH`, stamped by the driver on every child) has its own brief and must not be told to orchestrate, and an answer-only call (`NIRVANA_ANSWER_ONLY=1`, stamped on `noTools` children) only returns a decision. Measured locally without a model call (2026-10-13, 20 runs each): about 13 ms per call when agy closes the hook's stdin and about 530 ms when it holds stdin open (the script's 500 ms read timeout); about 8 ms with either marker in both cases.

---

## 11. Invocation examples

### Example 1: Squad capability

```bash
agy -p "Analyze video: https://..." --output-format json --dangerously-skip-permissions
```

### Example 2: Business brief, then a revision on the same conversation

```bash
# First turn: the business runs as ONE solo agent (it plays the seats itself)
agy -p "<brief>" --output-format json --dangerously-skip-permissions \
  --add-dir "$PROJECT" --add-dir "$OUTPUTS" > turn-1.json

# Revision: resume the conversation id returned in turn-1.json
agy -p "<revision request>" --output-format json --dangerously-skip-permissions \
  --conversation "$(jq -r '.session_id // .conversation_id' turn-1.json)" > turn-2.json
```

### Example 3: Harness escalation

```bash
echo '{"type":"human_escalation_required","trigger_id":"budget","severity":"high",...}' \
  > .harness/notifications/$(date +%s).json
```

### Reading the result

| Exit | Meaning |
|---|---|
| 0 | Turn completed. Still check `is_error` / `error` in the envelope |
| 1 | Startup or usage error, for example an invalid `--json-schema` (rejected at startup since 1.2.14) |
| 3 | Agent or model API failure. stderr carries an `AGY_ERROR: {...}` JSON line (status, error code, retryability, error id; since 1.2.6). Since 1.2.10 this also covers a turn that streamed part of its answer, and the JSON output includes the partial response |
| 124 | Engine-side: the spawn timeout killed the process |

---

## 12. Runtime-specific validators

- **Flags exist**: every flag the engine builds is in `agy --help` on 1.3.3. Re-run `agy --help` after an update before adding a new one.
- **Approval coherent**: a run without `--dangerously-skip-permissions` must not need tools to start (the prompt arrives on stdin, so none is needed to read it).
- **Model valid**: a model passed with `--model` must appear in `agy models`.
- **Rules size**: a generated `AGENTS.md` / `GEMINI.md` must stay under 24 000 bytes or agy truncates it.
- **JSON configs one level deep**: since 1.2.10 a directory entry in `skills.json`, `rules.json`, `agents.json` or `plugins.json` loads only the items directly inside it; nested items need `include_only`.

---

## 13. Known limitations

1. **Effort is not passed.** agy has `--effort low|medium|high|xhigh|max` (since 1.2.11, the same levels as the engine's), but `EFFORT_CAPABLE` holds only `claude-code` and `codex`, so a requested effort only logs "has no effort setting" and agy runs at its default.
2. **Answer-only calls rely on plan mode.** agy has no switch that removes tools; `--mode plan` without the skip flag makes headless agy auto-deny any tool that needs a permission (§5). A model that tries one anyway produces no answer, and the run fails with the denied actions named. The prompt arrives on stdin, so reading it needs no tool on any OS.
3. **`--continue` can pick the wrong conversation** when the previous envelope returned no id and two runs share a directory.
4. **No turn limit** (§6) and no per-call tool list (§5).
5. **Hook re-injection.** In the operator's own session the `nirvana-os` `PreInvocation` hook ignores `invocationNum`, so it re-sends the session context before every model call. Dispatched workers and answer-only calls skip it (§10).
9. **No system-prompt flag.** The fixed part of a prompt is a preamble of the message (§7), so prompt caching depends on the provider matching the prefix.
6. **Quota stops are immediate.** `GEMINI_API_KEY` sessions stop on daily quota, spend cap or depleted credits (1.2.12, 1.2.13); server retry delays above 30 s stop the run; "Your AI credits balance is too low to continue." (1.2.15). Expect exit 3.
7. **Windows.** The prompt goes on stdin, so the 6 000-byte argv budget of the other argv runtimes does not apply to agy. agy itself: the terminal sandbox needs no admin rights (1.2.17), sandboxed commands fall back to Windows PowerShell when PowerShell 7 came from the Microsoft Store (1.3.3), and `config.json`, `hooks.json` and plugin manifests saved with a UTF-8 BOM load (1.2.16, 1.3.1). Hook commands run under `cmd /c`.
8. **Fast release cadence.** One release every one or two days; behavior in headless mode has changed several times in a month (1.2.6, 1.2.9, 1.2.10, 1.3.2).

---

## 14. Source references

- `agy --help`, `agy help plugin`, `agy help mcp`, `agy models --help`, `agy changelog` (1.3.3)
- Bundled docs: `~/.gemini/antigravity-cli/builtin/skills/agy-customizations/docs/{hooks,skills,rules,json_configs,plugins,mcp_servers}.md`
- CLI reference: https://antigravity.google/docs/cli/reference
- Gemini CLI migration: https://antigravity.google/docs/cli/gcli-migration
- Transition announcement: https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/
- Driver: `skills/_shared/lib/host-agent-driver.ts` (`runAntigravity`, the `antigravity-cli` entry in `RUNTIMES`, `RUNTIME_DIR_GRANT_FLAG`, `EFFORT_CAPABLE`)
- Squad Protocol v6: `~/.nirvana/skills/squads/SQUAD_PROTOCOL_V6.md`
- Business Protocol v2: `~/.nirvana/skills/businesses/BUSINESS_PROTOCOL_V2.md`
- Harness protocol: `~/.nirvana/skills/harness/SKILL.md`

---

## 15. Version history

| Version | Date | Changes |
|---|---|---|
| 1.0.0 | 2026-06-06 | Doc inicial — successor to gemini-cli (sunset 2026-06-18); covers Squad 5.0 + Business 1.0 + Harness 1.0 against Antigravity 2.0 (Gemini 3 Pro) |
| 2.0.0 | 2026-10-11 | Rewritten against agy 1.3.3. Removed flags that never existed (`--max-iterations`, `--tools`, `--resume`, `--checkpoint`), the `~/.antigravity/*` paths and the 2.0 versioning. Documents the real driver argv (one spawn, `--conversation` / `--continue`), exit 3 + `AGY_ERROR`, the 1.3.2 plan-mode change, hooks, rules, skills, plugins, subagents and Windows notes |
| 2.1.0 | 2026-10-13 | Answer-only calls run in `--mode plan` without the skip flag, and an empty answer with `denied_actions` is a failed run. No system-prompt flag: the fixed part stays first in the message. Cost priced from tokens when the model is known, else unknown. The `nirvana-os` hook steps aside in dispatched and answer-only children |
| 2.2.0 | 2026-10-14 | The prompt goes on stdin as one stream-json `user` event (`--input-format stream-json --output-format stream-json -p=`) for every call and size; the temp-file bootstrap is gone for agy. The result is the final `result` event |
