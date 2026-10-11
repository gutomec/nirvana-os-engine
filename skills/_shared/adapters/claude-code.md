# Adapter · Claude Code

> Runtime adapter para Squad Protocol v5 + Business Protocol v1 + Harness Protocol v1.
> Cobre os 3 protocolos em um único doc. Seções canônicas conforme Squad v4 §18.5.
> Identidade + capabilities do sistema (o que o Nirvana-OS é e pode fazer): ver `../NIRVANA-OS.md` (fonte única).

---

## 1. Adapter metadata

| Campo | Valor |
|---|---|
| `runtime` | `claude-code` |
| `vendor` | Anthropic |
| `min_version` | Não é imposto pelo engine. O argv da §7 foi auditado no 2.1.284 e no 2.1.296; a correção de custo em resume pressupõe 2.1.277 ou posterior e mantém como está o valor por execução de um CLI mais antigo. O engine chama o CLI e não usa nenhum SDK da Anthropic. |
| `default_model` | herdado do runtime — o engine NUNCA define model; a config do runtime do usuário decide. Passe model só quando o usuário pedir explicitamente. |
| `tested_against` | Claude Code 2.1.296 (CLI, build nativo), auditado em 2026-10-11. Opus 5.5 é o Opus padrão desde o 2.1.280 |
| `config_paths` | `~/.claude/settings.json` (user), `<project>/.claude/settings.json`, `<project>/.claude/settings.local.json` |
| `skills_root` | `~/.nirvana/skills/` (user), `<project>/.claude/skills/` (project), bundled |
| `agents_root` | `~/.claude/agents/` (user), `<project>/.claude/agents/` (project) |
| `memory_root` | `~/.claude/memory/` (permanent), `<project>/CLAUDE.md` (project), conversation context (session) |
| `audit_log` | `~/.claude/projects/<project-id>/` (transcripts, tool results), `~/.harness-logs/` (harness OTel/jsonl) |
| `protocol_versions` | Squad 5.0, Business 1.0, Harness 1.0 |

---

## 2. Feature support matrix

`✓` = nativo · `~` = workaround/parcial · `✗` = não suportado

| Feature (Business v1 §6) | Squad v5 | Business v1 | Harness v1 | Notas |
|---|---|---|---|---|
| `max_turns` | ✓ | ✓ | ✓ | O runtime impõe: `maxTurns` no frontmatter do subagent, `--max-turns` no `claude -p`. O engine ainda não mapeia o `max_turns` do employee para a flag (§6) |
| `tool_whitelist` | ✓ | ✓ | ✓ | `tools:` no frontmatter + `permissions` em settings.json |
| `subagent_spawning` | ✓ | ✓ | ✓ | `Agent` tool com `subagent_type` (`Task` é o nome antigo, ainda aceito). A tool `Workflow` também abre agentes (§7) |
| `audit_trail` | ✓ | ✓ | ✓ | OTel se configurado, fallback para jsonl em `~/.harness-logs/` |
| `scheduled_invocation` | ✓ | ✓ | ✓ | `ScheduleWakeup`, `CronCreate` (deferred tools) |
| `event_bus` | ~ | ~ | ~ | Sem broker nativo. Mentions e tickets viajam por tool results + filesystem watch + memory polling. Documentado como limitação em §13. |
| `hooks` | ✓ | ✓ | ✓ | `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`, `SubagentStop`, `SessionStart`, `PreCompact`, `PostCompact` (§10) |
| `sandboxing` | ~ | ~ | ~ | `dangerouslyDisableSandbox` no Bash tool; sandbox é por permissão de tool, não por process isolation |
| `session_memory` | ✓ | ✓ | ✓ | Conversation context (auto-compactado) |
| `project_memory` | ✓ | ✓ | ✓ | `CLAUDE.md` + `<project>/.claude/memory/` |
| `global_memory` | ✓ | ✓ | ✓ | `~/.claude/CLAUDE.md` + `~/.claude/memory/` |
| `handoff_artifacts` | ✓ | ✓ | ✓ | Estrutura JSON em `tool_result` ou em arquivo persistido |
| `fork_context` | ✓ | ✓ | ✓ | Cada `Agent` invocation cria um sub-context isolado |
| `teammate_primitive` | ~ | ~ | ~ | Subagents servem de teammate por convenção; `TeamCreate` é deferred tool, não está disponível em todas as instalações. Quando indisponível o adapter cai para spawn paralelo de `Agent`. |
| `telemetry_otel` | ✓ | ✓ | ✓ | Via OTLP endpoint quando `HARNESS_TELEMETRY=otel` |

---

## 3. Concept mapping

| Conceito (Protocolo) | Equivalente Claude Code | Implementação |
|---|---|---|
| Squad / Business | Skill | Diretório `~/.nirvana/skills/<name>/SKILL.md` (frontmatter + body) |
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

