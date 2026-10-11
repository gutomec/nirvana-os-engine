# Adapter · Codex (OpenAI Codex CLI)

> Runtime adapter for Squad Protocol v6 + Business Protocol v2 + Harness Protocol v1.
> Covers the 3 protocols in a single doc. Canonical sections per Squad Protocol v6 §18.5.
> System identity + capabilities (what Nirvana-OS is and can do): see `../NIRVANA-OS.md` (single source).
>
> Every command and flag below exists in `codex --help` / `codex exec --help` on the tested versions.
> Agents build commands from this file: if a flag is not listed here, do not invent it.

---

## 1. Adapter metadata

| Field | Value |
|---|---|
| `runtime` | `codex` |
| `vendor` | OpenAI |
| `binary` | `codex` (headless entry point: `codex exec`, alias `codex e`) |
| `min_version` | Codex CLI 0.153 (the driver's flag set was first audited there; older builds lose flags through the driver's retry, see §11) |
| `tested_against` | Codex CLI 0.159.2 (installed, help pages read 2026-10-11) and 0.162.1 (latest stable, source at tag `rust-v0.162.1`) |
| `default_model` | Inherited from the user's `~/.codex/config.toml`. The engine never pins a model; it passes `--model` only when the user or a cascade entry names an OpenAI id. The bundled catalog default is `gpt-6.1-sol`. |
| `config_paths` | `~/.codex/config.toml` (or `$CODEX_HOME/config.toml`), `$CODEX_HOME/<name>.config.toml` (profile layered by `-p <name>`), `<repo>/.codex/config.toml` |
| `instructions` | `~/.codex/AGENTS.md` (global), `AGENTS.md` from the repo root down to cwd (project) |
| `skills_root` | `~/.agents/skills` (official user scope), `.agents/skills` (repo scope), `/etc/codex/skills` (admin). `$CODEX_HOME/skills` is deprecated but still scanned. |
| `agents_root` | `~/.codex/agents/*.toml` (personal), `.codex/agents/*.toml` (project) |
| `hooks` | `~/.codex/hooks.json`, `[hooks]` in `config.toml`, `<repo>/.codex/hooks.json`, plugin-bundled hooks |
| `audit_log` | `~/.codex/sessions/` (Codex rollouts), plus Nirvana's own audit through the Codex hooks (§10) and `outputs/<trace>/audit.jsonl` |
| `protocol_versions` | Squad 6, Business 2, Harness 1 (gaps in §13) |

---

## 2. Feature support matrix

`✓` = native · `~` = workaround/partial · `✗` = not supported

| Feature (Business v2 §6.5) | Squad v6 | Business v2 | Harness v1 | Notes |
|---|---|---|---|---|
| `max_turns` | ✗ | ✗ | ✗ | `codex exec` has no turn cap. The engine bounds a run by wall-clock timeout (§6). |
| `tool_whitelist` | ~ | ~ | ~ | No per-tool allowlist flag. Gates are the sandbox mode, the approval path and `PreToolUse` hooks that can deny (§5). |
| `subagent_spawning` | ✓ | ✓ | ✓ | Native `multi_agent` (on by default). Dispatched workers get `-c agents.enabled=false` unless the caller orchestrates (§7). |
| `audit_trail` | ✓ | ✓ | ✓ | `--json` event stream, rollouts in `~/.codex/sessions/`, Nirvana's `PreToolUse`/`PostToolUse` hooks. |
| `scheduled_invocation` | ✗ | ✗ | ✗ | No scheduler on the CLI; the harness uses external cron. |
| `event_bus` | ~ | ~ | ~ | Mentions and tickets go through the file system. |
| `hooks` | ✓ | ✓ | ✓ | 12 lifecycle events, trust by definition hash (§10). |
| `sandboxing` | ✓ | ✓ | ✓ | `read-only`, `workspace-write`, `danger-full-access`. |
| `session_memory` | ✓ | ✓ | ✓ | Thread history; `codex exec resume <id>` continues it. |
| `project_memory` | ✓ | ✓ | ✓ | `AGENTS.md` loaded automatically. |
| `global_memory` | ~ | ~ | ~ | `~/.codex/AGENTS.md`. The `memories` feature exists but ships off. |
| `handoff_artifacts` | ✓ | ✓ | ✓ | Final message via `-o <file>`; structured output via `--output-schema`. |
| `fork_context` | ✓ | ✓ | ✓ | `codex exec fork <id>` branches a thread without touching the original. The driver does not use it yet. |
| `teammate_primitive` | ✗ | ✗ | ✗ | No team primitive; a team is a file-system convention. |
| `telemetry_otel` | ✓ | ✓ | ✓ | Native OTel export through the `otel` config key. |

