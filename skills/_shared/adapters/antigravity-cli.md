# Adapter · Antigravity CLI (Google Antigravity 2.0)

> Runtime adapter para Squad Protocol v5 + Business Protocol v1 + Harness Protocol v1.
> Cobre os 3 protocolos em um único doc. Seções canônicas conforme Squad v4 §18.5.

> **Sucessor do gemini-cli.** Anunciado no Google I/O 2026, o Antigravity 2.0 **substitui o gemini-cli** no tier consumer a partir de 2026-06-18. Mesmo backend Google (modelos Gemini), binário e convenções de flag diferentes (`agy`). Ver [`gemini-cli.md`](./gemini-cli.md) (legado).

---

## 1. Adapter Metadata

| Campo | Valor |
|---|---|
| `runtime` | `antigravity-cli` |
| `vendor` | Google |
| `min_version` | `2.0+` (Antigravity CLI), `google-genai` SDK `>=0.5` |
| `default_model` | `gemini-3-pro` (prod), `gemini-3-flash` (low-cost) |
| `tested_against` | Antigravity 2.0 contra Gemini 3 Pro |
| `config_paths` | `~/.antigravity/settings.json`, `<project>/AGENTS.md`, `~/AGENTS.md` |
| `skills_root` | Sem skill system formal; adapter usa `~/.antigravity/skills/<name>/` (convenção) |
| `agents_root` | `~/.antigravity/agents/<name>.md` ou bundled em `<project>/.antigravity/agents/` |
| `memory_root` | `<project>/AGENTS.md` (project), `~/.antigravity/memory/` (custom) |
| `audit_log` | `~/.antigravity/sessions/` (transcripts), `~/.harness-logs/` (jsonl fallback) |
| `protocol_versions` | Squad 5.0, Business 1.0, Harness 1.0 (com gaps registrados em §13) |

---

## 2. Feature Support Matrix

`✓` = nativo · `~` = workaround/parcial · `✗` = não suportado

| Feature (Business v1 §6) | Squad v5 | Business v1 | Harness v1 | Notas |
|---|---|---|---|---|
| `max_turns` | ~ | ~ | ~ | `--max-iterations` global no CLI; per-employee via wrapper |
| `tool_whitelist` | ✓ | ✓ | ✓ | Function calling whitelist + `--tools` flag |
| `subagent_spawning` | ✓ | ✓ | ✓ | native — dynamic subagents in-process via Agent Harness local; Managed Agents para long runs; `agy -p` sub-process é fallback |
| `audit_trail` | ✓ | ✓ | ✓ | Session transcripts em `~/.antigravity/sessions/`; harness adiciona OTel/jsonl |
| `scheduled_invocation` | ✗ | ✗ | ✗ | Sem `ScheduleWakeup` — cron externo |
| `event_bus` | ~ | ~ | ~ | Mentions/tickets via file-system; sem broker |
| `hooks` | ~ | ~ | ~ | Hooks parciais; validações complexas em wrapper |
| `sandboxing` | ~ | ~ | ~ | Approval modes (Request Review / Proceed-in-Sandbox / Always-Proceed); profiles em consolidação |
| `session_memory` | ✓ | ✓ | ✓ | Conversation context |
| `project_memory` | ✓ | ✓ | ✓ | `AGENTS.md` carregado no start |
| `global_memory` | ~ | ~ | ~ | `~/AGENTS.md` user-level — sem auto-discovery rico |
| `handoff_artifacts` | ✓ | ✓ | ✓ | JSON em tool_result ou arquivo persistido |
| `fork_context` | ✓ | ✓ | ✓ | Subagents dinâmicos criam contexto isolado in-process |
| `teammate_primitive` | ~ | ~ | ~ | Managed Agents para long runs; team formal via convenção |
| `telemetry_otel` | ~ | ~ | ~ | Via OpenTelemetry SDK externo |

> **Nota fora da matriz canônica:** Antigravity expõe um SDK próprio para orquestrar agentes programaticamente, além do Agent Harness local que hospeda os subagents dinâmicos. Tratado em §7.

---

## 3. Concept Mapping

| Conceito (Protocolo) | Equivalente Antigravity | Implementação |
|---|---|---|
| Squad / Business | Diretório de agents + AGENTS.md | `<project>/.antigravity/<name>/AGENTS.md` carrega o "skill" |
| Capability | Workflow file | `<skill>/capabilities/<id>.md` invocado por wrapper |
| Employee | Antigravity agent profile | `~/.antigravity/agents/<name>.md` (frontmatter + body) |
| `is_brief_intake: true` | Default agent quando skill ativa | Configurado em `AGENTS.md` do skill |
| `is_antagonist: true` | Subagent dinâmico em pipeline | Spawn in-process via Agent Harness |
| Handoff artifact | JSON em arquivo + tool_result | Persistido em `<project>/.handoffs/` |
| Mention `@employee` | Convenção em prompt | Adapter resolve para spawn de subagent |
| Ticket | Arquivo persistido | `<project>/.tickets/<TICKET_ID>.json` |
| Escalation trigger | Wrapper script + harness call | Wrapper checa condição → emite notification para harness |
| Permanent memory | `~/AGENTS.md` + custom files | Auto-load só de AGENTS.md |
| Project memory | `<project>/AGENTS.md` | Auto-load |
| Session memory | Conversation transcript | Compactado automaticamente |
| Routing decision (harness) | Pre-spawn lookup table | BM25 sobre `capabilities[].examples[]` em wrapper Python/Node |

