# Nirvana project

Created by `nrv init`. Any agent runtime that opens this folder reads
`AGENTS.md` (or its copies `CLAUDE.md` and `GEMINI.md`) first.

## What is here

| Path | What it is |
|---|---|
| `AGENTS.md`, `CLAUDE.md`, `GEMINI.md` | the contract every agent reads |
| `.env` | this project's scope (`NIRVANA_SCOPE`) and path overrides |
| `.env.example` | every variable a project may set |
| `.nirvana/project.yaml` | the project's identity |
| `.nirvana/config.yaml` | engine settings for this project, written by `nrv config set --project` |
| `.nirvana/squads/`, `.nirvana/businesses/`, `.nirvana/mind-clones/` | entities that belong to this project only |
| `outputs/<run>/` | what each run delivered, with its audit trail |

## Use it

Ask your agent for what you need, in plain language. With the full contract
(the default of `nrv init`), every concrete deliverable goes to Nirvana: the
agent picks the businesses and squads, briefs them and dispatches them. A
project created with `--orchestrators=on-demand` uses Nirvana only when you ask
for it by name. The commands underneath are:

```bash
nrv config list                 # settings and where they come from
nrv list-businesses             # the library this project sees
nrv audit-view <run>            # what a run did
```

`.agents/skills/` and the per-agent skill folders exist only when the project
was created with `--with-skills` or `--copy`; otherwise every runtime reads the
skills from your home folder.

## Scope (`NIRVANA_SCOPE` in `.env`, set with `nrv init --scope=<mode>`)

| Value | Sees `~/squads`, `~/businesses` | Sees `.nirvana/squads`, `.nirvana/businesses` |
|---|---|---|
| `global` (default) | yes | no |
| `project` | no | yes |
| `merge` | yes | yes, and they win on a slug clash |

After adding entities under `.nirvana/` in a `project` or `merge` scope, run
`nrv index` so routing sees them.
