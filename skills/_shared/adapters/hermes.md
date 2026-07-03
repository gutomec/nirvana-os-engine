# Adapter · Hermes (Hermes Agent CLI)

> Runtime adapter para Squad Protocol v5 + Business Protocol v1 + Harness Protocol v1.
> Cobre os 3 protocolos em um único doc. Seções canônicas conforme Squad v4 §18.5.
> Identidade + capabilities do sistema (o que o Nirvana-OS é e pode fazer): ver `../NIRVANA-OS.md` (fonte única).
> Espelha o `codex.md` (sub-process dispatch). Tudo verificado contra o Hermes real
> instalado (`~/.hermes/`, v0.13.x) e o código (`agent/shell_hooks.py`, `agent/prompt_builder.py`).

---

## 1. Adapter Metadata

| Campo | Valor |
|---|---|
| `runtime` | `hermes` |
| `vendor` | Hermes Agent (linhagem OpenClaw) |
| `min_version` | `0.13+` (Hermes CLI) |
| `default_model` | definido pelo provider/profile do usuário (ex.: via OpenRouter); sem default próprio |
| `tested_against` | Hermes Agent v0.13.0 (2026.5.7) |
| `config_paths` | `~/.hermes/config.yaml`, `~/.hermes/profiles/<p>/config.yaml`, `<project>/AGENTS.md`, `~/.hermes/SOUL.md` |
| `skills_root` | `~/.hermes/skills/` (HOME-global) + `skills.external_dirs` no `config.yaml` (formato `SKILL.md` idêntico ao Claude Code) |
| `agents_root` | sem agent-profile por arquivo como o Codex; persona vai no prompt do `hermes -z` (ver §7) ou via `hermes profile` |
| `memory_root` | `<project>/AGENTS.md` (auto-load do CWD), SOUL.md/USER.md no system prompt, SQLite+FTS5, Honcho |
| `audit_log` | `~/.harness-logs/<date>/audit.jsonl` via shell hooks (§10) + fs-watch (`nrv-hermes`) |
| `protocol_versions` | Squad 5.0, Business 1.0, Harness 1.0 (gaps em §13) |

---

## 2. Feature Support Matrix

`✓` = nativo · `~` = workaround/parcial · `✗` = não suportado

| Feature (Business v1 §6) | Squad v5 | Business v1 | Harness v1 | Notas |
|---|---|---|---|---|
| `max_turns` | ~ | ~ | ~ | `agent.max_turns` global no config/profile; não há per-employee. Cada sub-process `hermes -z` herda o limite do profile |
| `tool_whitelist` | ✓ | ✓ | ✓ | `-t/--toolsets` restringe o universo de tools por invocação; `disabled_toolsets` no config |
| `subagent_spawning` | ~ | ~ | ~ | `delegation` nativo é mono-nível (`max_spawn_depth: 1`); fan-out multi-nível via sub-process `hermes -z` (= padrão Codex) |
| `audit_trail` | ~ | ~ | ~ | Shell hooks `pre/post_tool_call` → `audit-emit-from-hermes-hook.ts` → jsonl; + fs-watch. Não nativo |
| `scheduled_invocation` | ✓ | ✓ | ✓ | **`hermes cron` nativo** — vantagem sobre Codex/Gemini |
| `event_bus` | ~ | ~ | ~ | Mentions/tickets via file-system (`.handoffs/`); sem broker |
| `hooks` | ~ | ~ | ~ | `pre/post_tool_call`, `on_session_start/end`, `transform_*`, etc. — shell-based, consent-gated; sem granularidade por-arg do Claude |
| `sandboxing` | ✓ | ✓ | ✓ | 6 terminal backends (local, Docker, SSH, Daytona, Modal, Singularity); scanner Tirith pré-execução |
| `session_memory` | ✓ | ✓ | ✓ | Contexto por sessão + compressão automática |
| `project_memory` | ✓ | ✓ | ✓ | `AGENTS.md` do CWD carregado automaticamente (inclusive em `hermes -z`) |
| `global_memory` | ✓ | ✓ | ✓ | SOUL.md/USER.md + SQLite+FTS5 + Honcho (mais rico que Codex/Gemini) |
| `handoff_artifacts` | ✓ | ✓ | ✓ | JSON em `.handoffs/` (texto→JSON parse; ver §7) |
| `fork_context` | ~ | ~ | ~ | Sub-process spawn cria fork; isolation por profile/toolset |
| `teammate_primitive` | ~ | ~ | ~ | `delegation.orchestrator_enabled` (mono-nível); teams multi-nível são convenção via file-system |
| `telemetry_otel` | ~ | ~ | ~ | Sem OTel built-in; jsonl via hooks |
| `messaging_escalation` | ✓ | ✓ | ✓ | 18 adaptadores (Slack/Telegram/WhatsApp) — **upgrade sobre Codex** para escalação humana |
| `mcp` | ✓ | ✓ | ✓ | `mcp_servers` nativo |

