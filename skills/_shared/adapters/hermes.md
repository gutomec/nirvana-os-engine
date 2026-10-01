# Adapter · Hermes (Hermes Agent CLI)

> Runtime adapter for Squad Protocol v6 + Business Protocol v2 + Harness Protocol v1.
> Covers the 3 protocols in a single doc. Canonical sections per Squad Protocol v6 §18.5.
> System identity + capabilities (what Nirvana-OS is and can do): see `../NIRVANA-OS.md` (single source).
> Mirrors `codex.md` (sub-process dispatch). Everything verified against the real Hermes
> install (`~/.hermes/`, v0.13.x) and the code (`agent/shell_hooks.py`, `agent/prompt_builder.py`).

---

## 1. Adapter Metadata

| Field | Value |
|---|---|
| `runtime` | `hermes` |
| `vendor` | Hermes Agent (OpenClaw lineage) |
| `min_version` | `0.13+` (Hermes CLI) |
| `default_model` | defined by the user's provider/profile (e.g. via OpenRouter); no default of its own |
| `tested_against` | Hermes Agent v0.13.0 (2026.5.7) |
| `config_paths` | `~/.hermes/config.yaml`, `~/.hermes/profiles/<p>/config.yaml`, `<project>/AGENTS.md`, `~/.hermes/SOUL.md` |
| `skills_root` | `~/.hermes/skills/` (HOME-global) + `skills.external_dirs` in `config.yaml` (`SKILL.md` format identical to Claude Code) |
| `agents_root` | no per-file agent profile like Codex; the persona goes in the `hermes -z` prompt (see §7) or via `hermes profile` |
| `memory_root` | `<project>/AGENTS.md` (auto-load from the CWD), SOUL.md/USER.md in the system prompt, SQLite+FTS5, Honcho |
| `audit_log` | `~/.harness-logs/<date>/audit.jsonl` via shell hooks (§10) + fs-watch (`nrv-hermes`) |
| `protocol_versions` | Squad 5.0, Business 1.0, Harness 1.0 (gaps in §13) |

---

## 2. Feature Support Matrix

`✓` = native · `~` = workaround/partial · `✗` = not supported

| Feature (Business v2 §6.5) | Squad v6 | Business v2 | Harness v1 | Notes |
|---|---|---|---|---|
| `max_turns` | ~ | ~ | ~ | Global `agent.max_turns` in the config/profile; there is no per-employee limit. Each `hermes -z` sub-process inherits the profile's limit |
| `tool_whitelist` | ✓ | ✓ | ✓ | `-t/--toolsets` restricts the tool universe per invocation; `disabled_toolsets` in the config |
| `subagent_spawning` | ~ | ~ | ~ | Native `delegation` is single-level (`max_spawn_depth: 1`); multi-level fan-out via `hermes -z` sub-process (= Codex pattern) |
| `audit_trail` | ~ | ~ | ~ | `pre/post_tool_call` shell hooks → `audit-emit-from-hermes-hook.ts` → jsonl; + fs-watch. Not native |
| `scheduled_invocation` | ✓ | ✓ | ✓ | **Native `hermes cron`**, an advantage over Codex/Gemini |
| `event_bus` | ~ | ~ | ~ | Mentions/tickets via file-system (`.handoffs/`); no broker |
| `hooks` | ~ | ~ | ~ | `pre/post_tool_call`, `on_session_start/end`, `transform_*`, etc.: shell-based, consent-gated; no per-arg granularity like Claude |
| `sandboxing` | ✓ | ✓ | ✓ | 6 terminal backends (local, Docker, SSH, Daytona, Modal, Singularity); Tirith pre-execution scanner |
| `session_memory` | ✓ | ✓ | ✓ | Per-session context + automatic compression |
| `project_memory` | ✓ | ✓ | ✓ | CWD `AGENTS.md` loaded automatically (including in `hermes -z`) |
| `global_memory` | ✓ | ✓ | ✓ | SOUL.md/USER.md + SQLite+FTS5 + Honcho (richer than Codex/Gemini) |
| `handoff_artifacts` | ✓ | ✓ | ✓ | JSON in `.handoffs/` (text→JSON parse; see §7) |
| `fork_context` | ~ | ~ | ~ | Sub-process spawn creates a fork; isolation by profile/toolset |
| `teammate_primitive` | ~ | ~ | ~ | `delegation.orchestrator_enabled` (single-level); multi-level teams are a file-system convention |
| `telemetry_otel` | ~ | ~ | ~ | No built-in OTel; jsonl via hooks |
| `messaging_escalation` | ✓ | ✓ | ✓ | 18 adapters (Slack/Telegram/WhatsApp), an **upgrade over Codex** for human escalation |
| `mcp` | ✓ | ✓ | ✓ | Native `mcp_servers` |