---

## 3. Concept mapping

| Concept (Protocol) | Codex equivalent | Implementation |
|---|---|---|
| Squad / Business | Skill in `~/.agents/skills/<name>/SKILL.md` | The engine installs its skills there; the run itself is one `codex exec` process started by `runCodex` |
| Capability | File inside the skill | `<skill>/capabilities/<id>.md`, read by the agent when the brief names it |
| Employee (seat) | Seat file played by the one business agent | A business runs as ONE solo agent (`skills/harness/lib/business-solo.ts`) that opens a seat's file when it works as that seat. A Codex custom agent (§4) is only needed for a stand-alone subagent. |
| `is_brief_intake: true` | The solo agent itself | Gets the brief on stdin |
| `is_antagonist: true` | A separate `codex exec` dispatch | Started by the harness, never by the worker (workers have subagents off) |
| Handoff artifact | `-o <file>` plus files on disk | Persisted in `<project>/.handoffs/` |
| Mention `@employee` | Convention in the prompt | The harness resolves it to a new dispatch |
| Ticket | Persisted file | `<project>/.tickets/<TICKET_ID>.json` |
| Escalation trigger | Harness check after the run | Reads exit code, `turn.failed` / `error` events and the final message |
| Permanent memory | `~/.codex/AGENTS.md` + business memory files | Codex auto-loads only AGENTS.md; the brief carries the rest |
| Project memory | `AGENTS.md` | Auto-load (combined cap `project_doc_max_bytes`, default 32768) |
| Session memory | Thread history | `codex exec resume <thread_id>` (`nrv revise`) |
| Routing decision (harness) | Done before the spawn | The orchestrator picks the business; Codex only executes |

---

## 4. Frontmatter mapping

Codex reads no frontmatter from squads or businesses. Two native formats matter.

### Skill (`SKILL.md`)

A skill is a directory with `SKILL.md` (YAML frontmatter `name` + `description`, then the body). Codex lists skills inside a budget of 2% of the context window or 8,000 characters. Two skills with the same name are not merged; both show up. `[[skills.config]]` with `enabled = false` hides one without deleting it.

### Employee → Codex custom agent (TOML)

One agent per standalone TOML file in `~/.codex/agents/` or `.codex/agents/`. Required keys: `name`, `description`, `developer_instructions`. Any other `config.toml` key is optional (`model`, `model_reasoning_effort`, `sandbox_mode`, `mcp_servers`, `skills.config`); omitted keys inherit from the parent. The `name` field, not the filename, is the identity.

```toml
# ~/.codex/agents/alex-hormozi.toml
name = "alex-hormozi"
description = "Mind clone of Alex Hormozi for offer evaluation. (DISCLOSURE: AI-generated persona, not real person.)"
developer_instructions = """
You are a mind-clone of Alex Hormozi specialized in offer evaluation...
"""
sandbox_mode = "read-only"
# no `model` key: the engine does not pin a model, the parent's applies
```

> The adapter prepends `(DISCLOSURE: ...)` to the description when `type: mind_clone`.
> A `model` set in the file beats spawn values and `[agents]` defaults, so leave it out.

---

## 5. Tool whitelist mechanics

`codex exec` has no flag that lists allowed tools. What the engine has:

- **Sandbox** (`-s/--sandbox`): `read-only`, `workspace-write`, `danger-full-access`. The driver maps `noTools` to `-s read-only`.
- **Writable roots**: under `workspace-write` only `-C <dir>` is writable; the driver grants the project dir, the outputs root and the business or squad dir with `--add-dir`.
- **Approvals**: `--approve-for-me` routes every approval to Codex's own reviewer under the workspace-write sandbox. It cannot be combined with `-s`. `--dangerously-bypass-approvals-and-sandbox` removes both gates.
- **Hooks**: a `PreToolUse` handler can deny a call (`permissionDecision: "deny"` or exit code 2). This is the only hard per-tool gate.
- `-a/--ask-for-approval` (`on-request`, `never`) exists only on the interactive root, not on `exec`.

---

## 6. Max-turns mechanics

