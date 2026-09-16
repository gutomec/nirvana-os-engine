---
name: nirvana
description: "Nirvana-OS entry point: the user's own operating system of businesses (empresas), squads and mind-clones. Use it to list or inspect them ('quais são minhas empresas', 'quais squads eu tenho', 'what businesses/squads do I have', 'liste minhas empresas', 'quais mind-clones eu tenho', 'o que o nirvana pode fazer'), whenever the user invokes the system by name ('use o nirvana-os', 'via nirvana', 'pelo nirvana', 'orquestre via nirvana', 'manda o nirvana', 'use minhas empresas/squads', 'use Nirvana-OS to…'), for any concrete artifact asked for through it (book, video, report, design, code, campaign, any deliverable), and to create, validate, inspect or migrate a business or a squad ('crie uma empresa', 'valide o squad X'). Discovery runs the `nrv` CLI; production hands the brief to the harness orchestrator; lifecycle goes to the businesses and squads protocols. When the engine is missing, this skill installs it first."
compatibility: "Needs Bun and the `nrv` CLI. If they are absent it installs them on first use with the user's go-ahead: Bun in user space, the engine into ~/.nirvana, `nrv` into ~/.local/bin. Runtime-agnostic, no dependency on any specific agent CLI. Network is required for that first install only; everything after it runs locally."
tools: [Bash, Read]
license: SUL-1.0
metadata:
  openclaw:
    # No `requires.bins` gate on purpose: this skill's job on a machine without
    # Bun is to install it. The three engine skills keep their bun gate.
    emoji: "🌀"
---

# Nirvana-OS

Nirvana-OS is the user's own multi-agent operating system: Bun-native, with three
pillars. **Businesses** (empresas) are autonomous organizations with an org chart
of employees. **Squads** are portable agent teams with workflows. **Mind-clones**
are persona DNA injected into employees. The `nrv` CLI is the single entry point
to the registries, and the `harness` skill is the orchestrator that turns a brief
into dispatched work with an audit trail.

You are at the entry point: decide whether the engine is here, whether this is
discovery or production, and who executes. Always answer in the user's language
(default PT-BR). Never invent the name of a business, a squad or a mind-clone.
Report only what `nrv` actually prints.

## 1. Is the engine here?

```bash
command -v nrv || test -x "$HOME/.local/bin/nrv"
```

Found: go to section 2. Not found: install it, then come back.

**What the install changes.** Bun in user space (`~/.bun`) if it is missing; the
engine in `~/.nirvana`; the `nrv` launcher in `~/.local/bin` plus one PATH line
in the user's shell rc; audit hooks in the settings of the agent runtimes it
finds (`~/.claude`, `~/.gemini`, `~/.codex`, `~/.antigravity`); the empty content
roots `~/squads`, `~/businesses`, `~/businesses/_library/dna`. Network once, no
project code touched, no sudo, idempotent, reversible with `nrv uninstall --engine`.

**Ask before you install.** Say the paragraph above in a sentence or two and wait
for a yes. In a runtime with no way to ask, print that list, proceed, and report
exactly what changed. `scripts/bootstrap.sh --dry-run` prints the same list and
touches nothing.

Run the bootstrap from this skill's own directory, passing `--yes` only after the
go-ahead:

```bash
bash "${CLAUDE_SKILL_DIR}/scripts/bootstrap.sh" --yes                                        # macOS / Linux
powershell -ExecutionPolicy Bypass -File "${CLAUDE_SKILL_DIR}\scripts\bootstrap.ps1" -Yes     # Windows
```

Claude Code substitutes `${CLAUDE_SKILL_DIR}`. Codex and the OpenAI Agents API
print the skill's path next to its name. Anywhere else, the directory is one of
`./.claude/skills/nirvana`, `./.agents/skills/nirvana`, `~/.agents/skills/nirvana`,
`~/.codex/skills/nirvana`, or your agent's own user-level skills directory: use the
first that holds `scripts/bootstrap.sh`.

Then verify and carry on with the user's original request:

```bash
~/.local/bin/nrv doctor
```

`~/.local/bin` is on the PATH of new shells, not of the one you are in: call
`~/.local/bin/nrv` explicitly for the rest of this session. `nrv doctor` exit 1
means warnings and the install is fine; exit 2 means read the `FAIL` lines, and
`registry: … missing` is fixed by `nrv index`. Never re-run the installer because
doctor exited non-zero.

If the bootstrap cannot run (no network, no write access, a locked-down sandbox),
say exactly that and stop. A Nirvana answer with no engine behind it is fiction.

