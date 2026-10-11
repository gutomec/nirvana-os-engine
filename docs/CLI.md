# `nrv` — CLI reference

Nobody needs to type these day to day. You talk to the agent you already use (Claude Code, Codex, Antigravity, Pi…) in plain language, and the agent runs `nrv`: *"what squads do I have?"*, *"use Nirvana to write the launch copy"*, *"stop that run"*, *"update Nirvana"*. This page is the reference underneath, for agents and for anyone who wants the direct commands.

Run `nrv help` for the live reference, and `nrv <subcommand> --help` for any command's full options.

```bash
nrv <subcommand> [args]
```

---

## First run

| Command | What it does |
|---|---|
| `nrv install --bootstrap` | Wire the audit hooks into Claude Code, Antigravity and Codex (the installer already does it; idempotent). `nrv setup` is the same repair. |
| `nrv install --check` | Report the hook and PATH wiring; exit 0 if ready, 1 if it needs setup. |
| `nrv install --repair-path` | Windows: list temporary `nrv-*` entries left on the user PATH (nothing written); `--apply` removes exactly those. |
| `nrv doctor` | Full system diagnostic: binaries and runtimes, skills links, hooks, dependencies, registries, pack licenses, and the `config` section with every setting's effective value and origin. Exit 0 healthy, 1 warnings only, 2 a `FAIL` line. |

## Configure

| Command | What it does |
|---|---|
| `nrv config list [--json]` | Every operational setting (multi-target, Gauntlet, runtime, routing, supervisor, updates, budget, quality gate) with its effective value, where it comes from (a variable, the project file, the global file, the engine file, the default) and its default. |
| `nrv config get <key>` / `nrv config explain <key>` | The effective value; `explain` adds the description, the default, the allowed scopes and the legacy variable. |
| `nrv config set <key> <value> [--global\|--project]` / `nrv config unset <key> [...]` | Writes `<project>/.nirvana/config.yaml` (the default inside a project) or `~/.nirvana/config.yaml` (kept across `nrv update`), one line at a time, comments preserved. Refuses a value the schema rejects, a scope the key does not accept, and a key pinned by a variable in this shell, each with the reason; every write audits `x_settings_changed`. |

Precedence, always: environment variable > `<project>/.nirvana/config.yaml` > `~/.nirvana/config.yaml` > the performance profile (`execution.profile`: `max`, `balanced`, `economy`) > the engine's `skills/harness/config.yaml` > the default. A profile moves effort, the workers' context ceiling, review, routing and the judge at once; a key set explicitly wins over it. What survives an update, and what to do when a value is not what you expect, is in [`docs/configuration.md`](configuration.md); the full key table, the variables that stay environment-only and the reasons are in [`docs/architecture/configuration.md`](architecture/configuration.md).

## Talk to it / run work

| Command | What it does |
|---|---|
| `nrv brief template` / `check <file>` / `decide <file> "<decision>"` | The six-section brief the orchestrator writes for one business (Request verbatim, Decisions, Your part, Inputs, Done when, Output). `check` validates it; `decide` adds a decision while the run is going, and the worker re-reads the brief at every phase. |
| `nrv dispatch <business> --brief-file <file> --exec` | Run a business on the brief, on the session's runtime unless `--runtime <rt>` names another. The business runs as one agent that plays its seats. Without `--exec` it refuses; `--scaffold-only` only prepares the run folder. Exit 0 delivered, 1 failed, 2 withheld, 3 indeterminate, 4 refused. |
| `nrv dispatch --business <slug> \| --squad <slug>[:<capabilityId>] \| --agent-x "<brief>" --exec` | Name the target yourself; the three flags are mutually exclusive with each other and with `--auto`, and none of them consults the router. `--squad` takes an optional capability id: without one the dispatch resolves the squad's capability from the brief. (`--judge-x` is the engine's Gauntlet judge, spawned by the evaluator adapter on an evaluation brief; it is not a producer.) |
| `nrv dispatch --auto "<brief>" --exec` | No target named: the router picks one, falling through to `agent-x`, the generalist. `nrv auto "<brief>"` is the same. |
| `nrv run <business> "<brief>"` | Dispatch + execute + verify + gate against a business you name (`--exec` implied). |
| `nrv cards squad <slug>` | The work card of an installed squad: what a business reads to use it. |
| `nrv revise <project> "<change>"` | Apply a change while keeping the same runtime session: a business run, a squad run or an agent-x run, resumed on the runtime that finished it. A route of several squads has no single session and is refused (exit 4). |
| `nrv launch <name> --pillars=brand,marketing,gtm` | Scaffold a multi-pillar 360° launch (default: all 11 pillars). |
| `nrv ask <clone> "<question>"` | Talk directly to a single specialist (mind-clone), DNA injected. |
| `nrv multi-target plan\|run\|status <plan.json>` | Multi-target engine by plan file (alias `nrv mt`): `plan` compiles the waves, `run` executes them over the Run Kernel (`nrv config set multi_target.enabled false` or `NIRVANA_MULTI_TARGET_KILL_SWITCH=1` turns it off), `status` reads the projection. |