There is none. `codex exec` has no `--max-turns` and no config key for a per-run turn cap. The engine bounds a run with `timeoutMs` (the child is killed and reported with exit 124). Cost is not a usable bound either: Codex reports token counts, never USD, so the driver returns `costUnavailable: true` and the cost estimator prices the `usage` it hands back.

---

## 7. Subagent spawning

Codex has native subagents: the `multi_agent` feature is stable and on by default. Spawns show up in the event stream as `collab_tool_call` items. Global switches live under `[agents]`:

| Key | Meaning |
|---|---|
| `agents.enabled` | Turns the multi-agent tools on or off. Default `true`. |
| `agents.max_concurrent_threads_per_session` | Caps open spawned threads (primary not counted). `agents.max_threads` is a legacy alias. |
| `agents.default_subagent_model` | Default model for spawned agents. |
| `agents.default_subagent_reasoning_effort` | Default effort for spawned agents. |

There is no `agents.max_depth` key and no `[agents.<name>]` block; custom agents are TOML files (§4).

**Engine rule.** A dispatched worker does not open its own agents, the same rule Claude workers get through `--disallowedTools Task Agent Workflow`. `runCodex` and the Orca interactive launcher pass `-c agents.enabled=false` unless the caller sets `allowSubagents`. A config key is used instead of `--disable multi_agent` because older builds tolerate an unknown `-c` key but exit 1 on an unknown `--disable` feature.

**For a mention `@x`:** the harness detects it in the returned handoff and dispatches `x` as a new run.

---

## 8. Memory storage

| Layer | Path | Persistence |
|---|---|---|
| Global | `~/.codex/AGENTS.md` | Auto-load |
| Project | `AGENTS.md` from repo root to cwd | Auto-load, capped by `project_doc_max_bytes` (32768 across all files) |
| Session | Thread history in `~/.codex/sessions/` (skipped with `--ephemeral`) | Resumable by thread id |
| Business permanent | `~/businesses/<biz>/memory/permanent.md` | The engine writes it into the brief |
| Project (business) | `<project>/<biz>/<project_id>/memory/` | Isolation by construction |

> **Isolation guard:** Codex does not isolate memory per project. The engine builds the prompt with ONLY the memory of the current `project_id`; anything else is `audit_event: isolation_violation`.

---

## 9. Context window and compaction

- Window: 272,000 tokens for every listed model in the bundled catalog (`codex debug models --bundled`).
- Compaction is automatic. The engine sets the threshold with `-c model_auto_compact_token_limit=<n>` when its context-window setting is above 0, on both the headless and the Orca interactive path.
- There is no checkpoint flag. A run that must survive is resumed by thread id instead.

---

## 10. Hook system

Codex has granular hooks (feature `hooks`, stable, on).

**Events (12):** `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`, `SubagentStart`, `SubagentStop`, `Stop`, `Interrupt`.

**Sources:** `~/.codex/hooks.json`, inline `[hooks]` in `~/.codex/config.toml`, `<repo>/.codex/hooks.json` and `<repo>/.codex/config.toml` (loaded only when that project layer is trusted), enabled plugins, and managed `requirements.toml`.

**Trust:** a non-managed hook runs only after it is reviewed and trusted (`/hooks` in the TUI). Trust is recorded against the hook's definition hash, so a new or edited hook is skipped until trusted again. The record key also includes the matcher-group index, which means a group inserted before Nirvana's by another installer silently detaches Nirvana's trust until `nrv setup` runs again. `--dangerously-bypass-hook-trust` skips persisted trust for one invocation. Managed hooks are trusted by policy.

**Matchers** (for `PreToolUse`, `PostToolUse`, `PermissionRequest`): shell is `Bash`; file edits are `apply_patch` (aliases `Edit`, `Write`, while the payload `tool_name` stays `apply_patch`); MCP tools are `mcp__<server>__<tool>`. Hosted tools such as web search are not matched.

**Blocking:** `PreToolUse` denies with `hookSpecificOutput.permissionDecision: "deny"` or exit 2; `UserPromptSubmit` blocks with `decision: "block"` or exit 2; `PostToolUse` cannot undo a call, only replace its result with feedback; `async` handlers never block.

**What Nirvana installs:** `PreToolUse` and `PostToolUse` groups in `~/.codex/hooks.json`, matcher `Bash|apply_patch`, async command handlers running `audit-emit-from-hook.ts`, with the trust records written by `skills/_shared/lib/codex-hooks.ts`. MCP tool calls are not matched today.

