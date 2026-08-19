# .nirvana/ — this project's Nirvana state

Created by `nrv init`. What lives here:

| Path | What it is |
|---|---|
| `squads/`, `businesses/`, `mind-clones/` | project-local entities (visible under `NIRVANA_SCOPE=project` or `merge`) |
| `briefs/` | enriched briefs the orchestrator writes before dispatching |
| `plans/` | project plans |
| `outputs/<trace>/` | dispatched runs' artifacts and audit trails |

The global library (`~/squads`, `~/businesses`) stays untouched; scope is picked
in the project's `.env` (`NIRVANA_SCOPE`).
