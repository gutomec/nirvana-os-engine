# Adapter · Kimi Code CLI (Moonshot Kimi Code)

> Runtime adapter para Squad Protocol v5 + Business Protocol v1 + Harness Protocol v1.
> Cobre os 3 protocolos em um único doc. Seções canônicas conforme Squad v4 §18.5.
> Identidade + capabilities do sistema (o que o Nirvana-OS é e pode fazer): ver `../NIRVANA-OS.md` (fonte única).
> Espelha o `codex.md` (dispatch sub-process, sem agent-profile por arquivo).

---

## 1. Adapter Metadata

| Campo | Valor |
|---|---|
| `runtime` | `kimi-cli` |
| `vendor` | Moonshot AI |
| `min_version` | Kimi Code CLI (repo `MoonshotAI/kimi-code`, TypeScript) — versão não pinada ainda; `--output-format stream-json` exigido, com fallback para builds antigos (§7) |
| `default_model` | herdado do runtime — o engine NUNCA define model; vem da entrada `kimi-cli:<model>` do `LLM_CASCADE`. Passe model só quando o usuário pedir explicitamente. |
| `tested_against` | Kimi K3 (topo, MoE ~2.8T, 1M contexto, agêntico/coding, lançado 2026-07-16) e `kimi-for-coding` (K2.7) |
| `config_paths` | `~/.kimi-code/config.toml`, `<project>/AGENTS.md` |
| `skills_root` | Instala skills/MCP de repos GitHub; compatível com o dir universal `<project>/.agents/skills/` (já na truth table do engine) |
| `agents_root` | Sem agent-profile por arquivo (como o Codex `~/.codex/agents/`) — persona vai no prompt do `kimi -p` (ver §7) |
| `memory_root` | `<project>/AGENTS.md` (project) — Kimi não tem memory nativo cross-session rico |
| `audit_log` | `~/.harness-logs/` (jsonl via driver); Kimi não expõe transcript store canônico documentado |
| `protocol_versions` | Squad 5.0, Business 1.0, Harness 1.0 (com gaps registrados em §13) |

---

## 2. Feature Support Matrix

`✓` = nativo · `~` = workaround/parcial · `✗` = não suportado

| Feature (Business v1 §6) | Squad v5 | Business v1 | Harness v1 | Notas |
|---|---|---|---|---|
| `max_turns` | ~ | ~ | ~ | Sem flag per-employee confirmada; adapter simula via wrapper (timeout do sub-process + contagem no handoff) |
| `tool_whitelist` | ~ | ~ | ~ | Kimi é agentic-coding-first; sem `--allowedTools` confirmado. Whitelist via persona no prompt + gate no wrapper |
| `subagent_spawning` | ✗ | ✗ | ✗ | Subagents nativos NÃO confirmados. Fallback = execução sequencial dos steps do workflow; `kimi -p` sub-process para fan-out ao nível de OS |
| `audit_trail` | ~ | ~ | ~ | Sem transcript store documentado; harness adiciona jsonl via `runKimi` |
| `scheduled_invocation` | ✗ | ✗ | ✗ | Sem `ScheduleWakeup`/`CronCreate` — degradar para cron externo |
| `event_bus` | ~ | ~ | ~ | Mentions/tickets via file-system; sem broker |
| `hooks` | ~ | ~ | ~ | Sem hook system granular confirmado; validações complexas em wrapper |
| `sandboxing` | ~ | ~ | ~ | Sem profiles de sandbox documentados como os do Codex; isolar via cwd + permissões do OS |
| `session_memory` | ✓ | ✓ | ✓ | Contexto por sessão (1M window no K3) |
| `project_memory` | ✓ | ✓ | ✓ | `AGENTS.md` no projeto (convenção compartilhada com Codex/Antigravity) |
| `global_memory` | ~ | ~ | ~ | Sem auto-discovery rico como `~/.claude/memory/` |
| `handoff_artifacts` | ✓ | ✓ | ✓ | JSON extraído do stdout (`stream-json` NDJSON, ou texto puro no fallback) |
| `fork_context` | ~ | ~ | ~ | Sub-process spawn cria fork; sem isolation forte |
| `teammate_primitive` | ✗ | ✗ | ✗ | Sem `TeamCreate`; team é convenção via file system |
| `telemetry_otel` | ~ | ~ | ~ | OTel via OpenTelemetry SDK externo (não built-in) |
| `mcp` | ✓ | ✓ | ✓ | MCP nativo via `--mcp-config-file`; instala MCP/skills de repos GitHub |