---

## 3. Concept Mapping

| Conceito (Protocolo) | Equivalente Hermes | Implementação |
|---|---|---|
| Squad / Business | Skill-ponte + `AGENTS.md` do projeto | Registry global lido via `nrv`; `AGENTS.md` carregado por CWD |
| Capability | Comando `nrv` determinístico | `nrv find/route/index/verify-deliverable/quality-gate` via tool `terminal` |
| Employee | Persona embutida no prompt do `hermes -z` | persona-núcleo + DNA injetado (§7); não é arquivo de agent como no Codex |
| `is_brief_intake: true` | Maestro raciocina sobre o brief | É prompt (igual qualquer runtime), não código |
| `is_antagonist: true` | Sub-process `hermes -z` em pipeline | `hermes -z "<persona+DNA+brief>" > .handoffs/<id>.out` |
| Handoff artifact | JSON parseado do stdout do `-z` | Persistido em `<project>/.handoffs/` |
| Mention `@employee` | Convenção no handoff JSON | Adapter detecta `mentions[]` → novo sub-process |
| Ticket | Arquivo persistido | `<project>/.tickets/<TICKET_ID>.json` |
| Escalation trigger | Notificação + canal de mensageria | Wrapper emite notification; Hermes pode notificar via Slack/Telegram |
| Permanent memory | SOUL.md/USER.md + SQLite | Hermes nativo |
| Project memory | `<project>/AGENTS.md` | Auto-load por CWD |
| Session memory | Transcript + compressão | Hermes nativo |
| Routing decision (harness) | `nrv find` (BM25) | Shell-out determinístico via tool `terminal` |

---

## 4. Frontmatter Mapping

### Squad v5 / Business v1 → skill-ponte + AGENTS.md

A ponte (`skills/_shared/adapters/hermes/skills/nirvana/`) é uma skill `SKILL.md` padrão que o Hermes descobre via `external_dirs`. O contrato de projeto vai em `AGENTS.md` (byte-idêntico a `CLAUDE.md`/`GEMINI.md`), carregado pelo CWD.

### Employee → prompt do `hermes -z`

O Hermes não tem agent-profile por arquivo (como `~/.codex/agents/<name>.md`). A persona do employee é montada no prompt:

```
<persona-núcleo do employee (frontmatter → topo)>
<DNA do mind-clone — injectMindClones().combined_prompt>
## Brief
<brief enriquecido>
## Contrato de saída
Responda SOMENTE com um único objeto JSON: {...}
```

> Para `type: mind_clone`, o adapter prepende `(DISCLOSURE: AI-generated persona, not a real person.)` na persona, igual ao Codex.

---

## 5. Tool Whitelist Mechanics

- Hermes tem 47 tools em 19 toolsets. O whitelist por employee é aplicado via `-t/--toolsets` na invocação `hermes -z` — o que não está no toolset não existe na sessão.
- Mapeamento semantic tools → toolset Hermes:
  - `read` / `write` / `edit` → `file`
  - `bash` → `terminal`
  - `web_fetch` → `web`
  - `image` → image toolset
- Default mínimo do adapter: `-t file,terminal`. Expande conforme `employee.tools`.
- Gate adicional: scanner Tirith pré-execução + hooks `pre_tool_call` (mas o nosso hook de audit NÃO bloqueia — segurança fica no `-t` + Tirith + `--yolo` controlado).

---

## 6. Max-Turns Mechanics

Hermes tem `agent.max_turns` global (config/profile), não per-subagent. Adapter simula:

1. Cada employee roda como sub-process `hermes -z`, que herda `agent.max_turns` do profile ativo.
2. Para limites distintos por employee, usar um profile dedicado (`hermes profile`) com `max_turns` próprio, ou aceitar o global.
3. Estouro → o sub-process termina; o wrapper registra `audit_event: budget_violation`.

**Limitação:** sem contagem per-employee fina. Documentado como `~` (parcial). Recomenda-se employees flat (sem invocação aninhada dentro de um único `-z`).

---

## 7. Subagent Spawning

Hermes **não tem** `hermes run` nem subagent primitive in-process. O one-shot é `hermes -z "<prompt>"` (saída **texto puro**, sem `--output-format json`, sem `--agent`/`--soul`). O adapter despacha assim:

```bash
# Adapter spawn (pseudocódigo do que o wrapper executa)
PROMPT=$(cat <<EOF
$PERSONA_CORE                      # persona-núcleo do employee (frontmatter)
$DNA_BLOCK                         # injectMindClones().combined_prompt
## Brief
$BRIEF
## Tools permitidos
$TOOL_WHITELIST
## Contrato de saída (OBRIGATÓRIO)
Responda SOMENTE com um único objeto JSON, sem texto antes/depois:
{"success":bool,"artifact_path":string|null,"summary":string,
 "next_action":string|null,"mentions":[string],"errors":[string]}
EOF
)
hermes -z "$PROMPT" \
  --model "$EMPLOYEE_MODEL" --provider "$EMPLOYEE_PROVIDER" \
  -t "$TOOLSET_SUBSET" \
  --accept-hooks --yolo \
  > ".handoffs/${EMPLOYEE}-$(date +%s).out"

# Parse texto→JSON: extrai o 1º objeto {...} balanceado do stdout (tolerante a ruído).
```

**DNA / limite de contexto.** O system prompt do Hermes trunca arquivos de contexto em `CONTEXT_FILE_MAX_CHARS = 20_000` (head 70% + tail 20%, `agent/prompt_builder.py:824`). Por isso o DNA vai no **corpo do prompt do `-z`**, não num arquivo de contexto (evita o truncamento). Se `injectMindClones().total_bytes > ~14_000`, o adapter degrada para o top-1 clone + resumo determinístico dos demais e emite `dispatch_degraded`. Cada injeção emite `mind_clone_injected` com sha256 (`harness/lib/dispatch.ts:123-130`); `validateTrace()` (`dispatch.ts:193`) confirma pós-dispatch que o DNA declarado == injetado (invariante anti-fabricação).

**Mention `@x`:** detectada em `mentions[]` no handoff → novo sub-process `hermes -z`. Fan-out multi-nível fica no wrapper Nirvana (o `delegation` nativo do Hermes é mono-nível, `max_spawn_depth: 1`).

---

## 8. Memory Storage

| Camada | Path | Persistência |
|---|---|---|
| Permanent (cross-session) | SOUL.md/USER.md + SQLite+FTS5 + Honcho | Nativo |
| Project | `<project>/AGENTS.md` | Auto-load por CWD |
| Session | Transcript + compressão automática | Nativo |
| Business permanent | `~/businesses/<biz>/memory/permanent.md` | Adapter persiste via `nrv` |
| Project (business) | `<project>/<biz>/<project_id>/memory/` | Isolation by construction |

> **Isolation guard:** ao montar o prompt do `-z`, o adapter inclui APENAS o memory do `project_id` corrente — caso contrário `audit_event: isolation_violation`.

---

## 9. Context Window & Compaction

- Janela: depende do modelo/provider configurado (o Hermes roteia para o provider do profile).
- Arquivos de contexto (SOUL/USER/AGENTS) truncados em 20K chars (head70/tail20). DNA vai no corpo do prompt para não cair nessa regra (§7).
- Compaction: o Hermes comprime contexto automaticamente; cada `hermes -z` é efêmero (sem estado acumulado entre dispatches).

---

## 10. Hook System

Hermes tem shell hooks declarados em `~/.hermes/config.yaml` (`hooks:`). O `nrv setup --with-hermes` pluga dois, idempotentes por token:

```yaml
hooks:
  pre_tool_call:
    - matcher: "terminal|file"        # re.fullmatch sobre tool_name
      command: "bun ~/.claude/skills/_shared/scripts/audit-emit-from-hermes-hook.ts pre"
      timeout: 5
  post_tool_call:
    - matcher: "terminal|file"
      command: "bun ~/.claude/skills/_shared/scripts/audit-emit-from-hermes-hook.ts post"
      timeout: 5
```

- Payload JSON via stdin (`{hook_event_name, tool_name, tool_input, session_id, cwd}`); o shim normaliza `terminal→Bash`, `file→Write/Edit` e delega ao `audit-emit-from-hook.ts` (host `hermes-cli-hook`).
- **Regra de ouro:** o shim mantém stdout vazio + exit 0 — Hermes bloqueia o tool se a resposta parecer `{"action":"block"}`. O hook só observa.
- Comando roda via `shlex.split`, `shell=False` (sem operadores de shell). Consent na 1ª execução é pré-aprovado pelo instalador (`shell-hooks-allowlist.json`) quando o usuário opta pelos hooks.

| Hook desejado | Equivalente Hermes |
|---|---|
| `PreToolUse` | `pre_tool_call` (matcher por tool_name) |
| `PostToolUse` | `post_tool_call` |
| `SessionStart` | `on_session_start` |
| `Stop` / `SubagentStop` | `on_session_end` / `subagent_stop` |
| `UserPromptSubmit` | injetar no prompt do `-z` |

---

## 11. Invocation Examples

### Exemplo 1 — Consulta (Tier 0/1, sem degradação)

