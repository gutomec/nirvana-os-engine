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

## Webhooks

`POST /v1/webhooks {"url":"https://…"}` returns a secret; each terminal state
POSTs `{event:"run.finished", run:<envelope>}` with an HMAC-SHA256 of the body
in `X-Nirvana-Signature` (`sha256=…`). Verify it before trusting the payload.

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
- **Concurrency**: one run per session, `--max-concurrent` across sessions.
- **Seats**: each machine running the engine consumes a seat of the pack
  license. A fleet of API workers needs a licensing decision before it
  scales (see API_PROJECTION_PROPOSAL.md §4).
