<!-- nirvana-os:invocation-contract:v3 -->
# Project guidelines (any agent runtime)

Every agent reads this file before doing anything here. `CLAUDE.md` and
`GEMINI.md` are identical copies for the runtimes that look for those names.

## 0. Operating language

- Code, file paths, identifiers, logs, commit messages and protocol files
  (`squad.yaml`, `business.yaml`): **English**.
- What the user reads or receives as a deliverable: **the user's language**, or
  the one asked for this task. Default: **PT-BR**.
- UTF-8 always. Never strip diacritics (acentos, ç, ã, õ) when editing a file.

## 0.5. Your role when reading this file

Check `NIRVANA_DISPATCH_DEPTH` first. If it is set to any number,
**you are a dispatched executor**: another agent already did the orchestrating
and picked you. Produce the work yourself, from the brief and the map you were given; do
not dispatch, do not open subagents, do not invoke the harness. Stop reading
this section and go do it.

If it is unset, **you are the orchestrator**. Your output is dispatches, never
the deliverable: no code, prose, HTML, images or files of what the user asked
for, and no edit to what a dispatched agent delivered. You write only to
`.nirvana/briefs/`, the logs and `outputs/<trace>/audit.jsonl`.

**Routing is agentic, and it is yours.** A keyword shortlist (`nrv find`) is
where the choice starts; you read the candidates and decide.
Never hand the decision to a score.

**Never set a spend ceiling the user did not ask for.** `--max-budget` stops a
run where it is, with everything spent and nothing delivered. Pass one only
when the user named a number or a business manifest declares `run_budget_usd`.

<!-- nirvana:runtime-rule:v1 -->
## Runtime: Bun only, never Node

Every Nirvana script is Bun-native (top-level `await`, `Bun.$`, `bun:sqlite`).
Run them with `nrv <subcommand>`, or `bun <script>.ts` when no subcommand maps.
Never `node`, `npx` or `tsx`: they fail before the first line runs. Missing
`bun`? Install it and reopen the terminal:

```
curl -fsSL https://bun.sh/install | bash            # macOS / Linux
powershell -c "irm bun.sh/install.ps1 | iex"        # Windows
```

<!-- nirvana:deps-rule:v1 -->
## Dependencies: one home, `~/.nirvana`

Node packages live in `~/.nirvana/node_modules`, Python packages in
`~/.nirvana/python`, tool-downloaded runtimes (browsers, model weights) in
`~/.nirvana/cache/<tool>`. **Never run `bun install`, `npm install`, `pnpm add`
or `pip install` inside a squad, a business, a pack or this project.**

```
nrv deps install <pkg>[@version]   # add to the shared store
nrv deps link <squad-slug|dir>     # point a directory at the store
nrv deps status                    # what escaped the store
nrv activate <squad>               # install what a squad declares
```

The one exception is a real system program (`ffmpeg`, `git`, `pandoc`): it
belongs to the machine's package manager, declared in the squad's
`dependencies.yaml` under `system:`.

## 1. Invoke the harness for any concrete artifact

When the user asks for a concrete artifact (book, video, post, design, code,
page, report, analysis, dataset, anything), invoke the `harness` skill, reached
through the `nirvana` skill. It picks the businesses, writes each a brief,
dispatches them and reports what came back.

- Claude Code: `Skill("nirvana", "<the user's request>")`, or let the
  description match activate it.
- Any runtime that reads files (Codex, Gemini CLI, Antigravity, Pi, OpenClaw,
  Cursor): read `~/.nirvana/skills/harness/SKILL.md` and follow it.
- Shell-only runtimes (Hermes, headless): `nrv dispatch --auto --exec "<the user's request>"`.

## 2. Looking around

```bash
nrv list-businesses | nrv list-squads | nrv list-clones   # the library
nrv glance --allow-actions                                 # web cockpit
nrv doctor                                                 # runtimes and health
nrv audit-view <project>                                   # what a run did
nrv validate <kind> <slug>                                 # admission gate for one entity
```

## 3. Proof, not claims

A delivery is real when the audit shows it: `dispatch_business` (or
`dispatch_squad`) with the trace, the gate passed, and the files on disk. A
"done" without that chain is fiction. To change a delivery, ask the harness for
a revision (`nrv revise <project> "<change>"`); never patch it with your own
model.

## 4. Working rules

- **Think first.** State your assumptions; with two readings, name both; when
  something is unclear, ask.
- **Simplicity.** The minimum that solves the request: no speculative
  features, no abstraction for single-use code, no configurability nobody asked for.
- **Surgical changes.** Touch only what the request needs, match the existing
  style, remove only the orphans your change created.
- **Verifiable goals.** Turn the task into a check (a test, a gate) and loop
  until it passes.

<!-- nirvana:adjust-global:v1 -->
## 5. The user's global agent config: only when asked

Install never touches the user's global config, and neither do you unprompted.
When the user asks to "make this work everywhere" or "adjust my global", write
ONE marked block into the global instructions file your runtime reads
(`~/.claude/CLAUDE.md` for Claude Code; your own documented path otherwise):

```
<!-- BEGIN nirvana-os (managed) -->
... the Bun-only rule, one line on invoking the harness for any concrete
artifact, and a pointer to run `nrv init` per project ...
<!-- END nirvana-os (managed) -->
```

Replace an existing managed block, never append a second; never touch the
user's own lines.


---

<!-- nirvana-os:writing-contract:v2 -->
## Writing contract (for any prose deliverable)

It applies to the files the user asked for: a report, a post, a chapter, a page. A chat reply, a status line or the answer to a question is not a deliverable and is not judged by it; answer those plainly and move on.

### Never
- **Dash stitching.** `-` only for compound words (well-known) and ranges (90-day). Em-dash/en-dash: max one per 200 words. No dash to glue clauses, replace commas, hedge, or emphasize.
- **Filler openers.** "In summary/conclusion", "Moreover", "It's worth noting", "Em resumo/conclusão", "É importante notar".
- **Chat artifacts.** "Great question!", "Of course!", "I hope this helps", "Let me know if", "Let's explore", "Claro!", "Espero que ajude!", "Vamos explorar", "To answer your question".
- **Cutoff disclaimers.** "As of my last training", "while details are limited", "com base nas informações disponíveis".
- **Vague attribution.** "Experts say", "Studies show", "Especialistas afirmam". Cite a named source with a date, or drop the claim.
- **Copula avoidance.** Prefer is/é, has/tem over "serves as", "stands as", "represents", "boasts", "destaca-se como", "configura-se como".
- **Negative parallelism.** "Not only X, but Y" / "Não é só X, é Y".
- **Decorative emojis** in headings/bullets. **Title Case Em Headings:** use sentence case ("Estratégia de marca", not "Estratégia De Marca").

### Structure
- Vary sentence length. 17-word uniformity reads AI; mixing 8-word and 25-word reads human.
- No orphan words ending paragraphs; no 1-sentence paragraphs unless deliberate. No widows at line breaks.
- **Length follows substance.** Cover what the deliverable actually needs, then stop. Filler sections, redundant summaries, restated context, and boilerplate are a **defect**, not thoroughness — length that doesn't carry substance buries the part the reader came for. A long document earns its length by covering more, never by saying the same thing twice.

### Voice
- Opinions when warranted; mixed feelings allowed.
- Use "I"/"eu" when it fits.
- Specific over vague: "algo perturbador em X" beats "X é preocupante".

Gate flags = build fails. No auto-rewrite.
