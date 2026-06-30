---
name: nirvana-os
description: List and inspect the user's Nirvana-OS businesses (empresas) and squads, and route production briefs to the harness orchestrator. Trigger when the user asks "quais são minhas empresas", "quais squads eu tenho", "what businesses/squads do I have", "liste minhas empresas", "o que o nirvana pode fazer", or wants to orchestrate / dispatch / produzir work through Nirvana-OS.
version: 1.0.0
author: nirvana-os
license: SUL-1.0
platforms: [macos, linux]
metadata:
  hermes:
    tags: [nirvana, businesses, empresas, squads, mind-clones, harness, orchestration, orquestracao]
prerequisites:
  commands: [nrv]
---

# Nirvana-OS

The user runs Nirvana-OS, a Bun-native multi-agent orchestrator with three pillars: **businesses** (empresas — autonomous multi-agent organizations with org charts of employees), **squads** (portable agent teams with workflows), and **mind-clones** (persona DNA injected into employees). The `nrv` CLI is the single entry point. It reads the global registry at `~/businesses/` and `~/squads/`.

Always answer in the user's language (default PT-BR). Run the commands below with your shell tool, then summarize the output for the user. Never invent business or squad names — only report what `nrv` actually prints.

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
  → `nrv --help`  (30+ subcommands: dispatch, ask, inspect, audit-view, export, …)

## Orchestration — dispatch a production brief

When the user wants to actually produce something (a report, post, book, design, code, brand, analysis), the orchestration intelligence lives in the Nirvana harness. Do not produce the artifact yourself — hand the brief to `nrv`:

  → `nrv dispatch "<the user's brief verbatim>"`     (full maestro: picks business/squad/mind-clone, runs the quality gate)
  → `nrv ask "<question>"`                            (quick consult)

The harness emits an audit chain under `~/.harness-logs/<date>/audit.jsonl` for every dispatch, so the work is verifiable.

## Honest limits in Hermes

Full in-process multi-agent dispatch is richest inside Claude Code (native subagent primitive). In Hermes, the maestro reasoning still works and `nrv` carries the deterministic pieces (routing, list, inspect, verify, quality-gate); employee dispatch degrades to sub-process, the same way it does in the Codex and Gemini adapters. For read-only queries (list / inspect / search) there is no degradation — they work fully here.

## Notes

- Requires the `nrv` CLI on PATH (`command -v nrv`). If missing, tell the user to install Nirvana-OS, do not improvise.
- This skill is a thin bridge: it routes to `nrv`, it does not hold the registry itself.
