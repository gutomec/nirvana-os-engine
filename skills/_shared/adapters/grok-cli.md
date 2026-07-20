# Adapter · Grok Build CLI (xAI Grok)

> Runtime adapter para Squad Protocol v5 + Business Protocol v1 + Harness Protocol v1.
> Cobre os 3 protocolos em um único doc. Seções canônicas conforme Squad v4 §18.5.
> Identidade + capabilities do sistema (o que o Nirvana-OS é e pode fazer): ver `../NIRVANA-OS.md` (fonte única).
> Espelha o `codex.md` / `kimi-cli.md` (dispatch sub-process, sem agent-profile por arquivo).

---

## 1. Adapter Metadata

| Campo | Valor |
|---|---|
| `runtime` | `grok-cli` |
| `vendor` | xAI |
| `min_version` | Grok Build CLI (binário `grok`, `~/.grok/bin/grok`, `grok 0.2.103`) — flags headless `-p --output-format json --yolo`; versão não pinada |
| `default_model` | herdado do runtime — o engine NUNCA define model; vem da entrada `grok-cli:<model>` do `LLM_CASCADE`. Passe model só quando o usuário pedir explicitamente. |
| `tested_against` | `grok 0.2.103`; família Grok (`grok-code`, `grok-4`/`grok-4-fast`) — o model default do runtime ou o escolhido pelo usuário via `LLM_CASCADE`, nunca hardcoded |
| `config_paths` | `~/.grok/` (sessão/login do Build CLI), `<project>/AGENTS.md` |
| `skills_root` | Compatível com o dir universal `<project>/.agents/skills/` (mesma família dos CLIs agênticos; já na truth table do engine) |
| `agents_root` | Sem agent-profile por arquivo (como o Codex `~/.codex/agents/`) — persona vai no prompt do `grok -p` ou via `--system-prompt-override` (ver §7) |
| `memory_root` | `<project>/AGENTS.md` (project) — Grok não tem memory nativo cross-session rico |
| `audit_log` | `~/.harness-logs/` (jsonl via driver); Grok não expõe transcript store canônico documentado |
| `protocol_versions` | Squad 5.0, Business 1.0, Harness 1.0 (com gaps registrados em §13) |

---

## 2. Feature Support Matrix

`✓` = nativo · `~` = workaround/parcial · `✗` = não suportado

| Feature (Business v1 §6) | Squad v5 | Business v1 | Harness v1 | Notas |
|---|---|---|---|---|
| `max_turns` | ✓ | ✓ | ✓ | Flag nativa `--max-turns <N>`; o wrapper passa `opts.maxTurns` do employee direto ao runtime |
| `tool_whitelist` | ~ | ~ | ~ | Sem `--allowedTools`; `--permission-mode <MODE>` + `--yolo` controlam aprovação global. Whitelist fina via persona no prompt + gate no wrapper |
| `subagent_spawning` | ✗ | ✗ | ✗ | Subagents nativos NÃO confirmados. Fallback = execução sequencial dos steps do workflow; `grok -p` sub-process para fan-out ao nível de OS |
| `audit_trail` | ~ | ~ | ~ | Sem transcript store documentado; harness adiciona jsonl via `runGrok` |
| `scheduled_invocation` | ✗ | ✗ | ✗ | Sem `ScheduleWakeup`/`CronCreate` — degradar para cron externo |
| `event_bus` | ~ | ~ | ~ | Mentions/tickets via file-system; sem broker |
| `hooks` | ~ | ~ | ~ | Sem hook system granular confirmado; `--permission-mode` dá controle grosso; validações complexas em wrapper |
| `sandboxing` | ~ | ~ | ~ | `--permission-mode` + `--cwd` isolam; sem profiles de sandbox ricos como os do Codex |
| `session_memory` | ✓ | ✓ | ✓ | Contexto por sessão (janela da família Grok) |
| `project_memory` | ✓ | ✓ | ✓ | `AGENTS.md` no projeto (convenção compartilhada com Codex/Antigravity/Kimi) |
| `global_memory` | ~ | ~ | ~ | Sem auto-discovery rico como `~/.claude/memory/` |
| `handoff_artifacts` | ✓ | ✓ | ✓ | JSON extraído do stdout (`--output-format json`); `--json-schema` força o shape estruturado |
| `fork_context` | ~ | ~ | ~ | Sub-process spawn cria fork; sem isolation forte |
| `teammate_primitive` | ✗ | ✗ | ✗ | Sem `TeamCreate`; team é convenção via file system |
| `telemetry_otel` | ~ | ~ | ~ | OTel via OpenTelemetry SDK externo (não built-in) |
| `mcp` | ✓ | ✓ | ✓ | MCP compatível (família CLI agêntica); skills via `<project>/.agents/skills/` |

