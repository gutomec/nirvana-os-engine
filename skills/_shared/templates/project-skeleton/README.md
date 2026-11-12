# Nirvana project

Created by `nrv init`. Any agent runtime that opens this folder reads
`AGENTS.md` (or its copies `CLAUDE.md` and `GEMINI.md`) first.

## What is here

| Path | What it is |
|---|---|
| `AGENTS.md`, `CLAUDE.md`, `GEMINI.md` | the contract every agent reads |
| `.nirvana/project.yaml` | the project's identity and its scope |
| `.env.example` | the environment variables a project may set; `nrv init` creates no `.env` |
| `.nirvana/config.yaml` | engine settings for this project, written by `nrv config set` |
| `.nirvana/briefs/` | the briefs the orchestrator writes, one per business |
| `outputs/<run>/` | what each run delivered, with its audit trail |

## Use it

Ask your agent for what you need, in plain language. It works as usual and
uses Nirvana when the request names it, names or points to one of your
businesses, squads or mind-clones, or asks for work on another runtime; then
it picks the businesses and dispatches them. After
`nrv init . --orchestrators=always`, every concrete deliverable goes to Nirvana.
Settings change the same way ("put this project in economy mode"); the
commands underneath are:

```bash
nrv config list                                      # settings and where they come from
nrv config set execution.profile economy --project   # max | balanced | economy
nrv list-businesses                        # the library this project sees
nrv audit-view <run>                       # what a run did
```

## Scope (`scope` in `.nirvana/project.yaml`, set with `nrv init --scope=<mode>`)

| Value | Sees `~/squads`, `~/businesses` | Sees `.nirvana/squads`, `.nirvana/businesses` |
|---|---|---|
| `global` (default) | yes | no |
| `project` | no | yes |
| `merge` | yes | yes, and they win on a slug clash |
