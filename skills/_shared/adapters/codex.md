# Adapter · Codex (OpenAI Codex CLI)

> Runtime adapter para Squad Protocol v5 + Business Protocol v1 + Harness Protocol v1.
> Cobre os 3 protocolos em um único doc. Seções canônicas conforme Squad v4 §18.5.
> Identidade + capabilities do sistema (o que o Nirvana-OS é e pode fazer): ver `../NIRVANA-OS.md` (fonte única).
>
> Todo comando e flag abaixo existe em `codex --help` / `codex exec --help` nas versões testadas.
> Agentes montam comandos a partir deste arquivo: se uma flag não está aqui, não invente.

---

## 1. Adapter metadata

| Campo | Valor |
|---|---|
| `runtime` | `codex` |
| `vendor` | OpenAI |
| `binary` | `codex` (entrada headless: `codex exec`, alias `codex e`) |
| `min_version` | Codex CLI 0.153 (o conjunto de flags do driver foi auditado primeiro ali; builds mais antigos perdem flags pelo retry do driver, ver §11) |
| `tested_against` | Codex CLI 0.159.2 (instalado, help lido em 2026-10-11) e 0.162.1 (último estável, fonte na tag `rust-v0.162.1`) |
| `default_model` | Herdado do `~/.codex/config.toml` do usuário. O engine nunca fixa model; passa `--model` só quando o usuário ou uma entrada de cascade nomeia um id OpenAI. O default do catálogo embutido é `gpt-6.1-sol`. |
| `config_paths` | `~/.codex/config.toml` (ou `$CODEX_HOME/config.toml`), `$CODEX_HOME/<nome>.config.toml` (profile aplicado por `-p <nome>`), `<repo>/.codex/config.toml` |
| `instructions` | `~/.codex/AGENTS.md` (global), `AGENTS.md` da raiz do repo até o cwd (projeto) |
| `skills_root` | `~/.agents/skills` (escopo oficial do usuário), `.agents/skills` (escopo do repo), `/etc/codex/skills` (admin). `$CODEX_HOME/skills` está deprecado, mas ainda é lido. |
| `agents_root` | `~/.codex/agents/*.toml` (pessoal), `.codex/agents/*.toml` (projeto) |
| `hooks` | `~/.codex/hooks.json`, `[hooks]` no `config.toml`, `<repo>/.codex/hooks.json`, hooks de plugins |
| `audit_log` | `~/.codex/sessions/` (rollouts do Codex), mais o audit do Nirvana pelos hooks do Codex (§10) e `outputs/<trace>/audit.jsonl` |
| `protocol_versions` | Squad 5.0, Business 1.0, Harness 1.0 (gaps em §13) |

---

## 2. Feature support matrix

`✓` = nativo · `~` = workaround/parcial · `✗` = não suportado

| Feature (Business v1 §6) | Squad v5 | Business v1 | Harness v1 | Notas |
|---|---|---|---|---|
| `max_turns` | ✗ | ✗ | ✗ | `codex exec` não tem limite de turns. O engine limita a execução por timeout (§6). |
| `tool_whitelist` | ~ | ~ | ~ | Sem flag de allowlist por tool. Os gates são o modo de sandbox, o caminho de aprovação e hooks `PreToolUse` que podem negar (§5). |
| `subagent_spawning` | ✓ | ✓ | ✓ | `multi_agent` nativo (ligado por padrão). Workers despachados recebem `-c agents.enabled=false`, salvo quando o chamador orquestra (§7). |
| `audit_trail` | ✓ | ✓ | ✓ | Stream de eventos `--json`, rollouts em `~/.codex/sessions/`, hooks `PreToolUse`/`PostToolUse` do Nirvana. |
| `scheduled_invocation` | ✗ | ✗ | ✗ | O CLI não tem scheduler; o harness usa cron externo. |
| `event_bus` | ~ | ~ | ~ | Mentions e tickets passam pelo file system. |
| `hooks` | ✓ | ✓ | ✓ | 12 eventos de ciclo de vida, trust pelo hash da definição (§10). |
| `sandboxing` | ✓ | ✓ | ✓ | `read-only`, `workspace-write`, `danger-full-access`. |
| `session_memory` | ✓ | ✓ | ✓ | Histórico da thread; `codex exec resume <id>` continua. |
| `project_memory` | ✓ | ✓ | ✓ | `AGENTS.md` carregado automaticamente. |
| `global_memory` | ~ | ~ | ~ | `~/.codex/AGENTS.md`. A feature `memories` existe, mas vem desligada. |
| `handoff_artifacts` | ✓ | ✓ | ✓ | Mensagem final via `-o <arquivo>`; saída estruturada via `--output-schema`. |
| `fork_context` | ✓ | ✓ | ✓ | `codex exec fork <id>` ramifica uma thread sem tocar a original. O driver ainda não usa. |
| `teammate_primitive` | ✗ | ✗ | ✗ | Sem primitiva de time; time é convenção no file system. |
| `telemetry_otel` | ✓ | ✓ | ✓ | Export OTel nativo pela chave de config `otel`. |

