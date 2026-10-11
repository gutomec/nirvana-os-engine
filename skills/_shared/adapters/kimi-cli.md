# Adapter · Kimi Code CLI (Moonshot Kimi Code)

> Runtime adapter para Squad Protocol v5 + Business Protocol v1 + Harness Protocol v1.
> Cobre os 3 protocolos em um único doc. Seções canônicas conforme Squad v4 §18.5.
> Identidade + capabilities do sistema (o que o Nirvana-OS é e pode fazer): ver `../NIRVANA-OS.md` (fonte única).
> Espelha o `codex.md` (dispatch sub-process, sem arquivo de agent por employee escrito pelo engine).

Todo comando e flag abaixo vem da documentação oficial do Kimi Code (`MoonshotAI/kimi-code`, `docs/en/`, lida em 2026-10-11) ou do `runKimi` em `skills/_shared/lib/host-agent-driver.ts`. O Kimi não está instalado na máquina da auditoria, então nada aqui rodou contra um binário real; a §13 lista o que isso deixa em aberto.

---

## 1. Adapter Metadata

| Campo | Valor |
|---|---|
| `runtime` | `kimi-cli` |
| `vendor` | Moonshot AI |
| `min_version` | Kimi Code CLI 2.x, npm `@moonshot-ai/kimi-code` (reescrita em Node, binário único `kimi`, última 2.1.1 em 2026-09-24). A linha legada em Python, PyPI `kimi-cli` (última 1.52.0 em 2026-09-22), também instala um binário chamado `kimi`; a Moonshot diz que ela "will gradually be phased out". Qual dos dois está no PATH decide o conjunto de flags, por isso o driver re-executa sem as flags que um build rejeita (§7). |
| `default_model` | herdado do runtime. O engine NUNCA define model; vem da entrada `kimi-cli:<model>` do `LLM_CASCADE` e chega ao `-m` sem alteração. O `-m` recebe um alias de modelo definido no `config.toml` (o exemplo da documentação define `kimi-code/k3`, `kimi-code/kimi-for-coding`, `kimi-code/kimi-for-coding-highspeed`). Sem `-m`, vale o `default_model` do `config.toml`. |
| `tested_against` | Não executado aqui. Flags conferidas contra a referência do comando `kimi` e o changelog 2.1.1. |
| `config_paths` | 2.x: `~/.kimi-code/config.toml` (acompanha `KIMI_CODE_HOME`), `~/.kimi-code/mcp.json`, `~/.kimi-code/AGENTS.md`, `~/.kimi-code/SYSTEM.md`; no projeto `.kimi-code/local.toml`, `.kimi-code/mcp.json`, `AGENTS.md`. Legada: `~/.kimi/`. |
| `skills_root` | Usuário: `~/.kimi-code/skills/` e `~/.agents/skills/`. Projeto (diretório mais próximo com `.git`): `.kimi-code/skills/` e `.agents/skills/`. Extra: `extra_skill_dirs` no `config.toml`. Prioridade Projeto > Usuário > Extra > Built-in. O `nrv install` não linka nenhum diretório específico do Kimi; as skills do Nirvana chegam ao Kimi por `~/.agents/skills/` (linkado quando o OpenClaw está presente) ou por um `.agents/skills/` do projeto. |
| `agents_root` | Arquivos de agent custom (Markdown, frontmatter + system prompt) em `.kimi-code/agents/`, `.agents/agents/` e diretórios de usuário/extra/plugin; `--agent <name>` ou `--agent-file <path>` escolhe o agent principal. O engine não usa nenhum dos dois: a persona vai no prompt do `-p`. |
| `memory_root` | `AGENTS.md`: global `~/.kimi-code/AGENTS.md`, cross-tool `~/.agents/AGENTS.md`, projeto `AGENTS.md` ou `.kimi-code/AGENTS.md`. |
| `audit_log` | `~/.harness-logs/` (jsonl via driver). O Kimi guarda cada sessão em `~/.kimi-code/` com `agents/main/wire.jsonl` (prompts, mensagens, tool calls, estado final); `kimi export <id>` empacota a sessão em ZIP. |
| `protocol_versions` | Squad 5.0, Business 1.0, Harness 1.0 (com gaps registrados em §13) |

---

## 2. Feature Support Matrix

`✓` = nativo · `~` = workaround/parcial · `✗` = não suportado

