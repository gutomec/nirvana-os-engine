# Sessões do maestro

Nota de design do turno do maestro (`skills/harness/lib/control-plane/maestro-turn.ts`): o que é um projeto, o que é uma sessão, o que o engine guarda e o que fica com o runtime. Vale o que está no código; o que ainda não existe está marcado como limite.

## Projeto = diretório de trabalho

Toda conversa canônica pertence a um projeto adotado, e todo turno roda com `cwd` na raiz desse projeto, o padrão do Claude Desktop: a pessoa escolhe a pasta, o agente trabalha dentro dela. O filho lê o `CLAUDE.md`/`AGENTS.md` do projeto e tem o skill `harness`, então se comporta como o maestro de uma sessão de terminal aberta ali. O engine não injeta contexto além da diretiva curta e, quando há registros, uma linha com os slugs instalados.

## Sessão = a sessão nativa do runtime, guardada por diretório

O engine não copia a transcrição do agente para o SQLite. Cada runtime guarda as próprias sessões por diretório de trabalho: Claude em `~/.claude/projects/<cwd>/`, Pi em `~/.pi/agent/sessions/<cwd>/`, Gemini em `~/.gemini/tmp/<hash(cwd)>/chats/`, Codex em `~/.codex/sessions/` com o cwd nos metadados. O que o projeto guarda por conversa é só o índice, em colunas da tabela `conversations` (`control-plane.sqlite`; migração idempotente por `PRAGMA table_info` seguido de `ALTER TABLE`):

| Coluna | Conteúdo |
|---|---|
| `session_runtime` | runtime da sessão atual (`claude-code`, `codex`, …) |
| `session_id` | id da sessão atual nesse runtime |
| `session_started_at` | quando a sessão atual começou |
| `last_turn_at` | quando o último turno terminou |
| `session_history` | JSON com as sessões anteriores da conversa (`session_id`, `session_runtime`, `started_at`, `ended_at`, `reason`) |

As mensagens visíveis (`user` e `assistant`) continuam em `conversation_messages`: são a transcrição da UI, não o contexto do agente.

## Como cada runtime cria e retoma a sessão

O engine escolhe o id no primeiro turno quando o runtime deixa, para que a conversa mapeie numa sessão previsível.

| Runtime | Primeiro turno | Turnos seguintes | Streaming |
|---|---|---|---|
| Claude Code | `claude -p --session-id <uuid>`, uuid gerado pelo engine | `claude -p --resume <uuid>` | sim: `--output-format stream-json --verbose --include-partial-messages` (tokens, ferramentas, `result` com custo) |
| Codex | `codex exec --json` pelo driver; o id é do runtime (`thread_id` no fluxo `--json`, lido pelo adapter) | `codex exec resume <id>` pelo driver | limite: entrega ao fim |
| Gemini CLI | pelo driver (`--approval-mode yolo`) | `gemini -r <id>` pelo driver | limite: entrega ao fim; limite: o driver ainda não passa `--session-id` no primeiro turno, então o id só é previsível quando o runtime o devolve no JSON |
| Pi | pelo driver | pelo driver | limite: entrega ao fim; limite: o `--session-id` idempotente do Pi ainda não é usado pelo driver |
| Kimi, agy, grok, qwen, opencode | pelo driver | pelo driver, quando o adapter captura o id | limite: entrega ao fim |

Só o claude-code é iniciado diretamente pelo módulo. Os demais passam por `runHeadless` (`skills/_shared/lib/host-agent-driver.ts`) num processo filho do módulo (`maestro-turn.ts --child`), porque o driver é síncrono e não pode travar o event loop do servidor. Uma conversa tem um runtime: se `execution.default_runtime` (ou o host) mudar, o turno seguinte abre sessão nova e a antiga vai para `session_history` com `reason: runtime_changed`.

## Quando o runtime apagou a sessão

