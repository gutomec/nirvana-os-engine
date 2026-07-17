# Adapter · Gemini CLI

> Runtime adapter para Squad Protocol v5 + Business Protocol v1 + Harness Protocol v1.
> Cobre os 3 protocolos em um único doc. Seções canônicas conforme Squad v4 §18.5.
> Identidade + capabilities do sistema (o que o Nirvana-OS é e pode fazer): ver `../NIRVANA-OS.md` (fonte única).

> **LEGADO — sunset em 2026-06-18.** O Gemini CLI será descontinuado. Seu sucessor é o **antigravity-cli** (binário `agy`, ver [`antigravity-cli.md`](./antigravity-cli.md)), que mantém o backend Google/Gemini mas adiciona **subagents dinâmicos nativos in-process** (via Agent Harness local). O dispatch do Gemini CLI permanece **sub-process** (`gemini run`); para novas instalações no tier consumer, prefira o antigravity-cli.

---

## 1. Adapter Metadata

| Campo | Valor |
|---|---|
| `runtime` | `gemini-cli` |
| `vendor` | Google |
| `min_version` | `0.4+` (Gemini CLI), `google-genai` SDK `>=0.5` |
| `default_model` | herdado do runtime — o engine NUNCA define model; a config do runtime do usuário decide. Passe model só quando o usuário pedir explicitamente. |
| `tested_against` | Gemini CLI 0.4–0.6 contra Gemini 2.5 Pro |
| `config_paths` | `~/.gemini/settings.json`, `<project>/GEMINI.md`, `<project>/.gemini/config.toml` |
| `skills_root` | Sem skill system formal; adapter usa `~/.gemini/skills/<name>/` (convenção) |
| `agents_root` | `~/.gemini/agents/<name>.md` (experimental) ou bundled em `<project>/.gemini/agents/` |
| `memory_root` | `<project>/GEMINI.md` (project), `~/.gemini/memory/` (custom) |
| `audit_log` | `~/.gemini/sessions/` (experimental), `~/.harness-logs/` (jsonl fallback) |
| `protocol_versions` | Squad 5.0, Business 1.0, Harness 1.0 (com gaps registrados em §13) |

---

## 2. Feature Support Matrix

`✓` = nativo · `~` = workaround/parcial · `✗` = não suportado

| Feature (Business v1 §6) | Squad v5 | Business v1 | Harness v1 | Notas |
|---|---|---|---|---|
| `max_turns` | ~ | ~ | ~ | `--max-iterations` no CLI; per-employee via wrapper |
| `tool_whitelist` | ✓ | ✓ | ✓ | Function calling whitelist + `--tools` flag |
| `subagent_spawning` | ~ | ~ | ~ | `gemini agent` (experimental) ou sub-process `gemini run` — sem isolation primitive |
| `audit_trail` | ~ | ~ | ~ | Session transcripts experimentais; harness adiciona OTel/jsonl |
| `scheduled_invocation` | ✗ | ✗ | ✗ | Sem `ScheduleWakeup` — cron externo |
| `event_bus` | ✗ | ~ | ~ | Mentions/tickets via file-system; sem broker |
| `hooks` | ✗ | ✗ | ✗ | Sem hook system; workaround em wrapper |
| `sandboxing` | ~ | ~ | ~ | Container-based sandbox (`--sandbox`) opcional, profiles limitados vs Codex |
| `session_memory` | ✓ | ✓ | ✓ | Conversation context |
| `project_memory` | ✓ | ✓ | ✓ | `GEMINI.md` carregado no start |
| `global_memory` | ~ | ~ | ~ | `~/GEMINI.md` user-level — sem auto-discovery rico |
| `handoff_artifacts` | ✓ | ✓ | ✓ | JSON em tool_result ou arquivo persistido |
| `fork_context` | ~ | ~ | ~ | Sub-process spawn |
| `teammate_primitive` | ✗ | ✗ | ✗ | Sem `TeamCreate` |
| `telemetry_otel` | ~ | ~ | ~ | Via OpenTelemetry SDK externo |

> **Nota fora da matriz canônica:** Gemini CLI suporta MCP servers (experimental) registrados em `~/.gemini/mcp/`. Não é uma das 15 features de Business v1 §6, mas vale como vetor extra para tools customizadas. Tratado em §5 e §13.

---

## 3. Concept Mapping