| Feature (Business v1 §6) | Squad v5 | Business v1 | Harness v1 | Notas |
|---|---|---|---|---|
| `max_turns` | ~ | ~ | ~ | Sem flag de CLI. `[loop_control] max_steps_per_turn` no `config.toml`, ou a env `KIMI_LOOP_MAX_STEPS_PER_TURN`, limita os steps por turn; o engine não define nenhum dos dois e depende do próprio timeout |
| `tool_whitelist` | ~ | ~ | ~ | Sem flag de CLI. `[tools] enabled/disabled` e `[[permission.rules]]` no `config.toml`, ou uma lista `tools` num arquivo de agent; o engine não passa nenhum deles |
| `subagent_spawning` | ✓ | ✓ | ✓ | Sub-agents built-in `coder`, `explore`, `plan` via tool `Agent`, além de `AgentSwarm`. O engine não os desliga em runs `-p` |
| `audit_trail` | ✓ | ✓ | ✓ | `wire.jsonl` por sessão; o harness adiciona jsonl próprio via `runKimi` |
| `scheduled_invocation` | ✗ | ✗ | ✗ | Sem agendador; degradar para cron externo |
| `event_bus` | ~ | ~ | ~ | Mentions/tickets via file-system; sem broker |
| `hooks` | ✓ | ✓ | ✓ | `[[hooks]]` no `config.toml`, 20 eventos, três deles bloqueantes (§10). Ainda não ligados ao audit do engine |
| `sandboxing` | ~ | ~ | ~ | Fronteira do workspace (o 2.1.0 bloqueia fuga por symlink e rejeita dirs extras que resolvem para a home ou `/`) e permission rules; sem profiles de sandbox do OS |
| `session_memory` | ✓ | ✓ | ✓ | Sessões persistem; `-S/--session [id]`, `-c/--continue`, `kimi session list` |
| `project_memory` | ✓ | ✓ | ✓ | `AGENTS.md` no projeto |
| `global_memory` | ✓ | ✓ | ✓ | `~/.kimi-code/AGENTS.md` e `~/.agents/AGENTS.md` |
| `handoff_artifacts` | ✓ | ✓ | ✓ | JSON da última mensagem do assistant na saída `stream-json` (§7) |
| `fork_context` | ~ | ~ | ~ | `/fork` só no TUI; o engine abre um sub-process novo |
| `teammate_primitive` | ✗ | ✗ | ✗ | Sem primitive de time; team é convenção via file system |
| `telemetry_otel` | ✗ | ✗ | ✗ | Sem export OTel documentado; `KIMI_DISABLE_TELEMETRY=1` desliga a telemetria anônima |
| `mcp` | ✓ | ✓ | ✓ | `mcp.json` (usuário `~/.kimi-code/mcp.json`, projeto `.kimi-code/mcp.json`), stdio, HTTP e SSE, OAuth via `/mcp-config login`. Não há flag de CLI para arquivo de config MCP |

> **Nota fora da matriz canônica:** o que o Kimi soma ao cascade é um modelo de 1M tokens (`kimi-code/k3` aparece com `max_context_size = 1048576` no exemplo de config da documentação) e o login OAuth do Kimi Code (§8).

---

## 3. Concept Mapping

| Conceito (Protocolo) | Equivalente Kimi Code | Implementação |
|---|---|---|
| Squad / Business | Diretório de skills + AGENTS.md | `.agents/skills/<name>/` (projeto) ou `~/.agents/skills/` + `AGENTS.md` do CWD |
| Capability | Skill ou workflow file | `<skill>/capabilities/<id>.md`, lido pelo agent a partir do brief |
| Employee | Persona embutida no prompt do `kimi -p` | persona-núcleo + DNA no corpo do prompt; o engine não escreve arquivo de agent |
| `is_brief_intake: true` | Persona default quando skill ativa | Montada no prompt |
| `is_antagonist: true` | Sub-process invocado em pipeline | `kimi -p "<persona+brief>" --output-format stream-json -m <model>` |
| Handoff artifact | Última mensagem do assistant (stream-json) + arquivo | Persistido em `<project>/.handoffs/` |
| Mention `@employee` | Convenção no handoff | Adapter detecta → novo sub-process |
| Ticket | Arquivo persistido | `<project>/.tickets/<TICKET_ID>.json` |
| Escalation trigger | Wrapper script + harness call | Wrapper checa condição → emite notification para harness |
| Permanent memory | `AGENTS.md` (global + projeto) + files custom | Load nativo do `AGENTS.md` |
| Project memory | `<project>/AGENTS.md` | Nativo |
| Session memory | Diretório da sessão + `wire.jsonl` | Compaction automática (`[loop_control] reserved_context_size`) |
| Routing decision (harness) | Pre-spawn lookup table | BM25 sobre `capabilities[].examples[]` em wrapper Bun |