## 2. Discovery: run the command, then report

| The user asks | Command |
|---|---|
| "quais são minhas empresas", "what businesses do I have" | `nrv list-businesses` |
| "quais squads eu tenho", "liste meus squads" | `nrv list-squads` |
| "quais mind-clones eu tenho", "minhas personas" | `nrv list-clones` |
| details of one mind-clone | `nrv inspect-clone <slug>` (add `--dna`) |
| consult one mind-clone | `nrv ask <slug> "<pergunta>"` |
| "o que o nirvana pode fazer sobre X" | `nrv search "<topic>"` |
| which entity fits a need | `nrv find "<need>"` |
| the cockpit | `nrv glance` |
| anything else | `nrv --help` |

Run it with your shell tool and summarize the real output. Add `--format=json`
only when you need to parse it.

## 3. Production: hand the brief to the harness

Any request for a concrete artifact (report, post, book, campaign, design, code,
analysis, video) and any brief that names the system belong to the `harness`
skill. It surveys the three registries, can mobilize several businesses and
squads in parallel, runs the quality gate and verifies the result. **Do not
produce the artifact yourself.** Pass the brief verbatim; the harness handles
amplification and clarifying questions.

The harness is not registered as a skill of its own: it lives inside the
engine, and this file is the door to it.

| Your runtime | How to hand over |
|---|---|
| Any runtime that can read a file (Claude Code, Codex, Gemini CLI, Antigravity, Pi, OpenClaw, Cursor…) | read `~/.nirvana/skills/harness/SKILL.md` and follow it as your operating instructions for this brief; its `../_shared/…` references resolve against `~/.nirvana/skills/harness/` |
| Shell-only and sub-process runtimes (Hermes, legacy gemini-cli, headless) | `nrv dispatch --auto --exec "<the user's brief, verbatim>"` (`--exec=<runtime>` pins one; without `--exec` the command only scaffolds and delivers nothing) |

Dispatch needs one agent CLI on PATH (`claude`, `codex`, `gemini`, `agy`, `pi`,
`kimi`, `grok`, `qwen`, `opencode`). With none, Nirvana still answers discovery
but cannot dispatch production: say so rather than producing inline. Every
dispatch writes its audit chain to `~/.harness-logs/<date>/audit.jsonl`.

## 4. Lifecycle: create, validate, inspect, migrate

"crie uma empresa de X", "valide o squad Y", "inspecione a empresa Z", "migre o
squad W": these are lifecycle operations, not production. Read
`~/.nirvana/skills/businesses/SKILL.md` (businesses, the mind-clone library)
or `~/.nirvana/skills/squads/SKILL.md` (squads) and follow it. Both are
engine-internal like the harness; neither is registered as a skill of its own.

## 5. What a fresh install looks like

The engine ships **no content**. On a new machine the registries are empty and
`nrv list-businesses`, `nrv list-squads` and `nrv list-clones` print `total: 0`.
That is correct output, not a broken install. Say so and offer the three ways
forward:

- **Dispatch anyway.** With an empty library the harness still executes: the
  cascade falls back to `agent-x`, the autonomous generalist. Nothing stalls.
- **Create from prose.** A brief like "crie uma empresa de marketing digital" or
  "crie um mind-clone de <autor>" routes to the business, squad and mind-clone
  creation pipelines, which are engine work and write into the content roots.
- **Install packs.** Curated businesses, squads and mind-clones come from
  squads.sh and land in those same roots.

The first brief inside a project also makes it a Nirvana project: the harness
Phase 0 preflight runs `nrv init .` when the invocation contract is missing.
That is the harness's job, not yours.

## 6. Where the content lives

Defaults: `~/squads`, `~/businesses`, `~/businesses/_library/dna`. To relocate
them, set `NIRVANA_HOME`, `SQUADS_DIR`, `BUSINESSES_DIR` or `DNA_LIBRARY` in the
project `.env`, the only file read for paths besides the real environment.
`NIRVANA_SCOPE=global|project|merge` in that same file decides whether a project
sees the global library, its own `.nirvana/` one, or both.

## 7. Update and remove

| Goal | Command |
|---|---|
| Update the engine | `nrv update` |
| Update this skill | `npx skills update` |
| Remove the engine, keep the content | `nrv uninstall --engine` |
| Remove only this skill | `npx skills remove nirvana` |

This skill is thin by design: discovery goes to `nrv`, production goes to
`harness`, and the library lives on disk. It produces no artifacts itself.