---

## 3. Concept mapping

| Conceito (Protocolo) | Equivalente Codex | Implementação |
|---|---|---|
| Squad / Business | Skill em `~/.agents/skills/<nome>/SKILL.md` | O engine instala as skills; cada execução é um processo `codex exec` aberto por `runCodex` |
| Capability | Arquivo dentro da skill | `<skill>/capabilities/<id>.md`, lido pelo agente quando o brief o nomeia |
| Employee | Execução própria ou subagent nativo | `execution.business_mode: chain` (padrão): cada cargo roda numa sessão `codex exec` própria, em série. `session`: uma sessão roda a empresa e abre os cargos como subagents do Codex (`allowSubagents: true`). |
| `is_brief_intake: true` | Primeira sessão da cadeia | Recebe o brief no stdin |
| `is_antagonist: true` | Um despacho `codex exec` separado | Aberto pelo harness, nunca pelo worker |
| Handoff artifact | `-o <arquivo>` mais arquivos em disco | Persistido em `<project>/.handoffs/` |
| Mention `@employee` | Convenção no prompt | O harness resolve para um novo despacho |
| Ticket | Arquivo persistido | `<project>/.tickets/<TICKET_ID>.json` |
| Escalation trigger | Checagem do harness após a execução | Lê exit code, eventos `turn.failed` / `error` e a mensagem final |
| Permanent memory | `~/.codex/AGENTS.md` + arquivos de memória da empresa | O Codex só carrega AGENTS.md sozinho; o brief leva o resto |
| Project memory | `AGENTS.md` | Auto-load (teto conjunto `project_doc_max_bytes`, padrão 32768) |
| Session memory | Histórico da thread | `codex exec resume <thread_id>` (`nrv revise`) |
| Routing decision (harness) | Feita antes do spawn | O orquestrador escolhe a empresa; o Codex só executa |

---

## 4. Frontmatter mapping

O Codex não lê frontmatter de squads nem de empresas. Dois formatos nativos importam.

### Skill (`SKILL.md`)

Uma skill é um diretório com `SKILL.md` (frontmatter YAML com `name` e `description`, depois o corpo). O Codex lista as skills dentro de um orçamento de 2% da janela de contexto ou 8.000 caracteres. Duas skills com o mesmo nome não são mescladas; as duas aparecem. `[[skills.config]]` com `enabled = false` esconde uma sem apagá-la.

### Employee → custom agent do Codex (TOML)

Um agente por arquivo TOML avulso em `~/.codex/agents/` ou `.codex/agents/`. Chaves obrigatórias: `name`, `description`, `developer_instructions`. Qualquer outra chave do `config.toml` é opcional (`model`, `model_reasoning_effort`, `sandbox_mode`, `mcp_servers`, `skills.config`); o que o arquivo omite é herdado do pai. A identidade é o campo `name`, não o nome do arquivo.