| Conceito (Protocolo) | Equivalente Gemini CLI | Implementação |
|---|---|---|
| Squad / Business | Diretório + GEMINI.md | `<project>/.gemini/<name>/GEMINI.md` carrega o "skill" |
| Capability | Workflow file | `<skill>/capabilities/<id>.md` invocado por wrapper ou via slash command de Gemini CLI |
| Employee | Gemini agent profile | `~/.gemini/agents/<name>.md` (experimental) |
| `is_brief_intake: true` | Default agent quando skill ativa | `default_agent` em settings.json |
| `is_antagonist: true` | Sub-process invocado em pipeline | `gemini run --agent <name> --prompt "..."` |
| Handoff artifact | JSON em arquivo + tool_result | `<project>/.handoffs/` |
| Mention `@employee` | Convenção em prompt | Adapter resolve para spawn de sub-process |
| Ticket | Arquivo persistido | `<project>/.tickets/<TICKET_ID>.json` |
| Escalation trigger | Wrapper script + harness call | Wrapper checa condição → emite notification |
| Permanent memory | `~/GEMINI.md` + custom files | Auto-load só de GEMINI.md |
| Project memory | `<project>/GEMINI.md` | Auto-load |
| Session memory | Conversation transcript | Compactado |
| Routing decision (harness) | Pre-spawn lookup | BM25 sobre `capabilities[].examples[]` em wrapper |

---

## 4. Frontmatter Mapping

### Squad v5 / Business v1 → GEMINI.md

```markdown
# GEMINI.md (head do projeto/skill)
You are an AI agent operating under the Squad/Business Protocol.

Available capabilities: [media.video.analyze, media.transcript.extract, ...]
Default tools: [Read, Write, Bash]
Sandbox: enabled
```

```yaml
# .gemini/manifest.yaml (auxiliar, lido por wrapper)
name: nexus-council
protocol: 1.0
employees: [ceo, marketing-lead, ...]
operation_mode: zero_human
```

### Employee → Gemini agent profile

```yaml
# ~/.gemini/agents/alex-hormozi.md
---
name: alex-hormozi
description: Mind clone of Alex Hormozi for offer evaluation. (DISCLOSURE: AI-generated persona, not real person.)
model: inherit  # o engine não fixa model; usa o do runtime
tools: [Read, Grep, Bash]
max_iterations: 30
---

# System prompt
You are a mind-clone of Alex Hormozi specialized in offer evaluation...
```

> Adapter prepende `(DISCLOSURE: ...)` em description quando `type: mind_clone`.

---

## 5. Tool Whitelist Mechanics

- Gemini usa function calling. Adapter traduz semantic tools → function declarations:
  - `read` → `read_file({path})`
  - `bash` → `execute_command({command})`
  - `web_fetch` → `fetch_url({url})`
- Whitelist enforçada na lista passada ao SDK (`tools=[...]`).
- MCP servers (experimental) registrados via `~/.gemini/mcp/` aparecem como tools adicionais — adapter pode incluir/excluir por prefixo `mcp__<server>__`.

---

## 6. Max-Turns Mechanics

Gemini CLI tem `--max-iterations N` global. Adapter simula per-employee assim:

1. Wrapper spawn `gemini run --max-iterations <N> --agent <name> --prompt "..."`.
2. `<N>` lido do employee frontmatter (`maxTurns`).
3. Process exit ou wrapper detecta limit → emite `audit_event: budget_violation`.

Limitação: nested invocations escapam da contagem. Documentar como `~`.

---

## 7. Subagent Spawning

Gemini CLI tem `gemini agent` experimental. Adapter prefere abordagem sub-process robusta:

```bash
gemini run \
  --agent alex-hormozi \
  --max-iterations 30 \
  --output-format json \
  --prompt "Review this offer: ..." \
  > .handoffs/alex-hormozi-$(date +%s).json
```

Quando `gemini agent` API estabilizar, adapter pode migrar para spawn in-process. Para v1: sub-process.

---

## 8. Memory Storage

| Camada | Path | Persistência |
|---|---|---|
| Permanent (cross-session) | `~/GEMINI.md` + `~/.gemini/memory/` (convenção do adapter) | Manual |
| Project | `<project>/GEMINI.md` | Auto-load |
| Session | Conversation transcript | Compactado |
| Business permanent | `~/businesses/<biz>/memory/permanent.md` | Adapter persiste |
| Project (business) | `<project>/<biz>/<project_id>/memory/` | Isolation by construction |

> **Isolation guard:** Gemini CLI não enforça memory isolation. Adapter monta prompt com APENAS o memory relevante ao `project_id`. Caso contrário emite `audit_event: isolation_violation`.

---

