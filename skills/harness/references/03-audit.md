# Reference 03 — Audit trail

> Como o harness registra o que aconteceu, onde fica, e como consultar.
> Source of truth: `HARNESS_PROTOCOL_V1.md` §10. Schema: `_shared/schemas/core-schemas.json#/definitions/audit_event`.

## Onde fica

| Escopo | Path | Retenção default |
|---|---|---|
| Por sessão (cross-project) | `~/.harness-logs/<YYYY-MM-DD>/audit.jsonl` | 90 dias |
| Por projeto | `${PROJECTS_OUTPUT_DIR}/<project>/audit.jsonl` | 365 dias |

A skill em si grava só no log de sessão. Logs por projeto são gravados
pelos businesses/squads invocados (responsabilidade deles via `audit.emit`
re-export).

## Formato JSONL

Append-only, uma linha por evento. Encoding UTF-8.

```jsonl
{"ts":"2026-05-02T17:30:11.241Z","event":"brief_received","brief_length":58,"mode":"find"}
{"ts":"2026-05-02T17:30:11.342Z","event":"routing_decision","signal":"HIGH","target_id":"squad_capability:audio-suite:audio_video.transcribe","score":0.93}
{"ts":"2026-05-02T17:30:11.355Z","event":"invocation_start","target_id":"audio_video.transcribe","trace_id":"01HZ..."}
{"ts":"2026-05-02T17:30:14.901Z","event":"cost_emission","agent":"transcriber","model":"sonnet","tokens_input":1200,"tokens_output":340,"cost_usd":0.0228}
{"ts":"2026-05-02T17:30:14.902Z","event":"invocation_end","result":"completed","total_cost_usd":0.0228}
```

## Eventos suportados (closed enum)

```
brief_received
routing_decision
invocation_start
invocation_end
cost_emission
handoff
ticket_opened
ticket_resolved
escalation_trigger_fired
human_notification_required
human_response_received
resume
approval_checkpoint
approval_granted
approval_rejected
budget_violation
memory_write
isolation_violation
validation_failed
humanization_applied
humanization_skipped
```

`audit.emit` rejeita eventos fora desse conjunto (HP2: failure-loud).

## Campos canônicos

Todos os eventos têm `ts` e `event`. Demais campos canônicos
(top-level, opcionais):

- `trace_id`
- `project_id`
- `business_slug`
- `squad_name`
- `agent_or_employee`

Campos extras são permitidos (`additionalProperties: true` no schema). Use
nomes consistentes com a spec OTel sempre que possível (`tokens_input`,
`tokens_output`, `cost_usd`, etc.).

## API JavaScript

```javascript
const audit = require('~/.claude/skills/harness/lib/audit');

// Emite um evento.
audit.emit('routing_decision', {
  signal: 'HIGH',
  target_id: 'squad_capability:audio-suite:audio_video.transcribe',
  score: 0.93,
}, {
  trace_id: '01HZ...',
  project_id: 'cliente-x',
});

// Lê os últimos N eventos do dia.
const recent = audit.readRecent(50);

// Rotaciona logs antigos (default 90 dias).
audit.rotate(90);
```

## Consultas comuns

### Quantas decisões hoje?

```bash
TODAY=$(date -u +%Y-%m-%d)
wc -l < ~/.harness-logs/$TODAY/audit.jsonl
```

### Distribuição de signals

```bash
TODAY=$(date -u +%Y-%m-%d)
python3 - <<PY
import json
counts = {}
for line in open(f"$HOME/.harness-logs/{'$TODAY'}/audit.jsonl"):
    e = json.loads(line)
    if e["event"] == "routing_decision":
        counts[e["signal"]] = counts.get(e["signal"], 0) + 1
print(counts)
PY
```

### NO_MATCH dos últimos 7 dias (input para planejar capabilities novas)

```bash
for i in 0 1 2 3 4 5 6; do
  d=$(date -u -v-${i}d +%Y-%m-%d 2>/dev/null || date -u -d "$i days ago" +%Y-%m-%d)
  f="$HOME/.harness-logs/$d/audit.jsonl"
  [ -f "$f" ] && grep '"signal":"NO_MATCH"' "$f"
done
```

## Validação

Para validar que um audit event respeita o schema, use o validator
compartilhado:

```bash
python3 ~/.claude/skills/_shared/validators/validators.py \
  --validate audit_event \
  --input <(echo '{"ts":"2026-05-02T00:00:00Z","event":"brief_received","brief_length":42}')
```

## Retenção e rotação

Default: 90 dias para logs de sessão (`~/.harness-logs`). Configurável em
`config.yaml`:

```yaml
audit:
  retention_days: 90
```

A função `audit.rotate(days)` deleta diretórios `<YYYY-MM-DD>/` mais
antigos que o cutoff. Pode ser chamada periodicamente em um cron / Claude
Code hook.

## Privacidade

- O `brief` em si NÃO é registrado por padrão (apenas `brief_length` e um
  hash quando necessário). Adapters podem optar por incluir o brief
  completo via `brief_text` field, mas isso aumenta a superfície de
  vazamento.
- Custom fields que contenham PII devem ser hasheados antes do `emit`.
- O isolation guard garante que audit logs de outros projetos não vazam
  para a sessão corrente.

## Anti-patterns

- NÃO escrever audit no projeto sem permissão (cross-project leak).
- NÃO fazer `JSON.stringify` de objetos enormes diretamente — quebra a
  legibilidade do JSONL. Resuma e use referências (trace_id, hash).
- NÃO suprimir falhas no audit. Se `emit` lançar, o caller deve falhar
  alto — perder registros é pior do que falhar uma invocação.
