# Reference 06 — the HTTP API (`nrv serve`)

Serving the protocol over HTTP. The API is a CONTROL PLANE: a session is a
project directory, a brief becomes a child `nrv dispatch --auto --exec`, and
every answer reads what the engine already wrote. There is no second
executor, and there never will be.

## Start

```bash
nrv serve keygen --budget-usd 5 --daily-runs 50   # token is shown ONCE
nrv serve --port 7777                             # binds 127.0.0.1
```

Budget and quota are attributes of the KEY. A client that sends its own
budget is ignored — the server computes money, the caller never declares it.

`nrv serve` refuses to run as root: a dispatched agent would inherit it.

## The five calls that matter

```bash
TOKEN=nrv_…
API=http://127.0.0.1:7777

# 1. a session (a project dir, contract files written by nrv init)
SID=$(curl -s -X POST $API/v1/sessions -H "Authorization: Bearer $TOKEN" | jq -r .session_id)

# 2. a brief — always async; a real one takes minutes
TRACE=$(curl -s -X POST $API/v1/sessions/$SID/briefs \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"brief":"escreva o relatório X"}' | jq -r .trace_id)

# 3. watch it work (the project's audit log, streamed)
curl -N $API/v1/sessions/$SID/runs/$TRACE/events -H "Authorization: Bearer $TOKEN"

# 4. the envelope
curl -s $API/v1/sessions/$SID/runs/$TRACE -H "Authorization: Bearer $TOKEN"

# 5. the artifact
curl -s $API/v1/sessions/$SID/runs/$TRACE/artifacts/relatorio.md \
  -H "Authorization: Bearer $TOKEN" -o relatorio.md
```

## Which library a session can reach

```bash
curl -X POST $API/v1/sessions -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"library":"global"}'    # default
```

`global` lets the session route into your own businesses, squads and clones
— the reason you bought the packs. `isolated` restricts it to the session's
own project, which is what a multi-tenant host wants: one tenant must never
route into another's library.

## Two scopes that must never be confused

Where the INTELLIGENCE comes from and where the FILES are written are
different decisions, and the API keeps them apart:

| | Global session (default) | Isolated session |
|---|---|---|
| Businesses, squads, clones resolve from | the operator's library, project entries winning on conflict (`merge`) | the session's project only |
| Logs, outputs, run state are written to | the session directory | the session directory |

The library must never default to the project: a session that starts blind
routes every brief to the generalist, which is the least the system can do.
Artifact isolation is what keeps one caller's work out of another's, and it
holds in both modes — the server pins `HARNESS_LOGS_DIR` and
`NIRVANA_PROJECT_ROOT` to the session on every dispatch.

**On a server, point sessions at a volume**: `nrv serve` writes sessions
under `~/.nirvana/serve/sessions` unless `NIRVANA_SERVE_SESSIONS_ROOT` says
otherwise. Mount a volume there and every session's outputs, logs and run
state land on it — survives container replacement, and backing up one path
backs up every caller's work.

```bash
NIRVANA_SERVE_SESSIONS_ROOT=/data/nirvana-sessions nrv serve --port 7777
```

## The envelope

```json
{
  "state": "delivered | withheld | indeterminate | failed | running | queued",
  "gate": "pass | fail-accepted | fail | indeterminate | null",
  "artifacts": [{ "path": "relatorio.md", "bytes": 2413, "content_type": "text/markdown" }],
  "summary": "…contents of _SUMMARY.md…",
  "reservations": "…contents of _QA-RESERVATIONS.md, when the gate ran out of retries…",
  "exit_code": 0
}
```

`state` mirrors the dispatch exit contract 1:1 (0 delivered · 2 withheld ·
3 indeterminate). `gate: "fail-accepted"` means the retry ceiling was hit and
the last attempt was accepted WITH the reservations in the field beside it —
the API never hides that from the caller.

## Jobs — the polling floor

A consumer that only kept the job id (it lost the webhook, or never listened
for one) never needs the session id back:

```
GET  /v1/jobs/{trace_id}                  → the envelope (same shape as above)
GET  /v1/jobs/{trace_id}/events           → SSE, same feed as the session route
GET  /v1/jobs/{trace_id}/result           → the artifact, or the list + a path to pick one
GET  /v1/jobs/{trace_id}/artifacts/{path} → one artifact by path
```

