# Adapter · Antigravity CLI (`agy`)

> Runtime adapter para Squad Protocol v5 + Business Protocol v1 + Harness Protocol v1.
> Cobre os 3 protocolos em um único doc. Seções canônicas conforme Squad v4 §18.5.
> Identidade + capabilities do sistema (o que o Nirvana-OS é e pode fazer): ver `../NIRVANA-OS.md` (fonte única).

> **CLI de agente do Google.** O `agy` substituiu o Gemini CLI nos planos individuais em 2026-06-18 (Google Developers Blog, "An important update: transitioning Gemini CLI to Antigravity CLI"). O Gemini CLI deixou de ser um runtime do Nirvana; o agy é o caminho direto do Nirvana para os modelos Gemini. O CLI é versionado em 1.x e sai uma versão a cada um ou dois dias, então cada flag abaixo foi lida de `agy --help`, `agy changelog` e dos docs que vêm com o binário na **1.3.3** (2026-10-10). Confira `agy --help` antes de confiar numa flag em outro build.

---

## 1. Metadados do adapter

| Campo | Valor |
|---|---|
| `runtime` | `antigravity-cli` |
| `vendor` | Google |
| `cli` | `agy` (o instalador oficial põe em `~/.local/bin/agy` no macOS; `agy update` atualiza no lugar) |
| `min_version` | 1.2.10 recomendada: a partir dela um turno que falha no meio do stream sai com 3 em vez de 0. `--output-format` e `--continue` existem em todo build que o engine suporta |
| `default_model` | Herdado do runtime. O engine nunca define modelo; a config do agy do usuário decide. Um modelo só é passado quando o usuário pede (`--model`). `agy models` lista os ids |
| `tested_against` | agy 1.3.3 (superfície de flags, changelog, docs embutidos). Nenhuma chamada de modelo foi feita para este doc |
| `config_root` | `~/.gemini/config/` (raiz global de customização: `config.json`, `hooks.json`, `mcp_config.json`, `skills.json`, `rules.json`, `plugins.json`, `agents.json`, `skills/`, `rules/`). Raiz do workspace: `<project>/.agents/`. Settings do CLI: `~/.gemini/antigravity-cli/settings.json` |
| `nirvana_hook` | `~/.gemini/config/hooks.json`, hook nomeado `nirvana-os`: um handler `PreInvocation` que roda `bun ".../gemini-session-start.ts" --agy`, timeout de 10 s (escrito pelo `install.ts`) |
| `skills_root` | `~/.gemini/config/skills/<name>/`, `~/.gemini/antigravity-cli/skills/<name>/`, `<workspace>/.agents/skills/<name>/` |
| `agents_root` | `<workspace>/.agents/agents/<name>.md` (custom agents em Markdown); `agents.json` numa raiz de customização ou na raiz de um plugin (1.3.3) |
| `memory_root` | `GEMINI.md` / `AGENTS.md` lidos subindo do cwd até a raiz do repo; regras globais em `~/.gemini/config/` |
| `audit_log` | Os payloads de hook trazem `transcriptPath` e `artifactDirectoryPath` (num diretório `antigravity-cli/` no caso do CLI). O Nirvana mantém o próprio audit (`outputs/<trace>/audit.jsonl`) |
| `protocol_versions` | Squad 5.0, Business 1.0, Harness 1.0 (com gaps registrados em §13) |

---

## 2. Matriz de suporte

`✓` = nativo · `~` = workaround/parcial · `✗` = não suportado

