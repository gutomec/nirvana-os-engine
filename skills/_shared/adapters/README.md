# Runtime Adapters

> Each doc describes how Squad v5 + Business v2 + Harness v1 map to a concrete runtime.
> Canonical structure in 15 sections (Squad v4 §18.5). Mandatory minimum: 1, 2, 3, 6, 11, 13.

## Available adapters

| Runtime | Vendor | Doc | Status |
|---|---|---|---|
| `claude-code` | Anthropic | [`claude-code.md`](./claude-code.md) | Reference (all 15 sections) |
| `codex` | OpenAI | [`codex.md`](./codex.md) | Stable. `codex exec` argv verified against 0.159.2 help and the 0.162.1 source (2026-10-11); hooks with trust, skills in `~/.agents/skills`, TOML custom agents. |
| `antigravity-cli` | Google | [`antigravity-cli.md`](./antigravity-cli.md) | Flags verified against `agy --help` 1.3.3 (2026-10-11): `--input-format stream-json --output-format stream-json [--conversation <id> \| --continue] --dangerously-skip-permissions --add-dir … -p=`, the prompt as one stream-json event on stdin. One spawn per turn: a mid-turn model error exits 3 with `AGY_ERROR`. |
| `hermes` | Hermes Agent | [`hermes.md`](./hermes.md) | Stable (15 sections; dispatch via `hermes -z`, ceiling = Codex) |
| `kimi-cli` | Moonshot AI | [`kimi-cli.md`](./kimi-cli.md) | Invocation (`kimi -p … --output-format stream-json -m <model> --add-dir <d>`) from the official Kimi Code 2.x reference (2026-10-11); not run against a local binary. Only assistant messages make the result. Free via Kimi.com OAuth; paid via `~/.kimi-code/config.toml`. |
| `grok-cli` | xAI | [`grok-cli.md`](./grok-cli.md) | Invocation (`grok --prompt-file <f> --output-format json --cwd <d> [-r <id>] --always-approve --trust`) checked against `grok --help` 1.0.44 (2026-10-11). Folder trust gates project AGENTS.md, skills and MCP; resume is `-r`. Subscription or xAI API (`XAI_API_KEY`). |
| `pi` | Earendil (pi.dev) | [`pi.md`](./pi.md) | Invocation (`pi -p --mode json --session-id <uuid> --append-system-prompt … -- <prompt>`) checked against `pi --help` 0.84.3; 1.x changes from the official changelog (2026-10-11). The provider error arrives in the stream (pi exits 0 even on error, §13). ONE runtime for many providers, **including LOCAL models** (Ollama, llama.cpp, LM Studio, vLLM). The cascade's `@provider` becomes `--provider`, passed only together with `--model` (pi 1.0.0 rejects it alone). |
| `orca` (host) | Orca (orca.dev) | [`orca.md`](./orca.md) | **Host, not a runtime.** Inside an Orca terminal the engine stamps the audit with the workspace, projects each run onto the card (comment and column), opens Glance in the embedded browser and, with `execution.orca_workers: on` (default `off`), runs each headless dispatch as a worker terminal (Orca orchestration), falling back to the child process. Outside Orca nothing changes; a fake `orca` in the tests proves nothing is called. Measured on Orca 1.4.198 (2026-09-09). ADR-009. |

## Quick comparison (cross matrix)

| Feature | claude-code | codex | antigravity-cli | hermes | Notes |
|---|---|---|---|---|---|
| `max_turns` per-employee | ✓ (`--max-turns`, subagent `maxTurns`) | ✗ (no turn cap on `codex exec`) | ✗ (no turn flag) | ~ (global profile) | The engine passes no turn cap to any runtime today. |
| `tool_whitelist` | ✓ | ✓ | ✓ | ✓ (`-t/--toolsets`) | All support it. |
| `subagent_spawning` (in-process) | ✓ Agent tool (native, in-process) | ✓ native `[agents]` | ✓ native dynamic | ~ sub-process (`hermes -z`, single-level) | claude/codex/antigravity are natively in-process; hermes via sub-process. |
| `audit_trail` | ✓ | ✓ | ✓ | ~ (hooks + fs-watch) | Hermes via shell hooks. |
| `scheduled_invocation` | ✓ ScheduleWakeup | ✗ | ✗ | ✓ `hermes cron` | Hermes has native cron (an advantage over codex/antigravity). |
| `event_bus` | ~ | ~ | ~ | ~ | None has a broker; file-system plus memory. |
| `hooks` | ✓ | ✓ (trusted by hash) | ✓ (`hooks.json`, five events) | ~ (`pre/post_tool_call`) | Codex hooks need trust; agy's `PreInvocation` runs before every model call; Hermes is shell-based and consent-gated. |
| `sandboxing` | ~ permissions | ✓ profiles | ~ approval modes | ✓ 6 backends + Tirith | Codex/Hermes are richer. |
| `session_memory` | ✓ | ✓ | ✓ | ✓ | All. |
| `project_memory` | ✓ CLAUDE.md | ✓ AGENTS.md | ✓ AGENTS.md | ✓ AGENTS.md | Similar convention. |
| `global_memory` rich | ✓ | ~ | ~ | ✓ SOUL+SQLite+Honcho | Claude Code and Hermes have rich global memory. |
| `handoff_artifacts` | ✓ | ✓ | ✓ | ✓ (text→JSON) | JSON in tool_result or file. |
| `teammate_primitive` | ~ TeamCreate (deferred) | ✗ | ~ Managed Agents | ~ delegation (single-level) | Antigravity has Managed Agents for long runs; Hermes has native 1-level delegation. |
| `telemetry_otel` | ✓ | ~ | ~ | ~ | The others via an external SDK. |
| `messaging_escalation` | ~ | ~ | ~ | ✓ Slack/Telegram/WhatsApp | Hermes wins on human escalation. |
| Context window | 200K | 128K to 200K | 1M (2M on the roadmap) | depends on the provider | Hermes routes to the profile's provider. |

