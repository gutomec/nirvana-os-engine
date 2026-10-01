# Adapter · Kimi Code CLI (Moonshot Kimi Code)

> Runtime adapter for Squad Protocol v6 + Business Protocol v2 + Harness Protocol v1.
> Covers the 3 protocols in a single doc. Canonical sections per Squad Protocol v6 §18.5.
> System identity + capabilities (what Nirvana-OS is and can do): see `../NIRVANA-OS.md` (single source).
> Mirrors `codex.md` (sub-process dispatch, no per-file agent profile).

---

## 1. Adapter Metadata

| Field | Value |
|---|---|
| `runtime` | `kimi-cli` |
| `vendor` | Moonshot AI |
| `min_version` | Kimi Code CLI (repo `MoonshotAI/kimi-code`, TypeScript): version not pinned yet; `--output-format stream-json` required, with a fallback for old builds (§7) |
| `default_model` | inherited from the runtime. The engine NEVER sets a model; it comes from the `kimi-cli:<model>` entry of `LLM_CASCADE`. Pass a model only when the user explicitly asks. |
| `tested_against` | Kimi K3 (top tier, MoE ~2.8T, 1M context, agentic/coding, released 2026-07-16) and `kimi-for-coding` (K2.7) |
| `config_paths` | `~/.kimi-code/config.toml`, `<project>/AGENTS.md` |
| `skills_root` | Installs skills/MCP from GitHub repos; compatible with the universal dir `<project>/.agents/skills/` (already in the engine's truth table) |
| `agents_root` | No per-file agent profile (like Codex `~/.codex/agents/`); the persona goes in the `kimi -p` prompt (see §7) |
| `memory_root` | `<project>/AGENTS.md` (project); Kimi has no rich native cross-session memory |
| `audit_log` | `~/.harness-logs/` (jsonl via the driver); Kimi does not expose a documented canonical transcript store |
| `protocol_versions` | Squad 5.0, Business 1.0, Harness 1.0 (with gaps recorded in §13) |

---

## 2. Feature Support Matrix

`✓` = native · `~` = workaround/partial · `✗` = not supported

| Feature (Business v2 §6.5) | Squad v6 | Business v2 | Harness v1 | Notes |
|---|---|---|---|---|
| `max_turns` | ~ | ~ | ~ | No confirmed per-employee flag; the adapter simulates via a wrapper (sub-process timeout + count in the handoff) |
| `tool_whitelist` | ~ | ~ | ~ | Kimi is agentic-coding-first; no confirmed `--allowedTools`. Whitelist via persona in the prompt + gate in the wrapper |
| `subagent_spawning` | ✗ | ✗ | ✗ | Native subagents NOT confirmed. Fallback = sequential execution of the workflow steps; `kimi -p` sub-process for OS-level fan-out |
| `audit_trail` | ~ | ~ | ~ | No documented transcript store; the harness adds jsonl via `runKimi` |
| `scheduled_invocation` | ✗ | ✗ | ✗ | No `ScheduleWakeup`/`CronCreate`: degrade to external cron |
| `event_bus` | ~ | ~ | ~ | Mentions/tickets via file-system; no broker |
| `hooks` | ~ | ~ | ~ | No confirmed granular hook system; complex validation in a wrapper |
| `sandboxing` | ~ | ~ | ~ | No documented sandbox profiles like Codex's; isolate via cwd + OS permissions |
| `session_memory` | ✓ | ✓ | ✓ | Per-session context (1M window on K3) |
| `project_memory` | ✓ | ✓ | ✓ | `AGENTS.md` in the project (convention shared with Codex/Antigravity) |
| `global_memory` | ~ | ~ | ~ | No rich auto-discovery like `~/.claude/memory/` |
| `handoff_artifacts` | ✓ | ✓ | ✓ | JSON extracted from stdout (`stream-json` NDJSON, or plain text in the fallback) |
| `fork_context` | ~ | ~ | ~ | Sub-process spawn creates a fork; no strong isolation |
| `teammate_primitive` | ✗ | ✗ | ✗ | No `TeamCreate`; a team is a convention via the file system |
| `telemetry_otel` | ~ | ~ | ~ | OTel via an external OpenTelemetry SDK (not built-in) |
| `mcp` | ✓ | ✓ | ✓ | Native MCP via `--mcp-config-file`; installs MCP/skills from GitHub repos |

> **Note outside the canonical matrix:** Kimi's big differentiator is the pair of **1M context + open-weight models** (K3 with open weights promised for ~2026-07-27) and the **free OAuth route** (§8/§13), not new orchestration primitives.

---

## 3. Concept Mapping

| Concept (Protocol) | Kimi Code equivalent | Implementation |
|---|---|---|
| Squad / Business | Skills directory + AGENTS.md | `<project>/.agents/skills/<name>/` + the CWD's `AGENTS.md` |
| Capability | Workflow file | `<skill>/capabilities/<id>.md` invoked by a wrapper |
| Employee (seat) | Persona embedded in the `kimi -p` prompt | A business runs as ONE solo agent (`skills/harness/lib/business-solo.ts`) that plays the seats itself; core persona + DNA in the prompt body; not an agent file as in Codex |
| `is_brief_intake: true` | Default persona when the skill is active | Built in the prompt / the skill's `AGENTS.md` |
| `is_antagonist: true` | Sub-process invoked in a pipeline | `kimi -m <model> -p "<persona+brief>" --output-format stream-json` |
| Handoff artifact | JSON on stdout (NDJSON) + file | Persisted in `<project>/.handoffs/` |
| Mention `@employee` | Convention in the handoff | The adapter detects it → new sub-process |
| Ticket | Persisted file | `<project>/.tickets/<TICKET_ID>.json` |
| Escalation trigger | Wrapper script + harness call | The wrapper checks the condition → emits a notification to the harness |
| Permanent memory | `<project>/AGENTS.md` + custom files | No rich global auto-load |
| Project memory | `<project>/AGENTS.md` | Convention (load depends on the version) |
| Session memory | Conversation transcript | Compacted / the 1M window reduces pressure |
| Routing decision (harness) | Pre-spawn lookup table | BM25 over `capabilities[].examples[]` in a Bun/Node wrapper |

---

## 4. Frontmatter Mapping

### Squad v6 / Business v2 → AGENTS.md

Kimi has no rich frontmatter in the skill head. The adapter generates two files (same tactic as Codex/Antigravity):

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

Kimi has no per-file agent profile. The employee persona is assembled in the prompt:

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

---

## 5. Tool Whitelist Mechanics

- Kimi is agentic-coding-first and uses internal function-calling; **there is no confirmed `--allowedTools` flag**. The whitelist is applied in two ways:
  - **Persona in the prompt**: explicitly declare the allowed tools ("## Allowed tools") and forbid the rest.
  - **Gate in the wrapper**: the wrapper runs with a restricted cwd and OS permissions; commands outside the brief's scope are blocked outside the runtime.
- Semantic tools → Kimi intent mapping:
  - `read` → file read
  - `write` / `edit` → file write/edit
  - `bash` → command execution
  - `web_fetch` → URL fetch
- MCP servers (native, via `--mcp-config-file`) appear as additional tools; include/exclude by the `mcp__<server>__` prefix.

---

## 6. Max-Turns Mechanics

Kimi **does not** expose a confirmed per-employee `--max-turns`. The adapter simulates it like this:

1. Each employee runs as a `kimi -p` sub-process, with the wrapper's `timeout` (`opts.timeoutMs` → `spawnSync`).
2. The logical turn count comes from the handoff (the employee reports the steps executed).
3. Timeout overrun → the sub-process ends; the wrapper records `audit_event: budget_violation`.

**Limitation:** no fine per-turn counting from the runtime. Documented as `~` (partial). Flat employees are recommended (no nested invocation inside a single `-p`).

---

## 7. Subagent Spawning

**No confirmed subagent primitive.** Unlike Codex (`[agents]` blocks) and Antigravity (in-process dynamic subagents), Kimi **has no** native subagents confirmed in the research. The path is always a `kimi -p` **sub-process** (`host-agent-driver.runKimi`):

```bash
# Adapter spawn (host-agent-driver.runKimi)
kimi -m <model> -p "Review this offer: ..." \
  --output-format stream-json \
  > .handoffs/alex-hormozi-$(date +%s).ndjson
```

Real flags used by the driver:
- `-p "<prompt>"`: one-shot headless prompt (no TUI).
- `-m/--model <id>`: selects the model (e.g. `k3` = Kimi K3; `kimi-for-coding` = K2.7). It comes only from the `kimi-cli:<model>` cascade entry, never hardcoded.
- `--output-format stream-json`: NDJSON (1 object per line); accumulated answer on stdout, progress on stderr. **Old builds may lack the flag** → the driver detects the error (`output-format|unknown|unrecognized|invalid option`) and **re-runs without it** (stdout then carries the assistant's plain text).

The driver defensively extracts the assistant's final text from the NDJSON events (schema varies by build); if stdout is not NDJSON (fallback path), it keeps the whole stdout. It returns a handoff artifact that the adapter parses and records in the audit log.

> **No `--resume`.** `runKimi` generates its own `sessionId` and does **not** pass a native resume flag. Context continuation goes through `HANDOFF.json` + a new sub-process (see `agent-x.kimi.md` §4), not through a persisted runtime session.

**For a mention `@x`:** the adapter detects it in the returned handoff and opens a new sub-process for `x`.

**Parallel fan-out:** simulated at the OS level (the harness fires independent `kimi -p` sub-processes for independent steps), not inside Kimi.

---

## 8. Memory Storage

| Layer | Path | Persistence |
|---|---|---|
| Permanent (cross-session) | `<project>/AGENTS.md` + custom files | Manual |
| Project | `<project>/AGENTS.md` | Convention (load depends on the version) |
| Session | Conversation transcript | Compacted; the 1M window reduces pressure |
| Business permanent | `~/businesses/<biz>/memory/permanent.md` | Adapter persists |
| Project (business) | `<project>/<biz>/<project_id>/memory/` | Isolation by construction |

> **Isolation guard:** Kimi does not enforce memory isolation natively. The adapter builds the prompt with ONLY the memory relevant to the `project_id` before spawning, otherwise `audit_event: isolation_violation`.

**Authentication (not a shell env var).** Kimi **does not read** `MOONSHOT_API_KEY`/shell env automatically. The credential comes from one of two routes:

- **Free OAuth**: `kimi` → `/login` with a Kimi.com account (no API key). A **free, agentic** route; tracked cost = **$0** (the driver reports `costUsd: null`, like gemini/agy). Quota: rolling ~5h window, ~300-1200 calls; check `/usage`.
- **`~/.kimi-code/config.toml` (paid)**: a `[providers.<id>] type="openai" base_url=... api_key=...` block pointing to Moonshot (`https://api.moonshot.ai/v1`, key `MOONSHOT_API_KEY`) or OpenRouter. Cost = the provider's pay-per-token.

---

## 9. Context Window & Compaction

- Window: **1M tokens** (Kimi K3), larger than Claude/Codex, comparable to Gemini/Antigravity.
- Compaction: the large window reduces compaction pressure in long-running businesses.
- **Advantage:** a brief that consumes >100K tokens (large code analysis, extensive document review) runs without aggressive truncation.

---

## 10. Hook System

Kimi has no confirmed granular hooks. Workarounds in a wrapper:

| Desired hook | Kimi workaround |
|---|---|
| `PreToolUse` | Persona in the prompt acts as a soft validator; hard validation in a wrapper |
| `PostToolUse` | The wrapper parses the handoff / stdout after the run |
| `UserPromptSubmit` | The adapter injects instructions into the `kimi -p` prompt |
| `Stop` | The wrapper inspects the exit code and the final output |
| `SessionStart` | The wrapper loads memory before invoking `kimi -p` |
| `Compact` | No confirmed flag; the 1M window mitigates |

---

## 11. Invocation Examples

### Example 1: Squad capability

```bash
# User: "transcrever vídeo do Instagram https://..."
# Harness wrapper:
kimi -m <model> -p "You are instagram-intelligence. Analyze video: https://..." \
  --output-format stream-json
```

### Example 2: Business brief with handoff

```bash
# The business runs as ONE solo agent that plays the seats itself
kimi -m <model> -p "<business persona + brief + JSON contract>" --output-format stream-json \
  > .handoffs/nexus-1.ndjson

# A stand-alone sub-process (optional) is only spawned for an explicit mention `@alex-hormozi`
kimi -m <model> -p "<persona alex + DNA + context + JSON contract>" --output-format stream-json \
  > .handoffs/alex-1.ndjson
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

- **Credential present**: OAuth (`kimi` logged in) OR `[providers.<id>]` in `~/.kimi-code/config.toml`. With neither, dispatch fails; the wrapper checks before spawning.
- **Resolvable model**: the cascade's `kimi-cli:<model>` has to exist (e.g. `k3`, `kimi-for-coding`); the wrapper validates against the provider catalog.
- **MCP server reachability**: if the persona references `mcp__<server>__*`, validate that the server is in the `--mcp-config-file`.
- **AGENTS.md loaded**: the wrapper ensures `AGENTS.md`/manifest is injected into the prompt (Kimi does not do rich auto-discovery).

---

## 13. Known Limitations

1. **No subagent primitive** → the adapter uses a `kimi -p` sub-process. Cost: each spawn pays cold start overhead; fan-out stays in the wrapper.
2. **No granular hooks** → validation in an external wrapper, not inline.
3. **No `ScheduleWakeup` / `CronCreate`** → the harness degrades to external cron.
4. **No rich cross-session memory** → the adapter keeps memory in files and builds the prompt manually.
5. **Per-employee max-turns is simulated** (timeout + count in the handoff) → assumes flat employees.
6. **No `TeamCreate`** → teams are a file-system convention.
7. **OTel is not built-in** → the adapter integrates with an external OpenTelemetry SDK.
8. **`--output-format stream-json` may be missing** in old builds → the driver re-runs in plain text (parse of the whole stdout).
9. **Auth does not come from a shell env var** → OAuth (`/login`) or `config.toml`; the wrapper validates before dispatch.
10. **The tool whitelist is not hard-enforced** by the runtime → depends on the persona in the prompt + the wrapper gate.
11. **Recent/unstable flag surface** (repo `MoonshotAI/kimi-code`) → test `kimi --help` against the installed version before each bump.

**Compensating advantage:** 1M window + open-weight models (K3, open weights ~2026-07-27) + a free OAuth route ($0 tracked). A good fit for huge-context briefs with no per-token cost.

---

## 14. Source References

- Kimi Code CLI: repo `MoonshotAI/kimi-code` (TypeScript); install `curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash` (or global npm).
- Moonshot API: `https://api.moonshot.ai/v1` (key `MOONSHOT_API_KEY`).
- Driver: `skills/harness/lib/host-agent-driver.ts` (`runKimi`).
- Squad Protocol v6: `~/.nirvana/skills/squads/SQUAD_PROTOCOL_V6.md`
- Business Protocol v2: `~/.nirvana/skills/businesses/BUSINESS_PROTOCOL_V2.md`
- Harness protocol: `~/.nirvana/skills/harness/SKILL.md`

---

## 15. Version History

| Version | Date | Changes |
|---|---|---|
| 1.0.0 | 2026-07-19 | Initial doc: covers Squad 5.0 + Business 1.0 + Harness 1.0 against Kimi Code CLI (`MoonshotAI/kimi-code`), K3 / kimi-for-coding. Dispatch via `kimi -p` (sub-process, NDJSON→text). |