`/result` streams the file directly when the run produced exactly one
artifact; otherwise it answers with the same `artifacts` list the envelope
already carries, plus a pointer to `/artifacts/{path}`. Ownership is the same
key check every session route makes — another key's token gets
`job_not_found`, the same 404 a stranger's session id gets.

This is the honest floor the plan calls for: it does not depend on
connectivity at the moment an event fires, so it is what a consumer falls
back to after a lost webhook, a missed SSE stream, or simply never having
listened at all.

## Webhooks

`POST /v1/webhooks {"url":"https://…"}` returns a secret. Each terminal state
delivers ONE POST, retried on failure — see below — carrying:

```json
{ "event": "run.finished", "trace_id": "run_…", "session_id": "ses_…",
  "state": "delivered", "gate": "pass",
  "job_url": "/v1/jobs/run_…", "result_url": "/v1/jobs/run_…/result" }
```

**By reference, never by value**: the body never carries `summary`,
`reservations` or artifact content — a legal case is sensitive, and the
consumer already holds the credential needed to fetch the real thing from
the URLs above. `job_url` / `result_url` are relative unless the operator set
`NIRVANA_SERVE_PUBLIC_URL` (the bind address behind a reverse proxy is not
the public one) — the consumer already knows its own host, since it is the
one that called this API in the first place.

**Headers**, all required to trust the delivery:

| Header | Meaning |
|---|---|
| `X-Nirvana-Signature` | `sha256=<hmac>` over `${timestamp}.${body}` under the registered secret — the timestamp is bound INTO the signature, so a captured request cannot be replayed with a forged fresh timestamp. |
| `X-Nirvana-Timestamp` | Unix seconds the request was signed. |
| `X-Nirvana-Delivery-Id` | Idempotency key, stable across every retry of the SAME terminal event — reused from the CloudEvents `id` every audit event already carries (see `03-audit.md`). Dedupe on this before processing. |
| `X-Nirvana-Event` | `run.finished`, today's only kind. |

A receiver validates a delivery by recomputing the signature over
`${timestamp}.${body}` and refusing anything outside a 5-minute window (60s
of clock skew tolerated) — `verifyWebhook()` in `lib/serve/webhooks.ts` is
the reference implementation; use it rather than reimplementing the
timestamp math.

**Retry**: exponential backoff with full jitter, persisted per run
(`.webhook-delivery.jsonl` beside `.run.json`) so it survives this server
restarting, not only the receiver being briefly unreachable. Delays climb
1s → 2s → 4s → … capped at one hour; after 10 attempts (≈2h worst case
cumulative) the delivery is marked `abandoned` and stops — a retry that never
gives up is a different defect. An abandoned webhook is a degraded
notification, never a lost result: the run's artifacts stay on disk and
`GET /v1/jobs/{id}` never expires.

## Exposing it

The server speaks plain HTTP and ships no TLS. Put a reverse proxy in front:

```
# Caddy
api.example.com { reverse_proxy 127.0.0.1:7777 }
```

Then `nrv serve --host 127.0.0.1` stays local and only the proxy is public.
`--cors https://app.example.com` opts specific origins in; there is no
wildcard.

## Operational notes

- **Runtime credentials**: a server has no browser. `CLAUDE_CODE_OAUTH_TOKEN`
  (from `claude setup-token`) is the one credential that travels as an env
  var; other runtimes authenticate through their own CLI and store a file.
- **A restart does not lose runs**: each run persists `.run.json` beside its
  artifacts and is rehydrated on lookup. A run interrupted mid-flight is
  reported `failed` with the reason, never as eternally running.
- **A restart does not lose pending webhook deliveries either**: the retry
  schedule is re-discovered from `.webhook-delivery.jsonl` on startup, the
  same way orphaned runs are.
- **Concurrency**: one run per session, `--max-concurrent` across sessions.
- **Seats**: each machine running the engine consumes a seat of the pack
  license. A fleet of API workers needs a licensing decision before it
  scales (see API_PROJECTION_PROPOSAL.md §4).
