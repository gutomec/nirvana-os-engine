# Runtime Adapters

> Each doc describes how Squad v5 + Business v2 + Harness v1 map to a concrete runtime.
> Canonical structure in 15 sections (Squad v4 §18.5). Mandatory minimum: 1, 2, 3, 6, 11, 13.

## Available adapters

| Runtime | Vendor | Doc | Status |
|---|---|---|---|
| `claude-code` | Anthropic | [`claude-code.md`](./claude-code.md) | Reference (all 15 sections) |
| `codex` | OpenAI | [`codex.md`](./codex.md) | Stable (15 sections, gaps in hooks/scheduled) |
| `antigravity-cli` | Google | [`antigravity-cli.md`](./antigravity-cli.md) | Unverified: complete docs (15 sections), but the driver flags were NEVER confirmed against the real `agy` binary (§13). Treat as experimental until an authenticated `agy --help` confirms. |
| `gemini-cli` | Google | [`gemini-cli.md`](./gemini-cli.md) | Legacy: sunset 2026-06-18 (15 sections, gaps in hooks/event_bus/teammate) |
| `hermes` | Hermes Agent | [`hermes.md`](./hermes.md) | Stable (15 sections; dispatch via `hermes -z`, ceiling = Codex) |
| `kimi-cli` | Moonshot AI | [`kimi-cli.md`](./kimi-cli.md) | New: code (`runKimi`) + complete docs; invocation (`kimi -m <model> -p … --output-format stream-json`) NOT verified against the real `kimi` binary. Free via Kimi.com OAuth (K3/K2.7); paid via `~/.kimi-code/config.toml`. |
| `grok-cli` | xAI | [`grok-cli.md`](./grok-cli.md) | Invocation (`grok -p … --output-format json --always-approve --cwd`) VERIFIED against the real binary (`grok 0.2.103`): flags accepted, JSON returned with `text`/`sessionId`/`total_cost_usd`. Agentic coding + native media generation (image/i2v). Subscription or xAI API (`XAI_API_KEY`). |
| `pi` | Earendil (pi.dev) | [`pi.md`](./pi.md) | Invocation (`pi -p --mode json --session-id <uuid> --append-system-prompt …`) **VERIFIED against the real binary (`pi 0.82.1`)**: JSONL event stream confirmed, deterministic session, provider error detected in the stream (pi exits 0 even on error, §13). ONE runtime → 15+ providers (Anthropic, OpenAI, Google, OpenRouter…) **including LOCAL models** (Ollama, llama.cpp, LM Studio, vLLM via `models.json`). Native resume/fork; the cascade's `@provider` becomes a real `--provider`. |
| `orca` (host) | Orca (orca.dev) | [`orca.md`](./orca.md) | **Host, not a runtime.** Inside an Orca terminal the engine stamps the audit with the workspace, projects each run onto the card (comment and column), opens Glance in the embedded browser and runs each headless dispatch as a worker terminal (Orca orchestration), falling back to the child process. Outside Orca nothing changes; a fake `orca` in the tests proves nothing is called. Measured on Orca 1.4.198 (2026-09-09). ADR-009. |

## Quick comparison (cross matrix)

| Feature | claude-code | codex | antigravity-cli | gemini-cli | hermes | Notes |
|---|---|---|---|---|---|---|
| `max_turns` per-employee | ~ (via hook, no hard limit) | ~ (global CLI flag) | ~ (global CLI flag) | ~ (global CLI flag) | ~ (global profile) | No runtime has a native hard max_turns. On all of them it is a workaround; nested invocations escape outside Claude Code. |
| `tool_whitelist` | ✓ | ✓ | ✓ | ✓ | ✓ (`-t/--toolsets`) | All support it. |
| `subagent_spawning` (in-process) | ✓ Agent tool (native, in-process) | ✓ native `[agents]` | ✓ native dynamic | ~ sub-process (legacy) | ~ sub-process (`hermes -z`, single-level) | claude/codex/antigravity are natively in-process; gemini (legacy) and hermes via sub-process. |
| `audit_trail` | ✓ | ✓ | ✓ | ~ | ~ (hooks + fs-watch) | Gemini/Hermes via shell hooks. |
| `scheduled_invocation` | ✓ ScheduleWakeup | ✗ | ✗ | ✗ | ✓ `hermes cron` | Hermes has native cron (an advantage over codex/gemini/antigravity). |
| `event_bus` | ~ | ~ | ~ | ~ | ~ | None has a broker; file-system plus memory. |
| `hooks` | ✓ | ~ | ~ | ✗ | ~ (`pre/post_tool_call`) | Claude Code is granular; Hermes is shell-based and consent-gated. |
| `sandboxing` | ~ permissions | ✓ profiles | ~ approval modes | ~ container | ✓ 6 backends + Tirith | Codex/Hermes are richer. |
| `session_memory` | ✓ | ✓ | ✓ | ✓ | ✓ | All. |
| `project_memory` | ✓ CLAUDE.md | ✓ AGENTS.md | ✓ AGENTS.md | ✓ GEMINI.md | ✓ AGENTS.md | Similar convention. |
| `global_memory` rich | ✓ | ~ | ~ | ~ | ✓ SOUL+SQLite+Honcho | Claude Code and Hermes have rich global memory. |
| `handoff_artifacts` | ✓ | ✓ | ✓ | ✓ | ✓ (text→JSON) | JSON in tool_result or file. |
| `teammate_primitive` | ~ TeamCreate (deferred) | ✗ | ~ Managed Agents | ✗ | ~ delegation (single-level) | Antigravity has Managed Agents for long runs; Hermes has native 1-level delegation. |
| `telemetry_otel` | ✓ | ~ | ~ | ~ | ~ | The others via an external SDK. |
| `messaging_escalation` | ~ | ~ | ~ | ~ | ✓ Slack/Telegram/WhatsApp | Hermes wins on human escalation. |
| Context window | 200K | 128K to 200K | 1M (2M on the roadmap) | 1M (2M on the roadmap) | depends on the provider | Hermes routes to the profile's provider. |

