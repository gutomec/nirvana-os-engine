---
name: nirvana
description: "Nirvana-OS entry point: the user's own system of businesses (empresas), squads and mind-clones. Use it ONLY when the request calls for it: it names Nirvana or nirvana-os ('use o nirvana-os', 'via nirvana', 'pelo nirvana'); names or points to one of the user's businesses, squads or mind-clones, by name, by kind, by pack name or as the model to follow ('use minhas empresas/squads', 'o squad de copy', 'com a voz do Hormozi', 'como a empresa X e seus squads e clones'); asks for the work, or a part of it, to run on another agent runtime ('use o codex para revisar'); asks what they have ('quais são minhas empresas', 'quais squads eu tenho', 'o que o nirvana pode fazer'); asks to change its settings ('modo economia', 'máxima qualidade'); or asks to create, validate or migrate a business or a squad. Otherwise do not use it: work as you normally would. Discovery runs the `nrv` CLI, production goes to the harness orchestrator, lifecycle to the protocols; a missing engine is installed first."
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
discovery or production, and who executes. Always answer in the language of the
request. Never invent the name of a business, a squad or a mind-clone.
Report only what `nrv` actually prints.

## 1. Is the engine here?

```bash
command -v nrv || test -x "$HOME/.local/bin/nrv"
```

Found: go to section 2. Not found: install it, then come back.

**What the install changes.** Bun in user space (`~/.bun`) if it is missing; the
engine in `~/.nirvana`; the `nrv` launcher in `~/.local/bin` plus one PATH line
in the user's shell rc; audit hooks in the settings of the agent runtimes it
finds (`~/.claude`, `~/.gemini`, `~/.codex`); the empty content
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
only when you need to parse it. Discovery answers a question about the library;
it never stands in for a request to make something (section 3).

## 3. Production: hand the brief to the harness

Any request for a concrete artifact (report, post, book, campaign, design, code,
analysis, video) and any brief that names the system belong to the `harness`
skill. It surveys the three registries, can mobilize several businesses and
squads in parallel, runs the quality gate and verifies the result. **Do not
produce the artifact yourself.** Pass the brief verbatim; the harness handles
amplification and clarifying questions.

A request that names or points to one of the user's businesses, squads or
mind-clones is production too, whatever words it uses for them: a slug, a kind,
a pack or product name, or the model to follow ("como a empresa Motion Design
Genius e seus squads e clones"). Searching the library is not the work. When
`nrv search` or `nrv find` shows no exact match for the name the user used,
hand the brief over anyway: the harness reads the library and resolves the
name, or asks. Never search and then build the deliverable yourself.

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
Whether a project sees the global library, its own `.nirvana/` one, or both is
its scope (`global`, `project`, `merge`): `scope` in `.nirvana/project.yaml`,
set with `nrv init --scope=<mode>`.

## 7. Update and remove

| Goal | Command |
|---|---|
| Update the engine | `nrv update` |
| Update this skill | `npx skills update` |
| Remove the engine, keep the content | `nrv uninstall --engine` |
| Remove only this skill | `npx skills remove nirvana` |

## 8. Settings: the user asks, you change them

Users change how Nirvana works by talking to you, not by typing commands. Run
the command, confirm with `nrv config get <key>`, and say what changed in the
user's words.

| The user says | Command |
|---|---|
| "deixe o Nirvana no modo economia" ("equilibrado", "máxima qualidade") | `nrv config set execution.profile economy --global` (`balanced`, `max`) |
| "o que está configurado?" | `nrv config list` |
| "o que faz essa configuração?" | `nrv config explain <key>` |
| "volte ao padrão" | `nrv config unset <key> --global` |
| "neste projeto, use o Nirvana só quando eu pedir" / "orquestre tudo neste projeto" | `nrv init . --orchestrators=on-demand` / `--orchestrators=always` |
| "este projeto só com as empresas dele" / "as dele e as globais" / "a biblioteca toda" | `nrv init . --scope=project` / `merge` / `global` |
| "limite cada execução a US$ 5" | `nrv config set budget.default_max_cost_usd 5 --global` |

- **Where it applies.** Always pass `--global` or `--project` to `nrv config`:
  without a flag it writes to the project when run inside one, which the user
  rarely means. A request about "this project" is `--project`; anything else is
  `--global`. `nrv init` runs in the project's root.
- **A profile first, then exceptions.** A profile moves effort, the context
  ceiling, review, the judge and routing together; a key the user sets
  explicitly beats it. Change one key only when the user asked for that
  behaviour ("sem revisão", "sem juiz de IA").
- **When it takes effect.** A setting applies from the next dispatch. A new
  orchestration mode rewrites `AGENTS.md`, `CLAUDE.md` and `GEMINI.md`: tell the
  user to open a new session for it to take hold.
- Never edit `config.yaml` or `project.yaml` by hand, and never change a
  setting the user did not ask for.

This skill is thin by design: discovery goes to `nrv`, production goes to
`harness`, and the library lives on disk. It produces no artifacts itself.
