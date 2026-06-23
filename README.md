# Nirvana-OS engine

[![version](https://img.shields.io/badge/version-0.1.21--beta-blue)](#license-authorship-and-status)
[![license](https://img.shields.io/badge/license-SUL-lightgrey)](./LICENSE)
[![npm](https://img.shields.io/badge/npm-%40nirvana--os%2Fcli-cb3837)](https://www.npmjs.com/package/@nirvana-os/cli)

**Nirvana-OS is a Bun-native, runtime-agnostic operating system for multi-agent work.** This repository is its open-core engine. One `npx` turns the terminal agent you already use into a maestro that can create and orchestrate businesses, squads, and mind-clones, mobilize many of them in parallel for a single brief, and write an audit trail of every dispatch.

```bash
npx @nirvana-os/cli
```

That command installs the engine, links it into every agent runtime it finds, and is safe to run again any time. Nothing else to configure.

## What it is

Nirvana-OS is the orchestration layer above terminal agents. Claude Code, Codex, Gemini-CLI, Antigravity, and Hermes are runtimes. Nirvana-OS is the OS that runs on top of whichever one you already have.

This repo, `nirvana-os-engine`, installs the skills and nothing else. It ships empty on purpose: zero businesses, zero production squads, zero mind-clones. You get the motor, not the cargo. From minute one it creates and orchestrates three kinds of thing:

- **Businesses** — autonomous multi-agent organizations, each with its own org chart of employees.
- **Squads** — portable teams of agents that run workflows with DAGs, gates, and escalation.
- **Mind-clones** — persona DNA injected into employees for fidelity of voice and judgment.

## The problem and the vision

A terminal agent is a sharp tool. Point it at a task and it answers. Point it at *real* work, the kind that needs a researcher, a writer, a reviewer, and an operator pulling in different directions, and a single agent starts to strain. You end up running prompt after prompt by hand, stitching the outputs together yourself, with no record of who did what or why.

Real work is not one prompt. It is many specialized agents, coordinated, in parallel, with a paper trail.

That is the layer Nirvana-OS adds. You describe the outcome. The engine consults what you have, dispatches the right combination of businesses and squads, runs them at the same time, reconciles the output behind a quality gate, and writes down every dispatch. You stop being the integration glue. You become the person who states the goal and inspects the result. You get a conductor, not another soloist.

## Quickstart

Three steps take you from nothing to a real orchestrated dispatch.

**1. Install the engine.**

```bash
npx @nirvana-os/cli
```

The engine lands in `~/.nirvana/skills` and links into each runtime detected on your machine: Claude Code always, Codex / Gemini-CLI / Antigravity when present, Hermes through an opt-in bridge. The launcher handles Bun for you. Re-running is idempotent and pulls the latest release.

**2. Look around with `nrv`.**

The discovery commands are read-only and safe to run anytime.

```bash
nrv glance            # one-screen overview of what you have
nrv list-businesses   # organizations registered locally
nrv list-squads       # the agent teams
nrv list-clones       # persona DNA available to inject
nrv search "launch"   # find capabilities across all three registries
```

A fresh engine returns empty here, which is the point. The factory is installed; the cargo is not.

**3. Run your first brief.**

Bootstrap a project to work inside, then hand the maestro a brief from your terminal agent. Describe the outcome, not the steps.

```bash
nrv init ~/my-project
```

```text
Use Nirvana-OS to produce a launch package: market research,
landing-page copy, and a competitive teardown.
```

The harness reads the brief, consults the registries, dispatches the best combination across whatever businesses and squads fit, runs them in parallel, reconciles the results behind a quality gate, and writes the trail to `~/.harness-logs/<date>/audit.jsonl`. Open that file and you can read exactly what ran.

## The three pillars

Everything the engine creates and orchestrates is one of three things. This is the whole mental model.

| Pillar | What it is | Where it lives |
|---|---|---|
| **Businesses** | Autonomous multi-agent organizations, each with an org chart of employees | `~/businesses/` |
| **Squads** | Portable agent teams that run workflows (DAG, gates, escalation) | `~/squads/` |
| **Mind-clones** | Persona DNA injected into employees for voice and judgment fidelity | `~/businesses/_library/dna/` |

A business orchestrates employees. An employee calls squads. A squad runs agents. A mind-clone gives any of them a truer voice. A single brief rarely needs just one: "produce a launch package" might pull a research squad, a copy squad, and a design business at once, each staffed by employees carrying the right mind-clones. Assembling that cast is what the next section does for you.

## How it works

The harness is the maestro. Give it a brief and it does five things, in order:

1. Reads the brief.
2. Consults the three registries: businesses, squads, mind-clones.
3. Dispatches the best combination, which can be many businesses and/or many squads running in parallel.
4. Reconciles the results behind a quality gate.
5. Writes an audit trail to `~/.harness-logs/<date>/audit.jsonl`.

```
                       brief
                         │
                         ▼
                ┌───────────────────┐
                │ harness (maestro) │
                │ read · route ·    │
                │ dispatch          │
                └───────────────────┘
                         │
        consults the three registries
       (businesses · squads · mind-clones)
                         │
        ┌────────────────┼────────────────┐
        ▼                ▼                 ▼
 ┌────────────┐   ┌────────────┐    ┌──────────────┐
 │ business A │   │  squad X   │    │  mind-clones │
 │ employees  │   │  workflow  │◀───│  injected as │
 │  → squads  │   │  DAG·gates │    │  persona DNA │
 └────────────┘   └────────────┘    └──────────────┘
        │                │
        └───── parallel dispatch ──────┘
                         │
                         ▼
                ┌───────────────────┐
                │   quality gate    │
                │ reconcile output  │
                └───────────────────┘
                         │
            ┌────────────┴────────────┐
            ▼                         ▼
       final result        ~/.harness-logs/<date>/audit.jsonl
                            (every dispatch, on the record)
```

The parallelism is the wedge. One brief can put several businesses and squads to work in the same run and reunite their output at the end. The audit trail is the trust. Each dispatch leaves a JSONL record, so agentic work is never a black box: open the log and trace which agents ran, on which brief, in what order, and why.

## Multi-runtime

One skills tree in `~/.nirvana/skills`, linked into each runtime the installer detects. Nirvana-OS does not ask you to switch agents. It upgrades the one you have.

| Runtime | Status | How it links |
|---|---|---|
| Claude Code | Always linked | Detected and linked on install |
| Codex | Linked if present | Detected and linked automatically |
| Gemini-CLI | Linked if present | Detected and linked automatically |
| Antigravity (`agy`) | Linked if present | Detected and linked automatically |
| Hermes | Opt-in | Connected through a bridge you enable |

Install once. It shows up wherever you already work.

## Open core: free engine, paid content

The engine in this repo is free and stays free. No crippled tier, no basics locked behind a paywall. It creates and orchestrates businesses, squads, and mind-clones from zero, with no gates and no asterisk. If you want to build your own conglomerate, the engine is all you ever need and you owe nothing.

The paid layer is content, not capability: licensed collections of ready squads, businesses, and mind-clones, delivered through [squads.sh](https://squads.sh).

| | Free engine (this repo) | Paid packs (via squads.sh) |
|---|---|---|
| Create from scratch | Yes | Yes |
| Orchestrate in parallel | Yes | Yes |
| Audit trail on every dispatch | Yes | Yes |
| Multi-runtime install | Yes | Yes |
| Pre-built squads, businesses, mind-clones | None, empty by design | A full conglomerate, ready to run |
| Time to a working conglomerate | You build it | Day one |

The engine alone builds from scratch. The packs hand you an entire conglomerate ready on day one. That is a difference of time, not capability.

**Genesis Circle** is the founder pack: squads, businesses, and mind-clones built for production. A pack installs over the engine: buy it on squads.sh, run `bun setup.ts` (it ensures the engine via `npx @nirvana-os/cli`, then overlays the content with `nrv install-content`), and keep it current with `nrv update <slug>`. Want the head start? [Get Genesis Circle on squads.sh](https://squads.sh).

## `nrv` commands

| Command | What it does |
|---|---|
| `nrv glance` | One-screen overview of your local setup |
| `nrv list-businesses` | List registered businesses (read-only) |
| `nrv list-squads` | List registered squads (read-only) |
| `nrv list-clones` | List available mind-clones (read-only) |
| `nrv search "<topic>"` | Search capabilities across all three registries |
| `nrv init <path>` | Bootstrap a new project |
| `nrv update <slug>` | Update an installed pack to its latest version |
| `nrv --help` | Full command reference |

Full reference: [docs/CLI.md](./docs/CLI.md).

## Concepts and architecture

A few ideas hold the whole system together.

- **Three registries.** Discovery and dispatch read from the same three registries (businesses, squads, mind-clones). The harness routes against them to decide what to mobilize; `nrv search` and `nrv glance` browse them. One source of truth, two uses.
- **The audit trail.** Each orchestration appends to `~/.harness-logs/<date>/audit.jsonl`, an append-only record of every dispatch. When you want to know what the system did, you read the trail, not a dashboard.
- **Idempotent install and update.** Re-running `npx @nirvana-os/cli` converges on the latest engine without breaking what you already have, and `nrv update <slug>` does the same for an installed pack.

For installation detail, see [INSTALL.md](./INSTALL.md). To contribute, see [CONTRIBUTING.md](./CONTRIBUTING.md).

## License, authorship, and status

Author: **Luiz Gustavo Vieira Rodrigues (Prospecteezy)**. No co-authors.

License: the Nirvana-OS Sustainable Use License (SUL). The source is published openly and source-available; it is not an OSI-approved open-source license, and certain commercial uses require a separate commercial license. Read the full terms in [LICENSE](./LICENSE) before relying on any summary.

Status: beta (0.x). The engine works today and installs in minutes. Expect the surface to keep moving until 1.0.
