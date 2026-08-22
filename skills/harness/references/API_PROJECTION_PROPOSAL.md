# The API is the fourth projection

**Status:** proposal, registered · **Written:** 2026-08-22 · **Owner-approved direction:** yes (design phase)
**Grounding:** ~/vps-setup-squad/artefatos/nirvana-os-via-api-e-sdks.md (field survey, VPS-verified CLI paths + vendor-doc SDK research)

Nirvana-OS is not a service; it is a protocol with projections. The graph
(PR #41) projects the org as a validated artifact; glance projects
observability; the CLI projects commands. An HTTP API is the FOURTH
projection of the same protocol — never a second system, never a second
executor.

## 1. The insight that sizes the work

Everything an API needs already exists with a stable contract:

| API need | Engine primitive |
|---|---|
| Job state machine | run ledger (`open/beat/close`, leases, supervisor never-stall) |
| Status contract | `nrv dispatch --exec` exit codes (0 delivered · 1 failed · 2 withheld · 3 indeterminate) + ledger states |
| Session isolation | `NIRVANA_SCOPE=project` (HP7: cross-project access is a bug) |
| Progress feed | per-project `audit.jsonl` — append-only, tail → SSE |
| Structured response | `outputs/` tree + `_SUMMARY.md` + `_QA-RESERVATIONS.md` + gate verdict schema |
| Cost control | `--max-budget`, `--max-revisions`, `NIRVANA_MAX_GATE_RETRIES` |
| Crash survival | supervisor sweep + salvage (a run never ends in silence) |
| Executor safety | headless session-lifetime doctrine (0.7.7) + two-roles rule (worker never root) |

Missing: only the shell — HTTP, auth, queue, retention. Small on purpose.

## 2. The design: `nrv serve` (control plane, never executor)

Bun + Hono server shipped as an engine component.

```
POST   /v1/sessions                       → project dir + nrv init → {session_id}
POST   /v1/sessions/{id}/briefs           → 202 {trace_id}   (async, always)
GET    /v1/sessions/{id}/runs/{trace}     → ledger state + audit summary
GET    /v1/sessions/{id}/runs/{trace}/events     → SSE over audit.jsonl
GET    /v1/sessions/{id}/runs/{trace}/artifacts  → structured listing
GET    /v1/.../artifacts/{path}           → download (signed, expiring)
POST   /v1/webhooks                       → terminal-state callback
```

Decisions, each traceable to engine doctrine:

1. **Child-process execution** (`nrv dispatch --auto --exec` per run), not
   in-process imports: crash isolation, ledger/supervisor as the net, ONE
   execution path shared with the CLI forever.
2. **Queue: serialized per session**, N sessions parallel under a global
   `max_concurrent_runs` cap (the owner's machine constraint as product
   parameter).
3. **Response envelope wraps what exists**: `{state, gate, artifacts[],
   summary, reservations?, audit:{...}}` — `fail-accepted` +
   `_QA-RESERVATIONS.md` becomes honesty as a JSON field.
4. **Security in the browser-channel posture**: localhost/unix-socket by
   default, explicit `--host` to expose; API keys with per-key budget and
   quota (the affiliate lesson: the server computes, the client never sets
   its own ceiling); glance stays off the network forever.
5. **Runtime**: claude-code default (`CLAUDE_CODE_OAUTH_TOKEN` is the only
   env-friendly credential, field-verified); pi as the vendor-independent
   fallback (15+ providers, local models = the LLM_CASCADE zero-cost floor).

## 3. Corrections to the field survey (engine moved under it)

- §2.3 `existsSync(dirname)` silent-skip: FIXED in 0.7.4 (two-signal probe,
  loud linking). Survey describes pre-0.7.4 behavior as current.
- §6.4 `claude -p` orphaning background children: doctrine shipped in 0.7.7
  (session-lifetime rule in AUTONOMOUS_DIRECTIVE + SKILL.md scoping). The
  API design does not depend on it anyway — scripted dispatch is synchronous.

## 4. Open questions (the 1-day spike, before any API code)

1. Does Claude Agent SDK `settingSources + skills:"all"` actually load the
   harness from the filesystem? (vendor doc says yes; never executed)
2. Does the Codex SDK, spawning the real CLI, inherit `~/.codex/skills`?
3. Does `sessionStore` resume across hosts in practice?
4. **Commercial (owner decision): seat accounting.** Root + user on one VPS
   consume 2 of `max_seats=3`; an API worker fleet explodes this instantly.
   Recommended: a server/API license class with its own pricing — new
   revenue, not a counting bugfix.

## 5. Product ladder this unlocks

1. `nrv serve` in the engine — every buyer gains; packs stay the content moat.
2. **Nirvana Cloud on squads.sh** — hosted sessions per buyer (their license,
   their packs, usage billing); `nirvana-vps-setup` becomes the fleet
   bootstrapper. The loop closes itself.
3. n8n / Zapier / Make connectors over the API — mass distribution, thin work.
4. WhatsApp bridge — `agentic-whatsapp-nirvana` as an API consumer.

## 6. What this proposal refuses

- Exposing glance (owner's panel, not an API).
- Any in-server execution of briefs (second-executor failure mode).
- Any client-supplied monetary/limit parameter.
- Synchronous brief handling (a 2-page PDF took 19 verified minutes).
