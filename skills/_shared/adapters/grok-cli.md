# Adapter · Grok Build CLI (xAI Grok)

> Runtime adapter for Squad Protocol v6 + Business Protocol v2 + Harness Protocol v1.
> Covers the 3 protocols in a single doc. Canonical sections per Squad Protocol v6 §18.5.
> System identity + capabilities (what Nirvana-OS is and can do): see `../NIRVANA-OS.md` (single source).
> Mirrors `codex.md` / `kimi-cli.md` (sub-process dispatch, no per-file agent profile).

---

## 1. Adapter Metadata

| Field | Value |
|---|---|
| `runtime` | `grok-cli` |
| `vendor` | xAI |
| `min_version` | Grok Build CLI (binary `grok`, `~/.grok/bin/grok`, `grok 0.2.103`): headless flags `-p --output-format json --always-approve`; version not pinned |
| `default_model` | inherited from the runtime. The engine NEVER sets a model; it comes from the `grok-cli:<model>` entry of `LLM_CASCADE`. Pass a model only when the user explicitly asks. |
| `tested_against` | `grok 0.2.103`; Grok family (`grok-code`, `grok-4`/`grok-4-fast`): the runtime's default model or the one the user chose via `LLM_CASCADE`, never hardcoded |
| `config_paths` | `~/.grok/` (Build CLI session/login), `<project>/AGENTS.md` |
| `skills_root` | Compatible with the universal dir `<project>/.agents/skills/` (same family as the agentic CLIs; already in the engine's truth table) |
| `agents_root` | No per-file agent profile (like Codex `~/.codex/agents/`); the persona goes in the `grok -p` prompt or via `--system-prompt-override` (see §7) |
| `memory_root` | `<project>/AGENTS.md` (project); Grok has no rich native cross-session memory |
| `audit_log` | `~/.harness-logs/` (jsonl via the driver); Grok does not expose a documented canonical transcript store |
| `protocol_versions` | Squad 5.0, Business 1.0, Harness 1.0 (with gaps recorded in §13) |

---

## 2. Feature Support Matrix

`✓` = native · `~` = workaround/partial · `✗` = not supported

| Feature (Business v2 §6.5) | Squad v6 | Business v2 | Harness v1 | Notes |
|---|---|---|---|---|
| `max_turns` | ✓ | ✓ | ✓ | Native flag `--max-turns <N>`; the wrapper passes the employee's `opts.maxTurns` straight to the runtime |
| `tool_whitelist` | ~ | ~ | ~ | No `--allowedTools`; `--permission-mode <MODE>` + `--always-approve` control approval globally. Fine whitelist via persona in the prompt + gate in the wrapper |
| `subagent_spawning` | ✗ | ✗ | ✗ | Native subagents NOT confirmed. Fallback = sequential execution of the workflow steps; `grok -p` sub-process for OS-level fan-out |
| `audit_trail` | ~ | ~ | ~ | No documented transcript store; the harness adds jsonl via `runGrok` |
| `scheduled_invocation` | ✗ | ✗ | ✗ | No `ScheduleWakeup`/`CronCreate`: degrade to external cron |
| `event_bus` | ~ | ~ | ~ | Mentions/tickets via file-system; no broker |
| `hooks` | ~ | ~ | ~ | No confirmed granular hook system; `--permission-mode` gives coarse control; complex validation in a wrapper |
| `sandboxing` | ~ | ~ | ~ | `--permission-mode` + `--cwd` isolate; no rich sandbox profiles like Codex's |
| `session_memory` | ✓ | ✓ | ✓ | Per-session context (Grok family window) |
| `project_memory` | ✓ | ✓ | ✓ | `AGENTS.md` in the project (convention shared with Codex/Antigravity/Kimi) |
| `global_memory` | ~ | ~ | ~ | No rich auto-discovery like `~/.claude/memory/` |
| `handoff_artifacts` | ✓ | ✓ | ✓ | JSON extracted from stdout (`--output-format json`); `--json-schema` forces the structured shape |
| `fork_context` | ~ | ~ | ~ | Sub-process spawn creates a fork; no strong isolation |
| `teammate_primitive` | ✗ | ✗ | ✗ | No `TeamCreate`; a team is a convention via the file system |
| `telemetry_otel` | ~ | ~ | ~ | OTel via an external OpenTelemetry SDK (not built-in) |
| `mcp` | ✓ | ✓ | ✓ | MCP compatible (agentic CLI family); skills via `<project>/.agents/skills/` |

> **Note outside the canonical matrix:** Grok's big differentiator is the **media generation built into the Build CLI** (`image_gen` / `image_edit` / `image_to_video`) plus the **subscription route with $0 marginal cost** (§8/§13), not new orchestration primitives. Concrete reinforcements over the agentic peers: native `--max-turns` and structured output via `--json-schema`.

---

## 3. Concept Mapping

| Concept (Protocol) | Grok Build CLI equivalent | Implementation |
|---|---|---|
| Squad / Business | Skills directory + AGENTS.md | `<project>/.agents/skills/<name>/` + the CWD's `AGENTS.md` |
| Capability | Workflow file | `<skill>/capabilities/<id>.md` invoked by a wrapper |
| Employee (seat) | Persona embedded in the `grok -p` prompt | A business runs as ONE solo agent (`skills/harness/lib/business-solo.ts`) that plays the seats itself; core persona + DNA in the prompt body (or `--system-prompt-override`); not an agent file as in Codex |
| `is_brief_intake: true` | Default persona when the skill is active | Built in the prompt / the skill's `AGENTS.md` |
| `is_antagonist: true` | Sub-process invoked in a pipeline | `grok -m <model> -p "<persona+brief>" --output-format json --always-approve` |
| Handoff artifact | JSON on stdout | Persisted in `<project>/.handoffs/` |
| Mention `@employee` | Convention in the handoff | The adapter detects it → new sub-process |
| Ticket | Persisted file | `<project>/.tickets/<TICKET_ID>.json` |
| Escalation trigger | Wrapper script + harness call | The wrapper checks the condition → emits a notification to the harness |
| Permanent memory | `<project>/AGENTS.md` + custom files | No rich global auto-load |
| Project memory | `<project>/AGENTS.md` | Convention (load depends on the version) |
| Session memory | Conversation transcript | The Grok family window reduces pressure |
| Routing decision (harness) | Pre-spawn lookup table | BM25 over `capabilities[].examples[]` in a Bun/Node wrapper |

---

## 4. Frontmatter Mapping

### Squad v6 / Business v2 → AGENTS.md

Grok has no rich frontmatter in the skill head. The adapter generates two files (same tactic as Codex/Antigravity/Kimi):

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

### Employee → `grok -p` prompt

Grok has no per-file agent profile. The employee persona is assembled in the prompt (or passed in a separate block via `--system-prompt-override`):

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

- Grok is agentic-coding-first and uses internal function-calling; **there is no confirmed `--allowedTools` flag**. The runtime exposes coarse approval control via `--permission-mode <MODE>` and `--always-approve` (auto-approve of every tool execution, used in headless mode). The fine whitelist is applied in two ways:
  - **Persona in the prompt**: explicitly declare the allowed tools ("## Allowed tools") and forbid the rest.
  - **Gate in the wrapper**: the wrapper runs with a restricted `--cwd` and OS permissions; commands outside the brief's scope are blocked outside the runtime.
- Semantic tools → Grok intent mapping:
  - `read` → file read
  - `write` / `edit` → file write/edit
  - `bash` → command execution
  - `web_fetch` → URL fetch
- MCP servers appear as additional tools; include/exclude by the `mcp__<server>__` prefix.
- **Built-in media:** `image_gen` / `image_edit` / `image_to_video` are native Build CLI tools, exposed to the employee when the persona declares them.

---

## 6. Max-Turns Mechanics

Grok **exposes** a native `--max-turns <N>`. The adapter uses it like this:

1. Each employee runs as a `grok -p` sub-process, with `--max-turns <N>` derived from the employee's `maxTurns` (`opts.maxTurns` → argv), plus the wrapper's `timeout` (`opts.timeoutMs` → `spawnSync`) as a safety belt.
2. The logical turn count also comes from the handoff (the employee reports the steps executed).
3. Turn overrun or timeout → the sub-process ends; the wrapper records `audit_event: budget_violation`.

**Residual limitation:** a native cap exists, but there is no fine per-turn introspection of the runtime. Flat employees are recommended (no nested invocation inside a single `-p`).

---

## 7. Subagent Spawning

**No confirmed subagent primitive.** Unlike Codex (`[agents]` blocks) and Antigravity (in-process dynamic subagents), Grok **has no** native subagents confirmed in the research. The path is always a `grok -p` **sub-process** (`host-agent-driver.runGrok`):

```bash
# Adapter spawn (host-agent-driver.runGrok)
grok -m <model> -p "Review this offer: ..." \
  --output-format json --always-approve --cwd <dir> \
  > .handoffs/alex-hormozi-$(date +%s).json
```

Real flags used by the driver:
- `-p, --single "<prompt>"`: one-shot headless prompt (no TUI).
- `-m, --model <id>`: selects the model (e.g. `grok-code`, `grok-4`, `grok-4-fast`). It comes only from the `grok-cli:<model>` cascade entry, never hardcoded.
- `--output-format <plain|json|streaming-json>`: default `plain`; the driver passes **`json`** (a single object on stdout). `streaming-json` is available for incremental progress.
- `--always-approve`: auto-approve of every tool execution (headless autonomy).
- `--cwd <dir>`: working dir of the run.
- `--max-turns <N>`: turn cap (see §6).
- `--json-schema <schema>`: forces the structured output shape (hardens the handoff output contract).
- `--system-prompt-override <text>` / `--prompt-file <path>`: persona/prompt via flag or file instead of argv.

The driver extracts the final JSON object from stdout defensively; if the build does not support `--output-format json` (default is `plain`), the driver detects the error (`output-format|unknown|unrecognized|invalid option`) and **re-runs in `plain`** (stdout then carries the assistant's plain text, and the adapter parses the embedded JSON). It returns a handoff artifact that the adapter records in the audit log.

> **No `--resume`.** `runGrok` generates its own `sessionId` and does **not** pass a native resume flag. Context continuation goes through `HANDOFF.json` + a new sub-process (see `agent-x.grok.md` §4), not through a persisted runtime session.

**For a mention `@x`:** the adapter detects it in the returned handoff and opens a new sub-process for `x`.

**Parallel fan-out:** simulated at the OS level (the harness fires independent `grok -p` sub-processes for independent steps), not inside Grok.

---

## 8. Memory Storage

| Layer | Path | Persistence |
|---|---|---|
| Permanent (cross-session) | `<project>/AGENTS.md` + custom files | Manual |
| Project | `<project>/AGENTS.md` | Convention (load depends on the version) |
| Session | Conversation transcript | The Grok family window reduces pressure |
| Business permanent | `~/businesses/<biz>/memory/permanent.md` | Adapter persists |
| Project (business) | `<project>/<biz>/<project_id>/memory/` | Isolation by construction |

> **Isolation guard:** Grok does not enforce memory isolation natively. The adapter builds the prompt with ONLY the memory relevant to the `project_id` before spawning, otherwise `audit_event: isolation_violation`.

**Authentication: two tracks.** The engine is model-agnostic: the model comes ONLY from the `grok-cli:<model>` cascade entry. The credential comes from one of two routes:

- **Subscription via `grok` login**: the Grok Build CLI logged into an xAI account. An **agentic route with $0 marginal cost** on the subscription; tracked cost = **$0** (the driver reports `costUsd: null`, like agy/gemini/kimi). This is the route the **`grok-studio-nirvana`** squad uses.
- **xAI API via `XAI_API_KEY` (paid)**: a key in the environment pointing to the xAI API. Cost = pay-per-token.

---

## 9. Context Window & Compaction

- Window: **depends on the Grok model** chosen via `LLM_CASCADE`; the `grok-4`/`grok-4-fast` family offers large windows. The engine does not pin a number.
- Compaction: a wide window reduces compaction pressure in long-running businesses.
- **Advantage:** a large-context brief (extensive code analysis, document review) runs without aggressive truncation, and when the brief asks for a visual artifact, `image_gen`/`image_edit`/`image_to_video` resolve in the same runtime.

---

## 10. Hook System

Grok has no confirmed granular hooks. Workarounds in a wrapper (`--permission-mode` covers the coarse pre-tool gate):

| Desired hook | Grok workaround |
|---|---|
| `PreToolUse` | `--permission-mode` acts as a coarse gate; persona in the prompt as a soft validator; hard validation in a wrapper |
| `PostToolUse` | The wrapper parses the handoff / stdout after the run |
| `UserPromptSubmit` | The adapter injects instructions into the `grok -p` prompt (or `--system-prompt-override`) |
| `Stop` | The wrapper inspects the exit code and the final output |
| `SessionStart` | The wrapper loads memory before invoking `grok -p` |
| `Compact` | No confirmed flag; the Grok family's large window mitigates |

---

## 11. Invocation Examples

### Example 1: Squad capability

```bash
# User: "gerar key visual do lançamento e um teaser vertical"
# Harness wrapper:
grok -m <model> -p "You are grok-studio. image_gen key visual ..., then image_to_video teaser 9:16 ..." \
  --output-format json --always-approve --cwd <dir>
```

### Example 2: Business brief with handoff

```bash
# The business runs as ONE solo agent that plays the seats itself
grok -m <model> -p "<business persona + brief + JSON contract>" --output-format json --always-approve --cwd <dir> \
  > .handoffs/nexus-1.json

# A stand-alone sub-process (optional) is only spawned for an explicit mention `@alex-hormozi`
grok -m <model> -p "<persona alex + DNA + context + JSON contract>" --output-format json --always-approve --cwd <dir> \
  > .handoffs/alex-1.json
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

- **Credential present**: subscription (`grok` logged in) OR `XAI_API_KEY` in the environment (API route). With neither, dispatch fails; the wrapper checks before spawning.
- **Resolvable model**: the cascade's `grok-cli:<model>` has to exist (e.g. `grok-code`, `grok-4`, `grok-4-fast`); the wrapper validates against the provider catalog.
- **MCP server reachability**: if the persona references `mcp__<server>__*`, validate that the server is configured.
- **AGENTS.md loaded**: the wrapper ensures `AGENTS.md`/manifest is injected into the prompt (Grok does not do rich auto-discovery).

---

## 13. Known Limitations

1. **No subagent primitive** → the adapter uses a `grok -p` sub-process. Cost: each spawn pays cold start overhead; fan-out stays in the wrapper.
2. **No granular hooks** → validation in an external wrapper; `--permission-mode` covers only the coarse gate.
3. **No `ScheduleWakeup` / `CronCreate`** → the harness degrades to external cron.
4. **No rich cross-session memory** → the adapter keeps memory in files and builds the prompt manually.
5. **Max-turns has a native cap** (`--max-turns`), but no fine per-turn introspection of the runtime → assumes flat employees.
6. **No `TeamCreate`** → teams are a file-system convention.
7. **OTel is not built-in** → the adapter integrates with an external OpenTelemetry SDK.
8. **`--output-format` defaults to `plain`** → the wrapper passes `json` explicitly; builds without the flag fall back to `plain` (parse of the JSON embedded in stdout).
9. **Auth on two tracks** → subscription (`grok` login) OR `XAI_API_KEY` (env, paid route); the wrapper validates before dispatch.
10. **The tool whitelist is not hard-enforced** by the runtime (only coarse `--permission-mode`/`--always-approve`) → depends on the persona in the prompt + the wrapper gate.
11. **Recent/unstable flag surface** (`grok 0.2.103`) → test `grok --help` against the installed version before each bump.

**Compensating advantage:** built-in media generation (`image_gen` / `image_edit` / `image_to_video`) + a subscription route with $0 marginal cost ($0 tracked) + structured output (`--json-schema`) + native `--max-turns`. A good fit for briefs that mix code and a visual artifact in the same runtime.

---

## 14. Source References

- Grok Build CLI (xAI): binary `grok` (`~/.grok/bin/grok`), `grok 0.2.103`; headless via `grok -p "<prompt>" --output-format json --always-approve --cwd <dir>`.
- xAI API: paid route via `XAI_API_KEY` (pay-per-token).
- Driver: `skills/harness/lib/host-agent-driver.ts` (`runGrok`).
- Reference squad (subscription route): `grok-studio-nirvana`.
- Squad Protocol v6: `~/.nirvana/skills/squads/SQUAD_PROTOCOL_V6.md`
- Business Protocol v2: `~/.nirvana/skills/businesses/BUSINESS_PROTOCOL_V2.md`
- Harness protocol: `~/.nirvana/skills/harness/SKILL.md`

---

## 15. Version History

| Version | Date | Changes |
|---|---|---|
| 1.0.0 | 2026-07-20 | Initial doc: covers Squad 5.0 + Business 1.0 + Harness 1.0 against Grok Build CLI (`grok 0.2.103`), Grok family (`grok-code` / `grok-4` / `grok-4-fast`). Dispatch via `grok -p --output-format json --always-approve --cwd`. |
