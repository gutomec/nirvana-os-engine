# Adapter · Grok Build CLI (xAI Grok)

> Runtime adapter para Squad Protocol v5 + Business Protocol v1 + Harness Protocol v1.
> Cobre os 3 protocolos em um único doc. Seções canônicas conforme Squad v4 §18.5.
> Identidade + capabilities do sistema (o que o Nirvana-OS é e pode fazer): ver `../NIRVANA-OS.md` (fonte única).
> Dispatch por sub-process, mesma família do `codex.md` / `kimi-cli.md`. Toda flag abaixo foi lida do `grok --help` ou de `~/.grok/docs/user-guide/` do `grok 1.0.44`; o que o engine não passa está marcado.

---

## 1. Metadados do adapter

| Campo | Valor |
|---|---|
| `runtime` | `grok-cli` |
| `vendor` | xAI |
| `min_version` | Não pinada. O argv do driver exige `--prompt-file`, `--output-format json` e `--always-approve`; `--trust` é opcional (build que rejeita a flag é re-executado sem ela, §7). Builds antigos caem para `-p` e para saída `plain`. |
| `tested_against` | `grok 1.0.44 (5b807183dd79)`, lançado em 2026-09-28, auditado em 2026-10-11. Última versão publicada: 1.0.50 (2026-10-06), não instalada na máquina da auditoria. |
| `default_model` | Herdado do runtime. O engine NUNCA define model; vem da entrada `grok-cli:<model>` do `LLM_CASCADE` (ou de `opts.model`). Passe model só quando o usuário pedir explicitamente. `grok models` lista o que a conta pode usar. |
| `config_paths` | `~/.grok/config.toml`, `~/.grok/trusted_folders.toml` (folder trust), `~/.grok/sandbox.toml`, `~/.grok/sessions/`, `<project>/.grok/`, `<project>/AGENTS.md`. `GROK_HOME` move a árvore `~/.grok` inteira. |
| `skills_root` | `./.grok/skills`, `<repo>/.grok/skills`, `~/.grok/skills`, mais `.agents/skills` em cada nível e `~/.claude/skills` / `./.claude/skills` (compatibilidade Claude, ligada por padrão). Skills de projeto só carregam em pasta confiável. |
| `agents_root` | Nativo: `--agent <NOME ou arquivo>`, `--agents <JSON>` e personas no config (`16-subagents.md`). O engine não usa nenhum deles; a persona vai no arquivo de prompt. |
| `memory_root` | `<project>/AGENTS.md` (só em pasta confiável); memória cross-session experimental, desligada por padrão (`13-memory.md`). |
| `audit_log` | Grok: `~/.grok/sessions/<encoded-cwd>/<session-id>/`, legível com `grok export` e `grok usage <SESSION_ID>`. Engine: jsonl em `~/.harness-logs/` via `runGrok`. |
| `protocol_versions` | Squad 5.0, Business 1.0, Harness 1.0 (com gaps registrados em §13) |

---

## 2. Matriz de suporte

`✓` = nativo · `~` = workaround/parcial · `✗` = não suportado. "Engine" é o que o `runGrok` passa hoje.

