# Reference 02 — Budget enforcement

> Como o harness calcula e aplica caps de custo. Source of truth:
> `HARNESS_PROTOCOL_V1.md` §8.

## Princípio (HP3)

Caps são duros, não advisórios. Quando o estimado (pre-flight) ou o
acumulado (durante execução) excede a cap configurada, a invocação é
abortada por padrão. "Best effort" é proibido — previsibilidade vence
maximum effort.

## Os 4 caps por invocação

| Cap | Default | Override |
|---|---|---|
| `max_cost_usd` | 2.00 | `ctx.budget.max_cost_usd`, `--budget=USD`, `config.yaml`, `~/.claude/settings.json` |
| `max_tokens` | 200000 | `ctx.budget.max_tokens` |
| `max_handoffs` | 20 | `ctx.budget.max_handoffs` |
| `max_duration_seconds` | 600 | `ctx.budget.max_duration_seconds` |

## Pre-flight (Stage 4)

A função `budget.check(target, ctx)` em `lib/budget.js` retorna:

```javascript
{
  ok: boolean,                 // estimated_usd <= cap
  estimated_usd: number,
  max_cost_usd: number,
  max_handoffs: number,
  max_duration_seconds: number,
  on_exceeded: 'abort' | 'warn' | 'escalate',
  auto_invoke_budget_usd: number,
  breakdown: { ... },
  reason: string | null,
}
```

## Cálculo da estimativa

Em ordem de precedência:

1. **Explícito no registry**: se a capability/business declara
   `estimated_cost_usd` no manifest, usa-o.
2. **Baseline + handoff overhead**: caso contrário,
   ```
   estimate = baseline_by_type + (expected_handoffs * per_handoff_overhead)
   ```
   - `baseline_squad_capability_usd`: 0.30
   - `baseline_business_usd`: 0.80
   - `per_handoff_usd`: 0.05

## Configuração local (`config.yaml`)

```yaml
budget:
  default_max_cost_usd: 2.0
  default_max_tokens: 200000
  default_max_handoffs: 20
  default_max_duration_seconds: 600
  on_budget_exceeded: abort
  auto_invoke_budget_usd: 1.0

baselines:
  squad_capability_usd: 0.30
  business_usd: 0.80
  per_handoff_usd: 0.05
```

`config.yaml` é lido por `lib/budget.js` via Python (yaml safe_load) com
fallback a um parser inline para casos sem Python.

## Auto-invoke gate

Capability `validated` (status produção) com `estimated_cost_usd ≤
auto_invoke_budget_usd` (default 1.00) podem ser invocadas automaticamente
no signal HIGH. Acima desse limite, mesmo HIGH exige confirmação do humano
via `AskUserQuestion`.

## Per-business override

Um business pode declarar caps próprios em `business.yaml`:

```yaml
budgets:
  monthly_max_usd: 1000
  per_brief_max_usd: 5.00
```

Quando o harness invoca esse business, o cap efetivo é
`min(harness.default, business.per_brief_max_usd)`.

## On-exceeded actions

Configurável em `harness.budget.on_budget_exceeded`:

| Valor | Comportamento |
|---|---|
| `abort` (default) | Termina imediatamente, emite erro estruturado, audit `budget_violation` |
| `warn` | Continua, mas emite span de aviso e audit `budget_violation` |
| `escalate` | Pausa e dispara escalation trigger via Business Protocol §12 |

## Telemetria

Em cada decisão de budget, o harness emite atributos OTel/JSONL:

```
harness.budget.cap_usd
harness.budget.cumulative_usd
harness.budget.remaining_usd
harness.budget.cap_tokens
harness.budget.cumulative_tokens
harness.budget.action_taken    (quando triggered)
```

E um audit event:

```json
{"ts":"...","event":"budget_violation","cap_usd":2.0,"cumulative_usd":2.31,"action":"abort"}
```

## CLI exemplos

```bash
# override per-call
bun scripts/route.ts --budget=5.00 "rebuild brand from scratch"

# dry-run (não dispara plano)
bun scripts/route.ts --dry-run --json "manage marketing for client X"

# self-test verifica que budget.check funciona
bun scripts/validate.ts
```

## Boas práticas

- Mantenha `default_max_cost_usd` baixo (~$2). Briefs caros devem ser
  explícitos sobre o cap.
- Para businesses recorrentes, defina `monthly_max_usd` e revise mensalmente.
- Quando histórico de telemetria estiver disponível, substitua o baseline
  estático por uma média móvel das últimas N execuções (não implementado nesta
  v1.0 — ver BUILD-NOTES.md).

## Anti-patterns

- NÃO bypassar o cap "to be helpful". HP3: caps são duros.
- NÃO hardcodar pricing. Pricing tables ficam em adapter manifests.
- NÃO confundir cap (limite) com estimativa (predição). Cap é o piso de
  confiança; estimativa é input para decisão.