---

## 11. Invocation examples

### What the driver runs (`runCodex`, headless)

```text
codex exec -C <cwd>
  [--add-dir <dir>]...                        # project dir, outputs root, business/squad dir
  [-s read-only | --approve-for-me]           # noTools | --safe (trust mode passes neither)
  [resume <thread_id>]                        # only when resuming (nrv revise)
  --json --skip-git-repo-check -o <tmp-file>
  [--model <openai id>]                       # only gpt-*, o<N>*, codex*; anything else is dropped
  [-c model_reasoning_effort="<level>"]       # engine levels: low, medium, high, xhigh, max
  [-c model_auto_compact_token_limit=<n>]
  [-c agents.enabled=false]                   # unless allowSubagents
  [-c model_provider="<provider>"]
  [--ephemeral]                               # never on resume
  [--output-schema <file>]
  [-i <image>]...
  [-c web_search="<mode>"]
  [--dangerously-bypass-approvals-and-sandbox] # trust mode (default)
  < prompt on stdin
```

- `-C`, `--add-dir`, `-s` and `--approve-for-me` exist only on the `exec` parent, so they come before `resume`. After it they are a parse error (exit 2).
- The directive (`appendSystemPrompt`) has no flag; it is folded into the stdin prompt as a preamble followed by `---`.
- The session id is `thread.started.thread_id` from the `--json` stream. The final answer is read from the `-o` file.
- If an older Codex rejects a flag (`unexpected argument`), the driver drops it and retries, up to four times, for `--add-dir`, `--approve-for-me` (replaced by `-s workspace-write`), `--ephemeral`, `--output-schema`, `-i`, `-c` and `--model`.

Concrete run (trust mode, project outside git):

```bash
codex exec -C /work/proj --add-dir /work/proj/outputs \
  --json --skip-git-repo-check -o /tmp/codex-last.txt \
  -c model_reasoning_effort="high" -c agents.enabled=false \
  --dangerously-bypass-approvals-and-sandbox < brief.md
```

Resume for a revision (same parent flags, then the subcommand):

```bash
codex exec -C /work/proj resume 0199a3c2-... \
  --json --skip-git-repo-check -o /tmp/codex-last.txt \
  -c agents.enabled=false --dangerously-bypass-approvals-and-sandbox < revision.md
```

### Orca interactive worker (`interactiveArgv`)

```text
codex [--dangerously-bypass-approvals-and-sandbox] [-m <openai id>]
  [-c model_reasoning_effort="<level>"] [-c model_auto_compact_token_limit=<n>]
  [-c agents.enabled=false] [--add-dir <dir>]...
```

### Light layer (`callHostAgent`, judge and translate calls)

`codex exec [--dangerously-bypass-approvals-and-sandbox]`, prompt on stdin. It passes no `-C` and no `--skip-git-repo-check`, so with `headless_skip_permissions=false` from a non-git cwd Codex exits 1 before the model.

### `codex exec` surface (0.159.2)

| Form | Use |
|---|---|
| `codex exec [OPTIONS] [PROMPT]` | One run. No prompt or `-` reads stdin; a prompt plus piped stdin appends a `<stdin>` block. |
| `codex exec resume [SESSION_ID] [PROMPT]` | Continue a thread by UUID or thread name, or `--last`. `--all` lifts the cwd filter. No prompt reads stdin when piped. |
| `codex exec fork <SESSION_ID> [PROMPT]` | New thread branched from an existing one; the original is unchanged. |
| `codex exec review [PROMPT]` | Code review of the current repo: `--uncommitted`, `--base <branch>`, `--commit <sha>`, `--title`. |

Parent-only options: `-C/--cd`, `--add-dir`, `-s/--sandbox`, `--approve-for-me`, `-p/--profile`, `--oss`, `--local-provider`, `--color`. Shared by the subcommands: `-c`, `--enable`/`--disable <feature>`, `--strict-config`, `-m`, `-i`, `--dangerously-bypass-approvals-and-sandbox`, `--dangerously-bypass-hook-trust`, `--worktree`, `--thread-source`, `--skip-git-repo-check`, `--ephemeral`, `--ignore-user-config`, `--ignore-rules`, `--output-schema`, `--json`, `-o/--output-last-message`.

### JSON event stream (`--json`)