| Feature (Business v1 §6) | Squad v5 | Business v1 | Harness v1 | Notas |
|---|---|---|---|---|
| `max_turns` | ~ | ~ | ~ | O CLI tem `--max-turns <N>` (só headless). O engine **não** passa; `RunHeadlessOpts` não tem `maxTurns`. O único limite é o `timeoutMs` opcional do chamador. |
| `tool_whitelist` | ~ | ~ | ~ | O CLI tem `--tools` (allowlist) e `--disallowed-tools` (denylist), ambos só headless, e regras repetíveis `--allow` / `--deny` (`--allowedTools` / `--disallowedTools` são aliases de compatibilidade). O engine não passa nenhuma; `allowedTools` e `noTools` são ignorados no grok. |
| `subagent_spawning` | ✓ | ✓ | ✓ | `spawn_subagent` nativo, profundidade máxima 1. Para desligar: `--no-subagents`, `GROK_SUBAGENTS=0`, `--disallowed-tools Agent`. O engine não passa nenhum, então um worker grok pode abrir os próprios subagents. |
| `audit_trail` | ✓ | ✓ | ✓ | Transcripts de sessão em disco (`grok export`), hooks em toda tool call (§10), mais o jsonl do engine. |
| `scheduled_invocation` | ~ | ~ | ~ | Scheduler dentro da sessão (`/loop`, `scheduler_create`, `20-background-tasks.md`). Um run headless termina quando o turno acaba, então o harness continua usando cron externo. |
| `event_bus` | ~ | ~ | ~ | Mentions/tickets via file system; sem broker. |
| `hooks` | ✓ | ✓ | ✓ | `PreToolUse`, `PostToolUse`, `SessionStart`, `Stop`, `SubagentStop` e outros (§10). |
| `sandboxing` | ✓ | ✓ | ✓ | `--sandbox <PROFILE>` / `GROK_SANDBOX` (`workspace`, `read-only`, `strict`, `devbox`, custom). No macOS usa Seatbelt desde a 1.0.44. O engine não passa profile, nem no `--safe`. |
| `session_memory` | ✓ | ✓ | ✓ | Contexto por sessão; retomável com `-r` (§7). |
| `project_memory` | ✓ | ✓ | ✓ | `AGENTS.md` / `CLAUDE.md` lidos nativamente, condicionados ao folder trust. |
| `global_memory` | ~ | ~ | ~ | Memória cross-session experimental, desligada por padrão (`GROK_MEMORY=0` força desligada); regras de `~/.claude/` entram pela compatibilidade Claude. |
| `handoff_artifacts` | ✓ | ✓ | ✓ | `--output-format json` devolve um objeto (§7). `--json-schema <SCHEMA>` restringe o shape; o engine não passa. |
| `fork_context` | ✓ | ✓ | ✓ | `--fork-session` com `-r` / `-c` cria a continuação com um novo session id. O engine não usa. |
| `teammate_primitive` | ✗ | ✗ | ✗ | Sem `TeamCreate`; o pai pode mandar mensagem aos subagents, mas team continua sendo convenção via file system. |
| `telemetry_otel` | ✓ | ✓ | ✓ | `GROK_EXTERNAL_OTEL=1` mais as variáveis padrão `OTEL_*` de exporter (`24-monitoring-usage.md`). |
| `mcp` | ✓ | ✓ | ✓ | `grok mcp`; MCP servers de projeto só carregam em pasta confiável. |

> **Nota fora da matriz canônica:** os diferenciais do Grok para o Nirvana são as **tools de mídia embutidas no Build CLI** (`image_gen` / `image_edit` / `image_to_video`) e a **rota assinatura de custo marginal $0** (§8). O Grok também não tem teto de gasto próprio: limites no estilo `--max-budget` não existem no CLI.

---

## 3. Mapeamento de conceitos

| Conceito (Protocolo) | Equivalente Grok Build CLI | Implementação |
|---|---|---|
| Squad / Business | Diretório de skills + AGENTS.md | `<project>/.agents/skills/<name>/` + `AGENTS.md` do CWD, ambos carregados só em pasta confiável (`--trust`) |
| Capability | Workflow file | `<skill>/capabilities/<id>.md`, lido pelo agente a partir das instruções do prompt |
| Employee | Persona no arquivo de prompt | Persona-núcleo + DNA no arquivo passado por `--prompt-file`. Profiles nativos via `--agent` existem, mas não são usados. |
| `is_brief_intake: true` | Persona default quando o skill está ativo | Montada no prompt / `AGENTS.md` do skill |
| `is_antagonist: true` | Sub-process separado | Uma segunda chamada `grok --prompt-file ...` com a persona antagonista |
| Handoff artifact | JSON no stdout | Campo `text` do envelope json, persistido em `<project>/.handoffs/` |
| Mention `@employee` | Convenção no handoff | O adapter detecta → novo sub-process |
| Ticket | Arquivo persistido | `<project>/.tickets/<TICKET_ID>.json` |
| Escalation trigger | Wrapper script + chamada ao harness | O wrapper checa a condição → emite notification para o harness |
| Permanent memory | `<project>/AGENTS.md` + arquivos custom | Memória nativa experimental existe, desligada por padrão |
| Project memory | `<project>/AGENTS.md` | Nativo, só em pasta confiável |
| Session memory | Sessão em `~/.grok/sessions/` | Retomada com `-r <sessionId>` no revise |
| Routing decision (harness) | Lookup table pré-spawn | BM25 sobre `capabilities[].examples[]` em wrapper Bun |