---

## 4. Frontmatter Mapping

### Squad v5 / Business v1 → AGENTS.md

O Kimi lê `AGENTS.md` nativamente, mas não tem frontmatter de protocolo. O adapter mantém os mesmos dois arquivos do Codex:

```yaml
# AGENTS.md (head do projeto/skill)
You are an AI agent operating under the Squad/Business Protocol.

Available capabilities: [media.video.analyze, media.transcript.extract, ...]
Default tools: [Read, Write, Bash]
```

```yaml
# .agents/manifest.yaml (auxiliar: lido por wrapper, não pelo Kimi)
name: nexus-council
protocol: 1.0
employees: [ceo, marketing-lead, ...]
operation_mode: zero_human
```

### Employee → prompt do `kimi -p`

O engine não escreve arquivo de agent. A persona do employee é montada no prompt, junto com a diretiva do engine (o Kimi não tem flag de system prompt):

```
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

Um arquivo de agent do Kimi (`--agent-file <persona.md>`, com lista `tools`) poderia levar a persona como system prompt de verdade, com tool list imposta. Ainda não usado (§13).

---

## 5. Tool Whitelist Mechanics

- O Kimi não tem flag `--tools`/`--allowedTools`. Os controles que existem moram na config ou em arquivos de agent:
  - `[tools] enabled = [...]` / `disabled = [...]` no `config.toml`: allowlist/denylist global, aplicada antes da execução. Nomes built-in são exatos e case-sensitive (`Read`, `Bash`, `Grep`); tools MCP casam por glob (`mcp__github__*`).
  - `[[permission.rules]]` com `decision = "allow" | "deny" | "ask"` e `pattern = "Bash(rm -rf*)"`. No `-p` nunca há pedido de aprovação; regras de deny estáticas continuam valendo.
  - As listas `tools` / `disallowedTools` de um arquivo de agent custom.
- O engine não passa nada disso hoje, então um worker `-p` tem o tool set inteiro sob permissão `auto`. O whitelist é o "## Tools permitidos" da persona mais os gates do próprio engine.
- `--yolo`, `--auto` e `--plan` são rejeitados junto com `-p`; nunca adicione a um run headless.

---

## 6. Max-Turns Mechanics

O Kimi não tem `--max-turns`, nem flag de effort, nem teto de gasto na linha de comando.

1. Cada employee roda como sub-process `kimi -p`, com o timeout do driver (`opts.timeoutMs` → `spawnSync`).
2. Existe um teto real de steps na config: `[loop_control] max_steps_per_turn` (vazio ou `0` = ilimitado), sobrescrito por `KIMI_LOOP_MAX_STEPS_PER_TURN`. O engine não o define.
3. O print mode fica vivo enquanto houver background task pendente (`print_background_mode = "steer"` por default; limites `print_wait_ceiling_s` e `print_max_turns`, ambos na prática ilimitados). Um worker que deixa uma task `Bash` em background segura o processo até o timeout do engine.
4. Effort de thinking é só config: `[thinking] effort` ou o `default_effort` do modelo. Os perfis de effort do engine não chegam ao Kimi (`EFFORT_CAPABLE` contém só claude-code e codex).

---

## 7. Subagent Spawning

O Kimi tem sub-agents nativos (`coder`, `explore`, `plan`, despachados pelo agent principal via tool `Agent`, e `AgentSwarm`), cada um com janela de contexto própria. O engine não os usa para dispatch: cada employee é um sub-process `kimi -p` (`host-agent-driver.runKimi`). O argv que ele monta:

```bash
kimi -p "<prompt ou bootstrap>" --output-format stream-json [-m <model>] [--add-dir <dir>]...
```

- `-p "<prompt>"`: um prompt não interativo, sem TUI, permissão `auto`. Prompts acima de `MAX_ARGV_PROMPT_BYTES` vão para um arquivo temporário e o `-p` leva um bootstrap curto que aponta para ele (não há stdin nem flag de prompt-file documentados).
- `--output-format stream-json`: uma mensagem JSON por linha no stdout. Thinking não é escrito; progresso de tools e avisos de "resuming session" vão para o stderr.
- `-m <model>`: só quando a entrada do cascade nomeia um modelo.
- `--add-dir <dir>`: um por diretório que o dispatch concede (projeto, outputs, business, squads). `RUNTIME_DIR_GRANT_FLAG["kimi-cli"] = "--add-dir"`. Caminhos relativos resolvem contra o cwd; o 2.1.0 rejeita dir que resolve para a home ou `/`.

Fallbacks, em ordem: se o run falha e o stderr cita `add-dir`, o driver tira todos os `--add-dir`, avisa `kimi-cli: this version does not know --add-dir; retried without it (...)` e re-executa; se então falhar com `output-format`/unknown/unrecognized/invalid option, re-executa sem `--output-format` e fica com o stdout em texto puro.

**Leitura do stream.** A sequência documentada é: uma mensagem Assistant; quando o modelo chama uma tool, uma mensagem Assistant com `tool_calls`, depois a mensagem Tool, depois mais mensagens Assistant. O driver fica só com as mensagens de role assistant. O resultado é a última mensagem do assistant sem `tool_calls` (senão, o último texto do assistant). Mensagens Tool nunca entram no resultado, porque carregam dump de arquivo e saída de comando. Linhas sem role caem na leitura antiga por campo de texto; stdout que não é JSON fica inteiro.

**Contrato de falha.** O driver ainda respeita um evento `error` e um evento `result` com `is_error`, mas a documentação do Kimi não documenta nenhum dos dois, nem campo de custo. Na prática a falha depende do exit code, e o custo sai como indisponível (`costUsd: null`).

**Resume.** O `runKimi` gera ou reaproveita um session id só como rótulo e **não** passa `--session` ainda, embora o Kimi tenha `-S/--session <id>`. O `nrv revise` portanto abre uma sessão nova do Kimi; a continuidade vem do `HANDOFF.json` e dos arquivos em disco.

**Para mention `@x`:** adapter detecta no handoff retornado, abre novo sub-process para `x`.

**Fan-out paralelo:** ao nível do OS (sub-processes `kimi -p` independentes).

**Worker visível do Orca.** O `orca-worker.ts` abre `kimi [-m <model>]` sem flag de permissão, então um worker Kimi visível para nos prompts de aprovação.

---

## 8. Memory Storage

| Camada | Path | Persistência |
|---|---|---|
| Permanent (cross-session) | `~/.kimi-code/AGENTS.md`, `~/.agents/AGENTS.md` + files custom | Load nativo |
| Project | `<project>/AGENTS.md` ou `.kimi-code/AGENTS.md` | Load nativo |
| Session | Diretório da sessão em `~/.kimi-code/`, `agents/main/wire.jsonl` | Nativa; compaction automática |
| Business permanent | `~/businesses/<biz>/memory/permanent.md` | Adapter persiste |
| Project (business) | `<project>/<biz>/<project_id>/memory/` | Isolation by construction |

> **Isolation guard:** o Kimi não isola memory por project id. O adapter monta o prompt com APENAS o memory relevante ao `project_id`, caso contrário `audit_event: isolation_violation`.

**Autenticação.** Por default o Kimi não lê chaves de provider do shell: "Except for the explicitly declared `api_key_env`, the CLI does not fall back to shell environment variables for credentials." Rotas:

- **OAuth do Kimi Code**: `/login` no TUI, ou `kimi login` (device code RFC 8628, sem flags; exit 0 no sucesso). O token fica salvo localmente e é carregado no próximo start. Essas contas não aparecem em `/provider`. O driver não reporta custo para elas.
- **Providers no `config.toml`**: `[providers.<id>]` com `type = "kimi"` (`base_url` default `https://api.moonshot.ai/v1`), tipos Anthropic ou OpenAI-compatible, e `api_key` ou `api_key_env` (exatamente um). `kimi provider add <registry-url>` e `kimi provider catalog add <id> --api-key ...` escrevem essas entradas sem TUI.
- **Envs `KIMI_MODEL_*`** sintetizam um provider temporário em memória (não persiste).