Top-level `type`: `thread.started` (`thread_id`), `turn.started`, `turn.completed` (`usage`), `turn.failed` (`error.message`), `item.started` / `item.updated` / `item.completed` (`item`), `error` (`message`). `usage` carries `input_tokens`, `cached_input_tokens`, `cache_write_input_tokens`, `output_tokens`, `reasoning_output_tokens`. Item types include `agent_message`, `reasoning`, `command_execution`, `file_change`, `mcp_tool_call`, `collab_tool_call`, `web_search`, `todo_list`, `error`. No event carries the model name.

Failure contract used by the driver: exit 0 is not success. A terminal `error` or `turn.failed` marks failure; a later `turn.completed` clears it; an `item` of type `error` is a warning.

---

## 12. Runtime-specific validators

- **Model id**: only an OpenAI id reaches `--model` / `-m`. A Claude alias pinned for the session is dropped.
- **Effort per model**: Codex validates `model_reasoning_effort` against the model's catalog entry. `gpt-6-luna` and `gpt-5.6-luna` stop at `max`; `ultra` exists on Codex for some models but is not an engine level, so the engine never sends it.
- **Retired models**: `gpt-5.5` leaves Codex on 2026-10-14. Never put it in an example, a default or a cascade entry.
- **Approval flags**: never pass `-s` together with `--approve-for-me`.
- **Skill location**: install skills in `~/.agents/skills`; a copy in the deprecated `$CODEX_HOME/skills` is listed a second time.

---

## 13. Known limitations

1. **No per-run turn cap** → bounded by timeout only.
2. **No USD cost** → token counts only; with no `--model` passed and no model in the event stream, the price lookup can miss and `$N` budgets on `codex:` cascade entries fail open.
3. **No per-tool allowlist** → sandbox, approval path and `PreToolUse` deny are the gates.
4. **No append-system-prompt flag** → the directive travels inside the user prompt.
5. **Hook trust is tied to group order** → a foreign edit to `hooks.json` can detach Nirvana's audit hooks until `nrv setup`.
6. **Skills installed in the deprecated root** → `runtime-dirs.ts` still targets `~/.codex/skills`, and the OpenClaw target fills `~/.agents/skills`, so Codex lists `nirvana` twice.
7. **No scheduler and no team primitive** → external cron and file-system conventions.
8. **Mentions and tickets** depend on the harness fanning out between runs.

---

## 14. Source references

- `codex --help`, `codex exec --help`, `codex exec resume|fork|review --help`, `codex features list`, `codex debug models --bundled` (0.159.2, 2026-10-11)
- Codex source at `rust-v0.162.1`: `codex-rs/exec/src/cli.rs`, `codex-rs/exec/src/exec_events.rs`, `codex-rs/ext/skills/src/host_roots.rs`, `codex-rs/core/config.schema.json`
- Hooks: https://developers.openai.com/codex/hooks (redirects to learn.chatgpt.com/docs/hooks)
- Subagents: https://developers.openai.com/codex/subagents (redirects to learn.chatgpt.com/docs/agent-configuration/subagents)
- Skills: https://developers.openai.com/codex/skills
- Releases: https://github.com/openai/codex/releases
- Driver: `skills/_shared/lib/host-agent-driver.ts` (`runCodex`, light-layer `buildCall`), `skills/_shared/lib/orca-worker.ts` (`interactiveArgv`), `skills/_shared/lib/codex-hooks.ts`
- Squad Protocol v6: `~/.nirvana/skills/squads/SQUAD_PROTOCOL_V6.md`
- Business Protocol v2: `~/.nirvana/skills/businesses/BUSINESS_PROTOCOL_V2.md`
- Harness protocol: `~/.nirvana/skills/harness/SKILL.md`

---

## 15. Version history

| Version | Date | Changes |
|---|---|---|
| 1.0.0 | 2026-05-02 | Initial doc: covers Squad 5.0 + Business 1.0 + Harness 1.0 against Codex CLI 0.2x |
| 2.0.0 | 2026-10-11 | Rewritten against Codex CLI 0.159.2 / 0.162.1. Removed nonexistent `codex run`, `--max-turns`, `--output-format json`, `--checkpoint`, `--agent`/`--skill`/`--prompt`, Markdown custom agents and `[agents.<name>]`/`agents.max_depth`. Documented the real `runCodex` and Orca argv, the `exec`/`resume`/`fork`/`review` surface, the JSON events, the 12 hook events and trust, skills at `~/.agents/skills`, TOML custom agents, `agents.enabled` and the absence of a turn cap. |