> **Nota fora da matriz canônica:** o grande diferencial do Kimi é o par **contexto 1M + modelos open-weight** (K3 com open-weights prometidos ~2026-07-27) e a **rota OAuth grátis** (§8/§13), não novos primitives de orquestração.

---

## 3. Concept Mapping

| Conceito (Protocolo) | Equivalente Kimi Code | Implementação |
|---|---|---|
| Squad / Business | Diretório de skills + AGENTS.md | `<project>/.agents/skills/<name>/` + `AGENTS.md` do CWD |
| Capability | Workflow file | `<skill>/capabilities/<id>.md` invocado por wrapper |
| Employee | Persona embutida no prompt do `kimi -p` | persona-núcleo + DNA no corpo do prompt; não é arquivo de agent como no Codex |
| `is_brief_intake: true` | Persona default quando skill ativa | Montada no prompt / `AGENTS.md` do skill |
| `is_antagonist: true` | Sub-process invocado em pipeline | `kimi -m <model> -p "<persona+brief>" --output-format stream-json` |
| Handoff artifact | JSON no stdout (NDJSON) + arquivo | Persistido em `<project>/.handoffs/` |
| Mention `@employee` | Convenção no handoff | Adapter detecta → novo sub-process |
| Ticket | Arquivo persistido | `<project>/.tickets/<TICKET_ID>.json` |
| Escalation trigger | Wrapper script + harness call | Wrapper checa condição → emite notification para harness |
| Permanent memory | `<project>/AGENTS.md` + custom files | Sem auto-load global rico |
| Project memory | `<project>/AGENTS.md` | Convenção (load depende da versão) |
| Session memory | Conversation transcript | Compactado / janela 1M reduz pressão |
| Routing decision (harness) | Pre-spawn lookup table | BM25 sobre `capabilities[].examples[]` em wrapper Bun/Node |

---

## 4. Frontmatter Mapping

### Squad v5 / Business v1 → AGENTS.md

Kimi não tem frontmatter rico no head do skill. O adapter gera dois arquivos (mesma tática do Codex/Antigravity):

```yaml
# AGENTS.md (head do projeto/skill)
You are an AI agent operating under the Squad/Business Protocol.

Available capabilities: [media.video.analyze, media.transcript.extract, ...]
Default tools: [Read, Write, Bash]
```

```yaml
# .agents/manifest.yaml (auxiliar — lido por wrapper, não pelo Kimi)
name: nexus-council
protocol: 1.0
employees: [ceo, marketing-lead, ...]
operation_mode: zero_human
```

### Employee → prompt do `kimi -p`

Kimi não tem agent-profile por arquivo. A persona do employee é montada no prompt:

```
<persona-núcleo do employee (frontmatter → topo)>
<DNA do mind-clone — injectMindClones().combined_prompt>
## Brief
<brief enriquecido>
## Tools permitidos
<tool whitelist>
## Contrato de saída
Responda SOMENTE com um único objeto JSON: {...}
```

> Para `type: mind_clone`, o adapter **prepende** `(DISCLOSURE: AI-generated persona, not a real person.)` na persona, igual ao Codex.

---

## 5. Tool Whitelist Mechanics

- Kimi é agentic-coding-first e usa function-calling interno; **não há flag `--allowedTools` confirmada**. O whitelist é aplicado de dois modos:
  - **Persona no prompt**: declarar explicitamente as tools permitidas ("## Tools permitidos") e proibir o resto.
  - **Gate no wrapper**: o wrapper roda com cwd restrito e permissões do OS; comandos fora do escopo do brief são barrados fora do runtime.
- Mapeamento semantic tools → intenção Kimi:
  - `read` → leitura de arquivo
  - `write` / `edit` → escrita/edição de arquivo
  - `bash` → execução de comando
  - `web_fetch` → fetch de URL
- MCP servers (nativo, via `--mcp-config-file`) aparecem como tools adicionais; incluir/excluir por prefixo `mcp__<server>__`.

---

## 6. Max-Turns Mechanics

Kimi **não** expõe um `--max-turns` per-employee confirmado. Adapter simula assim:

1. Cada employee roda como sub-process `kimi -p`, com `timeout` do wrapper (`opts.timeoutMs` → `spawnSync`).
2. Contagem lógica de turns vem do handoff (o employee reporta steps executados).
3. Estouro de timeout → o sub-process termina; o wrapper registra `audit_event: budget_violation`.

