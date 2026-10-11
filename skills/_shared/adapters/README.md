# Runtime Adapters

> Cada doc descreve como Squad v5 + Business v1 + Harness v1 mapeiam para um runtime concreto.
> Estrutura canônica em 15 seções (Squad v4 §18.5). Mínimo obrigatório: 1, 2, 3, 6, 11, 13.

## Adapters disponíveis

| Runtime | Vendor | Doc | Status |
|---|---|---|---|
| `claude-code` | Anthropic | [`claude-code.md`](./claude-code.md) | Reference (todos os 15 seções) |
| `codex` | OpenAI | [`codex.md`](./codex.md) | Estável. Argv do `codex exec` verificado contra o help do 0.159.2 e o código do 0.162.1 (2026-10-11); hooks com trust, skills em `~/.agents/skills`, agentes customizados em TOML. |
| `antigravity-cli` | Google | [`antigravity-cli.md`](./antigravity-cli.md) | Flags verificadas contra o `agy --help` 1.3.3 (2026-10-11): `-p … --output-format json [--continue] --dangerously-skip-permissions --add-dir`. Um spawn por turno: um erro de modelo no meio do turno sai com exit 3 e `AGY_ERROR`. |
| `hermes` | Hermes Agent | [`hermes.md`](./hermes.md) | Estável (15 seções; dispatch via `hermes -z`, teto = Codex) |
| `kimi-cli` | Moonshot AI | [`kimi-cli.md`](./kimi-cli.md) | Invocação (`kimi -p … --output-format stream-json -m <model> --add-dir <d>`) tirada da referência oficial do Kimi Code 2.x (2026-10-11); não rodada contra um binário local. Só mensagens do assistente formam o resultado. Grátis via OAuth Kimi.com; pago via `~/.kimi-code/config.toml`. |
| `grok-cli` | xAI | [`grok-cli.md`](./grok-cli.md) | Invocação (`grok --prompt-file <f> --output-format json --cwd <d> [-r <id>] --always-approve --trust`) conferida contra o `grok --help` 1.0.44 (2026-10-11). O trust de pasta controla AGENTS.md, skills e MCP do projeto; o resume é `-r`. Assinatura ou API xAI (`XAI_API_KEY`). |
| `pi` | Earendil (pi.dev) | [`pi.md`](./pi.md) | Invocação (`pi -p --mode json --session-id <uuid> --append-system-prompt … -- <prompt>`) conferida contra o `pi --help` 0.84.3; mudanças do 1.x pelo changelog oficial (2026-10-11). O erro de provider chega no stream (o pi sai com exit 0 mesmo em erro, §13). UM runtime para muitos providers, **incluindo modelos LOCAIS** (Ollama, llama.cpp, LM Studio, vLLM). O `@provider` do cascade vira `--provider`, passado só junto com `--model` (o pi 1.0.0 recusa sozinho). |
| `orca` (host) | Orca (orca.dev) | [`orca.md`](./orca.md) | **Host, não runtime.** Dentro de um terminal do Orca o engine carimba o audit com o workspace, projeta cada run no card (comentário e coluna), abre o Glance no browser embutido e roda cada despacho headless como terminal de worker (orquestração do Orca), com fallback para o processo filho. Fora do Orca nada muda; um `orca` falso nos testes prova que nada é chamado. Medido no Orca 1.4.198 (2026-09-09). ADR-009. |

## Comparativo rápido (matriz cruzada)

| Feature | claude-code | codex | antigravity-cli | hermes | Notas |
|---|---|---|---|---|---|
| `max_turns` per-employee | ✓ (`--max-turns`, `maxTurns` do subagent) | ✗ (sem teto de turnos no `codex exec`) | ✗ (sem flag de turnos) | ~ (profile global) | O engine não passa teto de turnos a nenhum runtime hoje. |
| `tool_whitelist` | ✓ | ✓ | ✓ | ✓ (`-t/--toolsets`) | Todos suportam. |
| `subagent_spawning` (in-process) | ✓ Agent tool (native, in-process) | ✓ native `[agents]` | ✓ native dynamic | ~ sub-process (`hermes -z`, mono-nível) | claude/codex/antigravity in-process nativo; hermes via sub-process. |
| `audit_trail` | ✓ | ✓ | ✓ | ~ (hooks + fs-watch) | Hermes via shell hooks. |
| `scheduled_invocation` | ✓ ScheduleWakeup | ✗ | ✗ | ✓ `hermes cron` | Hermes tem cron nativo (vantagem sobre codex/antigravity). |
| `event_bus` | ~ | ~ | ~ | ~ | Nenhum tem broker; file-system mais memory. |
| `hooks` | ✓ | ✓ (trust por hash) | ✓ (`hooks.json`, cinco eventos) | ~ (`pre/post_tool_call`) | Os hooks do Codex precisam de trust; o `PreInvocation` do agy roda antes de cada chamada ao modelo; Hermes é shell-based e consent-gated. |
| `sandboxing` | ~ permissions | ✓ profiles | ~ approval modes | ✓ 6 backends + Tirith | Codex/Hermes mais ricos. |
| `session_memory` | ✓ | ✓ | ✓ | ✓ | Todos. |
| `project_memory` | ✓ CLAUDE.md | ✓ AGENTS.md | ✓ AGENTS.md | ✓ AGENTS.md | Convenção semelhante. |
| `global_memory` rico | ✓ | ~ | ~ | ✓ SOUL+SQLite+Honcho | Claude Code e Hermes têm memória global rica. |
| `handoff_artifacts` | ✓ | ✓ | ✓ | ✓ (texto→JSON) | JSON em tool_result ou file. |
| `teammate_primitive` | ~ TeamCreate (deferred) | ✗ | ~ Managed Agents | ~ delegation (mono-nível) | Antigravity tem Managed Agents para long runs; Hermes delegation nativo de 1 nível. |
| `telemetry_otel` | ✓ | ~ | ~ | ~ | Os outros via SDK externo. |
| `messaging_escalation` | ~ | ~ | ~ | ✓ Slack/Telegram/WhatsApp | Hermes ganha em escalação humana. |
| Janela contexto | 200K | 128K a 200K | 1M (2M no roadmap) | depende do provider | Hermes roteia para o provider do profile. |