> **Nota fora da matriz canônica:** o grande diferencial do Grok é a **geração de mídia embutida no Build CLI** (`image_gen` / `image_edit` / `image_to_video`) somada à **rota assinatura de custo marginal $0** (§8/§13), não novos primitives de orquestração. Reforços concretos sobre os pares agênticos: `--max-turns` nativo e structured output via `--json-schema`.

---

## 3. Concept Mapping

| Conceito (Protocolo) | Equivalente Grok Build CLI | Implementação |
|---|---|---|
| Squad / Business | Diretório de skills + AGENTS.md | `<project>/.agents/skills/<name>/` + `AGENTS.md` do CWD |
| Capability | Workflow file | `<skill>/capabilities/<id>.md` invocado por wrapper |
| Employee | Persona embutida no prompt do `grok -p` | persona-núcleo + DNA no corpo do prompt (ou `--system-prompt-override`); não é arquivo de agent como no Codex |
| `is_brief_intake: true` | Persona default quando skill ativa | Montada no prompt / `AGENTS.md` do skill |
| `is_antagonist: true` | Sub-process invocado em pipeline | `grok -m <model> -p "<persona+brief>" --output-format json --yolo` |
| Handoff artifact | JSON no stdout | Persistido em `<project>/.handoffs/` |
| Mention `@employee` | Convenção no handoff | Adapter detecta → novo sub-process |
| Ticket | Arquivo persistido | `<project>/.tickets/<TICKET_ID>.json` |
| Escalation trigger | Wrapper script + harness call | Wrapper checa condição → emite notification para harness |
| Permanent memory | `<project>/AGENTS.md` + custom files | Sem auto-load global rico |
| Project memory | `<project>/AGENTS.md` | Convenção (load depende da versão) |
| Session memory | Conversation transcript | Janela da família Grok reduz pressão |
| Routing decision (harness) | Pre-spawn lookup table | BM25 sobre `capabilities[].examples[]` em wrapper Bun/Node |

---

## 4. Frontmatter Mapping

### Squad v5 / Business v1 → AGENTS.md

Grok não tem frontmatter rico no head do skill. O adapter gera dois arquivos (mesma tática do Codex/Antigravity/Kimi):

```yaml
# AGENTS.md (head do projeto/skill)
You are an AI agent operating under the Squad/Business Protocol.

Available capabilities: [media.video.analyze, media.transcript.extract, ...]
Default tools: [Read, Write, Bash]
```

```yaml
# .agents/manifest.yaml (auxiliar — lido por wrapper, não pelo Grok)
name: nexus-council
protocol: 1.0
employees: [ceo, marketing-lead, ...]
operation_mode: zero_human
```

### Employee → prompt do `grok -p`

Grok não tem agent-profile por arquivo. A persona do employee é montada no prompt (ou passada em bloco separado via `--system-prompt-override`):

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

- Grok é agentic-coding-first e usa function-calling interno; **não há flag `--allowedTools` confirmada**. O runtime expõe controle de aprovação grosso via `--permission-mode <MODE>` e `--yolo` (auto-approve de todas as tool executions, usado no modo headless). O whitelist fino é aplicado de dois modos:
  - **Persona no prompt**: declarar explicitamente as tools permitidas ("## Tools permitidos") e proibir o resto.
  - **Gate no wrapper**: o wrapper roda com `--cwd` restrito e permissões do OS; comandos fora do escopo do brief são barrados fora do runtime.
- Mapeamento semantic tools → intenção Grok:
  - `read` → leitura de arquivo
  - `write` / `edit` → escrita/edição de arquivo
  - `bash` → execução de comando
  - `web_fetch` → fetch de URL
- MCP servers aparecem como tools adicionais; incluir/excluir por prefixo `mcp__<server>__`.
- **Mídia embutida:** `image_gen` / `image_edit` / `image_to_video` são tools nativas do Build CLI — expostas ao employee quando a persona as declara.

---

## 6. Max-Turns Mechanics

Grok **expõe** `--max-turns <N>` nativo. O adapter usa assim:

1. Cada employee roda como sub-process `grok -p`, com `--max-turns <N>` derivado do `maxTurns` do employee (`opts.maxTurns` → argv), mais `timeout` do wrapper (`opts.timeoutMs` → `spawnSync`) como cinto de segurança.
2. Contagem lógica de turns também vem do handoff (o employee reporta steps executados).
3. Estouro de turns ou timeout → o sub-process termina; o wrapper registra `audit_event: budget_violation`.

**Limitação residual:** teto nativo existe, mas sem introspecção per-turn fina do runtime. Recomenda-se employees flat (sem invocação aninhada dentro de um único `-p`).

---

## 7. Subagent Spawning

