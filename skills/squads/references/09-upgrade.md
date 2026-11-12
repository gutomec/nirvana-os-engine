# Squad Upgrade

## When to load
Intent: UPGRADE, MIGRATE (keywords: upgrade, migrate, convert)

## Protocol Reference
`SQUAD_PROTOCOL_V6.md` §35 (v5 → v6), §21 (older manifests)

## v5 → v6: one command

```bash
nrv migrate <slug|path> --to 6            # dry run, writes nothing
nrv migrate <slug|path> --to 6 --apply    # converts, with a backup
nrv validate squad <slug>                 # the admission gate on the result
nrv migrate <slug|path> --rollback <ts>   # undo, when the squad has not changed since
nrv migrate squad --all --to 6 [--root <dir>]   # the whole library, dry run
```

Other flags: `--map-refs`, `--no-extract-tasks`, `--no-derive-acceptance`, `--force`, `--json` (§35.4).

What changes in the squad:

| v5 | v6 |
|----|----|
| `workflows/<name>.yaml` in one of several graph dialects | `workflows/<name>.md`: frontmatter graph, prose body (§28.1) |
| `steps[].depends_on` / `deps` / `after` | `steps[].requires` |
| a prompt inline in `task: \|` or `action:` | `tasks/<workflow>-<step>.md` for a real prompt, the body under `## <step.id>` for a note |
| `invoke.ref: workflows/main.yaml` | `invoke.ref: workflows/main` (§28.6) |
| `components.workflows: [main.yaml]` | `components.workflows: [main]` |
| `success_indicators` nobody read | `capabilities[].acceptance[]`, derived with `blocking: false` (§29) |
| `not_for: ["long sentence (use other-squad)"]` | `not_for: ["short refusal"]`, 25 characters at most (§33) |
| `protocol: "5.0"` | `protocol: "6.0"` |

It refuses an `event_routes` document (a router, not a DAG), a document from which no step can be derived, and a file whose stem is not `^[a-z][a-z0-9_-]*$`. Without `--force` the squad is refused whole and nothing is written. The migration never invents prose: every sentence in a converted body existed in the source.

Three populations, three procedures (§35.5): never migrate an installed pack copy (migrate the pack source and let `nrv update` deliver it); unify an authored squad with its pack copies via `unify-squad.ts <slug> --authored <local>` before migrating; migrate an orphan in place.

Reading `.yaml` workflows is permanent. A v5 squad nobody migrates keeps loading, routing and validating.

## Older manifests

Protocol `4.0`, `4.1` and `5.0` load natively (§21). A squad without `capabilities[]` is listable, and the registry synthesizes virtual capabilities from its workflows so intent routing can find it. To make it first class, write real capabilities (§22, `templates/capability-block.tmpl`), then run `nrv migrate <slug> --to 6`.

Formats older than 4.0 are only detected for listing. There is no conversion tool: author the squad again against `SQUAD_PROTOCOL_V6.md` §5 to §8 and `templates/`.

## After migration

1. `nrv validate squad ./my-squad`: zero errors, or `--fix` and re-run.
2. `nrv index` so routing sees the new text.
3. Read the report at `<state>/squads/<slug>/migrate-<ts>.json` to confirm every change was intended; `nrv migrate <slug> --rollback <ts>` restores the backup while the squad is untouched.
