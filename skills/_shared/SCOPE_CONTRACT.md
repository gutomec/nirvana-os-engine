# Nirvana Scope Contract

> Canonical reference for `NIRVANA_SCOPE` — the mechanism that decides which squads, businesses, and mind-clones a project sees, and where its registries / state / logs land.

## TL;DR

Set in `<project>/.env`:

```bash
NIRVANA_SCOPE=global   # only ~/squads/* and ~/businesses/*  (default)
NIRVANA_SCOPE=project  # only <project>/.nirvana/*           (full isolation)
NIRVANA_SCOPE=merge    # both, project overrides global by slug
```

When unset, behavior is identical to the pre-scope era: everything global, everything in `$HOME`. **Backward compat is total** — installations that never touch `.env` keep working.

## What scope controls

| Concern | Source-of-truth file | Honors scope? |
|---|---|---|
| Which squads are visible | `enumerate(scope, "squads")` | yes |
| Which businesses are visible | `enumerate(scope, "businesses")` | yes |
| Which mind-clones are visible | `enumerate(scope, "mind-clones")` | yes |
| Where the squads registry persists | `paths.SQUADS_REGISTRY_PATH` | yes |
| Where the businesses registry persists | `paths.BUSINESSES_REGISTRY_PATH` | yes |
| Where activator state persists | `paths.SQUADS_STATE_DIR` | yes |
| Where harness logs land | `paths.HARNESS_LOGS_DIR` | yes |
| Where maestro logs land | `paths.MAESTRO_LOGS_DIR` | yes |
| Where outputs go | `paths.PROJECTS_OUTPUT_DIR` | yes |
| Where framework code lives (`~/.claude/skills/`) | `paths.CLAUDE_SKILLS_DIR` | no — always global |
| Where node_modules / Python deps live | system | no |

## Path resolution per mode

```
                    mode=global              mode=project                          mode=merge
SQUADS_DIR          ~/squads                 ~/squads                              ~/squads
                                             (read; not enumerated)                (read; project overlay)
SQUADS_REGISTRY     ~/.squads-registry.json  <project>/.nirvana/.squads-registry.  ~/.squads-registry.json
                                             json
SQUADS_STATE_DIR    ~/.claude/squads-state   <project>/.nirvana/state/squads       see below
HARNESS_LOGS_DIR    ~/.harness-logs          <project>/.nirvana/logs/harness       ~/.harness-logs
MAESTRO_LOGS_DIR    ~/.maestro-logs          <project>/.nirvana/logs/maestro       ~/.maestro-logs
```

### Merge mode subtlety: state writes

In merge mode the registry is global (read-only consumer for project), but when a *project-scoped* squad is activated, `activate-squad.ts` injects `NIRVANA_STATE_DIR=<project>/.nirvana/state/squads` into the activator subprocess. Result: each project keeps its own activation state for its own squads, while consuming globals read-only. No cross-project state collision.

## Override rule

In merge mode, when the same slug exists in both, the project copy wins. Detection is by **directory basename (slug)**, not by `name:` field in `squad.yaml`. Inspection:

```bash
bun ~/.claude/skills/_shared/lib/scope.ts --explain
```

shows each slug, its source (`project` / `global`), and whether it was overridden.

## Project root detection

`scope.ts` and `paths.js` walk up from `cwd`, stopping at the first ancestor containing one of: `.env`, `.nirvana`, `.git`, `package.json`, `pyproject.toml`. That ancestor becomes `projectRoot`. If none is found, mode silently degrades to `global`.

Override with `NIRVANA_PROJECT_ROOT=/abs/path` (env or shell export).

## Backward compatibility guarantees

- A repo without `.env` and without `.nirvana/` behaves exactly like before.
- A `.env` without `NIRVANA_SCOPE` — same: assumes `global`.
- A user in `~` (no project root) — same: `global`, registries in `~/`.
- Existing tools (`paths.js`, `paths.sh`, `bun-helpers.ts.paths`) keep their public API. Only the resolution branches; the keys are unchanged.

## What scope does NOT touch

These intentionally remain global (project-isolation should not break framework integrity):

- `~/.claude/skills/` — the framework code itself. A project does not get to fork the orchestration logic.
- Stage 6.5 agentic auditor — separation-of-duties principle is system-wide.
- DAG scheduler topology — algorithm is invariant.
- Pydantic validators — schema is universal.

## CLI overrides

Highest priority wins:

```bash
# CLI flag (overrides .env)
bun list-squads.ts --scope=project

# Process env (overrides .env)
NIRVANA_SCOPE=project bun list-squads.ts

# .env in project root
echo "NIRVANA_SCOPE=project" > .env
```

## Verification

```bash
# Inspect resolved scope
bun ~/.claude/skills/_shared/lib/scope.ts --explain

# Inspect resolved paths
node -e "const p=require('~/.claude/skills/_shared/lib/paths.js'.replace('~',process.env.HOME)); console.log(p)"

# Smoke matrix (3 modes × isolation proof)
bun ~/.claude/skills/_shared/tests/scope-isolation-smoke.ts
```

## Implementation references

| Concern | File |
|---|---|
| Mode detection + project root walk | `_shared/lib/scope.ts`, `_shared/lib/paths.js#detectScope` |
| Path resolution | `_shared/lib/paths.js#resolvePaths` |
| Bun-side helpers | `_shared/lib/bun-helpers.ts#paths` |
| Slug enumeration with override | `_shared/lib/scope.ts#enumerate` |
| Squad activator integration | `squads/lib/activator.js` (reads `NIRVANA_RESOLVED_SQUAD_PATH`, `NIRVANA_STATE_DIR`) |
| Squad registry roots | `squads/lib/registry.js#_computeDefaultRoots` |
| Business registry roots | `businesses/lib/registry.py#_resolve_default_registry_path` |
| Project skeleton template | `_shared/templates/project-skeleton/` |
| Bootstrap CLI | `_shared/scripts/init-project.ts` |

## Failure modes and what they mean

| Symptom | Likely cause | Fix |
|---|---|---|
| `[scope] NIRVANA_SCOPE=project but no project root found` | Running outside any tracked project | `cd` into a project, or `NIRVANA_PROJECT_ROOT=…` |
| Registry shows global squads in `scope=project` | Stale registry from before scope-aware refactor | Delete `<project>/.nirvana/.squads-registry.json` and re-run `index-squads` |
| Activate-squad finds nothing in `scope=project` | Squad not authored under `.nirvana/squads/` | `mkdir .nirvana/squads/<slug>` and add `squad.yaml` |
| State written to `~/.claude/squads-state/` despite `scope=project` | Bypassed `activate-squad.ts` and called `activator.js` directly | Always go through `activate-squad.{ts,sh,cmd}` |
