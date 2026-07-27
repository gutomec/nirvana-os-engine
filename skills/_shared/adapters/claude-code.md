# Adapter · Claude Code

> Runtime adapter para Squad Protocol v5 + Business Protocol v1 + Harness Protocol v1.
> Cobre os 3 protocolos em um único doc. Seções canônicas conforme Squad v4 §18.5.
> Identidade + capabilities do sistema (o que o Nirvana-OS é e pode fazer): ver `../NIRVANA-OS.md` (fonte única).

---

## 1. Adapter Metadata

| Campo | Valor |
|---|---|
| `runtime` | `claude-code` |
| `vendor` | Anthropic |
| `min_version` | `1.0.0` (CLI), Anthropic SDK `>=0.30` |
| `default_model` | herdado do runtime — o engine NUNCA define model; a config do runtime do usuário decide. Passe model só quando o usuário pedir explicitamente. |
| `tested_against` | Claude Code 1.x (CLI, IDE, web) — Opus 4.7 |
| `config_paths` | `~/.claude/settings.json` (user), `<project>/.claude/settings.json`, `<project>/.claude/settings.local.json` |
| `skills_root` | `~/.claude/skills/` (user), `<project>/.claude/skills/` (project), bundled |
| `agents_root` | `~/.claude/agents/` (user), `<project>/.claude/agents/` (project) |
| `memory_root` | `~/.claude/memory/` (permanent), `<project>/CLAUDE.md` (project), conversation context (session) |
| `audit_log` | `~/.claude/projects/<project-id>/` (transcripts, tool results), `~/.harness-logs/` (harness OTel/jsonl) |
| `protocol_versions` | Squad 5.0, Business 1.0, Harness 1.0 |

---

## 2. Feature Support Matrix

`✓` = nativo · `~` = workaround/parcial · `✗` = não suportado

| Feature (Business v1 §6) | Squad v5 | Business v1 | Harness v1 | Notas |
|---|---|---|---|---|
| `max_turns` | ✓ | ✓ | ✓ | `maxTurns` em frontmatter de agent/employee; runtime não enforça hard mas adapter pode fechar via hook |
| `tool_whitelist` | ✓ | ✓ | ✓ | `tools:` no frontmatter + `permissions` em settings.json |
| `subagent_spawning` | ✓ | ✓ | ✓ | `Agent` tool com `subagent_type` |
| `audit_trail` | ✓ | ✓ | ✓ | OTel se configurado, fallback para jsonl em `~/.harness-logs/` |
| `scheduled_invocation` | ✓ | ✓ | ✓ | `ScheduleWakeup`, `CronCreate` (deferred tools) |
| `event_bus` | ~ | ~ | ~ | Sem broker nativo. Mentions e tickets viajam por tool results + filesystem watch + memory polling. Documentado como limitação em §13. |
| `hooks` | ✓ | ✓ | ✓ | `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`, `SessionStart`, `Compact` |
| `sandboxing` | ~ | ~ | ~ | `dangerouslyDisableSandbox` no Bash tool; sandbox é por permissão de tool, não por process isolation |
| `session_memory` | ✓ | ✓ | ✓ | Conversation context (auto-compactado) |
| `project_memory` | ✓ | ✓ | ✓ | `CLAUDE.md` + `<project>/.claude/memory/` |
| `global_memory` | ✓ | ✓ | ✓ | `~/.claude/CLAUDE.md` + `~/.claude/memory/` |
| `handoff_artifacts` | ✓ | ✓ | ✓ | Estrutura JSON em `tool_result` ou em arquivo persistido |
| `fork_context` | ✓ | ✓ | ✓ | Cada `Agent` invocation cria um sub-context isolado |
| `teammate_primitive` | ~ | ~ | ~ | Subagents servem de teammate por convenção; `TeamCreate` é deferred tool, não está disponível em todas as instalações 1.x. Quando indisponível o adapter cai para spawn paralelo de `Agent`. |
| `telemetry_otel` | ✓ | ✓ | ✓ | Via OTLP endpoint quando `HARNESS_TELEMETRY=otel` |

---

## 3. Concept Mapping