Useful flags on `dispatch` / `run` / `auto`: `--project <YYYYMMDD>-<subject>-<part>` (the run's name; default `<YYYYMMDD>-<HHMM>-<target>`), `--review` / `--no-review` (ask for or decline the delivery review; otherwise `review.policy` decides), `--zip` / `--pdf` / `--html` (bundle the deliverables or build a report, only on request), `--runtime=claude-code|codex|antigravity-cli|pi|kimi-cli|grok-cli|qwen-code|opencode`, `--max-budget=<usd>` (only when the user named a number), `--timeout=<min>`, `--mode=agentic|cards` (how `--auto` routes), `--execution-mode=standard|gauntlet|auto` (default `standard`), `--gauntlet-intensity=light|balanced|exhaustive` (a Business target needs `NIRVANA_BUSINESS_GAUNTLET_ALLOWLIST=<slug>`), `--run-id=<runId>` (adopt a Run already prepared in the project's kernel, the way Glance does), `--safe` (restricted tools instead of the permission bypass Claude Code workers run with by default).

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
| `nrv find "<query>"` | Ranked candidates (businesses, squads with their capability ids) for a request, zero tokens. The orchestrator's shortlist; listed under QUALITY OF LIFE in `nrv help`. |
| `nrv search "<query>" [--kind=business\|squad\|mind-clone]` | Keyword + BM25 search across your libraries. |
| `nrv list-businesses` / `nrv list-squads` / `nrv list-clones` | List what's in your libraries (`--format=table\|json`). |
| `nrv inspect-clone <slug> [--commands\|--dna]` | Inspect a single specialist. |

## Projects

| Command | What it does |
|---|---|
| `nrv init <dir>` | Create a new Nirvana project. `--copy` (portable delivery), `--scope=project` (isolated). By default agents in the project work as they would without Nirvana and use it only when a request names it, asks for a business, a squad or a mind-clone, or asks for another runtime; `--orchestrators=always` makes Nirvana the orchestrator of every artifact. Rerunning init switches an existing project to the mode it is given. |
| `nrv resume <project>` | Resume an incomplete project from its audit log. |
| `nrv run-track stop <run-id\|project>` | Stop a run: end its dispatcher and worker and close it in the ledger, so the supervisor does not resume it. Killing the processes by hand leaves the run open. |
| `nrv export <project> [--format=zip\|tgz]` | Bundle a project's outputs to share. |
| `nrv clean <project> [--hard] [--force] [--dry-run]` | Remove a project scaffold (trash by default) and abandon the project's open runs in the ledger. A run still working there stops it (exit 4, with the command to end it); `--force` abandons it anyway without stopping its worker; `--dry-run` lists what it would close. |

A project is where a run's audit, briefs and deliverables live, for every runtime — including OpenClaw, whose agent must have the project as its workspace. How each one enters it: [docs/architecture/project-directory-and-runtimes.md](architecture/project-directory-and-runtimes.md).

## Libraries & distribution

| Command | What it does |
|---|---|
| `nrv install <source> [--dry-run\|--force\|--scope=project]` | Install a business / squad / mind-clone from a dir, tarball, http or git URL (auto-detects type). A paid pack installs with its own `setup.sh` / `setup.ps1`. |
| `nrv installed [--all] [--kind=...]` | List active installations. |
| `nrv uninstall <name>` / `--engine` / `--hooks` | Remove an installed asset; the engine (keeps `~/squads`, `~/businesses`, licenses and logs); or only the audit hooks. |
| `nrv pack create <dir>` / `inspect` / `publish` | Bundle and share assets (`.tgz` + sha256). |
| `nrv index` | Re-index squads + businesses after manual edits. |
| `nrv activate <slug>\|--all [--dry-run] [--confirm-heavy] [--only-declared] [--json] [--fix-with-agent[=<runtime>]]` | Install what a squad's `dependencies.yaml` declares. Node and Python packages go into the squad's own environment, `~/.nirvana/envs/<slug>/` (sub-apps under `subapps/<dir>/`, Python in `.venv`), with versions as declared. The squad folder only gets a best-effort `node_modules` link to the environment (never over a real folder, excluded through `.git/info/exclude`, not `.gitignore`); workers resolve packages through `NODE_PATH`, a Node ESM hook and an `npx` shim on `PATH`. Installs only when the declared specs changed, so an active squad costs milliseconds. A dispatch prepares the same environment on demand, so activation is optional for packages. `--all` walks the library one squad at a time. After a failure the output depends on who runs it: an agent session (detected by the same session markers routing uses) or a script gets a block between `=== nrv activate: issues for the agent ===` and its end marker, one entry per issue with the squad, the dependency, the useful error lines, the fix command, the `nrv activate <slug>` re-check and whether the fix needs the user's permission; `--json` prints the same data on stdout. Neither prompts, and the exit code is non-zero when something failed. A person at a terminal (stdin and stdout on a TTY, no agent marker) gets a summary and the offer to let an installed runtime fix the failures headless, scoped to them, after which those squads are checked again. `--fix-with-agent[=<runtime>]` runs that fix without asking, in any context (no value: the session's runtime, else the first installed). |
| `nrv deps [status] [--json]` | The squad environments (count and apparent size), the legacy shared store `~/.nirvana/node_modules` and venv when present (squads no longer install there), the pinned tool caches, and any dependency tree found outside them. `nrv deps install <pkg>` / `link <dir>` keep working on the shared store for engine and manual use. |