---

## 4. Mapeamento de frontmatter

### Squad v5 / Business v1 → AGENTS.md

O Grok lê `AGENTS.md`, `CLAUDE.md`, `Claude.md` e `CLAUDE.local.md` nativamente (`12-project-rules.md`), mas só depois que a pasta é confiável. O adapter mantém a mesma tática de dois arquivos do Codex/Kimi:

```yaml
# AGENTS.md (head do projeto/skill)
You are an AI agent operating under the Squad/Business Protocol.

Available capabilities: [media.video.analyze, media.transcript.extract, ...]
Default tools: [Read, Write, Bash]
```

```yaml
# .agents/manifest.yaml (auxiliar: lido por wrapper, não pelo Grok)
name: nexus-council
protocol: 1.0
employees: [ceo, marketing-lead, ...]
operation_mode: zero_human
```

### Employee → arquivo de prompt

O engine grava um arquivo temporário e o passa com `--prompt-file`. O `withPreamble` coloca a diretiva de modo autônomo (`appendSystemPrompt`) no topo desse arquivo, separada por `---`; ela chega como texto do turno do usuário, não como system prompt. O `--rules <TEXT>` do Grok (acrescenta ao system prompt) e o `--system-prompt-override` (substitui) existem, e o engine não usa nenhum dos dois.

```
<diretiva de modo autônomo (appendSystemPrompt)>
---
<persona-núcleo do employee (frontmatter → topo)>
<DNA do mind-clone: injectMindClones().combined_prompt>
## Brief
<brief enriquecido>
## Tools permitidos
<tool whitelist>
## Contrato de saída
Responda SOMENTE com um único objeto JSON: {...}
```

> Para `type: mind_clone`, o adapter **prepende** `(DISCLOSURE: AI-generated persona, not a real person.)` na persona, igual ao Codex.

---

## 5. Mecânica de tool whitelist

O CLI impõe limites de tool; o engine ainda não usa nenhum.

- `--tools <a,b,c>`: allowlist de tools built-in (só headless). As meta-tools de MCP continuam disponíveis, a menos que negadas.
- `--disallowed-tools <a,b,c>`: denylist (só headless). Aceita `Agent`, `Agent(explore)`, `Agent(explore, plan)` para bloquear subagents. Com as duas flags, a denylist vence.
- `--allow <RULE>` / `--deny <RULE>`, repetíveis, no TUI e no headless: `Bash(...)`, `Edit(...)`, `Write(...)`, `Read(...)`, `Grep(...)`, `WebFetch(...)`, `MCPTool(...)` com glob. Deny vence allow. Elas controlam a execução; não removem a tool.
- `--permission-mode default|acceptEdits|auto|dontAsk|bypassPermissions|plan`. `bypassPermissions` equivale a `--always-approve`. Regras de deny, hooks e travas de admin continuam valendo sob always-approve.
- `--disable-web-search` remove web search e fetch.

Os nomes de tool são ids internos, não os nomes portáveis: `read_file`, `grep`, `list_dir`, `search_replace`, `web_search`, `web_fetch` e a tool de shell (`run_terminal_cmd` em `14-headless-mode.md`, `run_terminal_command` em `10-hooks.md`; a documentação diverge, então leia a lista real com `grok inspect --json` ou na linha `system/init` do `streaming-messages-json`). Mapeamento portável: `read` → `read_file`, `edit`/`write` → `search_replace` e a tool de escrita, `grep` → `grep`, `bash` → a tool de shell, `web_fetch` → `web_fetch`, `web_search` → `web_search`. Tools MCP mantêm o prefixo `mcp__<server>__`.

