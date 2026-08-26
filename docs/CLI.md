# `nrv` — CLI reference

The day-to-day way to drive Nirvana-OS is to **talk to it in plain language** from any AI CLI you already use. This page is for power users who want the direct `nrv` commands underneath.

Run `nrv help` for the live reference, and `nrv <subcommand> --help` for any command's full options.

```bash
nrv <subcommand> [args]
```

---

## First run

| Command | What it does |
|---|---|
| `nrv install --bootstrap` | Wire audit hooks into Claude Code, Gemini-CLI, and Antigravity (run once after installing; idempotent). |
| `nrv install --check` | Report status; exit 0 if ready, 1 if it needs setup. |
| `nrv install --repair-path` | Windows: list temporary `nrv-*` entries left on the user PATH (nothing written); `--apply` removes exactly those. |
| `nrv doctor` | Full system diagnostic (binaries, skills, hooks, patches). |

## Talk to it / run work

| Command | What it does |
|---|---|
| `nrv auto "<brief>"` | **Autopilot.** The router picks the best company for your brief, executes it headless, verifies, and runs the quality gate. (= `run --auto`.) |
| `nrv run <business> "<brief>"` | Autopilot against a company you name: dispatch + execute + verify + gate. |
| `nrv dispatch <business> "<brief>"` | Scaffold a run (brief + DNA injection + audit) without auto-executing. |
| `nrv dispatch --business <slug> \| --squad <slug> \| --agent-x "<brief>" [--exec]` | Name the target yourself; the three flags are mutually exclusive with each other and with `--auto`, and none of them consults the router. `--exec` runs it, otherwise it only scaffolds. (`--judge-x` is the engine's Gauntlet judge, spawned by the evaluator adapter on an evaluation brief; it is not a producer.) |
| `nrv revise <project> "<change>"` | Apply a change while keeping the same runtime session. |
| `nrv launch <name> --pillars=brand,marketing,gtm` | Scaffold a multi-pillar 360° launch (default: all 11 pillars). |
| `nrv ask <clone> "<question>"` | Talk directly to a single specialist (mind-clone), DNA injected. |
| `nrv multi-target plan\|run\|status <plan.json>` | Multi-target engine by plan file (alias `nrv mt`): `plan` compiles the waves, `run` executes them over the Run Kernel (needs `NIRVANA_MULTI_TARGET_ENGINE=1`), `status` reads the projection. |

Useful flags on `run` / `auto`: `--team` (real multi-employee orchestration), `--zip` / `--pdf` (bundle deliverables), `--runtime=claude-code|codex|gemini-cli|antigravity-cli`, `--max-budget=<usd>`, `--timeout=<min>`, `--mode=agentic|fast` (routing mode), `--execution-mode=standard|gauntlet|auto` (default `standard`), `--gauntlet-intensity=light|balanced|exhaustive` (a Business target needs `NIRVANA_BUSINESS_GAUNTLET_ALLOWLIST=<slug>`), `--run-id=<runId>` (adopt a Run already prepared in the project's kernel, the way Glance does).

## See it happen

| Command | What it does |
|---|---|
| `nrv glance [--read-only]` | Open the **Glance** web cockpit: live runs, the capability graph, and the audit trail of everything your organization is doing. In an adopted project, a chat Message runs a child `dispatch.ts` with a live timeline, cancel, and recovery after a restart; `--read-only` disables execution and every write endpoint (`NIRVANA_GLANCE_EXECUTION=0` keeps the cockpit up without spawning). |
| `nrv tui [--once\|--json]` | Terminal cockpit: live audit, active projects, registries. |
| `nrv watch [project]` | Tail audit events live in the terminal. |
| `nrv audit-view <project>` | Rich chronological view of a project's audit chain. |

## Discover

| Command | What it does |
|---|---|
| `nrv route "<brief>"` | Route a brief and show the decision (HIGH / AMBIGUOUS / NO_MATCH). |
| `nrv find "<query>"` | Dry-run capability discovery. |
| `nrv search "<query>" [--kind=business\|squad\|mind-clone]` | Keyword + BM25 search across your libraries. |
| `nrv list-businesses` / `nrv list-squads` / `nrv list-clones` | List what's in your libraries (`--format=table\|json`). |
| `nrv inspect-clone <slug> [--commands\|--dna]` | Inspect a single specialist. |

## Projects

| Command | What it does |
|---|---|
| `nrv init <dir>` | Create a new Nirvana project. `--copy` (portable delivery), `--scope=project` (isolated). |
| `nrv resume <project>` | Resume an incomplete project from its audit log. |
| `nrv export <project> [--format=zip\|tgz]` | Bundle a project's outputs to share. |
| `nrv clean <project> [--hard]` | Remove a project scaffold (trash by default). |

## Libraries & distribution

| Command | What it does |
|---|---|
| `nrv install <source> [--dry-run\|--force\|--scope=project]` | Install a business / squad / mind-clone / pack from a dir, tarball, http or git URL (auto-detects type). |
| `nrv installed [--all] [--kind=...]` | List active installations. |
| `nrv uninstall <name>` | Remove an installed asset. |
| `nrv pack create <dir>` / `inspect` / `publish` | Bundle and share assets (`.tgz` + sha256). |
| `nrv index` | Re-index squads + businesses after manual edits. |

## Health & self-improvement

| Command | What it does |
|---|---|
| `nrv validate` | Self-test (registries, validators, audit). |
| `nrv validate-chain <project> [--strict\|--all]` | Audit-chain integrity check. |
| `nrv baseline [--days=N] [--save]` | Snapshot system KPIs from the audit log. |
| `nrv improver run [--days=N]` | Meta-Nirvana: mine the audit log and propose improvements. |
| `nrv update [--check\|--force]` | Self-update: pull + re-run installer + re-index. |

---

## A few real invocations

```bash
nrv doctor                                              # health check first
nrv auto "crie uma landing page para um SaaS de logística"   # autopilot, router picks the company
nrv run brand-creative-studio "Manifesto for a SaaS called Atlas"
nrv launch atlas --pillars=brand,marketing,gtm
nrv ask rory-sutherland "Critique this headline: ..."
nrv glance                                              # watch your organization work
nrv init ~/Projects/cliente-x --copy
```

> Every run writes a `trace_id` into an append-only audit log. Replay or verify any project with `nrv validate-chain <project> --strict`.
