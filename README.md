# Nirvana-OS engine

[![version](https://img.shields.io/badge/version-0.1.24--beta-blue)](#license-authorship-and-status)
[![license](https://img.shields.io/badge/license-SUL-lightgrey)](./LICENSE)
[![npm](https://img.shields.io/badge/npm-%40nirvana--os%2Fcli-cb3837)](https://www.npmjs.com/package/@nirvana-os/cli)

**Read this in your language:** [English](./README.md) · [Português](./README.pt-BR.md) · [Español](./README.es.md) · [中文](./README.zh.md) · [हिन्दी](./README.hi.md) · [العربية](./README.ar.md)

---

## Command a universe of companies in plain language

You already have a terminal agent. Claude Code, Codex, Gemini-CLI, or Antigravity. It is sharp, and it is alone.

Nirvana-OS turns that single agent into a maestro that runs **whole companies**. You describe what you want in plain prose, and the system stands up the organizations, the specialist teams, and the expert minds to deliver it, many of them at once, with a receipt for every step.

```bash
npx @nirvana-os/cli
```

One command. It installs the engine, links into every agent runtime it finds, and is safe to run again any time. Nothing else to configure.

## You don't need another chatbot. You need an organization that does the work.

A single agent answers a prompt. Real work is not one prompt. It is a researcher, a writer, a reviewer, and an operator pulling in different directions, coordinated, with a paper trail. Today you are the glue: you run prompt after prompt by hand and stitch the pieces together yourself, with no record of who did what.

Nirvana-OS removes you from the glue. You state the outcome in prose. The engine reads it, consults what you have, dispatches the right combination of companies and squads, runs them in parallel, reconciles the result behind a quality gate, and writes down every dispatch. You go from operator to director: you state the goal and inspect the result.

## What it is, in one breath

Nirvana-OS is the orchestration layer **above** terminal agents. It creates and runs three kinds of thing, and it does all of it from natural language:

- **Companies (businesses)** — autonomous organizations with an org chart of employees. Each employee calls squads.
- **Squads** — portable teams of agents that run real workflows (DAG, gates, escalation) and ship finished deliverables.
- **Mind-clones** — persona DNA (5 layers) injected into employees so they think and speak with a master's method.

One request can mobilize many of them at the same time. The orchestrator (the `harness`) picks the cast. You just describe the outcome.

## See it work: everything is a sentence

This is the part that matters. You do not write code, fill in forms, or edit config. You talk to the system, inside the AI runtime you already use, by naming it: **"use Nirvana-OS to…"**. Here is what that looks like.

### 1. Build a company by describing it

Give it the hierarchy and the roles in prose. It designs the org, writes every employee, wires the workflows, and validates the result.

```text
Use Nirvana-OS to create a company called podcast-empire that produces, publishes,
and monetizes 3 podcasts at once. Each show has its own niche, an AI host, an
editorial calendar, and an independent monetization funnel. Around 7 employees.
```

The system runs its business factory: intent reading, domain research, an org blueprint you approve, then employees, memory, and workflows, validated against the Business Protocol. You end up with `~/businesses/podcast-empire/`, staffed and ready to run.

### 2. Or let the system design the company for you

Don't know the right structure yet? Ask. This is the flow most people fall in love with.

**Step one, ask for the design:**

```text
Use Nirvana-OS: how would a complete, modern marketing agency be structured?
Give me the hierarchy, the key roles, and who the best specialists in the world
are for each seat.
```

The system answers with a real org chart: a creative director, a head of performance, a copy chief, a content lead, a strategist, and the names of the operators whose methods each seat should embody.

**Step two, clone those specialists:**

```text
Great. Clone those specialists into mind-clones I can hire.
```

It runs the mind-clone factory and produces persona DNA for each one, the thinking, heuristics, and voice of that kind of operator.

**Step three, build the company with them in the seats:**

```text
Now build the agency, and put those clones in the matching roles as the
brains of each employee.
```

It assembles the business, assigns each mind-clone to the right employee, and creates any specialist squad the agency needs but doesn't have yet. You asked three questions in plain English and got a staffed company.

### 3. Create a specialist squad in prose

When a company needs a capability no existing team covers, describe the team you want.

```text
Use Nirvana-OS to generate a squad for headless e-commerce automation, with
agents for catalog, checkout, inventory, and support. Validate it against the
Squad Protocol.
```

Out comes `~/squads/…/` with agents, tasks, workflows, schemas, a harness config, and a README, all validated.

### 4. Clone an expert in prose

Turn anyone's public body of work into an advisor your employees can use.

```text
Use Nirvana-OS to turn the public work of <author> into a complete AI mind-clone
through the genius factory.
```

The factory extracts a 5-layer DNA (philosophies, mental models, heuristics, frameworks, methodologies), builds the persona, runs it through a panel of other minds, and delivers an advisor you can drop into any company.

### 5. One sentence, many teams at once

The orchestrator is happy to mobilize several companies and squads from a single brief.

```text
Use Nirvana-OS to produce a launch package: market research, landing-page copy,
and a competitive teardown.
```

That one line can pull a research squad, a copy squad, and a design company in parallel, each staffed by employees carrying the right mind-clones, reconciled behind a single quality gate. You can also force a lane from the CLI: `nrv use-businesses "…"` or `nrv use-squads "…"`.

> The whole interface is prose plus a receipt. No API calls, no config files. Just describe the outcome and read the audit trail that proves what happened.

## Install in 60 seconds

Same idea on every OS: install Bun once, then run one command. You also need Node.js for `npx` (most machines already have it; if not, [nodejs.org](https://nodejs.org)).

### macOS / Linux

```bash
curl -fsSL https://bun.sh/install | bash
exec $SHELL                # reload PATH, or just open a new terminal
npx @nirvana-os/cli        # installs the engine
```

### Windows (native, no WSL)

The whole system runs on Bun, so Windows needs only Bun. In **PowerShell**:

```powershell
powershell -c "irm bun.sh/install.ps1 | iex"
# open a NEW PowerShell window so PATH refreshes
npx @nirvana-os/cli
```

The installer drops the `nrv` command in `~/.local/bin` (`%USERPROFILE%\.local\bin` on Windows) and adds it to your PATH automatically. Open a new terminal and confirm:

```bash
nrv --help
```

Re-running `npx @nirvana-os/cli` is idempotent and always pulls the latest engine.

## Look around with `nrv`

The discovery commands are read-only and safe anytime.

```bash
nrv glance            # one-screen overview of what you have
nrv list-businesses   # organizations registered locally
nrv list-squads       # the agent teams
nrv list-clones       # persona DNA available to inject
nrv search "launch"   # find capabilities across all three registries
```

A fresh engine returns empty here, and that is the point. The factory is installed; the cargo is not.

## The three pillars

Everything the engine creates and orchestrates is one of three things. This is the entire mental model.

| Pillar | What it is | Where it lives |
|---|---|---|
| **Companies** | Autonomous organizations, each with an org chart of employees | `~/businesses/` |
| **Squads** | Portable agent teams that run workflows (DAG, gates, escalation) | `~/squads/` |
| **Mind-clones** | Persona DNA injected into employees for voice and judgment | `~/businesses/_library/dna/` |

A company orchestrates employees. An employee calls squads. A squad runs agents. A mind-clone gives any of them a truer voice. A single brief rarely needs just one.

## You can make more of everything: the meta-tools

The engine ships three factories, and they call each other. This is how a company you asked for in one sentence ends up complete.

- **Business Creator** turns a prose brief into a full organization: employees, memory, workflows, validated end to end. When it needs a capability no squad covers, it delegates to the Squad Creator.
- **Squad Creator** turns a prose brief into a validated squad: agents, tasks, workflows, schemas, harness config, README.
- **Genius Factory** turns a person's public work into a mind-clone through a 5-stage pipeline, then hands you an advisor ready to hire.

Meta-tools calling meta-tools is why "design the agency, clone the specialists, build it" works as three plain sentences.

## How it works

Give the harness a brief and it does five things, in order:

1. Reads the brief.
2. Consults the three registries: companies, squads, mind-clones.
3. Dispatches the best combination, which can be many companies and/or squads in parallel.
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
       (companies · squads · mind-clones)
                         │
        ┌────────────────┼────────────────┐
        ▼                ▼                 ▼
 ┌────────────┐   ┌────────────┐    ┌──────────────┐
 │  company A │   │  squad X   │    │  mind-clones │
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

Parallelism is the wedge: one brief can put several teams to work in the same run and reunite their output at the end. The audit trail is the trust: open the log and trace which agents ran, on which brief, in what order, and why. Agentic work stops being a black box.

## One install, every runtime

There is one skills tree in `~/.nirvana/skills`, linked into each runtime the installer detects. Nirvana-OS does not ask you to switch agents. It upgrades the one you have.

| Runtime | Status |
|---|---|
| Claude Code | Always linked |
| Codex | Linked if present |
| Gemini-CLI | Linked if present |
| Antigravity (`agy`) | Linked if present |
| Hermes | Opt-in bridge |

## Open core: the engine is free, and stays free

The engine in this repo is free, with no crippled tier and nothing basic locked away. It creates and orchestrates companies, squads, and mind-clones from zero. If you want to build your own conglomerate from scratch, the engine is all you ever need and you owe nothing.

The paid layer is **content, not capability**: curated, ready-to-run collections of squads, companies, and mind-clones, delivered through [squads.sh](https://squads.sh).

| | Free engine (this repo) | Paid packs (squads.sh) |
|---|---|---|
| Create from scratch | Yes | Yes |
| Orchestrate in parallel | Yes | Yes |
| Audit trail on every dispatch | Yes | Yes |
| Multi-runtime install | Yes | Yes |
| Pre-built squads, companies, mind-clones | None, empty by design | A full conglomerate, ready to run |
| Time to a working conglomerate | You build it | Day one |

The difference the packs buy you is **time, not power**. The flagship, **Genesis Circle**, lands 39 production squads, 11 companies, and 159 mind-clones in one install. A pack overlays the engine: buy it, run `bun setup.ts`, keep it current with `nrv update <slug>`. [See the packs on squads.sh](https://squads.sh).

## `nrv` commands

| Command | What it does |
|---|---|
| `nrv route "<brief>"` | Hand the maestro a brief in prose |
| `nrv use-businesses "<brief>"` | Route a brief, company-first |
| `nrv use-squads "<brief>"` | Route a brief, squad-first |
| `nrv glance` | One-screen overview of your setup |
| `nrv list-businesses` / `list-squads` / `list-clones` | Browse the registries (read-only) |
| `nrv search "<topic>"` | Search capabilities across all three registries |
| `nrv init <path>` | Bootstrap a new project |
| `nrv update <slug>` | Update an installed pack |
| `nrv --help` | Full command reference |

Full reference: [docs/CLI.md](./docs/CLI.md).

## FAQ

**Do I need to know how to code?** No. You describe outcomes in plain language. The system writes, validates, and runs the code.

**Does it replace my agent?** No. It runs on top of Claude Code, Codex, Gemini-CLI, or Antigravity, and makes the one you have orchestrate many.

**Where does my work live?** On your machine, under `~/businesses`, `~/squads`, and `~/businesses/_library/dna`. Local-first, with no third-party cloud in the loop.

**Is the engine really free?** Yes. The paid packs are pre-built content that saves you time. The engine builds the same things from scratch at no cost.

**Windows?** Native, through Bun. No WSL required.

## License, authorship, and status

Author: **Luiz Gustavo Vieira Rodrigues (Prospecteezy)**. No co-authors.

License: the Nirvana-OS Sustainable Use License (SUL). The source is published openly and source-available. It is not an OSI-approved open-source license, and certain commercial uses require a separate commercial license. Read the full terms in [LICENSE](./LICENSE) before relying on any summary.

Status: beta (0.x). The engine works today and installs in minutes. Expect the surface to keep moving until 1.0.