O que o engine faz hoje: no caminho autônomo passa `--always-approve` e nenhuma allowlist. No `--safe` (`yolo: false`) não passa `--always-approve` nem `--trust`, e também nenhum `--tools`, `--permission-mode` ou `--sandbox`; a restrição é apenas "o modo de aprovação padrão do CLI num run headless". O bloco "## Tools permitidos" da persona é um limite brando.

Mídia embutida: `image_gen` / `image_edit` (chave `features.image_gen`) e `image_to_video` são tools nativas, disponíveis quando a persona pede.

---

## 6. Mecânica de max-turns

O CLI expõe `--max-turns <N>`, só no headless. Quando o teto é atingido, o turno termina com o hook `StopCancelled`, um evento `max_turns_reached` no `streaming-json` ou o subtype `error_max_turns` no `streaming-messages-json`. O `num_turns` do envelope json conta rodadas de modelo do agente principal (chamadas de subagents não entram).

**O engine não passa `--max-turns`.** O `runGrok` não tem entrada de turnos (`RunHeadlessOpts` não carrega `maxTurns`), então o `maxTurns` do employee não chega ao grok. O único limite é `opts.timeoutMs` → timeout do `spawnSync`, que por padrão não existe (sem teto). Um filho que estoura o timeout é morto por sinal e o driver registra exit code 124.

O Grok não tem teto de gasto: o guia headless diz que o subtype `error_max_budget_usd` nunca é emitido porque o grok não tem recurso de budget. Um `maxBudgetUsd` do engine não é passado ao grok e não teria para onde ir.

---

## 7. Subagent spawning

### Argv do dispatch (o que o `runGrok` executa de fato)

```bash
grok --prompt-file <arquivo-tmp> --output-format json --cwd <cwd> \
  [-r <sessionId>]        # só ao retomar (opts.sessionId definido, ex.: nrv revise)
  [--always-approve]      # caminho autônomo; sai no --safe
  [--trust]               # caminho autônomo; sai no --safe
  [-m <model>]            # só quando opts.model ou o cascade resolve um
```

- `--prompt-file <PATH>`: prompt single-turn a partir de arquivo, sem perda em qualquer tamanho. O arquivo temporário é apagado depois do run.
- `--output-format json`: um objeto no stdout ao fim do run.
- `--cwd <dir>`: diretório de trabalho (o cwd do processo filho é o mesmo).
- `-r <id>`: retoma a sessão `opts.sessionId`. Sem ele, cada chamada é uma conversa nova.
- `--always-approve`: aprova toda tool call. Sem ela, um run headless fica esperando aprovações que não vão chegar. `--yolo` é alias documentado no guia headless, mas não aparece no `--help`; o engine usa a flag documentada.
- `--trust`: flag oculta (fora do `--help`; `grok --trust --version` é aceito na 1.0.44). Concede folder trust, e assim carregam o `AGENTS.md` do projeto, skills de projeto em `.agents/skills`, hooks de projeto, MCP/LSP de projeto e regras de permissão de projeto. Sem ela, a inicialização headless com essas fontes exige `--trust` ou uma concessão anterior, e uma pasta de run nova não tem concessão anterior.
- `-m <model>`: de `opts.model` ou `resolveSystemModel("grok-cli")`; nunca hardcoded.

Retentativas, nesta ordem, todas antes de qualquer chamada ao modelo:
1. O stderr diz `unexpected argument '--trust'` → roda de novo, uma vez, sem `--trust`.
2. Erro de flag citando `prompt-file` → roda de novo com `-p <prompt>` no argv (inseguro para ARG_MAX com prompt grande; só para builds muito antigos).
3. Erro de flag citando `output-format` → roda de novo sem `--output-format` (texto puro no stdout).

Não passados hoje: `-s/--session-id`, `--effort`, `--no-subagents`, `--max-turns`, `--rules`, `--tools`, `--disallowed-tools`, `--permission-mode`, `--sandbox`, `--json-schema`. O grok não está em `EFFORT_CAPABLE`, então um effort pedido gera um aviso único e é descartado. Não há flag de concessão de diretório (equivalente a `--add-dir`): `addDirs` extras geram um warning.