> Linhas extras fora da feature matrix canônica de Business v1 §6 (não fazem parte do enum `features_required` mas viram o critério de escolha de runtime):
>
> - **MCP servers**: claude-code ✓ (estável), codex ~ (parcial), antigravity-cli ✓ (nativo), hermes ✓ (nativo).
> - **Janela de contexto**: ver linha acima.

## Quando usar qual

- **`claude-code`**: produção principal — todos os primitives e hooks suportados nativamente. Recomendado para businesses long-running com escalation, mind-clones, e auditoria rica.
- **`codex`**: quando sandboxing forte é prioridade (workspace-write/read-only/danger-full-access) e o uso é dominado por code-related capabilities. Trade-off: sem teto de turnos por execução, sem ScheduleWakeup.
- **`antigravity-cli`**: o CLI de agente do Google (modelos Gemini), e o caminho até eles agora que o Gemini CLI deixou de ser um runtime. Janela grande, subagents de projeto (`.agents/agents/`, `--agent`) e plugins. As flags do driver são conferidas contra o `agy --help` 1.3.3. Não é preferencial por padrão.
- **`gemini-cli`**: deixou de ser um runtime. Uma configuração, regra ou entrada de cascade que ainda o nomeie é ignorada com "Gemini CLI is no longer supported; pick another runtime". Use `antigravity-cli` para os modelos Gemini.
- **`hermes`**: quando o usuário já roda o Hermes Agent e quer empresas/squads/mind-clones lá — consulta (`nrv list/inspect/search/ask`) sem degradação, dispatch determinístico (`nrv dispatch`) e orquestração in-runtime via `hermes -z` (teto = Codex). Vantagens: `hermes cron` (scheduled) e escalação via Slack/Telegram. Trade-off: dispatch é texto→JSON (sem `--output-format json`), hooks shell consent-gated.
- **`pi`**: quando quiser UM runtime com acesso a 15+ providers (API keys ou OAuth das assinaturas Claude/ChatGPT/Copilot) e a **modelos locais** (Ollama, llama.cpp, LM Studio, vLLM) — briefs privacy-sensitive rodando 100% offline, fallback de custo $0/token em hardware próprio, ou um provider que nenhum CLI oficial cobre. Resume (`--session`) e fork de sessão nativos; skills no padrão Agent Skills (lê `~/.pi/agent/skills` — o `nrv install` symlinka a árvore do Nirvana lá). O MCP é nativo desde o 0.99. Trade-off: sem subagents built-in, sem hooks de shell (extensões TypeScript cobrem), e o exit code não sinaliza erro de provider (o driver detecta pelo stream).

### Roteamento automático por regras USE_*

Em vez de decidir na mão a cada dispatch, o usuário declara as regras em linguagem natural no `.env` do projeto (ou em `~/.claude/.env`):

```dotenv
USE_CODEX="Quando precisar gerar imagens ou refinar visuais"
USE_ANTIGRAVITY="Quando for fazer deep research na internet"
NOT_USE_ANTIGRAVITY="Quando for análise de codebase"   # veto: vence a regra positiva
USE_HERMES="Quando precisar interagir com o usuário via mensageria"
USE_PI="Quando precisar de modelos locais (Ollama/llama.cpp) ou de um provider fora dos CLIs oficiais"
```

O `nrv dispatch --exec` escolhe o runtime preferido pela regra que casar com o brief (BM25 zero-token no modo `fast`; no modo `agentic` as regras entram verbatim no prompt do roteador e do maestro, que também as respeita ao delegar sub-tarefas). Flag explícita (`--exec=<rt>`/`--runtime`) sempre vence; sem match, segue no runtime que o usuário já está usando. A resiliência de cota continua no `LLM_CASCADE`. Detalhes: `project-skeleton/.env.example`.

## Para implementadores de adapter

Cada doc segue 15 seções canônicas (Squad v4 §18.5):

1. Adapter Metadata
2. Feature Support Matrix
3. Concept Mapping
4. Frontmatter Mapping
5. Tool Whitelist Mechanics
6. Max-Turns Mechanics
7. Subagent Spawning
8. Memory Storage
9. Context Window & Compaction
10. Hook System
11. Invocation Examples
12. Runtime-Specific Validators
13. Known Limitations
14. Source References
15. Version History

Mínimo obrigatório para um adapter ser considerado v1: §§1, 2, 3, 6, 11, 13.
