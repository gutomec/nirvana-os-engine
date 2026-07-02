---
name: nirvana-os
description: "List and inspect the user's Nirvana-OS businesses (empresas), squads and mind-clones, and route production briefs to the harness orchestrator. Trigger on 'quais são minhas empresas/squads', 'what businesses/squads do I have', 'liste minhas empresas', 'quais mind-clones eu tenho', 'o que o nirvana pode fazer', 'use o nirvana-os', 'via nirvana', 'pelo nirvana', or any request to orchestrate / dispatch / produzir work through Nirvana-OS."
tools: [Bash, Read, Skill]
version: 1.0.0
author: nirvana-os
license: SUL-1.0
---

# Nirvana-OS

The user runs **Nirvana-OS**, a Bun-native multi-agent orchestrator with three pillars: **businesses** (empresas — autonomous multi-agent organizations with org charts of employees), **squads** (portable agent teams with workflows), and **mind-clones** (persona DNA injected into employees). The `nrv` CLI reads the global registry at `~/businesses/` and `~/squads/`. Full identity + capability surface: `_shared/NIRVANA-OS.md`.

When the user names the system — "use o nirvana-os", "via nirvana", "pelo nirvana", "o que o nirvana pode fazer" — they are addressing this system. This skill answers discovery cheaply and routes real production to the orchestrator.

Always answer in the user's language (default PT-BR). Run the discovery commands with your shell tool, then summarize the output. Never invent business or squad names — only report what `nrv` actually prints.

## Discovery — run the command, then report

- "Quais são minhas empresas?" / "What businesses do I have?" / "liste empresas"
  → `nrv list-businesses`            (add `--format=json` only if you need to parse)
- "Quais são meus squads?" / "What squads do I have?" / "liste squads"
  → `nrv list-squads`                (supports `--format=table|json`)
- "Quais mind-clones eu tenho?" / "list mind-clones" / "minhas personas/DNA"
  → `nrv list-clones`                (aliases: `list-mind-clones`; `--format=table|json`)
  → `nrv inspect-clone <slug>`       (details; add `--dna` for DNA layer counts)
  → `nrv ask <clone-slug> "<pergunta>"`  (consult one mind-clone with its DNA injected)
- "O que o Nirvana pode fazer sobre X?" / capability search across all three pillars
  → `nrv search "<topic>"`           (filter with `--kind=business|squad|mind-clone`; `nrv find "<need>"` for routing)
- Web cockpit / visão geral
  → `nrv glance`
- Anything else / full command surface
  → `nrv --help`  (30+ subcommands)

## Orchestration — dispatch a production brief

When the user wants to actually **produce** something (a report, post, book, design, code, brand, analysis) or says "use o nirvana-os para fazer X", the orchestration intelligence lives in the **`harness` skill**. Do not produce the artifact yourself.

- **In-process runtimes (Claude Code, Codex, Antigravity):** invoke the `harness` skill with the user's brief verbatim — e.g. `Skill("harness", "<user's brief>")`. The harness is the maestro: it surveys the three registries and can mobilize **many businesses and/or squads in parallel**, then runs the quality gate and verifies.
- **Sub-process runtimes (Hermes, legacy Gemini):** `nrv dispatch "<the user's brief verbatim>"`.

The harness emits an audit chain under `~/.harness-logs/<date>/audit.jsonl` for every dispatch, so the work is verifiable.

## Notes

- Requires the `nrv` CLI on PATH (`command -v nrv`). If missing, tell the user to install Nirvana-OS, do not improvise.
- This skill is a thin bridge: discovery routes to `nrv`; production routes to the `harness` skill. It does not hold the registry or produce artifacts itself.