### Camada leve (entrada `grok-cli` de `RUNTIMES`)

```bash
grok --prompt-file <arquivo-tmp> [--always-approve --trust]
```

Persona e mensagem do usuário vão juntas em um arquivo. `--always-approve --trust` só entram quando `headlessSkipPermissions()` está ligado (setting `execution.headless_skip_permissions`). Sem `--output-format`, o stdout vem em texto puro; o parser ainda tenta as chaves JSON `text`, `response`, `result`, `output`.

### Envelope de resultado

Sucesso (`--output-format json`):

```json
{"text":"...","stopReason":"end_turn","sessionId":"...","requestId":"...",
 "num_turns":7,"usage":{...},"modelUsage":{"<model>":{...,"costUSD":0.0127}},
 "total_cost_usd":0.0127,"total_cost_usd_ticks":126890500}
```

`total_cost_usd` só aparece quando o servidor reportou um custo completo. Quando faltou custo em alguma chamada, vem `cost_is_partial: true` e todos os floats de custo são omitidos; `usage_is_incomplete: true` faz o mesmo. Um prompt que nunca chegou ao modelo não tem campos de gasto.

Falha: `{"type":"error","message":"..."}` com exit diferente de zero (130 em SIGINT, 143 em SIGTERM, 1 nos demais casos).

Como o `runGrok` lê: texto do resultado de `response`, `result`, `output` ou `text`; session id de `session_id`, `sessionId`, `conversation_id` ou `session.id` (com fallback para o id recebido ou um UUID novo); custo de `total_cost_usd`, senão `costUnavailable`. Falha é `exit != 0` ou um campo `is_error` / `error`. O envelope `{"type":"error","message"}` não tem nenhum dos dois campos, então a mensagem dele não é extraída: o run falha mesmo assim pelo exit code, e o texto de erro vem do stderr. `cost_is_partial`, `usage_is_incomplete`, `num_turns` e `total_cost_usd_ticks` não são lidos.

### Sessões

- `-s, --session-id <UUID>`: nomeia só uma sessão **nova** (UUID válido e ainda não usado). Não retoma.
- `-r, --resume [<ID_OU_TÍTULO>]`: retoma por id, ou por título no diretório atual; a mais recente se omitido. Scripts devem passar id.
- `-c, --continue`: sessão mais recente do cwd.
- `--fork-session`: com `-r` / `-c`, continua sob um session id novo (que o `-s` pode nomear).
- `--restore-code`: também restaura o snapshot do repositório ao retomar.
- `grok sessions list|search|delete`, `grok export`, `grok usage <SESSION_ID> [TURN]`.

### Subagents nativos

O agente principal chama `spawn_subagent`; os tipos built-in são `general-purpose`, `explore` e `plan`, e agentes de projeto ou de usuário podem adicionar ou sobrepor tipos. A profundidade é fixa em um: um subagent não abre outro. `--agents <JSON>` define subagents inline (só headless), `--agent <NOME>` escolhe o profile do agente. Como o engine não passa `--no-subagents`, um worker grok pode delegar dentro do próprio run; workers Claude têm o padrão oposto (`--disallowedTools Task Agent`, salvo `allowSubagents`).

**Para mention `@x`:** o adapter detecta no handoff retornado e abre um novo sub-process para `x`. **Fan-out paralelo** entre employees continua no nível do OS: sub-processes `grok --prompt-file` independentes.

---

## 8. Armazenamento de memória

| Camada | Path | Persistência |
|---|---|---|
| Permanent (cross-session) | `<project>/AGENTS.md` + arquivos custom; memória nativa opcional (`topics/` por escopo, desligada por padrão) | Manual / experimental |
| Project | `<project>/AGENTS.md` | Nativo, só em pasta confiável |
| Session | `~/.grok/sessions/<encoded-cwd>/<session-id>/` | Persistida pelo grok; retomada com `-r` |
| Business permanent | `~/businesses/<biz>/memory/permanent.md` | Adapter persiste |
| Project (business) | `<project>/<biz>/<project_id>/memory/` | Isolation by construction |

