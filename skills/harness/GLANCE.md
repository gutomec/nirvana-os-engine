# Nirvana Glance — visualizador instantâneo do harness

> Ephemeral browser-based control panel for the Nirvana system. **Read-only by default.** No installation, no daemon, no persistence. Closes when you close the terminal.

## Quick start

```bash
bun ~/.claude/skills/harness/scripts/glance.ts
```

Opens a browser tab against `http://localhost:<auto-port>` showing:
- All squads visible to the current scope (with version, protocol, capabilities count, source label)
- All businesses (with org-chart, routing, employees, memory preview)
- All Maestro projects (with live D3 DAG visualization, auto-refresh every 5s)
- All mind-clones in the DNA library
- Live tail of harness/maestro logs (SSE stream, refreshes every 3s)
- Full-text search across squads / businesses / mind-clones

The server **auto-shuts down** after 30 minutes idle, on `Ctrl+C`, or when you close the terminal. Nothing persists outside `~/.claude/.glance.pid` (auto-cleaned on exit).

## Flags

```bash
bun glance.ts                    # auto-port, opens browser, Apple Light theme
bun glance.ts --port 4242        # fixed port
bun glance.ts --no-open          # don't auto-open browser (you open the URL manually)
bun glance.ts --idle-min 60      # 60min idle timeout (default 30)
bun glance.ts --theme apple-dark # Apple Dark theme (default: apple)
bun glance.ts --theme awwwards   # Awwwards-tier dark + lime + WebGL particle hero
bun glance.ts --allow-actions    # ⚠ Phase 5 only: enables write endpoints (re-index/activate)
bun glance.ts --scope=project    # force a specific scope (overrides .env)
```

## Themes

| Theme | When to use |
|---|---|
| `apple` (default) | Light Apple HIG. Best for daylight, projector demos, screenshots. |
| `apple-dark` | Dark Apple HIG. Best for late-night exploration. |
| `awwwards` | Black background, lime accent, WebGL particle hero on launch. Showy. |

Toggle live with the `◐` button in the nav bar.

## Layout

```
┌────────────────────────────────────────────────────────────┐
│ ⊚ Nirvana Glance   [search ⌘K]    [scope: project] ◐ ⟳     │
├──────────┬──────────────────────────────────┬──────────────┤
│ Squads   │  brandcraft                       │ Scope        │
│ Bus.     │  v5.0.0 · proto 5.0 · 12 caps    │   mode: …    │
│ Projects │  [Overview · Manifest · Caps · …] │   project: … │
│ Mind-c.  │                                   │              │
│          │  (selected entity content)        │ Logs         │
│ filter…  │                                   │   12:14 HIGH │
│ [items]  │                                   │   12:14 ROUTE│
└──────────┴──────────────────────────────────┴──────────────┘
```

## Keyboard shortcuts

- `⌘K` / `Ctrl+K` — focus search
- `Esc` — clear search dropdown

## Endpoints (read-only, GET only)

| Path | Returns |
|---|---|
| `GET /api/health` | uptime, scope, allow_actions flag |
| `GET /api/scope` | resolved scope (mode, projectRoot, dirs, registries, state, logs) |
| `GET /api/squads` | scope-aware squad list with version/protocol/capabilities |
| `GET /api/squads/:slug` | manifest YAML, README, file lists, activation state |
| `GET /api/businesses` | scope-aware business list |
| `GET /api/businesses/:slug` | manifest, org-chart, routing, memory preview, employees |
| `GET /api/projects` | Maestro projects from `${MAESTRO_LOGS_DIR}` |
| `GET /api/projects/:id/dag` | DAG state + plan + brief + waves |
| `GET /api/logs?type=harness\|maestro&date=YYYY-MM-DD&limit=N` | tail jsonl events |
| `GET /api/logs/dates?type=…` | available log dates |
| `GET /api/logs/stream?type=…&date=…` | SSE: 3s polling stream of new events |
| `GET /api/mind-clones` | DNA library list, scope-aware |
| `GET /api/mind-clones/:cat/:slug` | full markdown content |
| `GET /api/search?q=…` | fuzzy search across squads + businesses + mind-clones |

`POST` / `PUT` / `DELETE` always return `405 Method Not Allowed` until you opt in with `--allow-actions` (Phase 5, not yet wired).

## Scope awareness

Glance respects `NIRVANA_SCOPE`. Run from inside a `scope=project` tree → see only that project's squads/businesses, registries pulled from `<project>/.nirvana/`, logs from `<project>/.nirvana/logs/`. Run from anywhere else → see globals, registries from `$HOME`. The scope panel on the right always shows the active mode.

## Security

- Bind only to `localhost` (Bun.serve default).
- Random port (3737-onwards) — unlikely collision but caller can fix with `--port`.
- Read-only: no shell exec, no fs writes outside `~/.claude/.glance.pid`.
- No auth: anyone with localhost access (= you) can read. Matches the existing skill ergonomics.
- Future `--allow-actions` mode will gate behind explicit flag + per-action confirmation banner.

## Smoke test

```bash
bun ~/.claude/skills/harness/tests/glance-smoke.ts
```

Spawns server, hits all 13 endpoints + negative checks (POST→405, missing slug→404), kills it. Exits 0 on pass.

## Files