**Sem subagent primitive confirmado.** Diferente do Codex (blocos `[agents]`) e do Antigravity (subagents dinâmicos in-process), o Grok **não tem** subagents nativos confirmados na pesquisa. O caminho é sempre **sub-process** `grok -p` (`host-agent-driver.runGrok`):

```bash
# Adapter spawn (host-agent-driver.runGrok)
grok -m <model> -p "Review this offer: ..." \
  --output-format json --yolo --cwd <dir> \
  > .handoffs/alex-hormozi-$(date +%s).json
```

Flags reais usadas pelo driver:
- `-p, --single "<prompt>"` — prompt headless one-shot (sem TUI).
- `-m, --model <id>` — seleciona o modelo (ex.: `grok-code`, `grok-4`, `grok-4-fast`). Vem só da entrada `grok-cli:<model>` do cascade — nunca hardcoded.
- `--output-format <plain|json|streaming-json>` — default `plain`; o driver passa **`json`** (objeto único no stdout). `streaming-json` disponível para progresso incremental.
- `--yolo` — auto-approve de todas as tool executions (autonomia headless).
- `--cwd <dir>` — working dir do run.
- `--max-turns <N>` — teto de turns (ver §6).
- `--json-schema <schema>` — força o shape do output estruturado (endurece o contrato de saída do handoff).
- `--system-prompt-override <text>` / `--prompt-file <path>` — persona/prompt via flag ou arquivo em vez de argv.

O driver extrai o objeto JSON final do stdout defensivamente; se o build não suportar `--output-format json` (default é `plain`), o driver detecta o erro (`output-format|unknown|unrecognized|invalid option`) e **re-executa em `plain`** (o stdout então carrega o texto puro do assistant, e o adapter parseia o JSON embutido). Retorna handoff artifact que o adapter registra em audit log.

> **Sem `--resume`.** `runGrok` gera o próprio `sessionId` e **não** passa flag de retomada nativa. Continuação de contexto é via `HANDOFF.json` + novo sub-process (ver `agent-x.grok.md` §4), não via sessão persistida do runtime.

**Para mention `@x`:** adapter detecta no handoff retornado, abre novo sub-process para `x`.

**Fan-out paralelo:** simulado ao nível do OS (o harness dispara sub-processes `grok -p` independentes para steps independentes), não dentro do Grok.

---

## 8. Memory Storage

| Camada | Path | Persistência |
|---|---|---|
| Permanent (cross-session) | `<project>/AGENTS.md` + files custom | Manual |
| Project | `<project>/AGENTS.md` | Convenção (load depende da versão) |
| Session | Conversation transcript | Janela da família Grok reduz pressão |
| Business permanent | `~/businesses/<biz>/memory/permanent.md` | Adapter persiste |
| Project (business) | `<project>/<biz>/<project_id>/memory/` | Isolation by construction |

> **Isolation guard:** Grok não enforça memory isolation natively. Adapter monta o prompt com APENAS o memory relevante ao `project_id` antes de spawn — caso contrário `audit_event: isolation_violation`.

**Autenticação — dois trilhos.** O engine é model-agnostic: o model vem SÓ da entrada `grok-cli:<model>` do cascade. A credencial vem de uma de duas rotas:

- **Assinatura via `grok` login** — o Grok Build CLI logado numa conta xAI. Rota **agêntica de custo marginal $0** na assinatura; custo rastreado = **$0** (o driver reporta `costUsd: null`, igual a agy/gemini/kimi). É a rota que o squad **`grok-studio-nirvana`** usa.
- **API xAI via `XAI_API_KEY` (paga)** — chave no ambiente apontando para a API da xAI. Custo = pay-per-token.

---

## 9. Context Window & Compaction

- Janela: **depende do modelo Grok** escolhido via `LLM_CASCADE` — a família `grok-4`/`grok-4-fast` oferece janelas grandes. O engine não fixa número.
- Compaction: janela ampla reduz a pressão por compaction em businesses long-running.
- **Vantagem:** brief de contexto grande (análise de código extensa, document review) roda sem truncamento agressivo — e, quando o brief pede artefato visual, `image_gen`/`image_edit`/`image_to_video` resolvem no mesmo runtime.

---

## 10. Hook System

Grok não tem hooks granulares confirmados. Workarounds em wrapper (`--permission-mode` cobre o gate grosso pré-tool):

| Hook desejado | Workaround Grok |
|---|---|
| `PreToolUse` | `--permission-mode` age como gate grosso; persona no prompt como soft-validator; hard validation em wrapper |
| `PostToolUse` | Wrapper parseia o handoff / stdout após o run |
| `UserPromptSubmit` | Adapter injeta instructions no prompt do `grok -p` (ou `--system-prompt-override`) |
| `Stop` | Wrapper inspeciona exit code e output final |
| `SessionStart` | Wrapper carrega memory antes de invocar `grok -p` |
| `Compact` | Sem flag confirmada; janela grande da família Grok mitiga |