> **Isolation guard:** o Grok não impõe o isolamento de memória do Nirvana. O adapter monta o prompt com APENAS a memória relevante ao `project_id` antes do spawn, caso contrário `audit_event: isolation_violation`. Se a memória nativa for ligada, o escopo de workspace é compartilhado por clones e worktrees do mesmo repositório.

**Autenticação em dois trilhos.** O model vem SÓ da entrada `grok-cli:<model>` do cascade. A credencial vem de uma de duas rotas:

- **Assinatura via `grok login`**: conta xAI. **Custo marginal $0**; nessa rota o envelope em geral omite `total_cost_usd` (o guia diz que caminhos pool/OAuth costumam omitir), então o driver reporta `costUsd: null` + `costUnavailable`. É a rota que o squad **`grok-studio-nirvana`** usa.
- **API xAI via `XAI_API_KEY` (paga)**: pay-per-token; o custo é carimbado para tráfego com API key e chega em `total_cost_usd`.

---

## 9. Janela de contexto e compaction

- Janela: depende do modelo escolhido via `LLM_CASCADE`. Desde a 1.0.44 um modelo pode anunciar vários tamanhos de janela (`/context-window <tamanho>` no TUI); o primeiro listado é o padrão. O engine não fixa número.
- Compaction: automática em 85% da janela (`[session] auto_compact_threshold_percent`), manual com `/compact`. Os hooks `PreCompact` / `PostCompact` disparam em volta; o `streaming-json` pode emitir eventos `auto_compact_*`.
- Quando o brief pede artefato visual, `image_gen` / `image_edit` / `image_to_video` rodam na mesma sessão.

---

## 10. Sistema de hooks

O Grok tem um sistema de hooks completo (`10-hooks.md`). Fontes, todas mescladas:

| Escopo | Path | Confiável? |
|---|---|---|
| Global | `~/.grok/hooks/*.json`, `~/.grok/config.toml` | Sempre |
| Global | `~/.claude/settings.json` (+ `settings.local.json`) | Sempre (compatibilidade Claude, ligada por padrão) |
| Global | `~/.cursor/hooks.json` | Sempre (compatibilidade Cursor) |
| Projeto | `<project>/.grok/hooks/*.json`, `<project>/.claude/settings.json`, `<project>/.cursor/hooks.json` | Exige folder trust |
| Organização | `managed_config.toml`, `requirements.toml` | Sempre |
| Plugin | Empacotados em plugins instalados | Por plugin |

Eventos: `SessionStart`, `SessionEnd`, `UserPromptSubmit` (pode bloquear), `PreToolUse` (pode negar), `PostToolUse` (pode trocar o output que o modelo vê), `PostToolUseFailure`, `PermissionDenied`, `Stop` (pode bloquear), `StopFailure`, `StopCancelled`, `Notification`, `SubagentStart`, `SubagentStop` (pode bloquear), `PreCompact`, `PostCompact`. Desde a 1.0.49 (release notes, versão ausente na máquina da auditoria) os prompts de permissão de hook aparecem em todo modo de aprovação.

Consequência para o Nirvana: como o `~/.claude/settings.json` é sempre carregado, os hooks de auditoria que o `nrv setup` instala ali (`audit-emit-from-hook.ts pre|post`, sem argumento de agente) também disparam dentro dos filhos grok. O script então os rotula como `claude-code-hook`, e os nomes de tool do grok (`search_replace`, a tool de shell) diferem dos do Claude. Para desligar, `[compat.claude] hooks = false` em `~/.grok/config.toml`; um arquivo de hook nativo do grok em `~/.grok/hooks/` levaria o rótulo certo. Nenhum dos dois existe hoje.

| Hook desejado | Grok |
|---|---|
| `PreToolUse` | `PreToolUse` nativo (pode negar) |
| `PostToolUse` | `PostToolUse` nativo |
| `UserPromptSubmit` | `UserPromptSubmit` nativo (pode bloquear) |
| `Stop` | `Stop` / `StopFailure` / `StopCancelled` nativos |
| `SessionStart` | `SessionStart` nativo |
| `Compact` | `PreCompact` / `PostCompact` nativos |

---

## 11. Exemplos de invocação