```toml
# ~/.codex/agents/alex-hormozi.toml
name = "alex-hormozi"
description = "Mind clone of Alex Hormozi for offer evaluation. (DISCLOSURE: AI-generated persona, not real person.)"
developer_instructions = """
You are a mind-clone of Alex Hormozi specialized in offer evaluation...
"""
sandbox_mode = "read-only"
# sem chave `model`: o engine não fixa model, vale o do pai
```

> O adapter prepende `(DISCLOSURE: ...)` na description quando `type: mind_clone`.
> Um `model` definido no arquivo vence os valores do spawn e os defaults de `[agents]`, então deixe de fora.

---

## 5. Tool whitelist mechanics

`codex exec` não tem flag que liste tools permitidas. O que o engine tem:

- **Sandbox** (`-s/--sandbox`): `read-only`, `workspace-write`, `danger-full-access`. O driver mapeia `noTools` para `-s read-only`.
- **Raízes graváveis**: em `workspace-write` só `-C <dir>` é gravável; o driver libera o diretório do projeto, a raiz de outputs e o diretório da empresa ou do squad com `--add-dir`.
- **Aprovações**: `--approve-for-me` manda toda aprovação para o revisor do próprio Codex, sob o sandbox workspace-write. Não combina com `-s`. `--dangerously-bypass-approvals-and-sandbox` remove os dois gates.
- **Hooks**: um handler `PreToolUse` pode negar uma chamada (`permissionDecision: "deny"` ou exit code 2). É o único gate rígido por tool.
- `-a/--ask-for-approval` (`on-request`, `never`) existe só na raiz interativa, não no `exec`.

---

## 6. Max-turns mechanics

Não existe. `codex exec` não tem `--max-turns` nem chave de config para limitar turns por execução. O engine limita a execução com `timeoutMs` (o processo filho é encerrado e reportado com exit 124). Custo também não serve de limite: o Codex reporta contagem de tokens, nunca USD, então o driver devolve `costUnavailable: true` e o cost estimator precifica o `usage` que recebe.

---

## 7. Subagent spawning

O Codex tem subagents nativos: a feature `multi_agent` é estável e vem ligada. Os spawns aparecem no stream de eventos como itens `collab_tool_call`. As chaves globais ficam em `[agents]`:

| Chave | Significado |
|---|---|
| `agents.enabled` | Liga ou desliga as tools de multi-agent. Padrão `true`. |
| `agents.max_concurrent_threads_per_session` | Limita threads abertas por spawn (a principal não conta). `agents.max_threads` é alias legado. |
| `agents.default_subagent_model` | Model padrão dos agentes abertos. |
| `agents.default_subagent_reasoning_effort` | Effort padrão dos agentes abertos. |

Não existe chave `agents.max_depth` nem bloco `[agents.<nome>]`; custom agents são arquivos TOML (§4).

**Regra do engine.** Um worker despachado não abre agentes próprios, a mesma regra que os workers Claude recebem com `--disallowedTools`. `runCodex` e o launcher interativo do Orca passam `-c agents.enabled=false`, salvo quando o chamador define `allowSubagents` (o `business_mode: session` define). Usa-se chave de config em vez de `--disable multi_agent` porque builds antigos toleram uma chave `-c` desconhecida, mas saem com exit 1 diante de uma feature desconhecida em `--disable`.

**Para mention `@x`:** o harness detecta no handoff retornado e despacha `x` como nova execução.

---

## 8. Memory storage

| Camada | Path | Persistência |
|---|---|---|
| Global | `~/.codex/AGENTS.md` | Auto-load |
| Project | `AGENTS.md` da raiz do repo até o cwd | Auto-load, teto `project_doc_max_bytes` (32768 somando todos) |
| Session | Histórico da thread em `~/.codex/sessions/` (pulado com `--ephemeral`) | Retomável pelo id da thread |
| Business permanent | `~/businesses/<biz>/memory/permanent.md` | O engine escreve no brief |
| Project (business) | `<project>/<biz>/<project_id>/memory/` | Isolation by construction |

> **Isolation guard:** o Codex não isola memória por projeto. O engine monta o prompt com APENAS a memória do `project_id` atual; qualquer outra coisa é `audit_event: isolation_violation`.

