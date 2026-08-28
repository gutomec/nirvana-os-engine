# Engine contract — Glance one-pager ⇄ nirvana-os-engine

> Fonte da verdade: código-fonte oficial `gutomec/nirvana-os-engine` (v0.10.1 no
> momento do alinhamento), arquivos `skills/harness/lib/glance/server.ts`,
> `skills/harness/lib/glance/data-loader.ts` e `skills/harness/GLANCE.md`.
> Nada aqui foi inventado: cada shape citado foi lido do código upstream.

## Dois modos de operação

| Modo | Quando | De onde vêm os dados |
|---|---|---|
| `simulated` (padrão) | sem `NIRVANA_ENGINE_URL` | Run Kernel simulado local (Prisma/SQLite + gerador de eventos, `src/lib/event-engine.ts`) |
| `engine` | `NIRVANA_ENGINE_URL=http://127.0.0.1:<porta>` apontando para `nrv glance` | upstream real, normalizado por `src/lib/engine-client.ts`; campo indisponível ⇒ `null` ⇒ UI mostra `—` |

A TopBar exibe o chip **"Live engine" / "Engine ao vivo"** apenas no modo
`engine` (campo `health.source`). Se o upstream cair, cada rota cai no modo
simulado sem erro 500 (degradação honesta).

## Como rodar contra o engine real

```bash
# terminal 1 — engine oficial (qualquer porta livre)
bun ~/.nirvana/skills/harness/scripts/glance.ts --port 4242

# terminal 2 — este cockpit
NIRVANA_ENGINE_URL=http://127.0.0.1:4242 bun run dev
```

Escrita (`POST /api/v1/…`) continua sujeita à regra do engine: sem
`--allow-actions` no upstream, respostas 405 são traduzidas para turno
`NO_MATCH` com detalhe `upstream read-only` (nada é simulado como sucesso).

## Mapa de rotas

| Rota do cockpit | Endpoint upstream (engine ≥ 0.10) | Normalização |
|---|---|---|
| `GET /api/health` | `GET /api/health` | `{ok, version, uptime_ms, idle_ms, idle_timeout_ms, allow_actions, scope:{mode…}}` ⇒ `HealthDTO` (`scope.mode: merge→global`) |
| `GET /api/squads` | `GET /api/squads` | `{squads:[{slug, source, dir, version, protocol, capabilities, domains, manifest_path, manifest_hash}]}` ⇒ `EntityDTO(kind=SQUAD)`; `runsToday/successRate/lastSeenAt = null` |
| `GET /api/squads/:slug` | `GET /api/squads/:slug` (detalhe) ou lista de businesses | `getSquadDetail` ⇒ `EntityDetailDTO` + eventos do `audit.jsonl` que citam o slug |
| `GET /api/businesses` | `GET /api/businesses` | `{businesses:[{slug, source, version, domains, employee_count, business_type, manifest_path}]}` ⇒ `BusinessDTO`/`EntityDTO(kind=BUSINESS)` |
| `GET /api/logs?limit=N` | `GET /api/logs?type=harness&date=<hoje>&limit=N` | `{events:[raw jsonl], total_in_day, source, date, type}` ⇒ `WireEvent` (classificação `RUN/GATE/SYSTEM/ENTITY` por regex do nome do evento; id determinístico = `ts_ms*10+ocorrência`) |
| `GET /api/events` (SSE) | poll de 4s sobre `GET /api/logs` (mesma cadência do `/api/logs/stream` oficial de 3s) | reemite `timeline` com ids monotonicamente dedupados + `pulse` (10s) via `/api/health`+`/api/squads`+`/api/businesses`+`/api/logs` |
| `GET /api/pulse` | composição dos 4 endpoints acima | stats reais (`agents`, `eventsToday`); métricas que o engine não expõe (`successRate`, `avgResponseMs`, `uptimePct`) ⇒ `null` |
| `POST /api/v1` (turno) | `GET /api/v1/projects` → `GET|POST /api/v1/projects/:id/conversations` → `POST /api/v1/conversations/:cnv/messages` com `Idempotency-Key` e `{project_id, role:"user", content, mode:"turn"}` | resposta `{message, turn, session, queued, events_url}` ⇒ `TurnDTO` (estado mapeado por `TURN_STATE_MAP`, ex. `withheld→ROLLED_BACK`, `unavailable→NO_MATCH`) |
| `GET /api/v1?turnId=` | `GET /api/v1/conversations/:cnv` (`active_turn`) | `turnPayload` ⇒ `TurnDTO` (id numérico = hash estável do `turn_id`) |
| `POST /api/events/:seq/cancel` | `POST /api/v1/conversations/:cnv/turns/:trn/:cancel` com `{project_id}` | `202 {accepted}` ⇒ ok; `405` ⇒ `403 ACTIONS_GATED`; `409` ⇒ estado |

