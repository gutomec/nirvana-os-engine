# Outputs Contract

> **Single rule:** Run-output artifacts NEVER live inside a squad or business directory.
> They live in `<projectRoot>/.nirvana/outputs/<run_id>/` and only there.

## Why this rule exists

Squads (`<projectRoot>/.nirvana/squads/<slug>/`) and businesses (`<projectRoot>/.nirvana/businesses/<slug>/`) are *portable definitions*. The user copies them between projects routinely — bring `sales-funnel-masters` from project A to project B, drop it under B's `.nirvana/squads/`, ready to run.

If a previous run wrote outputs into the squad dir (e.g. `<slug>/outputs/<run_id>/...`), copying the squad carries those outputs along. Project B inherits Project A's run state. That is the bug we are guarding against.

## Canonical layout

```
<projectRoot>/
  .nirvana/
    squads/<slug>/                   ← portable definition. Never written to during a run.
    businesses/<slug>/               ← portable definition. Never written to during a run.
    mind-clones/<slug>/              ← portable definition. Never written to during a run.
    outputs/<run_id>/                ← ALL run artifacts go here. Project-local. Never copied.
      brief.md
      HANDOFF.json
      audit.jsonl
      businesses/<slug>/             ← per-business artifacts under this run
        handoffs/
        employees/
        tickets/
      squads/<slug>/                 ← per-squad artifacts under this run
        artifacts/
      <free-form>/                   ← intel/, posts/, reports/, etc. — whatever the run produces
```

`run_id` format: `<YYYYMMDDTHHMMSS>-<slug-or-purpose>` (e.g. `20260505T143022-ads-intelligence-q3-launch`). Timestamp first so directories sort chronologically.

## What the rule means in practice

| If you are…                                       | …write to                                           | …never write to                                   |
| ------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------- |
| `brief-business.ts`                               | `<outputs>/<run_id>/businesses/<slug>/`             | inside `.nirvana/businesses/<slug>/`              |
| A squad executing a workflow                      | `<outputs>/<run_id>/squads/<slug>/artifacts/`       | inside `.nirvana/squads/<slug>/`                  |
| Maestro DAG state                                 | `<outputs>/<run_id>/state/dag-state.json`           | inside `.nirvana/squads/business-nirvana-maestro/`|
| A user-written script that drops a deliverable    | `<outputs>/<run_id>/<topic>/`                       | anywhere under `.nirvana/squads/` or `businesses/`|

The single resolver to use: `outputsDir(scope)` from `~/.claude/skills/_shared/lib/scope.ts`. It honors `NIRVANA_OUTPUTS_DIR` as override, defaults to `<projectRoot>/.nirvana/outputs`, falls back to `<HOME>/.nirvana/outputs` when not inside a project.

## Allowed inside squad/business directories

These are part of the *definition* and travel with the squad/business — they are NOT outputs:

- `agents/`, `tasks/`, `workflows/`, `checklists/`, `dna/`, `templates/`, `data/` (input fixtures), `references/`, `config.yaml`, `squad.yaml`, `business.yaml`, `org-chart.yaml`, `routing.yaml`, etc.

## Disallowed inside squad/business directories

The lint at `~/.claude/skills/_shared/lib/outputs-lint.js` flags these names:

- **Hard fail** (validate exits non-zero): `outputs/`, `output/`
- **Warning**: `runs/`, `results/`, any subdir starting with `proj-`, ISO timestamps, or `run-N`

The lint runs first in `validate-squad.ts` and `validate-business.ts` (protocol-agnostic).

## Backwards compatibility

The legacy `.projects-outputs/` convention from `brief-business.ts` is gone. New runs go to `.nirvana/outputs/`. Existing `.projects-outputs/` directories from older runs are not auto-migrated — move them manually if you need to keep them, or delete them.

`PROJECTS_OUTPUT_DIR` env var is no longer read. Use `NIRVANA_OUTPUTS_DIR` instead (absolute or relative to projectRoot).

## Quick test

```bash
# Should pass cleanly:
bun ~/.claude/skills/squads/scripts/validate-squad.ts <slug>

# Plant a poison dir and re-run — should fail with outputs-lint:
mkdir -p ~/.nirvana/squads/<slug>/outputs/runs-from-yesterday
bun ~/.claude/skills/squads/scripts/validate-squad.ts <slug>
# → [FAIL] outputs-lint: run-output dir 'outputs/' must not exist inside…
```