> Extra rows outside the canonical feature matrix of Business v2 §6.5 (they are not part of the `features_required` enum but become the criterion for choosing a runtime):
>
> - **MCP servers**: claude-code ✓ (stable), codex ~ (partial), antigravity-cli ✓ (native), hermes ✓ (native).
> - **Context window**: see the row above.

## When to use which

- **`claude-code`**: main production: every primitive and hook supported natively. Recommended for long-running businesses with escalation, mind-clones and rich auditing.
- **`codex`**: when strong sandboxing is the priority (workspace-write/read-only/danger-full-access) and usage is dominated by code-related capabilities. Trade-off: no per-run turn cap, no ScheduleWakeup.
- **`antigravity-cli`**: Google's agent CLI (Gemini models), and the way to reach them now that the Gemini CLI is no longer a runtime. Large window, project subagents (`.agents/agents/`, `--agent`) and plugins. The driver's flags are checked against `agy --help` 1.3.3. It is not preferred by default.
- **`gemini-cli`**: no longer a runtime. A setting, rule or cascade entry that still names it is skipped with "Gemini CLI is no longer supported; pick another runtime". Use `antigravity-cli` for Gemini models.
- **`hermes`**: when the user already runs Hermes Agent and wants businesses/squads/mind-clones there: query (`nrv list/inspect/search/ask`) with no degradation, deterministic dispatch (`nrv dispatch`) and in-runtime orchestration via `hermes -z` (ceiling = Codex). Advantages: `hermes cron` (scheduled) and escalation via Slack/Telegram. Trade-off: dispatch is text→JSON (no `--output-format json`), shell hooks are consent-gated.
- **`pi`**: when you want ONE runtime with access to 15+ providers (API keys or OAuth of Claude/ChatGPT/Copilot subscriptions) and to **local models** (Ollama, llama.cpp, LM Studio, vLLM): privacy-sensitive briefs running 100% offline, a $0/token cost fallback on your own hardware, or a provider that no official CLI covers. Native resume (`--session`) and session fork; skills in the Agent Skills standard (reads `~/.pi/agent/skills`; `nrv install` symlinks the Nirvana tree there). MCP is built in since 0.99. Trade-off: no built-in subagents, no shell hooks (TypeScript extensions cover it), and the exit code does not signal a provider error (the driver detects it from the stream).

### Automatic routing by USE_* rules

Instead of deciding by hand on every dispatch, the user declares the rules in natural language in the project's `.env` (or in `~/.claude/.env`):

```dotenv
USE_CODEX="Quando precisar gerar imagens ou refinar visuais"
USE_ANTIGRAVITY="Quando for fazer deep research na internet"
NOT_USE_ANTIGRAVITY="Quando for análise de codebase"   # veto: beats the positive rule
USE_HERMES="Quando precisar interagir com o usuário via mensageria"
USE_PI="Quando precisar de modelos locais (Ollama/llama.cpp) ou de um provider fora dos CLIs oficiais"
```

`nrv dispatch --exec` picks the runtime preferred by the rule that matches the brief (a zero-token BM25 match of the brief against the rules; the rules also go verbatim into the agentic router's and the maestro's prompt, and the maestro respects them when delegating sub-tasks). An explicit flag (`--exec=<rt>`/`--runtime`) always wins; with no match, it stays on the runtime the user is already using. Quota resilience stays in `LLM_CASCADE`. Details: `project-skeleton/.env.example`.

## For adapter implementers

Each doc follows 15 canonical sections (Squad v4 §18.5):

1. Adapter Metadata
2. Feature Support Matrix
3. Concept Mapping
4. Frontmatter Mapping
5. Tool Whitelist Mechanics
6. Max-Turns Mechanics
7. Subagent Spawning
8. Memory Storage
9. Context Window & Compaction
10. Hook System
11. Invocation Examples
12. Runtime-Specific Validators
13. Known Limitations
14. Source References
15. Version History

Minimum for an adapter to be considered v1: §§1, 2, 3, 6, 11, 13.