### Exemplo 1: Squad capability (caminho autônomo)

```bash
# User: "gerar key visual do lançamento e um teaser vertical"
# O que o runGrok executa (o prompt é gravado antes num arquivo temporário):
grok --prompt-file <arquivo-tmp> --output-format json --cwd <run-dir> \
  --always-approve --trust -m <model>
# stdout: {"text":"...","sessionId":"0199...","total_cost_usd":...}
```

### Exemplo 2: Business brief com handoff em pipeline, depois um revise

```bash
# CEO recebe o brief
grok --prompt-file <persona-ceo+brief> --output-format json --cwd <run-dir> --always-approve --trust \
  > .handoffs/ceo-1.json

# Adapter detecta `next_action: delegate to marketing-lead`
grok --prompt-file <persona-marketing+contexto-ceo> --output-format json --cwd <run-dir> --always-approve --trust \
  > .handoffs/marketing-1.json

# Adapter detecta mention `@alex-hormozi`
grok --prompt-file <persona-alex+DNA+contexto> --output-format json --cwd <run-dir> --always-approve --trust \
  > .handoffs/alex-1.json

# nrv revise <project> "<mudança>": mesma sessão, retomada pelo id
grok --prompt-file <arquivo-revisão> --output-format json --cwd <run-dir> \
  -r <sessionId-do-ceo-1> --always-approve --trust
```

### Exemplo 3: dispatch `--safe`

```bash
# nrv dispatch --safe: sem auto-approve, sem concessão de folder trust
grok --prompt-file <arquivo-brief> --output-format json --cwd <run-dir>
```

### Exemplo 4: Harness escalation

```bash
# Wrapper detecta budget_violation (timeout)
echo '{"type":"human_escalation_required","trigger_id":"budget","severity":"high",...}' \
  > .harness/notifications/$(date +%s).json
# Harness orchestrator (em outro runtime ou interativo) consome o arquivo
```

Flags que existem no CLI e que um comando montado à mão pode acrescentar (o engine não acrescenta): `--max-turns <N>`, `--effort <none|minimal|low|medium|high|xhigh|max>` (alias de `--reasoning-effort`), `--no-subagents`, `--rules "<texto>"`, `--tools <lista>`, `--disallowed-tools <lista>`, `--sandbox <profile>`, `--json-schema '<schema>'`, `--output-format streaming-json|streaming-messages-json` (+ `--include-partial-messages`).

---

## 12. Validadores específicos do runtime

- **Binário**: `grok --version` responde. Confira para qual arquivo o `grok` resolve: o instalador também cria `~/.grok/bin/agent` apontando para o grok, o que encobre o binário `agent` do Cursor CLI quando `~/.grok/bin` vem antes no `PATH`.
- **Credencial presente**: `grok login` feito, ou `XAI_API_KEY` no ambiente. Sem nenhuma das duas, o dispatch falha.
- **Model resolvível**: o `grok-cli:<model>` do cascade aparece em `grok models`.
- **Folder trust**: sem `--trust` (caminho `--safe`), `AGENTS.md`, skills, hooks e MCP de projeto só carregam se a pasta já estiver em `~/.grok/trusted_folders.toml`, ou se `GROK_FOLDER_TRUST=0` desligar a trava. Um checkout git aninhado é um workspace separado. `grok inspect --json` na pasta do run mostra o que o grok de fato descobre.
- **MCP server reachability**: se a persona referencia `mcp__<server>__*`, confira em `grok mcp` que o server existe.

---

## 13. Limitações conhecidas

