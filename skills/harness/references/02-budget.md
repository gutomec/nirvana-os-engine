# Reference 02 — Budget enforcement

> How the harness computes and applies cost caps. Source of truth:
> `lib/budget.js` (this file documents its current defaults; the
> `HARNESS_PROTOCOL_V1.md` §8 figures are historical).

## Principle (HP3, amended by Rule 4)

**A cap of `0` (the default) means UNLIMITED** — no pre-flight, Nirvana stays
out of the way. When a cap is set to a positive value it is **hard, not
advisory**: the estimated (pre-flight) or accumulated (during execution) cost
crossing the cap stops the run per the configured action. "Best effort past
the cap" is forbidden — predictability beats maximum effort.

## The four caps per invocation

| Cap | Default | Override |
|---|---|---|
| `max_cost_usd` | 0 (unlimited) | `ctx.budget.max_cost_usd`, `--max-budget=<usd>`, `config.yaml` |
| `max_tokens` | 0 (unlimited) | `ctx.budget.max_tokens` |
| `max_handoffs` | 0 (unlimited) | `ctx.budget.max_handoffs` |
| `max_duration_seconds` | 0 (unlimited) | `ctx.budget.max_duration_seconds` |

## Pre-flight (Stage 4)

`budget.check(target, ctx)` in `lib/budget.js` returns:

```javascript
{
  ok: boolean,                 // unlimited, or estimated_usd <= cap
  unlimited: boolean,          // true when the effective cap is <= 0
  estimated_usd: number,
  max_cost_usd: number,
  max_handoffs: number,
  max_duration_seconds: number,
  on_exceeded: 'abort' | 'warn' | 'escalate',   // default 'warn'
  auto_invoke_budget_usd: number,
  breakdown: { ... },
  reason: string | null,
}
```

## Estimate computation

In precedence order:

1. **Explicit in the registry**: when the capability/business declares
   `estimated_cost_usd` in its manifest, use it directly.
2. **Baseline + handoff overhead** otherwise:
   ```
   estimate = baseline_by_type + (expected_handoffs * per_handoff_overhead)
   ```
   - `baseline_squad_capability_usd`: 0.30
   - `baseline_business_usd`: 0.80
   - `per_handoff_usd`: 0.05

## Local configuration (`config.yaml`)

```yaml
budget:
  default_max_cost_usd: 0        # 0 = unlimited (default); set > 0 for a hard cap
  default_max_tokens: 0
  default_max_handoffs: 0
  default_max_duration_seconds: 0
  on_budget_exceeded: warn       # abort | warn | escalate
  auto_invoke_budget_usd: 0      # 0 = no auto-invoke ceiling

baselines:
  squad_capability_usd: 0.30
  business_usd: 0.80
  per_handoff_usd: 0.05
```

`config.yaml` is read with the `yaml` package when available, falling back to
a tiny inline parser (top-level mappings, one nesting level).

## Auto-invoke gate

When `auto_invoke_budget_usd` is positive, a `validated` capability with
`estimated_cost_usd <= auto_invoke_budget_usd` may be invoked automatically on
a HIGH signal; above the ceiling, even HIGH requires human confirmation via
`AskUserQuestion`. At the default (0 = unlimited) the gate never blocks.

## Per-business override

A business can declare its own caps in `business.yaml`:

```yaml
run_budget_usd: 5.00        # per-run hard cap for this business
budgets:
  monthly_max_usd: 1000
  per_brief_max_usd: 5.00
```

When the harness invokes that business, the effective cap is the tightest
positive cap among harness default and business declaration.

## On-exceeded actions

Configured by `budget.on_budget_exceeded`:

| Value | Behavior |
|---|---|
| `warn` (default) | Continue, but emit a warning plus a `budget_violation` audit event |
| `abort` | Stop immediately, structured error, `budget_violation` audit event |
| `escalate` | Pause and fire the escalation trigger (Business Protocol §12) |

## Telemetry

Every budget decision emits OTel/JSONL-style attributes:

```
harness.budget.cap_usd
harness.budget.cumulative_usd
harness.budget.remaining_usd
harness.budget.cap_tokens
harness.budget.cumulative_tokens
harness.budget.action_taken    (when triggered)
```

Plus the audit event:

```json
{"ts":"...","event":"budget_violation","cap_usd":2.0,"cumulative_usd":2.31,"action":"warn"}
```

## CLI examples

```bash
# per-run hard cap on a dispatch
nrv dispatch <business> "<brief>" --exec --max-budget=5.00

# routing pre-flight only (fast router)
nrv route "manage marketing for client X"

# self-test covers budget.check
nrv validate
```

## Good practice

- Leave the default at 0 (unlimited) for interactive work; set explicit caps
  for unattended/recurring runs.
- For recurring businesses, declare `run_budget_usd` per business and review
  monthly.
- When telemetry history is available, replace the static baseline with a
  moving average of the last N runs (not implemented — see BUILD-NOTES.md).

## Anti-patterns

- Do NOT bypass a positive cap "to be helpful". A set cap is hard (HP3).
- Do NOT hardcode pricing — pricing tables belong to adapter manifests.
- Do NOT confuse cap (limit) with estimate (prediction). The cap is the
  trust floor; the estimate is decision input.