---

## 9. Context window and compaction

- Janela: 272.000 tokens para todo model listado no catálogo embutido (`codex debug models --bundled`).
- A compactação é automática e segue a config do usuário. Nesta linha o engine não passa nenhuma configuração de janela de contexto ao Codex.
- Não existe flag de checkpoint. Uma execução que precisa continuar é retomada pelo id da thread.

---

## 10. Hook system

O Codex tem hooks granulares (feature `hooks`, estável, ligada).

**Eventos (12):** `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`, `SubagentStart`, `SubagentStop`, `Stop`, `Interrupt`.

**Fontes:** `~/.codex/hooks.json`, `[hooks]` inline no `~/.codex/config.toml`, `<repo>/.codex/hooks.json` e `<repo>/.codex/config.toml` (carregados só quando essa camada do projeto é confiável), plugins habilitados e `requirements.toml` gerenciado.

**Trust:** um hook não gerenciado só roda depois de revisado e marcado como confiável (`/hooks` na TUI). O trust é gravado contra o hash da definição do hook, então um hook novo ou editado fica de fora até ganhar trust de novo. A chave do registro também inclui o índice do grupo de matcher: um grupo inserido antes do Nirvana por outro instalador desliga em silêncio o trust do Nirvana até `nrv setup` rodar de novo. `--dangerously-bypass-hook-trust` ignora o trust gravado por uma invocação. Hooks gerenciados são confiáveis por política.

**Matchers** (para `PreToolUse`, `PostToolUse`, `PermissionRequest`): shell é `Bash`; edições de arquivo são `apply_patch` (aliases `Edit`, `Write`, enquanto o `tool_name` do payload continua `apply_patch`); tools MCP são `mcp__<server>__<tool>`. Tools hospedadas, como web search, não casam.

**Bloqueio:** `PreToolUse` nega com `hookSpecificOutput.permissionDecision: "deny"` ou exit 2; `UserPromptSubmit` bloqueia com `decision: "block"` ou exit 2; `PostToolUse` não desfaz a chamada, só troca o resultado por feedback; handlers `async` nunca bloqueiam.

**O que o Nirvana instala:** grupos `PreToolUse` e `PostToolUse` em `~/.codex/hooks.json`, matcher `Bash|apply_patch`, handlers de comando async que rodam `audit-emit-from-hook.ts`, com os registros de trust gravados por `skills/_shared/lib/codex-hooks.ts`. Chamadas de tools MCP não casam hoje.

---

## 11. Invocation examples

### O que o driver roda (`runCodex`, headless)

```text
codex exec -C <cwd>
  [--add-dir <dir>]...                        # dir do projeto, raiz de outputs, dir da empresa/squad
  [-s read-only | --approve-for-me]           # noTools | --safe (modo trust não passa nenhum)
  [resume <thread_id>]                        # só ao retomar (nrv revise)
  --json --skip-git-repo-check -o <arquivo-tmp>
  [--model <id openai>]                       # só gpt-*, o<N>*, codex*; o resto é descartado
  [-c model_reasoning_effort="<nível>"]       # níveis do engine: low, medium, high, xhigh, max
  [-c agents.enabled=false]                   # salvo allowSubagents
  [-c model_provider="<provider>"]
  [--ephemeral]                               # nunca no resume
  [--output-schema <arquivo>]
  [-i <imagem>]...
  [-c web_search="<modo>"]
  [--dangerously-bypass-approvals-and-sandbox] # modo trust (padrão)
  < prompt no stdin
```

- `-C`, `--add-dir`, `-s` e `--approve-for-me` existem só no pai `exec`, por isso vêm antes de `resume`. Depois dele são erro de parse (exit 2).
- A diretiva (`appendSystemPrompt`) não tem flag; ela vai dobrada no prompt do stdin como preâmbulo seguido de `---`.
- O id da sessão é `thread.started.thread_id` do stream `--json`. A resposta final é lida do arquivo de `-o`.
- Se um Codex antigo rejeita uma flag (`unexpected argument`), o driver a remove e tenta de novo, até quatro vezes, para `--add-dir`, `--approve-for-me` (trocada por `-s workspace-write`), `--ephemeral`, `--output-schema`, `-i`, `-c` e `--model`.

