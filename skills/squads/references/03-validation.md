# Squad Validation

## When to load
Intent: VALIDATE (keywords: validate, check, verify, fix, repair, lint, audit)

## Protocol Reference
`SQUAD_PROTOCOL_V6.md` §15, §34

## The gate

A squad is admitted by one command, the admission gate. Its criteria catalog is in `SQUAD_PROTOCOL_V6.md` §34.1 and in code at `skills/_shared/lib/verify/kinds/squad.ts`.

```bash
nrv validate squad <slug|path>                  # report
nrv validate squad <slug|path> --fix            # mechanical repairs, with backup and rollback
nrv validate squad <slug|path> --fix=agentic --yes   # then an agent repairs what only meaning can fix
nrv validate squad <slug|path> --strict         # warnings reject too
nrv validate squad <slug|path> --json           # machine-readable report
nrv validate squad <slug|path> --no-retrieval   # skip the retrieval checks
nrv validate squad <slug|path> --baseline <file>
nrv validate squad --all [--json] [--record [--allow-regression]] [--root <dir>]
```

Exit codes: 0 admitted, 1 an error the baseline does not cover, 2 warnings only under `--strict`, 64 usage error or unknown entity. `--fix=agentic` spends model budget, so it needs `--yes` (exit 2 without it).

## What it checks

- **Manifest:** `squad.yaml` parses, matches `SquadManifestSchema` for its protocol, declares at least one capability, and every `components.*` entry exists.
- **Capabilities:** `outputs[]` shape, usable `examples[]`, `invoke.ref` resolves, `not_for` entries at most 25 characters (§33).
- **Workflows:** the lint rules of §28.3 (parse, refs, ids, cycles, dialect, twins, inline prose).
- **Hygiene:** `.nirvana-surface.json` present and current, no run output or per-buyer files inside the squad, no machine-local paths, audit events prefixed and attributed.
- **Quality (warnings):** agent frontmatter has `maxTurns` and `tools`, tasks have acceptance criteria, `dependencies.yaml` and `README.md` exist, routing metadata is complete, `fidelity: validated` has evidence.

Severity follows the declared `protocol`: under `"6.0"` the workflow and `not_for` rules are errors, under `"5.0"` they are warnings.

## Fixing

`--fix` runs the mechanical fixers in a fixed order (structure, manifest, files, surface), takes a backup, re-checks, and rolls back if a fixer failed or a new error appeared. A second run changes nothing. A reference that resolves to nothing is never invented: it stays a finding.

`nrv fix-squad <slug|path> [--apply]` writes `SQUAD-DOCTOR-REPORT.md` (problem, why, how to fix) and, with `--apply`, applies the safe fixes, such as downgrading an unproven `validated` fidelity to `experimental`.

## Routing check

Creation is not finished until the self-retrieval gate passes:

```bash
bun ~/.nirvana/skills/_shared/scripts/self-retrieval-gate.ts <slug> [--lenient] [--json]
```

## Adapter stage

After the core passes, the target runtime's adapter may add validators. They are listed in section 12 of each adapter in `skills/_shared/adapters/`.
