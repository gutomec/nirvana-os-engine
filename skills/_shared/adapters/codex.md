# Adapter · Codex (OpenAI Codex CLI)

> Runtime adapter para Squad Protocol v5 + Business Protocol v1 + Harness Protocol v1.
> Cobre os 3 protocolos em um único doc. Seções canônicas conforme Squad v4 §18.5.
> Identidade + capabilities do sistema (o que o Nirvana-OS é e pode fazer): ver `../NIRVANA-OS.md` (fonte única).

---

## 1. Adapter Metadata

| Campo | Valor |
|---|---|
| `runtime` | `codex` |
| `vendor` | OpenAI |
| `min_version` | `0.20+` (Codex CLI), OpenAI SDK `>=1.50` |
| `default_model` | herdado do runtime — o engine NUNCA define model; a config do runtime do usuário decide. Passe model só quando o usuário pedir explicitamente. |
| `tested_against` | Codex CLI 0.2x — gpt-5-codex |
| `config_paths` | `~/.codex/config.toml`, `<project>/AGENTS.md`, `~/AGENTS.md` |
| `skills_root` | Sem skill system nativo — adapter usa `~/.codex/skills/<name>/` (convenção) ou flat `~/.codex/agents/` |
| `agents_root` | `~/.codex/agents/<name>.md` ou bundled em `<project>/.codex/agents/` |
| `memory_root` | `<project>/AGENTS.md` (project), `~/.codex/memory/` (custom) — Codex não tem memory nativo cross-session |
| `audit_log` | `~/.codex/sessions/` (transcripts), `~/.harness-logs/` (jsonl fallback) |
| `protocol_versions` | Squad 5.0, Business 1.0, Harness 1.0 (com gaps registrados em §13) |

---

## 2. Feature Support Matrix

`✓` = nativo · `~` = workaround/parcial · `✗` = não suportado

| Feature (Business v1 §6) | Squad v5 | Business v1 | Harness v1 | Notas |
|---|---|---|---|---|
| `max_turns` | ~ | ~ | ~ | Codex tem `--max-turns` global no CLI; adapter precisa simular per-employee via wrapper script |
| `tool_whitelist` | ✓ | ✓ | ✓ | Function-calling whitelist via OpenAI tool definitions; sandbox gating native |
| `subagent_spawning` | ✓ | ✓ | ✓ | native via `[agents]` em `~/.codex/config.toml` (`agents.max_depth` default 1, explicit-only, `/agent`); `runCodex` sub-process é fallback |
| `audit_trail` | ✓ | ✓ | ✓ | Session transcripts em `~/.codex/sessions/`, harness adiciona OTel/jsonl |
| `scheduled_invocation` | ✗ | ✗ | ✗ | Sem `ScheduleWakeup`/`CronCreate` — degradar para cron externo |
| `event_bus` | ~ | ~ | ~ | Mentions/tickets via file-system; sem broker |
| `hooks` | ~ | ~ | ~ | Codex tem `--profile` e `instructions` mas sem hooks granulares (`PreToolUse`, etc.) |
| `sandboxing` | ✓ | ✓ | ✓ | Sandbox nativo (`workspace-write`, `read-only`, `danger-full-access`) |
| `session_memory` | ✓ | ✓ | ✓ | Conversation context por sessão |
| `project_memory` | ✓ | ✓ | ✓ | `AGENTS.md` no projeto (load automático) |
| `global_memory` | ~ | ~ | ~ | `~/AGENTS.md` user-level — sem auto-discovery rico como `~/.claude/memory/` |
| `handoff_artifacts` | ✓ | ✓ | ✓ | Estrutura JSON em tool_result ou em arquivo persistido |
| `fork_context` | ~ | ~ | ~ | Sub-process spawn cria fork mas sem isolation forte |
| `teammate_primitive` | ✗ | ✗ | ✗ | Sem `TeamCreate`; team é convenção via file system |
| `telemetry_otel` | ~ | ~ | ~ | OTel via OpenTelemetry SDK externo (não built-in) |

---

## 3. Concept Mapping

| Conceito (Protocolo) | Equivalente Codex | Implementação |
|---|---|---|
| Squad / Business | Diretório de agents + AGENTS.md | `<project>/.codex/<name>/AGENTS.md` carrega o "skill" |
| Capability | Workflow file | `<skill>/capabilities/<id>.md` invocado por wrapper |
| Employee | Codex agent profile | `~/.codex/agents/<name>.md` (frontmatter + body) |
| `is_brief_intake: true` | Default agent quando skill ativa | Configurado em `AGENTS.md` do skill |
| `is_antagonist: true` | Sub-process invocado em pipeline | `codex run --agent <name> --prompt "..."` |
| Handoff artifact | JSON em arquivo + tool_result | Persistido em `<project>/.handoffs/` |
| Mention `@employee` | Convenção em prompt | Adapter resolve para spawn de sub-process |
| Ticket | Arquivo persistido | `<project>/.tickets/<TICKET_ID>.json` |
| Escalation trigger | Wrapper script + harness call | Wrapper checa condição → emite notification para harness |
| Permanent memory | `~/AGENTS.md` + custom files | Codex auto-load somente AGENTS.md |
| Project memory | `<project>/AGENTS.md` | Auto-load |
| Session memory | Conversation transcript | Codex compacta automaticamente |
| Routing decision (harness) | Pre-spawn lookup table | BM25 sobre `capabilities[].examples[]` em wrapper Python/Node |