Migração: `kimi migrate` copia config, servidores MCP e sessões do legado `~/.kimi/` para `~/.kimi-code/`. Credenciais OAuth e autorizações MCP não são copiadas; rode `/login` de novo.

---

## 9. Context Window & Compaction

- Janela: por entrada de modelo (`max_context_size`). O exemplo da documentação declara `kimi-code/k3` com 1.048.576 tokens e `kimi-code/kimi-for-coding` com 262.144.
- Compaction: automática quando o restante da janela fica abaixo de `[loop_control] reserved_context_size`; `compaction_max_attempts` (default 5) limita as tentativas.
- Um brief acima de 100K tokens cabe no `k3` sem truncamento agressivo.

---

## 10. Hook System

O Kimi tem hooks: entradas `[[hooks]]` em `~/.kimi-code/config.toml` com exatamente quatro campos, `event`, `matcher` (regex), `command`, `timeout` (1-600 s, default 30). O JSON do evento chega pelo stdin (campos em snake_case). Exit `0` permite, `2` bloqueia (o stderr vira o motivo), qualquer outro valor é fail-open, assim como crash e timeout. Só `PreToolUse`, `Stop` e `UserPromptSubmit` podem bloquear.

| Hook desejado | Evento Kimi |
|---|---|
| `PreToolUse` | `PreToolUse` (bloqueante; roda antes das checagens de permissão) |
| `PostToolUse` | `PostToolUse` / `PostToolUseFailure` (só observação) |
| `UserPromptSubmit` | `UserPromptSubmit` (bloqueante; o stdout é anexado ao contexto) |
| `Stop` | `Stop` (bloqueante; um bloqueio deixa o modelo continuar) |
| `SessionStart` | `SessionStart` (`startup` ou `resume`) |
| `Compact` | `PreCompact` / `PostCompact` |