1. **Sem teto de turnos vindo do engine.** `--max-turns` existe, mas o `runGrok` não tem entrada para ele; só um timeout de relógio opcional limita o run.
2. **Sem teto de gasto em lugar nenhum.** O Grok não tem recurso de budget, e a rota assinatura em geral não reporta custo (`costUnavailable`).
3. **Limites de tool não estão ligados.** `--tools`, `--disallowed-tools`, `--allow`, `--deny`, `--permission-mode` e `--sandbox` existem; o engine não passa nenhum, e o `--safe` só tira `--always-approve` e `--trust`.
4. **Workers podem abrir subagents.** `--no-subagents` existe e não é passado, então a regra de profundidade do engine não vale para o grok.
5. **Effort é descartado.** `--effort` existe e funciona no headless; o grok não está em `EFFORT_CAPABLE`.
6. **A diretiva é texto de usuário.** A diretiva autônoma é prependida ao arquivo de prompt em vez de ir por `--rules`.
7. **Texto de erro perdido.** O envelope `{"type":"error","message"}` não é parseado; o erro exibido vem do stderr.
8. **Atribuição de auditoria.** O Grok executa os hooks de `~/.claude/settings.json`, então os eventos de tool dele chegam rotulados como Claude (§10).
9. **`--trust` não aparece no `--help`.** É aceito na 1.0.44 e está no guia do usuário; um build que remova a flag cai para o run sem trust (retentativa do §7), o que perde em silêncio o `AGENTS.md` e as skills de projeto numa pasta de run nova.
10. **Sem `TeamCreate`** → teams são convenção em file system.
11. **Colisão do binário `agent`** (`~/.grok/bin/agent`), ver §12.
12. **Stdin no headless.** A 1.0.44 não lê stdin via pipe como prompt (`--prompt-file` é o canal); as release notes dizem que a 1.0.50 roda um `grok` sem argumentos com stdin via pipe em modo headless. O engine não depende de nenhum dos dois.

**Vantagem compensatória:** geração de mídia embutida, rota assinatura de custo marginal $0, hooks/subagents/sandbox/OTel nativos, store de sessões retomável e um envelope json com detalhe de tokens e custo.

---

## 14. Referências

- `grok --help`, `grok agent --help`, `grok sessions --help`, `grok inspect --help`, `grok usage --help`, `grok --trust --version` (local, `grok 1.0.44`, 2026-10-11).
- `~/.grok/docs/user-guide/`: `08-skills.md`, `10-hooks.md`, `12-project-rules.md`, `13-memory.md`, `14-headless-mode.md`, `16-subagents.md`, `17-sessions.md`, `18-sandbox.md`, `20-background-tasks.md`, `22-permissions-and-safety.md`, `24-monitoring-usage.md`.
- `~/.grok/CHANGELOG.md` (1.0.44: sandbox Seatbelt, tamanhos de janela de contexto).
- Mirror de releases para 1.0.45 a 1.0.50: https://releases.sh/xai/grok-build-releases.md (a página oficial https://x.ai/build/changelog devolveu 403 ao fetcher).
- Driver: `skills/_shared/lib/host-agent-driver.ts` (`runGrok`; entrada `grok-cli` de `RUNTIMES`), re-exportado por `skills/harness/lib/host-agent-driver.ts`.
- Squad de referência (rota assinatura): `grok-studio-nirvana`.
- Squad Protocol v5: `~/.nirvana/skills/squads/SQUAD_PROTOCOL_V5.md`
- Business Protocol v1: `~/.nirvana/skills/businesses/BUSINESS_PROTOCOL_V1.md`
- Harness Protocol v1: `~/.nirvana/skills/harness/HARNESS_PROTOCOL_V1.md`

---

## 15. Histórico de versões

| Versão | Data | Mudanças |
|---|---|---|
| 1.0.0 | 2026-07-20 | Doc inicial: cobre Squad 5.0 + Business 1.0 + Harness 1.0 contra Grok Build CLI (`grok 0.2.103`), família Grok (`grok-code` / `grok-4` / `grok-4-fast`). Dispatch via `grok -p --output-format json --always-approve --cwd`. |
| 1.1.0 | 2026-10-11 | Reescrito contra o `grok 1.0.44` (última 1.0.50). Argv real do driver (`--prompt-file`, `-r` ao retomar, `--trust` no caminho autônomo com retentativa sem trust). Documenta subagents nativos, hooks (inclusive `~/.claude/settings.json`), `--tools` / `--allow` / `--deny`, folder trust, sandbox, effort, sessões, os envelopes json e de erro, a ausência de teto de gasto e a colisão do binário `agent`. Remove as alegações falsas de que o driver passa `--max-turns` e de que o grok não tem resume, subagents e hooks. |