## 4. Frontmatter mapping

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
# ~/.nirvana/skills/instagram-intelligence/SKILL.md frontmatter
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
# ~/.nirvana/skills/nexus-council/SKILL.md frontmatter
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

## 5. Tool whitelist mechanics

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

## 6. Max-turns mechanics

O Claude Code impõe limite de turns nativamente em dois lugares:

1. **Frontmatter do subagent**: `maxTurns: N` em `~/.claude/agents/<name>.md` limita aquele subagent.
2. **Execuções headless**: `claude -p --max-turns N`. A flag não aparece no `claude --help`, mas é aceita (conferido no 2.1.296). Uma execução que bate no limite termina com subtype `error_max_turns`; o `runClaudeCode` devolve isso em `resultSubtype` e cita no `error`.

O engine hoje não passa `--max-turns`, então o `max_turns` de um employee chega ao worker headless só como:

- **Informativo**: `maxTurns` no frontmatter do employee aparece no prompt ("você tem N turns").
- **Pre-flight budget**: o harness converte `maxTurns × estimated_cost_per_turn` em `budget.default_max_cost_usd` (Harness §6), e o `--max-budget-usd` encerra a execução (`error_max_budget_usd`).

Um hook pode acrescentar um contador onde nenhum dos limites nativos alcança. Um hook `PostToolUse` que devolve `{"continue": false}` quando a contagem estoura interrompe o processamento; `decision: "block"` no `PostToolUse` só mostra o motivo ao Claude, porque a tool já rodou. Schema atual (evento, grupo com matcher, lista de handlers):

```json
// settings.json hook (exemplo)
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Agent",
        "hooks": [
          { "type": "command", "command": "~/.claude/hooks/turn-counter.sh" }
        ]
      }
    ]
  }
}
```

**Limitação conhecida:** se o trabalho roda via `Skill` em vez de `Agent`, nem o `maxTurns` do subagent nem um matcher `Agent` o enxergam; só o `--max-turns` da sessão cobre esse caso.

---

## 7. Subagent spawning

Padrão: `Agent` tool com `subagent_type` apontando para o nome do agent definido em `~/.claude/agents/<name>.md`.

```typescript
// Pseudo-invocação interna
Agent({
  subagent_type: "alex-hormozi",
  description: "Offer review",
  prompt: "Review this offer for clarity and pricing...",
  // optional:
  isolation: "worktree" // git worktree para mudanças isoladas
})
```

O `Agent` tool é o **caminho PRIMÁRIO de dispatch**: roda in-process dentro da sessão do maestro, sem child `claude -p` e sem hard kill de 20 min de wall-clock — deliverables longos não são truncados.

O spawn devolve na hora um recibo (`"Async agent launched successfully"`) e a sessão segue livre. O trabalho chega depois, numa `<task-notification>` com `<result>` — é ali que está o relatório do subagente. Não passe `run_in_background: false`: bloqueia a sessão inteira pela duração do subagente (uma stack de deploy leva 45 min) e não traz nada que a notificação já não traga. O caminho headless `claude -p` (`host-agent-driver.runClaudeCode`) é o FALLBACK, usado só por scripts standalone sem contexto LLM próprio (o `dispatch.ts`).

**O argv headless, como o driver monta** (`skills/_shared/lib/host-agent-driver.ts`, conferido contra o `claude --help` do 2.1.296):

- `runClaudeCode`: `claude -p --output-format json`, depois `--resume <id>` numa revisão, `--model <m>` e `--effort <level>` só quando quem chama ou o pin do usuário define, `--tools ""` numa chamada sem tools, `--allowedTools` quando quem chama lista tools ou a autonomia está desligada, e então um destes: o `--permission-mode` de quem chama, `--permission-mode acceptEdits` (autonomia desligada) ou `--dangerously-skip-permissions` (o padrão). Em seguida `--disallowedTools Task Agent Workflow` salvo com `allowSubagents`, `--max-budget-usd`, `--settings`, cada `--add-dir` e, por último, a diretiva como `--append-system-prompt <texto>` (ou `--append-system-prompt-file <caminho>` quando o CLI é chamado por um shell, para que uma diretiva longa nunca trunque o argv). O prompt vai pelo stdin.
- `buildCall` (a entrada `claude-code` em `RUNTIMES`, usada pelo `callHostAgent` em judges e gates): `claude -p --no-session-persistence --output-format json`, `--dangerously-skip-permissions` com autonomia ligada, `--model` quando há pin, `--append-system-prompt <persona>`. A mensagem vai pelo stdin.
- Ambiente do filho (`headlessClaudeEnv`): `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` salvo se o usuário definiu, e `CLAUDE_CODE_DISABLE_WORKFLOWS=1` para um worker que não pode abrir agentes.