Execução concreta (modo trust, projeto fora de git):

```bash
codex exec -C /work/proj --add-dir /work/proj/outputs \
  --json --skip-git-repo-check -o /tmp/codex-last.txt \
  -c model_reasoning_effort="high" -c agents.enabled=false \
  --dangerously-bypass-approvals-and-sandbox < brief.md
```

Resume para uma revisão (mesmas flags do pai, depois o subcomando):

```bash
codex exec -C /work/proj resume 0199a3c2-... \
  --json --skip-git-repo-check -o /tmp/codex-last.txt \
  -c agents.enabled=false --dangerously-bypass-approvals-and-sandbox < revisao.md
```

### Worker interativo do Orca (`interactiveArgv`)

```text
codex [--dangerously-bypass-approvals-and-sandbox] [-m <id openai>]
  [-c model_reasoning_effort="<nível>"] [-c agents.enabled=false] [--add-dir <dir>]...
```

### Camada leve (`callHostAgent`, chamadas de judge e tradução)

`codex exec [--dangerously-bypass-approvals-and-sandbox]`, prompt no stdin. Não passa `-C` nem `--skip-git-repo-check`, então com `headless_skip_permissions=false` a partir de um cwd fora de git o Codex sai com exit 1 antes do model.

### Superfície do `codex exec` (0.159.2)

| Forma | Uso |
|---|---|
| `codex exec [OPTIONS] [PROMPT]` | Uma execução. Sem prompt, ou com `-`, lê o stdin; prompt mais stdin em pipe anexa um bloco `<stdin>`. |
| `codex exec resume [SESSION_ID] [PROMPT]` | Continua uma thread por UUID ou nome de thread, ou `--last`. `--all` tira o filtro de cwd. Sem prompt, lê o stdin quando há pipe. |
| `codex exec fork <SESSION_ID> [PROMPT]` | Thread nova ramificada de uma existente; a original não muda. |
| `codex exec review [PROMPT]` | Code review do repo atual: `--uncommitted`, `--base <branch>`, `--commit <sha>`, `--title`. |

Opções só do pai: `-C/--cd`, `--add-dir`, `-s/--sandbox`, `--approve-for-me`, `-p/--profile`, `--oss`, `--local-provider`, `--color`. Compartilhadas pelos subcomandos: `-c`, `--enable`/`--disable <feature>`, `--strict-config`, `-m`, `-i`, `--dangerously-bypass-approvals-and-sandbox`, `--dangerously-bypass-hook-trust`, `--worktree`, `--thread-source`, `--skip-git-repo-check`, `--ephemeral`, `--ignore-user-config`, `--ignore-rules`, `--output-schema`, `--json`, `-o/--output-last-message`.

### Stream de eventos JSON (`--json`)

`type` de topo: `thread.started` (`thread_id`), `turn.started`, `turn.completed` (`usage`), `turn.failed` (`error.message`), `item.started` / `item.updated` / `item.completed` (`item`), `error` (`message`). `usage` traz `input_tokens`, `cached_input_tokens`, `cache_write_input_tokens`, `output_tokens`, `reasoning_output_tokens`. Tipos de item incluem `agent_message`, `reasoning`, `command_execution`, `file_change`, `mcp_tool_call`, `collab_tool_call`, `web_search`, `todo_list`, `error`. Nenhum evento traz o nome do model.

Contrato de falha usado pelo driver: exit 0 não é sucesso. Um `error` terminal ou `turn.failed` marca falha; um `turn.completed` posterior limpa; um `item` do tipo `error` é aviso.

---

## 12. Runtime-specific validators