**Limitação:** sem contagem per-turn fina do runtime. Documentar como `~` (parcial). Recomenda-se employees flat (sem invocação aninhada dentro de um único `-p`).

---

## 7. Subagent Spawning

**Sem subagent primitive confirmado.** Diferente do Codex (blocos `[agents]`) e do Antigravity (subagents dinâmicos in-process), o Kimi **não tem** subagents nativos confirmados na pesquisa. O caminho é sempre **sub-process** `kimi -p` (`host-agent-driver.runKimi`):

```bash
# Adapter spawn (host-agent-driver.runKimi)
kimi -m <model> -p "Review this offer: ..." \
  --output-format stream-json \
  > .handoffs/alex-hormozi-$(date +%s).ndjson
```

Flags reais usadas pelo driver:
- `-p "<prompt>"` — prompt headless (one-shot, sem TUI).
- `-m/--model <id>` — seleciona o modelo (ex.: `k3` = Kimi K3; `kimi-for-coding` = K2.7). Vem só da entrada `kimi-cli:<model>` do cascade — nunca hardcoded.
- `--output-format stream-json` — NDJSON (1 objeto por linha); resposta acumulada no stdout, progresso no stderr. **Builds antigos podem não ter a flag** → o driver detecta o erro (`output-format|unknown|unrecognized|invalid option`) e **re-executa sem ela** (stdout então carrega o texto puro do assistant).

O driver extrai o texto final do assistant defensivamente dos eventos NDJSON (schema varia por build); se o stdout não for NDJSON (caminho de fallback), mantém o stdout inteiro. Retorna handoff artifact que o adapter parseia e registra em audit log.

> **Sem `--resume`.** `runKimi` gera o próprio `sessionId` e **não** passa flag de retomada nativa. Continuação de contexto é via `HANDOFF.json` + novo sub-process (ver `agent-x.kimi.md` §4), não via sessão persistida do runtime.

**Para mention `@x`:** adapter detecta no handoff retornado, abre novo sub-process para `x`.

**Fan-out paralelo:** simulado ao nível do OS (o harness dispara sub-processes `kimi -p` independentes para steps independentes), não dentro do Kimi.

---

## 8. Memory Storage

| Camada | Path | Persistência |
|---|---|---|
| Permanent (cross-session) | `<project>/AGENTS.md` + files custom | Manual |
| Project | `<project>/AGENTS.md` | Convenção (load depende da versão) |
| Session | Conversation transcript | Compactado; janela 1M reduz pressão |
| Business permanent | `~/businesses/<biz>/memory/permanent.md` | Adapter persiste |
| Project (business) | `<project>/<biz>/<project_id>/memory/` | Isolation by construction |

> **Isolation guard:** Kimi não enforça memory isolation natively. Adapter monta o prompt com APENAS o memory relevante ao `project_id` antes de spawn — caso contrário `audit_event: isolation_violation`.

**Autenticação (não é env var do shell).** O Kimi **não lê** `MOONSHOT_API_KEY`/env do shell automaticamente. A credencial vem de uma de duas rotas:

- **OAuth grátis** — `kimi` → `/login` com conta Kimi.com (sem API key). Rota **grátis e agêntica**; custo rastreado = **$0** (o driver reporta `costUsd: null`, igual a gemini/agy). Cota: janela rolante ~5h, ~300–1200 chamadas — checar `/usage`.
- **`~/.kimi-code/config.toml` (paga)** — bloco `[providers.<id>] type="openai" base_url=... api_key=...` apontando para Moonshot (`https://api.moonshot.ai/v1`, key `MOONSHOT_API_KEY`) ou OpenRouter. Custo = pay-per-token do provider.

---

## 9. Context Window & Compaction

- Janela: **1M tokens** (Kimi K3 — maior que Claude/Codex, comparável ao Gemini/Antigravity).
- Compaction: a janela grande reduz a pressão por compaction em businesses long-running.
- **Vantagem:** brief que consome >100K tokens (análise de código grande, document review extenso) roda sem truncamento agressivo.

---

## 10. Hook System

Kimi não tem hooks granulares confirmados. Workarounds em wrapper:

| Hook desejado | Workaround Kimi |
|---|---|
| `PreToolUse` | Persona no prompt age como soft-validator; hard validation em wrapper |
| `PostToolUse` | Wrapper parseia o handoff / stdout após o run |
| `UserPromptSubmit` | Adapter injeta instructions no prompt do `kimi -p` |
| `Stop` | Wrapper inspeciona exit code e output final |
| `SessionStart` | Wrapper carrega memory antes de invocar `kimi -p` |
| `Compact` | Sem flag confirmada; janela 1M mitiga |

---

## 11. Invocation Examples

### Exemplo 1 — Squad capability

```bash
# User: "transcrever vídeo do Instagram https://..."
# Harness wrapper:
kimi -m <model> -p "You are instagram-intelligence. Analyze video: https://..." \
  --output-format stream-json
```

### Exemplo 2 — Business brief com handoff em pipeline

```bash
# CEO recebe brief
kimi -m <model> -p "<persona ceo + brief + contrato JSON>" --output-format stream-json \
  > .handoffs/ceo-1.ndjson

# Adapter detecta `next_action: delegate to marketing-lead`
kimi -m <model> -p "<persona marketing + contexto do ceo + contrato JSON>" --output-format stream-json \
  > .handoffs/marketing-1.ndjson

# Adapter detecta mention `@alex-hormozi`
kimi -m <model> -p "<persona alex + DNA + contexto + contrato JSON>" --output-format stream-json \
  > .handoffs/alex-1.ndjson
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

- **Credencial presente**: OAuth (`kimi` logado) OU `[providers.<id>]` em `~/.kimi-code/config.toml`. Sem nenhuma das duas, o dispatch falha — o wrapper checa antes de spawn.
- **Model resolvível**: `kimi-cli:<model>` do cascade tem que existir (ex.: `k3`, `kimi-for-coding`); wrapper valida contra o catálogo do provider.
- **MCP server reachability**: se a persona referencia `mcp__<server>__*`, validar que o server está no `--mcp-config-file`.
- **AGENTS.md carregado**: o wrapper garante que o `AGENTS.md`/manifest é injetado no prompt (Kimi não faz auto-discovery rico).

---

## 13. Known Limitations

1. **Sem subagent primitive** → adapter usa sub-process `kimi -p`. Custo: cada spawn paga overhead de cold start; fan-out fica no wrapper.
2. **Sem hooks granulares** → validações em wrapper externo, não inline.
3. **Sem `ScheduleWakeup` / `CronCreate`** → harness degradar para cron externo.
4. **Sem memory cross-session rico** → adapter mantém memory em files, monta prompt manualmente.
5. **Max-turns per-employee é simulado** (timeout + contagem no handoff) → assume employees flat.
6. **Sem `TeamCreate`** → teams são convenção em file-system.
7. **OTel não é built-in** → adapter integra com OpenTelemetry SDK externo.
8. **`--output-format stream-json` pode faltar** em builds antigos → driver re-executa em texto puro (parse do stdout inteiro).
9. **Auth não vem de env var do shell** → OAuth (`/login`) ou `config.toml`; o wrapper valida antes de dispatch.
10. **Tool whitelist não é hard-enforced** pelo runtime → depende da persona no prompt + gate do wrapper.
11. **Superfície de flags recente/instável** (repo `MoonshotAI/kimi-code`) → testar `kimi --help` contra a versão instalada antes de cada bump.

**Vantagem compensatória:** janela 1M + modelos open-weight (K3, open-weights ~2026-07-27) + rota OAuth grátis ($0 rastreado) — bom fit para briefs de contexto gigante sem custo por token.

---

## 14. Source References

- Kimi Code CLI: repo `MoonshotAI/kimi-code` (TypeScript); install `curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash` (ou npm global).
- Moonshot API: `https://api.moonshot.ai/v1` (key `MOONSHOT_API_KEY`).
- Driver: `skills/harness/lib/host-agent-driver.ts` (`runKimi`).
- Squad Protocol v5: `~/.claude/skills/squads/SQUAD_PROTOCOL_V5.md`
- Business Protocol v1: `~/.claude/skills/businesses/BUSINESS_PROTOCOL_V1.md`
- Harness Protocol v1: `~/.claude/skills/harness/HARNESS_PROTOCOL_V1.md`

---

## 15. Version History

| Versão | Data | Mudanças |
|---|---|---|
| 1.0.0 | 2026-07-19 | Doc inicial — cobre Squad 5.0 + Business 1.0 + Harness 1.0 contra Kimi Code CLI (`MoonshotAI/kimi-code`), K3 / kimi-for-coding. Dispatch via `kimi -p` (sub-process, NDJSON→texto). |