| Feature (Business v1 §6) | Squad v5 | Business v1 | Harness v1 | Notas |
|---|---|---|---|---|
| `max_turns` | ✗ | ✗ | ✗ | Não há flag de turnos ou passos. `--print-timeout <dur>` limita o tempo de relógio; um hook `Stop` recebe `terminationReason: max_steps_exceeded` quando o limite interno do agy estoura |
| `tool_whitelist` | ~ | ~ | ~ | Não há flag de tools por chamada. Um custom agent em Markdown declara `tools` e é escolhido com `--agent`; `--mode plan` e `--sandbox` restringem o comportamento. O engine não usa nenhum deles hoje |
| `subagent_spawning` | ✓ | ✓ | ✓ | Subagents nativos: `.agents/agents/*.md`, `@<subagent> <mensagem>`, `invoke_subagent` nas tools de um custom agent. O engine despacha cada turno como um processo `agy -p` próprio |
| `audit_trail` | ~ | ~ | ~ | Caminho do transcript em todo payload de hook; `--log-file` para o log do CLI. O engine audita a partir do envelope JSON |
| `scheduled_invocation` | ✗ | ✗ | ✗ | Timers que o agente agenda vivem só dentro de uma sessão. Agendamento entre runs é cron externo |
| `event_bus` | ~ | ~ | ~ | Mentions e tickets via file system; sem broker |
| `hooks` | ✓ | ✓ | ✓ | `PreToolUse`, `PostToolUse`, `PreInvocation`, `PostInvocation`, `Stop` (§10) |
| `sandboxing` | ✓ | ✓ | ✓ | `--sandbox` (sandbox de terminal do SO, macOS e Windows), `--mode accept-edits\|plan`, pedidos de aprovação a menos que `--dangerously-skip-permissions` |
| `session_memory` | ✓ | ✓ | ✓ | Conversas persistem e são retomadas com `--conversation <id>` ou `--continue` |
| `project_memory` | ✓ | ✓ | ✓ | `GEMINI.md` / `AGENTS.md` carregados do cwd até a raiz do repo |
| `global_memory` | ✓ | ✓ | ✓ | Regras globais em `~/.gemini/config/` (`AGENTS.md`, `GEMINI.md`, `rules/`) |
| `handoff_artifacts` | ✓ | ✓ | ✓ | Arquivos em disco mais o envelope JSON; `--json-schema` devolve `structured_output` validado (não ligado no engine) |
| `fork_context` | ~ | ~ | ~ | Cada subagent roda a própria conversa; subagents com workspace `branch` ganham cópia isolada (1.3.3) |
| `teammate_primitive` | ~ | ~ | ~ | Subagents mais `agy remote-control`; time formal só por convenção |
| `telemetry_otel` | ✗ | ✗ | ✗ | Nenhum export OTel documentado. O uso de tokens volta no envelope JSON |

---

## 3. Mapeamento de conceitos

| Conceito (Protocolo) | Equivalente no Antigravity | Implementação |
|---|---|---|
| Squad / Business | Skills + regras do workspace | O engine despacha o brief como um run `agy -p`; o agy também carrega qualquer `GEMINI.md` / `AGENTS.md` acima do cwd |
| Capability | Skill | `<raiz>/skills/<name>/SKILL.md` com frontmatter `name` e `description`, ou o texto da capability dentro do brief |
| Employee | Persona no prompt; custom agent do agy opcional | O engine manda a persona do employee e o brief num único prompt `agy -p`. Um subagent avulso do agy ficaria em `.agents/agents/<name>.md`, escolhido com `--agent <name>`; o engine não gera esses arquivos |
| `is_brief_intake: true` | Primeiro turno do run | O brief é o prompt de `-p` |
| `is_antagonist: true` | Um run `agy -p` separado, ou um subagent nativo | O engine prefere um run separado com trace próprio |
| Handoff artifact | Arquivo + envelope JSON | Persistido em `<project>/.handoffs/` ou nos outputs do trace |
| Mention `@employee` | `@<subagent> <mensagem>` (nativo, 1.2.9) para subagents do agy | Mentions do Nirvana são resolvidas pelo engine, não pelo agy |
| Ticket | Arquivo persistido | `<project>/.tickets/<TICKET_ID>.json` |
| Escalation trigger | Checagem do engine + notificação ao harness | `.harness/notifications/<ts>.json` |
| Permanent memory | Regras globais em `~/.gemini/config/` + arquivos do engine | A memória do business fica em `~/businesses/<biz>/memory/` |
| Project memory | `<project>/AGENTS.md` / `GEMINI.md` | Auto-load |
| Session memory | Conversa do agy | Retomada com `--continue` |
| Routing decision (harness) | Nenhum no agy | O orquestrador roteia antes do spawn |