- **Id do model**: só um id OpenAI chega a `--model` / `-m`. Um alias Claude fixado na sessão é descartado.
- **Effort por model**: o Codex valida `model_reasoning_effort` contra a entrada do model no catálogo. `gpt-6-luna` e `gpt-5.6-luna` param em `max`; `ultra` existe no Codex para alguns models, mas não é nível do engine, então o engine nunca o envia.
- **Models aposentados**: `gpt-5.5` sai do Codex em 2026-10-14. Nunca o coloque em exemplo, default ou entrada de cascade.
- **Flags de aprovação**: nunca passe `-s` junto com `--approve-for-me`.
- **Local das skills**: instale skills em `~/.agents/skills`; uma cópia no deprecado `$CODEX_HOME/skills` aparece listada duas vezes.

---

## 13. Known limitations

1. **Sem limite de turns por execução** → limitado só por timeout.
2. **Sem custo em USD** → só contagem de tokens; sem `--model` passado e sem model no stream de eventos, a busca de preço pode falhar e orçamentos `$N` em entradas `codex:` do cascade passam sem trava.
3. **Sem allowlist por tool** → sandbox, caminho de aprovação e deny no `PreToolUse` são os gates.
4. **Sem flag de append-system-prompt** → a diretiva viaja dentro do prompt do usuário.
5. **Trust dos hooks preso à ordem dos grupos** → uma edição alheia no `hooks.json` pode desligar os hooks de audit do Nirvana até `nrv setup`.
6. **Skills instaladas na raiz deprecada** → `runtime-dirs.ts` ainda mira `~/.codex/skills`, e o alvo OpenClaw preenche `~/.agents/skills`, então o Codex lista `nirvana` duas vezes.
7. **Sem configuração de janela de contexto nesta linha** → o engine não passa `model_auto_compact_token_limit`; vale a config do usuário.
8. **Sem scheduler e sem primitiva de time** → cron externo e convenções no file system.
9. **Mentions e tickets** dependem do harness fazer o fan-out entre execuções.

---

## 14. Source references

- `codex --help`, `codex exec --help`, `codex exec resume|fork|review --help`, `codex features list`, `codex debug models --bundled` (0.159.2, 2026-10-11)
- Fonte do Codex em `rust-v0.162.1`: `codex-rs/exec/src/cli.rs`, `codex-rs/exec/src/exec_events.rs`, `codex-rs/ext/skills/src/host_roots.rs`, `codex-rs/core/config.schema.json`
- Hooks: https://developers.openai.com/codex/hooks (redireciona para learn.chatgpt.com/docs/hooks)
- Subagents: https://developers.openai.com/codex/subagents (redireciona para learn.chatgpt.com/docs/agent-configuration/subagents)
- Skills: https://developers.openai.com/codex/skills
- Releases: https://github.com/openai/codex/releases
- Driver: `skills/_shared/lib/host-agent-driver.ts` (`runCodex`, `buildCall` da camada leve), `skills/_shared/lib/orca-worker.ts` (`interactiveArgv`), `skills/_shared/lib/codex-hooks.ts`, `skills/harness/lib/business-session.ts`
- Squad Protocol v5: `~/.nirvana/skills/squads/SQUAD_PROTOCOL_V5.md`
- Business Protocol v1: `~/.nirvana/skills/businesses/BUSINESS_PROTOCOL_V1.md`
- Harness Protocol v1: `~/.nirvana/skills/harness/HARNESS_PROTOCOL_V1.md`

---

## 15. Version history

| Versão | Data | Mudanças |
|---|---|---|
| 1.0.0 | 2026-05-02 | Doc inicial: cobre Squad 5.0 + Business 1.0 + Harness 1.0 contra Codex CLI 0.2x |
| 2.0.0 | 2026-10-11 | Reescrito contra Codex CLI 0.159.2 / 0.162.1. Removidos `codex run`, `--max-turns`, `--output-format json`, `--checkpoint`, `--agent`/`--skill`/`--prompt`, custom agents em Markdown e `[agents.<nome>]`/`agents.max_depth`, que não existem. Documentados o argv real de `runCodex` e do Orca, a superfície `exec`/`resume`/`fork`/`review`, os eventos JSON, os 12 eventos de hook e o trust, skills em `~/.agents/skills`, custom agents em TOML, `agents.enabled` e a ausência de limite de turns. |
