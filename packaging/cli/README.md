# @nirvana-os/cli

Install Nirvana-OS: the orchestration layer that turns your terminal agent into a maestro for whole companies.

```bash
npx @nirvana-os/cli
```

One command. It installs the engine, links it into every agent runtime it finds (Claude Code, Codex, Gemini-CLI, Antigravity), and is safe to run again any time.

## What you get

Nirvana-OS runs **on top of** the terminal agent you already use and lets you create and orchestrate three things, all from plain language:

- **Companies** — autonomous organizations with an org chart of employees.
- **Squads** — portable agent teams that run workflows and ship finished work.
- **Mind-clones** — persona DNA injected into employees for a master's judgment and voice.

You describe an outcome in prose. The engine dispatches the right combination, runs it in parallel, reconciles the result behind a quality gate, and writes an audit trail of every step.

This package is a thin launcher. It carries no content: it downloads the latest engine from GitHub and installs it. The engine is free and open-core.

## After installing

Open a new terminal (the installer adds `nrv` to your PATH), then:

```bash
nrv --help            # full command reference
nrv glance            # one-screen overview
nrv route "<brief>"   # hand the maestro a brief in plain prose
```

## Requirements

- **Bun** (the engine runs on Bun). The launcher installs it if missing.
- **Node.js** for `npx` (most machines already have it).
- macOS, Linux, or Windows (native, no WSL).

## Free engine, optional packs

The engine builds companies, squads, and mind-clones from scratch, free. If you want a whole conglomerate ready on day one, curated content packs are on [squads.sh](https://squads.sh). The flagship, Genesis Circle, lands 39 squads, 11 companies, and 159 mind-clones in one install.

Full documentation: [github.com/gutomec/nirvana-os-engine](https://github.com/gutomec/nirvana-os-engine).

## License and author

Author: Luiz Gustavo Vieira Rodrigues (Prospecteezy). Nirvana-OS Sustainable Use License (SUL).