Runtimes podam sessões (Claude `cleanupPeriodDays`, 30 dias por padrão; Gemini `maxAge`, 30 dias). Se um `--resume` termina sem resultado, o turno não falha: abre uma sessão NOVA para a mesma conversa e antepõe ao prompt uma recapitulação curta, rotulada, das últimas seis mensagens visíveis de `conversation_messages` (`continuityRecap`), grava `x_session_recreated` no audit do projeto (`previous_session_id`, `new_session_id`, `reason: resume_failed`) e atualiza o índice (a antiga vai para `session_history` com `reason: session_vanished`). Uma tentativa por turno.

## Continuar no terminal

Como a sessão é nativa e fica por diretório, a mesma conversa continua no terminal: `cd <raiz do projeto> && claude --resume <session_id>` (Codex `codex resume <id>`, Gemini `gemini -r <id>`, Pi `pi --session <id>`). O cabeçalho da conversa mostra o id curto e copia o comando (`resume_command`, também em `GET /api/v1/conversations/{id}` e no evento `done` do turno).

## Autonomia por turno

Sessões `-p` não restauram o modo de permissão, então as flags de autonomia vão em TODO turno: `claude --dangerously-skip-permissions` e, pelos adapters do driver, `codex --dangerously-bypass-approvals-and-sandbox`, `gemini --approval-mode yolo`, `agy --dangerously-skip-permissions`, `grok --always-approve`. `execution.headless_skip_permissions=false` troca todas pelo caminho restrito de cada runtime (no claude, `--permission-mode acceptEdits` com a allowlist de ferramentas do driver). No Windows o `claude.cmd` roda pelo interpretador de comandos, que corta a linha na primeira quebra de linha de um argumento; a diretiva vai então como `--append-system-prompt-file <arquivo temporário>`, para que as flags depois dela sobrevivam. O teto por turno é `glance.maestro_max_budget_usd` (padrão 5; só o claude aplica no próprio CLI, os outros recebem o aviso do driver).

## SIGTERM = cancelado

Cancelar um turno (`POST /api/v1/conversations/{cnv}/turns/{trn}:cancel`) manda `SIGTERM` ao grupo de processos do turno; um `claude -p` sai com 143 e deixa a sessão retomável. O turno termina `cancelled` (`reason: cancelled_by_user`), nunca `failed`, e nada é gravado como resposta; um 143 vindo de fora termina do mesmo modo (`reason: interrupted`). Um turno que estoura `MAESTRO_TURN_TIMEOUT_MS` (45 min) é morto assim e termina `failed` com `reason: timeout`.

## Responder ou trabalhar é decisão do maestro

Não há roteador no caminho da requisição. A diretiva (`MAESTRO_DIRECTIVE`) diz ao maestro para responder perguntas com os comandos de leitura e, num pedido de trabalho, seguir o protocolo do harness, dizer antes qual empresa, squad, clone, runtime e modo usaria, e abrir Runs pelos scripts normais. Um Run que o maestro abre aparece no turno como evento `run` (lido de `x_ledger_run_opened` no audit do projeto) e na aba Runs como qualquer outro.

## Limites

- Streaming só no claude-code; os outros runtimes entregam ao fim (`done`), sem tokens nem eventos de ferramenta.
- O id previsível no primeiro turno existe só no claude-code; para gemini e pi depende dos adapters do driver.
- O turno não sobrevive ao servidor: `shutdown` sinaliza os turnos ativos; não há recuperação como a dos Runs.
- A recapitulação usa as mensagens visíveis, não a transcrição do agente.

## Fontes

- Claude Code, sessões: https://code.claude.com/docs/en/sessions
- Claude Code, desktop: https://code.claude.com/docs/en/desktop
- Claude Code, headless: https://code.claude.com/docs/en/headless
- Codex, modo não interativo: https://learn.chatgpt.com/docs/non-interactive-mode
- Gemini CLI, gestão de sessões: https://geminicli.com/docs/cli/session-management/
- Pi, formato de sessão: https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/session-format.md
- Kimi CLI, sessões: https://moonshotai.github.io/kimi-cli/en/guides/sessions.html