| Conceito (Protocolo) | Equivalente Claude Code | Implementação |
|---|---|---|
| Squad / Business | Skill | Diretório `~/.claude/skills/<name>/SKILL.md` (frontmatter + body) |
| Capability | Sub-skill / task / workflow | Arquivo invocado por nome a partir do `Skill` tool ou via slash command |
| Employee | Subagent | Arquivo agent.md (`name`, `description`, `tools`, `model`) em `~/.claude/agents/` ou bundled em skill |
| `is_brief_intake: true` | Skill activator | Skill que dispara primeiro quando harness recebe brief |
| `is_antagonist: true` | Subagent invocado em loop de revisão | Spawn paralelo de subagent crítico |
| Handoff artifact | Tool result | JSON estruturado retornado por subagent (validável contra `HandoffArtifactSchema`) |
| Mention `@employee` | Convenção em prompt + memory | Adapter resolve `@x` para `Agent({ subagent_type: "x", ...})` |
| Ticket | Arquivo persistido + memory ref | `<project>/.tickets/<TICKET_ID>.json` + entrada em memory |
| Escalation trigger | Hook + harness notification | `PostToolUse` checa condição → emite `HarnessNotification` |
| Permanent memory | `~/.claude/memory/*.md` + `~/.claude/CLAUDE.md` | Files referenciados via auto-load |
| Project memory | `<project>/.claude/memory/` + `CLAUDE.md` | Auto-load por sessão |
| Session memory | Conversation context | Mantido pelo runtime, compactado quando perto do limit |
| Routing decision (harness) | Skill scoring + AgentTool dispatch | BM25 sobre `capabilities[].examples[]` |

---

## 4. Frontmatter Mapping

### Squad v5 → Skill frontmatter

```yaml
# squad.yaml (Squad v5 §22)
name: instagram-intelligence
version: 5.4.0
protocol: 5.0
description: ...
capabilities:
  - id: media.video.analyze
    invoke: { type: task, ref: tasks/analyze.md }
```

```yaml
---
# ~/.claude/skills/instagram-intelligence/SKILL.md frontmatter
name: instagram-intelligence
description: <copia de squad.yaml description>
---
```

### Business v1 → Skill frontmatter

```yaml
# business.yaml (Business v1 §6)
name: nexus-council
employee_count: 9
operation_mode: zero_human
```

```yaml
---
# ~/.claude/skills/nexus-council/SKILL.md frontmatter
name: nexus-council
description: <gerado a partir de description+pitch>
---
```

### Employee → Subagent agent.md

```yaml
# employees/alex-hormozi.md frontmatter (Business v1 §7)
name: alex-hormozi
type: mind_clone
disclosure_required: true
maxTurns: 30
tools: [Read, Grep, Bash]
model: inherit
```

```yaml
---
# ~/.claude/agents/alex-hormozi.md frontmatter
name: alex-hormozi
description: Mind clone of Alex Hormozi for offer evaluation. (DISCLOSURE: AI-generated persona, not real person.)
tools: Read, Grep, Bash
model: inherit
---
```

> **Regra de tradução:** quando `type: mind_clone`, o adapter **prepende** `(DISCLOSURE: AI-generated persona, not real person.)` à description do agent.md.

---

## 5. Tool Whitelist Mechanics

- O frontmatter `tools:` aceita semantic names (`read`, `write`, `edit`, `grep`, `glob`, `bash`, `web_search`, `web_fetch`) — Squad v4 §10.7.
- Adapter Claude Code traduz para nomes nativos: `Read`, `Write`, `Edit`, `Grep`, `Glob`, `Bash`, `WebSearch`, `WebFetch`.
- Tools MCP entram como `mcp__<server>__<tool>`.
- Para enforçar whitelist em runtime, configurar `permissions` em `<project>/.claude/settings.json`:

```json
{
  "permissions": {
    "allow": ["Read", "Grep", "Bash(npm test:*)"],
    "deny": ["WebFetch"]
  }
}
```

---

## 6. Max-Turns Mechanics

Claude Code não enforça `maxTurns` nativamente em sub-agentes. O adapter usa 3 mecanismos:

1. **Informativo**: `maxTurns` no employee frontmatter aparece no prompt do subagent ("você tem N turns").
2. **Pre-flight budget**: harness converte `maxTurns × estimated_cost_per_turn` em `budget.default_max_cost_usd` (Harness §6).
3. **Hook enforcement**: `PostToolUse` hook conta tool calls do subagent e aborta via `decision: "block"` quando excede:

```json
// settings.json hook (exemplo)
{
  "hooks": {
    "PostToolUse": [
      { "matcher": "Agent", "command": "~/.claude/hooks/turn-counter.sh" }
    ]
  }
}
```

**Limitação conhecida:** se o subagent é dispatched via `Skill` em vez de `Agent`, o counter precisa rodar em outro escopo. Documentar como `~` (parcial) na matrix.

---

## 7. Subagent Spawning

Padrão: `Agent` tool com `subagent_type` apontando para o nome do agent definido em `~/.claude/agents/<name>.md`.

```typescript
// Pseudo-invocação interna
Agent({
  subagent_type: "alex-hormozi",
  description: "Offer review",
  prompt: "Review this offer for clarity and pricing...",
  // optional:
  isolation: "worktree", // git worktree para mudanças isoladas
  run_in_background: false
})
```

O `Agent` tool é o **caminho PRIMÁRIO de dispatch**: roda in-process dentro da sessão do maestro, sem child `claude -p` e sem hard kill de 20 min de wall-clock — deliverables longos não são truncados. O caminho headless `claude -p` (`host-agent-driver.runClaudeCode`, flags `--output-format json` / `--allowedTools` / `--permission-mode` / `--add-dir` / `--max-budget-usd` / `--resume`) é o FALLBACK, usado só por scripts standalone sem contexto LLM próprio (o `dispatch.ts`).

**Para businesses (employees):** o adapter mapeia 1:1 — cada employee vira um subagent_type. CEO da business é o agent_type que tem `is_brief_intake: true`.

**Para squads (capabilities):** capability com `invoke.type: agent` mapeia para `Agent`; com `type: workflow` ou `type: task` pode rodar inline no escopo da skill.

---

## 8. Memory Storage

| Camada | Path | Persistência |
|---|---|---|
| Permanent (cross-session) | `~/.claude/memory/<topic>.md` indexada por `~/.claude/memory/MEMORY.md` | Manual ou auto via `auto memory` |
| Project (per-cliente) | `<project>/.claude/memory/` + `<project>/CLAUDE.md` | Auto-load no start da sessão |
| Session | Conversation context | Compactado pelo runtime |
| Business permanent | `~/businesses/<biz>/memory/permanent.md` | Adapter persiste explicitly via Write |
| Project (business) | `<project>/<biz>/<project_id>/memory/` | Isolation by construction (Business v1 §9) |

> **Isolation guard (Harness §H10):** quando o adapter detecta tentativa de leitura de memory de outro `project_id`, emite `audit_event: isolation_violation` e bloqueia.

---

## 9. Context Window & Compaction

- Janela: 200K tokens (Sonnet/Opus 4.x).
- Compaction: automática quando perto do limit. Emite hook `Compact` permitindo persistir state crítico antes.
- Para businesses long-running: forçar checkpoint via `Skill: harness#checkpoint` ao atingir 70% do context.

---

## 10. Hook System

Hooks executam shell commands. Eventos relevantes:

| Hook | Trigger | Uso para protocolo |
|---|---|---|
| `PreToolUse` | Antes de cada tool call | Enforce permissions, dry-run cost |
| `PostToolUse` | Depois de cada tool call | Turn counter, cost emission, audit |
| `UserPromptSubmit` | Cada prompt do user | Injetar harness preamble |
| `Stop` | Fim de turn | Persistir mention/ticket inbox |
| `SessionStart` | Início de sessão | Carregar memory + verificar pending tickets |
| `Compact` | Antes de auto-compaction | Salvar state crítico (Business v1 §9.3) |

Configuração em `settings.json`. Ver `update-config` skill para syntax exata.

---

## 11. Invocation Examples

### Exemplo 1 — Squad capability (Squad v5)

```
User: "transcrever vídeo do Instagram https://..."

Harness routing:
  brief → match capabilities[].examples → "transcrever vídeo do Instagram"
  → match: instagram-intelligence#media.video.analyze (score 0.94)
  → HIGH match (auto-invoke)
  → Skill({ skill: "instagram-intelligence", args: "video=https://..." })
```

### Exemplo 2 — Business brief (Business v1)

