# .nirvana/: this project's Nirvana state

Created by `nrv init`.

| Path | What it is |
|---|---|
| `project.yaml` | the project's identity, its scope (`global`, `project`, `merge`) and orchestration mode |
| `config.yaml` | engine settings for this project (`nrv config set`) |
| `squads/`, `businesses/`, `mind-clones/` | project-local entities (visible when the scope is `project` or `merge`) |
| `briefs/` | the briefs the orchestrator writes, one per business (`nrv brief template`) |
| `plans/` | multi-target plans |

The global library (`~/squads`, `~/businesses`) stays untouched.