---

## 4. Frontmatter Mapping

### Squad v5 / Business v1 → AGENTS.md

Codex não tem frontmatter rico. O adapter gera dois arquivos:

```yaml
# AGENTS.md (head do projeto/skill)
You are an AI agent operating under the Squad/Business Protocol.

Available capabilities: [media.video.analyze, media.transcript.extract, ...]
Default tools: [Read, Write, Bash]
Sandbox: workspace-write
```

```yaml
# .codex/manifest.yaml (auxiliar — lido por wrapper, não pelo Codex)
name: nexus-council
protocol: 1.0
employees: [ceo, marketing-lead, ...]
operation_mode: zero_human
```

### Employee → Codex agent profile

```yaml
# ~/.codex/agents/alex-hormozi.md
---
name: alex-hormozi
description: Mind clone of Alex Hormozi for offer evaluation. (DISCLOSURE: AI-generated persona, not real person.)
model: inherit  # o engine não fixa model; usa o do runtime
tools: [Read, Grep, Bash]
sandbox: read-only
---

# System prompt
You are a mind-clone of Alex Hormozi specialized in offer evaluation...
```

> Adapter prepende `(DISCLOSURE: ...)` em description quando `type: mind_clone`.

---

## 5. Tool Whitelist Mechanics

- Codex usa OpenAI function-calling. Adapter traduz semantic tools → function definitions:
  - `read` → `read_file({path})`
  - `bash` → `run_command({command})`
  - `web_fetch` → `fetch_url({url})`
- Whitelist enforçada na lista passada à API (`tools=[...]`).
- Sandbox profile (`workspace-write` / `read-only` / `danger-full-access`) gate adicional.

---

## 6. Max-Turns Mechanics

Codex CLI tem `--max-turns N` global, mas não per-subagent. Adapter simula assim:

1. Wrapper spawn `codex run --max-turns <N> --agent <name> --prompt "..."`.
2. `<N>` lido do employee frontmatter (`maxTurns`).
3. Process exit code != 0 quando excede → harness emite `audit_event: budget_violation`.

**Limitação:** se employee invoca outro employee internamente (sem voltar pro adapter), o adapter perde contagem. Documentar como `~` (parcial). Recomenda-se employees de Codex serem flat (sem nested invocation).

---

## 7. Subagent Spawning

**PRIMÁRIO — subagents nativos do Codex.** O Codex agora tem subagents nativos: blocos `[agents]` em `~/.codex/config.toml`, com `agents.max_depth` (default 1), delegação **explicit-only** e o comando `/agent`. Quando o maestro roda dentro de um `codex run` interativo/headless, ele despacha o employee como subagent nativo (in-process àquele run), sem cold start de sub-process. Ref: https://developers.openai.com/codex/subagents.

```toml
# ~/.codex/config.toml
[agents.alex-hormozi]
description = "Mind clone of Alex Hormozi for offer evaluation."
model = "inherit"  # o engine nao fixa model; usa o do runtime
# agents.max_depth default 1 — delegação é explicit-only (/agent)
```

**FALLBACK — `codex exec` sub-process.** Para scripts standalone sem contexto LLM próprio, o adapter usa `codex exec` como sub-process com escopo isolado:

```bash
# Adapter spawn (pseudocode)
codex run \
  --agent alex-hormozi \
  --max-turns 30 \
  --sandbox read-only \
  --output-format json \
  --prompt "Review this offer: ..." \
  > .handoffs/alex-hormozi-$(date +%s).json
```

Sub-process retorna handoff artifact em stdout. Adapter parseia e registra em audit log.

> **Nota driver:** `host-agent-driver.runCodex` atualmente usa **sempre** o fallback sub-process (`codex exec`). A doc descreve os subagents nativos como caminho primário — doc-ahead-of-driver é aceitável até o driver ser atualizado.

**Para mention `@x`:** adapter detecta no handoff retornado, abre novo sub-process para `x`.

---

## 8. Memory Storage