---

## 4. Frontmatter Mapping

### Squad v5 / Business v1 → AGENTS.md

Antigravity não tem frontmatter rico no head do skill. O adapter gera dois arquivos:

```yaml
# AGENTS.md (head do projeto/skill)
You are an AI agent operating under the Squad/Business Protocol.

Available capabilities: [media.video.analyze, media.transcript.extract, ...]
Default tools: [Read, Write, Bash]
```

```yaml
# .antigravity/manifest.yaml (auxiliar — lido por wrapper, não pelo runtime)
name: nexus-council
protocol: 1.0
employees: [ceo, marketing-lead, ...]
operation_mode: zero_human
```

### Employee → Antigravity agent profile

```yaml
# ~/.antigravity/agents/alex-hormozi.md
---
name: alex-hormozi
description: Mind clone of Alex Hormozi for offer evaluation. (DISCLOSURE: AI-generated persona, not real person.)
model: gemini-3-pro
tools: [Read, Grep, Bash]
max_iterations: 30
---

# System prompt
You are a mind-clone of Alex Hormozi specialized in offer evaluation...
```

> Adapter prepende `(DISCLOSURE: ...)` em description quando `type: mind_clone`.

---

## 5. Tool Whitelist Mechanics

- Antigravity usa function calling (backend Gemini). Adapter traduz semantic tools → function declarations:
  - `read` → `read_file({path})`
  - `bash` → `execute_command({command})`
  - `web_fetch` → `fetch_url({url})`
- Whitelist enforçada na lista passada ao SDK (`tools=[...]`) ou via `--tools`.
- Approval mode (§9) gate adicional sobre comandos que escrevem.

---

## 6. Max-Turns Mechanics

Antigravity CLI tem `--max-iterations N` global, mas não per-subagent. Adapter simula assim:

1. Wrapper spawn `agy -p "..." --max-iterations <N>` (ou despacha subagent nativo com limite por agent).
2. `<N>` lido do employee frontmatter (`maxTurns` / `max_iterations`).
3. Process exit ou wrapper detecta limit → emite `audit_event: budget_violation`.

**Limitação:** nested invocations via subagent dinâmico podem escapar da contagem do wrapper externo. Documentar como `~` (parcial).

---

## 7. Subagent Spawning

**PRIMÁRIO — subagents dinâmicos nativos.** O Antigravity 2.0 spawna subagents **dinâmicos in-process** através de um **Agent Harness server local**. Quando o maestro roda dentro de uma sessão `agy`, ele despacha o employee como subagent dinâmico hospedado pelo Agent Harness — in-process àquela run, sem cold start de sub-process. Para execuções longas existem **Managed Agents** (rodam de forma gerenciada/persistente), e um **SDK** permite orquestrar agentes programaticamente.

**FALLBACK — `agy -p` sub-process.** Para scripts standalone sem contexto LLM próprio (ou runtimes só-sub-process), o adapter usa `agy -p` como sub-process (`host-agent-driver.runAntigravity`):

```bash
# Adapter spawn (host-agent-driver.runAntigravity)
agy -p "Review this offer: ..." \
  --output-format json \
  > .handoffs/alex-hormozi-$(date +%s).json
```

Flags reais usadas pelo driver:
- `-p "<prompt>"` — prompt headless (one-shot). `-p` / `--print` / `--prompt` aceitam o prompt como valor de argv.
- `--output-format json` — objeto JSON único (paridade com `runGemini`/`runClaudeCode`). `stream-json` (NDJSON) também existe.
- `--resume <id>` — retoma a sessão (passado quando `opts.sessionId` está setado).
- `--model <id>` — override de modelo (passado quando `opts.model` está setado).

Sub-process retorna handoff artifact em stdout. Adapter parseia e registra em audit log.

> **Nota driver:** a flag de approval-mode (autonomous/yolo) **ainda não está confirmada** na pesquisa (`(base de conhecimento interna)` §5.3 — modos Request Review / Proceed-in-Sandbox / Always-Proceed). `host-agent-driver.runAntigravity` carrega um TODO: confirmar com `agy --help` depois de autenticado, então mapear `opts.yolo !== false → Always-Proceed`.

**Para mention `@x`:** adapter detecta no handoff retornado, spawna novo subagent (in-process) ou sub-process para `x`.

---

## 8. Memory Storage

