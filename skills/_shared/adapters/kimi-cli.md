# Adapter · Kimi Code CLI (Moonshot Kimi Code)

> Runtime adapter for Squad Protocol v6 + Business Protocol v2 + Harness Protocol v1.
> Covers the 3 protocols in a single doc. Canonical sections per Squad Protocol v6 §18.5.
> System identity + capabilities (what Nirvana-OS is and can do): see `../NIRVANA-OS.md` (single source).
> Mirrors `codex.md` (sub-process dispatch, no per-employee agent file written by the engine).

Every command and flag below comes from the official Kimi Code docs (`MoonshotAI/kimi-code`, `docs/en/`, read 2026-10-11) or from `runKimi` in `skills/_shared/lib/host-agent-driver.ts`. Kimi is not installed on the audit machine, so nothing here was run against a live binary; §13 lists what that leaves open.

---

## 1. Adapter Metadata

| Field | Value |
|---|---|
| `runtime` | `kimi-cli` |
| `vendor` | Moonshot AI |
| `min_version` | Kimi Code CLI 2.x, npm `@moonshot-ai/kimi-code` (Node rewrite, single binary `kimi`, latest 2.1.1 on 2026-09-24). The legacy Python line, PyPI `kimi-cli` (latest 1.52.0 on 2026-09-22), also installs a binary named `kimi`; Moonshot says it "will gradually be phased out". Which one is on PATH decides the flag set, so the driver retries without the flags a build rejects (§7). |
| `default_model` | Inherited from the runtime. The engine never sets a model; it comes from the `kimi-cli:<model>` entry of `LLM_CASCADE` and reaches `-m` unchanged. `-m` takes a model alias defined in `config.toml` (the docs' example config defines `kimi-code/k3`, `kimi-code/kimi-for-coding`, `kimi-code/kimi-for-coding-highspeed`). Without `-m`, `default_model` from `config.toml` applies. |
| `tested_against` | Not run here. Flags checked against the `kimi` command reference and changelog 2.1.1. |
| `config_paths` | 2.x: `~/.kimi-code/config.toml` (moves with `KIMI_CODE_HOME`), `~/.kimi-code/mcp.json`, `~/.kimi-code/AGENTS.md`, `~/.kimi-code/SYSTEM.md`; project `.kimi-code/local.toml`, `.kimi-code/mcp.json`, `AGENTS.md`. Legacy: `~/.kimi/`. |
| `skills_root` | User: `~/.kimi-code/skills/` and `~/.agents/skills/`. Project (nearest dir with `.git`): `.kimi-code/skills/` and `.agents/skills/`. Extra: `extra_skill_dirs` in `config.toml`. Priority Project > User > Extra > Built-in. `nrv install` links no Kimi-specific dir; Nirvana skills reach Kimi through `~/.agents/skills/` (linked when OpenClaw is present) or a project `.agents/skills/`. |
| `agents_root` | Custom agent files (Markdown, frontmatter + system prompt) in `.kimi-code/agents/`, `.agents/agents/` and user/extra/plugin dirs; `--agent <name>` or `--agent-file <path>` selects the main agent. The engine uses neither: the persona travels in the `-p` prompt. |
| `memory_root` | `AGENTS.md`: global `~/.kimi-code/AGENTS.md`, cross-tool `~/.agents/AGENTS.md`, project `AGENTS.md` or `.kimi-code/AGENTS.md`. |
| `audit_log` | `~/.harness-logs/` (jsonl via the driver). Kimi keeps each session under `~/.kimi-code/` with `agents/main/wire.jsonl` (prompts, messages, tool calls, final state); `kimi export <id>` zips a session. |
| `protocol_versions` | Squad 5.0, Business 1.0, Harness 1.0 (with gaps recorded in §13) |

---

## 2. Feature Support Matrix

`✓` = native · `~` = workaround/partial · `✗` = not supported

| Feature (Business v2 §6.5) | Squad v6 | Business v2 | Harness v1 | Notes |
|---|---|---|---|---|
| `max_turns` | ~ | ~ | ~ | No CLI flag. `[loop_control] max_steps_per_turn` in `config.toml`, or env `KIMI_LOOP_MAX_STEPS_PER_TURN`, caps steps per turn; the engine sets neither and relies on its own timeout |
| `tool_whitelist` | ~ | ~ | ~ | No CLI flag. `[tools] enabled/disabled` and `[[permission.rules]]` in `config.toml`, or a `tools` list in an agent file; the engine passes none of them |
| `subagent_spawning` | ✓ | ✓ | ✓ | Built-in `coder`, `explore`, `plan` sub-agents via the `Agent` tool, plus `AgentSwarm`. The engine does not disable them in `-p` runs |
| `audit_trail` | ✓ | ✓ | ✓ | Per-session `wire.jsonl`; the harness adds its own jsonl via `runKimi` |
| `scheduled_invocation` | ✗ | ✗ | ✗ | No scheduler; degrade to external cron |
| `event_bus` | ~ | ~ | ~ | Mentions/tickets via the file system; no broker |
| `hooks` | ✓ | ✓ | ✓ | `[[hooks]]` in `config.toml`, 20 events, three of them blocking (§10). Not wired to the engine's audit yet |
| `sandboxing` | ~ | ~ | ~ | Workspace boundary (2.1.0 blocks symlink escapes, rejects extra dirs that resolve to home or `/`) and permission rules; no OS sandbox profiles |
| `session_memory` | ✓ | ✓ | ✓ | Sessions persist; `-S/--session [id]`, `-c/--continue`, `kimi session list` |
| `project_memory` | ✓ | ✓ | ✓ | `AGENTS.md` in the project |
| `global_memory` | ✓ | ✓ | ✓ | `~/.kimi-code/AGENTS.md` and `~/.agents/AGENTS.md` |
| `handoff_artifacts` | ✓ | ✓ | ✓ | JSON from the last assistant message of the `stream-json` output (§7) |
| `fork_context` | ~ | ~ | ~ | `/fork` in the TUI only; the engine spawns a fresh sub-process |
| `teammate_primitive` | ✗ | ✗ | ✗ | No team primitive; a team is a file-system convention |
| `telemetry_otel` | ✗ | ✗ | ✗ | No OTel export documented; `KIMI_DISABLE_TELEMETRY=1` turns off the anonymous telemetry |
| `mcp` | ✓ | ✓ | ✓ | `mcp.json` (user `~/.kimi-code/mcp.json`, project `.kimi-code/mcp.json`), stdio, HTTP and SSE, OAuth via `/mcp-config login`. No CLI flag for an MCP config file |

> **Note outside the canonical matrix:** what Kimi adds to the cascade is a 1M-token model (`kimi-code/k3` is declared with `max_context_size = 1048576` in the docs' config example) and the Kimi Code OAuth login (§8).

---

## 3. Concept Mapping

| Concept (Protocol) | Kimi Code equivalent | Implementation |
|---|---|---|
| Squad / Business | Skills directory + AGENTS.md | `.agents/skills/<name>/` (project) or `~/.agents/skills/` + the CWD's `AGENTS.md` |
| Capability | Skill or workflow file | `<skill>/capabilities/<id>.md`, read by the agent from the brief |
| Employee (seat) | Persona embedded in the `kimi -p` prompt | A business runs as ONE solo agent (`skills/harness/lib/business-solo.ts`) that plays the seats itself; core persona + DNA in the prompt body |
| `is_brief_intake: true` | Default persona when the skill is active | Built in the prompt |
| `is_antagonist: true` | Sub-process invoked in a pipeline | `kimi -p "<persona+brief>" --output-format stream-json -m <model>` |
| Handoff artifact | Last assistant message (stream-json) + file | Persisted in `<project>/.handoffs/` |
| Mention `@employee` | Convention in the handoff | The adapter detects it → new sub-process |
| Ticket | Persisted file | `<project>/.tickets/<TICKET_ID>.json` |
| Escalation trigger | Wrapper script + harness call | The wrapper checks the condition → emits a notification to the harness |
| Permanent memory | `AGENTS.md` (global + project) + custom files | Native load of `AGENTS.md` |
| Project memory | `<project>/AGENTS.md` | Native |
| Session memory | Session dir + `wire.jsonl` | Automatic compaction (`[loop_control] reserved_context_size`) |
| Routing decision (harness) | Pre-spawn lookup table | BM25 over `capabilities[].examples[]` in a Bun wrapper |

---

## 4. Frontmatter Mapping

### Squad v6 / Business v2 → AGENTS.md

Kimi reads `AGENTS.md` natively but has no protocol frontmatter. The adapter keeps the same two files as Codex:

```yaml
# AGENTS.md (head of the project/skill)
You are an AI agent operating under the Squad/Business Protocol.

Available capabilities: [media.video.analyze, media.transcript.extract, ...]
Default tools: [Read, Write, Bash]
```

```yaml
# .agents/manifest.yaml (auxiliary: read by a wrapper, not by Kimi)
name: nexus-council
protocol: 1.0
employees: [ceo, marketing-lead, ...]
operation_mode: zero_human
```

### Employee → `kimi -p` prompt

The engine writes no agent file. The employee persona is assembled in the prompt, together with the engine directive (Kimi has no system-prompt flag):

```
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

A Kimi agent file (`--agent-file <persona.md>`, with a `tools` list) could carry the persona as a real system prompt with an enforced tool list. Not used yet (§13).

---

## 5. Tool Whitelist Mechanics

- Kimi has no `--tools`/`--allowedTools` flag. The controls it does have live in config or agent files:
  - `[tools] enabled = [...]` / `disabled = [...]` in `config.toml`: a global allowlist/denylist, enforced before execution. Built-in names are exact and case-sensitive (`Read`, `Bash`, `Grep`); MCP tools match globs (`mcp__github__*`).
  - `[[permission.rules]]` with `decision = "allow" | "deny" | "ask"` and `pattern = "Bash(rm -rf*)"`. In `-p`, approvals are never requested; static deny rules still apply.
  - A custom agent file's `tools` / `disallowedTools` lists.
- The engine passes none of these today, so a `-p` worker has the full tool set under `auto` permission. The whitelist is the persona's "## Allowed tools" plus the engine's own gates.
- `--yolo`, `--auto` and `--plan` are rejected together with `-p`; never add them to a headless run.

---

## 6. Max-Turns Mechanics

Kimi has no `--max-turns`, no effort flag and no spend cap on the command line.

1. Each employee runs as a `kimi -p` sub-process with the driver's timeout (`opts.timeoutMs` → `spawnSync`).
2. A real step cap exists in config: `[loop_control] max_steps_per_turn` (unset or `0` = unlimited), overridable by `KIMI_LOOP_MAX_STEPS_PER_TURN`. The engine does not set it.
3. Print mode stays alive while background tasks are pending (`print_background_mode = "steer"` by default; bounds `print_wait_ceiling_s`, `print_max_turns`, both effectively unbounded). A worker that leaves a background `Bash` task running keeps the process up until the engine's timeout.
4. Thinking effort is config only: `[thinking] effort` or a model's `default_effort`. The engine's effort profiles do not reach Kimi (`EFFORT_CAPABLE` holds only claude-code and codex).

---

## 7. Subagent Spawning

Kimi has native sub-agents (`coder`, `explore`, `plan`, dispatched by the main agent through the `Agent` tool, and `AgentSwarm`), each with its own context window. The engine does not use them for dispatch: every employee is a `kimi -p` sub-process (`host-agent-driver.runKimi`). The argv it builds:

```bash
kimi -p "<prompt or bootstrap>" --output-format stream-json [-m <model>] [--add-dir <dir>]...
```

- `-p "<prompt>"`: one non-interactive prompt, no TUI, `auto` permission. Prompts above `MAX_ARGV_PROMPT_BYTES` go to a temp file and `-p` carries a short bootstrap that points at it (no stdin or prompt-file flag is documented).
- `--output-format stream-json`: one JSON message per stdout line. Thinking is not written; tool progress and "resuming session" notices go to stderr.
- `-m <model>`: only when the cascade entry names a model.
- `--add-dir <dir>`: one per directory the dispatch grants (project, outputs, business, squads). `RUNTIME_DIR_GRANT_FLAG["kimi-cli"] = "--add-dir"`. Relative paths resolve against the cwd; 2.1.0 rejects a dir that resolves to home or `/`.

Fallbacks, in order: if the run fails and stderr names `add-dir`, the driver drops every `--add-dir`, warns `kimi-cli: this version does not know --add-dir; retried without it (...)` and reruns; if it then fails on `output-format`/unknown/unrecognized/invalid option, it reruns without `--output-format` and keeps the plain stdout.

**Reading the stream.** The documented sequence is: an Assistant message; when the model calls a tool, an Assistant message with `tool_calls`, then the Tool message, then further Assistant messages. The driver keeps only assistant-role messages. The result is the last assistant message without `tool_calls` (else the last assistant text). Tool messages never reach the result, since they carry file dumps and command output. Lines without a role fall back to the older text-field reading; non-JSON stdout is kept whole.

**Failure contract.** The driver still honours an `error` event and a `result` event with `is_error`, but the Kimi docs document neither, nor any cost field. In practice failure rests on the exit code, and cost is reported as unavailable (`costUsd: null`).

**Resume.** `runKimi` generates or reuses a session id as a label only and does **not** pass `--session` yet, although Kimi has `-S/--session <id>`. `nrv revise` therefore starts a fresh Kimi session; continuity comes from `HANDOFF.json` and the files on disk.

**For a mention `@x`:** the adapter detects it in the returned handoff and opens a new sub-process for `x`.

**Parallel fan-out:** at the OS level (independent `kimi -p` sub-processes).

**Orca visible worker.** `orca-worker.ts` opens `kimi [-m <model>]` with no permission flag, so a visible Kimi worker stops at approval prompts.

---

## 8. Memory Storage

| Layer | Path | Persistence |
|---|---|---|
| Permanent (cross-session) | `~/.kimi-code/AGENTS.md`, `~/.agents/AGENTS.md` + custom files | Native load |
| Project | `<project>/AGENTS.md` or `.kimi-code/AGENTS.md` | Native load |
| Session | `~/.kimi-code/` session dir, `agents/main/wire.jsonl` | Native; automatic compaction |
| Business permanent | `~/businesses/<biz>/memory/permanent.md` | Adapter persists |
| Project (business) | `<project>/<biz>/<project_id>/memory/` | Isolation by construction |

> **Isolation guard:** Kimi does not isolate memory per project id. The adapter builds the prompt with ONLY the memory relevant to the `project_id`, otherwise `audit_event: isolation_violation`.

**Authentication.** Kimi does not read provider keys from the shell by default: "Except for the explicitly declared `api_key_env`, the CLI does not fall back to shell environment variables for credentials." Routes:

- **Kimi Code OAuth**: `/login` in the TUI, or `kimi login` (RFC 8628 device code, no flags; exit 0 on success). The token is stored locally and loaded on the next start. These accounts do not appear in `/provider`. The driver reports no cost for them.
- **`config.toml` providers**: `[providers.<id>]` with `type = "kimi"` (default `base_url` `https://api.moonshot.ai/v1`), Anthropic or OpenAI-compatible types, and `api_key` or `api_key_env` (exactly one). `kimi provider add <registry-url>` and `kimi provider catalog add <id> --api-key ...` write these entries non-interactively.
- **`KIMI_MODEL_*` env vars** synthesize a temporary in-memory provider (not persisted).

Migration: `kimi migrate` copies the legacy `~/.kimi/` config, MCP servers and sessions to `~/.kimi-code/`. OAuth credentials and MCP authorizations are not copied; run `/login` again.

---

## 9. Context Window & Compaction

- Window: per model entry (`max_context_size`). The docs' example declares `kimi-code/k3` at 1,048,576 tokens and `kimi-code/kimi-for-coding` at 262,144.
- Compaction: automatic when the remaining window falls below `[loop_control] reserved_context_size`; `compaction_max_attempts` (default 5) bounds retries.
- A brief above 100K tokens fits on `k3` without aggressive truncation.

---

## 10. Hook System

Kimi has hooks: `[[hooks]]` entries in `~/.kimi-code/config.toml` with exactly four fields, `event`, `matcher` (regex), `command`, `timeout` (1-600 s, default 30). The event JSON arrives on stdin (snake_case fields). Exit `0` allows, `2` blocks (stderr is the reason), anything else fails open, as do crashes and timeouts. Only `PreToolUse`, `Stop` and `UserPromptSubmit` can block.

| Desired hook | Kimi event |
|---|---|
| `PreToolUse` | `PreToolUse` (blocking; runs before permission checks) |
| `PostToolUse` | `PostToolUse` / `PostToolUseFailure` (observe only) |
| `UserPromptSubmit` | `UserPromptSubmit` (blocking; stdout is appended to context) |
| `Stop` | `Stop` (blocking; a block lets the model continue) |
| `SessionStart` | `SessionStart` (`startup` or `resume`) |
| `Compact` | `PreCompact` / `PostCompact` |

Fail-open means a hook is an alert and a light guard, never the only barrier. The engine does not install Kimi hooks yet, so the audit relies on the driver's jsonl.

---

## 11. Invocation Examples

### Example 1: Squad capability

```bash
# User: "transcrever vídeo do Instagram https://..."
kimi -p "You are instagram-intelligence. Analyze video: https://..." \
  --output-format stream-json -m kimi-code/k3 --add-dir "$PROJECT"
```

### Example 2: Business brief with handoff

```bash
# The business runs as ONE solo agent that plays the seats itself
kimi -p "<business persona + brief + JSON contract>" --output-format stream-json \
  -m kimi-code/k3 --add-dir "$PROJECT" --add-dir "$HOME/businesses/nexus" \
  > .handoffs/nexus-1.ndjson

# The answer is the last assistant line without tool_calls (§7); Tool lines are skipped
```

### Example 3: Harness escalation

```bash
# Wrapper detects budget_violation
echo '{"type":"human_escalation_required","trigger_id":"budget","severity":"high",...}' \
  > .harness/notifications/$(date +%s).json
# The harness orchestrator (in another runtime or interactive) consumes the file
```

---

## 12. Runtime-Specific Validators

- **Which line is installed**: `kimi --version` (`-V`). 2.x is the target; a legacy 1.x build loses `--add-dir` (the driver warns) and may lack `stream-json`.
- **Credential present**: OAuth login done, or a `[providers.<id>]` entry with `api_key`/`api_key_env`. `kimi doctor` validates `config.toml` and `tui.toml` without starting the TUI (exit 1 on an invalid file).
- **Resolvable model**: the cascade's `kimi-cli:<model>` has to be an alias in `config.toml` (`kimi provider list --json` prints the table).
- **Workspace trust**: since 2.1.0 project-local configuration applies only after the folder is trusted, and `-p` cannot show the prompt. Project `.kimi-code/mcp.json` servers stay off in headless runs unless the workspace is already trusted or `KIMI_CODE_TRUST_WORKSPACE=1` is set for the process. The engine does not set it.
- **Granted dirs**: none may resolve to home or `/` (2.1.0 rejects them).
- **Windows**: needs Git for Windows (Git Bash is Kimi's shell); set `KIMI_SHELL_PATH` when `bash.exe` sits in a custom location.

---

## 13. Known Limitations

1. **No session resume from the engine**: `--session <id>` exists but `runKimi` does not pass it; `nrv revise` starts fresh.
2. **Failure and cost contract unverified**: the docs show no `result`/`error` event and no cost field, so failure detection is the exit code and cost is unavailable. Pin the real event fields with one `kimi -p ... --output-format stream-json` run once the CLI is installed.
3. **Stream field names inferred**: the driver reads `role` (top level or under `message`), `content` and `tool_calls`; the docs describe the sequence, not the JSON keys.
4. **No tool whitelist from the engine**: `-p` runs under `auto` permission with every tool; config `[tools]`/permission rules or an agent file would enforce one.
5. **Sub-agents not disabled**: a `-p` worker can open `Agent`/`AgentSwarm` children that never pass the engine's depth counter.
6. **No effort, max-turns or budget flags**: config and env only (§6); the engine's profiles do not reach Kimi.
7. **Background tasks extend print mode**: a pending background task keeps `kimi -p` alive until the engine's timeout.
8. **Trust gate in headless runs**: project MCP servers and project-local config stay off unless the workspace is trusted.
9. **Two binaries named `kimi`**: the legacy Python line may reject `--add-dir` and `stream-json`; the driver degrades with a warning.
10. **Orca visible worker has no autonomy flag**: it stops at approval prompts (`--auto` exists for interactive runs, not added yet).
11. **Hooks not wired to the audit**: Kimi's `[[hooks]]` could feed the audit script like claude/codex/gemini; not done.

**Compensating advantage:** a 1M-token model, native sub-agents, hooks and MCP, and an OAuth route with no per-token bill for the engine to track.

---

## 14. Source References

- Kimi Code CLI: repo `MoonshotAI/kimi-code`, docs at `https://moonshotai.github.io/kimi-code/en/`: `reference/kimi-command`, `customization/{skills,hooks,mcp,agents}`, `configuration/{config-files,providers,env-vars,data-locations}`, `guides/{getting-started,migration,sessions}`, `release-notes/changelog` (2.1.1, 2026-09-24).
- Install: `curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash`, Windows `irm https://code.kimi.com/kimi-code/install.ps1 | iex`, or `npm install -g @moonshot-ai/kimi-code` (Node 22.19.0+).
- Legacy line: `https://pypi.org/project/kimi-cli/` (1.52.0).
- Moonshot API: `https://api.moonshot.ai/v1`.
- Driver: `skills/_shared/lib/host-agent-driver.ts` (`runKimi`, adapter `kimi-cli`, `RUNTIME_DIR_GRANT_FLAG`); Orca worker: `skills/_shared/lib/orca-worker.ts`.
- Squad Protocol v6: `~/.nirvana/skills/squads/SQUAD_PROTOCOL_V6.md`
- Business Protocol v2: `~/.nirvana/skills/businesses/BUSINESS_PROTOCOL_V2.md`
- Harness protocol: `~/.nirvana/skills/harness/SKILL.md`

---

## 15. Version History

| Version | Date | Changes |
|---|---|---|
| 1.0.0 | 2026-07-19 | Initial doc: covers Squad 5.0 + Business 1.0 + Harness 1.0 against Kimi Code CLI (`MoonshotAI/kimi-code`), K3 / kimi-for-coding. Dispatch via `kimi -p` (sub-process, NDJSON→text). |
| 2.0.0 | 2026-10-11 | Rewritten for Kimi Code 2.x from the official docs. Two product lines (Node `@moonshot-ai/kimi-code` 2.1.1 with `~/.kimi-code`, legacy Python `kimi-cli` 1.52 with `~/.kimi`, both install `kimi`). Driver argv now carries `--add-dir` grants (retried without on a build that rejects it); the stream parser keeps only assistant messages. Documented `-p` = auto permission (rejects `--yolo`/`--auto`/`--plan`), 2.1.0 workspace trust, skill roots, `[[hooks]]`, `mcp.json`, native sub-agents, and that the engine does not pass `--session`. Removed `--mcp-config-file`, the unverified K3 and quota figures, and the claims of no hooks and no sub-agents. |