---

## 4. Mapeamento de frontmatter

### Squad v5 / Business v1 → skill do agy

O agy lê Agent Skills: um diretório com `SKILL.md` cujo frontmatter YAML tem `name` (minúsculo, com hífens) e `description` (quando usar). Pastas opcionais `scripts/`, `examples/`, `resources/`, `references/` ficam ao lado.

```markdown
---
name: media-video-analyze
description: Use this skill when the brief asks to analyze a video and extract a transcript.
---

# Steps
1. ...
```

`GEMINI.md` / `AGENTS.md` não aceitam frontmatter e valem sempre para o escopo do seu diretório.

### Employee → custom agent do agy (opcional)

Um custom agent em Markdown em `.agents/agents/<name>.md`. As chaves de frontmatter que o changelog cita são `tools`, `skills`, `rules`, `agents`, `plugins`, `hooks`, `inheritCustomizations` e `excludeDefaultComponents`; caminhos relativos resolvem contra o diretório do arquivo do agent. O schema completo está na referência online (https://antigravity.google/docs/cli/reference), não nos docs embutidos, então só gere um depois de conferir lá. Para `type: mind_clone`, o adapter prepende `(DISCLOSURE: AI-generated persona, not real person.)` à description.

---

## 5. Mecânica de whitelist de tools

- O agy não tem flag que liste as tools permitidas numa chamada. A restrição vem de três lugares: a lista `tools` de um custom agent (com `--agent`), `--mode plan` (planejar antes de agir) e hooks `PreToolUse` que respondem `allow`, `deny`, `ask` ou `force_ask` por nome de tool (`run_command`, `view_file`, `browser_.*`, ...).
- Aprovação: sem `--dangerously-skip-permissions`, um run headless para na primeira tool que pede aprovação. Desde a 1.2.15 um pedido negado é respeitado e o agente não tenta contorná-lo.
- O engine passa `--dangerously-skip-permissions` a menos que o run peça segurança (`opts.yolo === false`, o caminho `--safe`). Ele **não** respeita `opts.noTools` no agy: chamadas só de resposta ainda rodam com todas as tools (§13).

---

## 6. Mecânica de max-turns

O agy não expõe limite de turnos ou iterações na linha de comando. O que existe:

1. `--print-timeout <dur>` (duração no formato Go, por exemplo `20m`). O padrão `0s` espera o turno terminar; desde a 1.2.9 o run espera as tarefas em background até esse prazo, com teto de 30 minutos.
2. O limite interno de passos do agy, visível a um hook `Stop` como `terminationReason: "max_steps_exceeded"`.
3. O timeout de spawn do engine (`opts.timeoutMs`), que mata o processo; o resultado reporta exit 124 e nada é parseado.

Um `max_turns` do protocolo, portanto, não é aplicável no agy. O engine não passa `--print-timeout` hoje.

---

## 7. Spawn de subagents

**O que o engine roda.** Cada turno é um processo `agy`, com uma spawn só (`runAntigravity` em `skills/_shared/lib/host-agent-driver.ts`):

```bash
agy -p "<prompt ou bootstrap>" --output-format json \
  [--continue] \
  [--model <id>] \
  [--dangerously-skip-permissions] \
  [--add-dir <dir>]...
```

- `-p` (alias `--print`, `--prompt`): roda um prompt sem interação. O prompt é `appendSystemPrompt + "\n\n---\n\n" + prompt` quando há preâmbulo.
- Entrega do prompt: argv até 100 000 bytes (6 000 no Windows). Acima disso o engine grava o prompt num arquivo temporário UTF-8 e manda um bootstrap curto mandando o agy ler e executar o arquivo. O engine não usa `--input-format stream-json`, então a leitura do arquivo precisa de aprovação de tool no modo `--safe`.
- `--output-format json`: um objeto JSON no fim. O engine lê `response` (ou `result`), `session_id` / `sessionId` / `conversation_id`, `is_error`, `error` e `usage` (`input_tokens`, `output_tokens`, `thinking_tokens`, `cache_read_tokens`). Não vem custo em USD, então o run é marcado `costUnavailable` e precificado pelos tokens.
- Retomada: nesta linha é sempre `--continue` (agy: "Continue the most recent conversation"), passado sempre que `opts.sessionId` existe. `--conversation <id>` existe no agy, mas este driver não o usa. O agy não aceita um id escolhido antes.
- `--model <id>`: só a partir de `opts.model` ou do modelo de sistema resolvido.
- `--dangerously-skip-permissions`: a menos que `opts.yolo === false`.
- `--add-dir <dir>`: uma vez por diretório concedido ao run (projeto, raiz de outputs, diretório do business ou squad).
- Nunca passadas: `--effort` (ver §13), `--mode`, `--sandbox`, `--json-schema`, `--print-timeout`, `--agent`, `--disable-slash-commands`, `--conversation`.

**Sem re-spawn.** Um run que falha é reportado como falho. Desde a 1.2.10 um erro de modelo ou agente no meio do turno sai com 3 depois que o turno já foi pago, então repetir o run gasta duas vezes. A re-spawn sem `--output-format` que o driver desta linha carregava foi removida: todo agy suportado tem a flag. A recuperação fica com quem chamou.

**Camada leve.** O adapter `antigravity-cli` em `RUNTIMES`, usado em chamadas auxiliares curtas, roda `agy -p "<persona>\n\n---\n\n<mensagem>" [--dangerously-skip-permissions]` com a mesma regra de argv/arquivo temporário, em modo texto, e faz trim do stdout. A flag de skip segue o setting `execution.headless_skip_permissions` (`NIRVANA_HEADLESS_SKIP_PERMISSIONS`).

**Subagents nativos.** Numa sessão interativa do agy o modelo pode delegar a subagents definidos em `.agents/agents/`, falar com um via `@<name> <mensagem>`, ou abrir a sessão já como um deles com `--agent <name>` (funciona em headless desde a 1.2.11). O Nirvana não depende deles para despachar.

---

## 8. Armazenamento de memória

| Camada | Path | Persistência |
|---|---|---|
| Permanent (cross-session) | Regras globais em `~/.gemini/config/` (`AGENTS.md`, `GEMINI.md`, `rules/`) | Manual |
| Project | `<project>/AGENTS.md` ou `GEMINI.md`, mais todos acima do cwd até a raiz do repo | Auto-load |
| Session | Conversa do agy | Persistida pelo agy; retomável |
| Business permanent | `~/businesses/<biz>/memory/permanent.md` | O engine persiste |
| Project (business) | `<project>/<biz>/<project_id>/memory/` | Isolamento por construção |

As regras são deduplicadas por conversa. Cada arquivo de regra tem teto de 24 000 bytes (truncado em fim de linha), e as regras sempre ativas mais as globais dividem um orçamento de 20 000 tokens; o que passa do orçamento vira ponteiro para o arquivo.

> **Isolation guard:** o agy não isola memória entre projetos. O engine monta o prompt com APENAS a memória relevante ao `project_id` antes do spawn, caso contrário `audit_event: isolation_violation`. Um `GEMINI.md` / `AGENTS.md` acima do cwd do run é carregado de qualquer forma, então o cwd do dispatch importa.

---

## 9. Janela de contexto e compactação

- A janela depende do modelo em uso; `agy models` lista o que a conta pode rodar.
- A compactação é automática e distribui o orçamento de pedidos do usuário entre todos os prompts capturados (1.2.8).
- O hook `PreInvocation` `nirvana-os` roda antes de **toda** chamada de modelo, então o contexto dele é reenviado a cada vez e ocupa janela em runs longos.
- Desde a 1.3.2 `--dangerously-skip-permissions` não aprova mais o plano de implementação no modo plan; planos esperam revisão a menos que `Artifact Review` seja alterado em `/config`. Um run headless em `--mode plan` pode, portanto, travar.

---

## 10. Sistema de hooks

Hooks ficam em `hooks.json` numa raiz de customização: `~/.gemini/config/hooks.json` (global) ou `<workspace>/.agents/hooks.json`. Plugins podem trazer os seus. Cada chave de topo é um hook nomeado (`"enabled": false` desliga); handlers do mesmo evento em hooks nomeados diferentes rodam em sequência.

| Evento | Quando dispara | Formato | Saída |
|---|---|---|---|
| `PreToolUse` | Antes de um passo de tool | Agrupado: regex `matcher` no nome da tool + `hooks` | `decision`: `allow` / `deny` / `ask` / `force_ask`; opcionais `reason`, `permissionOverrides`, `overwrite` |
| `PostToolUse` | Depois de um passo de tool | Agrupado | `{}` |
| `PreInvocation` | Antes de toda chamada de modelo (a entrada traz `invocationNum`) | Lista plana de handlers | `injectSteps`: `userMessage`, `ephemeralMessage` ou `toolCall` |
| `PostInvocation` | Depois que as tool calls terminam | Plano | `injectSteps`, `terminationBehavior`: `force_continue` / `terminate` |
| `Stop` | Quando o loop termina (`terminationReason`: `model_stop`, `max_steps_exceeded`, `error`) | Plano | `decision: "continue"` volta ao loop |

- Campos do handler: `type` (só `"command"`), `command` (roda com `sh -c`, ou `cmd /c` no Windows, a partir do diretório que contém o `hooks.json`; `~` é expandido), `timeout` em **segundos**, padrão 30.
- A entrada é JSON no stdin com chaves camelCase: `conversationId`, `workspacePaths`, `transcriptPath`, `artifactDirectoryPath`, `modelName`. A saída é JSON no stdout. Hooks rodam de forma síncrona e bloqueiam o loop.
- O Nirvana instala um hook nomeado, `nirvana-os`, um `PreInvocation` que injeta o contexto de sessão do projeto como `ephemeralMessage`.

---

## 11. Exemplos de invocação

### Exemplo 1: capability de squad

```bash
agy -p "Analyze video: https://..." --output-format json --dangerously-skip-permissions
```

### Exemplo 2: brief de business, depois uma revisão

```bash
# Primeiro turno
agy -p "<brief>" --output-format json --dangerously-skip-permissions \
  --add-dir "$PROJECT" --add-dir "$OUTPUTS" > turn-1.json

# Revisão: esta linha retoma a conversa mais recente do agy
agy -p "<pedido de revisão>" --output-format json --dangerously-skip-permissions \
  --continue > turn-2.json
```

### Exemplo 3: escalation do harness

```bash
echo '{"type":"human_escalation_required","trigger_id":"budget","severity":"high",...}' \
  > .harness/notifications/$(date +%s).json
```

### Lendo o resultado

| Exit | Significado |
|---|---|
| 0 | Turno concluído. Ainda confira `is_error` / `error` no envelope |
| 1 | Erro de inicialização ou de uso, por exemplo um `--json-schema` inválido (rejeitado na inicialização desde a 1.2.14) |
| 3 | Falha de agente ou da API do modelo. O stderr traz uma linha `AGY_ERROR: {...}` em JSON (status, código de erro, se dá para repetir, id do erro; desde a 1.2.6). Desde a 1.2.10 isso também cobre um turno que transmitiu parte da resposta, e a saída JSON inclui a resposta parcial |
| 124 | Do lado do engine: o timeout de spawn matou o processo |

---

## 12. Validadores específicos do runtime

- **Flags existem**: toda flag que o engine monta está no `agy --help` da 1.3.3. Rode `agy --help` de novo depois de atualizar, antes de acrescentar uma flag.
- **Aprovação coerente**: um run sem `--dangerously-skip-permissions` não pode precisar de tools para começar (o bootstrap de prompt grande precisa ler um arquivo).
- **Modelo válido**: um modelo passado com `--model` precisa aparecer em `agy models`.
- **Tamanho das regras**: um `AGENTS.md` / `GEMINI.md` gerado precisa ficar abaixo de 24 000 bytes, senão o agy trunca.
- **Configs JSON com um nível**: desde a 1.2.10 uma entrada de diretório em `skills.json`, `rules.json`, `agents.json` ou `plugins.json` carrega só os itens diretamente dentro dela; itens aninhados precisam de `include_only`.

---

## 13. Limitações conhecidas

1. **Effort não é passado.** O agy tem `--effort low|medium|high|xhigh|max` (desde a 1.2.11, os mesmos níveis do engine), mas `EFFORT_CAPABLE` só contém `claude-code` e `codex`, então um effort pedido só gera o aviso "has no effort setting" e o agy roda no padrão dele.
2. **`noTools` é ignorado.** Chamadas só de resposta rodam com todas as tools e a flag de skip. `--mode plan` é o candidato, mas o comportamento headless do modo plan desde a 1.3.2 não foi testado.
3. **`--continue` pode pegar a conversa errada.** Nesta linha toda revisão retoma a conversa mais recente, e dois runs no mesmo diretório podem trocar de conversa. A linha 0.15 passa `--conversation <id>` quando o envelope traz um id.
4. **Sem limite de turnos** (§6) e sem lista de tools por chamada (§5).
5. **Reinjeção do hook.** O `PreInvocation` `nirvana-os` ignora `invocationNum` e `NIRVANA_DISPATCH_DEPTH`, então reenvia o contexto de sessão antes de cada chamada de modelo, inclusive em workers despachados.
6. **Paradas por cota são imediatas.** Sessões com `GEMINI_API_KEY` param na cota diária, no teto de gasto ou sem créditos (1.2.12, 1.2.13); pedidos de espera do servidor acima de 30 s encerram o run; "Your AI credits balance is too low to continue." (1.2.15). Espere exit 3.
7. **Windows.** O orçamento de argv é de 6 000 bytes, então a maioria dos briefs vai pelo bootstrap de arquivo temporário. No próprio agy: o sandbox de terminal não precisa de admin (1.2.17), comandos no sandbox caem para o Windows PowerShell quando o PowerShell 7 veio da Microsoft Store (1.3.3), e `config.json`, `hooks.json` e manifestos de plugin salvos com BOM UTF-8 carregam (1.2.16, 1.3.1). Comandos de hook rodam sob `cmd /c`.
8. **Ritmo de release acelerado.** Uma versão a cada um ou dois dias; o comportamento headless mudou várias vezes num mês (1.2.6, 1.2.9, 1.2.10, 1.3.2).

---

## 14. Referências

- `agy --help`, `agy help plugin`, `agy help mcp`, `agy models --help`, `agy changelog` (1.3.3)
- Docs embutidos: `~/.gemini/antigravity-cli/builtin/skills/agy-customizations/docs/{hooks,skills,rules,json_configs,plugins,mcp_servers}.md`
- Referência do CLI: https://antigravity.google/docs/cli/reference
- Migração do Gemini CLI: https://antigravity.google/docs/cli/gcli-migration
- Anúncio da transição: https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/
- Driver: `skills/_shared/lib/host-agent-driver.ts` (`runAntigravity`, a entrada `antigravity-cli` em `RUNTIMES`, `RUNTIME_DIR_GRANT_FLAG`, `EFFORT_CAPABLE`)
- Squad Protocol v5: `~/.nirvana/skills/squads/SQUAD_PROTOCOL_V5.md`
- Business Protocol v1: `~/.nirvana/skills/businesses/BUSINESS_PROTOCOL_V1.md`
- Harness Protocol v1: `~/.nirvana/skills/harness/HARNESS_PROTOCOL_V1.md`

---

## 15. Histórico de versões

| Versão | Data | Mudanças |
|---|---|---|
| 1.0.0 | 2026-06-06 | Doc inicial — sucessor do gemini-cli (sunset 2026-06-18); cobre Squad 5.0 + Business 1.0 + Harness 1.0 contra Antigravity 2.0 (Gemini 3 Pro) |
| 2.0.0 | 2026-10-11 | Reescrito contra o agy 1.3.3. Saem as flags que nunca existiram (`--max-iterations`, `--tools`, `--resume`, `--checkpoint`), os caminhos `~/.antigravity/*` e a numeração 2.0. Documenta o argv real do driver (uma spawn, sempre `--continue`), exit 3 + `AGY_ERROR`, a mudança do modo plan na 1.3.2, hooks, regras, skills, plugins, subagents e notas de Windows |