A flag de bypass é o padrão porque um filho sem TTY não tem como responder a um pedido de aprovação: num `-p`, as chamadas que ainda pediriam aprovação são negadas. O modo em que o `claude -p` começa sem flag depende da sessão: `default` (exibido como `manual`) onde o CLI busca feature flags, `auto` em provedores terceiros ou com telemetria desligada desde o 2.1.285. O engine não depende de nenhum dos dois. As opções de `--permission-mode` que o help lista são `acceptEdits`, `auto`, `bypassPermissions`, `manual`, `dontAsk`, `plan`; `default` saiu da lista, mas ainda é aceito como `manual`. Um worker alcança qualquer pasta e roda qualquer comando que o brief dele precisa, com qualquer modelo. `NIRVANA_HEADLESS_SKIP_PERMISSIONS=0` desliga a autonomia em todos os runtimes (o `claude -p` cai em `--allowedTools` + `--permission-mode acceptEdits`, o mesmo caminho de `nrv dispatch --safe`).

**Worker não abre agentes.** Negar `Task` e `Agent` não basta nos builds atuais: a tool `Workflow` roda workflows dinâmicos dentro do `claude -p`, o modo bypass aprova a chamada e uma execução pode abrir até 1.000 agentes. Os interruptores são `CLAUDE_CODE_DISABLE_WORKFLOWS=1`, `"disableWorkflows": true` nos settings ou uma regra deny em `Workflow`. O engine usa dois deles em todo worker, salvo quando quem chama passa `allowSubagents: true`: `--disallowedTools Task Agent Workflow` no argv e `CLAUDE_CODE_DISABLE_WORKFLOWS=1` no ambiente do filho.

**Custo em resume.** Desde o 2.1.277, o `total_cost_usd` de uma sessão retomada inclui o gasto das execuções que ela restaurou, então somar resultados conta em dobro. O engine registra o custo da própria execução: guarda no run ledger o último total informado por session id (`claude-session-cost.ts`) e, numa execução retomada, registra a diferença. Sem total anterior conhecido, ou quando o valor informado é menor que ele (CLI anterior ao 2.1.277), o valor informado é mantido. O `--max-budget-usd` conta só o gasto da própria chamada.

**`--bare`.** A documentação do CLI anuncia o `--bare` como futuro padrão do `-p`. Ele pula hooks, a descoberta de CLAUDE.md, OAuth e keychain (só API key ou `apiKeyHelper`), o que quebraria a autenticação por assinatura e o setup do `~/.nirvana`. O engine nunca passa essa flag.

**Para businesses (employees):** o adapter mapeia 1:1 — cada employee vira um subagent_type. CEO da business é o agent_type que tem `is_brief_intake: true`.

**Para squads (capabilities):** capability com `invoke.type: agent` mapeia para `Agent`; com `type: workflow` ou `type: task` pode rodar inline no escopo da skill.

---

## 8. Memory storage

| Camada | Path | Persistência |
|---|---|---|
| Permanent (cross-session) | `~/.claude/memory/<topic>.md` indexada por `~/.claude/memory/MEMORY.md` | Manual ou auto via `auto memory` |
| Project (per-cliente) | `<project>/.claude/memory/` + `<project>/CLAUDE.md` | Auto-load no start da sessão |
| Session | Conversation context | Compactado pelo runtime |
| Business permanent | `~/businesses/<biz>/memory/permanent.md` | Adapter persiste explicitly via Write |
| Project (business) | `<project>/<biz>/<project_id>/memory/` | Isolation by construction (Business v1 §9) |

> **Isolation guard (Harness §H10):** quando o adapter detecta tentativa de leitura de memory de outro `project_id`, emite `audit_event: isolation_violation` e bloqueia.

---

## 9. Context window e compaction

- Janela: definida pelo modelo que o usuário roda. `claude --autocompact <auto|tokens>` (100k a 1M) ou `CLAUDE_CODE_AUTO_COMPACT_WINDOW` (100000 a 1000000; valores menores viram 100K) antecipam o ponto em que a compaction começa.
- Compaction: automática quando perto do limit. `PreCompact` dispara antes (matcher `manual` ou `auto`), permitindo persistir state crítico, e `PostCompact` depois que ela termina.
- Para businesses long-running: forçar checkpoint via `Skill: harness#checkpoint` ao atingir 70% do context.

---

## 10. Hook system

Hooks são declarados por evento, como grupos com matcher que carregam cada um uma lista `hooks` de handlers (o JSON está na §6). O `type` do handler é `command`, `http`, `mcp_tool`, `prompt` ou `agent`. Eventos relevantes:

| Hook | Trigger | Uso para protocolo |
|---|---|---|
| `PreToolUse` | Antes de cada tool call | Enforce permissions, dry-run cost |
| `PostToolUse` | Depois de cada tool call | Turn counter, cost emission, audit |
| `UserPromptSubmit` | Cada prompt do user | Injetar harness preamble |
| `Stop` | Fim de turn | Persistir mention/ticket inbox |
| `SubagentStop` | Um subagent termina | Recolher handoff artifacts |
| `SessionStart` | Início de sessão | Carregar memory + verificar pending tickets |
| `PreCompact` | Antes da compaction (manual ou auto) | Salvar state crítico (Business v1 §9.3) |
| `PostCompact` | Depois que a compaction termina | Reinjetar o state que o resumo perdeu |

Configuração em `settings.json` (user, project ou local), no `hooks/hooks.json` de um plugin ou no frontmatter de skill e subagent. O `--bare` pula os hooks de settings e plugins. No `-p`, um settings que falha na validação é ignorado em silêncio. Ver `update-config` skill para syntax exata.

---

## 11. Invocation examples

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

## 12. Runtime-specific validators

Além de `validators.ts/.py`, Claude Code requer:

- **Subagent existence check**: cada `subagent_type` referenciado em employee `manages:` ou em mention deve existir como arquivo `~/.claude/agents/<name>.md` ou bundled na skill.
- **Slash command collision**: se squad/business tem `slashPrefix`, não pode colidir com built-in (`/clear`, `/help`, `/config`, `/loop`, `/schedule`, etc.).
- **Settings.json schema**: ao injetar permissions/hooks, validar contra schema do Claude Code (`update-config` skill conhece o schema).

---

## 13. Known limitations

1. **O engine não passa `--max-turns`.** O runtime impõe limite de turns (§6), mas o `max_turns` de um employee chega ao worker headless só como texto no prompt e como budget.
2. **Sem broker de eventos.** Mentions/tickets dependem de file-system + memory; race conditions possíveis em multi-process. Para v1: single-process.
3. **OTel não é built-in.** Requer config externa (`OTEL_EXPORTER_OTLP_ENDPOINT` env var) ou fallback jsonl.
4. **Subagent context não tem quota explícita.** Cada `Agent` cria um fork novo; o budget é macroscópico (cost USD), não micro (tokens por sub).
5. **Slash commands não aceitam args estruturados.** Adapter passa args como string única; validators recebem e parseiam.
6. **Hooks rodam em shell**, não em JS — limitação para validações complexas. Workaround: hook chama um script Node/Python.
7. **`ScheduleWakeup` é específico** do Claude Code (não portável). Harness deve degradar para cron externo em runtimes que não suportam.
8. **Sem isolation forte por subagent.** Subagents compartilham fs/network do main process; isolation é por permissions, não por sandbox.

---

## 14. Source references

- Claude Code public docs: https://code.claude.com/docs (headless: `/en/headless`, hooks: `/en/hooks`, permission modes: `/en/permission-modes`, workflows: `/en/workflows`, custo: `/en/agent-sdk/cost-tracking`)
- Referência de implementação (caminhos relativos ao código do Claude Code):
  - `Skill.md` — modelo de skill
  - `src/tools/AgentTool/` — AgentTool, forkSubagent
  - `src/tools/TaskCreateTool/prompt.ts` — TaskCreate
  - `src/tools/TeamCreateTool/prompt.ts` — TeamCreate
  - `src/coordinator/coordinatorMode.ts` — coordenação multi-agent
- Squad Protocol v5: `~/.nirvana/skills/squads/SQUAD_PROTOCOL_V5.md`
- Business Protocol v1: `~/.nirvana/skills/businesses/BUSINESS_PROTOCOL_V1.md`
- Harness Protocol v1: `~/.nirvana/skills/harness/HARNESS_PROTOCOL_V1.md`

---

## 15. Version history

| Versão | Data | Mudanças |
|---|---|---|
| 1.0.0 | 2026-05-02 | Doc inicial — cobre Squad 5.0 + Business 1.0 + Harness 1.0 contra Claude Code 1.x (Opus 4.7) |
| 1.1.0 | 2026-10-11 | Auditado contra o Claude Code 2.1.296 (Opus 5.5 como Opus padrão). Os eventos `PreCompact`/`PostCompact` substituem o inexistente `Compact`; o JSON de hook usa o schema `{matcher, hooks:[{type, command}]}`; `maxTurns`/`--max-turns` nativos e `error_max_turns`; modo de permissão inicial (`auto` em provedores terceiros ou com telemetria desligada desde o 2.1.285) e opções de `--permission-mode`; o argv headless real; a tool `Workflow` e a cerca do worker (`--disallowedTools Task Agent Workflow`, `CLAUDE_CODE_DISABLE_WORKFLOWS=1`); custo cumulativo em resume e a diferença registrada no ledger; `--bare` nunca passado; docs migrados para code.claude.com |
