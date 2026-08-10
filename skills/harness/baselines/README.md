# Baselines

Snapshots of system KPIs produced by `skills/harness/scripts/baseline.ts`.

Each file `<YYYY-MM-DD>.json` is a point-in-time capture conforming to `schema.json` in this directory. Every fase posterior do plano de evolução reporta delta vs o baseline mais antigo (em geral o de Fase 0).

## Como gerar

```bash
# Janela default (30 dias), salva em <today>.json
nrv baseline --days=30 --save

# Janela menor, output ad-hoc
nrv baseline --days=7

# Dump JSON puro (para diff/automação)
nrv baseline --days=30 --json

# Override do root dos logs
nrv baseline --root=/path/to/.harness-logs --days=14
```

## Formato (resumido)

```json
{
  "meta": {
    "computed_at": "ISO-8601",
    "window_days": 30,
    "window_start": "ISO-8601",
    "window_end": "ISO-8601",
    "audit_logs_root": "/Users/.../.harness-logs",
    "schema_version": "1.0.0",
    "git_sha": "abc123…",
    "notes": "warnings sobre fragmentação de trace_id, gaps, etc."
  },
  "kpis": {
    "<kpi_name>": {
      "value": 0.935,
      "sample_size": 31,
      "confidence": "high",
      "raw": { /* counters específicos */ },
      "unmeasurable_reason": null
    }
  },
  "event_counts": { "cost_emission": 35109, "gate_passed": 55, /* ... */ },
  "trace_summary": {
    "distinct_traces": 447,
    "traces_with_dispatch": 31,
    "traces_with_gate_decision": 31,
    "orphan_event_lines": 725,
    "dispatched_with_cost": 0,
    "dispatched_without_cost": 31
  }
}
```

### Confidence levels

- `high` — `sample_size ≥ 30`
- `medium` — `10 ≤ sample_size < 30`
- `low` — `1 ≤ sample_size < 10`
- `unmeasurable` — `sample_size = 0` ou KPI depende de fase ainda não implementada

## KPIs medidos

| KPI | Como é computado | Depende de |
|---|---|---|
| `gate_pass_rate` | Traces com `gate_passed` E sem `gate_failed`/`validation_failed` ÷ traces com decisão de gate | eventos atuais |
| `first_pass_pass_rate` | Passa sem `revision` event no mesmo trace ÷ traces com decisão | eventos atuais |
| `mean_dispatch_cost_usd` | Mediana de `total_cost_usd` somado por trace, restrito a traces com dispatch | eventos atuais (frágil hoje — ver fragmentação abaixo) |
| `mean_dispatch_latency_seconds` | Mediana de `last_ts − first_ts` por trace com dispatch | eventos atuais |
| `brief_amplification_uplift` | Pass-rate de traces com `brief_amplified` − pass-rate sem | eventos atuais (frágil) |
| `observability_recall` | % de dispatches visíveis no trace viewer | **Fase 2** |
| `regression_smoke_pass_rate` | % de smoke tests passando | **Fase 1** |
| `revision_loop_efficacy` | % de `gate_failed` que convergem em ≤ 2 revisões | **Fase 3** |
| `memory_retrieval_precision_at_5` | Precision@5 vs golden set | **Fase 6** |
| `self_improver_proposals_accepted` | % de propostas do improver aprovadas | **Fase 8** |

## Achados conhecidos no baseline atual (`2026-05-12.json`)

1. **Fragmentação de `trace_id`.** Eventos `cost_emission` emitidos pelo hook do Claude Code carregam o `session_id` da sessão como `trace_id`. Já eventos `dispatch_business`/`dispatch_squad` emitidos pelo harness usam um `trace_id` próprio. Resultado: **0 dos 31 traces dispatched tinham cost_emission no mesmo trace** na janela de 30 dias. Isso torna `mean_dispatch_cost_usd` unmeasurable apesar dos dois sinais existirem isoladamente.
   - **Endereçar em:** Fase 2 (Observability) — trace builder deve correlacionar via session_id ↔ harness trace_id, possivelmente via `target_plan_committed` payload.
2. **725 linhas órfãs** (sem `trace_id`) em 30 dias. Maioria são eventos de hook pre-dispatch (`tool_invoked`, `bash_completed`). Não são erro — apenas eventos cujo escopo é tool-call, não dispatch.
3. **`brief_amplification_uplift` é unmeasurable** porque os 38 eventos `brief_amplified` ficam em traces separados dos eventos de gate decision. Mesma causa raiz da fragmentação de cost.
4. **31 dispatches em 30 dias** parece baixo dado os 4408 `tool_invoked`. Reflete o fato de que a maior parte do uso recente do Claude Code não passou pelo dispatcher do harness (foi código direto). Esperado mudar conforme `harness` virar caminho default.

## Como interpretar deltas

Toda fase posterior cria seu próprio baseline (`<today>.json`). A comparação deve ser feita campo-a-campo:

```bash
# Diff de KPIs
diff <(jq '.kpis' baselines/2026-05-12.json) <(jq '.kpis' baselines/2026-07-01.json)
```

Quando `confidence` cai (sample_size cai), o delta não é confiável mesmo que value pareça mover. Sempre cruze value + sample_size + confidence.

## Notas operacionais

- O script é **read-only** sobre `~/.harness-logs/`. Nenhuma mutação no audit.
- Linhas JSONL malformadas são contadas em `parseErrors` (não visível no snapshot, só em stderr) e puladas.
- O parser ignora eventos com `event` ausente.
- Sem dependência externa além do runtime (Bun + node:fs). Rodável offline.