| Camada | Path | Persistência |
|---|---|---|
| Permanent (cross-session) | `~/AGENTS.md` + `~/.antigravity/memory/` (convenção do adapter) | Manual |
| Project | `<project>/AGENTS.md` | Auto-load |
| Session | Conversation transcript | Compactado |
| Business permanent | `~/businesses/<biz>/memory/permanent.md` | Adapter persiste |
| Project (business) | `<project>/<biz>/<project_id>/memory/` | Isolation by construction |

> **Isolation guard:** Antigravity não enforça memory isolation natively. Adapter monta prompt com APENAS o memory relevante ao `project_id` antes de spawn — caso contrário `audit_event: isolation_violation`.

---

## 9. Context Window & Compaction

- Janela: 1M–2M tokens (Gemini 3 Pro/Flash) — maior que Claude/Codex.
- Compaction: auto-summarization quando perto do limit.
- **Approval modes** (Request Review / Proceed-in-Sandbox / Always-Proceed) governam se comandos que escrevem pedem confirmação; afetam runs autônomos longos.
- **Vantagem:** janela maior reduz pressão por compaction em businesses long-running.

---

## 10. Hook System

Antigravity não tem hooks granulares maduros. Workarounds em wrapper:

| Hook desejado | Workaround Antigravity |
|---|---|
| `PreToolUse` | Function declaration validation no SDK |
| `PostToolUse` | Wrapper parseia tool calls do transcript após cada turn |
| `UserPromptSubmit` | Adapter injeta system instructions no prompt do `agy -p` |
| `Stop` | Wrapper inspeciona exit code e final transcript |
| `SessionStart` | Wrapper carrega memory antes de invocar `agy` |
| `Compact` | `--checkpoint` flag (quando disponível) |

---

## 11. Invocation Examples

### Exemplo 1 — Squad capability

```bash
agy -p "Analyze video: https://..." \
  --output-format json
```

### Exemplo 2 — Business brief com handoff em pipeline

```bash
# CEO recebe brief
agy -p "<brief>" --output-format json > .handoffs/ceo-1.json

# Adapter detecta `next_action: delegate to marketing-lead`
agy -p "<context from ceo handoff>" --output-format json --resume <ceo-session-id> \
  > .handoffs/marketing-1.json

# Adapter detecta mention `@alex-hormozi`
agy -p "<context from marketing handoff>" --output-format json \
  > .handoffs/alex-1.json
```

### Exemplo 3 — Harness escalation

```bash
echo '{"type":"human_escalation_required","trigger_id":"budget","severity":"high",...}' \
  > .harness/notifications/$(date +%s).json
```

---

## 12. Runtime-Specific Validators

- **Approval mode coerente**: se employee.tools inclui `Bash`, o approval mode não pode ser tão restritivo que bloqueie toda escrita esperada pelo brief.
- **Function declaration coerente**: tools no whitelist precisam ter declaration válida — wrapper valida pre-spawn.
- **AGENTS.md carregado**: adapter verifica que skill manifest é referenciado no `AGENTS.md` (caso contrário não carrega).
- **Modelo suportado**: alguns features (function calling rico, code execution) variam por modelo. Adapter checa `model` em employee frontmatter contra a capability matrix do Antigravity.

---

## 13. Known Limitations

1. **Approval-mode flag para runs autônomos ainda não confirmada** — TODO no driver (§7); confirmar com `agy --help` autenticado.
2. **Sem hooks granulares maduros** — validações em wrapper externo.
3. **Sem `ScheduleWakeup` / `CronCreate`** — cron externo.
4. **Sem memory cross-session rico** — adapter mantém memory em files, monta prompt manualmente.
5. **Max-iterations per-employee é simulado** — nested subagent invocations podem escapar da contagem do wrapper.
6. **Mentions e tickets** dependem do wrapper detectar e fan-out — race conditions possíveis em multi-process.
7. **OTel não é built-in** — adapter integra com OpenTelemetry SDK externo.
8. **Runtime recente (2.0)** — superfície de flags/SDK pode mudar entre versões; testar antes de cada bump.

---

## 14. Source References

- Antigravity CLI spec (pesquisa interna): `(base de conhecimento interna)`
- Google Gen AI SDK: https://github.com/google-gemini/generative-ai-python
- Squad Protocol v5: `~/.claude/skills/squads/SQUAD_PROTOCOL_V5.md`
- Business Protocol v1: `~/.claude/skills/businesses/BUSINESS_PROTOCOL_V1.md`
- Harness Protocol v1: `~/.claude/skills/harness/HARNESS_PROTOCOL_V1.md`

---

## 15. Version History

| Versão | Data | Mudanças |
|---|---|---|
| 1.0.0 | 2026-06-06 | Doc inicial — sucessor do gemini-cli (sunset 2026-06-18); cobre Squad 5.0 + Business 1.0 + Harness 1.0 contra Antigravity 2.0 (Gemini 3 Pro) |
