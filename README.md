<div align="center">

<img src="./docs/assets/banner-week1.png" alt="Nirvana-OS: one sentence in, finished work out. Parallel agent workflows converge through quality gates." width="100%">

# Nirvana-OS

**Ready-to-run agentic operations.** One sentence in. Finished work out.

[![GitHub stars](https://img.shields.io/github/stars/gutomec/nirvana-os-engine)](https://github.com/gutomec/nirvana-os-engine/stargazers)
[![version](https://img.shields.io/github/v/release/gutomec/nirvana-os-engine?label=version)](./CHANGELOG.md)
[![CI](https://github.com/gutomec/nirvana-os-engine/actions/workflows/smoke.yml/badge.svg)](https://github.com/gutomec/nirvana-os-engine/actions/workflows/smoke.yml)
[![license](https://img.shields.io/badge/license-SUL-lightgrey)](./LICENSE)

**macOS, Linux and WSL**

```bash
curl -fsSL https://gutomec.github.io/nirvana-os-engine/install.sh | bash
```

**Windows (PowerShell)**

```powershell
irm https://gutomec.github.io/nirvana-os-engine/install.ps1 | iex
```

[Documentation](https://gutomec.github.io/nirvana-os-engine/) · [Packs](https://squads.sh/pt/packs) · [Illustrated install](https://gutomec.github.io/nirvana-os-engine/install.html) · [Beta](https://gutomec.github.io/nirvana-os-engine/beta.html) · [Changelog](./CHANGELOG.md)

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
| **Businesses** | Organizations with an org chart of employees (seats). A dispatched business runs its seats, which call squads and channel mind-clones | `~/businesses/` |
| **Squads** | Portable agent teams with agents, tasks and workflows the dispatched agent follows as its method | `~/squads/` |
| **Mind-clones** | Persona DNA in five layers, so an agent thinks and writes with a specific expert's method | `~/businesses/_library/dna/` |

The engine ships with no content. You create businesses, squads and clones by asking your agent, or you install a pack from [squads.sh](https://squads.sh/pt/packs).

## Install

Run the one-liner at the top of this page: the `bash` line on macOS, Linux and WSL, the PowerShell line on Windows. Node is not needed. If [Bun](https://bun.sh) is missing, the installer puts it in your user folder (`~/.bun`) without sudo or admin rights and carries on.

Before you run it:

- **macOS:** nothing to prepare.
- **Windows (PowerShell):** nothing to prepare, and no administrator rights.
- **Linux (Ubuntu):** `sudo apt update && sudo apt install -y curl unzip`.
- **Windows with WSL (Ubuntu):** run `wsl --install` in a PowerShell opened as administrator, reboot, open the Ubuntu app and create your Linux user. Then install `curl` and `unzip` as on Linux and run the `bash` line inside Ubuntu. Your AI agent (Claude Code, Codex, Antigravity) must be installed inside Ubuntu too, and your projects belong in `~`, not under `/mnt/c`, which is slow.

What it changes on your machine:

- the engine in `~/.nirvana/skills`;
- the `nirvana` skill linked into every agent runtime it finds: `~/.claude/skills`, `~/.codex/skills`, `~/.gemini/config/skills` (Antigravity), `~/.pi/agent/skills` and `~/.agents/skills` (OpenClaw);
- `nrv` and `nrv-hermes` in `~/.local/bin`, plus one PATH line in your shell profile (the user PATH on Windows);
- audit hooks in Claude Code, Antigravity and Codex;
- the empty content folders `~/squads`, `~/businesses` and `~/businesses/_library/dna`.

Running it again is safe. **Close the terminal and open a new one** so `nrv` is on your PATH, and check with `nrv --version`. Then ask your agent: *"Check that Nirvana-OS is installed correctly."* It runs `nrv doctor`. Exit 1 means warnings only; exit 2 lists what failed.

The step-by-step guide for each system, the beta and troubleshooting are on the [documentation site](https://gutomec.github.io/nirvana-os-engine/install.html) (in Portuguese) and in [INSTALL.md](./INSTALL.md), with the other routes (the `nirvana` skill through skills.sh, installing from a clone).

## Start a project

Open the folder you want to work in, start your agent there, and say: *"Set up this folder as a Nirvana-OS project."* The agent runs `nrv init .`, which writes `.nirvana/project.yaml`, a `.env` with the project's library scope, and the project contract in `AGENTS.md`, `CLAUDE.md` and `GEMINI.md`. Deliverables land in `outputs/` inside the project.

On 0.14.11 that contract makes Nirvana the orchestrator of every concrete deliverable in the project: ask for a report, a page or a campaign and your agent hands it to Nirvana. If you want Nirvana only when you ask for it by name, say so when you set the project up (*"set up this folder as a Nirvana project, on demand only"*). The agent runs `nrv init . --orchestrators=on-demand`, which writes a short note instead of the full contract. When you run `nrv init .` yourself in a terminal, in a folder that already has one of those files, it asks which mode to use. The 0.15 beta turns this around: on-demand is the default, and `--orchestrators=always` opts in.

From then on you talk to your agent in plain language and it uses Nirvana-OS. You do not type commands day to day.

## What to ask your agent

| You say | Your agent runs |
|---|---|
| "What businesses / squads / mind-clones do I have?" | `nrv list-businesses`, `nrv list-squads`, `nrv list-clones` |
| "Use Nirvana to write the launch copy for X." | the harness: picks the businesses and squads, briefs them and dispatches them |
| "Run this through the copy squad, on Codex." | `nrv dispatch --squad <slug> … --exec --runtime codex` |
| "Change the headline in what you delivered." | `nrv revise <project> "<change>"` |
| "Show me what that run did." | `nrv audit-view <project>` |
| "Install the dependencies of all my squads." | `nrv activate --all` |
| "Update Nirvana-OS." | `nrv update` |
| "Update my Genesis Circle pack." | `nrv update genesis-circle` |
| "Cap each run at US$ 5." | `nrv config set budget.default_max_cost_usd 5 --global` |

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

The agent orchestrates and never writes the deliverable itself. It picks the businesses and squads, writes each an enriched brief and dispatches them, in parallel when the parts are independent.

<div align="center">
  <img src="./docs/assets/nirvana-promo-en-readme.gif" alt="One prose order in, a whole AI conglomerate assembles and delivers" width="100%">
</div>

## Packs

Packs are curated businesses, squads and mind-clones sold on [squads.sh](https://squads.sh/pt/packs). The flagship is [Genesis Circle](https://squads.sh/pt/nirvana-os).

1. Buy the pack on squads.sh and download its zip from your dashboard.
2. Unzip the whole archive and open a terminal in the folder that holds `setup.sh`:
   - macOS: double-click the zip, type `cd ` in Terminal, drag the folder onto the window and press Enter;
   - Windows: right-click the zip, choose **Extract All**, open the folder, right-click an empty area and choose **Open in Terminal**;
   - Linux and WSL: `cd ~/Downloads && unzip <file>.zip -d <folder> && cd <folder>`. On WSL, first copy the zip from `/mnt/c/Users/<user>/Downloads` to `~/Downloads`.
3. Run the setup:
   - macOS, Linux and WSL: `bash setup.sh`
   - Windows: `powershell -ExecutionPolicy Bypass -File setup.ps1`

   Setup installs Bun if needed, installs or updates the engine, copies the content into `~/squads`, `~/businesses` and `~/businesses/_library/dna`, rebuilds the indexes and stores the pack's license in `~/.nirvana-license/packs/<pack>/`. It never replaces the engine with an older release, so a beta stays a beta.
4. Talk to your agent: *"Use Nirvana to list what the Genesis Circle pack gave me"*, then ask for work by naming a business, a squad or the pack.

**Activating squads.** A squad's dependencies install on demand the first time it runs, in its own environment under `~/.nirvana/envs/<squad>`. To prepare them all up front, ask your agent: *"Activate all my Nirvana squads."* It runs `nrv activate --all`, which covers Node and Python packages, system programs, API keys and environment variables, MCP servers and models. The agent gets the list of failures with the exact command that fixes each one, and asks your permission before anything that uses `brew`, `sudo` or `winget`, and for any API key. A first run on a big pack takes several minutes.

**Updating a pack.** Ask your agent to update it, or run `nrv update <pack-slug>`, for example `nrv update genesis-circle`. Components you edited are backed up under `~/.nirvana/backups/packs/<pack>/` before the update replaces them. If the update fails with a license error, download the pack again from squads.sh and run its setup once more; that also refreshes the license.

## Updating the engine

Ask your agent to update Nirvana-OS, or run `nrv update`. It backs up `~/.nirvana/skills` first and keeps your settings and content. `nrv update --check` names the release it would install without changing anything.

An update never moves the engine to an older release. A stable engine moves only to a newer stable. A beta moves to the newest greater release, beta or stable, so a 0.15 beta becomes 0.15.0 when that ships. After an engine update, `nrv update` also checks every installed pack that has a license and says when one has a newer version.

## Betas

Betas are GitHub prereleases. The one-liner installs the latest stable, so a beta is installed by pinning its tarball. The current beta is `v0.15.0-beta.12`. The tag has a leading `v`; without it the download returns 404. For a newer beta, replace that tag with one from the [release list](https://github.com/gutomec/nirvana-os-engine/releases).

macOS, Linux and WSL:

```bash
curl -fsSL https://gutomec.github.io/nirvana-os-engine/install.sh | NIRVANA_ENGINE_URL=https://github.com/gutomec/nirvana-os-engine/releases/download/v0.15.0-beta.12/nirvana-os-engine.tar.gz bash
```

Windows (PowerShell), as one line:

```powershell
$env:NIRVANA_ENGINE_URL='https://github.com/gutomec/nirvana-os-engine/releases/download/v0.15.0-beta.12/nirvana-os-engine.tar.gz'; irm https://gutomec.github.io/nirvana-os-engine/install.ps1 | iex
```

Then, if the window is still open, run `Remove-Item Env:NIRVANA_ENGINE_URL`: while the variable is set, `nrv update` reinstalls the pinned tarball. The Windows commands use single quotes because a double quote lost in a paste leaves PowerShell waiting on `>>`.

The beta brings performance profiles (`max`, `balanced`, `economy`) and makes `nrv init` on-demand by default. Once on a beta, `nrv update` and every pack setup keep you on the beta channel.

**Back to stable.** On Windows, open a new PowerShell and run `Remove-Item Env:NIRVANA_ENGINE_URL`; an error saying it does not exist is fine. Run the plain one-liner from the top of this page. It installs the latest stable over the beta and keeps your content, packs and settings. Check that `nrv --version` no longer shows `beta`, then run `nrv init .` again in each project you used with the beta, after removing the block the beta wrote in `AGENTS.md`, `CLAUDE.md` and `GEMINI.md` ([details](./INSTALL.md#back-to-stable-from-a-beta)).

## Settings

Settings change when you ask. *"What is configured?"*, *"cap each run at US$ 5"* or *"turn off the AI judge"* are enough; your agent runs `nrv config` and tells you what changed. `nrv config list` shows every setting, its value and where it came from: an environment variable, the project's `.nirvana/config.yaml`, your `~/.nirvana/config.yaml`, the engine or the default. Your global file survives every update.

No model and no effort are set by default, so each runtime uses its own configuration. The full reference is [docs/configuration.md](./docs/configuration.md).

**Per project.** `nrv config set briefing.altitude <outcome|guided|prescriptive> --project` sets how much a brief carries: `outcome`, the default, states the result, the guardrails and the definition of done; `guided` adds the structure the author suggests; `prescriptive` adds per-item criteria, the artifact list and the method. `nrv config get briefing.altitude` shows the value in effect. Rules in free text go in the project's `CLAUDE.md`, `AGENTS.md` or `GEMINI.md`, above the Nirvana block that `nrv init` rewrites; your agent reads them and carries them into the briefs it writes. Asking is enough: *"in this project, use guided briefs"*, *"add to this project's CLAUDE.md: every deliverable in Brazilian Portuguese"*.

## Why "the work is done" means something here

An orchestrator can announce anything in its final message. Nirvana-OS backs each delivery with things you can open on disk.

- **Audit trail.** Every dispatch, gate verdict and delivery is an append-only event in `~/.harness-logs/<date>/audit.jsonl`. Every `--exec` run also leaves a record in the project's `.nirvana/run-kernel.sqlite`. `nrv audit-view <project>` shows the chain.
- **Checked on disk.** `verify-deliverable` compares what the brief promised with the files that exist, and the quality gate runs rubrics per file type, with correction rounds when it fails. A run whose serious failures survive the corrections is withheld, not delivered.
- **Graded against the brief.** The gate hands the brief to its judge, so a deliverable is held to what was asked, not only to a generic rubric.
- **Spend under your control.** No cost ceiling is set unless you ask for one (*"cap each run at US$ 5"* sets `budget.default_max_cost_usd`).

## Command reference

For agents and power users. `nrv help` lists everything; `nrv <command> --help` gives each command's options. Full reference: [docs/CLI.md](./docs/CLI.md).

| Command | What it does |
|---|---|
| `nrv doctor` | Health check: runtimes, hooks, skills links, dependencies, registries, licenses |
| `nrv init <dir>` | Make a folder a Nirvana project (`--orchestrators=on-demand\|always`, `--scope=project\|merge`) |
| `nrv list-businesses` / `list-squads` / `list-clones` | Browse the three registries |
| `nrv find "<need>"` / `nrv search "<topic>"` | Ranked candidates for a request / keyword search across the libraries |
| `nrv dispatch <business> "<brief>" --exec` | Run a business on a brief; `--squad <slug>`, `--agent-x` or `--auto` name other targets. Without `--exec` it only scaffolds |
| `nrv run-track status\|wait <run>` | Read a run's state, or wait for it to finish |
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

**Does it replace my agent?** No. It runs on top of it. Dispatched work runs on the runtime of your session unless you name another: Claude Code, Codex, Antigravity, Pi, Kimi or Grok.

**Where does my work live?** On your machine: content in `~/businesses`, `~/squads` and `~/businesses/_library/dna`, deliverables in each project's `outputs/`. There is no Nirvana cloud in the loop.

**What if nothing in my library fits?** The request still runs, on `agent-x`, the generalist. You can also ask your agent to create the business or squad that is missing.

**Windows?** Native, through Bun, with no WSL needed. If you prefer WSL, install everything inside Ubuntu, your agent included.

## Troubleshooting

- **PowerShell shows `>>` and waits.** A quote was left open in the paste. Press Ctrl+C or open a new window, then paste the single line again.
- **macOS prints "Saving session… [Processo concluído]" after you close Terminal.** That is Terminal closing the shell, not an error.
- **The install returns 404.** The tag is missing its leading `v`, or that release does not exist.
- **A pack update fails with a license error.** Download the pack again from squads.sh and run its setup.
- **Anything else.** `nrv doctor` checks the whole install and `nrv install --check` checks the hooks and the PATH. More in [INSTALL.md](./INSTALL.md#troubleshooting).

## License, authorship, and status

Author: **Luiz Gustavo Vieira Rodrigues (gutomec / Prospecteezy)**. No co-authors.

License: the Nirvana-OS Sustainable Use License (SUL) v1.0. The source is published and openly readable, and the engine is free to use. It is source-available, not an OSI-approved open-source license, and certain commercial uses require a separate commercial license. Read [LICENSE](./LICENSE) before relying on any summary, including this one.

Status: beta (0.x, currently 0.14.13). The engine works today and installs in minutes. Expect the surface to keep moving until 1.0.
