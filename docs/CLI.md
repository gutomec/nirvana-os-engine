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
| `nrv doctor` | Full system diagnostic (binaries, skills, hooks, patches). |

## Talk to it / run work

| Command | What it does |
|---|---|
| `nrv auto "<brief>"` | **Autopilot.** The router picks the best company for your brief, executes it headless, verifies, and runs the quality gate. (= `run --auto`.) |
| `nrv run <business> "<brief>"` | Autopilot against a company you name: dispatch + execute + verify + gate. |
| `nrv dispatch <business> "<brief>"` | Scaffold a run (brief + DNA injection + audit) without auto-executing. |
| `nrv revise <project> "<change>"` | Apply a change while keeping the same runtime session. |
| `nrv launch <name> --pillars=brand,marketing,gtm` | Scaffold a multi-pillar 360° launch (default: all 11 pillars). |
| `nrv ask <clone> "<question>"` | Talk directly to a single specialist (mind-clone), DNA injected. |

Useful flags on `run` / `auto`: `--team` (real multi-employee orchestration), `--zip` / `--pdf` (bundle deliverables), `--runtime=claude-code|codex|gemini-cli|antigravity-cli`, `--max-budget=<usd>`, `--timeout=<min>`, `--mode=agentic|fast` (routing mode).

## See it happen

| Command | What it does |
|---|---|
| `nrv glance [--allow-actions]` | Open the **Glance** web cockpit: live runs, the capability graph, and the audit trail of everything your organization is doing. |
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
| `nrv install <source> [--dry-run\|--force\|--scope=project\|--accept-external-apps=DIGEST\|--decline-external-apps]` | Install a business / squad / mind-clone / pack from a dir, tarball, http or git URL (auto-detects type). |
| `nrv installed [--all] [--kind=...]` | List active installations. |
| `nrv uninstall <name>` | Remove an installed asset. |
| `nrv pack create <dir>` / `inspect` / `publish` | Bundle and share assets (`.tgz` + sha256). |
| `nrv index` | Re-index squads + businesses after manual edits. |

When a pack contains squads with `external_apps` in `dependencies.yaml`, installation aggregates and deduplicates those declarations with declarations from already-installed `required_squads`. `presence_check` and optional `compatibility.check` may be one executable-plus-argv command for all declared platforms or a complete map keyed by the entries in `platforms`. Platform-specific maps are useful when package managers or application paths differ between Windows and macOS. Missing, undeclared, and unknown platform keys are rejected, and nested commands have the same strict validation as legacy commands.

Run `nrv install <pack> --dry-run --json` to inspect the canonical plan digest plus each application's name, license, source, homepage, permissions, compatibility checks, and current-platform install argv without running any declared command. Only the current platform's effective checks and installer enter that platform's consent plan. With no decision, an optional-only plan runs no external command and installs the parent pack with named capabilities degraded; a plan containing a required application exits with code 2 before copying pack assets. Accept exactly that immutable plan with `--accept-external-apps=sha256:...`, or use `--decline-external-apps`. Declining optional applications installs the parent pack degraded, while declining a required application blocks the pack. To enable a deferred application after the pack exists, generate a fresh digest with `--force --dry-run`, then rerun with `--force --accept-external-apps=<digest>`. Accepted execution checks every application before installing required applications ahead of optional ones. External installer effects are reported and are not part of the pack asset rollback; a failed asset copy removes its partial destination and restores any `--force` backup.

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
nrv glance --allow-actions                              # watch your organization work
nrv init ~/Projects/cliente-x --copy
```

> Every run writes a `trace_id` into an append-only audit log. Replay or verify any project with `nrv validate-chain <project> --strict`.