```
~/.claude/skills/harness/
├── scripts/glance.{ts,sh,cmd}        ← entrypoint
├── lib/glance/
│   ├── server.ts                      ← Bun.serve + endpoints + SSE
│   ├── data-loader.ts                 ← scope-aware reads (registry/state/logs)
│   └── views/
│       ├── index.html                 ← SPA shell (Tailwind + Alpine + D3)
│       ├── glance.css                 ← Apple HIG tokens (OKLCH) + dark + awwwards
│       ├── glance.js                  ← Alpine app + fetch helpers + SSE consumer
│       ├── dag-renderer.js            ← D3 force-directed DAG
│       └── awwwards-hero.js           ← canvas2d particle field (1.8s intro)
├── tests/glance-smoke.ts              ← 13 endpoint checks + negative cases
└── GLANCE.md                          ← this file
```

## Phase 5 — Actions (write endpoints with SSE streaming)

Pass `--allow-actions` to enable POST endpoints. Default OFF for safety.

```bash
bun ~/.claude/skills/harness/scripts/glance.ts --allow-actions
```

| Endpoint | Action | Mutating? | Body |
|---|---|---|---|
| `POST /api/actions/audit-score` | Re-runs `audit-squads-score.ts` | no | `{}` |
| `POST /api/actions/audit-improve` | `improve-squad.ts <slug>` (dry-run or apply) | yes | `{slug, dry_run?}` |
| `POST /api/actions/audit-batch` | `audit-batch-orchestrator.ts` | yes | `{dry_run?, tier?, limit?}` |
| `POST /api/actions/activate-dry-run` | `activate-squad.ts <slug> --dry-run` | no | `{slug}` |
| `POST /api/actions/index-squads` | Re-runs `index-squads.ts` | yes | `{}` |
| `POST /api/actions/index-businesses` | Re-runs `index-businesses.ts` | yes | `{}` |
| `POST /api/actions/run-smoke` | `scope-isolation-smoke.ts` | no | `{}` |
| `POST /api/actions/run-test` | `scope.test.ts` | no | `{}` |
| `GET  /api/actions/jobs` | List active + recent jobs | — | — |
| `GET  /api/actions/jobs/:id` | Job state + output buffer | — | — |
| `GET  /api/actions/jobs/:id/stream` | SSE: `snapshot` → `line`* → `done` | — | — |
| `POST /api/actions/jobs/:id/cancel` | SIGTERM then SIGKILL after 5s | — | — |

All return `202 Accepted` with `{ job, stream_url }`. Without `--allow-actions`: `403`.

### Guards
- **Concurrency:** at most 1 mutating job at a time (returns `409` if already running). Read-only actions are concurrent.
- **Whitelist:** only the commands above can spawn — no arbitrary shell exec.
- **Slug regex:** `^[a-z0-9-]+$` enforced at endpoint to block injection.
- **Confirmation modal:** UI prompts before any `--apply` action.
- **Auto-cleanup:** finished jobs garbage-collected after 1h; max 5000 lines in memory per job.

### Agentic improvements (audit-improve / audit-batch)

The mechanical fixers cover ~70% of nirvana criteria deterministically. The remaining 30% (rewriting descriptions, expanding READMEs, adding task acceptance criteria) require LLM judgement — handled by the consensus loop in `~/.claude/skills/squads/lib/squad-audit-consensus.js`:

1. **Auth:** spawns the local `claude` CLI with `CLAUDE_CODE_OAUTH_TOKEN` set in env. We **never** read `ANTHROPIC_API_KEY` directly — using Claude Code's OAuth keeps invocations on the user's plan/billing.
2. **Loop:** self_audit+logos propose → dialektikos critique → self_audit refine → meta evaluate → empiricus tiebreak.
3. **Verifier:** an independent `claude -p` spawn (the `meta` agent of self_audit squad) reviews the actual diff post-validation. Verdict `rollback` triggers automatic restore from backup. Set `CLAUDE_AUDIT_VERIFY_ALWAYS=1` to run on mechanical-only patches too.
4. **Cost caps:** `--max-budget-usd 0.50` per consensus call (override via `CLAUDE_AUDIT_BUDGET_USD`); `0.20` per verifier call (`CLAUDE_VERIFY_BUDGET_USD`).

### UI

When `--allow-actions` is on, Glance gains:
- **⚡ menu (top-right):** system actions (re-score, audit batch, re-index, smoke, tests)
- **Per-squad action buttons:** Activate (dry-run), Audit (dry-run), Improve (apply, with confirmation)
- **▦ Console drawer (bottom):** persistent log viewer
  - Lists all jobs with status badges (● running, ✓ completed, ✗ failed, ⊘ cancelled)
  - Click a job → live SSE stream of stdout/stderr
  - Cancel button on running jobs
  - Auto-opens when you trigger an action; can be dismissed with ✕

## Why this works

- **Não persistente:** server lives only during the terminal session. No daemon.
- **Cross-platform:** Bun runs natively on macOS / Linux / Windows / WSL2 / Alpine.
- **Zero build:** all frontend deps via CDN (Tailwind, Alpine, D3, Inter, JetBrains Mono). Just open the URL.
- **Scope-coherent:** reads everything via the same `paths.js` / `scope.ts` the rest of the system uses. What Glance shows = what the harness sees.
- **Smoke-locked:** 13 endpoint checks pass before any commit.

For deeper dive into design rationale (self_audit 7-pillar analysis), see git history of this file.
