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
| `nrv doctor` | Full system diagnostic (binaries, skills, hooks, patches, and the `config` section: every operational setting with its effective value and origin). |

## Configure

| Command | What it does |
|---|---|
| `nrv config list [--json]` | Every operational setting (multi-target, Gauntlet, runtime, routing, supervisor, updates, budget, quality gate) with its effective value, where it comes from (a variable, the project file, the global file, the engine file, the default) and its default. |
| `nrv config get <key>` / `nrv config explain <key>` | The effective value; `explain` adds the description, the default, the allowed scopes and the legacy variable. |
| `nrv config set <key> <value> [--global\|--project]` / `nrv config unset <key> [...]` | Writes `<project>/.nirvana/config.yaml` (the default inside a project) or `~/.nirvana/config.yaml` (kept across `nrv update`), one line at a time, comments preserved. Refuses a value the schema rejects, a scope the key does not accept, and a key pinned by a variable in this shell, each with the reason; every write audits `x_settings_changed`. |

Precedence, always: environment variable > `<project>/.nirvana/config.yaml` > `~/.nirvana/config.yaml` > the engine's `skills/harness/config.yaml` > the default. The full key table, the variables that stay environment-only and the reasons are in `docs/architecture/configuration.md`.

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
| `nrv multi-target plan\|run\|status <plan.json>` | Multi-target engine by plan file (alias `nrv mt`): `plan` compiles the waves, `run` executes them over the Run Kernel (`nrv config set multi_target.enabled false` or `NIRVANA_MULTI_TARGET_KILL_SWITCH=1` turns it off), `status` reads the projection. |

Useful flags on `run` / `auto`: `--team` (real multi-employee orchestration), `--zip` / `--pdf` (bundle deliverables), `--runtime=claude-code|codex|gemini-cli|antigravity-cli`, `--max-budget=<usd>`, `--timeout=<min>`, `--mode=agentic|fast` (routing mode), `--execution-mode=standard|gauntlet|auto` (default `standard`), `--gauntlet-intensity=light|balanced|exhaustive` (a Business target needs `NIRVANA_BUSINESS_GAUNTLET_ALLOWLIST=<slug>`), `--run-id=<runId>` (adopt a Run already prepared in the project's kernel, the way Glance does).

## See it happen

| Command | What it does |
|---|---|
| `nrv glance [--read-only]` | Open the **Glance** web cockpit: live runs, the capability graph, and the audit trail of everything your organization is doing. In an adopted project, a chat Message runs a child `dispatch.ts` with a live timeline, cancel, and recovery after a restart; `--read-only` disables execution and every write endpoint (`NIRVANA_GLANCE_EXECUTION=0` keeps the cockpit up without spawning). The gear opens the "Configuração" panel: every `nrv config` key with its own control, saved per key into the project or the global file and holding from the next Message; the `.env` section stays for secrets, library scope and `LLM_CASCADE`. |
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
| `nrv validate <kind> <slug\|path> [--fix] [--strict] [--json]` | Admission gate for one squad, business or mind-clone (`nrv verify` is an alias). |
| `nrv validate <kind> --all [--record [--allow-regression]]` | Verify every installed entity of a kind; `--record` writes the debt baseline. |
| `nrv validate --pack <content-dir> [--json]` | Verify a pack's content before it ships. |
| `nrv validate-chain <project> [--strict\|--all]` | Audit-chain integrity check. |
| `nrv baseline [--days=N] [--save]` | Snapshot system KPIs from the audit log. |
| `nrv improver run [--days=N]` | Meta-Nirvana: mine the audit log and propose improvements. |
| `nrv update [--check\|--force]` | Self-update: pull + re-run installer + re-index. |

> `nrv validate` exits `0` admitted · `1` an error the debt baseline does not cover · `2` only warnings, under `--strict` · `64` usage error or unknown entity. The system doctor moved to `nrv doctor`; `nrv validate` with no arguments still runs it, with a deprecation notice, for one release. Kind aliases: `biz`, `clone`, `mc`. Full contract: [docs/architecture/validate-gate.md](architecture/validate-gate.md).

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
