# Reference 03 — Audit trail

> How the harness records what happened, where the log lives, and how to query
> it. Source of truth for event names: `lib/audit.js` `ALLOWED_EVENTS` (the
> table below is generated from it). Schema:
> `_shared/schemas/core-schemas.json#/definitions/audit_event`.

## Where it lives

| Scope | Path | Default retention |
|---|---|---|
| Per session (cross-project) | `~/.harness-logs/<YYYY-MM-DD>/audit.jsonl` | 90 days |
| Per project | `<project>/audit.jsonl` (plus the session log) | 365 days |

Resolution: `$HARNESS_LOGS_DIR` wins when set; otherwise `_shared/lib/log-paths.ts`
walks up from the caller's `cwd` to find the project root (`.nirvana` / `.env` /
`.git` markers) so a dispatcher can pin events to the project regardless of
where the process started; the fallback is `~/.harness-logs`. Writers also
dual-write to the SQLite state-db when `bun:sqlite` is available — JSONL stays
authoritative for legacy readers, SQLite is the race-safe substrate.

## JSONL format

Append-only, one JSON object per line, UTF-8.

```jsonl
{"ts":"2026-08-05T17:30:11.241Z","event":"brief_received","trace_id":"01HZ...","brief_excerpt":"...","brief_chars":142,"command":"route"}
{"ts":"2026-08-05T17:30:11.342Z","event":"routing_decision","signal":"HIGH","target_id":"squad_capability:audio-suite:audio_video.transcribe","route_tier":"stage2_squad"}
{"ts":"2026-08-05T17:30:12.001Z","event":"dispatch_business","trace_id":"01HZ...","business_slug":"ars-libri"}
{"ts":"2026-08-05T17:31:14.901Z","event":"cost_emission","agent":"transcriber","model":"sonnet","tokens_input":1200,"tokens_output":340,"cost_usd":0.0228}
{"ts":"2026-08-05T17:31:20.000Z","event":"gate_passed","trace_id":"01HZ...","score":0.91}
```

## Canonical fields