Fail-open quer dizer que hook é alerta e guarda leve, nunca a única barreira. O engine ainda não instala hooks do Kimi, então o audit depende do jsonl do driver.

---

## 11. Invocation Examples

### Exemplo 1: Squad capability

```bash
# User: "transcrever vídeo do Instagram https://..."
kimi -p "You are instagram-intelligence. Analyze video: https://..." \
  --output-format stream-json -m kimi-code/k3 --add-dir "$PROJECT"
```

### Exemplo 2: Business brief com handoff em pipeline

```bash
# CEO recebe brief
kimi -p "<persona ceo + brief + contrato JSON>" --output-format stream-json \
  -m kimi-code/k3 --add-dir "$PROJECT" > .handoffs/ceo-1.ndjson

# Adapter detecta `next_action: delegate to marketing-lead`
kimi -p "<persona marketing + contexto do ceo + contrato JSON>" --output-format stream-json \
  -m kimi-code/k3 --add-dir "$PROJECT" > .handoffs/marketing-1.ndjson

# A resposta é a última linha do assistant sem tool_calls (§7); linhas Tool são ignoradas
```

### Exemplo 3: Harness escalation

```bash
# Wrapper detecta budget_violation
echo '{"type":"human_escalation_required","trigger_id":"budget","severity":"high",...}' \
  > .harness/notifications/$(date +%s).json
# Harness orchestrator (em outro runtime ou interativo) consome o file
```

---

## 12. Runtime-Specific Validators

- **Qual linha está instalada**: `kimi --version` (`-V`). O alvo é a 2.x; um build legado 1.x perde o `--add-dir` (o driver avisa) e pode não ter `stream-json`.
- **Credencial presente**: login OAuth feito, ou uma entrada `[providers.<id>]` com `api_key`/`api_key_env`. `kimi doctor` valida `config.toml` e `tui.toml` sem abrir o TUI (exit 1 em arquivo inválido).
- **Model resolvível**: o `kimi-cli:<model>` do cascade tem que ser um alias do `config.toml` (`kimi provider list --json` imprime a tabela).
- **Trust do workspace**: desde o 2.1.0 a configuração local do projeto só vale depois que a pasta é confiada, e o `-p` não consegue mostrar o prompt. Servidores de `.kimi-code/mcp.json` do projeto ficam desligados em runs headless, a menos que o workspace já seja confiado ou `KIMI_CODE_TRUST_WORKSPACE=1` esteja definido para o processo. O engine não define essa env.
- **Dirs concedidos**: nenhum pode resolver para a home ou `/` (o 2.1.0 rejeita).
- **Windows**: exige Git for Windows (o Git Bash é o shell do Kimi); defina `KIMI_SHELL_PATH` quando o `bash.exe` estiver num local custom.

---

## 13. Known Limitations