```
hermes chat
> Quais são minhas empresas e squads?
# A skill-ponte roteia para `nrv list-businesses` / `nrv list-squads`.
```

### Exemplo 2 — Dispatch determinístico (Tier 2)

```
hermes -z "Use a skill nirvana-os: despache este brief — <brief>" --accept-hooks
# A ponte chama `nrv dispatch "<brief>"` (brief-business + DNA + audit).
```

### Exemplo 3 — Orquestração in-runtime (Tier 4)

```bash
# CEO recebe brief
hermes -z "<persona ceo + brief + contrato JSON>" -t file,terminal --accept-hooks --yolo \
  > .handoffs/ceo-1.out
# Adapter parseia JSON, detecta next_action: marketing-lead
hermes -z "<persona marketing + DNA + contexto do ceo + contrato JSON>" ... \
  > .handoffs/marketing-1.out
# Adapter detecta mentions:["alex-hormozi"]
hermes -z "<persona alex-hormozi + DNA + contexto + contrato JSON>" ... \
  > .handoffs/alex-1.out
```

### Exemplo 4 — Escalação humana (vantagem do Hermes)

```bash
# Wrapper detecta budget_violation → Hermes notifica via canal
hermes slack send "#nirvana-ops" "Escalação: budget_violation no trace <id>"
```

---

## 12. Runtime-Specific Validators

- **`bun` + `nrv` no PATH** do terminal backend do Hermes (`command -v bun`, `command -v nrv`). Em backend efêmero (Modal/Singularity), instalar Bun na imagem.
- **Toolset coerente**: se `employee.tools` inclui `bash`, o `-t` precisa incluir `terminal`.
- **Hook não-bloqueante**: o shim de audit nunca escreve `{"action":"block"}` nem sai != 0.
- **external_dirs resolvível**: o caminho da ponte é absoluto (não `~`); `${NIRVANA_PROJECT_SKILLS}` resolve só quando o `nrv-hermes` exporta a var.
- **Contrato JSON**: parser tolerante (extrai o 1º `{...}` balanceado); 1 retry com instrução reforçada se o modelo devolver texto solto.

---

## 13. Known Limitations

1. **Sem `hermes run` / `--output-format json`** → dispatch usa `hermes -z` (texto puro) + contrato "responda só JSON" + parse. Risco de o modelo não seguir → parser tolerante + retry.
2. **Sem subagent primitive in-process** → sub-process `hermes -z` (teto = Codex, não Claude Code). `delegation` nativo é mono-nível.
3. **Sem hooks granulares por-arg** → audit via `pre/post_tool_call` shell + fs-watch.
4. **Max-turns per-employee** é global do profile (simulado).
5. **Consent de hooks** exige allowlist (pré-aprovada pelo instalador sob opt-in do usuário).
6. **Limite de 20K chars** em arquivos de contexto → DNA grande vai no corpo do prompt + gate de degradação.
7. **Backends efêmeros** precisam de Bun na imagem.
8. **`hermes acp`** (servidor ACP de longa duração) seria a evolução para orquestração persistente — fora do v1 (que usa `-z` one-shot).

---

## 14. Source References

- Hermes CLI: `hermes --help`, `hermes chat --help`, `hermes hooks --help`, `hermes skills --help`.
- Hooks: `~/.hermes/hermes-agent/agent/shell_hooks.py` (`_serialize_payload`, `_record_approval`, `_is_allowlisted`).
- Context limit: `~/.hermes/hermes-agent/agent/prompt_builder.py:824` (`CONTEXT_FILE_MAX_CHARS = 20_000`).
- Skills/external_dirs: `~/.hermes/hermes-agent/agent/skill_utils.py` (`get_external_skills_dirs`), `~/.hermes/config.yaml`.
- Ponte + shim: `skills/_shared/adapters/hermes/skills/nirvana/`, `skills/_shared/scripts/audit-emit-from-hermes-hook.ts`.
- Wrapper: `bin/nrv-hermes`. Installer: `scripts/install.ts` (`offerHermesBridge`).
- DNA injection: `harness/lib/dispatch.ts` (`injectMindClones`, `validateTrace`).
- Squad v5: `~/.claude/skills/squads/SQUAD_PROTOCOL_V5.md`. Business v1: `~/.claude/skills/businesses/BUSINESS_PROTOCOL_V1.md`. Harness v1: `~/.claude/skills/harness/HARNESS_PROTOCOL_V1.md`.

---

## 15. Version History

| Versão | Data | Mudanças |
|---|---|---|
| 1.0.0 | 2026-06-05 | Doc inicial — Squad 5.0 + Business 1.0 + Harness 1.0 contra Hermes Agent v0.13.0. Dispatch via `hermes -z` (sub-process, texto→JSON). Ponte + audit hooks + nrv-hermes. |