Every event has `ts` and `event`. Canonical optional top-level fields
(normalized by `audit.emit`'s `ctx` argument):

- `trace_id`
- `project_id`
- `business_slug`
- `squad_name`
- `agent_or_employee`
- `session_id` (correlates runtime hook events with harness events)

Extra fields are allowed (`additionalProperties: true` in the schema). Prefer
OTel-consistent names where they exist (`tokens_input`, `tokens_output`,
`cost_usd`).

## The closed enum + the `x_` namespace

Event names have two tiers:

1. **Core enum** — the closed list in `lib/audit.js` `ALLOWED_EVENTS`. These
   are the events code paths and the maestro protocol rely on; readers
   (glance, validate-chain, trace-builder, the improver) key on these names.
2. **`x_` namespace (open, by design)** — anything else. `audit.emit` records
   an unknown name as `x_<name>` (one stderr warning per process per name)
   instead of crashing the caller; a name already starting with `x_` passes
   through silently. Extension events SHOULD be spelled with the explicit
   `x_` prefix at the call site so the source literal matches the log
   (`x_route_ambiguous_autopicked`, `x_capability_resolved`,
   `x_delivery_withheld`, `x_runtime_errored_with_artifacts`,
   `x_research_completed`, ...). Set
   `NIRVANA_AUDIT_STRICT=1` to make unknown
   names throw (used by the schema tests).

The parity gate `bun scripts/check-audit-parity.ts --strict` fails the build
when the docs prescribe a non-enum, non-`x_` event or when code emits one.

<!-- BEGIN GENERATED: audit-events (scripts/gen-audit-events-doc.ts — do not edit by hand) -->

96 events in the closed enum (declaration order of `ALLOWED_EVENTS` in `lib/audit.js`):

```
brief_received
brief_amplified
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
loop_detected
context_budget_warning
stall_detected
stall_retry
gate_failed
gate_passed
dispatch_business
dispatch_squad
dispatch_agent_x
target_plan_committed
mind_clone_injected
dispatch_blocked
dispatch_audit
dispatch_audit_revision
judge_invoked
critique_generated
revision_dispatched
revision_loop_exhausted
brief_scored
clarification_emitted
clarification_received
chunk_emitted
chunk_gate_passed
chunk_gate_failed
delivered
verify_passed
verify_failed
agent_executed
agent_exec_failed
auto_route_selected
revision_auto
routing_rule_applied
routing_rule_vetoed
brief_proxy_enriched
report_pdf_generated
report_html_generated
report_publisher_ran
report_skipped_fast
session_resumed
session_resume_failed
squad_run_failed
team_director_called
team_director_failed
team_chain_selected
team_step_failed
team_completed
mind_clone_missing_degraded
agentic_route_called
agentic_route_decision
agentic_route_failed
cascade_exhausted
cascade_no_entry_available
runtime_unavailable
runtime_auth_failed
runtime_quota_exhausted
runtime_transient_retry
runtime_error
runtime_handoff
dispatch_cost_recorded
handoff_phase_advanced
deliverable_manifest_registered
revision_requested
revision_failed
session_started
tool_invoked
bash_completed
artifact_touched
watch_started
watch_stopped
ask_invoked
nirvana_updated
pack_created
project_exported
project_purged
```
<!-- END GENERATED: audit-events -->

Regenerate with `bun scripts/gen-audit-events-doc.ts --write`;
`skills/harness/tests/audit-events-doc.test.ts` asserts this file matches the
enum, so a stale table is a test failure, not a silent lie.

Note: part of the enum is the **maestro-emitted surface** — events the
orchestrating model writes via `nrv audit emit` during an agentic run
(`target_plan_committed`, `human_notification_required`, `stall_detected`,
`memory_write`, ...). No engine code path emits those; their presence in the
enum is the contract that the maestro's writes validate cleanly.

## Emitting

**CLI (the canonical path for the maestro):**

```bash
nrv audit emit dispatch_business --business=<slug> --trace=<uuid> --brief_excerpt="<first 80 chars>"
nrv audit emit gate_passed       --business=<slug> --trace=<uuid> --score=<n>
# structured fields:
nrv audit emit dispatch_business --business=<slug> --json='{"mind_clones":[...]}'
```

**JavaScript API:**

```javascript
const audit = require('~/.nirvana/skills/harness/lib/audit.js');

audit.emit('routing_decision', {
  signal: 'HIGH',
  target_id: 'squad_capability:audio-suite:audio_video.transcribe',
  score: 0.93,
}, {
  trace_id: '01HZ...',
  project_id: 'client-x',
  cwd: projectDir,   // anchors WHERE the event is written (project root walk)
});

const recent = audit.readRecent(50);       // last N events of the day
audit.rotate(90);                          // delete day-dirs older than 90 days
```

## Common queries

### How many events today?

```bash
TODAY=$(date -u +%Y-%m-%d)
wc -l < ~/.harness-logs/$TODAY/audit.jsonl
```

### Signal distribution

```bash
TODAY=$(date -u +%Y-%m-%d)
jq -r 'select(.event=="routing_decision") | .signal' ~/.harness-logs/$TODAY/audit.jsonl | sort | uniq -c
```

### NO_MATCH of the last 7 days (input for planning new capabilities)

```bash
for i in 0 1 2 3 4 5 6; do
  d=$(date -u -v-${i}d +%Y-%m-%d 2>/dev/null || date -u -d "$i days ago" +%Y-%m-%d)
  f="$HOME/.harness-logs/$d/audit.jsonl"
  [ -f "$f" ] && grep '"signal":"NO_MATCH"' "$f"
done
```

## Validation

```bash
python3 ~/.nirvana/skills/_shared/validators/validators.py \
  --validate audit_event \
  --input <(echo '{"ts":"2026-08-05T00:00:00Z","event":"brief_received","brief_length":42}')
```

`nrv validate-chain <project>` checks a project's chain end-to-end
(`brief_received → dispatch_* → gate_* → delivered`), and
`nrv validate-chain --verify-disk` flags a `gate_passed` with no on-disk
artifact as a `PROTOCOL_VIOLATION`.

## Retention and rotation

Default: 90 days for session logs (`~/.harness-logs`). Configurable in
`config.yaml`:

```yaml
audit:
  retention_days: 90
```

`audit.rotate(days)` deletes `<YYYY-MM-DD>/` directories older than the
cutoff; call it periodically (cron / runtime hook).

## Privacy

- Never put a full brief on an event. `brief_excerpt`
  (`_shared/lib/brief-excerpt.ts`) is the only sanctioned form: bounded at 300
  characters, single line, with `brief_chars` beside it carrying the true length.
  The router CLI used to send the whole brief; it no longer does. A field that
  grows without a ceiling on a file appended thousands of times a day is a
  defect, not a feature.
- Hash custom fields containing PII before `emit`.
- The isolation guard keeps other projects' audit logs out of the current
  session.

## Anti-patterns

- Do NOT write audit events into another project's tree (cross-project leak).
- Do NOT `JSON.stringify` huge objects into a single event — summarize and
  reference (trace_id, hash, path) instead.
- Do NOT swallow audit failures silently in protocol-critical paths: losing
  the record is worse than failing the invocation (HP2: failure-loud).
- Do NOT invent bare event names outside the enum — use the `x_` prefix so
  the log and the source agree, and promote to the enum when a reader starts
  depending on the event.
