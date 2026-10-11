<div align="center">

<img src="./docs/assets/banner-week1.png" alt="Nirvana-OS: one sentence in, finished work out. Parallel agent workflows converge through quality gates." width="100%">

# Nirvana-OS

**Ready-to-run agentic operations.** One sentence in. Finished work out.

[![GitHub stars](https://img.shields.io/github/stars/gutomec/nirvana-os-engine)](https://github.com/gutomec/nirvana-os-engine/stargazers)
[![version](https://img.shields.io/github/v/release/gutomec/nirvana-os-engine?label=version)](./CHANGELOG.md)
[![CI](https://github.com/gutomec/nirvana-os-engine/actions/workflows/smoke.yml/badge.svg)](https://github.com/gutomec/nirvana-os-engine/actions/workflows/smoke.yml)
[![license](https://img.shields.io/badge/license-SUL-lightgrey)](./LICENSE)

**macOS / Linux**

```bash
curl -fsSL https://gutomec.github.io/nirvana-os-engine/install.sh | bash
```

**Windows (PowerShell)**

```powershell
irm https://gutomec.github.io/nirvana-os-engine/install.ps1 | iex
```

[Documentation](https://gutomec.github.io/nirvana-os-engine/) · [Packs](https://squads.sh/pt/packs) · [Illustrated install](https://gutomec.github.io/nirvana-os-engine/install.html) · [Changelog](./CHANGELOG.md)

**Read this in your language:** [English](./README.md) · [Português](./README.pt-BR.md) · [Español](./README.es.md) · [中文](./README.zh.md) · [हिन्दी](./README.hi.md) · [العربية](./README.ar.md)

</div>

---

## You talk to your agent. Your agent runs Nirvana.

You already work with a terminal agent: Claude Code, Codex, Antigravity, Pi, Grok or another. One prompt gets one good answer. Real work takes a researcher, a writer, a reviewer and an operator, with a record of who did what.

Nirvana-OS gives your agent that organization. You ask in plain language, and the agent uses Nirvana to pick the right businesses, squads and mind-clones, dispatch them, check what comes back and show you the receipt. You do not learn a new interface and you do not type commands day to day. The commands further down are the reference your agent uses, and they are there for you when you want them.

## What it is

Nirvana-OS is a Bun-native, runtime-agnostic multi-agent system. It runs on top of the agent you already use and never replaces it. It works with three kinds of content, all of them folders on your machine:

| Pillar | What it is | Where it lives |
|---|---|---|
| **Businesses** | Organizations with an org chart. A dispatched business runs as one agent that plays its seats, uses squads through their cards and channels mind-clones | `~/businesses/` |
| **Squads** | Portable agent teams with agents, tasks and workflows the dispatched agent follows as its method | `~/squads/` |
| **Mind-clones** | Persona DNA in five layers, so an agent thinks and writes with a specific expert's method | `~/businesses/_library/dna/` |

The engine ships with no content. You create businesses, squads and clones by asking your agent, or you install a pack from [squads.sh](https://squads.sh/pt/packs).

## Install

Run the one-liner at the top of this page. It needs `curl` (or `wget`) and `tar`, which macOS, Linux and Windows 10+ already have. Node is not needed. If [Bun](https://bun.sh) is missing, the installer puts it in your user folder (`~/.bun`) without sudo and carries on.

What it changes on your machine:

- the engine in `~/.nirvana/skills`;
- the `nirvana` skill linked into every agent runtime it finds: `~/.claude/skills`, `~/.codex/skills`, `~/.gemini/config/skills` (Antigravity), `~/.pi/agent/skills` and `~/.agents/skills` (OpenClaw);
- `nrv` and `nrv-hermes` in `~/.local/bin`, plus one PATH line in your shell profile (the user PATH on Windows);
- audit hooks in Claude Code, Antigravity and Codex;
- the empty content folders `~/squads`, `~/businesses` and `~/businesses/_library/dna`.

Running it again is safe. Open a new terminal afterwards so `nrv` is on your PATH, then ask your agent: *"Check that Nirvana-OS is installed correctly."* It runs `nrv doctor`. Exit 1 means warnings only; exit 2 lists what failed.

The one-liner does not ask questions. To pick a performance profile at install time, pass it through: `curl -fsSL https://gutomec.github.io/nirvana-os-engine/install.sh | bash -s -- --profile=balanced`. You can also set it later by asking your agent (see [Settings](#settings)).

Other routes (the `nirvana` skill through skills.sh, installing from a clone) are in [INSTALL.md](./INSTALL.md).

## Start a project

Open the folder you want to work in, start your agent there, and say: *"Set up this folder as a Nirvana-OS project."* The agent runs `nrv init .`, which writes `.nirvana/project.yaml` and a short note in `AGENTS.md`, `CLAUDE.md` and `GEMINI.md`. Deliverables land in `outputs/` inside the project.

That note keeps your agent working as usual. It uses Nirvana only when your request calls for it:

- you name it ("use Nirvana to…", "via nirvana");
- you name or point to one of your businesses, squads or mind-clones ("my launch company", "the copy squad", "in Hormozi's voice"), including a pack name;
- you ask for the work, or part of it, to run on another runtime ("use Codex to review it").

If you want Nirvana to orchestrate every deliverable in a project, say *"orchestrate everything in this project with Nirvana"*. The agent runs `nrv init . --orchestrators=always`. Open a new session for the change to take hold.

## What to ask your agent

| You say | Your agent runs |
|---|---|
| "What businesses / squads / mind-clones do I have?" | `nrv list-businesses`, `nrv list-squads`, `nrv list-clones` |
| "Use Nirvana to write the launch copy for X." | the harness: picks the business, writes a brief, `nrv dispatch … --exec` |
| "Run this through the copy squad, on Codex." | `nrv dispatch --squad <slug> … --exec --runtime codex` |
| "Stop that run." | `nrv run-track stop <run>` |
| "Change the headline in what you delivered." | `nrv revise <project> "<change>"` |
| "Show me what that run did." | `nrv audit-view <project>` |
| "Install the dependencies of all my squads." | `nrv activate --all` |
| "Update Nirvana-OS." | `nrv update` |
| "Update my Genesis Circle pack." | `nrv update genesis-circle` |
| "Put Nirvana in economy mode." | `nrv config set execution.profile economy --global` |

Bigger requests work the same way:

```text
Use Nirvana-OS to create a company called podcast-empire that produces, publishes,
and monetizes 3 podcasts at once. Each show has its own niche, an AI host, an
editorial calendar, and an independent monetization funnel. Around 7 employees.
```

```text
Use Nirvana-OS to turn the public work of <author> into a complete AI mind-clone.
```

```text
Use Nirvana-OS to produce a launch package: market research, landing-page copy,
and a competitive teardown.
```

The agent orchestrates and never writes the deliverable itself. Each business it picks gets its own brief and its own run, in parallel when the parts are independent.

<div align="center">
  <img src="./docs/assets/nirvana-promo-en-readme.gif" alt="One prose order in, a whole AI conglomerate assembles and delivers" width="100%">
</div>

## Packs

Packs are curated businesses, squads and mind-clones sold on [squads.sh](https://squads.sh/pt/packs). The flagship is [Genesis Circle](https://squads.sh/pt/nirvana-os).

1. Buy the pack on squads.sh and download its zip from your dashboard.
2. Unzip the whole archive into a folder, open a terminal there and run the setup:
   - macOS / Linux: `bash setup.sh`
   - Windows: `powershell -ExecutionPolicy Bypass -File setup.ps1`

   Setup installs Bun if needed, installs or updates the engine, copies the content into `~/squads`, `~/businesses` and `~/businesses/_library/dna`, rebuilds the indexes and stores the pack's license in `~/.nirvana-license/packs/<pack>/`.
3. Talk to your agent: *"Use Nirvana to list what the Genesis Circle pack gave me"*, then ask for work by naming a business, a squad or the pack.

Squad dependencies install on demand the first time a squad runs. To prepare them all up front, ask your agent to install the dependencies of every squad (`nrv activate --all`).

**Updating a pack.** Ask your agent to update it, or run `nrv update <pack>`. Components you edited are backed up under `~/.nirvana/backups/packs/<pack>/` before the update replaces them. If the update fails with a license error, download the pack again from squads.sh and run its setup once more; that also refreshes the license.

## Updating the engine

Ask your agent to update Nirvana-OS, or run `nrv update`. It backs up `~/.nirvana/skills` first and keeps your settings and content. `nrv update --check` names the release it would install without changing anything.

An update never moves the engine to an older release. A stable engine moves only to a newer stable. A beta moves to the newest greater release, beta or stable, so a 0.15 beta becomes 0.15.0 when that ships. After an engine update, `nrv update` also checks every installed pack that has a license and says when one has a newer version.

## Betas

Betas are GitHub prereleases. The one-liner installs the latest stable, so a beta is installed by pinning its tarball:

```bash
curl -fsSL https://gutomec.github.io/nirvana-os-engine/install.sh | NIRVANA_ENGINE_URL=https://github.com/gutomec/nirvana-os-engine/releases/download/v<version>/nirvana-os-engine.tar.gz bash
```

```powershell
$env:NIRVANA_ENGINE_URL = "https://github.com/gutomec/nirvana-os-engine/releases/download/v<version>/nirvana-os-engine.tar.gz"
irm https://gutomec.github.io/nirvana-os-engine/install.ps1 | iex
Remove-Item Env:NIRVANA_ENGINE_URL
```

Replace `<version>` with the release, for example `0.15.0-beta.5`. The tag has a leading `v`; without it the download returns 404. The release list is on [GitHub](https://github.com/gutomec/nirvana-os-engine/releases). In PowerShell the variable lives for the whole window, which is why the last line removes it: while it is set, `nrv update` reinstalls the pinned tarball.

Once on a beta, `nrv update` and every pack setup keep you on the beta channel. To go back to stable, run the plain one-liner from the top of this page: it installs the latest stable over the beta, and your content and settings stay.

## Settings

Settings change when you ask. *"Put Nirvana in economy mode"*, *"maximum quality"* or *"what is configured?"* are enough; your agent runs `nrv config` and tells you what changed.

A profile moves several settings at once:

| Profile | Effort | Context ceiling per worker | Review | Visual checks by workers |
|---|---|---|---|---|
| `max` | xhigh | none (runtime default) | every delivery, up to two rounds | on |
| `balanced` | high | 400k tokens | when a rule asks for it | off |
| `economy` | medium | 200k tokens | only on request | off |

A profile never picks the model; your runtime's own configuration does. A setting you change explicitly wins over the profile. `nrv config list` shows every setting, its value and where it came from. The full reference is [docs/configuration.md](./docs/configuration.md).

## Why "the work is done" means something here

An orchestrator can announce anything in its final message. Nirvana-OS backs each delivery with things you can open on disk.

- **Audit trail.** Every dispatch, gate verdict and delivery is an append-only event in `~/.harness-logs/<date>/audit.jsonl`. Every `--exec` run also leaves a record in the project's `.nirvana/run-kernel.sqlite`. `nrv audit-view <project>` shows the chain.
- **Checked on disk.** `verify-deliverable` compares what the brief promised with the files that exist, and the quality gate runs rubrics per file type, with correction rounds when it fails. A run whose serious failures survive the corrections is withheld, not delivered.
- **Briefs with criteria.** Each brief carries the user's request verbatim and observable "done when" criteria; the ones marked `(blocking)` decide whether the delivery passes.
- **Spend under your control.** No cost ceiling is set unless you ask for one (*"cap each run at US$ 5"* sets `budget.default_max_cost_usd`).

## Command reference

For agents and power users. `nrv help` lists everything; `nrv <command> --help` gives each command's options. Full reference: [docs/CLI.md](./docs/CLI.md).

| Command | What it does |
|---|---|
| `nrv doctor` | Health check: runtimes, hooks, skills links, dependencies, registries, licenses |
| `nrv init <dir>` | Make a folder a Nirvana project (`--orchestrators=always`, `--scope=project\|merge\|global`) |
| `nrv list-businesses` / `list-squads` / `list-clones` | Browse the three registries |
| `nrv find "<need>"` / `nrv search "<topic>"` | Ranked candidates for a request / keyword search across the libraries |
| `nrv brief template\|check\|decide` | The six-section brief the orchestrator writes for one business |
| `nrv dispatch <business> --brief-file <file> --exec` | Run a business on a brief; `--squad <slug>[:<capability>]`, `--agent-x` or `--auto` name other targets. Refuses without `--exec` |
| `nrv run-track status\|stop <run>` | Read a run's state, or stop it cleanly |
| `nrv revise <project> "<change>"` | Change a delivery in the same runtime session |
| `nrv audit-view <project>` | The audit chain of a run |
| `nrv activate <squad>\|--all` | Prepare a squad's environment in `~/.nirvana/envs/<squad>` ahead of time |
| `nrv config list\|get\|set\|unset\|explain` | Settings, with `--global` or `--project` |
| `nrv update [--check]` / `nrv update <pack>` | Update the engine / a pack |
| `nrv validate <squad\|business\|clone> <slug> [--fix]` | Admission gate for one entity |
| `nrv glance` | Web cockpit (`--read-only` to browse only) |
| `nrv uninstall --engine` | Remove the engine and keep your content |

## FAQ

**Do I need to know how to code?** No. You describe outcomes in plain language; your agent runs Nirvana, and the businesses and squads write, check and deliver.

**Does it replace my agent?** No. It runs on top of it. Dispatched work runs on the runtime of your session unless you name another: Claude Code, Codex, Antigravity, Pi, Kimi, Grok, Qwen Code or OpenCode.

**Where does my work live?** On your machine: content in `~/businesses`, `~/squads` and `~/businesses/_library/dna`, deliverables in each project's `outputs/`. There is no Nirvana cloud in the loop.

**What if nothing in my library fits?** The request still runs, on `agent-x`, the generalist. You can also ask your agent to create the business or squad that is missing.

**Windows?** Native, through Bun. No WSL.

## License, authorship, and status

Author: **Luiz Gustavo Vieira Rodrigues (gutomec / Prospecteezy)**. No co-authors.

License: the Nirvana-OS Sustainable Use License (SUL) v1.0. The source is published and openly readable, and the engine is free to use. It is source-available, not an OSI-approved open-source license, and certain commercial uses require a separate commercial license. Read [LICENSE](./LICENSE) before relying on any summary, including this one.

Status: beta (0.x, currently 0.15.0-beta.5). The engine works today and installs in minutes. Expect the surface to keep moving until 1.0.