1. **Sem resume de sessão pelo engine**: `--session <id>` existe, mas o `runKimi` não passa; o `nrv revise` começa do zero.
2. **Contrato de falha e de custo não verificado**: a documentação não mostra evento `result`/`error` nem campo de custo, então a detecção de falha é o exit code e o custo fica indisponível. Fixar os campos reais com um run `kimi -p ... --output-format stream-json` assim que a CLI for instalada.
3. **Nomes de campo do stream inferidos**: o driver lê `role` (no topo ou dentro de `message`), `content` e `tool_calls`; a documentação descreve a sequência, não as chaves JSON.
4. **Sem tool whitelist vinda do engine**: o `-p` roda sob permissão `auto` com todas as tools; `[tools]`/permission rules na config ou um arquivo de agent imporiam uma.
5. **Sub-agents não desligados**: um worker `-p` pode abrir filhos `Agent`/`AgentSwarm` que nunca passam pelo contador de profundidade do engine.
6. **Sem flags de effort, max-turns ou budget**: só config e env (§6); os perfis do engine não chegam ao Kimi.
7. **Background tasks esticam o print mode**: uma task pendente em background mantém o `kimi -p` vivo até o timeout do engine.
8. **Trust gate em runs headless**: servidores MCP do projeto e config local ficam desligados se o workspace não for confiado.
9. **Dois binários chamados `kimi`**: a linha legada em Python pode rejeitar `--add-dir` e `stream-json`; o driver degrada com aviso.
10. **Worker visível do Orca sem flag de autonomia**: para nos prompts de aprovação (`--auto` existe para runs interativos, ainda não adicionado).
11. **Hooks fora do audit**: os `[[hooks]]` do Kimi poderiam alimentar o script de audit como em claude/codex/gemini; não feito.

**Vantagem compensatória:** modelo de 1M tokens, sub-agents nativos, hooks e MCP, e uma rota OAuth sem conta por token para o engine rastrear.

---

## 14. Source References

- Kimi Code CLI: repo `MoonshotAI/kimi-code`, docs em `https://moonshotai.github.io/kimi-code/en/`: `reference/kimi-command`, `customization/{skills,hooks,mcp,agents}`, `configuration/{config-files,providers,env-vars,data-locations}`, `guides/{getting-started,migration,sessions}`, `release-notes/changelog` (2.1.1, 2026-09-24).
- Instalação: `curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash`, no Windows `irm https://code.kimi.com/kimi-code/install.ps1 | iex`, ou `npm install -g @moonshot-ai/kimi-code` (Node 22.19.0+).
- Linha legada: `https://pypi.org/project/kimi-cli/` (1.52.0).
- Moonshot API: `https://api.moonshot.ai/v1`.
- Driver: `skills/_shared/lib/host-agent-driver.ts` (`runKimi`, adapter `kimi-cli`, `RUNTIME_DIR_GRANT_FLAG`); worker Orca: `skills/_shared/lib/orca-worker.ts`.
- Squad Protocol v5: `~/.nirvana/skills/squads/SQUAD_PROTOCOL_V5.md`
- Business Protocol v1: `~/.nirvana/skills/businesses/BUSINESS_PROTOCOL_V1.md`
- Harness Protocol v1: `~/.nirvana/skills/harness/HARNESS_PROTOCOL_V1.md`

---

## 15. Version History

| Versão | Data | Mudanças |
|---|---|---|
| 1.0.0 | 2026-07-19 | Doc inicial: cobre Squad 5.0 + Business 1.0 + Harness 1.0 contra Kimi Code CLI (`MoonshotAI/kimi-code`), K3 / kimi-for-coding. Dispatch via `kimi -p` (sub-process, NDJSON→texto). |
| 2.0.0 | 2026-10-11 | Reescrito para o Kimi Code 2.x a partir da documentação oficial. Duas linhas de produto (Node `@moonshot-ai/kimi-code` 2.1.1 com `~/.kimi-code`, Python legada `kimi-cli` 1.52 com `~/.kimi`, ambas instalam `kimi`). O argv do driver agora leva os grants via `--add-dir` (re-executa sem eles num build que rejeita); o parser do stream fica só com mensagens do assistant. Documentados `-p` = permissão auto (rejeita `--yolo`/`--auto`/`--plan`), trust de workspace do 2.1.0, raízes de skills, `[[hooks]]`, `mcp.json`, sub-agents nativos, e que o engine não passa `--session`. Removidos `--mcp-config-file`, os números não verificados do K3 e da cota, e as afirmações de que não há hooks nem sub-agents. |