## Health & self-improvement

| Command | What it does |
|---|---|
| `nrv validate <kind> <slug\|path> [--fix] [--strict] [--json]` | Admission gate for one squad, business or mind-clone (`nrv verify` is an alias). |
| `nrv validate <kind> --all [--record [--allow-regression]]` | Verify every installed entity of a kind; `--record` writes the debt baseline. |
| `nrv validate --pack <content-dir> [--json]` | Verify a pack's content before it ships. |
| `nrv validate-chain <project> [--strict\|--all]` | Audit-chain integrity check. |
| `nrv migrate <slug\|path> --to 6 [--apply] [--all] [--map-refs]` | Convert a squad to Squad Protocol 6.0: canonical workflow documents, extension-less refs, acceptance from `success_indicators` (`nrv migrate-squad` is an alias). |
| `nrv migrate <slug\|path> --rollback <ts>` | Undo a conversion from its backup, while the squad has not changed since. |
| `nrv baseline [--days=N] [--save]` | Snapshot system KPIs from the audit log. |
| `nrv improver run [--days=N]` | Meta-Nirvana: mine the audit log and propose improvements. |
| `nrv update [--check]` | Update the engine. A release install moves along its channel and never to an older or equal version: a stable engine to the newest greater stable, a prerelease to the newest greater release, prerelease or stable. `--check` names the release it would install. `NIRVANA_ENGINE_URL` / `NIRVANA_ENGINE_TARBALL` pin the source. A git checkout at `~/nirvana-os` is pulled instead (`--branch=`, `--force`, `--skip-pull`). Before installing, backs up the deployed skills under `~/.nirvana/skills-backup-<stamp>/`; on Windows, directory links are preserved as junctions, and linked dependency stores are not copied into the backup. Afterwards it checks every installed pack that has a license. |
| `nrv update <pack> [--keep-clones\|--keep-squads\|--keep-businesses] [--check]` | Update an installed pack with its own license (`~/.nirvana-license/packs/<pack>/`, then the single `~/.nirvana-license/PROVENANCE.json`). A component you changed since the pack installed it is backed up under `~/.nirvana/backups/packs/<pack>/<stamp>/` before the overlay replaces it; `--keep-<kind>` leaves what is on disk as it is (new components still arrive). On a license error, download the pack again and run its setup. |
| `nrv license [status\|check\|install [<path>]\|activate] [--pack <slug>]` | Show a pack's provenance, install a `PROVENANCE.json`, activate a machine. |

> `nrv validate` exits `0` admitted · `1` an error the debt baseline does not cover · `2` only warnings, under `--strict` · `64` usage error or unknown entity. The system doctor moved to `nrv doctor`; `nrv validate` with no arguments still runs it, with a deprecation notice, for one release. Kind aliases: `biz`, `clone`, `mc`. Full contract: [docs/architecture/validate-gate.md](architecture/validate-gate.md).
>
> `nrv migrate` is dry run by default: it prints the report and writes nothing until `--apply`, and every applied run leaves a timestamped backup that `--rollback <ts>` restores. `--all` walks the whole squad library. Full contract: [SQUAD_PROTOCOL_V6.md](../skills/squads/SQUAD_PROTOCOL_V6.md) §35.

---

## A few real invocations

```bash
nrv doctor                                              # health check first
nrv auto "crie uma landing page para um SaaS de logística"   # the router picks the target
nrv run brand-creative-studio "Manifesto for a SaaS called Atlas"
nrv launch atlas --pillars=brand,marketing,gtm
nrv ask rory-sutherland "Critique this headline: ..."
nrv glance                                              # watch your organization work
nrv init ~/Projects/cliente-x --copy
```

> Every run writes a `trace_id` into an append-only audit log. Replay or verify any project with `nrv validate-chain <project> --strict`.
