<div align="center">

<img src="./docs/assets/banner-week1.png" alt="Nirvana-OS banner: many agent nodes converging into one orchestrated core" width="100%">

# Nirvana-OS

**You give one sentence. An AI conglomerate delivers finished work, with a receipt for every step.**

[![version](https://img.shields.io/badge/version-0.7.11-blue)](./CHANGELOG.md)
[![CI](https://github.com/gutomec/nirvana-os-engine/actions/workflows/smoke.yml/badge.svg)](https://github.com/gutomec/nirvana-os-engine/actions/workflows/smoke.yml)
[![license](https://img.shields.io/badge/license-SUL-lightgrey)](./LICENSE)
[![npm](https://img.shields.io/badge/npm-%40nirvana--os%2Fcli-cb3837)](https://www.npmjs.com/package/@nirvana-os/cli)
[![stars](https://img.shields.io/github/stars/gutomec/nirvana-os-engine?style=social)](https://github.com/gutomec/nirvana-os-engine/stargazers)

```bash
npx @nirvana-os/cli
```

One command installs the engine and links it into every terminal agent it finds. Safe to run again any time.

[Documentation](https://gutomec.github.io/nirvana-os-engine/) · [Packs on squads.sh](https://squads.sh/pt/nirvana-os) · [Illustrated install](https://gutomec.github.io/nirvana-os-engine/install.html) · [Changelog](./CHANGELOG.md)

**Read this in your language:** [English](./README.md) · [Português](./README.pt-BR.md) · [Español](./README.es.md) · [中文](./README.zh.md) · [हिन्दी](./README.hi.md) · [العربية](./README.ar.md)

</div>

---

## Your agent is sharp. It is also alone.

You already run a terminal agent: Claude Code, Codex, Gemini-CLI, or Antigravity. One prompt gets one good answer. Real work is not one prompt. It is a researcher, a writer, a reviewer, and an operator pulling in the same direction, in parallel, with a paper trail. Today, you are the glue.

Nirvana-OS promotes your single agent into a maestro that runs whole organizations. You describe the outcome in plain prose. The engine reads the brief, consults what you own, dispatches companies, squads, and mind-clones in parallel, reconciles everything behind a quality gate, and writes an audit trail of every dispatch. You stop being the operator and become the director.

The whole interface is prose plus a receipt. You talk, your agent runs the commands.

## What it is

Nirvana-OS is a Bun-native, runtime-agnostic multi-agent operating system. It creates, manages, and administers a conglomerate: any number of companies and squads, orchestrated from brief to verified deliverable. It is the orchestration layer above your terminal agent, not a replacement for it. Everything it creates is one of three things:

| Pillar | What it is | Where it lives |
|---|---|---|
| **Companies (businesses)** | Autonomous organizations with an org chart of persistent employees who call squads | `~/businesses/` |
| **Squads** | Portable agent teams that run real workflows: DAG, quality gates, escalation | `~/squads/` |
| **Mind-clones** | Persona DNA in 5 layers, injected into employees so they think and speak with a master's method | `~/businesses/_library/dna/` |

A company orchestrates employees. An employee calls squads. A squad runs agents. A mind-clone gives any of them a truer voice. One brief can mobilize many of them at once, and the orchestrator picks the cast.

## Quickstart: 60 seconds to a working engine

What you need: [Bun](https://bun.sh) 1.0 or newer. Node 18+ and `tar` exist only so `npx` works, and most machines already have them.

```bash
# macOS / Linux
curl -fsSL https://bun.sh/install | bash
exec $SHELL
npx @nirvana-os/cli

# Windows (native, no WSL), in PowerShell
powershell -c "irm bun.sh/install.ps1 | iex"
# open a NEW PowerShell window so PATH refreshes
npx @nirvana-os/cli
```

The installer places a single skills tree at `~/.nirvana/skills`, links it into `~/.claude`, `~/.codex`, `~/.gemini`, and `~/.antigravity` wherever it finds them, and puts the `nrv` binaries on your PATH. It installs the engine and no content: your registries start empty by design, so everything in them is something you built or chose to install. Re-running the installer is idempotent and always pulls the latest engine.

Confirm the install is healthy:

```bash
nrv doctor
```

Then open your agent and say **"use Nirvana-OS to…"**. For agent-driven setup, point your runtime at [`AGENT-QUICKSTART.md`](./AGENT-QUICKSTART.md).

## See it work: everything is a sentence

**Build a company by describing it.** The system designs the org, writes every employee, wires the workflows, and validates the result against the Business Protocol.

```text
Use Nirvana-OS to create a company called podcast-empire that produces, publishes,
and monetizes 3 podcasts at once. Each show has its own niche, an AI host, an
editorial calendar, and an independent monetization funnel. Around 7 employees.
```

**Clone an expert in prose.** The genius factory extracts a 5-layer DNA (philosophies, mental models, heuristics, frameworks, methodologies) from a person's public body of work, every item cited back to its source.

```text
Use Nirvana-OS to turn the public work of <author> into a complete AI mind-clone
through the genius factory.
```

**One sentence, many teams at once.** A single brief can pull a research squad, a copy squad, and a design company in parallel, reconciled behind one quality gate, with the audit trail showing every choice the maestro made.

```text
Use Nirvana-OS to produce a launch package: market research, landing-page copy,
and a competitive teardown.
```

More flows, including "design the agency, clone the specialists, build it" in three questions, are in the [documentation home](https://gutomec.github.io/nirvana-os-engine/), which runs the same sentence across all seven supported runtimes: Claude Code, Codex, Gemini, Antigravity, Grok, Kimi, and Hermes.

<div align="center">
  <img src="./docs/assets/nirvana-promo-en-readme.gif" alt="One prose order in, a whole AI conglomerate assembles and delivers" width="100%">
</div>

<!-- DEMO-90s SLOT
     Canonical 90-second demo goes here when published.
     1. Upload the demo to YouTube (script and storyboard: trace 75fbfbcc, phase X3).
     2. Replace this comment block with the embed or a linked thumbnail:
        <a href="VIDEO_URL"><img src="THUMBNAIL_URL" alt="Nirvana-OS in 90 seconds" width="100%"></a>
-->

## Why "the work is done" means something here

Multi-agent systems have a trust problem: an orchestrator can announce anything in its final message. Nirvana-OS answers with three guarantees, each backed by a mechanism you can open on disk.

- **Traceable.** Every action becomes an append-only event in `~/.harness-logs/<date>/audit.jsonl`: brief received, dispatch, mind-clone injected, gate passed or failed. Without these events, no completion message is honest.
- **Tested.** `verify-deliverable.ts` compares what the brief promised against what actually exists on disk. `quality-gate.ts` runs rubrics per file type in a judge, critique, and revise loop. No verify PASS, no legitimate completion.
- **Contracted.** Tasks have binary acceptance criteria. Capabilities have typed inputs and outputs. Client-bound output passes an approval chain: producer, then reviewer, then approver. Budgets are a hard ceiling, and escalation triggers define exactly when a human enters the loop.

## Free engine, paid content

The engine in this repo is free, with no crippled tier and nothing basic locked away. It creates and orchestrates companies, squads, and mind-clones from zero. The source is published and openly readable under the [Sustainable Use License](./LICENSE) (source-available, not OSI-approved; certain commercial uses require a separate license).

The paid layer is **content, not capability**: curated, ready-to-run collections delivered through [squads.sh](https://squads.sh). The difference the packs buy you is time, not power. The flagship, **Genesis Circle**, lands 39 production squads, 11 companies, and 159 mind-clones in one install, current with `nrv update <pack>`.

| | Free engine (this repo) | Packs ([squads.sh](https://squads.sh/pt/nirvana-os)) |
|---|---|---|
| Create from scratch | Yes | Yes |
| Orchestrate in parallel | Yes | Yes |
| Audit trail on every dispatch | Yes | Yes |
| Pre-built squads, companies, mind-clones | None, empty by design | A full conglomerate, day one |

## The handful of commands worth typing yourself

| You type | What it does |
|---|---|
| `npx @nirvana-os/cli` | Install or update the engine (idempotent) |
| `nrv glance` | Read-only web cockpit: companies, squads, clones, audit, costs |
| `nrv list-businesses` / `nrv list-squads` / `nrv list-clones` | Browse the three registries |
| `nrv search "<topic>"` | Find capabilities across all three registries |
| `nrv update <pack>` | Update an installed pack |
| `nrv doctor` | Check the installation |

Everything else, your agent runs. Full reference: [docs/CLI.md](./docs/CLI.md).

## FAQ

**Do I need to know how to code?** No. You describe outcomes in plain language; the system writes, validates, and runs the code.

**Does it replace my agent?** No. It runs on top of Claude Code, Codex, Gemini-CLI, or Antigravity, and makes the one you have orchestrate many.

**Where does my work live?** On your machine, under `~/businesses`, `~/squads`, and `~/businesses/_library/dna`. Local-first, with no third-party cloud in the loop.

**What if the system can't do what I ask?** It says so. A brief that matches nothing gets a refusal plus a suggestion to create the missing capability. An ambiguous brief gets a question back, with the top candidates.

**Windows?** Native, through Bun. No WSL required.

## License, authorship, and status

Author: **Luiz Gustavo Vieira Rodrigues (gutomec / Prospecteezy)**. No co-authors.

License: the Nirvana-OS Sustainable Use License (SUL) v1.0. The source is published and openly readable, and the engine is free to use. It is source-available, not an OSI-approved open-source license, and certain commercial uses require a separate commercial license. Read [LICENSE](./LICENSE) before relying on any summary, including this one.

Status: beta (0.x, currently 0.7.11). The engine works today and installs in minutes. Expect the surface to keep moving until 1.0.