> Extra rows outside the canonical feature matrix of Business v2 §6.5 (they are not part of the `features_required` enum but become the criterion for choosing a runtime):
>
> - **MCP servers**: claude-code ✓ (stable), codex ~ (partial), antigravity-cli ✓ (native), gemini-cli ✓ (experimental, legacy), hermes ✓ (native).
> - **Context window**: see the row above.

## When to use which

- **`claude-code`**: main production: every primitive and hook supported natively. Recommended for long-running businesses with escalation, mind-clones and rich auditing.
- **`codex`**: when strong sandboxing is the priority (workspace-write/read-only/danger-full-access) and usage is dominated by code-related capabilities. Trade-off: no granular hooks, no ScheduleWakeup.
- **`antigravity-cli`**: successor to gemini-cli (from 2026-06-18) for the Google consumer tier. Same large window (1M+), native in-process dynamic subagents and Managed Agents for long runs. **NOT verified against the real binary**: the driver flags (approval-mode, etc.) are based on research, not on an authenticated `agy --help` (§13). Use only if `agy` is installed and you confirm the flag surface; it is not preferred by default.
- **`gemini-cli`**: **legacy, sunset 2026-06-18.** When the brief consumes >100K tokens of context (large code analysis, extensive document review) and the install has not migrated yet. Trade-off: experimental agent system, no hooks, limited audit. Migrate to `antigravity-cli`.
- **`hermes`**: when the user already runs Hermes Agent and wants businesses/squads/mind-clones there: query (`nrv list/inspect/search/ask`) with no degradation, deterministic dispatch (`nrv dispatch`) and in-runtime orchestration via `hermes -z` (ceiling = Codex). Advantages: `hermes cron` (scheduled) and escalation via Slack/Telegram. Trade-off: dispatch is text→JSON (no `--output-format json`), shell hooks are consent-gated.
- **`pi`**: when you want ONE runtime with access to 15+ providers (API keys or OAuth of Claude/ChatGPT/Copilot subscriptions) and to **local models** (Ollama, llama.cpp, LM Studio, vLLM): privacy-sensitive briefs running 100% offline, a $0/token cost fallback on your own hardware, or a provider that no official CLI covers. Native resume (`--session`) and session fork; skills in the Agent Skills standard (reads `~/.pi/agent/skills`; `nrv install` symlinks the Nirvana tree there). Trade-off: no native MCP, no built-in subagents, no shell hooks (TypeScript extensions cover it), and the exit code does not signal a provider error (the driver detects it from the stream).

### Automatic routing by USE_* rules

Instead of deciding by hand on every dispatch, the user declares the rules in natural language in the project's `.env` (or in `~/.claude/.env`):

```dotenv
USE_CODEX="Quando precisar gerar imagens ou refinar visuais"
USE_ANTIGRAVITY="Quando for fazer deep research na internet"
USE_GEMINI="Quando o contexto for gigante (1M tokens)"
NOT_USE_GEMINI="Quando for análise de codebase"   # veto: beats the positive rule
USE_HERMES="Quando precisar interagir com o usuário via mensageria"
USE_PI="Quando precisar de modelos locais (Ollama/llama.cpp) ou de um provider fora dos CLIs oficiais"
```

`nrv dispatch --exec` picks the runtime preferred by the rule that matches the brief (zero-token BM25 in `fast` mode; in `agentic` mode the rules go verbatim into the router's and the maestro's prompt, and the maestro also respects them when delegating sub-tasks). An explicit flag (`--exec=<rt>`/`--runtime`) always wins; with no match, it stays on the runtime the user is already using. Quota resilience stays in `LLM_CASCADE`. Details: `project-skeleton/.env.example`.

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
