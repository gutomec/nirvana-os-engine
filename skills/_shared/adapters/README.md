# Runtime Adapters

> Cada doc descreve como Squad v5 + Business v1 + Harness v1 mapeiam para um runtime concreto.
> Estrutura canônica em 15 seções (Squad v4 §18.5). Mínimo obrigatório: 1, 2, 3, 6, 11, 13.

## Adapters disponíveis

| Runtime | Vendor | Doc | Status |
|---|---|---|---|
| `claude-code` | Anthropic | [`claude-code.md`](./claude-code.md) | Reference (todos os 15 seções) |
| `codex` | OpenAI | [`codex.md`](./codex.md) | Estável (15 seções, gaps em hooks/scheduled) |
| `antigravity-cli` | Google | [`antigravity-cli.md`](./antigravity-cli.md) | Estável (15 seções; sucessor do gemini-cli, subagents dinâmicos nativos) |
| `gemini-cli` | Google | [`gemini-cli.md`](./gemini-cli.md) | Legado — sunset 2026-06-18 (15 seções, gaps em hooks/event_bus/teammate) |
| `hermes` | Hermes Agent | [`hermes.md`](./hermes.md) | Estável (15 seções; dispatch via `hermes -z`, teto = Codex) |

## Comparativo rápido (matriz cruzada)

| Feature | claude-code | codex | antigravity-cli | gemini-cli | hermes | Notas |
|---|---|---|---|---|---|---|
| `max_turns` per-employee | ~ (via hook, sem hard limit) | ~ (CLI flag global) | ~ (CLI flag global) | ~ (CLI flag global) | ~ (profile global) | Nenhum runtime tem max_turns hard nativo. Em todos é workaround; nested invocations escapam fora do Claude Code. |
| `tool_whitelist` | ✓ | ✓ | ✓ | ✓ | ✓ (`-t/--toolsets`) | Todos suportam. |
| `subagent_spawning` (in-process) | ✓ Agent tool (native, in-process) | ✓ native `[agents]` | ✓ native dynamic | ~ sub-process (legado) | ~ sub-process (`hermes -z`, mono-nível) | claude/codex/antigravity in-process nativo; gemini (legado) e hermes via sub-process. |
| `audit_trail` | ✓ | ✓ | ✓ | ~ | ~ (hooks + fs-watch) | Gemini/Hermes via shell hooks. |
| `scheduled_invocation` | ✓ ScheduleWakeup | ✗ | ✗ | ✗ | ✓ `hermes cron` | Hermes tem cron nativo (vantagem sobre codex/gemini/antigravity). |
| `event_bus` | ~ | ~ | ~ | ~ | ~ | Nenhum tem broker; file-system mais memory. |
| `hooks` | ✓ | ~ | ~ | ✗ | ~ (`pre/post_tool_call`) | Claude Code granular; Hermes shell-based consent-gated. |
| `sandboxing` | ~ permissions | ✓ profiles | ~ approval modes | ~ container | ✓ 6 backends + Tirith | Codex/Hermes mais ricos. |
| `session_memory` | ✓ | ✓ | ✓ | ✓ | ✓ | Todos. |
| `project_memory` | ✓ CLAUDE.md | ✓ AGENTS.md | ✓ AGENTS.md | ✓ GEMINI.md | ✓ AGENTS.md | Convenção semelhante. |
| `global_memory` rico | ✓ | ~ | ~ | ~ | ✓ SOUL+SQLite+Honcho | Claude Code e Hermes têm memória global rica. |
| `handoff_artifacts` | ✓ | ✓ | ✓ | ✓ | ✓ (texto→JSON) | JSON em tool_result ou file. |
| `teammate_primitive` | ~ TeamCreate (deferred) | ✗ | ~ Managed Agents | ✗ | ~ delegation (mono-nível) | Antigravity tem Managed Agents para long runs; Hermes delegation nativo de 1 nível. |
| `telemetry_otel` | ✓ | ~ | ~ | ~ | ~ | Os outros via SDK externo. |
| `messaging_escalation` | ~ | ~ | ~ | ~ | ✓ Slack/Telegram/WhatsApp | Hermes ganha em escalação humana. |
| Janela contexto | 200K | 128K a 200K | 1M (2M no roadmap) | 1M (2M no roadmap) | depende do provider | Hermes roteia para o provider do profile. |

> Linhas extras fora da feature matrix canônica de Business v1 §6 (não fazem parte do enum `features_required` mas viram o critério de escolha de runtime):
>
> - **MCP servers**: claude-code ✓ (estável), codex ~ (parcial), antigravity-cli ✓ (nativo), gemini-cli ✓ (experimental, legado), hermes ✓ (nativo).
> - **Janela de contexto**: ver linha acima.

## Quando usar qual

- **`claude-code`**: produção principal — todos os primitives e hooks suportados nativamente. Recomendado para businesses long-running com escalation, mind-clones, e auditoria rica.
- **`codex`**: quando sandboxing forte é prioridade (workspace-write/read-only/danger-full-access) e o uso é dominado por code-related capabilities. Trade-off: sem hooks granulares, sem ScheduleWakeup.
- **`antigravity-cli`**: sucessor do gemini-cli (a partir de 2026-06-18) para o tier consumer Google. Mesma janela grande (1M+), mais subagents dinâmicos nativos in-process e Managed Agents para long runs. Preferir sobre gemini-cli em instalações novas.
- **`gemini-cli`**: **legado — sunset 2026-06-18.** Quando o brief consome >100K tokens de context (análise de código grande, document review extenso) e a instalação ainda não migrou. Trade-off: agent system experimental, hooks ausentes, audit limitado. Migrar para `antigravity-cli`.
- **`hermes`**: quando o usuário já roda o Hermes Agent e quer empresas/squads/mind-clones lá — consulta (`nrv list/inspect/search/ask`) sem degradação, dispatch determinístico (`nrv dispatch`) e orquestração in-runtime via `hermes -z` (teto = Codex). Vantagens: `hermes cron` (scheduled) e escalação via Slack/Telegram. Trade-off: dispatch é texto→JSON (sem `--output-format json`), hooks shell consent-gated.

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
