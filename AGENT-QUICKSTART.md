# Agent quickstart: drive Nirvana-OS in one page

You are a terminal agent (Claude Code, Codex, Antigravity, Pi, …)
on a machine where Nirvana-OS may be installed. The user talks to you in plain
language; you run Nirvana for them. This page is enough to do that correctly.
The full protocol is `~/.nirvana/skills/harness/SKILL.md`; the entry skill is
`~/.nirvana/skills/nirvana/SKILL.md`.

## 1. Is the engine here?

```bash
command -v nrv || test -x "$HOME/.local/bin/nrv"
```

If not, tell the user what the install changes (Bun in `~/.bun` if missing,
the engine in `~/.nirvana`, `nrv` in `~/.local/bin` plus one PATH line, audit
hooks in the agent runtimes it finds, empty content folders), wait for a yes,
then run:

```bash
curl -fsSL https://gutomec.github.io/nirvana-os-engine/install.sh | bash   # macOS / Linux
irm https://gutomec.github.io/nirvana-os-engine/install.ps1 | iex          # Windows PowerShell
```

`~/.local/bin` reaches the PATH of new shells only: call `~/.local/bin/nrv`
for the rest of this session. Check with `nrv doctor` (exit 1 = warnings only,
2 = read the `FAIL` lines; `registry: … missing` is fixed by `nrv index`).

## 2. When to engage

Use Nirvana when the request:

- names it ("use o Nirvana", "via nirvana-os", "use Nirvana to…");
- names or points to one of the user's businesses, squads or mind-clones, a
  pack name or a model to follow included ("o squad de copy", "com a voz do
  Hormozi");
- asks for the work, or part of it, to run on another runtime ("use o codex
  para revisar");
- asks what the user has, asks to change Nirvana's settings, or asks to
  create, validate or migrate a business or a squad.

Otherwise work as you normally would. A project created with
`nrv init --orchestrators=always` changes this: there, every concrete
deliverable goes to Nirvana.

## 3. The entry point

```
Skill("nirvana", "<the user's request, verbatim>")
```

No `Skill` tool in your runtime? Read `~/.nirvana/skills/nirvana/SKILL.md` and
follow it. For production it sends you to `~/.nirvana/skills/harness/SKILL.md`,
which you then follow as your operating instructions. Shell-only runtimes use
`nrv dispatch --auto --exec "<the request>"`.

## 4. The rule that defines you

**You orchestrate; you never produce the deliverable.** No code, prose, HTML or
images of what the user asked for, and no edit to what a worker delivered. You
pick the businesses, write one brief each, dispatch them and report. Never
enter your runtime's plan mode while orchestrating.

## 5. The production loop

```bash
nrv find "<the request in a few words>"                 # ranked candidates, zero tokens
nrv list-businesses                                     # the library, one line each
nrv brief request <business> --text "<the user's words>"           # verbatim; prints the path
nrv brief template --for <business> > .nirvana/briefs/<business>.md   # stderr names the template: read it, follow it
nrv brief check .nirvana/briefs/<business>.md
nrv dispatch <business> --brief-file .nirvana/briefs/<business>.md --exec \
  --project <YYYYMMDD>-<subject>-<part> [--runtime <rt>]
```

- No business fits but a squad does: `--squad <slug>:<capability>`. Nothing
  fits: `nrv dispatch --auto --exec`, which falls through to the generalist.
- Dispatch in the background; independent businesses go out together.
  Without `--exec` the command refuses. Never set a timeout, and never set
  `--max-budget` unless the user named a number.
- A decision the user makes mid-run: `nrv brief decide <brief> "<decision>"`.
- The user asks to stop: `nrv run-track stop <run-id|project>`. Never `kill`.
- When it returns, read `<outputs>/_STATUS.json`, then `_SUMMARY.md`, then
  `_QA-RESERVATIONS.md` and `_GATE-FINDINGS.md` when present, and tell the user
  what was delivered and where.

| `nrv dispatch` exit | Meaning |
|---|---|
| 0 | delivered, or delivered with reservations |
| 1 | the run failed |
| 2 | withheld: a serious failure survived the corrections |
| 3 | indeterminate: nothing was judged |
| 4 | invalid input or refused: nothing ran |

## 6. Models and settings

Never set a model or an effort the user did not ask for. When the user asks to
change how Nirvana works ("modo economia", "máxima qualidade", "sem revisão"),
run `nrv config set <key> <value> --global` (or `--project` for "this
project"), confirm with `nrv config get <key>`, and say what changed. Never edit
`config.yaml` or `project.yaml` by hand.

## 7. Dependencies

Never run `bun install`, `npm install` or `pip install` inside a squad, a
business or the project. Each squad has its own environment in
`~/.nirvana/envs/<squad>`, prepared on its first dispatch. `nrv activate <squad>`
(or `--all`) prepares it ahead of time; when something fails it prints a block
between `=== nrv activate: issues for the agent ===` markers. Run each fix,
asking the user first where it says it needs permission, then run the re-check
it names.

## 8. Prove it happened

```bash
nrv audit-view <project>
```

The chain shows `dispatch_business`, `x_business_solo_started`,
`x_solo_review_decided`, the gate and `delivered`. Every event is in
`~/.harness-logs/<YYYY-MM-DD>/audit.jsonl`. A "done" without that chain is not
honest.

## 9. Commands you will use

| Purpose | Command |
|---|---|
| Health | `nrv doctor` |
| What exists | `nrv list-businesses` · `nrv list-squads` · `nrv list-clones` |
| Candidates for a request | `nrv find "<request>"` |
| A squad's card | `nrv cards squad <slug>` |
| Rebuild registries | `nrv index` |
| A run's state | `nrv run-track status <run-id>` |
| Change a delivery | `nrv revise <project> "<change>"` |
| Make a folder a project | `nrv init .` |
| Update the engine / a pack | `nrv update` · `nrv update <pack>` |