| Camada | Path | Persistência |
|---|---|---|
| Permanent (cross-session) | `~/AGENTS.md` + `~/.codex/memory/` (convenção do adapter) | Manual |
| Project | `<project>/AGENTS.md` | Auto-load |
| Session | Conversation transcript | Compactado |
| Business permanent | `~/businesses/<biz>/memory/permanent.md` | Adapter persiste |
| Project (business) | `<project>/<biz>/<project_id>/memory/` | Isolation by construction |

> **Isolation guard:** Codex não enforça memory isolation natively. Adapter precisa montar prompt com APENAS o memory relevante ao `project_id` antes de spawn — caso contrário `audit_event: isolation_violation`.

---

## 9. Context Window & Compaction

- Janela: 128K–200K tokens (gpt-5-codex). Variável por modelo.
- Compaction: Codex tem auto-summarization quando perto do limit; adapter pode forçar `--checkpoint` antes.

---

## 10. Hook System

Codex não tem hooks granulares. Workarounds:

| Hook desejado | Workaround Codex |
|---|---|
| `PreToolUse` | Function definition pode ter `description` que age como soft-validator; hard validation em wrapper |
| `PostToolUse` | Wrapper parseia tool calls do transcript após cada turn |
| `UserPromptSubmit` | Adapter injeta `instructions` no prompt do `codex run` |
| `Stop` | Wrapper inspeciona exit code e final transcript |
| `SessionStart` | Wrapper carrega memory antes de invocar `codex run` |
| `Compact` | `--checkpoint` flag |

---

## 11. Invocation Examples

### Exemplo 1 — Squad capability

```bash
# User: "transcrever vídeo do Instagram https://..."
# Harness wrapper:
codex run \
  --agent instagram-intelligence \
  --skill media.video.analyze \
  --max-turns 20 \
  --prompt "Analyze video: https://..." \
  --output-format json
```

### Exemplo 2 — Business brief com handoff

```bash
# CEO recebe brief
codex run --agent nexus-ceo --max-turns 10 --prompt "<brief>" > .handoffs/ceo-1.json

# Adapter detecta `next_action: delegate to marketing-lead` no handoff
codex run --agent marketing-lead --max-turns 30 \
  --prompt "<context from ceo handoff>" > .handoffs/marketing-1.json

# Adapter detecta mention `@alex-hormozi`
codex run --agent alex-hormozi --max-turns 15 \
  --prompt "<context from marketing handoff>" > .handoffs/alex-1.json
```

### Exemplo 3 — Harness escalation

```bash
# Wrapper detecta budget_violation
echo '{"type":"human_escalation_required","trigger_id":"budget","severity":"high",...}' \
  > .harness/notifications/$(date +%s).json
# Harness orchestrator (em outro runtime ou interativo) consome o file
```

---

## 12. Runtime-Specific Validators

- **Sandbox profile coerente**: se employee.tools inclui `Bash`, sandbox deve ser `workspace-write` ou `danger-full-access` (não `read-only`).
- **Function definition match**: cada tool no whitelist precisa ter function definition válida — wrapper valida antes de spawn.
- **AGENTS.md carregado**: adapter verifica que `AGENTS.md` referencia `manifest.yaml` corretamente (caso contrário Codex não vê o skill).

---

## 13. Known Limitations

1. **Sem subagent primitive** → adapter usa sub-process `codex run`. Custo: cada spawn paga overhead de cold start.
2. **Sem hooks granulares** → validações em wrapper externo, não inline.
3. **Sem `ScheduleWakeup` / `CronCreate`** → harness degradar para cron externo.
4. **Sem memory cross-session rico** → adapter mantém memory em files, monta prompt manualmente.
5. **Max-turns per-employee é simulado** → assume employees flat (sem nested invocation).
6. **Sem `TeamCreate`** → teams são convenção em file-system.
7. **OTel não é built-in** → adapter integra com OpenTelemetry SDK externo.
8. **Mentions e tickets** dependem do wrapper detectar e fan-out — race conditions possíveis em multi-process.
9. **Slash commands** não existem nativamente; adapter usa CLI flags (`--agent`, `--skill`, `--prompt`).

---

## 14. Source References

- Codex CLI docs: https://platform.openai.com/docs/codex
- OpenAI SDK: https://github.com/openai/openai-python
- Squad Protocol v5: `~/.claude/skills/squads/SQUAD_PROTOCOL_V5.md`
- Business Protocol v1: `~/.claude/skills/businesses/BUSINESS_PROTOCOL_V1.md`
- Harness Protocol v1: `~/.claude/skills/harness/HARNESS_PROTOCOL_V1.md`

---

## 15. Version History

| Versão | Data | Mudanças |
|---|---|---|
| 1.0.0 | 2026-05-02 | Doc inicial — cobre Squad 5.0 + Business 1.0 + Harness 1.0 contra Codex CLI 0.2x (gpt-5-codex) |