---

## 3. Concept Mapping

| Concept (Protocol) | Hermes equivalent | Implementation |
|---|---|---|
| Squad / Business | Bridge skill + the project's `AGENTS.md` | Global registry read via `nrv`; `AGENTS.md` loaded by CWD |
| Capability | Deterministic `nrv` command | `nrv find/route/index/verify-deliverable/quality-gate` via the `terminal` tool |
| Employee (seat) | Persona embedded in the `hermes -z` prompt | A business runs as ONE solo agent (`skills/harness/lib/business-solo.ts`) that plays the seats itself; core persona + injected DNA (§7); not an agent file as in Codex |
| `is_brief_intake: true` | The maestro reasons about the brief | It is a prompt (like on any runtime), not code |
| `is_antagonist: true` | `hermes -z` sub-process in a pipeline | `hermes -z "<persona+DNA+brief>" > .handoffs/<id>.out` |
| Handoff artifact | JSON parsed from the `-z` stdout | Persisted in `<project>/.handoffs/` |
| Mention `@employee` | Convention in the handoff JSON | The adapter detects `mentions[]` → new sub-process |
| Ticket | Persisted file | `<project>/.tickets/<TICKET_ID>.json` |
| Escalation trigger | Notification + messaging channel | The wrapper emits a notification; Hermes can notify via Slack/Telegram |
| Permanent memory | SOUL.md/USER.md + SQLite | Hermes native |
| Project memory | `<project>/AGENTS.md` | Auto-load by CWD |
| Session memory | Transcript + compression | Hermes native |
| Routing decision (harness) | `nrv find` (BM25) | Deterministic shell-out via the `terminal` tool |

---

## 4. Frontmatter Mapping

### Squad v6 / Business v2 → bridge skill + AGENTS.md

The bridge (`skills/_shared/adapters/hermes/skills/nirvana/`) is a standard `SKILL.md` skill that Hermes discovers via `external_dirs`. The project contract goes in `AGENTS.md` (byte-identical to `CLAUDE.md`/`GEMINI.md`), loaded by the CWD.

### Employee → `hermes -z` prompt

Hermes has no per-file agent profile (like `~/.codex/agents/<name>.md`). The employee persona is assembled in the prompt:

```
<employee core persona (frontmatter → top)>
<mind-clone DNA: injectMindClones().combined_prompt>
## Brief
<enriched brief>
## Output contract
Reply ONLY with a single JSON object: {...}
```

> For `type: mind_clone`, the adapter prepends `(DISCLOSURE: AI-generated persona, not a real person.)` to the persona, same as Codex.

---

## 5. Tool Whitelist Mechanics

- Hermes has 47 tools in 19 toolsets. The per-employee whitelist is applied via `-t/--toolsets` on the `hermes -z` invocation: what is not in the toolset does not exist in the session.
- Semantic tools → Hermes toolset mapping:
  - `read` / `write` / `edit` → `file`
  - `bash` → `terminal`
  - `web_fetch` → `web`
  - `image` → image toolset
- Adapter minimum default: `-t file,terminal`. It expands according to `employee.tools`.
- Additional gate: Tirith pre-execution scanner + `pre_tool_call` hooks (but our audit hook does NOT block; security rests on `-t` + Tirith + a controlled `--yolo`).

---

## 6. Max-Turns Mechanics

Hermes has a global `agent.max_turns` (config/profile), not per-subagent. The adapter simulates it:

1. Each employee runs as a `hermes -z` sub-process, which inherits `agent.max_turns` from the active profile.
2. For distinct limits per employee, use a dedicated profile (`hermes profile`) with its own `max_turns`, or accept the global.
3. Overrun → the sub-process ends; the wrapper records `audit_event: budget_violation`.

**Limitation:** no fine per-employee counting. Documented as `~` (partial). Flat employees are recommended (no nested invocation inside a single `-z`).

---

## 7. Subagent Spawning

Hermes **has no** `hermes run` and no in-process subagent primitive. The one-shot is `hermes -z "<prompt>"` (**plain text** output, no `--output-format json`, no `--agent`/`--soul`). The adapter dispatches like this:

```bash
# Adapter spawn (pseudocode of what the wrapper runs)
PROMPT=$(cat <<EOF
$PERSONA_CORE                      # employee core persona (frontmatter)
$DNA_BLOCK                         # injectMindClones().combined_prompt
## Brief
$BRIEF
## Allowed tools
$TOOL_WHITELIST
## Output contract (MANDATORY)
Reply ONLY with a single JSON object, no text before/after:
{"success":bool,"artifact_path":string|null,"summary":string,
 "next_action":string|null,"mentions":[string],"errors":[string]}
EOF
)
hermes -z "$PROMPT" \
  --model "$EMPLOYEE_MODEL" --provider "$EMPLOYEE_PROVIDER" \
  -t "$TOOLSET_SUBSET" \
  --accept-hooks --yolo \
  > ".handoffs/${EMPLOYEE}-$(date +%s).out"

# Parse text→JSON: extract the 1st balanced {...} object from stdout (noise tolerant).
```

**DNA / context limit.** The Hermes system prompt truncates context files at `CONTEXT_FILE_MAX_CHARS = 20_000` (head 70% + tail 20%, `agent/prompt_builder.py:824`). That is why the DNA goes in the **body of the `-z` prompt**, not in a context file (it avoids truncation). If `injectMindClones().total_bytes > ~14_000`, the adapter degrades to the top-1 clone + a deterministic summary of the others and emits `dispatch_degraded`. Each injection emits `mind_clone_injected` with a sha256 (`harness/lib/dispatch.ts:123-130`); `validateTrace()` (`dispatch.ts:193`) confirms after dispatch that the declared DNA == the injected DNA (anti-fabrication invariant).