```
User: "Estamos lançando um produto novo, preciso de um plano completo de marketing."

Harness routing:
  brief → match domains [marketing, strategy] + employee_count
  → match: nexus-council (score 0.78)
  → AMBIGUOUS (precisa confirmar via AskUserQuestion ou abre business)
  → Skill({ skill: "nexus-council" })
  → Business CEO (is_brief_intake) recebe brief
  → CEO delega via Agent({ subagent_type: "marketing-lead", ... })
  → marketing-lead emite handoff artifact com self_score
  → CEO consolida, retorna
```

### Exemplo 3 — Mention entre employees

```
Employee A produz handoff:
{
  "from_agent": "marketing-lead",
  "to_agent": "ceo",
  "summary": "...",
  "next_action": "review",
  "business_extensions": {
    "type": "mention",
    "mention_text": "@alex-hormozi pode revisar o pricing?",
    "self_score": { "clarity": 0.92, "passes_threshold": true }
  }
}

Adapter detecta `@alex-hormozi` → Agent({ subagent_type: "alex-hormozi", prompt: "...marketing-lead pediu para revisar pricing..." })
```

### Exemplo 4 — Harness escalation (zero-human bridge)

```
Budget breach detected (Harness §H6):
  audit_event: budget_violation
  → emit HarnessNotification (severity: high)
  → AskUserQuestion({
      question: "Budget excedido em 20%. Continuar?",
      options: [{ label: "Aprovar overage" }, { label: "Abortar" }]
    })
  → audit_event: human_response_received
  → resume ou abort conforme resposta
```

---

## 12. Runtime-Specific Validators

Além de `validators.ts/.py`, Claude Code requer:

- **Subagent existence check**: cada `subagent_type` referenciado em employee `manages:` ou em mention deve existir como arquivo `~/.claude/agents/<name>.md` ou bundled na skill.
- **Slash command collision**: se squad/business tem `slashPrefix`, não pode colidir com built-in (`/clear`, `/help`, `/config`, `/loop`, `/schedule`, etc.).
- **Settings.json schema**: ao injetar permissions/hooks, validar contra schema do Claude Code (`update-config` skill conhece o schema).

---

## 13. Known Limitations

1. **Sem maxTurns hard nativo no Agent tool.** Mitigação via hook (§6).
2. **Sem broker de eventos.** Mentions/tickets dependem de file-system + memory; race conditions possíveis em multi-process. Para v1: single-process.
3. **OTel não é built-in.** Requer config externa (`OTEL_EXPORTER_OTLP_ENDPOINT` env var) ou fallback jsonl.
4. **Subagent context não tem quota explícita.** Cada `Agent` cria um fork novo; o budget é macroscópico (cost USD), não micro (tokens por sub).
5. **Slash commands não aceitam args estruturados.** Adapter passa args como string única; validators recebem e parseiam.
6. **Hooks rodam em shell**, não em JS — limitação para validações complexas. Workaround: hook chama um script Node/Python.
7. **`ScheduleWakeup` é específico** do Claude Code (não portável). Harness deve degradar para cron externo em runtimes que não suportam.
8. **Sem isolation forte por subagent.** Subagents compartilham fs/network do main process; isolation é por permissions, não por sandbox.

---

## 14. Source References

- Claude Code public docs: https://docs.claude.com/en/docs/claude-code
- Referência de implementação (caminhos relativos ao código do Claude Code):
  - `Skill.md` — modelo de skill
  - `src/tools/AgentTool/` — AgentTool, forkSubagent
  - `src/tools/TaskCreateTool/prompt.ts` — TaskCreate
  - `src/tools/TeamCreateTool/prompt.ts` — TeamCreate
  - `src/coordinator/coordinatorMode.ts` — coordenação multi-agent
- Squad Protocol v5: `~/.claude/skills/squads/SQUAD_PROTOCOL_V5.md`
- Business Protocol v1: `~/.claude/skills/businesses/BUSINESS_PROTOCOL_V1.md`
- Harness Protocol v1: `~/.claude/skills/harness/HARNESS_PROTOCOL_V1.md`

---

## 15. Version History

| Versão | Data | Mudanças |
|---|---|---|
| 1.0.0 | 2026-05-02 | Doc inicial — cobre Squad 5.0 + Business 1.0 + Harness 1.0 contra Claude Code 1.x (Opus 4.7) |