### Detalhe do id determinístico (SSE resume)

`Last-Event-ID` do cockpit é numérico e derivado do timestamp: `id = ts_ms*10 +
(ocorrência dentro do mesmo ms)`. Reconexões repetem o mesmo cálculo sobre o
mesmo arquivo — logo o replay é estável e sem duplicação (o mesmo princípio do
engine: "Event pagination and SSE use the Project sequence, not timestamps").

## O que NÃO é do engine (e está marcado como tal)

- Tier 3 simulado (ROUTER/SUPERVISOR/…) — no modo `engine` as 8 células passam
  a derivar de valores reais (counts de registry, scope, allow-actions, uptime).
- Métricas hero `successRate/avgResponseMs/uptimePct` — o engine 0.10.1 não
  expõe agregados; exibimos `—` em vez de inventar números.
- `budgetPct` do turno — noção do cockpit simulado; no modo engine fica `0`.

## Convenções de i18n respeitadas

`CONTRIBUTING.md` do engine: "Code, comments, identifiers, commit messages:
English. User-facing runtime strings: localized (PT-BR is the default locale)."
Aqui: código/identificadores em inglês, UI localizada `en`/`pt-BR`
(`src/lib/i18n/`), rótulos de dados do engine (ex.: "Ledger: retido") ficam
como o engine os emite.

## Maestro v2 · Agentic Forms (kernel simulado)

O chat da Ask bar evoluiu para conversa com **formulários gerados em tempo real**
pelo maestro — o operador clica/seleciona em vez de digitar (paradigma validado
pelo autor em sistema paralelo). Protocolo próprio, **sem dependência do a2ui
do engine upstream** (que está instável lá); se um dia o upstream expor a2ui
estável, o renderizador de cards pode ser estendido.

- **Contrato**: `MaestroReply { text, form?, actions? }` em `src/lib/types.ts`.
  Formulários: `choice` (chips/lista), `multi`, `confirm`, `text`. O `form.id`
  é um **token de continuação** (TTL 15min, um uso) guardado em
  `src/lib/maestro-flows.ts` (memória global, igual ao engine).
- **Turnos**: `Turn.meta` (JSON) guarda `{ locale, intent, formToken, answers,
  reply }`; a resposta rica é construída no `finalize` com dados **ao vivo**
  (entities/events/subsystems/settings) e devolvida por `POST/GET /api/v1`
  como `reply`. Turnos de fluxo são determinísticos (sem rolled_back aleatório);
  orçamento continua consumido por turno (budget_exhausted honesto).
- **Ações de UI**: `open_entity` / `open_timeline` / `open_projects` — o maestro
  comanda o Glance (drawer, scroll) depois de responder.
- **Fluxos guiados**: `status` (snapshot + drill-down de agente), `diagnose`
  (alvo → diagnóstico 60min com números reais → corretiva), `route` (squad →
  campo de tarefa gerado → despacho), `gate` (pendências do dia → reprocessar).
  Texto livre casa palavras-chave PT/EN e inicia fluxos; chips de entrada
  ficam no topo do thread.
- **Escrita gated**: todo despacho/corretiva/gate respeita `--allow-actions`;
  sem gate, a resposta é honesta ("nada foi despachado").
- **Modo engine (upstream real)**: conversa permanece **textual** (`reply: null`)
  — os fluxos/formulários são do kernel simulado; delimitação deliberada.