**Mention `@x`:** detected in `mentions[]` in the handoff → new `hermes -z` sub-process. Multi-level fan-out stays in the Nirvana wrapper (Hermes' native `delegation` is single-level, `max_spawn_depth: 1`).

---

## 8. Memory Storage

| Layer | Path | Persistence |
|---|---|---|
| Permanent (cross-session) | SOUL.md/USER.md + SQLite+FTS5 + Honcho | Native |
| Project | `<project>/AGENTS.md` | Auto-load by CWD |
| Session | Transcript + automatic compression | Native |
| Business permanent | `~/businesses/<biz>/memory/permanent.md` | Adapter persists via `nrv` |
| Project (business) | `<project>/<biz>/<project_id>/memory/` | Isolation by construction |

> **Isolation guard:** when assembling the `-z` prompt, the adapter includes ONLY the current `project_id`'s memory, otherwise `audit_event: isolation_violation`.

---

## 9. Context Window & Compaction

- Window: depends on the configured model/provider (Hermes routes to the profile's provider).
- Context files (SOUL/USER/AGENTS) are truncated at 20K chars (head70/tail20). The DNA goes in the prompt body so it escapes that rule (§7).
- Compaction: Hermes compresses context automatically; each `hermes -z` is ephemeral (no state accumulated between dispatches).

---

## 10. Hook System

Hermes has shell hooks declared in `~/.hermes/config.yaml` (`hooks:`). `nrv setup --with-hermes` plugs in two, idempotent by token:

```yaml
hooks:
  pre_tool_call:
    - matcher: "terminal|file"        # re.fullmatch over tool_name
      command: "bun ~/.nirvana/skills/_shared/scripts/audit-emit-from-hermes-hook.ts pre"
      timeout: 5
  post_tool_call:
    - matcher: "terminal|file"
      command: "bun ~/.nirvana/skills/_shared/scripts/audit-emit-from-hermes-hook.ts post"
      timeout: 5
```

- JSON payload via stdin (`{hook_event_name, tool_name, tool_input, session_id, cwd}`); the shim normalizes `terminal→Bash`, `file→Write/Edit` and delegates to `audit-emit-from-hook.ts` (host `hermes-cli-hook`).
- **Golden rule:** the shim keeps stdout empty + exit 0, because Hermes blocks the tool if the response looks like `{"action":"block"}`. The hook only observes.
- The command runs via `shlex.split`, `shell=False` (no shell operators). Consent on first run is pre-approved by the installer (`shell-hooks-allowlist.json`) when the user opts into the hooks.

| Desired hook | Hermes equivalent |
|---|---|
| `PreToolUse` | `pre_tool_call` (matcher by tool_name) |
| `PostToolUse` | `post_tool_call` |
| `SessionStart` | `on_session_start` |
| `Stop` / `SubagentStop` | `on_session_end` / `subagent_stop` |
| `UserPromptSubmit` | inject into the `-z` prompt |

---

## 11. Invocation Examples

### Example 1: Query (Tier 0/1, no degradation)

```
hermes chat
> Quais são minhas empresas e squads?
# The bridge skill routes to `nrv list-businesses` / `nrv list-squads`.
```

### Example 2: Deterministic dispatch (Tier 2)

```
hermes -z "Use a skill nirvana-os-hermes: despache este brief — <brief>" --accept-hooks
# The bridge calls `nrv dispatch --auto --exec "<brief>"` (brief-business + DNA + headless execution + audit).
```

### Example 3: In-runtime orchestration (Tier 4)

```bash
# The business runs as ONE solo agent that plays the seats itself
hermes -z "<business persona + brief + JSON contract>" -t file,terminal --accept-hooks --yolo \
  > .handoffs/nexus-1.out
# A stand-alone sub-process is only spawned for an explicit mention
# Adapter detects mentions:["alex-hormozi"]
hermes -z "<persona alex-hormozi + DNA + context + JSON contract>" ... \
  > .handoffs/alex-1.out
```

### Example 4: Human escalation (a Hermes advantage)

```bash
# Wrapper detects budget_violation → Hermes notifies via a channel
hermes slack send "#nirvana-ops" "Escalação: budget_violation no trace <id>"
```

---

## 12. Runtime-Specific Validators

- **`bun` + `nrv` on the PATH** of the Hermes terminal backend (`command -v bun`, `command -v nrv`). On an ephemeral backend (Modal/Singularity), install Bun in the image.
- **Coherent toolset**: if `employee.tools` includes `bash`, `-t` must include `terminal`.
- **Non-blocking hook**: the audit shim never writes `{"action":"block"}` and never exits != 0.
- **Resolvable external_dirs**: the bridge path is absolute (not `~`); `${NIRVANA_PROJECT_SKILLS}` resolves only when `nrv-hermes` exports the var.
- **JSON contract**: tolerant parser (extracts the 1st balanced `{...}`); 1 retry with a reinforced instruction if the model returns loose text.

---

## 13. Known Limitations

1. **No `hermes run` / `--output-format json`** → dispatch uses `hermes -z` (plain text) + a "reply only JSON" contract + parsing. Risk that the model does not comply → tolerant parser + retry.
2. **No in-process subagent primitive** → `hermes -z` sub-process (ceiling = Codex, not Claude Code). Native `delegation` is single-level.
3. **No per-arg granular hooks** → audit via `pre/post_tool_call` shell + fs-watch.
4. **Per-employee max-turns** is the profile's global (simulated).
5. **Hook consent** requires an allowlist (pre-approved by the installer under user opt-in).
6. **20K chars limit** on context files → large DNA goes in the prompt body + degradation gate.
7. **Ephemeral backends** need Bun in the image.
8. **`hermes acp`** (long-lived ACP server) would be the evolution for persistent orchestration; out of scope for v1 (which uses one-shot `-z`).

---

## 14. Source References

- Hermes CLI: `hermes --help`, `hermes chat --help`, `hermes hooks --help`, `hermes skills --help`.
- Hooks: `~/.hermes/hermes-agent/agent/shell_hooks.py` (`_serialize_payload`, `_record_approval`, `_is_allowlisted`).
- Context limit: `~/.hermes/hermes-agent/agent/prompt_builder.py:824` (`CONTEXT_FILE_MAX_CHARS = 20_000`).
- Skills/external_dirs: `~/.hermes/hermes-agent/agent/skill_utils.py` (`get_external_skills_dirs`), `~/.hermes/config.yaml`.
- Bridge + shim: `skills/_shared/adapters/hermes/skills/nirvana/`, `skills/_shared/scripts/audit-emit-from-hermes-hook.ts`.
- Wrapper: `bin/nrv-hermes`. Installer: `scripts/install.ts` (`offerHermesBridge`).
- DNA injection: `harness/lib/dispatch.ts` (`injectMindClones`, `validateTrace`).
- Squad v6: `~/.nirvana/skills/squads/SQUAD_PROTOCOL_V6.md`. Business v2: `~/.nirvana/skills/businesses/BUSINESS_PROTOCOL_V2.md`.

---

## 15. Version History

| Version | Date | Changes |
|---|---|---|
| 1.0.0 | 2026-06-05 | Initial doc: Squad 5.0 + Business 1.0 + Harness 1.0 against Hermes Agent v0.13.0. Dispatch via `hermes -z` (sub-process, text→JSON). Bridge + audit hooks + nrv-hermes. |