---

## 11. Invocation Examples

### Exemplo 1 — Squad capability

```bash
# User: "gerar key visual do lançamento e um teaser vertical"
# Harness wrapper:
grok -m <model> -p "You are grok-studio. image_gen key visual ..., then image_to_video teaser 9:16 ..." \
  --output-format json --yolo --cwd <dir>
```

### Exemplo 2 — Business brief com handoff em pipeline

```bash
# CEO recebe brief
grok -m <model> -p "<persona ceo + brief + contrato JSON>" --output-format json --yolo --cwd <dir> \
  > .handoffs/ceo-1.json

# Adapter detecta `next_action: delegate to marketing-lead`
grok -m <model> -p "<persona marketing + contexto do ceo + contrato JSON>" --output-format json --yolo --cwd <dir> \
  > .handoffs/marketing-1.json

# Adapter detecta mention `@alex-hormozi`
grok -m <model> -p "<persona alex + DNA + contexto + contrato JSON>" --output-format json --yolo --cwd <dir> \
  > .handoffs/alex-1.json
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

- **Credencial presente**: assinatura (`grok` logado) OU `XAI_API_KEY` no ambiente (rota API). Sem nenhuma das duas, o dispatch falha — o wrapper checa antes de spawn.
- **Model resolvível**: `grok-cli:<model>` do cascade tem que existir (ex.: `grok-code`, `grok-4`, `grok-4-fast`); wrapper valida contra o catálogo do provider.
- **MCP server reachability**: se a persona referencia `mcp__<server>__*`, validar que o server está configurado.
- **AGENTS.md carregado**: o wrapper garante que o `AGENTS.md`/manifest é injetado no prompt (Grok não faz auto-discovery rico).

---

## 13. Known Limitations

1. **Sem subagent primitive** → adapter usa sub-process `grok -p`. Custo: cada spawn paga overhead de cold start; fan-out fica no wrapper.
2. **Sem hooks granulares** → validações em wrapper externo; `--permission-mode` cobre só o gate grosso.
3. **Sem `ScheduleWakeup` / `CronCreate`** → harness degradar para cron externo.
4. **Sem memory cross-session rico** → adapter mantém memory em files, monta prompt manualmente.
5. **Max-turns tem teto nativo** (`--max-turns`), mas sem introspecção per-turn fina do runtime → assume employees flat.
6. **Sem `TeamCreate`** → teams são convenção em file-system.
7. **OTel não é built-in** → adapter integra com OpenTelemetry SDK externo.
8. **`--output-format` default é `plain`** → o wrapper passa `json` explícito; builds sem a flag caem para `plain` (parse do JSON embutido no stdout).
9. **Auth em dois trilhos** → assinatura (`grok` login) OU `XAI_API_KEY` (env, rota paga); o wrapper valida antes de dispatch.
10. **Tool whitelist não é hard-enforced** pelo runtime (só `--permission-mode`/`--yolo` grosso) → depende da persona no prompt + gate do wrapper.
11. **Superfície de flags recente/instável** (`grok 0.2.103`) → testar `grok --help` contra a versão instalada antes de cada bump.

**Vantagem compensatória:** geração de mídia embutida (`image_gen` / `image_edit` / `image_to_video`) + rota assinatura de custo marginal $0 ($0 rastreado) + structured output (`--json-schema`) + `--max-turns` nativo — bom fit para briefs que misturam código e artefato visual no mesmo runtime.

---

## 14. Source References

- Grok Build CLI (xAI): binário `grok` (`~/.grok/bin/grok`), `grok 0.2.103`; headless via `grok -p "<prompt>" --output-format json --yolo --cwd <dir>`.
- xAI API: rota paga via `XAI_API_KEY` (pay-per-token).
- Driver: `skills/harness/lib/host-agent-driver.ts` (`runGrok`).
- Squad de referência (rota assinatura): `grok-studio-nirvana`.
- Squad Protocol v5: `~/.claude/skills/squads/SQUAD_PROTOCOL_V5.md`
- Business Protocol v1: `~/.claude/skills/businesses/BUSINESS_PROTOCOL_V1.md`
- Harness Protocol v1: `~/.claude/skills/harness/HARNESS_PROTOCOL_V1.md`

---

## 15. Version History

| Versão | Data | Mudanças |
|---|---|---|
| 1.0.0 | 2026-07-20 | Doc inicial — cobre Squad 5.0 + Business 1.0 + Harness 1.0 contra Grok Build CLI (`grok 0.2.103`), família Grok (`grok-code` / `grok-4` / `grok-4-fast`). Dispatch via `grok -p --output-format json --yolo --cwd`. |