## 9. Context Window & Compaction

- Janela: 1M–2M tokens (Gemini 2.5 Pro/Flash) — maior que Claude/Codex.
- Compaction: auto-summarization quando perto do limit.
- **Vantagem:** janela maior reduz pressão por compaction em businesses long-running.

---

## 10. Hook System

Gemini CLI não tem hooks granulares. Workarounds em wrapper:

| Hook desejado | Workaround Gemini CLI |
|---|---|
| `PreToolUse` | Function declaration validation no SDK |
| `PostToolUse` | Wrapper parseia tool calls do transcript após cada turn |
| `UserPromptSubmit` | Adapter injeta system instructions no prompt do `gemini run` |
| `Stop` | Wrapper inspeciona exit code e final transcript |
| `SessionStart` | Wrapper carrega memory antes de invocar `gemini run` |
| `Compact` | `--checkpoint` flag (experimental) |

---

## 11. Invocation Examples

### Exemplo 1 — Squad capability

```bash
gemini run \
  --agent instagram-intelligence \
  --skill media.video.analyze \
  --max-iterations 20 \
  --prompt "Analyze video: https://..." \
  --output-format json
```

### Exemplo 2 — Business brief com handoff em pipeline

```bash
# CEO recebe brief
gemini run --agent nexus-ceo --max-iterations 10 \
  --prompt "<brief>" > .handoffs/ceo-1.json

# Adapter detecta `next_action: delegate to marketing-lead`
gemini run --agent marketing-lead --max-iterations 30 \
  --prompt "<context from ceo handoff>" > .handoffs/marketing-1.json

# Adapter detecta mention `@alex-hormozi`
gemini run --agent alex-hormozi --max-iterations 15 \
  --prompt "<context from marketing handoff>" > .handoffs/alex-1.json
```

### Exemplo 3 — Harness escalation

```bash
echo '{"type":"human_escalation_required","trigger_id":"budget","severity":"high",...}' \
  > .harness/notifications/$(date +%s).json
```

---

## 12. Runtime-Specific Validators

- **MCP server reachability**: se employee.tools inclui `mcp__<server>__*`, validar que o MCP server está em `~/.gemini/mcp/<server>/` e responde a health check.
- **Function declaration coerente**: tools no whitelist precisam ter declaration válida — wrapper valida pre-spawn.
- **GEMINI.md carregado**: adapter verifica que skill manifest é referenciado no GEMINI.md (caso contrário não carrega).
- **Modelo suportado**: alguns features (function calling rico, code execution) variam por modelo. Adapter checa `model` em employee frontmatter contra capability matrix do Gemini.

---

## 13. Known Limitations

1. **Sem subagent primitive estável** — `gemini agent` experimental, adapter prefere sub-process.
2. **Sem hooks granulares** — validações em wrapper externo.
3. **Sem `ScheduleWakeup` / `CronCreate`** — cron externo.
4. **Sem memory cross-session rico** — adapter mantém memory em files.
5. **Max-iterations per-employee é simulado** — assume employees flat.
6. **Sem `TeamCreate`** — teams como convenção.
7. **OTel não built-in** — SDK externo.
8. **Mentions e tickets** dependem do wrapper detectar e fan-out.
9. **MCP support é experimental** — pode mudar entre versões; adapter precisa testar antes de cada bump de versão.
10. **Slash commands** experimentais; adapter usa CLI flags.
11. **Audit log** experimental — não confiar para produção sem fallback jsonl do harness.

**Vantagem compensatória:** janela de contexto 5–10x maior que Claude/Codex permite businesses long-running com menos pressure de compaction.

---

## 14. Source References

- Gemini CLI docs: https://ai.google.dev/gemini-api/docs/cli
- Google Gen AI SDK: https://github.com/google-gemini/generative-ai-python
- MCP support em Gemini CLI (experimental): https://ai.google.dev/gemini-api/docs/mcp
- Squad Protocol v5: `~/.claude/skills/squads/SQUAD_PROTOCOL_V5.md`
- Business Protocol v1: `~/.claude/skills/businesses/BUSINESS_PROTOCOL_V1.md`
- Harness Protocol v1: `~/.claude/skills/harness/HARNESS_PROTOCOL_V1.md`

---

## 15. Version History

| Versão | Data | Mudanças |
|---|---|---|
| 1.0.0 | 2026-05-02 | Doc inicial — cobre Squad 5.0 + Business 1.0 + Harness 1.0 contra Gemini CLI 0.4–0.6 (Gemini 2.5 Pro) |
